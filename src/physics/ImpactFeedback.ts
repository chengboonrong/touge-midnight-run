/**
 * Turns real chassis contact-force events into at most one feedback impulse.
 * Import-free and pure: callers pass plain numbers read inside the Rapier
 * drain callback, so no temporary event object is ever retained.
 *
 * An event is rated by deltaV = force * dt / mass, the speed change it causes
 * in one fixed step. The chassis resting its full weight on something is about
 * g * dt = 0.16 m/s per step at 60 Hz, and the wheels are rays, so suspension
 * load never appears as a contact at all. The thresholds are untuned hypotheses.
 */

/** Smallest per-step speed change that counts as a hit, m/s (about 9x resting weight at 60 Hz). */
export const IMPACT_MIN_DELTA_V = 1.5;
/** Per-step speed change that gives full strength, m/s. */
export const IMPACT_FULL_DELTA_V = 4;
/** Simulation time without a qualifying contact before a new impact may fire, s. */
export const IMPACT_COOLDOWN = 0.25;

/** Contact force (N) equal to IMPACT_MIN_DELTA_V, for the collider's event threshold. */
export function impactThresholdForce(mass: number, dt: number): number {
  return IMPACT_MIN_DELTA_V * mass / dt;
}

export class ImpactFeedback {
  private pending = 0;
  private cooldown = 0;
  private acceptStep = true;

  /** Call once per executed fixed step, before draining that step's contacts. */
  step(dt: number): void {
    if (dt > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    this.acceptStep = this.cooldown <= 1e-9;
  }

  /** One contact-force event. Ignored unless it involves `vehicle` and is hard enough. */
  contact(collider1: number, collider2: number, vehicle: number, forceMagnitude: number, dt: number, mass: number): void {
    if (collider1 !== vehicle && collider2 !== vehicle) return;
    if (!(dt > 0) || !(mass > 0)) return;
    const deltaV = forceMagnitude * dt / mass;
    if (!(deltaV >= IMPACT_MIN_DELTA_V)) return;
    // Any qualifying contact restarts the cooldown, so sustained hard contact thumps once.
    const blocked = !this.acceptStep;
    this.cooldown = IMPACT_COOLDOWN;
    if (blocked) return;
    const t = Math.min(1, (deltaV - IMPACT_MIN_DELTA_V) / (IMPACT_FULL_DELTA_V - IMPACT_MIN_DELTA_V));
    // Within an accepted fixed step, keep the strongest contact. Rendering never changes cooldown eligibility.
    this.pending = Math.max(this.pending, 0.2 + 0.8 * t);
  }

  /** Strength 0.2..1 of the strongest unrendered impact, or 0. Clears it. */
  consume(): number {
    const strength = this.pending;
    this.pending = 0;
    return strength;
  }

  reset(): void {
    this.pending = 0;
    this.cooldown = 0;
    this.acceptStep = true;
  }
}
