import {readFile} from 'node:fs/promises';
import ts from 'typescript';
async function loadSource(relative){const source=await readFile(new URL(relative,import.meta.url),'utf8');const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;return import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));}
import test from 'node:test';
import assert from 'node:assert/strict';
const { CUE_ATTACK, CUE_RELEASE, RACE_CUES }=await loadSource('../src/audio/raceCue.ts');
test('race cues: finite, quiet, ordered, non-overlapping and under one second', () => {
    for (const [kind, tones] of Object.entries(RACE_CUES)) {
        assert.ok(tones.length >= 1 && tones.length <= 4, kind);
        let end = 0;
        for (const [at, hz, hold, level] of tones) {
            assert.ok([at, hz, hold, level].every(Number.isFinite), kind);
            assert.ok(at >= end - 1e-9, `${kind} overlaps`);
            assert.ok(hz >= 200 && hz <= 2000, kind);
            assert.ok(hold >= CUE_ATTACK, kind);
            assert.ok(level > 0 && level <= 0.3, kind);
            end = at + hold + CUE_RELEASE;
        }
        assert.ok(end <= 1, kind);
    }
    assert.equal(RACE_CUES.countdown[0][1], 700);
    assert.equal(RACE_CUES.go[0][1], 1050);
    assert.ok(RACE_CUES.go[0][2] > RACE_CUES.countdown[0][2]);
    assert.equal(RACE_CUES.improved.length, 2);
});
