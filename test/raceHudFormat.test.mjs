import {readFile} from 'node:fs/promises';
import ts from 'typescript';
async function loadSource(relative){const source=await readFile(new URL(relative,import.meta.url),'utf8');const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;return import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));}
import test from 'node:test';
import assert from 'node:assert/strict';
const { formatRaceTime, formatSplit }=await loadSource('../src/ui/RaceHud.ts');
test('formatRaceTime: m:ss.cc, truncated, safe for bad input', () => {
    assert.equal(formatRaceTime(0), '0:00.00');
    assert.equal(formatRaceTime(59.999), '0:59.99');
    assert.equal(formatRaceTime(65.432), '1:05.43');
    assert.equal(formatRaceTime(83.5), '1:23.50');
    assert.equal(formatRaceTime(NaN), '-:--.--');
    assert.equal(formatRaceTime(-1), '-:--.--');
});
test('formatSplit: signed seconds, empty without a reference', () => {
    assert.equal(formatSplit(-0.456), '-0.46');
    assert.equal(formatSplit(1.2), '+1.20');
    assert.equal(formatSplit(-0.001), '+0.00');
    assert.equal(formatSplit(null), '');
    assert.equal(formatSplit(NaN), '');
});
