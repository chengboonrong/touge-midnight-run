// Pure manga feedback state. Transpiles the real MangaFeedback.ts; no DOM is constructed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../src/render/MangaFeedback.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {MangaState,streakOpacity,MANGA}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const run=(state,hz,seconds,speed=30)=>{const n=Math.round(seconds*hz);for(let i=0;i<n;i++)state.update(1/hz,speed);};

test('speed mapping is finite, monotonic and bounded',()=>{
 assert.equal(streakOpacity(0),0);assert.equal(streakOpacity(20),0);assert.equal(streakOpacity(-50),0);
 assert.ok(Math.abs(streakOpacity(36)-0.12)<1e-12);assert.ok(streakOpacity(1e9)<=0.12);
 for(const bad of [NaN,Infinity,-Infinity])assert.equal(streakOpacity(bad),0);
 let last=0;for(let v=0;v<=80;v+=0.5){const o=streakOpacity(v);assert.ok(Number.isFinite(o)&&o>=last&&o<=0.12+1e-12);last=o;}
});

test('without a real trigger nothing ever pulses',()=>{
 const s=new MangaState();run(s,60,5,50);
 assert.equal(s.impactAlpha,0);assert.equal(s.nearAlpha,0);assert.ok(s.streak>0&&s.streak<=0.12+1e-12);
});

test('decay depends on elapsed time only at 30, 60 and 144 Hz',()=>{
 for(const hz of [30,60,144]){
  const s=new MangaState();assert.equal(s.impact(1),true);assert.equal(s.nearMiss(),true);
  run(s,hz,1/6);
  assert.ok(Math.abs(s.impactAlpha-MANGA.impactMax*Math.exp(-(1/6)/MANGA.impactDecay))<1e-9,'impact '+hz);
  assert.ok(Math.abs(s.nearAlpha-1)<1e-9,'near '+hz);
  run(s,hz,1/6);
  assert.ok(Math.abs(s.impactAlpha-MANGA.impactMax*Math.exp(-(1/3)/MANGA.impactDecay))<1e-9,'impact late '+hz);
  assert.ok(s.nearAlpha<1e-6,'near gone '+hz);
 }
});

test('impact needs strength above 0.55, is capped at 0.12 and fires at most 2 Hz',()=>{
 const s=new MangaState();
 assert.equal(s.impact(0.5),false);assert.equal(s.impact(0.55),false);assert.equal(s.impact(NaN),false);assert.equal(s.impactAlpha,0);
 assert.equal(s.impact(5),true);assert.ok(s.impactAlpha>0&&s.impactAlpha<=0.12+1e-12);
 assert.equal(s.impact(1),false);
 run(s,60,0.4);assert.equal(s.impact(1),false);
 run(s,60,0.2);assert.equal(s.impact(1),true);
});

test('bad frame times and speeds stay finite and bounded',()=>{
 const s=new MangaState();s.impact(1);s.nearMiss();
 for(const [dt,v] of [[NaN,NaN],[-1,Infinity],[Infinity,-Infinity],[1e9,30],[0,50]]){
  s.update(dt,v);
  for(const x of [s.streak,s.impactAlpha,s.nearAlpha])assert.ok(Number.isFinite(x)&&x>=0&&x<=1);
  assert.ok(s.streak<=0.12+1e-12&&s.impactAlpha<=0.12+1e-12);
 }
});

test('low quality disables streaks and impact strokes but keeps the near-miss word',()=>{
 const s=new MangaState();s.setLow(true);
 assert.equal(s.impact(1),false);s.update(1/60,50);
 assert.equal(s.streak,0);assert.equal(s.impactAlpha,0);
 assert.equal(s.nearMiss(),true);s.update(1/60,50);assert.ok(s.nearAlpha>0);
});

test('reduced motion disables streaks and every new pulse',()=>{
 const s=new MangaState();s.impact(1);s.nearMiss();s.setReduced(true);
 assert.equal(s.impactAlpha,0);assert.equal(s.nearAlpha,0);
 assert.equal(s.impact(1),false);assert.equal(s.nearMiss(),false);s.update(1/60,50);
 assert.equal(s.streak,0);assert.equal(s.impactAlpha,0);assert.equal(s.nearAlpha,0);
});

test('reset clears pulses, streaks and the cooldown',()=>{
 const s=new MangaState();s.impact(1);s.nearMiss();s.update(1/60,50);s.reset();
 assert.equal(s.streak,0);assert.equal(s.impactAlpha,0);assert.equal(s.nearAlpha,0);
 assert.equal(s.impact(1),true);
});

test('switching to low or reduced motion immediately hides existing streaks while paused',()=>{
 for(const mode of ['low','reduced']){
  const s=new MangaState();s.update(1/60,36);assert.ok(s.streak>0);
  if(mode==='low')s.setLow(true);else s.setReduced(true);
  assert.equal(s.streak,0,'no further update is required to apply the preference');
 }
});
