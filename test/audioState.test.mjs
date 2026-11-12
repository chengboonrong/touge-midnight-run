// Audio lifecycle tests: transpile src/audio/audioState.ts standalone (it has no imports) and load it via a data URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/audio/audioState.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const m = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

const tick = () => new Promise(resolve => setImmediate(resolve));

/** A context stand-in whose resume/suspend promises the test settles by hand. */
function fakeContext(state) {
  const calls = [];
  const op = name => () => {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    calls.push({ op: name, resolve, reject });
    return promise;
  };
  return { state, calls, resume: op('resume'), suspend: op('suspend') };
}

/** Wires the gate the way GameAudio does: re-sync to the current want when the state changed. */
function host(ctx) {
  const h = { want: true, log: [], gate: null };
  h.gate = new m.ContextGate(ctx, changed => { h.log.push(changed); if (changed) h.gate.sync(h.want); });
  return h;
}

test('a pending resume from an invalid gesture does not block a later gesture', async () => {
  const ctx = fakeContext('suspended');
  const h = host(ctx);
  h.gate.sync(true, true); // Escape: resume() stays pending without activation
  assert.equal(ctx.calls.length, 1);
  h.gate.sync(true, false); // visibility or state change: no stacking
  assert.equal(ctx.calls.length, 1);
  h.gate.sync(true, true); // W or pointer: must retry
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[1].op, 'resume');
  ctx.state = 'running';
  ctx.calls[1].resolve();
  ctx.calls[0].resolve();
  await tick();
  h.gate.sync(true, true);
  assert.equal(ctx.calls.length, 2, 'running context needs no further calls');
});

test('pausing during a pending resume suspends, and a late resume is suspended again', async () => {
  const ctx = fakeContext('suspended');
  const h = host(ctx);
  h.gate.sync(true, true);
  h.want = false;
  h.gate.sync(false);
  assert.equal(ctx.calls[1]?.op, 'suspend');
  h.gate.sync(false);
  assert.equal(ctx.calls.length, 2, 'no duplicate suspend while one is pending');
  ctx.calls[1].resolve();
  await tick();
  ctx.state = 'running'; // the old resume finally lands while still paused
  ctx.calls[0].resolve();
  await tick();
  assert.equal(ctx.calls.length, 3);
  assert.equal(ctx.calls[2].op, 'suspend');
  ctx.state = 'suspended';
  ctx.calls[2].resolve();
  await tick();
  assert.equal(ctx.calls.length, 3);
});

test('unpausing during a pending suspend resumes once it settles', async () => {
  const ctx = fakeContext('running');
  const h = host(ctx);
  h.want = false;
  h.gate.sync(false);
  assert.equal(ctx.calls[0]?.op, 'suspend');
  h.want = true;
  h.gate.sync(true);
  assert.equal(ctx.calls.length, 1);
  ctx.state = 'suspended';
  ctx.calls[0].resolve();
  await tick();
  assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[1].op, 'resume');
});

test('rejections, synchronous throws and a closed context never throw or loop', async () => {
  const ctx = fakeContext('suspended');
  const h = host(ctx);
  h.gate.sync(true, true);
  ctx.calls[0].reject(new Error('no activation'));
  await tick();
  assert.deepEqual(h.log, [false]);
  assert.equal(ctx.calls.length, 1, 'a rejection does not retry by itself');
  h.gate.sync(true, false);
  assert.equal(ctx.calls.length, 2, 'pending was cleared, so the next sync retries');
  ctx.calls[1].resolve(); // fulfilled but state unchanged: must not loop
  await tick();
  assert.equal(ctx.calls.length, 2);
  ctx.resume = () => { throw new Error('broken'); };
  assert.doesNotThrow(() => h.gate.sync(true, true));
  await tick();
  assert.equal(h.log.at(-1), false);
  ctx.state = 'closed';
  let touched = 0;
  ctx.resume = ctx.suspend = () => { touched++; return Promise.resolve(); };
  h.gate.sync(true, true);
  h.gate.sync(false);
  assert.equal(touched, 0);
});

test('automation is throttled to about 30 Hz and skips insignificant targets', () => {
  const throttle = new m.AutomationThrottle();
  let due = 0;
  for (let i = 0; i < 600; i++) if (throttle.due(i / 60)) due++;
  assert.ok(due >= 290 && due <= 301, `60 fps for 10 s scheduled ${due} times`);
  const fast = new m.AutomationThrottle();
  due = 0;
  for (let i = 0; i < 1440; i++) if (fast.due(i / 144)) due++;
  assert.ok(due <= 301, `144 fps for 10 s scheduled ${due} times`);
  assert.equal(m.targetChanged(NaN, 1), true, 'first target always schedules');
  assert.equal(m.targetChanged(1, 1.0005), false);
  assert.equal(m.targetChanged(100, 100.05), false);
  assert.equal(m.targetChanged(1, 1.01), true);
  assert.equal(m.targetChanged(0.5, 0), true);
  assert.equal(m.targetChanged(0.0005, 0), true, 'a tiny level still decays to exact silence');
  assert.equal(m.targetChanged(0, 0), false);
  assert.equal(m.targetChanged(0, NaN), false, 'nonfinite targets are never scheduled');
  assert.equal(m.targetChanged(0, Infinity), false);
});
