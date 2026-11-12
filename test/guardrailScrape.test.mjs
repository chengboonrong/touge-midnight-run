// Guardrail scrape detector against the real Rapier 0.14 WASM: real solver contacts and impulses, no mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const source=await readFile(new URL('../src/physics/GuardrailScrape.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {GuardrailScrape}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const HALF=0.96,DT=1/60;
// Chassis box: half extents (HALF, 0.3, 2) centred at y 0.6. `push` is the direction that holds it against the wall.
const WALLS={
 side:{half:[0.2,2,60],at:g=>[HALF+g+0.2,2,-40],push:[1,0,0]},
 front:{half:[4,2,0.2],at:g=>[0,2,-(2+g+0.2)],push:[0,0,-1]},
 floor:{half:[200,0.5,200],at:g=>[0,0.3-g-0.5,0],push:[0,-1,0]},
};

/** Gravity off and rotations locked: the fixture holds the box against a frictionless wall with a small real impulse every step. */
function scene(t,{wall='side',gap=0.005,vz=-10,mass=1200,tag=true}={}){
 const world=new RAPIER.World({x:0,y:0,z:0});world.timestep=DT;t.after(()=>world.free());
 const rails=new Set();let push=[0,0,0];
 if(wall){
  const w=WALLS[wall];
  const c=world.createCollider(RAPIER.ColliderDesc.cuboid(...w.half).setTranslation(...w.at(gap)).setFriction(0));
  if(tag)rails.add(c.handle);
  push=w.push;
 }
 const body=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0,0.6,0).setCanSleep(false).lockRotations());
 const collider=world.createCollider(RAPIER.ColliderDesc.cuboid(HALF,0.3,2).setMass(mass).setFriction(0),body);
 body.setLinvel({x:0,y:0,z:vz},true);
 return {world,body,mass,push,rails,detector:new GuardrailScrape(world,body,collider,rails)};
}
/** accel is the holding push in m/s^2 (0 = no push). Every level must be finite and within 0..1. */
function drive(s,steps,accel=8){
 let max=0,last=0;const j=s.mass*accel*DT;
 for(let i=0;i<steps;i++){
  if(accel>0)s.body.applyImpulse({x:s.push[0]*j,y:s.push[1]*j,z:s.push[2]*j},true);
  s.world.step();
  last=s.detector.update(DT);
  assert.ok(Number.isFinite(last)&&last>=0&&last<=1,'level '+last);
  assert.equal(s.detector.level,last);
  if(last>max)max=last;
 }
 return {max,last};
}

test('a tagged side contact sliding along the wall gives a bounded positive level',t=>{
 const r=drive(scene(t),60);
 t.diagnostic(JSON.stringify(r));
 assert.ok(r.last>0.2&&r.last<=1);
});

test('no contact at all is silent',t=>{
 assert.equal(drive(scene(t,{wall:null}),30,0).max,0);
});

test('a tagged large trimesh that is only a broad-phase candidate is silent',t=>{
 const s=scene(t,{wall:null});
 const vertices=new Float32Array([
  -20,0,20,-20,2,20,-20,2,-90,-20,0,-90,
  1.26,0,20,1.26,2,20,1.26,2,-90,1.26,0,-90,
 ]);
 const mesh=s.world.createCollider(RAPIER.ColliderDesc.trimesh(vertices,new Uint32Array([0,1,2,0,2,3,4,5,6,4,6,7])));
 s.rails.add(mesh.handle);
 assert.equal(drive(s,120,0).max,0);
});

test('a head-on hit with no sliding is silent',t=>{
 assert.equal(drive(scene(t,{wall:'front',gap:0.5}),60).max,0);
});

test('sliding slower than 2 m/s is silent',t=>{
 assert.equal(drive(scene(t,{vz:-1}),60).max,0);
});

test('a tagged collider with a road-like vertical normal is silent',t=>{
 assert.equal(drive(scene(t,{wall:'floor'}),60).max,0);
});

test('the same sliding contact on an untagged wall is silent',t=>{
 assert.equal(drive(scene(t,{tag:false}),60).max,0);
});

test('the detector does not change the body',t=>{
 const s=scene(t);drive(s,30);
 s.body.applyImpulse({x:s.mass*8*DT,y:0,z:0},true);
 s.world.step();
 const v0=s.body.linvel(),w0=s.body.angvel(),p0=s.body.translation();
 assert.ok(s.detector.update(DT)>0);
 assert.deepEqual(s.body.linvel(),v0);
 assert.deepEqual(s.body.angvel(),w0);
 assert.deepEqual(s.body.translation(),p0);
});

test('reset, an invalid dt and the end of contact all give zero at once',t=>{
 const s=scene(t);
 assert.ok(drive(s,60).last>0);
 s.detector.reset();
 assert.equal(s.detector.level,0);
 assert.ok(drive(s,5).last>0);
 for(const dt of [NaN,Infinity,0,-1]){
  assert.ok(drive(s,1).last>0);
  assert.equal(s.detector.update(dt),0);
  assert.equal(s.detector.level,0);
 }
 assert.ok(drive(s,5).last>0);
 s.body.setTranslation({x:-5,y:0.6,z:s.body.translation().z},true);
 assert.equal(drive(s,1,0).last,0);
 assert.equal(drive(s,5,0).max,0);
});

test('pressure is normalised by the real body mass: light and heavy cars pushed at the same acceleration agree',t=>{
 const light=drive(scene(t,{mass:600}),60,3).last,heavy=drive(scene(t,{mass:2400}),60,3).last;
 t.diagnostic(JSON.stringify({light,heavy}));
 assert.ok(light>0&&light<=1&&heavy>0&&heavy<=1);
 assert.ok(Math.abs(light-heavy)<0.2);
});
