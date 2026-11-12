// Development tuning: pure parse/clone helpers and real Rapier 0.14 mass properties.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import RAPIER from '@dimforge/rapier3d-compat';

const load = async path => {
  const source = await readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
};
const { VEHICLE } = await load('config.ts');
const tune = await load('physics/VehicleTune.ts');
const { RaycastVehicle } = await load('physics/RaycastVehicle.ts');
await RAPIER.init();

const STOCK = structuredClone(VEHICLE);
const raw = (changes = {}) => ({
  ...Object.fromEntries(Object.entries(tune.tuneDisplay(VEHICLE)).map(([key, value]) => [key, String(value)])),
  ...changes,
});
const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) <= 1e-4 * Math.max(1, Math.abs(expected)), `${label}: ${actual} vs ${expected}`);

test('stock display values parse back to the stock patch; kW converts to W', () => {
  const stock = tune.parseTune(raw(), VEHICLE);
  assert.equal(stock.ok, true);
  assert.deepEqual(stock.patch, tune.tunePatch(VEHICLE));
  const more = tune.parseTune(raw({ enginePeakPowerKw: '200', centerOfMassY: '-0.1' }), VEHICLE);
  assert.equal(more.ok, true);
  assert.equal(more.patch.enginePeakPower, 200000);
  assert.equal(more.patch.centerOfMassY, -0.1);
});

test('one invalid field rejects the whole patch', () => {
  const bad = [
    ['mass', 'NaN'], ['mass', 'Infinity'], ['mass', ''], ['mass', 'abc'], ['mass', '1700'],
    ['enginePeakPowerKw', '79'], ['centerOfMassY', '0.11'], ['handbrakeGripRecoveryTime', '0.7'],
    ['gear3', '2.1'], ['gear5', '0.3'], ['gear1', '6'], ['gear1', '5.9'],
  ];
  for (const [key, value] of bad) {
    const result = tune.parseTune(raw({ enginePeakTorque: '400', [key]: value }), VEHICLE);
    assert.equal(result.ok, false, `${key}=${value}`);
    assert.ok(result.error.length > 0);
    assert.equal('patch' in result, false);
  }
  assert.deepEqual(VEHICLE, STOCK);
});

test('clone is isolated from the stock defaults and stock can be restored', () => {
  const copy = tune.cloneTuning(VEHICLE);
  assert.deepEqual(copy, STOCK);
  const patch = { ...tune.tunePatch(VEHICLE), mass: 1500, centerOfMassY: -0.15, gearRatios: [3, 2, 1.4, 1.1, 0.9] };
  tune.applyTune(copy, patch);
  assert.notEqual(copy.gearRatios, patch.gearRatios);
  copy.gearRatios[0] = 5;
  copy.spawn.x = 99;
  copy.chassisHalfExtents.x = 9;
  assert.equal(patch.gearRatios[0], 3);
  assert.deepEqual(VEHICLE, STOCK);
  tune.applyTune(copy, tune.tunePatch(VEHICLE));
  assert.deepEqual(tune.tunePatch(copy), tune.tunePatch(STOCK));
});

test('applyMassProperties sets real mass, centre of mass and box inertia at once', t => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  t.after(() => world.free());
  const tuning = tune.cloneTuning(VEHICLE);
  const vehicle = new RaycastVehicle(RAPIER, world, tuning);
  const body = vehicle.body;
  const zero = { x: 0, y: 0, z: 0 };
  // Reference: the original construction, collider.setMass only.
  const h = VEHICLE.chassisHalfExtents;
  const ref = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(50, 0, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z).setMass(VEHICLE.mass), ref);
  ref.recomputeMassPropertiesFromColliders();
  const spin = target => {
    target.setAngvel(zero, true);
    target.applyTorqueImpulse({ x: 300, y: 500, z: 700 }, true);
    const w = target.angvel();
    target.setAngvel(zero, true);
    return w;
  };
  const push = target => {
    target.setLinvel(zero, true);
    target.applyImpulse({ x: 1200, y: 0, z: 0 }, true);
    const v = target.linvel().x;
    target.setLinvel(zero, true);
    return v;
  };
  const expectStock = () => {
    near(body.mass(), 1200, 'stock mass');
    near(body.localCom().y, 0, 'stock com y');
    near(push(body), 1, 'stock push');
    const a = spin(body), b = spin(ref);
    for (const axis of ['x', 'y', 'z']) near(a[axis], b[axis], `stock spin ${axis}`);
    return a;
  };
  const pose = vehicle.collider.translation();
  const stockSpin = expectStock();

  tune.applyTune(tuning, { ...tune.tunePatch(VEHICLE), mass: 1500, centerOfMassY: -0.15 });
  vehicle.applyMassProperties();
  near(body.mass(), 1500, 'tuned mass');
  const com = body.localCom();
  near(com.x, 0, 'com x'); near(com.y, -0.15, 'com y'); near(com.z, 0, 'com z');
  near(push(body), 0.8, 'tuned push');
  const tuned = spin(body);
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Number.isFinite(tuned[axis]) && tuned[axis] !== 0, `tuned spin ${axis}`);
    near(tuned[axis], stockSpin[axis] * 0.8, `tuned spin ${axis}`);
  }
  const after = vehicle.collider.translation();
  for (const axis of ['x', 'y', 'z']) near(after[axis], pose[axis], `box ${axis}`);

  tune.applyTune(tuning, tune.tunePatch(VEHICLE));
  vehicle.applyMassProperties();
  expectStock();
});

test('mass, COM and spring range corners remain supported and brake upright', t => {
  for (const [mass, centerOfMassY, suspensionStiffness] of [[900, -0.2, 42000], [1600, 0.1, 18000]]) {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = 1 / 60;
    t.after(() => world.free());
    world.createCollider(RAPIER.ColliderDesc.cuboid(100, 0.5, 300).setTranslation(0, -0.5, 0));
    const tuning = { ...tune.cloneTuning(VEHICLE), mass, centerOfMassY, suspensionStiffness };
    const vehicle = new RaycastVehicle(RAPIER, world, tuning);
    const step = input => { vehicle.update(input, 1 / 60); world.step(); };
    const idle = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    for (let i = 0; i < 180; i++) step(idle);
    assert.ok(vehicle.wheels.every(w => w.grounded && w.load > 100), `supported ${mass}`);
    for (let i = 0; i < 240; i++) step({ ...idle, throttle: 1 });
    assert.ok(vehicle.forwardSpeed > 8, `accelerates ${mass}`);
    for (let i = 0; i < 240; i++) step({ ...idle, brake: vehicle.forwardSpeed > 0.6 ? 1 : 0 });
    const p = vehicle.body.translation(), q = vehicle.body.rotation();
    assert.ok([p.x, p.y, p.z, q.x, q.y, q.z, q.w].every(Number.isFinite));
    assert.ok(p.y > 0.3, `chassis clears floor ${mass}: ${p.y}`);
    assert.ok(1 - 2 * (q.x * q.x + q.z * q.z) > 0.98, `upright ${mass}`);
    assert.ok(Math.abs(vehicle.forwardSpeed) < 1, `braked ${mass}: ${vehicle.forwardSpeed}`);
  }
});
