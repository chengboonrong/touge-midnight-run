import RAPIER from '@dimforge/rapier3d-compat';
import { FIXED_DT, GRAVITY } from '../config';

/**
 * Owns the Rapier world and its fixed timestep.
 *
 * Construction is async because the compat build must load its WASM before any
 * other Rapier call, so instances only come from PhysicsWorld.create().
 * Bodies and colliders are created by callers through `world`.
 */
export class PhysicsWorld {
  readonly world: RAPIER.World;

  private constructor(world: RAPIER.World) {
    this.world = world;
  }

  static async create(): Promise<PhysicsWorld> {
    await RAPIER.init();
    const world = new RAPIER.World({ x: GRAVITY.x, y: GRAVITY.y, z: GRAVITY.z });
    world.timestep = FIXED_DT;
    return new PhysicsWorld(world);
  }

  /** Step length in seconds, as configured on the Rapier world. */
  get timestep(): number {
    return this.world.timestep;
  }

  /** Advances the simulation by exactly one fixed timestep. */
  step(): void {
    this.world.step();
  }
}
