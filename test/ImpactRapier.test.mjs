import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const source=await readFile(new URL('../src/physics/ImpactFeedback.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {ImpactFeedback,impactThresholdForce}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));

function run(t,kind){
 const world=new RAPIER.World({x:0,y:-9.81,z:0});world.timestep=1/60;
 const queue=new RAPIER.EventQueue(true);t.after(()=>{queue.free();world.free();});
 world.createCollider(RAPIER.ColliderDesc.cuboid(50,0.5,50).setTranslation(0,-0.5,0));
 if(kind==='wall')world.createCollider(RAPIER.ColliderDesc.cuboid(0.2,3,5).setTranslation(3,2,0));
 const body=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0,kind==='drop'?5:0.31,0).setCcdEnabled(true));
 const collider=world.createCollider(RAPIER.ColliderDesc.cuboid(0.96,0.3,2).setMass(1200).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(impactThresholdForce(1200,1/60)),body);
 if(kind==='wall')body.setLinvel({x:15,y:0,z:0},true);
 const feedback=new ImpactFeedback();let signals=0,peak=0,force=0;
 for(let i=0;i<180;i++){
  feedback.step(1/60);world.step(queue);
  queue.drainContactForceEvents(event=>{force=Math.max(force,event.totalForceMagnitude());feedback.contact(event.collider1(),event.collider2(),collider.handle,event.totalForceMagnitude(),1/60,body.mass());});
  const s=feedback.consume();if(s>0)signals++;peak=Math.max(peak,s);
 }
 return {signals,peak,force};
}
test('real Rapier0.14 wall contacts deliver bounded one-shot feedback',t=>{const r=run(t,'wall');t.diagnostic(JSON.stringify(r));assert.ok(r.signals>=1&&r.signals<=3);assert.ok(r.peak>0.8&&r.peak<=1);});
test('real Rapier0.14 hard landing delivers feedback while resting support is silent',t=>{const drop=run(t,'drop');const rest=run(t,'rest');t.diagnostic(JSON.stringify({drop,rest}));assert.ok(drop.signals>=1&&drop.peak>0);assert.equal(rest.signals,0);});
