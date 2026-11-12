import * as THREE from 'three';
import type { RaycastVehicle } from '../physics/RaycastVehicle';

/**
 * Binds the Blender coupe to the rigid body and its four suspension wheels.
 *
 * Physics runs at a fixed rate, so the car keeps the previous and the current
 * physics pose and renders a blend of the two. Per fixed step:
 *
 *   car.savePreviousPose();   // before the step
 *   vehicle.update(...); world.step();
 *   car.readPhysicsPose();    // after the step
 *
 * and once per frame: car.render(alpha).
 */

interface WheelPose {
  suspensionLength: number;
  steerAngle: number;
  spinAngle: number;
}

export class Car {
  /** Add this to the scene. After render() it holds the interpolated pose. */
  readonly root: THREE.Group;

  private readonly vehicle: RaycastVehicle;
  /** Per wheel: moves with the suspension and turns with the steering. */
  private readonly wheelPivots: THREE.Object3D[] = [];
  /** Per wheel: child of the pivot, rolls about the axle. */
  private readonly wheelSpinners: THREE.Group[] = [];

  private readonly prevPosition = new THREE.Vector3();
  private readonly currPosition = new THREE.Vector3();
  private readonly prevQuaternion = new THREE.Quaternion();
  private readonly currQuaternion = new THREE.Quaternion();
  private readonly prevWheels: WheelPose[] = [];
  private readonly currWheels: WheelPose[] = [];

  constructor(vehicle: RaycastVehicle, model: THREE.Group) {
    this.vehicle = vehicle;
    this.root = model;
    const names = ['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'];
    for (const name of names) {
      const pivot = model.getObjectByName(name);
      if (!pivot) throw Error(`Coupe asset is missing ${name}`);
      const spinner = new THREE.Group();
      spinner.add(...pivot.children.slice());
      pivot.add(spinner);
      this.wheelPivots.push(pivot);
      this.wheelSpinners.push(spinner);
      this.prevWheels.push({ suspensionLength: 0, steerAngle: 0, spinAngle: 0 });
      this.currWheels.push({ suspensionLength: 0, steerAngle: 0, spinAngle: 0 });
    }
    model.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });

    this.snap();
    this.render(1);
  }

  /** Call once per fixed step, before the vehicle and the world advance. */
  savePreviousPose(): void {
    this.prevPosition.copy(this.currPosition);
    this.prevQuaternion.copy(this.currQuaternion);
    for (let i = 0; i < this.currWheels.length; i++) {
      Object.assign(this.prevWheels[i], this.currWheels[i]);
    }
  }

  /** Call once per fixed step, after world.step(). */
  readPhysicsPose(): void {
    const p = this.vehicle.body.translation();
    const q = this.vehicle.body.rotation();
    this.currPosition.set(p.x, p.y, p.z);
    this.currQuaternion.set(q.x, q.y, q.z, q.w);
    for (let i = 0; i < this.currWheels.length; i++) {
      const wheel = this.vehicle.wheels[i];
      const pose = this.currWheels[i];
      pose.suspensionLength = wheel.suspensionLength;
      pose.steerAngle = wheel.steerAngle;
      pose.spinAngle = wheel.spinAngle;
    }
  }

  /**
   * Makes the previous pose equal to the current physics pose, so the next
   * render() shows it exactly instead of blending from somewhere else.
   */
  snap(): void {
    this.readPhysicsPose();
    this.savePreviousPose();
  }

  /** Puts the vehicle back on its spawn and snaps, so the jump is not blended. */
  reset(): void {
    this.vehicle.reset();
    this.snap();
  }

  /** Poses the meshes `alpha` (0..1) of the way from the previous to the current pose. */
  render(alpha: number): void {
    this.root.position.lerpVectors(this.prevPosition, this.currPosition, alpha);
    this.root.quaternion.slerpQuaternions(this.prevQuaternion, this.currQuaternion, alpha);

    const mounts = this.vehicle.wheelMounts;
    for (let i = 0; i < this.wheelPivots.length; i++) {
      const from = this.prevWheels[i];
      const to = this.currWheels[i];
      const pivot = this.wheelPivots[i];
      pivot.position.y =
        mounts[i].y - THREE.MathUtils.lerp(from.suspensionLength, to.suspensionLength, alpha);
      pivot.rotation.y = THREE.MathUtils.lerp(from.steerAngle, to.steerAngle, alpha);
      // Rolling forwards (-Z) turns the wheel backwards about its +X axle.
      this.wheelSpinners[i].rotation.x = -THREE.MathUtils.lerp(from.spinAngle, to.spinAngle, alpha);
    }
  }
}
