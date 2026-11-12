/**
 * Drift score from real chassis dynamics. Pure: no imports, DOM or clock.
 * The host calls update() once per fixed physics step with the chassis-local
 * velocity, the loaded grounded wheel count and the largest loaded rear slip.
 * Points build in a chain and are banked into total after a short grace, so a
 * switchback links both halves. It never changes physics.
 */

export interface DriftThresholds {
  /** Minimum planar speed, m/s. */
  minSpeed: number;
  /** Minimum forward speed, m/s: no points in reverse or mid-spin. */
  minForward: number;
  /** Minimum loaded grounded wheels. */
  minWheels: number;
  /** Scoring slip-angle window, rad. */
  minAngle: number;
  maxAngle: number;
  /** Minimum real rear slip speed, m/s. */
  minRearSlip: number;
  /** Time without scoring before the chain is banked, s. */
  grace: number;
  /** Points per (m/s * rad) per second. */
  rate: number;
}

const DEG = Math.PI / 180;
export const DRIFT_DEFAULTS: Readonly<DriftThresholds> = {
  minSpeed: 8, minForward: 3, minWheels: 3, minAngle: 13 * DEG, maxAngle: 60 * DEG, minRearSlip: 1.5, grace: 0.4, rate: 8,
};

export class DriftScore {
  private readonly cfg: DriftThresholds;
  private _total = 0;
  private _chain = 0;
  private _angle = 0;
  private _active = false;
  private idle = 0;

  constructor(thresholds: Partial<DriftThresholds> = {}) {
    this.cfg = { ...DRIFT_DEFAULTS, ...thresholds };
  }

  /** Banked points. */
  get total(): number { return this._total; }
  /** Points of the current chain, not banked yet. */
  get chain(): number { return this._chain; }
  /** True while a chain is waiting to be banked. */
  get pending(): boolean { return this._chain > 0; }
  /** True only if the last step itself qualified. */
  get active(): boolean { return this._active; }
  /** Signed slip angle of the last step, rad: atan2(side, max(|forward|, 1)). */
  get angle(): number { return this._angle; }

  update(dt: number, forwardSpeed: number, sideSpeed: number, loadedGroundedWheelCount: number, maxLoadedRearSlipSpeed: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const c = this.cfg;
    const ok = Number.isFinite(forwardSpeed) && Number.isFinite(sideSpeed)
      && Number.isFinite(loadedGroundedWheelCount) && Number.isFinite(maxLoadedRearSlipSpeed);
    const speed = ok ? Math.hypot(forwardSpeed, sideSpeed) : 0;
    this._angle = ok ? Math.atan2(sideSpeed, Math.max(Math.abs(forwardSpeed), 1)) : 0;
    const angle = Math.abs(this._angle);
    this._active = ok && speed >= c.minSpeed && forwardSpeed >= c.minForward && loadedGroundedWheelCount >= c.minWheels
      && angle >= c.minAngle && angle <= c.maxAngle && maxLoadedRearSlipSpeed >= c.minRearSlip;
    if (this._active) {
      this._chain += speed * angle * c.rate * dt;
      this.idle = 0;
    } else if (this._chain > 0 && (this.idle += dt) >= c.grace - 1e-9) {
      this.stop();
    }
  }

  /** Banks the current chain now, adding no new points. Safe to call repeatedly. */
  stop(): void {
    this._total += this._chain;
    this._chain = 0;
    this.idle = 0;
    this._active = false;
  }

  /** Clears banked points, chain and angle. */
  reset(): void {
    this.stop();
    this._total = 0;
    this._angle = 0;
  }
}
