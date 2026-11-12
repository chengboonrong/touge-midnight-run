// MusicManager lifecycle with deferred play() promises. Transpiles the real MusicManager.ts and musicState.ts to CommonJS;
// only the media/context methods the manager uses are faked. Fake gain ramps land instantly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const load = (name, req) => {
  const source = readFileSync(new URL('../src/audio/' + name + '.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', js)(module, module.exports, req);
  return module.exports;
};
const musicState = load('musicState', () => { throw new Error('musicState has no imports'); });
const { MusicManager } = load('MusicManager', id => { assert.equal(id, './musicState'); return musicState; });

let els = [];
globalThis.Audio = class {
  constructor() { this.paused = true; this.src = ''; this.plays = []; els.push(this); }
  play() { this.paused = false; return new Promise((resolve, reject) => this.plays.push({ resolve, reject })); }
  pause() { this.paused = true; }
  removeAttribute() { this.src = ''; }
  load() {}
};
const param = () => ({ value: 0, cancelScheduledValues() {}, setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime(v) { this.value = v; }, setTargetAtTime(v) { this.value = v; } });
const rig = (maxGains = 2) => {
  els = [];
  const nodes = [];
  const gains = [];
  const node = () => { const n = { on: true, connect() {}, disconnect() { this.on = false; } }; nodes.push(n); return n; };
  const ctx = {
    currentTime: 0,
    createMediaElementSource: () => node(),
    createGain() { if (gains.length >= maxGains) throw new Error('no gain'); const g = Object.assign(node(), { gain: param() }); gains.push(g); return g; },
  };
  return { ctx, nodes, gains, els, levels: () => gains.map(g => g.gain.value) };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
/** A manager whose race track on slot 0 has really started. */
const started = async (r, level = 0.5) => {
  const mm = new MusicManager(r.ctx, {}, 'race', level);
  mm.setActive(true);
  assert.equal(r.els[0].plays.length, 1, 'first play() is attempted synchronously');
  assert.deepEqual(r.levels(), [0, 0], 'nothing fades in before play() settles');
  r.els[0].plays[0].resolve();
  await tick();
  return mm;
};

test('a delayed incoming track keeps the old one at level until it really starts', async () => {
  const r = rig();
  const mm = await started(r);
  assert.deepEqual(r.levels(), [0.5, 0]);
  mm.setState('results');
  assert.match(r.els[1].src, /results\.mp3$/);
  assert.equal(r.els[1].plays.length, 1);
  assert.deepEqual(r.levels(), [0.5, 0]);
  assert.equal(r.els[0].paused, false);
  r.els[1].plays[0].resolve();
  await tick();
  assert.deepEqual(r.levels(), [0, 0.5]);
  mm.dispose();
});

test('a load that settles after pause neither plays nor unsilences; stale refusals are ignored', async () => {
  const r = rig();
  const mm = await started(r);
  mm.setState('results');
  mm.setActive(false);
  r.els[1].plays[0].resolve();
  await tick();
  assert.deepEqual(r.levels(), [0, 0]);
  assert.deepEqual(r.els.map(el => el.paused), [true, true]);
  mm.setActive(true);
  assert.equal(r.els[1].plays.length, 2);
  mm.setActive(false);
  mm.setActive(true);
  assert.equal(r.els[1].plays.length, 3);
  r.els[1].plays[1].reject({ name: 'NotAllowedError' });
  await tick();
  mm.setActive(true);
  assert.equal(r.els[1].plays.length, 3, 'a stale refusal must not mark the current attempt blocked');
  r.els[1].plays[2].resolve();
  await tick();
  assert.deepEqual(r.levels(), [0, 0.5]);
  mm.dispose();
});

test('switching back while a load is pending cannot stop the active track or leave the unused one playing', async () => {
  const r = rig();
  const mm = await started(r);
  mm.setState('results');
  mm.setState('race');
  assert.match(r.els[0].src, /race\.mp3$/);
  assert.deepEqual(r.levels(), [0.5, 0]);
  r.els[1].plays[0].resolve();
  await tick();
  assert.deepEqual(r.els.map(el => el.paused), [false, true]);
  assert.deepEqual(r.levels(), [0.5, 0]);
  r.els[0].plays[1].resolve();
  await tick();
  assert.deepEqual(r.els.map(el => el.paused), [false, true]);
  assert.deepEqual(r.levels(), [0.5, 0]);
  mm.dispose();
});

test('a third track requested while one is pending loads into the idle slot, not the audible one', async () => {
  const r = rig();
  const mm = await started(r);
  mm.setState('results');
  mm.setState('menu');
  assert.match(r.els[0].src, /race\.mp3$/);
  assert.match(r.els[1].src, /menu\.mp3$/);
  assert.deepEqual(r.levels(), [0.5, 0]);
  mm.dispose();
});

test('mute silences both slots mid fade; unmute raises only the audible slot', async () => {
  const r = rig();
  const mm = await started(r);
  mm.setState('results');
  r.els[1].plays[0].resolve();
  await tick();
  r.gains[0].gain.value = 0.3; // outgoing slot part way through its fade
  mm.setLevel(0);
  assert.deepEqual(r.levels(), [0, 0]);
  mm.setLevel(0.4);
  assert.deepEqual(r.levels(), [0, 0.4]);
  mm.setState('race'); // pending on slot 0
  mm.setLevel(0);
  mm.setLevel(0.4);
  assert.deepEqual(r.levels(), [0, 0.4], 'a pending slot is never raised by unmute');
  mm.setLevel(0);
  r.els[0].plays[1].resolve();
  await tick();
  assert.deepEqual(r.levels(), [0, 0], 'a delayed start stays silent while muted');
  mm.dispose();
});

test('a constructor that fails part way disposes what it created', () => {
  const r = rig(1);
  assert.throws(() => new MusicManager(r.ctx, {}, 'race', 0.5), /no gain/);
  assert.equal(r.nodes.length, 3);
  assert.ok(r.nodes.every(n => n.on === false));
  assert.equal(r.els.length, 2);
  assert.ok(r.els.every(el => el.paused && el.src === ''));
});
