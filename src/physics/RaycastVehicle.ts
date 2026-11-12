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
 *      brakes, rolling drag) and a lateral force that opposes sideways slip at
 *      the contact point, following a slip-angle curve: it builds up to a
 *      peak angle, then eases off towards a sliding level. The pair is scaled
 *      back onto a friction ellipse sized by the normal load, so tire forces
 *      are always bounded by grip.
 *   4. Everything is applied as one impulse at the contact point.
 *
 * A wheel with no contact produces no force at all, so there is no traction or
 * steering in the air. Nothing here sets velocities or positions directly
 * except reset(), and no rotation axis is locked.
 *
 * Wheels have no rotational state of their own, so there is no slip ratio and
 * no wheelspin: longitudinal force is the requested force, limited by grip.
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
  /**
   * Space. Brakes the rear wheels and cuts their lateral grip and drive. On
   * release the brake and drive cut end at once; the grip eases back.
   */
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
  /**
   * Sideways speed of the contact point over the ground in m/s, measured
   * along the wheel's right in the contact plane (the steered wheel's right
   * for the front wheels). Positive = sliding to the wheel's right. Taken
   * before this step's forces act. 0 in the air or with no load.
   */
  slipSpeed: number;
  /**
   * Slip angle in rad, within [-PI/2, PI/2]: the angle between the wheel's
   * heading and the contact point's motion over the ground. Same sign as
   * slipSpeed (positive = sliding to the wheel's right), also when rolling
   * backwards. Measured against at least slipAngleMinSpeed of rolling speed,
   * so it fades to 0 at a standstill. 0 in the air or with no load. Sideways
   * slip only: not wheelspin or a slip ratio.
   */
  slipAngle: number;
  /**
   * World-space point where the suspension ray actually hit, from the latest
   * update(). Telemetry only. Valid only while grounded with load > 0;
   * otherwise (0, 0, 0). The object is owned by the vehicle and reused.
   */
  contactPoint: Vec3;
  /**
   * World-space ground normal at that hit. Same validity as contactPoint:
   * (0, 0, 0) in the air, with no load, and after reset().
   */
  contactNormal: Vec3;
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

/** Writes into an existing vector, so telemetry never allocates per step. */
function setVec(target: Vec3, x: number, y: number, z: number): void {
  target.x = x;
  target.y = y;
  target.z = z;
}

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

/**
 * Lateral force as a fraction of peak grip, for slipRatio = |slip angle| /
 * peak slip angle (>= 0). Rises from 0 with slope 2, reaches 1 at slipRatio 1
 * with a flat top, then falls smoothly towards slidingGrip. Continuous with a
 * continuous slope, and always within [0, 1].
 */
function lateralGripCurve(slipRatio: number, slidingGrip: number): number {
  const rise = (2 * slipRatio) / (1 + slipRatio * slipRatio);
  return slipRatio <= 1 ? rise : slidingGrip + (1 - slidingGrip) * rise;
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
    slipSpeed: 0,
    slipAngle: 0,
    contactPoint: { x: 0, y: 0, z: 0 },
    contactNormal: { x: 0, y: 0, z: 0 },
  };
}

/** Engine and gearbox state for the HUD and audio. Read-only for callers. */
export interface EngineState {
  /** Engine speed in rev/min. Always finite and within [idleRpm, redlineRpm]. */
  readonly rpm: number;
  /** -1 = reverse, 0 = neutral (declutched), 1.. = forward gear. */
  readonly gear: number;
  readonly idleRpm: number;
  readonly redlineRpm: number;
  /** True during the torque interruption of an automatic gear change. */
  readonly shifting: boolean;
  /** True while the rev limiter holds the engine at the redline. */
  readonly limiting: boolean;
}

/**
 * Arcade engine and automatic gearbox. In gear the engine speed is the road
 * speed through the gearing, never below idle (as if the clutch slipped) and
 * never above the redline. Drive force is engine torque at that speed through
 * the gear, bounded by the tuning's force ceilings and top speeds. This is
 * not a wheelspin simulation: the wheels have no speed of their own.
 */
export class Powertrain implements EngineState {
  rpm: number;
  gear = 0;
  shifting = false;
  limiting = false;
  readonly idleRpm: number;
  readonly redlineRpm: number;
  private readonly t: VehicleTuning;
  /** Time left of the current shift's torque interruption, s. */
  private shiftLeft = 0;

  constructor(tuning: VehicleTuning) {
    this.t = tuning;
    this.idleRpm = tuning.engineIdleRpm;
    this.redlineRpm = tuning.engineRedlineRpm;
    this.rpm = this.idleRpm;
  }

  /** Full-throttle crankshaft torque in Nm: the torque curve under the power limit. */
  torqueAt(rpm: number): number {
    const t = this.t;
    const rise = clamp(
      (rpm - t.engineIdleRpm) / Math.max(1, t.enginePeakTorqueRpm - t.engineIdleRpm),
      0,
      1,
    );
    const curve = t.engineIdleTorqueFraction + (1 - t.engineIdleTorqueFraction) * rise;
    return Math.min(t.enginePeakTorque * curve, t.enginePeakPower / ((Math.max(rpm, 1) * Math.PI) / 30));
  }

  /**
   * Advances the engine and gearbox by dt and returns the drive force for the
   * rear axle in N, signed along the chassis' forward axis.
   * direction: 1 = forward gears, -1 = reverse, 0 = neutral, where demand
   * (0..1) only revs the engine.
   */
  update(dt: number, forwardSpeed: number, demand: number, direction: -1 | 0 | 1): number {
    const t = this.t;
    const pedal = clamp(demand, 0, 1);
    if (direction === 0) {
      this.gear = 0;
      this.shiftLeft = 0;
      this.shifting = false;
      // Aim a little past the redline so full throttle reaches the limiter.
      const target = t.engineIdleRpm + pedal * (1.05 * t.engineRedlineRpm - t.engineIdleRpm);
      const keep = t.engineRevTime > 0 ? Math.exp(-dt / t.engineRevTime) : 0;
      this.rpm = clamp(target + (this.rpm - target) * keep, t.engineIdleRpm, t.engineRedlineRpm);
      this.limiting = this.rpm >= t.engineRedlineRpm;
      return 0;
    }

    const speed = Math.max(0, forwardSpeed * direction);
    // Engine rev/min per unit of gear ratio at this road speed.
    const rpmPerRatio = (speed / t.wheelRadius) * t.finalDrive * (30 / Math.PI);
    const gears = t.gearRatios;
    if (direction < 0) {
      this.gear = -1;
      this.shiftLeft = 0;
    } else if (this.gear < 1) {
      // Engaging from neutral or reverse: lowest gear that is not due an upshift.
      this.gear = 1;
      this.shiftLeft = 0;
      while (this.gear < gears.length && rpmPerRatio * gears[this.gear - 1] >= t.upshiftRpm) {
        this.gear++;
      }
    } else if (this.shifting) {
      this.shiftLeft -= dt;
    } else {
      const roadRpm = rpmPerRatio * gears[this.gear - 1];
      if (roadRpm >= t.upshiftRpm && this.gear < gears.length) {
        this.gear++;
        this.shiftLeft = t.shiftTime;
      } else if (roadRpm <= t.downshiftRpm && this.gear > 1) {
        this.gear--;
        this.shiftLeft = t.shiftTime;
      }
    }
    this.shifting = this.shiftLeft > 1e-9;

    // The new gear is engaged at once, so the revs drop (or rise) with it.
    const ratio = direction < 0 ? t.reverseGearRatio : gears[this.gear - 1];
    const roadRpm = rpmPerRatio * ratio;
    this.rpm = clamp(roadRpm, t.engineIdleRpm, t.engineRedlineRpm);
    this.limiting = roadRpm >= t.engineRedlineRpm;
    if (this.shifting || this.limiting) return 0;

    const wheelForce = (this.torqueAt(this.rpm) * ratio * t.finalDrive) / t.wheelRadius;
    const ceiling = direction < 0 ? t.reverseForce : t.engineForce;
    const top = direction < 0 ? t.reverseTopSpeed : t.topSpeed;
    return direction * pedal * Math.min(ceiling, wheelForce) * taper(speed / top);
  }

  /** Back to neutral at idle, with no shift in progress. */
  reset(): void {
    this.gear = 0;
    this.rpm = this.idleRpm;
    this.shifting = false;
    this.limiting = false;
    this.shiftLeft = 0;
  }
}

export class RaycastVehicle {
  /** Engine and gearbox telemetry from the latest update(), for HUD and audio. */
  readonly engine: Readonly<EngineState>;
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
  private readonly powertrain: Powertrain;
  /** Current front wheel angle in rad. Positive = left. */
  private steer = 0;
  /**
   * Rear lateral grip multiplier: handbrakeRearGripScale while the handbrake
   * is held, easing back to 1 after it is released.
   */
  private rearGripScale = 1;

  constructor(rapier: RapierApi, world: RAPIER.World, tuning: VehicleTuning) {
    this.rapier = rapier;
    this.world = world;
    this.tuning = tuning;
    this.powertrain = new Powertrain(tuning);
    this.engine = this.powertrain;

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
    this.applyMassProperties();

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

  /**
   * Sets the chassis mass properties from this.tuning: mass, a centre of mass
   * at (0, centerOfMassY ?? 0, 0) in chassis space, and the principal inertia
   * of a uniform box with the chassis half extents. This replaces the
   * collider's mass properties (no mass is added) and is a prescribed box
   * inertia about the shifted centre, not a computed mass distribution of the
   * render model. The body is recomputed at once and woken. Called at
   * construction and when the tuning changes, never per step.
   */
  applyMassProperties(): void {
    const { mass, chassisHalfExtents: half } = this.tuning;
    const x2 = half.x * half.x;
    const y2 = half.y * half.y;
    const z2 = half.z * half.z;
    const k = mass / 3;
    this.collider.setMassProperties(
      mass,
      { x: 0, y: this.tuning.centerOfMassY ?? 0, z: 0 },
      { x: k * (y2 + z2), y: k * (x2 + z2), z: k * (x2 + y2) },
      { x: 0, y: 0, z: 0, w: 1 },
    );
    this.body.recomputeMassPropertiesFromColliders();
    this.body.wakeUp();
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
    let direction: -1 | 0 | 1 = 0; // gear direction this step, 0 = neutral
    let demand = 0; // 0..1 drive demand in that direction
    let brakeForce = 0; // magnitude, total for all four wheels

    if (throttle > 0 && brake > 0) {
      brakeForce = brake * t.brakeForce; // both pedals: the brake wins
    } else if (throttle > 0) {
      if (forwardSpeed < -t.directionChangeSpeed) {
        brakeForce = throttle * t.brakeForce; // rolling backwards: stop first
      } else {
        direction = 1;
        demand = throttle;
      }
    } else if (brake > 0) {
      if (forwardSpeed > t.directionChangeSpeed) {
        brakeForce = brake * t.brakeForce;
      } else {
        direction = -1;
        demand = brake;
      }
    }
    // No pedal is driving: stay in gear while rolling, neutral near standstill.
    if (direction === 0 && Math.abs(forwardSpeed) > t.directionChangeSpeed) {
      direction = forwardSpeed > 0 ? 1 : -1;
    }
    // Handbrake: locked rear wheels cannot drive. Declutched, so the throttle
    // only revs the engine.
    if (input.handbrake) {
      direction = 0;
      demand = brake > 0 ? 0 : throttle;
    }
    // Signed along forward, total for the rear axle.
    const driveForce = this.powertrain.update(dt, forwardSpeed, demand, direction);

    // Handbrake grip: cut at once while held. After release the missing grip
    // decays exponentially, so the result depends on elapsed time only.
    if (input.handbrake) {
      this.rearGripScale = t.handbrakeRearGripScale;
    } else if (t.handbrakeGripRecoveryTime > 0) {
      this.rearGripScale =
        1 - (1 - this.rearGripScale) * Math.exp(-dt / t.handbrakeGripRecoveryTime);
    } else {
      this.rearGripScale = 1;
    }

    // --- Wheels --------------------------------------------------------------
    const rayLength = t.suspensionRestLength + t.wheelRadius;
    // Force that cancels slipResponse of 1 m/s of contact slip in one step,
    // treating each wheel as carrying a quarter of the car. An upper bound
    // that keeps the tires dissipative, not the tire's cornering stiffness.
    const slipForcePerSpeed = (t.slipResponse * (t.mass / WHEEL_COUNT)) / dt;
    const slidingGrip = clamp(t.tireSlidingGrip, 0, 1);

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
        wheel.slipSpeed = 0;
        wheel.slipAngle = 0;
        setVec(wheel.contactPoint, 0, 0, 0);
        setVec(wheel.contactNormal, 0, 0, 0);
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
      let sideSpeed = 0;
      let slipAngle = 0;
      let wheelForward = heading;
      let wheelRight = cross(heading, normal);

      if (load > 0 && inPlaneLength > 1e-6) {
        wheelForward = scale(inPlane, 1 / inPlaneLength);
        wheelRight = cross(wheelForward, normal);

        const contactVelocity = velocityAt(contact);
        rollingSpeed = dot(contactVelocity, wheelForward);
        sideSpeed = dot(contactVelocity, wheelRight);
        slipAngle = Math.atan2(
          sideSpeed,
          Math.max(Math.abs(rollingSpeed), t.slipAngleMinSpeed),
        );

        // Requested forces, before the grip limit.
        const axleShare = isFront ? t.brakeFrontBias : 1 - t.brakeFrontBias;
        let brakeLimit = (brakeForce * axleShare) / 2;
        if (locked) brakeLimit = Math.max(brakeLimit, t.handbrakeForce / 2);
        // Brakes oppose rolling but never push past standstill.
        longitudinal =
          clamp(-rollingSpeed * slipForcePerSpeed, -brakeLimit, brakeLimit) -
          t.rollingDrag * rollingSpeed;
        if (!isFront) longitudinal += driveForce / 2;

        const maxLongitudinal = t.gripLongitudinal * load;
        const maxLateral =
          (isFront ? t.gripLateralFront : t.gripLateralRear * this.rearGripScale) * load;

        // Lateral: the slip-angle curve sets the force (no dt in it). It is
        // capped at the force that cancels slipResponse of the side slip in
        // one step, which only bites at low speed or tiny slip and brings the
        // force smoothly to zero at rest. Always opposes the slip, so it
        // never feeds it. Never above maxLateral, so a saturated sideways
        // demand cannot dilute brake/drive force in the ellipse below.
        if (maxLateral > 0) {
          const peakAngle = Math.max(
            isFront ? t.tirePeakSlipAngleFront : t.tirePeakSlipAngleRear,
            1e-6,
          );
          const curveForce =
            maxLateral * lateralGripCurve(Math.abs(slipAngle) / peakAngle, slidingGrip);
          lateral =
            -Math.sign(sideSpeed) * Math.min(curveForce, Math.abs(sideSpeed) * slipForcePerSpeed);
        }

        // Combined grip: scale the pair back onto the friction ellipse.
        if (maxLongitudinal <= 0) longitudinal = 0;
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
      wheel.slipSpeed = sideSpeed;
      wheel.slipAngle = slipAngle;
      // Telemetry only: the actual ray hit, valid while this wheel carries load.
      if (load > 0) {
        setVec(wheel.contactPoint, contact.x, contact.y, contact.z);
        setVec(wheel.contactNormal, normal.x, normal.y, normal.z);
      } else {
        setVec(wheel.contactPoint, 0, 0, 0);
        setVec(wheel.contactNormal, 0, 0, 0);
      }
      wheel.spinSpeed = locked ? 0 : rollingSpeed / t.wheelRadius;
      wheel.spinAngle += wheel.spinSpeed * dt;
    }
  }

  /**
   * Puts the chassis back on its spawn, at rest and unrotated, and clears the
   * steering, handbrake grip recovery and wheel state. Callers that
   * interpolate poses must snap them.
   */
  reset(): void {
    const { spawn } = this.tuning;
    this.body.setTranslation({ x: spawn.x, y: spawn.y, z: spawn.z }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steer = 0;
    this.rearGripScale = 1;
    this.powertrain.reset();
    for (const wheel of this.wheelStates) {
      // Keep the wheel's own contact vectors: callers may hold on to them.
      const { contactPoint, contactNormal } = wheel;
      Object.assign(wheel, restingWheel(this.tuning.suspensionRestLength));
      setVec(contactPoint, 0, 0, 0);
      setVec(contactNormal, 0, 0, 0);
      wheel.contactPoint = contactPoint;
      wheel.contactNormal = contactNormal;
    }
  }
}
