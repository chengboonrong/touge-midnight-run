// Pure audio mapping tests: transpile src/audio/audioMath.ts standalone and import it via a data URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/audio/audioMath.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const m = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

const unit = value => Number.isFinite(value) && value >= 0 && value <= 1;
const sum = values => values.reduce((a, b) => a + b, 0);

test('idle, redline and bad rpm give finite bounded engine values', () => {
  for (const rpm of [900, 4000, 7500, 0, -5, 1e9, NaN, Infinity]) {
    const frac = m.rpmFraction(rpm, 900, 7500);
    assert.ok(unit(frac), `fraction ${rpm}`);
    const frequency = m.engineFrequency(rpm);
    assert.ok(Number.isFinite(frequency) && frequency >= 10 && frequency <= 400, `frequency ${rpm}`);
    const layers = m.engineLayers(frac, [0, 0, 0, 0]);
    assert.equal(layers.length, 4);
    for (const layer of layers) assert.ok(unit(layer));
    assert.ok(Math.abs(sum(layers) - 1) < 1e-9, 'layers crossfade at constant sum');
    for (const throttle of [0, 1, NaN, 9]) assert.ok(unit(m.engineLevel(frac, throttle, false, true)));
  }
  assert.equal(m.rpmFraction(900, 900, 7500), 0);
  assert.equal(m.rpmFraction(7500, 900, 7500), 1);
  assert.equal(m.rpmFraction(3000, NaN, 7500), 0);
  assert.equal(m.rpmFraction(3000, 7500, 900), 0);
  assert.deepEqual(m.engineLayers(0, [0, 0, 0, 0]), [1, 0, 0, 0]);
  assert.deepEqual(m.engineLayers(1, [0, 0, 0, 0]), [0, 0, 0, 1]);
});

test('a gear shift does not spike the engine level', () => {
  const before = m.rpmFraction(7000, 900, 7500);
  const after = m.rpmFraction(4500, 900, 7500);
  const cruising = m.engineLevel(before, 1, false, false);
  const shifting = m.engineLevel(after, 1, true, false);
  assert.ok(shifting <= cruising);
  assert.ok(shifting <= m.engineLevel(after, 1, false, false));
  assert.ok(Math.abs(sum(m.engineLayers(before, [0, 0, 0, 0])) - 1) < 1e-9);
});

test('tire noise needs a loaded, grounded, sliding wheel', () => {
  const airborne = { grounded: false, load: 0, slipSpeed: 30 };
  assert.equal(m.tireLevel([airborne, airborne, airborne, airborne]), 0);
  assert.equal(m.tireLevel([{ grounded: true, load: 0, slipSpeed: 30 }]), 0);
  assert.equal(m.tireLevel([{ grounded: true, load: 3000, slipSpeed: 0.3 }]), 0);
  assert.equal(m.tireLevel([{ grounded: true, load: NaN, slipSpeed: NaN }]), 0);
  assert.equal(m.tireLevel([]), 0);
  const sliding = m.tireLevel([airborne, { grounded: true, load: 3000, slipSpeed: -8 }]);
  assert.ok(sliding > 0.5 && sliding <= 1);
  assert.ok(m.tireLevel([{ grounded: true, load: 1e9, slipSpeed: 1e9 }]) <= 1);
});

test('road and wind are silent at rest and bounded at speed', () => {
  assert.equal(m.roadLevel(0, 1), 0);
  assert.equal(m.windLevel(0), 0);
  assert.equal(m.roadLevel(30, 0), 0);
  assert.equal(m.roadLevel(NaN, 1), 0);
  assert.equal(m.windLevel(Infinity), 0);
  assert.ok(unit(m.roadLevel(1000, 1)) && unit(m.windLevel(1000)));
  assert.ok(m.roadLevel(20, 1) > 0 && m.windLevel(20) > 0);
  assert.equal(m.groundedFraction([]), 0);
  assert.equal(m.groundedFraction([{ grounded: true }, { grounded: false }]), 0.5);
});

test('malformed or nonfinite preferences fall back safely', () => {
  const fallback = { volume: m.DEFAULT_VOLUME, muted: false };
  for (const raw of [null, undefined, 42, 'garbage', '{', '[]', '{"volume":1e999}', '{"volume":"loud","muted":"yes"}', { volume: NaN }]) {
    assert.deepEqual(m.parseAudioPrefs(raw), fallback);
  }
  assert.deepEqual(m.parseAudioPrefs('{"volume":5,"muted":true}'), { volume: 1, muted: true });
  assert.deepEqual(m.parseAudioPrefs('{"volume":-1}'), { volume: 0, muted: false });
  assert.equal(m.masterLevel({ volume: 1, muted: true }), 0);
  assert.ok(m.masterLevel({ volume: 1, muted: false }) < 1);
  assert.ok(unit(m.masterLevel({ volume: NaN, muted: false })));
});

test('scrape level is clamped to 0..1 and silent for anything nonfinite', () => {
  assert.equal(m.scrapeLevel(0), 0);
  assert.equal(m.scrapeLevel(0.4), 0.4);
  assert.equal(m.scrapeLevel(7), 1);
  assert.equal(m.scrapeLevel(-3), 0);
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '1']) assert.equal(m.scrapeLevel(bad), 0);
});
