import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function load(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('exports', 'require', 'module', js)(module.exports, require, module);
  return module.exports;
}

const { ImpactFeedback, IMPACT_MIN_DELTA_V, IMPACT_COOLDOWN, impactThresholdForce } = load('../src/physics/ImpactFeedback.ts');
const MASS = 1200;
const DT = 1 / 60;
const CAR = 1;
const hit = (f, deltaV, dt = DT) => f.contact(CAR, 2, CAR, deltaV * MASS / dt, dt, MASS);

test('ordinary support and resting loads are silent', () => {
  const f = new ImpactFeedback();
  f.contact(CAR, 2, CAR, MASS * 9.81, DT, MASS);
  f.contact(2, CAR, CAR, 2 * MASS * 9.81, DT, MASS);
  f.contact(CAR, 2, CAR, NaN, DT, MASS);
  f.contact(CAR, 2, CAR, 1e9, 0, MASS);
  assert.equal(f.consume(), 0);
  assert.ok(impactThresholdForce(MASS, DT) > 2 * MASS * 9.81);
  assert.ok(Math.abs(impactThresholdForce(MASS, DT) - IMPACT_MIN_DELTA_V * MASS / DT) < 1e-6);
});

test('a strong hit yields a bounded amplitude, consumed once', () => {
  const f = new ImpactFeedback();
  hit(f, 2);
  const s = f.consume();
  assert.ok(s > 0 && s < 1);
  assert.equal(f.consume(), 0);
  const g = new ImpactFeedback();
  g.contact(2, CAR, CAR, 1e12, DT, MASS);
  assert.equal(g.consume(), 1);
});

test('contacts that do not involve the vehicle are ignored', () => {
  const f = new ImpactFeedback();
  f.contact(5, 6, CAR, 1e9, DT, MASS);
  assert.equal(f.consume(), 0);
});

test('the same events give one identical impact at 30, 60 and 144 Hz render', () => {
  const events = new Map([[10, 2], [11, 3], [12, 2]]);
  const results = [30, 60, 144].map(hz => {
    const f = new ImpactFeedback();
    const out = [];
    let done = 0;
    for (let frame = 1; frame <= hz; frame++) {
      const due = Math.floor(frame * 60 / hz + 1e-9);
      for (; done < due; done++) {
        f.step(DT);
        if (events.has(done)) hit(f, events.get(done));
      }
      const s = f.consume();
      if (s > 0) out.push(s);
    }
    return out;
  });
  for (const out of results) assert.deepEqual(out, results[0]);
  assert.equal(results[0].length, 1);
});

test('cooldown is measured in simulation time, not steps', () => {
  for (const dt of [1 / 60, 1 / 120]) {
    const early = new ImpactFeedback();
    hit(early, 3, dt);
    assert.ok(early.consume() > 0);
    for (let i = 0; i < Math.floor(0.5 * IMPACT_COOLDOWN / dt); i++) early.step(dt);
    hit(early, 3, dt);
    assert.equal(early.consume(), 0);
    const late = new ImpactFeedback();
    hit(late, 3, dt);
    assert.ok(late.consume() > 0);
    for (let i = 0; i < Math.ceil(IMPACT_COOLDOWN / dt) + 1; i++) late.step(dt);
    hit(late, 3, dt);
    assert.ok(late.consume() > 0);
  }
});

test('sustained hard contact thumps once', () => {
  const f = new ImpactFeedback();
  let count = 0;
  for (let i = 0; i < 120; i++) {
    f.step(DT);
    hit(f, 2);
    if (f.consume() > 0) count++;
  }
  assert.equal(count, 1);
});

test('reset clears the pending impact and the cooldown', () => {
  const f = new ImpactFeedback();
  hit(f, 3);
  f.reset();
  assert.equal(f.consume(), 0);
  hit(f, 3);
  assert.ok(f.consume() > 0);
});

test('paused frames (no step, no contacts) produce no events and do not age the cooldown', () => {
  const f = new ImpactFeedback();
  hit(f, 3);
  assert.ok(f.consume() > 0);
  for (let i = 0; i < 100; i++) assert.equal(f.consume(), 0);
  f.step(DT); // First resumed physics step, with no catch-up for paused renders.
  hit(f, 3);
  assert.equal(f.consume(), 0);
});

test('multiple contacts in one fixed step retain the strongest accepted hit',()=>{
 const a=new ImpactFeedback();a.step(DT);hit(a,2);hit(a,3);
 const b=new ImpactFeedback();b.step(DT);hit(b,3);
 assert.equal(a.consume(),b.consume());
});
