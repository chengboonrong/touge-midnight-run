import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import RAPIER from '@dimforge/rapier3d-compat';

await RAPIER.init();

// Both sources have no runtime imports, so they are transpiled standalone and run against the real Rapier WASM.
async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

const { VEHICLE } = await load('../src/config.ts');
const { RaycastVehicle } = await load('../src/physics/RaycastVehicle.ts');

const IDLE = { throttle: 0, brake: 0, steer: 0, handbrake: false };
const DT = 1 / 60;

function rig(t) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;
  t.after(() => world.free());
  world.createCollider(RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0));
  const vehicle = new RaycastVehicle(RAPIER, world, VEHICLE);
  const step = count => {
    for (let i = 0; i < count; i++) {
      vehicle.update(IDLE, DT);
      world.step();
    }
  };
  return { vehicle, step };
}

const assertZero = (wheel, label) => {
  for (const vector of [wheel.contactPoint, wheel.contactNormal]) {
    for (const axis of ['x', 'y', 'z']) assert.equal(vector[axis], 0, `${label} ${axis}`);
  }
};

test('contact telemetry starts as finite zeros and stays zero in the air', t => {
  const { vehicle, step } = rig(t);
  vehicle.wheels.forEach((wheel, i) => assertZero(wheel, `initial wheel ${i}`));
  step(1); // the spawn height keeps the rays off the ground
  vehicle.wheels.forEach((wheel, i) => {
    assert.equal(wheel.grounded, false);
    assertZero(wheel, `airborne wheel ${i}`);
  });
});

test('a loaded wheel reports the actual ray hit on the plane, in FL FR RL RR order', t => {
  const { vehicle, step } = rig(t);
  const owned = vehicle.wheels.map(wheel => [wheel.contactPoint, wheel.contactNormal]);
  step(180);
  const centre = vehicle.body.translation();
  const sideSign = [-1, 1, -1, 1];
  const axleZ = [VEHICLE.frontAxleZ, VEHICLE.frontAxleZ, VEHICLE.rearAxleZ, VEHICLE.rearAxleZ];
  vehicle.wheels.forEach((wheel, i) => {
    assert.ok(wheel.grounded && wheel.load > 0, `wheel ${i} is loaded`);
    const p = wheel.contactPoint;
    const n = wheel.contactNormal;
    for (const value of [p.x, p.y, p.z, n.x, n.y, n.z]) assert.ok(Number.isFinite(value));
    assert.ok(Math.abs(p.y) < 1e-3, `wheel ${i} hit height ${p.y}`);
    assert.ok(Math.abs(p.x - (centre.x + sideSign[i] * VEHICLE.halfTrack)) < 0.05, `wheel ${i} x ${p.x}`);
    assert.ok(Math.abs(p.z - (centre.z + axleZ[i])) < 0.05, `wheel ${i} z ${p.z}`);
    assert.ok(Math.abs(n.x) < 1e-4 && Math.abs(n.z) < 1e-4 && Math.abs(n.y - 1) < 1e-4, `wheel ${i} normal`);
    assert.equal(wheel.contactPoint, owned[i][0], 'contact point object is reused');
    assert.equal(wheel.contactNormal, owned[i][1], 'contact normal object is reused');
  });
});

test('leaving the ground and reset() clear the contact telemetry without replacing the vectors', t => {
  const { vehicle, step } = rig(t);
  const owned = vehicle.wheels.map(wheel => [wheel.contactPoint, wheel.contactNormal]);
  step(180);
  assert.ok(vehicle.wheels.every(wheel => wheel.contactNormal.y > 0.9));
  vehicle.body.setTranslation({ x: 0, y: 10, z: 0 }, true);
  step(1);
  vehicle.wheels.forEach((wheel, i) => {
    assert.equal(wheel.grounded, false);
    assertZero(wheel, `lifted wheel ${i}`);
  });
  vehicle.reset();
  step(180);
  assert.ok(vehicle.wheels.every(wheel => wheel.contactNormal.y > 0.9), 'grounded again after reset');
  vehicle.reset();
  vehicle.wheels.forEach((wheel, i) => {
    assertZero(wheel, `reset wheel ${i}`);
    assert.equal(wheel.contactPoint, owned[i][0]);
    assert.equal(wheel.contactNormal, owned[i][1]);
  });
});
