import {readFile} from 'node:fs/promises';
import ts from 'typescript';
async function loadSource(relative){const source=await readFile(new URL(relative,import.meta.url),'utf8');const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;return import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));}
import test from 'node:test';
import assert from 'node:assert/strict';
const { RaceSession }=await loadSource('../src/race/RaceSession.ts');
const SQUARE = [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 100, y: 0, z: 100 }, { x: 0, y: 0, z: 100 }];
const SPAWN = { x: 10, y: 0, z: 0 };
function at(station) {
    const s = ((station % 400) + 400) % 400;
    if (s < 100)
        return { x: s, y: 0, z: 0 };
    if (s < 200)
        return { x: 100, y: 0, z: s - 100 };
    if (s < 300)
        return { x: 300 - s, y: 0, z: 100 };
    return { x: 0, y: 0, z: 400 - s };
}
test('race reset: cancel or restart before a drain discards queued countdown events', () => {
    const race = new RaceSession(SQUARE, 8, SPAWN);
    race.start(SPAWN);
    race.update(1.5, SPAWN);
    race.cancel(SPAWN);
    assert.deepEqual(race.drainEvents(), [{ type: 'cancel' }]);
    race.start(SPAWN);
    race.update(1.5, SPAWN);
    race.start(SPAWN);
    assert.deepEqual(race.drainEvents(), [{ type: 'countdown', value: 3 }]);
});
test('race reset: restart before a drain discards a queued finish', () => {
    const race = new RaceSession(SQUARE, 8, SPAWN);
    race.start(SPAWN);
    race.update(3, SPAWN);
    race.drainEvents();
    let station = 10;
    for (let i = 0; i < 5000 && race.state !== 'finished'; i++) {
        station += 20 / 60;
        race.update(1 / 60, at(station));
    }
    assert.equal(race.state, 'finished');
    assert.ok(race.best !== null);
    race.start(SPAWN);
    assert.deepEqual(race.drainEvents(), [{ type: 'countdown', value: 3 }]);
    assert.ok(race.best !== null);
});
