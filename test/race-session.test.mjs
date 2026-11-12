// Phase 5a: pure race logic. Loads the real src/race/RaceSession.ts (transpiled in memory)
// and the real route JSON found in the repository. These feed sampled route positions
// through update(); they do not mutate race state or simulate the vehicle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function load(relative) {
  const source = readFileSync(join(root, relative), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
}

function readRoute() {
  return JSON.parse(readFileSync(join(root, 'public/assets/touge/route.json'), 'utf8'));
}

const { RaceSession, readBestLap, RACE_MUSIC } = await load('src/race/RaceSession.ts');
const { VEHICLE } = await load('src/config.ts');

/** Closed planar polyline sampler, independent of the production code. */
function makePath(points) {
  const n = points.length, len = [], cum = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    cum.push(total);
    len.push(Math.hypot(b.x - a.x, b.z - a.z));
    total += len[i];
  }
  return {
    length: total,
    at(station, lift = 0.5) {
      const s = ((station % total) + total) % total;
      let i = 0;
      while (i < n - 1 && cum[i] + len[i] <= s) i++;
      const a = points[i], b = points[(i + 1) % n], f = len[i] > 0 ? (s - cum[i]) / len[i] : 0;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f + lift, z: a.z + (b.z - a.z) * f };
    },
  };
}

const SQUARE = [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 100, y: 0, z: 100 }, { x: 0, y: 0, z: 100 }];
const square = makePath(SQUARE);
const S0 = 10; // start station on the square; gates at 110, 210, 310 and 410 (= 10)
const DT = 1 / 60;
const newSquare = best => new RaceSession(SQUARE, 10, square.at(S0), best);

/** Starts a run and holds the car still until GO. Returns the number of updates. */
function launch(session, position, dt = DT) {
  session.start(position);
  let steps = 0;
  while (session.state === 'countdown' && steps < 100000) { session.update(dt, position); steps++; }
  assert.equal(session.state, 'racing');
  return steps;
}

function drive(session, path, from, to, speed = 20, dt = DT) {
  const steps = Math.max(1, Math.round(Math.abs(to - from) / (speed * dt)));
  for (let k = 1; k <= steps; k++) session.update(dt, path.at(from + (to - from) * k / steps));
}

function line(session, a, b, speed = 20, dt = DT) {
  const steps = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / (speed * dt)));
  for (let k = 1; k <= steps; k++) {
    const f = k / steps;
    session.update(dt, { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f });
  }
}

/** Drives forward at constant speed from station s0 until the run ends or time runs out. */
function lap(session, path, s0, speed, dt, maxSeconds) {
  for (let k = 1; session.state === 'racing' && k * dt < maxSeconds; k++) session.update(dt, path.at(s0 + speed * k * dt));
}

const types = events => events.map(e => (e.type === 'countdown' ? 'countdown' + e.value : e.type));

test('starts in practice and maps states to music', () => {
  const s = newSquare();
  assert.equal(s.state, 'practice');
  assert.equal(s.best, null);
  s.update(DT, square.at(S0));
  assert.equal(s.state, 'practice');
  assert.equal(s.elapsed, 0);
  assert.deepEqual({ ...RACE_MUSIC }, { practice: 'race', countdown: 'prepare', racing: 'race', finished: 'results' });
  assert.throws(() => new RaceSession([], 10, square.at(S0)));
});

test('countdown emits exactly 3, 2, 1, GO from simulation time', () => {
  const s = newSquare(), p = square.at(S0);
  s.start(p);
  assert.equal(s.state, 'countdown');
  assert.equal(s.countdown, 3);
  assert.deepEqual(types(s.drainEvents()), ['countdown3']);
  for (let i = 0; i < 3; i++) s.update(0.25, p);
  assert.deepEqual(types(s.drainEvents()), []);
  s.update(0.25, p);
  assert.deepEqual(types(s.drainEvents()), ['countdown2']);
  assert.equal(s.countdown, 2);
  for (let i = 0; i < 4; i++) s.update(0.25, p);
  assert.deepEqual(types(s.drainEvents()), ['countdown1']);
  for (let i = 0; i < 3; i++) s.update(0.25, p);
  assert.equal(s.state, 'countdown');
  assert.equal(s.elapsed, 0);
  s.update(0.25, p);
  assert.deepEqual(types(s.drainEvents()), ['go']);
  assert.equal(s.state, 'racing');
  assert.equal(s.elapsed, 0);
  for (const hz of [30, 60, 120]) {
    const t = newSquare();
    assert.equal(launch(t, p, 1 / hz), 3 * hz);
    assert.ok(t.elapsed < 1e-6);
    assert.deepEqual(types(t.drainEvents()), ['countdown3', 'countdown2', 'countdown1', 'go']);
  }
});

test('long steps still emit every countdown event once and in order', () => {
  const p = square.at(S0);
  const a = newSquare();
  a.start(p);
  a.update(2.5, p);
  assert.deepEqual(types(a.drainEvents()), ['countdown3', 'countdown2', 'countdown1']);
  a.update(0.4, p);
  assert.deepEqual(types(a.drainEvents()), []);
  a.update(0.2, p);
  assert.deepEqual(types(a.drainEvents()), ['go']);
  assert.ok(Math.abs(a.elapsed - 0.1) < 1e-9);
  const b = newSquare();
  b.start(p);
  b.update(5, p);
  assert.deepEqual(types(b.drainEvents()), ['countdown3', 'countdown2', 'countdown1', 'go']);
  assert.ok(Math.abs(b.elapsed - 2) < 1e-9);
});

test('a pause (no updates) adds no time, and bad dt is ignored', () => {
  const s = newSquare(), p = square.at(S0);
  s.start(p);
  assert.equal(s.countdown, 3);
  launch(s, p);
  for (let i = 0; i < 3; i++) s.update(DT, p);
  const before = s.elapsed;
  s.update(0, p);
  s.update(NaN, p);
  s.update(-1, p);
  assert.equal(s.elapsed, before);
  s.update(DT, p);
  assert.ok(Math.abs(s.elapsed - before - DT) < 1e-12);
});

test('forward lap on the square gives the same time at 30/60/120 Hz', () => {
  for (const hz of [30, 60, 120]) {
    const s = newSquare();
    launch(s, square.at(S0), 1 / hz);
    lap(s, square, S0, 20, 1 / hz, 60);
    assert.equal(s.state, 'finished');
    assert.ok(Math.abs(s.elapsed - 20) < 1e-6, `lap ${s.elapsed} at ${hz} Hz`);
    s.splits.forEach((split, i) => assert.ok(Math.abs(split - 5 * (i + 1)) < 1e-6));
    assert.equal(s.valid, true);
    assert.deepEqual(types(s.drainEvents()).slice(4), ['checkpoint', 'checkpoint', 'checkpoint', 'finish', 'personalBest']);
    assert.ok(Math.abs(s.best.time - 20) < 1e-6);
    const frozen = s.elapsed;
    s.update(1 / hz, square.at(S0 + 5));
    assert.equal(s.elapsed, frozen);
  }
});

test('driving the wrong way round never passes a gate', () => {
  const s = newSquare();
  launch(s, square.at(S0));
  drive(s, square, S0, S0 - 405);
  drive(s, square, S0 - 405, S0 - 395);
  assert.equal(s.state, 'racing');
  assert.equal(s.checkpoint, 0);
  assert.equal(s.valid, true);
  assert.ok(!types(s.drainEvents()).includes('checkpoint'));
});

test('bouncing on one gate counts it once and cannot finish', () => {
  const s = newSquare();
  launch(s, square.at(S0));
  drive(s, square, S0, 115);
  assert.equal(s.checkpoint, 1);
  for (let i = 0; i < 3; i++) { drive(s, square, 115, 105); drive(s, square, 105, 115); }
  assert.equal(s.checkpoint, 1);
  drive(s, square, 115, 5);
  drive(s, square, 5, 15);
  assert.equal(s.state, 'racing');
  assert.equal(s.checkpoint, 1);
});

test('skipping a checkpoint by cutting across cannot finish', () => {
  const s = newSquare();
  launch(s, square.at(S0));
  drive(s, square, S0, 120);
  assert.equal(s.checkpoint, 1);
  line(s, square.at(120), square.at(305));
  drive(s, square, 305, 415);
  assert.equal(s.state, 'racing');
  assert.equal(s.checkpoint, 1);
  assert.equal(s.valid, false);
  assert.equal(s.best, null);
});

test('a teleport step cannot count a gate and invalidates the record', () => {
  const s = newSquare();
  launch(s, square.at(S0));
  drive(s, square, S0, 100);
  s.update(DT, square.at(120));
  assert.equal(s.checkpoint, 0);
  assert.equal(s.valid, false);
  drive(s, square, 120, 105);
  drive(s, square, 105, 415);
  assert.equal(s.state, 'finished');
  const events = s.drainEvents();
  assert.deepEqual(events.filter(e => e.type === 'invalid').map(e => e.reason), ['teleport']);
  const finish = events.find(e => e.type === 'finish');
  assert.equal(finish.valid, false);
  assert.equal(finish.personalBest, false);
  assert.ok(!types(events).includes('personalBest'));
  assert.equal(s.best, null);
});

test('repeated off-course time invalidates after 0.5 s in total', () => {
  const s = newSquare();
  let x = S0;
  const step = z => s.update(DT, { x: (x += 0.2), y: 0.5, z });
  launch(s, { x, y: 0.5, z: -7 });
  for (let i = 0; i < 12; i++) step(-7);
  assert.equal(s.offCourse, true);
  for (let z = -6; z <= 0; z++) step(z);
  assert.equal(s.offCourse, false);
  assert.equal(s.valid, true);
  for (let z = -1; z >= -7; z--) step(z);
  for (let i = 0; i < 10; i++) step(-7);
  assert.equal(s.valid, true);
  assert.equal(s.offCourse, true);
  for (let i = 0; i < 10; i++) step(-7);
  assert.equal(s.valid, false);
  assert.equal(s.state, 'racing');
  assert.deepEqual(s.drainEvents().filter(e => e.type === 'invalid').map(e => e.reason), ['offcourse']);

  const h = newSquare();
  launch(h, square.at(S0));
  for (let y = 1.5; y <= 5; y++) h.update(DT, { x: S0, y, z: 0 });
  for (let i = 0; i < 40; i++) h.update(DT, { x: S0, y: 5.5, z: 0 });
  assert.equal(h.valid, false);
  assert.deepEqual(h.drainEvents().filter(e => e.type === 'invalid').map(e => e.reason), ['offcourse']);
});

test('cancel, restart and slower laps keep the best; only a faster valid lap replaces it', () => {
  const s = newSquare();
  launch(s, square.at(S0));
  lap(s, square, S0, 20, DT, 60);
  assert.ok(Math.abs(s.best.time - 20) < 1e-6);
  s.drainEvents();

  launch(s, square.at(S0));
  drive(s, square, S0, 150);
  s.cancel(square.at(S0));
  assert.equal(s.state, 'practice');
  assert.equal(s.elapsed, 0);
  assert.equal(s.checkpoint, 0);
  assert.ok(types(s.drainEvents()).includes('cancel'));
  assert.ok(Math.abs(s.best.time - 20) < 1e-6);

  launch(s, square.at(S0));
  drive(s, square, S0, 150);
  launch(s, square.at(S0));
  assert.equal(s.checkpoint, 0);
  lap(s, square, S0, 10, DT, 90);
  assert.equal(s.state, 'finished');
  let finish = s.drainEvents().find(e => e.type === 'finish');
  assert.equal(finish.valid, true);
  assert.equal(finish.personalBest, false);
  assert.ok(Math.abs(s.best.time - 20) < 1e-6);

  launch(s, square.at(S0));
  lap(s, square, S0, 25, DT, 60);
  const events = s.drainEvents();
  finish = events.find(e => e.type === 'finish');
  assert.equal(finish.personalBest, true);
  assert.ok(Math.abs(finish.previousBest - 20) < 1e-6);
  assert.ok(events.find(e => e.type === 'checkpoint').delta < 0);
  assert.ok(types(events).includes('personalBest'));
  assert.ok(Math.abs(s.best.time - 16) < 1e-6);
});

test('saved best data is validated defensively', () => {
  const junk = [undefined, null, 'x', 5, [], {}, { time: -1, splits: [1, 2, 3] }, { time: NaN, splits: [1, 2, 3] },
    { time: Infinity, splits: [1, 2, 3] }, { time: 10 }, { time: 10, splits: [1, 2] }, { time: 10, splits: [3, 2, 5] },
    { time: 10, splits: [1, 2, 11] }, { time: 10, splits: [0, 2, 5] }, { time: 10, splits: [1, '2', 5] }, { time: '10', splits: [1, 2, 5] }];
  for (const value of junk) {
    assert.equal(readBestLap(value), null);
    assert.equal(newSquare(value).best, null);
  }
  const saved = { time: 10, splits: [2, 5, 8] };
  const s = newSquare(saved);
  assert.deepEqual(s.best, saved);
  saved.splits[0] = 99;
  assert.equal(s.best.splits[0], 2);
  launch(s, square.at(S0));
  lap(s, square, S0, 20, DT, 60);
  assert.equal(s.state, 'finished');
  assert.equal(s.best.time, 10);
  assert.ok(!types(s.drainEvents()).includes('personalBest'));
});

test('real route: gates derive from the spawn projection and a 16 m/s lap times L/v', () => {
  const route = readRoute();
  assert.ok(route, 'route JSON with points and width not found in the repository');
  assert.ok(route.points.length >= 500);
  const spawn = VEHICLE.spawn;
  const path = makePath(route.points);
  const probe = new RaceSession(route.points, route.width, spawn);
  assert.ok(Math.abs(probe.lapLength - path.length) < 1e-6);
  assert.ok(Math.abs(path.length - route.length) < 2, `polyline ${path.length} vs metadata ${route.length}`);
  assert.ok(probe.startStation > 10 && probe.startStation < path.length - 10, 'start is not route point 0');
  assert.equal(probe.gates.length, 4);
  const finishGate = probe.gates[3];
  assert.ok(Math.abs(finishGate.x) < 0.05 && Math.abs(finishGate.z - spawn.z) < 0.25);
  assert.ok(finishGate.tz < -0.9, 'start gate faces local -Z');
  probe.gates.forEach((gate, i) => {
    const expected = (probe.startStation + path.length * (i + 1) / 4) % path.length;
    assert.ok(Math.abs(gate.station - expected) < 1e-6);
    const centre = path.at(expected, 0);
    assert.ok(Math.hypot(gate.x - centre.x, gate.z - centre.z) < 1e-6);
  });

  const speed = 16, expected = path.length / speed, times = [];
  for (const hz of [30, 60, 120]) {
    const dt = 1 / hz;
    const s = new RaceSession(route.points, route.width, spawn);
    assert.equal(launch(s, spawn, dt), 3 * hz);
    lap(s, path, s.startStation, speed, dt, expected + 5);
    assert.equal(s.state, 'finished', `no finish at ${hz} Hz`);
    assert.ok(Math.abs(s.elapsed - expected) < 0.05, `lap ${s.elapsed} vs ${expected} at ${hz} Hz`);
    assert.equal(s.splits.length, 3);
    s.splits.forEach((split, i) => assert.ok(Math.abs(split - expected * (i + 1) / 4) < 0.05));
    assert.equal(s.valid, true);
    const events = s.drainEvents();
    assert.ok(!types(events).includes('invalid'));
    assert.ok(types(events).includes('personalBest'));
    assert.equal(s.best.time, s.elapsed);
    times.push(s.elapsed);
  }
  assert.ok(Math.max(...times) - Math.min(...times) < 0.01);
});
