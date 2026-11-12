/**
 * Custom four-ray vehicle.
 *
 * One fully dynamic chassis rigid body. Each fixed step, before world.step():
 *
 *   1. Four rays are cast from the suspension mounts along the chassis' own
 *      down axis. The chassis body is excluded from its own queries.
 *   2. A wheel whose ray hits gets a spring/damper force along the contact
 *      normal. That force is also the tire's normal load.
 *   3. Each grounded tire asks for a longitudinal force (rear-wheel drive,
 *      brakes, rolling drag) and a lateral force that cancels sideways slip at
 *      the contact point. The pair is scaled back onto a friction ellipse
 *      sized by the normal load, so tire forces are always bounded by grip.
 *   4. Everything is applied as one impulse at the contact point.
 *
 * A wheel with no contact produces no force at all, so there is no traction or
 * steering in the air. Nothing here sets velocities or positions directly
 * except reset(), and no rotation axis is locked.
 *
 * Conventions: +Y up, local -Z forward, local +X right.
 * Wheel order: front-left, front-right, rear-left, rear-right.
 *
 * Scene queries see the world as of the last world.step(), so the very first
 * update() after the world is created finds no ground. The spawn height keeps
 * the wheels off the ground at that moment anyway.
 *
 * This file has no runtime imports on purpose (the imports below are erased):
 * the Node tests transpile it standalone and run it against the real Rapier
 * WASM, so the Rapier module and the tuning are passed in.
 */

import type RAPIER from '@dimforge/rapier3d-compat';
import type { VehicleTuning } from '../config';

/** The part of the Rapier module the vehicle needs. */
export type RapierApi = Pick<typeof RAPIER, 'Ray' | 'RigidBodyDesc' | 'ColliderDesc'>;

export interface VehicleInput {
  /** 0..1 (W). Accelerates; brakes first if the car is rolling backwards. */
  throttle: number;
  /** 0..1 (S). Brakes while rolling forwards, then reverses. */
  brake: number;
  /** -1 = full left (A) .. +1 = full right (D). */
  steer: number;
  /** Space. Brakes the rear wheels and cuts their lateral grip and drive. */
  handbrake: boolean;
}

/** Per-wheel result of the latest update(). Read-only for callers. */
export interface WheelState {
  /** True if the suspension ray found ground during the latest update(). */
  grounded: boolean;
  /** Mount to wheel-centre distance in m, within [0, rest length]. */
  suspensionLength: number;
  /** Steering angle about the chassis up axis in rad. Positive = left. */
  steerAngle: number;
  /** Accumulated rolling angle in rad. Positive = rolling forwards. */
  spinAngle: number;
  /** Rolling rate in rad/s. Positive = rolling forwards. */
  spinSpeed: number;
  /** Suspension force = tire normal load, in N. 0 in the air. */
  load: number;
  /** Tire force along the wheel's heading in N. Positive = forwards. */
  longitudinalForce: number;
  /** Tire force along the wheel's right in N. */
  lateralForce: number;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

const WHEEL_COUNT = 4;
const FRONT_WHEEL_COUNT = 2;
const LOCAL_FORWARD: Vec3 = { x: 0, y: 0, z: -1 };
const LOCAL_UP: Vec3 = { x: 0, y: 1, z: 0 };

/**
 * A hit only counts as ground if its normal is within about 78 degrees of the
 * chassis up axis. Rejects walls and degenerate (zero) normals.
 */
const MIN_CONTACT_ALIGNMENT = 0.2;

/** Per-step multiplier on a wheel's spin rate while it is off the ground. */
const AIRBORNE_SPIN_KEEP = 0.98;

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Rotates v by the unit quaternion q. */
function rotate(q: Quat, v: Vec3): Vec3 {
  // v' = v + w * t + u x t, with u = (q.x, q.y, q.z) and t = 2 * (u x v).
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** Drive force fade: 1 at or below standstill, 0 at and beyond the top speed. */
function taper(speedRatio: number): number {
  if (speedRatio <= 0) return 1;
  return Math.max(0, 1 - speedRatio * speedRatio);
}

function restingWheel(restLength: number): WheelState {
  return {
    grounded: false,
    suspensionLength: restLength,
    steerAngle: 0,
    spinAngle: 0,
    spinSpeed: 0,
    load: 0,
    longitudinalForce: 0,
    lateralForce: 0,
  };
}

export class RaycastVehicle {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly tuning: VehicleTuning;
  /** Chassis-local suspension mount points, in wheel order. */
  readonly wheelMounts: ReadonlyArray<Readonly<Vec3>>;
  /** Per-wheel state from the latest update(), in wheel order. */
  readonly wheels: ReadonlyArray<Readonly<WheelState>>;

  private readonly rapier: RapierApi;
  private readonly world: RAPIER.World;
  private readonly wheelStates: WheelState[];
  /** Current front wheel angle in rad. Positive = left. */
  private steer = 0;

  constructor(rapier: RapierApi, world: RAPIER.World, tuning: VehicleTuning) {
    this.rapier = rapier;
    this.world = world;
    this.tuning = tuning;

    const { spawn, chassisHalfExtents: half } = tuning;
    this.body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setLinearDamping(tuning.linearDamping)
        .setAngularDamping(tuning.angularDamping)
        .setCanSleep(false)
        .setCcdEnabled(true),
    );
    this.collider = world.createCollider(
      rapier.ColliderDesc.cuboid(half.x, half.y, half.z).setMass(tuning.mass),
      this.body,
    );

    const y = tuning.suspensionMountY;
    this.wheelMounts = [
      { x: -tuning.halfTrack, y, z: tuning.frontAxleZ },
      { x: tuning.halfTrack, y, z: tuning.frontAxleZ },
      { x: -tuning.halfTrack, y, z: tuning.rearAxleZ },
      { x: tuning.halfTrack, y, z: tuning.rearAxleZ },
    ];

    this.wheelStates = [];
    for (let i = 0; i < WHEEL_COUNT; i++) {
      this.wheelStates.push(restingWheel(tuning.suspensionRestLength));
    }
    this.wheels = this.wheelStates;
  }

  /** Current front wheel angle in rad. Positive = left. */
  get steerAngle(): number {
    return this.steer;
  }

  /** Chassis speed along its own forward axis in m/s. Negative = reversing. */
  get forwardSpeed(): number {
    return dot(this.body.linvel(), rotate(this.body.rotation(), LOCAL_FORWARD));
  }

  /** Chassis speed in m/s, in any direction. */
  get speed(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.y, v.z);
  }

  /**
   * Applies this step's suspension and tire impulses.
   * Call once per fixed step, BEFORE world.step().
   */
  update(input: VehicleInput, dt: number): void {
    const t = this.tuning;
    const body = this.body;

    // One snapshot of the chassis state. Every wheel is solved against it, so
    // the result does not depend on the order the wheels are processed in.
    const position = body.translation();
    const rotation = body.rotation();
    const linvel = body.linvel();
    const angvel = body.angvel();
    const com = body.worldCom();

    const forward = rotate(rotation, LOCAL_FORWARD);
    const up = rotate(rotation, LOCAL_UP);
    const down = scale(up, -1);
    const forwardSpeed = dot(linvel, forward);

    const velocityAt = (point: Vec3): Vec3 => add(linvel, cross(angvel, sub(point, com)));

    // --- Steering: speed-sensitive lock, rate-limited ------------------------
    const speedFactor = clamp(Math.abs(forwardSpeed) / t.steerSpeedRef, 0, 1);
    const lockAngle = t.maxSteerAngle * (1 + (t.highSpeedSteerScale - 1) * speedFactor);
    const targetSteer = -clamp(input.steer, -1, 1) * lockAngle; // left is positive
    const maxSteerStep = t.steerRate * dt;
    this.steer += clamp(targetSteer - this.steer, -maxSteerStep, maxSteerStep);

    const steeredForward = rotate(rotation, {
      x: -Math.sin(this.steer),
      y: 0,
      z: -Math.cos(this.steer),
    });

    // --- Pedals --------------------------------------------------------------
    const throttle = clamp(input.throttle, 0, 1);
    const brake = clamp(input.brake, 0, 1);
    let driveForce = 0; // signed along forward, total for the rear axle
    let brakeForce = 0; // magnitude, total for all four wheels

    if (throttle > 0 && brake > 0) {
      brakeForce = brake * t.brakeForce; // both pedals: the brake wins
    } else if (throttle > 0) {
      if (forwardSpeed < -t.directionChangeSpeed) {
        brakeForce = throttle * t.brakeForce; // rolling backwards: stop first
      } else {
        driveForce = throttle * t.engineForce * taper(forwardSpeed / t.topSpeed);
      }
    } else if (brake > 0) {
      if (forwardSpeed > t.directionChangeSpeed) {
        brakeForce = brake * t.brakeForce;
      } else {
        driveForce = -brake * t.reverseForce * taper(-forwardSpeed / t.reverseTopSpeed);
      }
    }
    if (input.handbrake) driveForce = 0; // locked rear wheels cannot drive

    // --- Wheels --------------------------------------------------------------
    const rayLength = t.suspensionRestLength + t.wheelRadius;
    // Force that cancels slipResponse of 1 m/s of contact slip in one step,
    // treating each wheel as carrying a quarter of the car.
    const slipForcePerSpeed = (t.slipResponse * (t.mass / WHEEL_COUNT)) / dt;

    for (let i = 0; i < WHEEL_COUNT; i++) {
      const wheel = this.wheelStates[i];
      const isFront = i < FRONT_WHEEL_COUNT;
      const locked = !isFront && input.handbrake;
      wheel.steerAngle = isFront ? this.steer : 0;

      const mount = add(position, rotate(rotation, this.wheelMounts[i]));
      const hit = this.world.castRayAndGetNormal(
        new this.rapier.Ray(mount, down),
        rayLength,
        true,
        undefined,
        undefined,
        undefined,
        body, // never hit our own chassis
      );

      if (hit === null || dot(hit.normal, up) < MIN_CONTACT_ALIGNMENT) {
        // Airborne: no suspension force and no tire force of any kind.
        wheel.grounded = false;
        wheel.suspensionLength = t.suspensionRestLength;
        wheel.load = 0;
        wheel.longitudinalForce = 0;
        wheel.lateralForce = 0;
        wheel.spinSpeed *= AIRBORNE_SPIN_KEEP;
        wheel.spinAngle += wheel.spinSpeed * dt;
        continue;
      }

      const normal: Vec3 = { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z };
      const distance = hit.timeOfImpact; // `down` is unit length, so metres
      const contact = add(mount, scale(down, distance));

      // Suspension: spring on compression, damper on compression speed. It
      // can only push, and its force is capped.
      const suspensionLength = distance - t.wheelRadius; // < 0 if bottomed out
      const compression = t.suspensionRestLength - suspensionLength;
      const compressionSpeed = dot(velocityAt(mount), down);
      const load = clamp(
        t.suspensionStiffness * compression + t.suspensionDamping * compressionSpeed,
        0,
        t.suspensionMaxForce,
      );

      // Tire frame in the contact plane.
      const heading = isFront ? steeredForward : forward;
      const inPlane = sub(heading, scale(normal, dot(heading, normal)));
      const inPlaneLength = Math.hypot(inPlane.x, inPlane.y, inPlane.z);
      let longitudinal = 0;
      let lateral = 0;
      let rollingSpeed = 0;
      let wheelForward = heading;
      let wheelRight = cross(heading, normal);

      if (load > 0 && inPlaneLength > 1e-6) {
        wheelForward = scale(inPlane, 1 / inPlaneLength);
        wheelRight = cross(wheelForward, normal);

        const contactVelocity = velocityAt(contact);
        rollingSpeed = dot(contactVelocity, wheelForward);
        const sideSpeed = dot(contactVelocity, wheelRight);

        // Requested forces, before the grip limit.
        const axleShare = isFront ? t.brakeFrontBias : 1 - t.brakeFrontBias;
        let brakeLimit = (brakeForce * axleShare) / 2;
        if (locked) brakeLimit = Math.max(brakeLimit, t.handbrakeForce / 2);
        // Brakes oppose rolling but never push past standstill.
        longitudinal =
          clamp(-rollingSpeed * slipForcePerSpeed, -brakeLimit, brakeLimit) -
          t.rollingDrag * rollingSpeed;
        if (!isFront) longitudinal += driveForce / 2;
        lateral = -sideSpeed * slipForcePerSpeed;

        // Combined grip: scale the pair back onto the friction ellipse.
        const maxLongitudinal = t.gripLongitudinal * load;
        const maxLateral =
          (isFront ? t.gripLateralFront : t.gripLateralRear) *
          (locked ? t.handbrakeRearGripScale : 1) *
          load;
        if (maxLongitudinal <= 0) longitudinal = 0;
        if (maxLateral <= 0) lateral = 0;
        const usage = Math.hypot(
          maxLongitudinal > 0 ? longitudinal / maxLongitudinal : 0,
          maxLateral > 0 ? lateral / maxLateral : 0,
        );
        if (usage > 1) {
          longitudinal /= usage;
          lateral /= usage;
        }
      }

      const force = add(
        scale(normal, load),
        add(scale(wheelForward, longitudinal), scale(wheelRight, lateral)),
      );
      body.applyImpulseAtPoint(scale(force, dt), contact, true);

      wheel.grounded = true;
      wheel.suspensionLength = clamp(suspensionLength, 0, t.suspensionRestLength);
      wheel.load = load;
      wheel.longitudinalForce = longitudinal;
      wheel.lateralForce = lateral;
      wheel.spinSpeed = locked ? 0 : rollingSpeed / t.wheelRadius;
      wheel.spinAngle += wheel.spinSpeed * dt;
    }
  }

  /**
   * Puts the chassis back on its spawn, at rest and unrotated, and clears the
   * steering and wheel state. Callers that interpolate poses must snap them.
   */
  reset(): void {
    const { spawn } = this.tuning;
    this.body.setTranslation({ x: spawn.x, y: spawn.y, z: spawn.z }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steer = 0;
    for (const wheel of this.wheelStates) {
      Object.assign(wheel, restingWheel(this.tuning.suspensionRestLength));
    }
  }
}
