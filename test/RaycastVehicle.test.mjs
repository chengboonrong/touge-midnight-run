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

// --- Phase 1a: longitudinal force while sliding (D1), slip telemetry (D3) ----

const SLIDE_FORWARD = 15; // m/s along -Z (the unrotated car's forward)
const SLIDE_SIDE = 6; // m/s along +X (the unrotated car's right)
const STRAIGHT = { x: 0, y: 0, z: -SLIDE_FORWARD };
const SLIDING = { x: SLIDE_SIDE, y: 0, z: -SLIDE_FORWARD };

/** Settles a car, gives it a velocity and solves one update() (no world step). */
function solveAt(t, velocity, input = {}, tuningOverrides = {}) {
  const s = scene(t, tuningOverrides);
  s.run(SETTLE_STEPS);
  s.body.setLinvel(velocity, true);
  s.vehicle.update({ ...NEUTRAL, ...input }, FIXED_DT);
  return s;
}

/** Each axis within its own grip, and the pair inside the friction ellipse. */
function assertWithinEllipse(s, rearLateralScale = 1) {
  s.vehicle.wheels.forEach((wheel, i) => {
    assert.equal(wheel.grounded, true);
    const maxLongitudinal = VEHICLE.gripLongitudinal * wheel.load;
    const maxLateral =
      (FRONT.includes(i) ? VEHICLE.gripLateralFront : VEHICLE.gripLateralRear * rearLateralScale) *
      wheel.load;
    assert.ok(maxLongitudinal > 0, `wheel ${i} is loaded`);
    if (maxLateral === 0) assert.equal(Math.abs(wheel.lateralForce), 0);
    const usage = Math.hypot(
      wheel.longitudinalForce / maxLongitudinal,
      maxLateral > 0 ? wheel.lateralForce / maxLateral : 0,
    );
    assert.ok(usage <= 1 + 1e-9, `wheel ${i} grip usage ${usage}`);
  });
}

const forces = (s, key) => s.vehicle.wheels.map((wheel) => wheel[key].toFixed(1)).join(', ');

test('the foot brake keeps useful longitudinal force while sliding sideways', (t) => {
  // Reference: the same brake request with no side slip, i.e. what the brakes
  // and longitudinal grip allow on their own.
  const straight = solveAt(t, STRAIGHT, { brake: 1 });
  const sliding = solveAt(t, SLIDING, { brake: 1 });
  t.diagnostic(`brake longitudinal N, straight: ${forces(straight, 'longitudinalForce')}`);
  t.diagnostic(`brake longitudinal N, sliding:  ${forces(sliding, 'longitudinalForce')}`);

  for (let i = 0; i < 4; i++) {
    const reference = straight.vehicle.wheels[i].longitudinalForce;
    const actual = sliding.vehicle.wheels[i].longitudinalForce;
    assert.ok(reference < -1000, `wheel ${i} brakes in a straight line: ${reference}`);
    assert.ok(actual <= 0.5 * reference, `wheel ${i} brakes ${actual} N vs ${reference} N straight`);
  }
  assertWithinEllipse(straight);
  assertWithinEllipse(sliding);
});

test('rear-wheel throttle keeps useful drive force while sliding sideways', (t) => {
  const straight = solveAt(t, STRAIGHT, { throttle: 1 });
  const sliding = solveAt(t, SLIDING, { throttle: 1 });
  t.diagnostic(`drive longitudinal N, straight: ${forces(straight, 'longitudinalForce')}`);
  t.diagnostic(`drive longitudinal N, sliding:  ${forces(sliding, 'longitudinalForce')}`);

  for (const i of REAR) {
    const reference = straight.vehicle.wheels[i].longitudinalForce;
    const actual = sliding.vehicle.wheels[i].longitudinalForce;
    assert.ok(reference > 1000, `wheel ${i} drives in a straight line: ${reference}`);
    assert.ok(actual >= 0.5 * reference, `wheel ${i} drives ${actual} N vs ${reference} N straight`);
  }
  assertWithinEllipse(sliding);

  // Holding the handbrake still cuts the drive: locked rear wheels only brake.
  const held = solveAt(t, SLIDING, { throttle: 1, handbrake: true });
  for (const i of REAR) {
    assert.ok(held.vehicle.wheels[i].longitudinalForce < 0, 'no drive with the handbrake held');
  }
  assertWithinEllipse(held, VEHICLE.handbrakeRearGripScale);
});

test('combined tire force stays on the friction ellipse with zero rear lateral grip', (t) => {
  const s = solveAt(t, SLIDING, { brake: 1, handbrake: true }, { handbrakeRearGripScale: 0 });
  assertWithinEllipse(s, 0);
  for (const i of REAR) {
    assert.ok(s.vehicle.wheels[i].longitudinalForce < -1000, 'rear wheels still brake');
  }
});

test('slipSpeed is the signed contact side speed in the wheel frame', (t) => {
  const near = (actual, expected, label) =>
    assert.ok(Math.abs(actual - expected) < 0.05, `${label}: ${actual} vs ${expected}`);

  // Sliding towards the car's right is positive, towards its left negative.
  for (const side of [SLIDE_SIDE, -SLIDE_SIDE]) {
    const s = solveAt(t, { x: side, y: 0, z: -SLIDE_FORWARD });
    s.vehicle.wheels.forEach((wheel, i) => near(wheel.slipSpeed, side, `wheel ${i}`));
  }

  // Rolling straight ahead is no side slip.
  const straight = solveAt(t, STRAIGHT);
  straight.vehicle.wheels.forEach((wheel, i) => near(wheel.slipSpeed, 0, `straight wheel ${i}`));

  // Pure yaw to the left (about +Y): the nose sweeps left, the tail right.
  // Rigid-body kinematics give a side speed of yawRate * axleZ at each axle.
  const yawRate = 1;
  const spinning = scene(t);
  spinning.run(SETTLE_STEPS);
  spinning.body.setAngvel({ x: 0, y: yawRate, z: 0 }, true);
  spinning.vehicle.update(NEUTRAL, FIXED_DT);
  for (const i of FRONT) {
    near(spinning.vehicle.wheels[i].slipSpeed, yawRate * VEHICLE.frontAxleZ, `front wheel ${i}`);
  }
  for (const i of REAR) {
    near(spinning.vehicle.wheels[i].slipSpeed, yawRate * VEHICLE.rearAxleZ, `rear wheel ${i}`);
  }
});

test('slipSpeed stays finite in a handbrake slide and is zero airborne and after reset', (t) => {
  // The same slide as the handbrake test above, sampled every step.
  const slide = (handbrake) => {
    const s = scene(t);
    s.run(SETTLE_STEPS);
    s.body.setLinvel({ x: SLIDE_SIDE, y: 0, z: 0 }, true);
    s.run(15, { handbrake }, () => {
      for (const wheel of s.vehicle.wheels) assert.ok(Number.isFinite(wheel.slipSpeed));
    });
    return s;
  };
  const gripped = slide(false);
  const loose = slide(true);
  for (const [label, s] of [['no handbrake', gripped], ['handbrake', loose]]) {
    t.diagnostic(
      `slide after 15 steps, ${label}: yaw ${s.body.angvel().y.toFixed(4)} rad/s, ` +
        `side speed ${s.body.linvel().x.toFixed(4)} m/s, slipSpeed ${forces(s, 'slipSpeed')}`,
    );
  }
  for (const i of REAR) {
    assert.ok(loose.vehicle.wheels[i].slipSpeed > 1, 'the rear is still sliding to the right');
  }

  loose.vehicle.reset();
  for (const wheel of loose.vehicle.wheels) assert.equal(wheel.slipSpeed, 0);

  // Moving sideways in the air is not tire slip.
  const airborne = scene(t, { spawn: { x: 0, y: 2.5, z: 0 } });
  airborne.body.setLinvel({ x: SLIDE_SIDE, y: 0, z: 0 }, true);
  airborne.run(30, {}, () => {
    for (const wheel of airborne.vehicle.wheels) {
      assert.equal(wheel.grounded, false);
      assert.equal(wheel.slipSpeed, 0);
    }
  });
});

// --- Phase 1b: slip-angle tire curve and handbrake grip recovery -------------

// Explicit curve tuning, so these tests do not depend on the default values
// (which are tuning hypotheses). Angles in rad, speed in m/s, time in s.
const TIRE = {
  tirePeakSlipAngleFront: 0.14,
  tirePeakSlipAngleRear: 0.08,
  tireSlidingGrip: 0.7,
  slipAngleMinSpeed: 1,
  handbrakeGripRecoveryTime: 0.4,
};
const AXLES = [
  { name: 'front', wheel: 0, peak: TIRE.tirePeakSlipAngleFront, grip: VEHICLE.gripLateralFront },
  { name: 'rear', wheel: 2, peak: TIRE.tirePeakSlipAngleRear, grip: VEHICLE.gripLateralRear },
];

/**
 * Settles a car with the TIRE tuning, then solves one update() (no world
 * step) at a forward speed and a slip angle (rad, positive = sliding right).
 */
function solveSlip(t, speed, angle, input = {}, dt = FIXED_DT) {
  const s = scene(t, TIRE);
  s.run(SETTLE_STEPS);
  s.body.setLinvel({ x: speed * Math.tan(angle), y: 0, z: -speed }, true);
  s.vehicle.update({ ...NEUTRAL, ...input }, dt);
  return s;
}

/** Lateral force opposing a rightward slip, as a fraction of peak lateral grip. */
function gripUse(s, axle) {
  const wheel = s.vehicle.wheels[axle.wheel];
  return -wheel.lateralForce / (axle.grip * wheel.load);
}

test('lateral force builds progressively to a peak slip angle, then eases to sliding grip', (t) => {
  const speed = 20;
  for (const axle of AXLES) {
    const use = (fraction) => gripUse(solveSlip(t, speed, fraction * axle.peak), axle);
    const below = [0.25, 0.5, 0.75].map(use);
    const peak = use(1);
    const beyond = [2, 4].map(use);
    const sideways = gripUse(solveSlip(t, speed, 1.2), axle);
    t.diagnostic(
      `${axle.name} grip use at 0.25/0.5/0.75/1/2/4 x peak and 1.2 rad: ` +
        [...below, peak, ...beyond, sideways].map((value) => value.toFixed(3)).join(', '),
    );

    // Progressive: a quarter of the peak angle is well short of full grip.
    assert.ok(below[0] > 0.2 && below[0] < 0.7, `${axle.name} at a quarter of the peak: ${below[0]}`);
    assert.ok(below[0] < below[1] && below[1] < below[2] && below[2] < peak, `${axle.name} rises`);
    assert.ok(peak > 0.95 && peak <= 1 + 1e-9, `${axle.name} peak: ${peak}`);
    // Past the peak the force falls, but never below the sliding fraction.
    assert.ok(beyond[0] < peak && beyond[1] < beyond[0] && sideways < beyond[1], `${axle.name} falls`);
    assert.ok(sideways < peak - 0.1, `${axle.name} sliding ${sideways} vs peak ${peak}`);
    assert.ok(sideways >= TIRE.tireSlidingGrip - 1e-6, `${axle.name} keeps sliding grip: ${sideways}`);

    // Mirrored slip gives the mirrored force.
    const right = solveSlip(t, speed, 0.5 * axle.peak).vehicle.wheels[axle.wheel].lateralForce;
    const left = solveSlip(t, speed, -0.5 * axle.peak).vehicle.wheels[axle.wheel].lateralForce;
    assert.ok(right < 0 && left > 0, `${axle.name} opposes slip: ${right}, ${left}`);
    assert.ok(Math.abs(left + right) < 0.02 * left, `${axle.name} symmetric: ${right}, ${left}`);
  }

  // The front and rear peak angles are separate: at the rear's peak angle the
  // front (larger peak angle) is still building.
  const s = solveSlip(t, speed, TIRE.tirePeakSlipAngleRear);
  assert.ok(gripUse(s, AXLES[0]) < gripUse(s, AXLES[1]) - 0.05, 'front peaks later than rear');
});

test('the same slip angle gives the same grip use at any driving speed', (t) => {
  const angle = 0.07; // half the front peak angle
  const atSpeed = [12, 24, 40].map((speed) => solveSlip(t, speed, angle));
  for (const axle of AXLES) {
    const uses = atSpeed.map((s) => gripUse(s, axle));
    t.diagnostic(`${axle.name} grip use at 12/24/40 m/s: ${uses.map((u) => u.toFixed(4)).join(', ')}`);
    for (const use of uses) {
      assert.ok(Math.abs(use - uses[0]) < 0.02, `${axle.name}: ${use} vs ${uses[0]}`);
    }
  }
  const frontUse = gripUse(atSpeed[0], AXLES[0]);
  assert.ok(frontUse > 0.5 && frontUse < 0.95, `front is below its peak: ${frontUse}`);

  // The same 1 m/s of side slip is a smaller angle at speed, so less force.
  const slow = gripUse(solveSlip(t, 12, Math.atan2(1, 12)), AXLES[0]);
  const fast = gripUse(solveSlip(t, 40, Math.atan2(1, 40)), AXLES[0]);
  assert.ok(slow > 1.5 * fast, `1 m/s of slip: ${slow} at 12 m/s vs ${fast} at 40 m/s`);
});

test('the slip-angle response does not depend on the step size at driving speed', (t) => {
  for (const angle of [0.01, 0.3]) {
    const [reference, ...others] = [1 / 60, 1 / 120, 1 / 240].map((dt) =>
      solveSlip(t, 20, angle, {}, dt),
    );
    for (const axle of AXLES) {
      const expected = reference.vehicle.wheels[axle.wheel].lateralForce;
      assert.ok(expected < -100, `${axle.name} produces force at ${angle} rad: ${expected}`);
      for (const other of others) {
        const actual = other.vehicle.wheels[axle.wheel].lateralForce;
        assert.ok(
          Math.abs(actual - expected) < 1e-6 * Math.abs(expected),
          `${axle.name} at ${angle} rad: ${actual} vs ${expected}`,
        );
      }
    }
  }
});

test('lateral tire force only ever opposes slip, down to a standstill', (t) => {
  // Never pushes along the slip, and never more than would stop the slip of a
  // quarter of the car within one step.
  const quarterMass = VEHICLE.mass / 4;
  const assertDissipative = (s) => {
    for (const wheel of s.vehicle.wheels) {
      assert.ok(wheel.lateralForce * wheel.slipSpeed <= 0, 'opposes slip');
      assert.ok(
        Math.abs(wheel.lateralForce) * FIXED_DT <= Math.abs(wheel.slipSpeed) * quarterMass + 1e-9,
        `${wheel.lateralForce} N on ${wheel.slipSpeed} m/s of slip`,
      );
    }
  };
  for (const speed of [0, 0.3, 8, 30]) {
    for (const side of [0.01, 0.2, 8, -8]) {
      const s = scene(t, TIRE);
      s.run(SETTLE_STEPS);
      s.body.setLinvel({ x: side, y: 0, z: -speed }, true);
      s.vehicle.update(NEUTRAL, FIXED_DT);
      assertDissipative(s);
    }
  }

  // A sideways nudge at a standstill dies out and the car rests without jitter.
  const s = scene(t, TIRE);
  s.run(SETTLE_STEPS);
  s.body.setLinvel({ x: 0.3, y: 0, z: 0 }, true);
  s.run(240, {}, () => {
    assertDissipative(s);
    for (const wheel of s.vehicle.wheels) assert.ok(Number.isFinite(wheel.slipAngle));
  });
  assertSettled(s, 'after a sideways nudge');
  const rest = s.body.translation();
  s.run(120, {}, () => {
    for (const wheel of s.vehicle.wheels) {
      assert.ok(Math.abs(wheel.slipAngle) < 0.02, `resting slip angle ${wheel.slipAngle}`);
    }
  });
  const end = s.body.translation();
  assert.ok(Math.hypot(end.x - rest.x, end.y - rest.y, end.z - rest.z) < 1e-3, 'no creep at rest');
  assertSettled(s, 'two seconds later');
});

test('slipAngle is the signed contact slip angle, with low-speed and reverse conventions', (t) => {
  const near = (actual, expected, label) =>
    assert.ok(Math.abs(actual - expected) < 0.005, `${label}: ${actual} vs ${expected}`);
  const solveVelocity = (velocity, angvel) => {
    const s = scene(t, TIRE);
    s.run(SETTLE_STEPS);
    s.body.setLinvel(velocity, true);
    if (angvel) s.body.setAngvel(angvel, true);
    s.vehicle.update(NEUTRAL, FIXED_DT);
    return s;
  };

  // Driving forwards: positive = sliding to the wheel's right, like slipSpeed.
  for (const angle of [0.3, -0.3]) {
    const s = solveSlip(t, 15, angle);
    s.vehicle.wheels.forEach((wheel, i) => {
      near(wheel.slipAngle, angle, `wheel ${i}`);
      assert.ok(wheel.slipAngle * wheel.slipSpeed > 0, `wheel ${i} sign matches slipSpeed`);
    });
  }
  solveSlip(t, 15, 0).vehicle.wheels.forEach((wheel, i) => near(wheel.slipAngle, 0, `straight ${i}`));

  // Reversing: measured against the rolling speed's magnitude, so the sign
  // still follows slipSpeed (sliding right is positive).
  const reversing = solveVelocity({ x: 2, y: 0, z: 10 });
  reversing.vehicle.wheels.forEach((wheel, i) => near(wheel.slipAngle, Math.atan2(2, 10), `reverse ${i}`));

  // Below slipAngleMinSpeed the angle is measured against that speed, so it
  // fades to zero at a standstill instead of jumping to 90 degrees.
  const creeping = solveVelocity({ x: 0.05, y: 0, z: 0 });
  creeping.vehicle.wheels.forEach((wheel, i) =>
    near(wheel.slipAngle, Math.atan2(0.05, TIRE.slipAngleMinSpeed), `creeping ${i}`),
  );
  const sideways = solveVelocity({ x: SLIDE_SIDE, y: 0, z: 0 });
  sideways.vehicle.wheels.forEach((wheel, i) => {
    assert.ok(wheel.slipAngle > 1.3 && wheel.slipAngle <= Math.PI / 2, `sideways ${i}: ${wheel.slipAngle}`);
  });

  // Pure yaw to the left: the nose sweeps left (negative), the tail right.
  const spinning = solveVelocity({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  for (const i of FRONT) assert.ok(spinning.vehicle.wheels[i].slipAngle < -0.5, `front wheel ${i}`);
  for (const i of REAR) assert.ok(spinning.vehicle.wheels[i].slipAngle > 0.5, `rear wheel ${i}`);
});

/** Total rear lateral force (N) of one update() in a fixed slide at the rear peak angle. */
function rearLateralAt(s, input = {}) {
  s.body.setLinvel({ x: 20 * Math.tan(TIRE.tirePeakSlipAngleRear), y: 0, z: -20 }, true);
  s.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  s.vehicle.update({ ...NEUTRAL, ...input }, FIXED_DT);
  return REAR.reduce((sum, i) => sum + Math.abs(s.vehicle.wheels[i].lateralForce), 0);
}

test('rear lateral grip returns gradually after the handbrake is released', (t) => {
  // Parked cars: hold the handbrake, wait, then solve the same slide for all.
  const parked = (heldSteps, releasedSteps) => {
    const s = scene(t, TIRE);
    s.run(SETTLE_STEPS);
    s.run(heldSteps, { handbrake: true });
    s.run(releasedSteps);
    return s;
  };
  const freshCar = parked(0, 0);
  const fresh = rearLateralAt(freshCar);
  const held = rearLateralAt(parked(5, 0), { handbrake: true }) / fresh;
  const waits = [0, 5, 15, 40, 120];
  const cars = waits.map((steps) => parked(5, steps));
  const released = cars.map((s) => rearLateralAt(s) / fresh);
  t.diagnostic(
    `rear lateral grip vs fresh: held ${held.toFixed(3)}, released after ` +
      waits.map((steps, i) => `${steps} steps ${released[i].toFixed(3)}`).join(', '),
  );

  assert.ok(fresh > 1000, `fresh rear lateral force ${fresh}`);
  assert.ok(held < 0.4, `held: ${held}`);
  assert.ok(released[0] < 0.5, `no snap back on release: ${released[0]}`);
  for (let i = 1; i < released.length; i++) {
    assert.ok(released[i] > released[i - 1], `monotone recovery: ${released}`);
  }
  assert.ok(released[2] > released[0] + 0.1 && released[2] < 0.9, `0.25 s in: ${released[2]}`);
  assert.ok(released[4] > 0.97 && released[4] <= 1 + 1e-6, `recovered after 2 s: ${released[4]}`);

  // Only the rear's lateral grip recovers: the front is unaffected and the
  // rear lock is off at once.
  const justReleased = cars[0].vehicle.wheels;
  for (const i of FRONT) {
    const expected = freshCar.vehicle.wheels[i].lateralForce;
    assert.ok(Math.abs(justReleased[i].lateralForce - expected) < 0.01 * Math.abs(expected), 'front grip');
  }
  for (const i of REAR) {
    assert.ok(justReleased[i].longitudinalForce > -300, `no rear lock: ${justReleased[i].longitudinalForce}`);
  }

  // Throttle is not suppressed while the grip recovers.
  const freshDriving = parked(0, 0);
  const releasedDriving = parked(5, 0);
  rearLateralAt(freshDriving, { throttle: 1 });
  rearLateralAt(releasedDriving, { throttle: 1 });
  for (const i of REAR) {
    const expected = freshDriving.vehicle.wheels[i].longitudinalForce;
    const actual = releasedDriving.vehicle.wheels[i].longitudinalForce;
    assert.ok(expected > 1000, `fresh drive force ${expected}`);
    assert.ok(actual >= 0.99 * expected, `drive force ${actual} vs ${expected} fresh`);
  }
});

test('handbrake grip recovery depends on elapsed time, not on the step size', (t) => {
  // update() without a world step only advances the vehicle's own state; the
  // chassis does not move, and rearLateralAt() sets its velocities again.
  const after = (steps, dt) => {
    const s = scene(t, TIRE);
    s.run(SETTLE_STEPS);
    if (steps > 0) s.vehicle.update({ ...NEUTRAL, handbrake: true }, dt);
    for (let i = 0; i < steps; i++) s.vehicle.update(NEUTRAL, dt);
    return rearLateralAt(s);
  };
  const fresh = after(0, FIXED_DT);
  const reference = after(30, 1 / 60); // 0.5 s in each case
  const recovered = reference / fresh;
  assert.ok(recovered > 0.5 && recovered < 0.95, `partly recovered after 0.5 s: ${recovered}`);
  for (const [steps, dt] of [[60, 1 / 120], [15, 1 / 30]]) {
    const actual = after(steps, dt);
    assert.ok(
      Math.abs(actual - reference) < 0.005 * reference,
      `${steps} steps of ${dt} s: ${actual} vs ${reference}`,
    );
  }
});

test('reset and leaving the ground clear slip telemetry and handbrake grip recovery', (t) => {
  const prepared = (handbrake, reset) => {
    const s = scene(t, TIRE);
    s.run(SETTLE_STEPS);
    const settled = s.body.translation();
    s.body.setLinvel(SLIDING, true);
    s.vehicle.update({ ...NEUTRAL, handbrake }, FIXED_DT);
    for (const wheel of s.vehicle.wheels) assert.ok(wheel.slipAngle > 0.1, 'sliding before reset');
    if (reset) {
      s.vehicle.reset();
      for (const wheel of s.vehicle.wheels) {
        assert.equal(wheel.slipAngle, 0);
        assert.equal(wheel.slipSpeed, 0);
        assert.equal(wheel.lateralForce, 0);
      }
      // Straight back onto its springs, so no recovery time passes.
      s.body.setTranslation(settled, true);
    }
    return rearLateralAt(s);
  };
  const fresh = prepared(false, true);
  const cleared = prepared(true, true);
  const recovering = prepared(true, false);
  assert.ok(Math.abs(cleared - fresh) < 1e-3 * fresh, `reset clears recovery: ${cleared} vs ${fresh}`);
  assert.ok(recovering < 0.6 * fresh, `without reset it is still recovering: ${recovering} vs ${fresh}`);

  // Moving sideways in the air is not a slip angle.
  const airborne = scene(t, { ...TIRE, spawn: { x: 0, y: 2.5, z: 0 } });
  airborne.body.setLinvel({ x: SLIDE_SIDE, y: 0, z: -SLIDE_FORWARD }, true);
  airborne.run(30, { handbrake: true }, () => {
    for (const wheel of airborne.vehicle.wheels) {
      assert.equal(wheel.grounded, false);
      assert.equal(wheel.slipAngle, 0);
    }
  });
});

test('a handbrake slide stays upright and settles after release and countersteer', (t) => {
  // Default tuning. A scripted driver, so this checks that a slide can be
  // entered and caught; it says nothing about how that feels.
  const s = scene(t);
  s.run(SETTLE_STEPS);
  s.run(240, { throttle: 1 });
  const entrySpeed = s.vehicle.forwardSpeed;

  // Chassis sideslip in rad: positive = moving to the right of the nose.
  const sideslip = () => {
    const f = forwardOf(s.body);
    const u = upOf(s.body);
    const v = s.body.linvel();
    const right = {
      x: f.y * u.z - f.z * u.y,
      y: f.z * u.x - f.x * u.z,
      z: f.x * u.y - f.y * u.x,
    };
    return Math.atan2(
      v.x * right.x + v.y * right.y + v.z * right.z,
      v.x * f.x + v.y * f.y + v.z * f.z,
    );
  };

  let peakSideslip = 0;
  let peakRearSlipAngle = 0;
  let minUp = 1;
  const watch = () => {
    peakSideslip = Math.max(peakSideslip, sideslip());
    for (const i of REAR) {
      peakRearSlipAngle = Math.max(peakRearSlipAngle, s.vehicle.wheels[i].slipAngle);
    }
    minUp = Math.min(minUp, upOf(s.body).y);
    for (const value of motion(s.body)) assert.ok(Number.isFinite(value));
  };

  // Entry: turn in left and hold the handbrake; the tail steps out to the right.
  s.run(45, { steer: -1, handbrake: true }, watch);
  const releaseSideslip = sideslip();
  const releaseYaw = s.body.angvel().y;

  // Recovery: release, steer into the slide in proportion to the sideslip and
  // the yaw rate, and feed in a little throttle.
  for (let i = 0; i < 240; i++) {
    const steer = Math.min(1, Math.max(-1, 2.5 * sideslip() + 0.5 * s.body.angvel().y));
    s.run(1, { steer, throttle: 0.3 }, watch);
  }
  const endSideslip = sideslip();
  const endYaw = s.body.angvel().y;
  t.diagnostic(
    `entry ${entrySpeed.toFixed(2)} m/s; at release sideslip ${releaseSideslip.toFixed(3)} rad, ` +
      `yaw ${releaseYaw.toFixed(3)} rad/s; peak sideslip ${peakSideslip.toFixed(3)} rad, ` +
      `peak rear slip angle ${peakRearSlipAngle.toFixed(3)} rad; after 4 s sideslip ` +
      `${endSideslip.toFixed(3)} rad, yaw ${endYaw.toFixed(3)} rad/s, ` +
      `speed ${s.vehicle.forwardSpeed.toFixed(2)} m/s, min up.y ${minUp.toFixed(4)}`,
  );

  assert.ok(entrySpeed > 10, `entry speed ${entrySpeed}`);
  assert.ok(peakSideslip > 0.1, `the car really slides: ${peakSideslip}`);
  assert.ok(peakSideslip < 1.0, `controlled drift stays below 57 degrees: ${peakSideslip}`);
  assert.ok(
    peakRearSlipAngle > VEHICLE.tirePeakSlipAngleRear,
    `rear tires pass their peak angle: ${peakRearSlipAngle}`,
  );
  assert.ok(minUp > 0.9, `stays upright: ${minUp}`);
  assert.ok(Math.abs(endSideslip) < 0.05, `sideslip recovered: ${endSideslip}`);
  assert.ok(Math.abs(endYaw) < 0.2, `yaw settled: ${endYaw}`);
  assert.ok(s.vehicle.forwardSpeed > entrySpeed * 0.5, `retains useful exit speed: ${s.vehicle.forwardSpeed}`);
});
