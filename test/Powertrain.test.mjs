// Phase 1c drivetrain: real Powertrain behaviour plus one real-Rapier integration check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import RAPIER from '@dimforge/rapier3d-compat';

async function load(path) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

const { VEHICLE: T, FIXED_DT: DT, GRAVITY } = await load('src/config.ts');
const { Powertrain, RaycastVehicle } = await load('src/physics/RaycastVehicle.ts');
const EPS = 1e-6;
const G = T.gearRatios;
// Kinematics of a rolling wheel behind a fixed reduction: road speed at an engine speed.
const roadSpeed = (rpm, ratio) => (((rpm * 2 * Math.PI) / 60) * T.wheelRadius) / (ratio * T.finalDrive);
const fresh = (tuning = T) => new Powertrain(tuning);
const sane = e => Number.isFinite(e.rpm) && e.rpm >= T.engineIdleRpm && e.rpm <= T.engineRedlineRpm;

/** Full-throttle run of a drag-free point mass; one sample per step. */
function sprint(dt, seconds) {
  const p = fresh();
  const log = [];
  let v = 0;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const force = p.update(dt, v, 1, 1);
    log.push({ v, force, gear: p.gear, rpm: p.rpm, shifting: p.shifting });
    v += (force / T.mass) * dt;
  }
  return log;
}

test('launch: first gear, idle rpm, strong but bounded force that scales with throttle', () => {
  const p = fresh();
  const f = p.update(DT, 0, 1, 1);
  assert.equal(p.gear, 1);
  assert.equal(p.rpm, T.engineIdleRpm);
  assert.ok(f >= 0.5 * T.engineForce, 'responsive launch');
  assert.ok(f <= T.engineForce + EPS, 'engineForce stays the ceiling');
  assert.ok(f <= (T.enginePeakTorque * G[0] * T.finalDrive) / T.wheelRadius + EPS, 'no more than the gearing can deliver');
  assert.ok(Math.abs(fresh().update(DT, 0, 0.5, 1) - f / 2) < EPS);
  assert.equal(Math.abs(fresh().update(DT, 10, 0, 1)), 0, 'no throttle, no drive');
});

test('force never exceeds the ceiling, the gearing or the power limit, and fades with speed', () => {
  const at = {};
  for (let v = 2; v <= 48; v += 2) {
    const p = fresh();
    const f = (at[v] = p.update(DT, v, 1, 1));
    assert.ok(Number.isFinite(f) && f >= 0 && sane(p), `finite at ${v} m/s`);
    assert.ok(f <= T.engineForce + EPS);
    assert.ok(f * v <= T.enginePeakPower * (1 + 1e-9), `power limit at ${v} m/s`);
    assert.ok(f <= (T.enginePeakTorque * G[p.gear - 1] * T.finalDrive) / T.wheelRadius + EPS);
  }
  assert.ok(at[46] < at[6], 'progressive: far less push at high speed');
  assert.equal(Math.abs(fresh().update(DT, T.topSpeed, 1, 1)), 0, 'top speed cap kept');
});

test('rpm follows road speed through the gearing', () => {
  const a = fresh();
  const b = fresh();
  a.update(DT, 8, 1, 1);
  b.update(DT, 12, 1, 1);
  assert.equal(a.gear, 1);
  assert.equal(b.gear, 1);
  assert.ok(b.rpm > a.rpm);
  assert.ok(Math.abs(b.rpm / a.rpm - 1.5) < 1e-9, 'proportional to wheel speed within a gear');
  assert.ok(Math.abs(roadSpeed(b.rpm, G[0]) - 12) < EPS);
});

test('upshift: revs drop by the ratio step, torque is cut for shiftTime of elapsed time, then resumes', () => {
  const ends = [];
  for (const dt of [1 / 60, 1 / 120]) {
    const log = sprint(dt, 6);
    const i = log.findIndex(s => s.gear === 2);
    assert.ok(i > 0, 'reaches second gear');
    assert.ok(log.slice(0, i).every(s => s.gear === 1 && !s.shifting && s.force > 0), 'no cut before the shift');
    assert.ok(log[i].rpm < log[i - 1].rpm, 'revs drop');
    assert.ok(Math.abs(log[i].rpm / log[i - 1].rpm - G[1] / G[0]) < 0.03, 'drop matches the ratio step');
    let n = 0;
    while (log[i + n].shifting) {
      assert.equal(Math.abs(log[i + n].force), 0, 'no drive during the shift');
      n++;
    }
    assert.ok(n * dt >= T.shiftTime - 1e-9 && n * dt <= T.shiftTime + dt + 1e-9, `cut lasted ${n * dt}s`);
    assert.equal(log[i + n].gear, 2);
    assert.ok(log[i + n].force > 0, 'drive resumes');
    log.forEach((s, k) => {
      assert.ok(sane(s) && s.force <= T.engineForce + EPS);
      assert.ok(k === 0 || s.gear >= log[k - 1].gear, 'never shifts back down while accelerating');
    });
    ends.push(log.at(-1).v);
  }
  assert.ok(Math.abs(ends[0] - ends[1]) < 0.5, 'same run at 60 and 120 Hz');
});

test('hysteresis: wobbling around an upshift speed shifts once, coasting down steps through the gears once', () => {
  for (let g = 1; g < G.length; g++) {
    const vUp = roadSpeed(T.upshiftRpm, G[g - 1]);
    const p = fresh();
    let changes = 0;
    let last = g;
    for (let i = 0; i < 600; i++) {
      p.update(DT, vUp * (1 - 0.05 * Math.cos(i * DT * Math.PI)), 1, 1);
      if (i === 0) assert.equal(p.gear, g, 'picks the gear that suits the speed');
      if (p.gear !== last) changes++;
      last = p.gear;
    }
    assert.equal(changes, 1, `no hunting between gears ${g} and ${g + 1}`);
    assert.equal(p.gear, g + 1);
  }
  const p = fresh();
  let changes = 0;
  let last = 0;
  for (let v = 45; v > 1; v -= 3 * DT) {
    p.update(DT, v, 0, 1);
    if (last !== 0) {
      assert.ok(p.gear <= last, 'never upshifts while slowing');
      if (p.gear !== last) changes++;
    }
    last = p.gear;
    assert.ok(sane(p));
  }
  assert.equal(p.gear, 1);
  assert.ok(changes <= G.length - 1);
});

test('limiter and neutral: no torque at redline, finite state, free revving depends on elapsed time only', () => {
  const p = fresh({ ...T, gearRatios: [G[0]] });
  const vRed = roadSpeed(T.engineRedlineRpm, G[0]);
  assert.ok(p.update(DT, vRed * 0.5, 1, 1) > 0);
  assert.equal(p.limiting, false);
  assert.equal(Math.abs(p.update(DT, vRed * 1.1, 1, 1)), 0);
  assert.equal(p.limiting, true);
  assert.equal(p.rpm, T.engineRedlineRpm);
  for (const f of [p.update(DT, 1e6, 1, 1), p.update(0, -1e6, 1, -1), p.update(0, 0, 1, 0)]) {
    assert.ok(Number.isFinite(f) && sane(p));
  }
  const n = fresh();
  let prev = n.rpm;
  for (let i = 0; i < 180; i++) {
    assert.equal(Math.abs(n.update(DT, 0, 1, 0)), 0, 'neutral never drives');
    assert.equal(n.gear, 0);
    assert.ok(n.rpm >= prev);
    prev = n.rpm;
  }
  assert.equal(n.rpm, T.engineRedlineRpm);
  assert.equal(n.limiting, true);
  for (let i = 0; i < 180; i++) n.update(DT, 0, 0, 0);
  assert.ok(n.rpm < T.engineIdleRpm + 50 && n.rpm >= T.engineIdleRpm);
  assert.equal(n.limiting, false);
  const a = fresh();
  const b = fresh();
  for (let i = 0; i < 30; i++) a.update(1 / 60, 0, 0.5, 0);
  for (let i = 0; i < 60; i++) b.update(1 / 120, 0, 0.5, 0);
  assert.ok(a.rpm > T.engineIdleRpm + 500 && Math.abs(a.rpm - b.rpm) < 1e-6);
});

test('reverse: own gear, bounded force, capped speed, clean change back to first', () => {
  const p = fresh();
  const f = p.update(DT, 0, 1, -1);
  assert.equal(p.gear, -1);
  assert.equal(p.rpm, T.engineIdleRpm);
  assert.ok(f < 0 && f >= -T.reverseForce - EPS);
  assert.ok(p.update(DT, -5, 1, -1) < 0);
  assert.ok(p.rpm > T.engineIdleRpm);
  assert.equal(Math.abs(p.update(DT, -T.reverseTopSpeed, 1, -1)), 0);
  assert.ok(p.update(DT, -0.2, 1, 1) > 0);
  assert.equal(p.gear, 1);
  assert.equal(p.shifting, false);
});

test('reset clears gear, revs and a shift in progress', () => {
  const p = fresh();
  let v = 0;
  for (let i = 0; i < 600 && !p.shifting; i++) v += (p.update(DT, v, 1, 1) / T.mass) * DT;
  assert.equal(p.shifting, true);
  p.reset();
  assert.deepEqual([p.gear, p.rpm, p.shifting, p.limiting], [0, T.engineIdleRpm, false, false]);
  assert.equal(p.update(DT, 0, 1, 1), fresh().update(DT, 0, 1, 1));
});

test('real Rapier car: gears drive the chassis, telemetry stays sane, handbrake and reset declutch', async t => {
  await RAPIER.init();
  const world = new RAPIER.World(GRAVITY);
  t.after(() => world.free());
  world.timestep = DT;
  world.createCollider(RAPIER.ColliderDesc.cuboid(200, 0.5, 600).setTranslation(0, -0.5, 0));
  const car = new RaycastVehicle(RAPIER, world, T);
  const input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  const step = () => {
    car.update(input, DT);
    world.step();
  };
  for (let i = 0; i < 90; i++) step();
  assert.equal(car.engine.gear, 0, 'neutral at rest');
  assert.equal(car.engine.rpm, T.engineIdleRpm);

  input.throttle = 1;
  let maxGear = 0;
  let cutSteps = 0;
  let biggestDrop = 0;
  let prevRpm = car.engine.rpm;
  for (let i = 0; i < 480; i++) {
    step();
    const e = car.engine;
    assert.ok(sane(e), 'finite rpm within idle..redline');
    assert.ok(car.forwardSpeed <= (T.engineForce / T.mass) * (i + 1) * DT + 0.5, 'never beats the force ceiling');
    maxGear = Math.max(maxGear, e.gear);
    if (e.shifting) cutSteps++;
    biggestDrop = Math.max(biggestDrop, prevRpm - e.rpm);
    prevRpm = e.rpm;
  }
  assert.ok(car.forwardSpeed > 20, `gear force really drives the car (${car.forwardSpeed} m/s)`);
  assert.ok(maxGear >= 2 && cutSteps > 0 && biggestDrop > 1000, 'shifted up with a rev drop');

  input.handbrake = true;
  step();
  assert.equal(car.engine.gear, 0, 'handbrake declutches');
  assert.ok(car.wheels[2].longitudinalForce <= 0 && car.wheels[3].longitudinalForce <= 0, 'no drive under handbrake');

  car.reset();
  assert.deepEqual([car.engine.gear, car.engine.rpm, car.engine.shifting], [0, T.engineIdleRpm, false]);
});
