// Near-miss detector against the real Rapier 0.14 WASM: real ground, real walls, a real moving chassis box.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const source=await readFile(new URL('../src/physics/NearMiss.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {NearMiss}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const HALF=0.96,DT=1/60;

/** walls: [side, zStart, zEnd, gap beyond the chassis side]. The chassis drives towards -Z at `speed`; gravity is off so it keeps its height. */
function scene(t,walls,speed=25){
 const world=new RAPIER.World({x:0,y:0,z:0});world.timestep=DT;t.after(()=>world.free());
 world.createCollider(RAPIER.ColliderDesc.cuboid(200,0.5,200).setTranslation(0,-0.5,0));
 for(const [side,z0,z1,gap=0.3] of walls)world.createCollider(RAPIER.ColliderDesc.cuboid(0.2,2,(z0-z1)/2).setTranslation(side*(HALF+gap+0.2),2,(z0+z1)/2).setFriction(0));
 const body=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0,0.6,0).setCanSleep(false));
 const collider=world.createCollider(RAPIER.ColliderDesc.cuboid(HALF,0.3,2).setMass(1200).setFriction(0),body);
 body.setLinvel({x:0,y:0,z:-speed},true);
 return {world,body,detector:new NearMiss(RAPIER,world,body,collider,HALF)};
}
function drive(s,steps,wheels=4){let n=0;for(let i=0;i<steps;i++){s.world.step();if(s.detector.update(DT,wheels))n++;}return n;}

test('far then near gives exactly one event for a continuous pass, mirrored left and right',t=>{
 assert.equal(drive(scene(t,[[1,-30,-50]]),240),1);
 assert.equal(drive(scene(t,[[-1,-30,-50]]),240),1);
});

test('no event beyond 0.45 m, below 22 m/s or with fewer than three loaded wheels',t=>{
 assert.equal(drive(scene(t,[[1,-30,-50,0.6]]),240),0);
 assert.equal(drive(scene(t,[[1,-30,-50]],15),300),0);
 assert.equal(drive(scene(t,[[1,-30,-50]]),240,2),0);
});

test('an actual contact pair suppresses the event',t=>{
 const clear=scene(t,[[1,-30,-90]]);drive(clear,30);
 clear.body.setTranslation({x:0,y:0.6,z:-40},true);
 assert.equal(drive(clear,60),1,'control: armed, close, not touching');
 const touch=scene(t,[[1,-30,-90]]);drive(touch,30);
 touch.body.setTranslation({x:0.32,y:0.6,z:-40},true);
 assert.equal(drive(touch,60),0);
});

test('starting beside a wall or accelerating beside it cannot farm an event',t=>{
 assert.equal(drive(scene(t,[[1,10,-90]]),120),0);
 const slow=scene(t,[[1,10,-90]],10);
 assert.equal(drive(slow,30),0);
 slow.body.setLinvel({x:0,y:0,z:-25},true);
 assert.equal(drive(slow,90),0);
});

test('a second wall inside the 1.5 s cooldown is silent; after far-then-near and the cooldown it counts again',t=>{
 assert.equal(drive(scene(t,[[1,-10,-20],[1,-30,-40]]),240),1);
 assert.equal(drive(scene(t,[[1,-10,-20],[1,-60,-70]]),240),2);
});

test('reset disarms, so a teleport next to a wall gives no event',t=>{
 const s=scene(t,[[1,-30,-90]]);drive(s,30);
 s.detector.reset();
 s.body.setTranslation({x:0,y:0.6,z:-40},true);
 assert.equal(drive(s,60),0);
});

test('a large pass-style trimesh candidate with no touching manifold does not suppress a close pass',t=>{
 const s=scene(t,[]);
 const vertices=new Float32Array([
  -20,0,10,-20,2,10,-20,2,-90,-20,0,-90,
  1.26,0,-30,1.26,2,-30,1.26,2,-90,1.26,0,-90,
 ]);
 s.world.createCollider(RAPIER.ColliderDesc.trimesh(vertices,new Uint32Array([0,1,2,0,2,3,4,5,6,4,6,7])));
 s.world.step();
 let candidates=0,solverContacts=0;
 s.world.contactPairsWith(s.body.collider(0),other=>{
  candidates++;s.world.contactPair(s.body.collider(0),other,m=>{solverContacts+=m.numSolverContacts();});
 });
 assert.equal(solverContacts,0);
 const events=drive(s,240);
 t.diagnostic(JSON.stringify({candidates,solverContacts,events}));
 assert.equal(events,1);
});
