import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const base=new URL('../public/assets/audio/',import.meta.url);
test('four distinct playable-score MP3 assets match the original-score manifest',async()=>{
 const manifest=JSON.parse(await readFile(new URL('manifest.json',base),'utf8'));
 assert.equal(manifest.license,'CC0-1.0');assert.equal(manifest.sampleRate,44100);
 assert.ok(manifest.bpm>=145&&manifest.bpm<=165);assert.equal(manifest.tracks.length,4);
 assert.deepEqual(manifest.tracks.map(t=>t.state).sort(),['menu','prepare','race','results']);
 const hashes=new Set();
 for(const track of manifest.tracks){
  assert.match(track.file,/^[a-z]+\.mp3$/);
  const bytes=await readFile(new URL(track.file,base));assert.ok(bytes.length>10000);
  assert.ok(bytes.subarray(0,3).toString()==='ID3'||(bytes[0]===255&&(bytes[1]&224)===224),'MP3 signature');
  assert.equal(track.loopStartSample,0);assert.ok(Math.abs(track.loopEndSample/manifest.sampleRate-track.bars*4*60/manifest.bpm)<1/manifest.sampleRate);
  assert.ok(Math.abs(track.durationSeconds-track.loopEndSample/manifest.sampleRate)<0.001);
  hashes.add(createHash('sha256').update(bytes).digest('hex'));
 }
 assert.equal(hashes.size,4,'four independently arranged tracks');
});
