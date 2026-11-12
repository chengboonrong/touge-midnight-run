import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/core/Input.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { Input } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

/** A synthetic UI control: closest() finds an owned control, as a select or summary would. */
const control = { closest: () => control };
/** A synthetic non-control element, such as the canvas. */
const plain = { closest: () => null };

function fire(win, type, code, target) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { code, repeat: false, ctrlKey: false, metaKey: false, altKey: false });
  if (target) Object.defineProperty(event, 'target', { value: target });
  win.dispatchEvent(event);
  return event;
}

test('keydown on a UI control is neither prevented nor held', () => {
  const win = new EventTarget();
  const input = new Input(win);
  assert.equal(fire(win, 'keydown', 'Space', control).defaultPrevented, false);
  assert.equal(fire(win, 'keydown', 'KeyW', control).defaultPrevented, false);
  assert.equal(fire(win, 'keydown', 'KeyR', control).defaultPrevented, false);
  assert.equal(input.isHeld('Space'), false);
  assert.equal(input.isHeld('KeyW'), false);
  assert.equal(input.consumeReset(), false);
  input.dispose();
});

test('keydown on the window or a non-control element still drives', () => {
  const win = new EventTarget();
  const input = new Input(win);
  assert.equal(fire(win, 'keydown', 'KeyW').defaultPrevented, true);
  assert.equal(fire(win, 'keydown', 'KeyA', plain).defaultPrevented, true);
  assert.equal(input.isHeld('KeyW'), true);
  assert.equal(input.isHeld('KeyA'), true);
  input.dispose();
});

test('focusin onto a UI control clears keyboard holds, other focusin does not', () => {
  const win = new EventTarget();
  const input = new Input(win);
  fire(win, 'keydown', 'KeyW');
  fire(win, 'focusin', undefined, plain);
  fire(win, 'focusin');
  assert.equal(input.isHeld('KeyW'), true);
  fire(win, 'focusin', undefined, control);
  assert.equal(input.isHeld('KeyW'), false);
  input.dispose();
});

test('keyup on a UI control still releases and leaves the default alone', () => {
  const win = new EventTarget();
  const input = new Input(win);
  fire(win, 'keydown', 'KeyD');
  const up = fire(win, 'keyup', 'KeyD', control);
  assert.equal(input.isHeld('KeyD'), false);
  assert.equal(up.defaultPrevented, false);
  input.dispose();
});

test('clearAll drops keyboard holds, touch holds and a pending reset', () => {
  const win = new EventTarget();
  const input = new Input(win);
  fire(win, 'keydown', 'KeyW');
  fire(win, 'keydown', 'KeyR');
  input.setTouchHeld('KeyS', true);
  input.clearAll();
  assert.equal(input.isHeld('KeyW'), false);
  assert.equal(input.isHeld('KeyS'), false);
  assert.equal(input.consumeReset(), false);
  input.dispose();
});
