import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CHASE_CAMERA, PHYSICS_HZ, VEHICLE } from './config';
import { GameLoop } from './core/GameLoop';
import { Input } from './core/Input';
import { Car } from './entities/Car';
import { PhysicsWorld } from './physics/PhysicsWorld';
import { RaycastVehicle, type VehicleInput } from './physics/RaycastVehicle';
import { createScene } from './render/SceneSetup';
import { Hud } from './ui/Hud';
import { TouchControls } from './ui/TouchControls';
import { addPassColliders, readRoute } from './world/MountainPass';
import './styles.css';

async function bootstrap(): Promise<void> {
  const { renderer, scene, camera } = createScene();
  const loader = new GLTFLoader();
  const [physics, coupe, pass, route] = await Promise.all([
    PhysicsWorld.create(),
    loader.loadAsync('/assets/touge/coupe.glb'),
    loader.loadAsync('/assets/touge/mountain_pass.glb'),
    fetch('/assets/touge/route.json').then(async response => {
      if (!response.ok) throw Error(`Cannot load route (${response.status})`);
      return readRoute(await response.json());
    }),
  ]);
  scene.add(pass.scene);
  pass.scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial && material.map) {
        material.map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      }
    }
  });
  addPassColliders(pass.scene, physics.world);
  const vehicle = new RaycastVehicle(RAPIER, physics.world, VEHICLE);
  const car = new Car(vehicle, coupe.scene);
  scene.add(car.root);

  for (const x of [-0.54, 0.54]) {
    const light = new THREE.SpotLight(0xffe3b0, 650, 65, 0.32, 0.7, 2);
    light.position.set(x, 0.05, -2.02);
    light.target.position.set(x, -0.48, -35);
    car.root.add(light, light.target);
  }
  const brakeLight = new THREE.PointLight(0xff2417, 0.35, 3.5, 2);
  brakeLight.position.set(0, 0.1, 2.05);
  car.root.add(brakeLight);
  const tailMaterials: THREE.MeshStandardMaterial[] = [];
  car.root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial && material.name === 'TailLamp') {
        material.emissive.setHex(0xff180f);
        tailMaterials.push(material);
      }
    }
  });

  const input = new Input(window);
  const hud = new Hud(route.points, route.length);
  // Touch screens, including hybrid laptops; the keyboard keeps working.
  if (navigator.maxTouchPoints > 0 || matchMedia('(any-pointer: coarse)').matches) {
    document.body.dataset.touch = 'true';
    new TouchControls(input, document, window);
  }
  const controls: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  const heading = new THREE.Vector3(0, 0, -1);
  const scratch = new THREE.Vector3();
  const desired = new THREE.Vector3();
  let snapCamera = true;

  const updateCamera = (frameDt: number): void => {
    scratch.set(0, 0, -1).applyQuaternion(car.root.quaternion);
    scratch.y = 0;
    if (scratch.lengthSq() > 1e-4) heading.copy(scratch).normalize();
    desired.copy(car.root.position).addScaledVector(heading, -CHASE_CAMERA.distance);
    desired.x -= heading.z * 1.35;
    desired.z += heading.x * 1.35;
    desired.y += 2.65;
    if (snapCamera) { camera.position.copy(desired); snapCamera = false; }
    else camera.position.lerp(desired, 1 - Math.exp(-CHASE_CAMERA.stiffness * frameDt));
    scratch.copy(car.root.position).addScaledVector(heading, 5);
    scratch.y += 0.6;
    camera.lookAt(scratch);
    const fov = 63 + Math.min(vehicle.speed / 50, 1) * 5;
    if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = fov; camera.updateProjectionMatrix(); }
  };

  document.body.dataset.ready = 'true';
  const loop = new GameLoop({
    fixedUpdate: dt => {
      controls.throttle = input.isHeld('KeyW') ? 1 : 0;
      controls.brake = input.isHeld('KeyS') ? 1 : 0;
      controls.steer = Number(input.isHeld('KeyD')) - Number(input.isHeld('KeyA'));
      controls.handbrake = input.isHeld('Space');
      if (input.consumeReset()) { car.reset(); snapCamera = true; }
      car.savePreviousPose();
      vehicle.update(controls, dt);
      physics.step();
      car.readPhysicsPose();
    },
    render: (alpha, frameDt) => {
      car.render(alpha);
      updateCamera(frameDt);
      const braking = controls.brake > 0 || controls.handbrake;
      brakeLight.intensity = braking ? 1.2 : 0.35;
      for (const material of tailMaterials) material.emissiveIntensity = braking ? 2.8 : 0.8;
      renderer.render(scene, camera);
      const velocity = vehicle.body.linvel();
      hud.update(Math.hypot(velocity.x, velocity.z) * 3.6, car.root.position,
        Math.atan2(heading.x, -heading.z), controls.handbrake, vehicle.forwardSpeed < -0.5);
    },
  }, { fixedHz: PHYSICS_HZ });
  loop.start();
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  const loading = document.querySelector('#loading span');
  if (loading) loading.textContent = `Could not load the pass. ${String(error)}`;
});
