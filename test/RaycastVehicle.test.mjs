// Drives the real src/physics/RaycastVehicle.ts with the real src/config.ts
// tuning inside a real Rapier world (the pinned WASM build), stepping exactly
// like the game does: vehicle.update(input, dt), then world.step().

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as rapierModule from '@dimforge/rapier3d-compat';

async function importTs(relativeUrl) {
  const source = await readFile(new URL(relativeUrl, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const executable = outputText.replace(/from (['"])three\1/g, `from ${JSON.stringify(import.meta.resolve('three'))}`);
  return import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);
}

const { FIXED_DT, GRAVITY, VEHICLE } = await importTs('../src/config.ts');
const { RaycastVehicle } = await importTs('../src/physics/RaycastVehicle.ts');
const { Car } = await importTs('../src/entities/Car.ts');
const coupeBytes = await readFile(new URL('../public/assets/touge/coupe.glb', import.meta.url));
const { scene: coupeModel } = await new GLTFLoader().parseAsync(coupeBytes.buffer.slice(coupeBytes.byteOffset, coupeBytes.byteOffset + coupeBytes.byteLength), '');

// Node may load the package as CommonJS or ESM; find the object with init().
const RAPIER = [rapierModule, rapierModule.default, rapierModule.default?.default].find(
  (candidate) => typeof candidate?.init === 'function',
);
assert.ok(RAPIER, 'could not locate the Rapier exports');
await RAPIER.init();

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: false };
const G = -GRAVITY.y;
const WEIGHT = VEHICLE.mass * G;
const SETTLE_STEPS = 300; // 5 s
const FRONT = [0, 1];
const REAR = [2, 3];

// Static equilibrium: each spring carries a quarter of the weight.
const REST_HEIGHT =
  VEHICLE.wheelRadius +
  VEHICLE.suspensionRestLength -
  WEIGHT / 4 / VEHICLE.suspensionStiffness -
  VEHICLE.suspensionMountY;

/** A world with a large flat slab (top at y = 0) and one vehicle. */
function scene(t, tuningOverrides = {}) {
  const world = new RAPIER.World({ x: GRAVITY.x, y: GRAVITY.y, z: GRAVITY.z });
  world.timestep = FIXED_DT;
  t.after(() => world.free());
  world.createCollider(RAPIER.ColliderDesc.cuboid(1000, 0.5, 1000).setTranslation(0, -0.5, 0));

  const vehicle = new RaycastVehicle(RAPIER, world, { ...VEHICLE, ...tuningOverrides });
  const body = vehicle.body;

  const run = (steps, input = {}, afterStep) => {
    const full = { ...NEUTRAL, ...input };
    for (let i = 0; i < steps; i++) {
      vehicle.update(full, FIXED_DT);
      world.step();
      afterStep?.();
    }
  };

  return { world, vehicle, body, run };
}

/** World-space forward (local -Z) of a body. */
function forwardOf(body) {
  const q = body.rotation();
  return {
    x: -2 * (q.x * q.z + q.w * q.y),
    y: -2 * (q.y * q.z - q.w * q.x),
    z: -(1 - 2 * (q.x * q.x + q.y * q.y)),
  };
}

/** World-space up (local +Y) of a body. */
function upOf(body) {
  const q = body.rotation();
  return {
    x: 2 * (q.x * q.y - q.w * q.z),
    y: 1 - 2 * (q.x * q.x + q.z * q.z),
    z: 2 * (q.y * q.z + q.w * q.x),
  };
}

const length = (v) => Math.hypot(v.x, v.y, v.z);

/** Full rigid-body state as plain numbers, for exact comparisons. */
function motion(body) {
  const p = body.translation();
  const q = body.rotation();
  const v = body.linvel();
  const w = body.angvel();
  return [p.x, p.y, p.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, w.x, w.y, w.z];
}

function assertSettled(s, label) {
  const p = s.body.translation();
  assert.ok(Math.abs(p.y - REST_HEIGHT) < 0.01, `${label}: ride height ${p.y} vs ${REST_HEIGHT}`);
  const velocity = s.body.linvel();
  assert.ok(Math.hypot(velocity.x, velocity.z) < 0.01, `${label}: no horizontal drift`);
  // Impulses precede Rapier's gravity substeps. Allow a vertical phase offset
  // below one gravity step; actual ride-height drift is checked separately.
  assert.ok(Math.abs(velocity.y) < G * FIXED_DT, `${label}: vertical speed ${velocity.y}`);
  assert.ok(length(s.body.angvel()) < 0.01, `${label}: spin ${length(s.body.angvel())}`);
  assert.ok(upOf(s.body).y > 0.9999, `${label}: level, up.y ${upOf(s.body).y}`);
  for (const wheel of s.vehicle.wheels) assert.equal(wheel.grounded, true, `${label}: grounded`);
}

test('runs against the exactly pinned Rapier build', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies['@dimforge/rapier3d-compat'], '0.14.0');
  assert.equal(RAPIER.version(), '0.14.0');
});

test('settles on its suspension at a stable, level ride height', (t) => {
  const s = scene(t);
  s.run(SETTLE_STEPS);
  assertSettled(s, 'after 5 s');

  const p = s.body.translation();
  assert.ok(
    Math.hypot(p.x - VEHICLE.spawn.x, p.z - VEHICLE.spawn.z) < 0.01,
    `no drift, at ${p.x}, ${p.z}`,
  );
  // Held up by the rays, not resting on its own collider: this also fails if
  // the rays hit the chassis they start inside of.
  assert.ok(p.y - VEHICLE.chassisHalfExtents.y > 0.05, 'chassis box clears the ground');

  for (const wheel of s.vehicle.wheels) {
    assert.ok(Math.abs(wheel.load - WEIGHT / 4) < 0.05 * (WEIGHT / 4), `load ${wheel.load}`);
    assert.ok(wheel.suspensionLength > 0.02, `not bottomed out: ${wheel.suspensionLength}`);
    assert.ok(
      wheel.suspensionLength < VEHICLE.suspensionRestLength - 0.02,
      `compressed: ${wheel.suspensionLength}`,
    );
  }

  // And it stays there: no creep, no jitter.
  let minY = Infinity;
  let maxY = -Infinity;
  s.run(120, {}, () => {
    const y = s.body.translation().y;
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  });
  assert.ok(maxY - minY < 1e-3, `height wandered by ${maxY - minY}`);
  assertSettled(s, 'after 7 s');
});

test('W accelerates a grounded car forward (-Z) through the rear wheels', (t) => {
  const s = scene(t);
  s.run(SETTLE_STEPS);
  const start = s.body.translation();

  const steps = 120;
  s.run(steps, { throttle: 1 });

  const speed = s.vehicle.forwardSpeed;
  const end = s.body.translation();
  assert.ok(speed > 6, `forward speed ${speed}`);
  // Cannot beat the engine: v <= F / m * t.
  const ceiling = (VEHICLE.engineForce / VEHICLE.mass) * steps * FIXED_DT;
  assert.ok(speed < ceiling * 1.02, `speed ${speed} within engine ceiling ${ceiling}`);
  assert.ok(end.z < start.z - 6, `moved along -Z: ${end.z - start.z}`);
  assert.ok(Math.abs(end.x - start.x) < 0.05, `tracks straight: ${end.x - start.x}`);
  assert.ok(upOf(s.body).y > 0.99, 'stays upright');

  for (const i of REAR) {
    assert.ok(s.vehicle.wheels[i].longitudinalForce > 1000, 'rear wheels drive');
  }
  for (const i of FRONT) {
    assert.ok(s.vehicle.wheels[i].longitudinalForce <= 0, 'front wheels are not driven');
  }
});

test('S brakes a forward-moving car, then reverses; W brakes a reversing car', (t) => {
  const launch = (s) => {
    s.run(SETTLE_STEPS);
    s.run(180, { throttle: 1 });
  };
  const coasting = scene(t);
  const braking = scene(t);
  launch(coasting);
  launch(braking);

  const before = braking.vehicle.forwardSpeed;
  assert.ok(before > 8, `launch speed ${before}`);

  const brakeSteps = 30;
  coasting.run(brakeSteps);
  braking.run(brakeSteps, { brake: 1 });
  for (const wheel of braking.vehicle.wheels) {
    assert.ok(wheel.longitudinalForce < 0, 'all four wheels brake');
  }

  const coasted = coasting.vehicle.forwardSpeed;
  const braked = braking.vehicle.forwardSpeed;
  assert.ok(braked < coasted - 3, `braked ${braked} vs coasted ${coasted}`);
  assert.ok(braked > 0, `still rolling forward after 0.5 s: ${braked}`);
  const deceleration = (before - braked) / (brakeSteps * FIXED_DT);
  assert.ok(
    deceleration < VEHICLE.gripLongitudinal * G * 1.1,
    `deceleration ${deceleration} is bounded by grip`,
  );
  assert.ok(upOf(braking.body).y > 0.98, 'stays upright under braking');

  // Keep holding S: stop, then back up, no faster than the reverse limit.
  braking.run(360, { brake: 1 });
  const reversing = braking.vehicle.forwardSpeed;
  assert.ok(reversing < -2, `reversing at ${reversing}`);
  assert.ok(reversing > -VEHICLE.reverseTopSpeed, `reverse speed ${reversing} is limited`);
  assert.ok(braking.body.linvel().z > 2, 'backs up along +Z');

  // W while rolling backwards: the undriven front wheels push forward = brakes.
  braking.run(1, { throttle: 1 });
  for (const i of FRONT) {
    assert.ok(braking.vehicle.wheels[i].longitudinalForce > 500, 'front brakes oppose reversing');
  }
  braking.run(240, { throttle: 1 });
  assert.ok(braking.vehicle.forwardSpeed > 2, 'then drives forward again');
});

test('A steers left (-X) and D steers right (+X)', (t) => {
  const corner = (steer) => {
    const s = scene(t);
    s.run(SETTLE_STEPS);
    s.run(120, { throttle: 1 });
    s.run(60, { steer });
    return s;
  };

  const left = corner(-1);
  assert.ok(left.vehicle.steerAngle > 0.1, 'front wheels turned left');
  assert.equal(left.vehicle.wheels[0].steerAngle, left.vehicle.steerAngle);
  assert.equal(left.vehicle.wheels[1].steerAngle, left.vehicle.steerAngle);
  assert.equal(left.vehicle.wheels[2].steerAngle, 0, 'rear wheels do not steer');
  assert.equal(left.vehicle.wheels[3].steerAngle, 0, 'rear wheels do not steer');
  assert.ok(forwardOf(left.body).x < -0.2, `heading swung left: ${forwardOf(left.body).x}`);
  assert.ok(left.body.translation().x < -0.5, `moved left: ${left.body.translation().x}`);
  assert.ok(left.body.angvel().y > 0.2, `yawing left: ${left.body.angvel().y}`);
  assert.ok(upOf(left.body).y > 0.9, 'does not roll over');

  const right = corner(1);
  assert.ok(right.vehicle.steerAngle < -0.1, 'front wheels turned right');
  assert.ok(forwardOf(right.body).x > 0.2, `heading swung right: ${forwardOf(right.body).x}`);
  assert.ok(right.body.translation().x > 0.5, `moved right: ${right.body.translation().x}`);
  assert.ok(right.body.angvel().y < -0.2, `yawing right: ${right.body.angvel().y}`);
  assert.ok(upOf(right.body).y > 0.9, 'does not roll over');

  // Same inputs, same result, bit for bit.
  assert.deepEqual(motion(corner(-1).body), motion(left.body));
});

test('the handbrake lets the rear slide: less rear lateral grip', (t) => {
  // Start both cars in the same pure sideways slide towards +X.
  const slide = (handbrake) => {
    const s = scene(t);
    s.run(SETTLE_STEPS);
    s.body.setLinvel({ x: 6, y: 0, z: 0 }, true);
    s.run(15, { handbrake });
    return s;
  };
  const gripped = slide(false);
  const loose = slide(true);

  const rearLateral = (s) =>
    REAR.reduce((sum, i) => sum + Math.abs(s.vehicle.wheels[i].lateralForce), 0);
  assert.ok(
    rearLateral(loose) < rearLateral(gripped),
    `rear lateral force ${rearLateral(loose)} vs ${rearLateral(gripped)}`,
  );

  // Less total grip: the handbrake car is still sliding faster.
  const grippedSlide = gripped.body.linvel().x;
  const looseSlide = loose.body.linvel().x;
  assert.ok(grippedSlide < 6, 'tires slow the slide');
  assert.ok(looseSlide > grippedSlide + 0.3, `slide ${looseSlide} vs ${grippedSlide}`);

  // The front still bites while the rear lets go, so the tail swings out
  // ahead of the nose: yaw about +Y for a slide towards +X.
  const grippedYaw = gripped.body.angvel().y;
  const looseYaw = loose.body.angvel().y;
  assert.ok(looseYaw > grippedYaw + 0.2, `yaw rate ${looseYaw} vs ${grippedYaw}`);
  assert.ok(looseYaw > 0.2, `tail steps out: ${looseYaw}`);
});

test('tires produce no thrust, braking or steering force in the air', (t) => {
  const high = { spawn: { x: 0, y: 2.5, z: 0 } };
  const airSteps = 30; // 0.5 s of free fall: still well above ray reach

  const fall = (input) => {
    const s = scene(t, high);
    s.run(airSteps, input, () => {
      for (const wheel of s.vehicle.wheels) {
        assert.equal(wheel.grounded, false);
        assert.equal(wheel.load, 0);
        assert.equal(wheel.longitudinalForce, 0);
        assert.equal(wheel.lateralForce, 0);
      }
    });
    return s;
  };

  const passive = fall({});
  const powered = fall({ throttle: 1, steer: -1 });
  const braked = fall({ brake: 1, steer: 1, handbrake: true });

  const v = powered.body.linvel();
  const w = powered.body.angvel();
  assert.ok(v.y < -4, `falling: ${v.y}`);
  assert.ok(v.x === 0 && v.z === 0, `no horizontal thrust: ${v.x}, ${v.z}`);
  assert.ok(w.x === 0 && w.y === 0 && w.z === 0, 'no torque');

  // Inputs change nothing at all while airborne.
  assert.deepEqual(motion(powered.body), motion(passive.body));
  assert.deepEqual(motion(braked.body), motion(passive.body));

  // The same throttle does drive the car once the wheels are down.
  powered.run(180, { throttle: 1 });
  assert.ok(powered.vehicle.forwardSpeed > 3, `drives after landing: ${powered.vehicle.forwardSpeed}`);
});

test('tire forces never exceed the grip that the wheel load allows', (t) => {
  const s = scene(t);
  const maxGrip = Math.max(
    VEHICLE.gripLongitudinal,
    VEHICLE.gripLateralFront,
    VEHICLE.gripLateralRear,
  );
  let groundedSamples = 0;
  const check = () => {
    for (const wheel of s.vehicle.wheels) {
      const tireForce = Math.hypot(wheel.longitudinalForce, wheel.lateralForce);
      assert.ok(Number.isFinite(wheel.load) && Number.isFinite(tireForce));
      assert.ok(wheel.load >= 0 && wheel.load <= VEHICLE.suspensionMaxForce, `load ${wheel.load}`);
      assert.ok(tireForce <= maxGrip * wheel.load + 1e-6, `${tireForce} N on ${wheel.load} N`);
      assert.ok(wheel.suspensionLength >= 0);
      assert.ok(wheel.suspensionLength <= VEHICLE.suspensionRestLength);
      if (wheel.grounded) groundedSamples++;
      else assert.equal(tireForce, 0);
    }
  };

  s.run(SETTLE_STEPS, {}, check);
  s.run(120, { throttle: 1 }, check);
  s.run(60, { throttle: 1, steer: -1 }, check);
  s.run(60, { brake: 1, steer: 1 }, check);
  s.run(60, { throttle: 1, steer: 1, handbrake: true }, check);
  s.run(60, { steer: -1, handbrake: true }, check);

  assert.ok(groundedSamples > 1000, `grounded samples: ${groundedSamples}`);
  for (const value of motion(s.body)) assert.ok(Number.isFinite(value));
});

test('reset returns the car to its spawn at rest, and it settles again', (t) => {
  const s = scene(t);
  s.run(SETTLE_STEPS);
  s.run(150, { throttle: 1, steer: 1 });

  const moved = s.body.translation();
  assert.ok(
    Math.hypot(moved.x - VEHICLE.spawn.x, moved.z - VEHICLE.spawn.z) > 3,
    'drove away from the spawn',
  );
  assert.notEqual(s.vehicle.steerAngle, 0);

  s.vehicle.reset();

  // Rapier stores f32, so compare positions with a small tolerance.
  const p = s.body.translation();
  const q = s.body.rotation();
  assert.ok(Math.abs(p.x - VEHICLE.spawn.x) < 1e-6);
  assert.ok(Math.abs(p.y - VEHICLE.spawn.y) < 1e-6);
  assert.ok(Math.abs(p.z - VEHICLE.spawn.z) < 1e-6);
  assert.ok(Math.hypot(q.x, q.y, q.z) < 1e-6 && Math.abs(q.w - 1) < 1e-6, 'unrotated');
  assert.equal(s.vehicle.speed, 0);
  assert.equal(Math.abs(s.vehicle.forwardSpeed), 0);
  assert.equal(length(s.body.angvel()), 0);
  assert.equal(s.vehicle.steerAngle, 0);
  for (const wheel of s.vehicle.wheels) {
    assert.equal(wheel.grounded, false);
    assert.equal(wheel.suspensionLength, VEHICLE.suspensionRestLength);
    assert.equal(wheel.steerAngle, 0);
    assert.equal(wheel.spinAngle, 0);
    assert.equal(wheel.spinSpeed, 0);
    assert.equal(wheel.load, 0);
  }

  s.run(SETTLE_STEPS);
  assertSettled(s, 'after reset');
  const settled = s.body.translation();
  assert.ok(
    Math.hypot(settled.x - VEHICLE.spawn.x, settled.z - VEHICLE.spawn.z) < 0.01,
    `settles on the spawn: ${settled.x}, ${settled.z}`,
  );
});

test('zero rear lateral grip still allows longitudinal handbrake force', (t) => {
  const s = scene(t, { handbrakeRearGripScale: 0 });
  s.run(SETTLE_STEPS);
  s.body.setLinvel({ x: 3, y: 0, z: -10 }, true);
  s.vehicle.update({ ...NEUTRAL, handbrake: true }, FIXED_DT);
  for (const i of REAR) {
    const wheel = s.vehicle.wheels[i];
    assert.equal(wheel.grounded, true);
    assert.equal(Math.abs(wheel.lateralForce), 0);
    assert.ok(wheel.longitudinalForce < -1000, 'rear wheels must still brake');
  }
});

test('rendered car interpolates poses and reset snaps both ends of the blend', (t) => {
  const s = scene(t, { spawn: { x: 0, y: 0.8, z: 0 } });
  const car = new Car(s.vehicle, coupeModel.clone(true));
  car.savePreviousPose();
  s.body.setTranslation({ x: 10, y: 1, z: -20 }, true);
  s.body.setRotation({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }, true);
  car.readPhysicsPose();
  car.render(0.5);
  assert.ok(Math.abs(car.root.position.x - 5) < 1e-6);
  assert.ok(Math.abs(car.root.position.y - 0.9) < 1e-6);
  assert.ok(Math.abs(car.root.position.z + 10) < 1e-6);
  assert.ok(Math.abs(car.root.quaternion.y - Math.sin(Math.PI / 8)) < 1e-6);

  car.reset();
  for (const alpha of [0, 0.5, 0.999]) {
    car.render(alpha);
    assert.ok(Math.abs(car.root.position.x) < 1e-6);
    assert.ok(Math.abs(car.root.position.y - 0.8) < 1e-6);
    assert.ok(Math.abs(car.root.position.z) < 1e-6);
    assert.ok(Math.abs(car.root.quaternion.y) < 1e-6);
    assert.ok(Math.abs(car.root.quaternion.w - 1) < 1e-6);
  }
});
