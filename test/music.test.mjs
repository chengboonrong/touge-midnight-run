// Pure music rules: preferences, states and two-slot crossfade planning. Transpiles src/audio/musicState.ts standalone.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/audio/musicState.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

test('four music states, free practice defaults to race', () => {
  assert.deepEqual([...m.MUSIC_STATES], ['menu', 'prepare', 'race', 'results']);
  for (const state of m.MUSIC_STATES) assert.equal(m.parseMusicState(state), state);
  for (const bad of [undefined, null, '', 'RACE', 3, {}]) assert.equal(m.parseMusicState(bad), 'race');
});

test('every state has its own local mp3', () => {
  const urls = m.MUSIC_STATES.map(state => m.MUSIC_TRACKS[state]);
  assert.equal(new Set(urls).size, 4);
  for (const url of urls) assert.match(url, /^\/assets\/audio\/[a-z]+\.mp3$/);
});

test('music volume is bounded and defaults to 0.25', () => {
  assert.equal(m.DEFAULT_MUSIC_VOLUME, 0.25);
  assert.equal(m.parseMusicVolume(0.5), 0.5);
  assert.equal(m.parseMusicVolume(7), 1);
  assert.equal(m.parseMusicVolume(-1), 0);
  for (const bad of [NaN, Infinity, '0.5', null, undefined]) assert.equal(m.parseMusicVolume(bad), 0.25);
});

test('old SFX-only preferences migrate with the default music volume', () => {
  assert.equal(m.parseMusicVolumePref('{"volume":0.4,"muted":true}'), 0.25);
  assert.equal(m.parseMusicVolumePref('{"volume":0.4,"muted":false,"musicVolume":0.6}'), 0.6);
  assert.equal(m.parseMusicVolumePref('{"musicVolume":"loud"}'), 0.25);
  assert.equal(m.parseMusicVolumePref('not json'), 0.25);
  assert.equal(m.parseMusicVolumePref(null), 0.25);
});

test('mute all silences music; music keeps headroom below the effects', () => {
  assert.equal(m.musicLevel(1, true), 0);
  assert.equal(m.musicLevel(0, false), 0);
  assert.ok(m.musicLevel(1, false) <= 0.6);
  assert.ok(Math.abs(m.musicLevel(0.25, false) - 0.25 * m.MUSIC_HEADROOM) < 1e-12);
  assert.equal(m.musicLevel(NaN, false), m.musicLevel(0.25, false));
  assert.equal(m.CROSSFADE_SECONDS, 0.8);
});

test('planner alternates two slots and reuses a slot that still holds the track', () => {
  const p = new m.MusicPlanner();
  assert.equal(p.current(), null);
  const a = p.request('race');
  assert.deepEqual({ fadeIn: a.fadeIn, fadeOut: a.fadeOut, reuse: a.reuse, state: a.state }, { fadeIn: 0, fadeOut: -1, reuse: false, state: 'race' });
  assert.equal(p.request('race'), null);
  const b = p.request('results');
  assert.deepEqual([b.fadeIn, b.fadeOut, b.reuse], [1, 0, false]);
  const c = p.request('race');
  assert.deepEqual([c.fadeIn, c.fadeOut, c.reuse], [0, 1, true]);
  const d = p.request('menu');
  assert.deepEqual([d.fadeIn, d.fadeOut, d.reuse], [1, 0, false]);
  assert.deepEqual(p.current(), { slot: 1, state: 'menu' });
  for (const state of ['prepare', 'race', 'menu', 'results', 'prepare']) {
    const change = p.request(state);
    assert.ok(change.fadeIn === 0 || change.fadeIn === 1);
    assert.equal(change.fadeOut, 1 - change.fadeIn);
  }
});

test('a pending stop is honoured only while it is the latest plan', () => {
  const p = new m.MusicPlanner();
  p.request('menu');
  const b = p.request('race');
  assert.equal(p.shouldStop(b.fadeOut, b.token), true);
  assert.equal(p.shouldStop(b.fadeIn, b.token), false);
  const c = p.request('menu');
  assert.equal(p.shouldStop(b.fadeOut, b.token), false);
  assert.equal(p.shouldStop(c.fadeOut, c.token), true);
  p.cancel();
  assert.equal(p.shouldStop(c.fadeOut, c.token), false);
  assert.deepEqual(p.current(), { slot: 0, state: 'menu' });
  assert.equal(p.request('menu'), null);
});
