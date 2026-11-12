import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three';
import ts from 'typescript';

// Transpile the real sources standalone; the runtime 'three' import is pointed at the real package.
async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/from\s+['"]three['"]/, `from ${JSON.stringify(import.meta.resolve('three'))}`);
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

const { CHASE_CAMERA } = await load('../src/config.ts');
const { ChaseCamera } = await load('../src/render/ChaseCamera.ts');

const STILL = { x: 0, y: 0, z: 0 };
const rig = () => {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  const car = new THREE.Object3D();
  return { camera, car, chase: new ChaseCamera(camera, CHASE_CAMERA) };
};
const gap = (camera, car) => camera.position.distanceTo(car.position);
const rollSine = camera => new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).y;

test('constant 50 m/s adds no unbounded following distance and widens the FOV comfortably', () => {
  const { camera, car, chase } = rig();
  chase.update(car, STILL, 0, 1 / 60);
  const rest = gap(camera, car);
  const idleFov = camera.fov;
  const velocity = { x: 0, y: 0, z: -50 };
  let worst = 0;
  for (let i = 0; i < 300; i++) {
    car.position.z -= 50 / 60;
    chase.update(car, velocity, 0, 1 / 60);
    worst = Math.max(worst, gap(camera, car));
  }
  assert.ok(Number.isFinite(worst) && worst <= rest + 1.5, `worst ${worst} vs rest ${rest}`);
  assert.ok(Math.abs(gap(camera, car) - rest) < 0.1, 'steady speed settles at the rest distance');
  assert.ok(camera.position.z > car.position.z, 'camera stays behind');
  assert.ok(camera.position.x > car.position.x, 'camera stays to the right');
  assert.ok(camera.position.y > car.position.y, 'camera stays above');
  assert.ok(Number.isFinite(camera.fov) && camera.fov > idleFov + 1, `fov ${camera.fov}`);
  assert.ok(camera.fov <= CHASE_CAMERA.fovMax + 1e-9 && camera.fov <= 75, `fov ${camera.fov}`);
});

test('a static pose converges identically at 60 Hz and 120 Hz', () => {
  const run = hz => {
    const { camera, car, chase } = rig();
    const velocity = { x: 3, y: 0, z: -12 };
    car.rotation.y = 0.3;
    chase.update(car, velocity, 0.4, 1 / hz, true);
    car.position.set(4, 0, -9);
    car.rotation.y = 1.1;
    for (let i = 0; i < hz; i++) chase.update(car, velocity, 0.4, 1 / hz);
    return camera;
  };
  const a = run(60);
  const b = run(120);
  assert.ok(a.position.distanceTo(b.position) < 1e-6, `positions differ by ${a.position.distanceTo(b.position)}`);
  assert.ok(a.quaternion.angleTo(b.quaternion) < 1e-6);
  assert.ok(Math.abs(a.fov - b.fov) < 0.01);
});

test('first update and reset snap do not jump or keep stale filter state', () => {
  const { camera, car, chase } = rig();
  car.position.set(100, 2, 100);
  chase.update(car, STILL, 0, 1 / 60);
  const rest = gap(camera, car);
  const idleFov = camera.fov;
  assert.ok(Number.isFinite(rest) && rest < 15, `first update placed the camera ${rest} m away`);
  const velocity = { x: 20, y: 0, z: -30 };
  for (let i = 0; i < 120; i++) {
    car.position.x += 20 / 60;
    car.position.z -= 30 / 60;
    chase.update(car, velocity, 0.5, 1 / 60);
  }
  car.position.set(-500, 20, 300);
  car.rotation.y = 2;
  chase.update(car, STILL, 0, 1 / 60, true);
  assert.ok(Math.abs(gap(camera, car) - rest) < 1e-6, 'snap restores the rest offset at the new pose');
  assert.ok(Math.abs(camera.fov - idleFov) < 1e-6, 'snap restores the idle FOV');
  assert.ok(Math.abs(rollSine(camera)) < 1e-6, 'snap clears roll');
  const before = camera.position.clone();
  chase.update(car, STILL, 0, 1 / 60);
  assert.ok(before.distanceTo(camera.position) < 1e-6, 'no movement on the frame after a snap');
});

test('roll is zero when driving straight and finite and subtle when sliding sideways', () => {
  const straight = rig();
  for (let i = 0; i < 120; i++) straight.chase.update(straight.car, { x: 0, y: 0, z: -20 }, 0, 1 / 60);
  assert.ok(Math.abs(rollSine(straight.camera)) < 1e-6);
  const slide = rig();
  for (let i = 0; i < 120; i++) slide.chase.update(slide.car, { x: 8, y: 0, z: -20 }, 0.6, 1 / 60);
  const roll = Math.abs(rollSine(slide.camera));
  assert.ok(Number.isFinite(roll) && roll > 1e-3, `roll sine ${roll}`);
  assert.ok(roll <= Math.sin(THREE.MathUtils.degToRad(2.5)), `roll sine ${roll}`);
  assert.ok(Number.isFinite(gap(slide.camera, slide.car)));
});

test('60 Hz physics velocity samples give consistent braking lag on 60/120/144 Hz displays', () => {
  const atRate = hz => {
    const {camera,car,chase}=rig();
    chase.update(car,{x:0,z:-25},0,0,true);
    for(let frame=1;frame<=hz;frame++){
      const physicsTime=Math.floor(frame/hz*60+1e-9)/60;
      chase.update(car,{x:0,z:-(25-12*physicsTime)},0,1/hz);
    }
    return camera.position.z-car.position.z;
  };
  const baseline=atRate(60);
  for(const hz of [120,144]) assert.ok(Math.abs(atRate(hz)-baseline)<0.06,`${hz} Hz braking lag differs from 60 Hz`);
});
