/**
 * Near-miss detector. About ten times per simulated second it casts one horizontal ray to each side of
 * the chassis and reports a single event when a fast, grounded car passes a near-vertical obstacle within
 * `range` of its side without touching anything. Data only: it applies no forces and changes no chassis or world state.
 *
 * A valid fast sample with nothing close must come first (armed), so starting, resetting or accelerating
 * beside a wall never fires. Any slow, airborne or touching sample disarms.
 *
 * No runtime imports (the import below is erased): Node tests run it against the real Rapier WASM.
 */
import type RAPIER from '@dimforge/rapier3d-compat';

export const NEAR_MISS = { interval: 0.1, minSpeed: 22, range: 0.45, cooldown: 1.5, minWheels: 3, maxNormalY: 0.4 } as const;

export class NearMiss {
  private readonly world: RAPIER.World;
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly reach: number;
  private readonly left: RAPIER.Ray;
  private readonly right: RAPIER.Ray;
  private timer = 0;
  private cooldown = 0;
  private armed = false;
  private touching = false;
  // Large trimeshes can be contact-graph candidates without any actual contact.
  private readonly onManifold = (manifold: RAPIER.TempContactManifold): void => {
    if (manifold.numSolverContacts() > 0) this.touching = true;
  };
  private readonly onPair = (other: RAPIER.Collider): void => {
    if (!this.touching) this.world.contactPair(this.collider, other, this.onManifold);
  };

  constructor(rapier: Pick<typeof RAPIER, 'Ray'>, world: RAPIER.World, body: RAPIER.RigidBody, collider: RAPIER.Collider, halfWidth: number) {
    this.world = world;
    this.body = body;
    this.collider = collider;
    this.reach = halfWidth + NEAR_MISS.range;
    this.left = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: -1, y: 0, z: 0 });
    this.right = new rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  }

  /** Call once per fixed step after world.step(), in driving phases only. True at most once per pass. */
  update(dt: number, loadedWheelCount: number): boolean {
    if (!Number.isFinite(dt) || !(dt > 0)) return false;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.timer += dt;
    if (this.timer < NEAR_MISS.interval - 1e-9) return false;
    this.timer = 0;
    const v = this.body.linvel();
    if (!(loadedWheelCount >= NEAR_MISS.minWheels) || !(Math.hypot(v.x, v.z) >= NEAR_MISS.minSpeed)) { this.armed = false; return false; }
    this.touching = false;
    this.world.contactPairsWith(this.collider, this.onPair);
    if (this.touching) { this.armed = false; return false; }
    // Chassis right (local +X), flattened to the horizontal plane.
    const q = this.body.rotation();
    const rx = 1 - 2 * (q.y * q.y + q.z * q.z), rz = 2 * (q.x * q.z - q.w * q.y), length = Math.hypot(rx, rz);
    if (!(length > 1e-6)) { this.armed = false; return false; }
    const p = this.body.translation(), dx = rx / length, dz = rz / length;
    const leftNear = this.probe(this.left, p, -dx, -dz), rightNear = this.probe(this.right, p, dx, dz);
    if (!leftNear && !rightNear) { this.armed = true; return false; }
    if (!this.armed) return false;
    // Latch: the next event needs a far sample first, whether or not this one is inside the cooldown.
    this.armed = false;
    if (this.cooldown > 1e-9) return false;
    this.cooldown = NEAR_MISS.cooldown;
    return true;
  }

  /** After a respawn or teleport: disarmed, no cooldown, next probe a full interval away. */
  reset(): void {
    this.timer = 0;
    this.cooldown = 0;
    this.armed = false;
  }

  private probe(ray: RAPIER.Ray, origin: { x: number; y: number; z: number }, dx: number, dz: number): boolean {
    ray.origin.x = origin.x;
    ray.origin.y = origin.y;
    ray.origin.z = origin.z;
    ray.dir.x = dx;
    ray.dir.y = 0;
    ray.dir.z = dz;
    const hit = this.world.castRayAndGetNormal(ray, this.reach, true, undefined, undefined, undefined, this.body);
    return hit !== null && Math.abs(hit.normal.y) <= NEAR_MISS.maxNormalY;
  }
}
