/**
 * Sustained guardrail scrape level from actual Rapier contacts. After every world step it looks at the
 * chassis contact pairs, but only at the collider handles it was given (the pass's `Guardrails` meshes).
 * A pair counts only when it has solver contacts, a near-vertical surface (not road-like) and a positive
 * normal impulse. Broad-phase candidates alone never count: large trimeshes are always candidates.
 *
 * Data only: it applies no forces and changes no body or world state. It has no timers and no memory of
 * earlier steps, so the level drops to 0 on the first step without a real sliding contact. Smoothing is
 * left to the AudioParam that consumes the level.
 *
 * No runtime imports (the import below is erased): Node tests run it against the real Rapier WASM.
 */
import type RAPIER from '@dimforge/rapier3d-compat';

/**
 * Tuning constants, with units.
 * - minSpeed, fullSpeed (m/s): sliding speed of the chassis contact point along the rail. Silent at or below
 *   minSpeed, full at fullSpeed, linear in between.
 * - fullPressure (m/s^2): contact pressure as an acceleration, normalImpulse / (body.mass() * dt). Dividing by
 *   the real body mass keeps the level the same when development tuning changes the mass. 6 is about 0.6 g.
 * - maxNormalY: contact normals with |y| above this are road-like and ignored.
 * level = speed01 * sqrt(pressure01), strongest manifold wins, always within 0..1.
 */
export const GUARDRAIL_SCRAPE = { minSpeed: 2, fullSpeed: 15, fullPressure: 6, maxNormalY: 0.4 } as const;

export class GuardrailScrape {
  private readonly world: RAPIER.World;
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly rails: ReadonlySet<number>;
  private current = 0;
  private best = 0;
  // Body state for the current update, copied to plain numbers before the pair callbacks run.
  private scale = 0;
  private lx = 0; private ly = 0; private lz = 0;
  private ax = 0; private ay = 0; private az = 0;
  private cx = 0; private cy = 0; private cz = 0;
  // The manifold is a temporary owned by Rapier: read inside the callback only, never kept or freed.
  private readonly onManifold = (manifold: RAPIER.TempContactManifold): void => {
    if (!(manifold.numSolverContacts() > 0)) return;
    const normal = manifold.normal();
    if (!normal) return;
    const length = Math.hypot(normal.x, normal.y, normal.z);
    if (!(length > 1e-6)) return;
    const nx = normal.x / length, ny = normal.y / length, nz = normal.z / length;
    if (!(Math.abs(ny) <= GUARDRAIL_SCRAPE.maxNormalY)) return;
    let impulse = 0;
    for (let i = 0, count = manifold.numContacts(); i < count; i++) {
      const j = manifold.contactImpulse(i);
      if (j > 0) impulse += j;
    }
    if (!(impulse > 0)) return;
    const point = manifold.solverContactPoint(0);
    if (!point) return;
    // Velocity of the chassis at the contact point: v + w x (point - centre of mass). The rail is fixed.
    const rx = point.x - this.cx, ry = point.y - this.cy, rz = point.z - this.cz;
    const vx = this.lx + this.ay * rz - this.az * ry;
    const vy = this.ly + this.az * rx - this.ax * rz;
    const vz = this.lz + this.ax * ry - this.ay * rx;
    const vn = vx * nx + vy * ny + vz * nz;
    const slide = Math.hypot(vx - vn * nx, vy - vn * ny, vz - vn * nz);
    const speed = (slide - GUARDRAIL_SCRAPE.minSpeed) / (GUARDRAIL_SCRAPE.fullSpeed - GUARDRAIL_SCRAPE.minSpeed);
    if (!(speed > 0)) return;
    // impulse * scale = impulse / (mass * dt) = m/s^2.
    const pressure = Math.min(1, (impulse * this.scale) / GUARDRAIL_SCRAPE.fullPressure);
    const level = Math.min(1, speed) * Math.sqrt(pressure);
    if (level > this.best) this.best = level;
  };
  private readonly onPair = (other: RAPIER.Collider): void => {
    if (this.rails.has(other.handle)) this.world.contactPair(this.collider, other, this.onManifold);
  };

  constructor(world: RAPIER.World, body: RAPIER.RigidBody, collider: RAPIER.Collider, railHandles: ReadonlySet<number>) {
    this.world = world;
    this.body = body;
    this.collider = collider;
    this.rails = railHandles;
  }

  /** Level from the last update, 0..1. */
  get level(): number { return this.current; }

  /** Call once per fixed step after world.step(). dt turns the step's impulse into a force. Returns the level. */
  update(dt: number): number {
    this.current = 0;
    if (!Number.isFinite(dt) || !(dt > 0)) return 0;
    const mass = this.body.mass();
    if (!Number.isFinite(mass) || !(mass > 0)) return 0;
    this.scale = 1 / (mass * dt);
    const v = this.body.linvel(), w = this.body.angvel(), c = this.body.worldCom();
    this.lx = v.x; this.ly = v.y; this.lz = v.z;
    this.ax = w.x; this.ay = w.y; this.az = w.z;
    this.cx = c.x; this.cy = c.y; this.cz = c.z;
    this.best = 0;
    this.world.contactPairsWith(this.collider, this.onPair);
    const level = this.best;
    this.current = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    return this.current;
  }

  /** After a respawn or teleport: silent until the next update finds a real contact. */
  reset(): void {
    this.current = 0;
    this.best = 0;
  }
}
