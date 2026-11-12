import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/core/Input.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { Input } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const HELD_CODES = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'];
const MODIFIERS = ['ctrlKey', 'metaKey', 'altKey'];

// Node provides EventTarget and Event but not KeyboardEvent, so key events are
// cancelable Events carrying the KeyboardEvent fields that Input reads.
function harness() {
  const target = new EventTarget();
  const input = new Input(target);
  const send = (type, code, init = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      code,
      repeat: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  };
  return {
    input,
    down: (code, init) => send('keydown', code, init),
    up: (code, init) => send('keyup', code, init),
    blur: () => target.dispatchEvent(new Event('blur')),
    held: () => HELD_CODES.filter((code) => input.isHeld(code)),
  };
}

test('nothing is held and no reset is pending initially', () => {
  const h = harness();
  assert.deepEqual(h.held(), []);
  assert.equal(h.input.consumeReset(), false);
});

for (const code of HELD_CODES) {
  test(`${code} is held from keydown until keyup, and only that key`, () => {
    const h = harness();
    h.down(code);
    assert.deepEqual(h.held(), [code]);
    h.up(code);
    assert.deepEqual(h.held(), []);
  });
}

test('held keys are tracked independently of each other', () => {
  const h = harness();
  h.down('KeyW');
  h.down('KeyD');
  h.down('Space');
  assert.deepEqual(h.held(), ['KeyW', 'KeyD', 'Space']);
  h.up('KeyD');
  assert.deepEqual(h.held(), ['KeyW', 'Space']);
  h.up('KeyA'); // releasing a key that was never down changes nothing
  assert.deepEqual(h.held(), ['KeyW', 'Space']);
  h.up('KeyW');
  h.up('Space');
  assert.deepEqual(h.held(), []);
});

test('auto-repeat keydowns keep a key held and one keyup releases it', () => {
  const h = harness();
  h.down('KeyW');
  for (let i = 0; i < 5; i++) h.down('KeyW', { repeat: true });
  assert.deepEqual(h.held(), ['KeyW']);
  h.up('KeyW');
  assert.deepEqual(h.held(), []);
});

test('handled keys prevent the browser default on keydown, repeat and keyup', () => {
  const h = harness();
  for (const code of [...HELD_CODES, 'KeyR']) {
    assert.equal(h.down(code).defaultPrevented, true, `${code} keydown`);
    assert.equal(h.down(code, { repeat: true }).defaultPrevented, true, `${code} repeat`);
    assert.equal(h.up(code).defaultPrevented, true, `${code} keyup`);
  }
});

test('unhandled keys are left alone and change no state', () => {
  const h = harness();
  for (const code of ['KeyQ', 'Tab', 'F5', 'F12', 'ArrowUp', 'Escape']) {
    assert.equal(h.down(code).defaultPrevented, false, `${code} keydown`);
    assert.equal(h.up(code).defaultPrevented, false, `${code} keyup`);
  }
  assert.deepEqual(h.held(), []);
  assert.equal(h.input.consumeReset(), false);
});

test('R requests exactly one reset, which is consumed once', () => {
  const h = harness();
  h.down('KeyR');
  assert.equal(h.input.consumeReset(), true);
  assert.equal(h.input.consumeReset(), false);
});

test('a reset stays pending after R is released until it is consumed', () => {
  const h = harness();
  h.down('KeyR');
  h.up('KeyR');
  assert.equal(h.input.consumeReset(), true);
  assert.equal(h.input.consumeReset(), false);
});

test('holding R never re-arms the reset through repeat keydowns', () => {
  const h = harness();
  h.down('KeyR');
  assert.equal(h.input.consumeReset(), true);
  for (let i = 0; i < 10; i++) h.down('KeyR', { repeat: true });
  assert.equal(h.input.consumeReset(), false);
  h.up('KeyR');
  assert.equal(h.input.consumeReset(), false);
});

test('a repeat R keydown with no initial press does not request a reset', () => {
  const h = harness();
  h.down('KeyR', { repeat: true });
  assert.equal(h.input.consumeReset(), false);
});

test('releasing and pressing R again requests a new reset', () => {
  const h = harness();
  h.down('KeyR');
  assert.equal(h.input.consumeReset(), true);
  h.up('KeyR');
  h.down('KeyR');
  assert.equal(h.input.consumeReset(), true);
  assert.equal(h.input.consumeReset(), false);
});

test('several R presses before one consume collapse into a single reset', () => {
  const h = harness();
  for (let i = 0; i < 3; i++) {
    h.down('KeyR');
    h.up('KeyR');
  }
  assert.equal(h.input.consumeReset(), true);
  assert.equal(h.input.consumeReset(), false);
});

test('R is not a held key and held keys do not request a reset', () => {
  const h = harness();
  h.down('KeyR');
  assert.deepEqual(h.held(), []);
  assert.equal(h.input.isHeld('KeyR'), false);
  h.input.consumeReset();
  for (const code of HELD_CODES) h.down(code);
  assert.equal(h.input.consumeReset(), false);
});

for (const modifier of MODIFIERS) {
  test(`${modifier} combinations stay browser shortcuts and are not game input`, () => {
    const h = harness();
    for (const code of [...HELD_CODES, 'KeyR']) {
      const event = h.down(code, { [modifier]: true });
      assert.equal(event.defaultPrevented, false, `${code} keydown`);
    }
    assert.deepEqual(h.held(), []);
    assert.equal(h.input.consumeReset(), false);
  });

  test(`keyup with ${modifier} down still releases the key, without preventing default`, () => {
    const h = harness();
    h.down('KeyW');
    const event = h.up('KeyW', { [modifier]: true });
    assert.deepEqual(h.held(), []);
    assert.equal(event.defaultPrevented, false);
  });
}

test('Shift is not a shortcut modifier', () => {
  const h = harness();
  assert.equal(h.down('KeyW', { shiftKey: true }).defaultPrevented, true);
  assert.deepEqual(h.held(), ['KeyW']);
  h.down('KeyR', { shiftKey: true });
  assert.equal(h.input.consumeReset(), true);
});

test('blur clears every held key and the pending reset', () => {
  const h = harness();
  for (const code of HELD_CODES) h.down(code);
  h.down('KeyR');
  h.blur();
  assert.deepEqual(h.held(), []);
  assert.equal(h.input.consumeReset(), false);
});

test('after blur, a still-held R does not reset but fresh input works', () => {
  const h = harness();
  h.down('KeyW');
  h.down('KeyR');
  h.blur();

  // Focus returns with both keys physically down: the OS sends repeats only.
  h.down('KeyR', { repeat: true });
  assert.equal(h.input.consumeReset(), false);
  h.down('KeyW', { repeat: true });
  assert.deepEqual(h.held(), ['KeyW']);

  h.up('KeyW');
  h.up('KeyR');
  assert.deepEqual(h.held(), []);
  h.down('KeyR');
  assert.equal(h.input.consumeReset(), true);
});

test('dispose detaches the listeners and drops state', () => {
  const h = harness();
  h.down('KeyW');
  h.down('KeyR');
  h.input.dispose();
  assert.deepEqual(h.held(), []);
  assert.equal(h.input.consumeReset(), false);

  assert.equal(h.down('KeyA').defaultPrevented, false);
  h.down('KeyR');
  assert.deepEqual(h.held(), []);
  assert.equal(h.input.consumeReset(), false);
});

test('starting a browser shortcut releases driving controls even if keyup is lost', () => {
  const h = harness();
  h.down('KeyW');
  h.down('Space');
  h.down('KeyR');
  const event = h.down('MetaLeft', { metaKey: true });
  assert.equal(event.defaultPrevented, false);
  h.up('MetaLeft');
  assert.deepEqual(h.held(), []);
  assert.equal(h.input.consumeReset(), false);
});
