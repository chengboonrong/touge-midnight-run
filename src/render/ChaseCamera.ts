import { Vector3, type Object3D, type PerspectiveCamera } from 'three';
import type { CHASE_CAMERA } from '../config';

export type ChaseCameraTuning = Readonly<Record<keyof typeof CHASE_CAMERA, number>>;

/** Sideslip is measured against at least this forward speed, m/s. */
const SLIP_MIN_SPEED = 5;

const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

/**
 * Follow camera: position = car position + smoothed offset. Only the offset is
 * filtered, so its length is bounded and constant speed adds no distance.
 * Every filter is exp(-response * dt); nothing is allocated per frame.
 */
export class ChaseCamera {
  private readonly camera: PerspectiveCamera;
  private readonly tuning: ChaseCameraTuning;
  private readonly heading = new Vector3(0, 0, -1);
  private readonly offset = new Vector3();
  private readonly scratch = new Vector3();
  private accelShift = 0;
  private cornerShift = 0;
  private roll = 0;
  private fov = 0;
  private previousX = 0;
  private previousZ = 0;
  private fresh = true;

  constructor(camera: PerspectiveCamera, tuning: ChaseCameraTuning) {
    this.camera = camera;
    this.tuning = tuning;
  }

  /** Horizontal unit direction the camera treats as the car's forward. */
  get forward(): { readonly x: number; readonly z: number } {
    return this.heading;
  }

  /**
   * @param car Rendered (interpolated) car object.
   * @param velocity World linear velocity of the car, m/s.
   * @param yawRate Angular velocity about +Y, rad/s.
   * @param dt Frame time, s.
   * @param snap Jump to the rest pose and clear all filters.
   */
  update(car: Object3D, velocity: { readonly x: number; readonly z: number }, yawRate: number, dt: number, snap = false): void {
    const t = this.tuning;
    const h = this.heading;
    const s = this.scratch;
    s.set(0, 0, -1).applyQuaternion(car.quaternion);
    s.y = 0;
    if (s.lengthSq() > 1e-4) h.copy(s).normalize();
    const rightX = -h.z;
    const rightZ = h.x;
    const reset = snap || this.fresh;
    this.fresh = false;

    const forwardSpeed = velocity.x * h.x + velocity.z * h.z;
    const sideSpeed = velocity.x * rightX + velocity.z * rightZ;
    const velocityChange = reset ? 0
      : (velocity.x - this.previousX) * h.x + (velocity.z - this.previousZ) * h.z;
    this.previousX = velocity.x;
    this.previousZ = velocity.z;
    const slip = Math.atan2(sideSpeed, Math.max(Math.abs(forwardSpeed), SLIP_MIN_SPEED));
    const speedRatio = Math.min(Math.hypot(velocity.x, velocity.z) / t.fovSpeed, 1);
    const fovTarget = t.fovMin + speedRatio * (t.fovMax - t.fovMin);

    if (reset) {
      this.accelShift = 0;
      this.cornerShift = 0;
      this.roll = 0;
      this.fov = fovTarget;
    } else {
      const keep = Math.exp(-t.effectResponse * Math.max(dt, 0));
      const k = 1 - keep;
      // Integrate velocity changes: clipping per-render acceleration biases high-refresh displays.
      this.accelShift = clamp(this.accelShift * keep + velocityChange * t.accelOffset * t.effectResponse, t.maxAccelOffset);
      this.cornerShift += (clamp(yawRate * t.cornerOffset, t.maxCornerOffset) - this.cornerShift) * k;
      this.roll += (clamp(slip * t.rollGain, t.maxRoll) - this.roll) * k;
      this.fov += (fovTarget - this.fov) * k;
    }

    // Target offset: behind, to the right (outwards in a corner) and above.
    s.copy(h).multiplyScalar(-t.distance);
    s.x += rightX * t.rightOffset;
    s.z += rightZ * t.rightOffset;
    s.y = t.height;
    if (reset) this.offset.copy(s);
    else this.offset.lerp(s, 1 - Math.exp(-t.stiffness * Math.max(dt, 0)));

    const camera = this.camera;
    camera.position.copy(car.position).add(this.offset);
    camera.position.addScaledVector(h, -this.accelShift);
    camera.position.x += rightX * this.cornerShift;
    camera.position.z += rightZ * this.cornerShift;
    s.copy(car.position).addScaledVector(h, t.lookAhead);
    s.y += t.lookHeight;
    camera.lookAt(s);
    camera.rotateZ(this.roll);
    if (reset || Math.abs(camera.fov - this.fov) > 1e-3) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }
}
