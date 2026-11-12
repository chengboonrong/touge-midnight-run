import {readFile} from 'node:fs/promises';
import ts from 'typescript';
async function loadSource(relative){const source=await readFile(new URL(relative,import.meta.url),'utf8');const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;return import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));}
import test from 'node:test';
import assert from 'node:assert/strict';
const { DriftScore }=await loadSource('../src/race/DriftScore.ts');
function run(d, seconds, hz, forward, side, wheels = 4, slip = 4) {
    const steps = Math.round(seconds * hz);
    for (let i = 0; i < steps; i++)
        d.update(1 / hz, forward, side, wheels, slip);
}
test('drift: constant dynamics score the same at 30/60/120 Hz', () => {
    const expected = Math.hypot(16, 6) * Math.atan2(6, 16) * 8 * 2;
    for (const hz of [30, 60, 120]) {
        const d = new DriftScore();
        run(d, 2, hz, 16, 6);
        assert.ok(Math.abs(d.chain - expected) < 1e-6, `hz ${hz}: ${d.chain}`);
        assert.equal(d.active, true);
        assert.equal(d.pending, true);
        assert.equal(d.total, 0);
    }
});
test('drift: angle is signed', () => {
    const d = new DriftScore();
    d.update(1 / 60, 16, 6, 4, 4);
    assert.ok(Math.abs(d.angle - Math.atan2(6, 16)) < 1e-12);
    d.update(1 / 60, 16, -6, 4, 4);
    assert.ok(Math.abs(d.angle + Math.atan2(6, 16)) < 1e-12);
});
test('drift: no points at rest, in reverse, airborne, spinning or with bad input', () => {
    const cases = [
        [0, 0, 4, 0], [-16, 6, 4, 4], [16, 6, 2, 4], [1, 12, 4, 6], [16, 6, 4, 0.5], [5, 2, 4, 4], [16, 1, 4, 4],
        [NaN, 6, 4, 4], [16, Infinity, 4, 4], [16, 6, NaN, 4], [16, 6, 4, NaN],
    ];
    for (const [forward, side, wheels, slip] of cases) {
        const d = new DriftScore();
        run(d, 1, 60, forward, side, wheels, slip);
        assert.equal(d.chain, 0, `${forward},${side},${wheels},${slip}`);
        assert.equal(d.total, 0);
        assert.equal(d.active, false);
        assert.ok(Number.isFinite(d.angle));
    }
    const d = new DriftScore();
    for (const dt of [NaN, 0, -1, Infinity])
        d.update(dt, 16, 6, 4, 4);
    assert.equal(d.chain, 0);
    const strict = new DriftScore({ minSpeed: 30 });
    run(strict, 1, 60, 16, 6);
    assert.equal(strict.chain, 0);
});
test('drift: grace links a switchback, then banks the chain once', () => {
    const d = new DriftScore();
    run(d, 0.5, 60, 16, 6);
    const first = d.chain;
    assert.ok(first > 0);
    run(d, 0.2, 60, 16, 0);
    assert.equal(d.active, false);
    assert.equal(d.pending, true);
    assert.equal(d.chain, first);
    assert.equal(d.total, 0);
    run(d, 0.5, 60, 16, -6);
    const linked = d.chain;
    assert.ok(linked > first);
    assert.equal(d.total, 0);
    run(d, 0.5, 60, 16, 0);
    assert.equal(d.total, linked);
    assert.equal(d.chain, 0);
    assert.equal(d.pending, false);
});
test('drift: stop banks once without new points, reset clears all', () => {
    const d = new DriftScore();
    run(d, 0.5, 60, 16, 6);
    const chain = d.chain;
    d.stop();
    assert.equal(d.total, chain);
    assert.equal(d.chain, 0);
    assert.equal(d.active, false);
    d.stop();
    assert.equal(d.total, chain);
    d.reset();
    assert.equal(d.total, 0);
    assert.equal(d.chain, 0);
    assert.equal(d.angle, 0);
    assert.equal(d.pending, false);
});
