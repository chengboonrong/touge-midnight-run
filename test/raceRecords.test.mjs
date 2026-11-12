// Best-lap persistence. Transpiles the real RaceSession.ts and RaceRecords.ts to CommonJS; storage is injected.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const load = (name, req) => {
  const source = readFileSync(new URL('../src/race/' + name + '.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', js)(module, module.exports, req);
  return module.exports;
};
const session = load('RaceSession', () => { throw new Error('RaceSession has no imports'); });
const { courseKey, loadBestLap, saveBestLap } = load('RaceRecords', id => { assert.equal(id, './RaceSession'); return session; });

const KEY = courseKey('kurotake', 2345.6, 180);
const lap = time => ({ time, splits: [time * 0.25, time * 0.5, time * 0.75] });
const mem = (init = {}) => {
  const map = new Map(Object.entries(init));
  return { map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); } };
};
const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };

test('the key is versioned and scoped to the course shape', () => {
  assert.match(KEY, /^touge\.best\.kurotake\.v1\./);
  assert.notEqual(KEY, courseKey('kurotake', 2345.6, 181));
  assert.notEqual(KEY, courseKey('kurotake', 2400, 180));
  assert.notEqual(KEY, courseKey('other', 2345.6, 180));
});

test('missing, bad JSON, corrupt data and throwing or absent storage all load as null', () => {
  assert.equal(loadBestLap(mem(), KEY), null);
  assert.equal(loadBestLap(mem({ [KEY]: '{oops' }), KEY), null);
  assert.equal(loadBestLap(mem({ [KEY]: 'null' }), KEY), null);
  assert.equal(loadBestLap(mem({ [KEY]: JSON.stringify({ time: 60, splits: [30, 20, 50] }) }), KEY), null);
  assert.equal(loadBestLap(mem({ [KEY]: JSON.stringify({ time: -1, splits: [1, 2, 3] }) }), KEY), null);
  assert.equal(loadBestLap(broken, KEY), null);
  assert.equal(loadBestLap(null, KEY), null);
});

test('a saved lap round-trips and touches no other key', () => {
  const store = mem({ 'touge.audio': '{"volume":0.5}', 'touge.quality': 'low' });
  assert.equal(saveBestLap(store, KEY, lap(80)), true);
  assert.deepEqual(loadBestLap(store, KEY), lap(80));
  assert.equal(store.map.size, 3);
  assert.equal(store.map.get('touge.audio'), '{"volume":0.5}');
  assert.equal(store.map.get('touge.quality'), 'low');
  assert.equal(loadBestLap(store, courseKey('kurotake', 2345.6, 181)), null);
});

test('a faster or equal record stored by another tab is never overwritten', () => {
  const store = mem({ [KEY]: JSON.stringify(lap(70)) });
  assert.equal(saveBestLap(store, KEY, lap(75)), false);
  assert.equal(saveBestLap(store, KEY, lap(70)), false);
  assert.deepEqual(loadBestLap(store, KEY), lap(70));
  assert.equal(saveBestLap(store, KEY, lap(65)), true);
  assert.deepEqual(loadBestLap(store, KEY), lap(65));
});

test('corrupt stored data is replaced; invalid laps are not written', () => {
  const store = mem({ [KEY]: '{oops' });
  assert.equal(saveBestLap(store, KEY, { time: 50, splits: [1, 2] }), false);
  assert.equal(saveBestLap(store, KEY, null), false);
  assert.equal(store.map.get(KEY), '{oops');
  assert.equal(saveBestLap(store, KEY, lap(90)), true);
  assert.deepEqual(loadBestLap(store, KEY), lap(90));
});

test('storage exceptions and absent storage never throw', () => {
  assert.equal(saveBestLap(broken, KEY, lap(80)), false);
  assert.equal(saveBestLap(null, KEY, lap(80)), false);
  const readOnly = { getItem: () => null, setItem() { throw new Error('quota'); } };
  assert.equal(saveBestLap(readOnly, KEY, lap(80)), false);
});
