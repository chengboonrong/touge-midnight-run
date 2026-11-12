import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
const { Input } = await load('../src/core/Input.ts');
const { TouchControls } = await load('../src/ui/TouchControls.ts');

const HELD_CODES = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'];
const RELEASE_EVENTS = ['pointerup', 'pointercancel', 'lostpointercapture'];

// Node has EventTarget and Event but no DOM. This is the part of an element
// that TouchControls uses; events are dispatched straight at the element.
class FakeElement extends EventTarget {
  children = [];
  attributes = new Map();
  captured = [];
  removed = false;
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(child) { this.children.push(child); }
  remove() { this.removed = true; }
  setPointerCapture(pointerId) { this.captured.push(pointerId); }
}

function harness() {
  const view = new EventTarget(); // stands in for window; shared with Input as in main.ts
  const page = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    body: new FakeElement(),
    createElement: () => new FakeElement(),
  });
  const input = new Input(view);
  const touch = new TouchControls(input, page, view);
  const root = page.body.children[0];
  const button = (label) => root.children.find((child) => child.textContent === label);
  const pointer = (label, type, pointerId, mouseButton = 0) => {
    const event = Object.assign(new Event(type, { cancelable: true }), { pointerId, button: mouseButton });
    button(label).dispatchEvent(event);
    return event;
  };
  const key = (type, code, init = {}) => view.dispatchEvent(Object.assign(
    new Event(type, { cancelable: true }),
    { code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...init },
  ));
  return {
    input, touch, page, view, root, button, key,
    down: (label, pointerId, mouseButton) => pointer(label, 'pointerdown', pointerId, mouseButton),
    up: (label, pointerId) => pointer(label, 'pointerup', pointerId),
    pointer,
    held: () => HELD_CODES.filter((code) => input.isHeld(code)),
    pressed: () => root.children
      .filter((child) => child.getAttribute('aria-pressed') === 'true')
      .map((child) => child.textContent),
  };
}

// --- Input: source ownership ---

test('a touch hold reads as held until the touch source releases it', () => {
  const input = new Input(new EventTarget());
  input.setTouchHeld('KeyW', true);
  assert.equal(input.isHeld('KeyW'), true);
  assert.equal(input.isHeld('KeyS'), false);
  input.setTouchHeld('KeyW', false);
  assert.equal(input.isHeld('KeyW'), false);
});

test('requestReset raises one reset that is consumed once', () => {
  const input = new Input(new EventTarget());
  input.requestReset();
  assert.equal(input.consumeReset(), true);
  assert.equal(input.consumeReset(), false);
});

test('keyboard and touch holds of the same action are independent', () => {
  const h = harness();
  h.key('keydown', 'KeyW');
  h.down('GAS', 1);
  h.up('GAS', 1);
  assert.deepEqual(h.held(), ['KeyW'], 'touch release keeps the keyboard hold');

  h.down('GAS', 2);
  h.key('keyup', 'KeyW');
  assert.deepEqual(h.held(), ['KeyW'], 'keyup keeps the touch hold');
  h.up('GAS', 2);
  assert.deepEqual(h.held(), []);
});

test('a keyboard shortcut clears keyboard holds but not touch holds', () => {
  const h = harness();
  h.key('keydown', 'KeyA');
  h.down('GAS', 1);
  h.key('keydown', 'MetaLeft', { metaKey: true });
  assert.deepEqual(h.held(), ['KeyW']);
  assert.deepEqual(h.pressed(), ['GAS']);
});

test('Input.dispose drops touch holds too', () => {
  const h = harness();
  h.down('GAS', 1);
  h.input.dispose();
  assert.deepEqual(h.held(), []);
});

// --- TouchControls: structure ---

test('renders six named, unpressed buttons inside a labelled group', () => {
  const h = harness();
  assert.equal(h.root.getAttribute('role'), 'group');
  assert.ok(h.root.getAttribute('aria-label'));
  assert.deepEqual(
    h.root.children.map((child) => child.textContent).sort(),
    ['BRAKE', 'GAS', 'HANDBRAKE', 'LEFT', 'RESET', 'RIGHT'],
  );
  for (const child of h.root.children) {
    assert.equal(child.type, 'button');
    assert.equal(child.getAttribute('aria-pressed'), 'false');
  }
  assert.deepEqual(h.held(), []);
  assert.equal(h.input.consumeReset(), false);
});

test('each button drives its own action', () => {
  const actions = { GAS: 'KeyW', BRAKE: 'KeyS', LEFT: 'KeyA', RIGHT: 'KeyD', HANDBRAKE: 'Space' };
  for (const [label, code] of Object.entries(actions)) {
    const h = harness();
    h.down(label, 1);
    assert.deepEqual(h.held(), [code], label);
    assert.deepEqual(h.pressed(), [label]);
    h.up(label, 1);
    assert.deepEqual(h.held(), [], label);
    assert.deepEqual(h.pressed(), []);
  }
});

// --- TouchControls: pointer lifecycle ---

test('gas, steering and handbrake are held together by separate pointers', () => {
  const h = harness();
  h.down('GAS', 1);
  h.down('LEFT', 2);
  h.down('HANDBRAKE', 3);
  assert.deepEqual(h.held(), ['KeyW', 'KeyA', 'Space']);
  h.up('LEFT', 2);
  assert.deepEqual(h.held(), ['KeyW', 'Space']);
  h.up('HANDBRAKE', 3);
  assert.deepEqual(h.held(), ['KeyW']);
  h.up('GAS', 1);
  assert.deepEqual(h.held(), []);
});

test('pointerdown captures the pointer and prevents the browser default', () => {
  const h = harness();
  const event = h.down('GAS', 7);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(h.button('GAS').captured, [7]);
});

for (const type of RELEASE_EVENTS) {
  test(`${type} releases the hold`, () => {
    const h = harness();
    h.down('GAS', 1);
    h.down('RIGHT', 2);
    h.pointer('GAS', type, 1);
    assert.deepEqual(h.held(), ['KeyD']);
    assert.deepEqual(h.pressed(), ['RIGHT']);
  });
}

test('two pointers on one button: the hold lasts until the last one releases', () => {
  const h = harness();
  h.down('GAS', 1);
  h.down('GAS', 2);
  h.up('GAS', 1);
  h.pointer('GAS', 'lostpointercapture', 1); // browsers send this after pointerup
  assert.deepEqual(h.held(), ['KeyW']);
  assert.deepEqual(h.pressed(), ['GAS']);
  h.pointer('GAS', 'pointercancel', 2);
  assert.deepEqual(h.held(), []);
  assert.deepEqual(h.pressed(), []);
});

test('a release from a pointer that never pressed the button changes nothing', () => {
  const h = harness();
  h.down('GAS', 1);
  for (const type of RELEASE_EVENTS) h.pointer('GAS', type, 9);
  assert.deepEqual(h.held(), ['KeyW']);
});

test('secondary mouse buttons are ignored', () => {
  const h = harness();
  for (const mouseButton of [1, 2]) {
    const event = h.down('GAS', 1, mouseButton);
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(h.held(), []);
  assert.deepEqual(h.pressed(), []);
  assert.deepEqual(h.button('GAS').captured, []);
  h.down('RESET', 1, 2);
  assert.equal(h.input.consumeReset(), false);
});

// --- TouchControls: losing the page ---

test('window blur releases every touch hold and pressed state', () => {
  const h = harness();
  h.down('GAS', 1);
  h.down('GAS', 2);
  h.down('LEFT', 3);
  h.view.dispatchEvent(new Event('blur'));
  assert.deepEqual(h.held(), []);
  assert.deepEqual(h.pressed(), []);

  h.up('GAS', 1); // late events for the dropped pointers are harmless
  h.down('GAS', 4);
  assert.deepEqual(h.held(), ['KeyW']);
  h.up('GAS', 2);
  assert.deepEqual(h.held(), ['KeyW'], 'a stale pointer cannot release a fresh hold');
  h.up('GAS', 4);
  assert.deepEqual(h.held(), []);
});

test('the page becoming hidden releases touch holds; a visible change does not', () => {
  const h = harness();
  h.down('GAS', 1);
  h.down('RIGHT', 2);
  h.page.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(h.held(), ['KeyW', 'KeyD']);

  h.page.visibilityState = 'hidden';
  h.page.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(h.held(), []);
  assert.deepEqual(h.pressed(), []);
});

// --- TouchControls: reset ---

test('RESET requests one reset on the initial press only', () => {
  const h = harness();
  h.down('RESET', 1);
  assert.deepEqual(h.held(), []);
  assert.equal(h.input.consumeReset(), true);
  assert.equal(h.input.consumeReset(), false);

  h.down('RESET', 2); // a second finger while the first is still down
  h.up('RESET', 2);
  h.up('RESET', 1);
  h.pointer('RESET', 'lostpointercapture', 1);
  assert.equal(h.input.consumeReset(), false);

  h.down('RESET', 3);
  assert.equal(h.input.consumeReset(), true);
  assert.equal(h.input.consumeReset(), false);
});

// --- TouchControls: page behaviour and cleanup ---

test('the context menu is suppressed on the controls', () => {
  const h = harness();
  const event = new Event('contextmenu', { cancelable: true });
  h.root.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
});

test('dispose releases holds, removes the controls and detaches the listeners', () => {
  const h = harness();
  h.down('GAS', 1);
  h.touch.dispose();
  assert.deepEqual(h.held(), []);
  assert.equal(h.root.removed, true);

  assert.equal(h.down('BRAKE', 2).defaultPrevented, false);
  h.down('RESET', 3);
  assert.deepEqual(h.held(), []);
  assert.equal(h.input.consumeReset(), false);
  const menu = new Event('contextmenu', { cancelable: true });
  h.root.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, false);
});
