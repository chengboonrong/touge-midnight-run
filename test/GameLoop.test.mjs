import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/core/GameLoop.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { GameLoop } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function harness(t) {
  const pending = new Map();
  let nextId = 0;
  let steps = 0;
  const frames = [];
  t.mock.method(globalThis, 'requestAnimationFrame', (callback) => {
    pending.set(++nextId, callback);
    return nextId;
  });
  t.mock.method(globalThis, 'cancelAnimationFrame', (id) => pending.delete(id));
  const loop = new GameLoop({
    fixedUpdate: (dt) => {
      assert.equal(dt, 1 / 60);
      steps++;
    },
    render: (alpha, dt) => {
      assert.ok(alpha >= 0 && alpha < 1);
      frames.push({ alpha, dt });
    },
  });
  const tick = (ms) => {
    const [id, callback] = pending.entries().next().value;
    pending.delete(id);
    callback(ms);
  };
  return { loop, tick, frames, pending, steps: () => steps };
}

// Node has no browser animation scheduler; each test restores these placeholders.
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

for (const hz of [30, 60, 120, 144]) {
  test(`60 physics steps per second at ${hz} render Hz`, (t) => {
    const h = harness(t);
    h.loop.start();
    h.loop.start();
    assert.equal(h.pending.size, 1);
    for (let frame = 0; frame <= hz * 10; frame++) h.tick(frame * 1000 / hz);
    assert.ok(Math.abs(h.steps() - 600) <= 1);
    assert.equal(h.frames.length, hz * 10 + 1);
    h.loop.stop();
    assert.equal(h.loop.isRunning, false);
    assert.equal(h.pending.size, 0);
  });
}

test('long gaps clamp to 0.1 seconds and restart discards elapsed time', (t) => {
  const h = harness(t);
  h.loop.start();
  h.tick(0);
  h.tick(10000);
  assert.equal(h.frames.at(-1).dt, 0.1);
  assert.equal(h.steps(), 6);
  h.loop.stop();
  h.loop.start();
  h.tick(20000);
  assert.equal(h.steps(), 6);
  assert.equal(h.frames.at(-1).alpha, 0);
  h.loop.stop();
});
