import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import RAPIER from '@dimforge/rapier3d-compat';

await RAPIER.init();

// The real sources are transpiled to CommonJS so DrivingEffects and this test share one real three instance.
const nodeRequire = createRequire(import.meta.url);
const THREE = nodeRequire('three');
const modules = new Map();
function loadTs(file) {
  const cached = modules.get(file);
  if (cached) return cached.exports;
  const js = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  modules.set(file, module);
  const localRequire = id => (id.startsWith('.') ? loadTs(resolve(dirname(file), `${id}.ts`)) : nodeRequire(id));
  new Function('exports', 'require', 'module', js)(module.exports, localRequire, module);
  return module.exports;
}
const src = name => loadTs(resolve(dirname(fileURLToPath(import.meta.url)), '../src', name));
const { VEHICLE, EFFECTS } = src('config.ts');
const { RaycastVehicle } = src('physics/RaycastVehicle.ts');
const { DrivingEffects } = src('render/DrivingEffects.ts');

const IDLE = { throttle: 0, brake: 0, steer: 0, handbrake: false };
/** Sideways speed of the forced slide, m/s: 0.25 m of contact travel per 60 Hz step. */
const SLIDE = 15;

function rig(t, quality = 'high', hz = 60) {
  const dt = 1 / hz;
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = dt;
  t.after(() => world.free());
  world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 0.5, 2000).setTranslation(0, -0.5, 0));
  const vehicle = new RaycastVehicle(RAPIER, world, VEHICLE);
  const scene = new THREE.Scene();
  const effects = new DrivingEffects(scene, vehicle, quality);
  t.after(() => effects.dispose());
  const body = vehicle.body;
  /** Steps the real vehicle. slide = hold a pure sideways slide by pinning planar velocity and yaw rate. */
  const run = (seconds, slide = false, each = undefined) => {
    const steps = Math.round(seconds * hz);
    for (let i = 0; i < steps; i++) {
      if (slide) {
        const v = body.linvel();
        const w = body.angvel();
        body.setLinvel({ x: SLIDE, y: v.y, z: 0 }, true);
        body.setAngvel({ x: w.x, y: 0, z: w.z }, true);
      }
      vehicle.update(IDLE, dt);
      world.step();
      effects.fixedUpdate(dt);
      if (each) each();
    }
  };
  const shift = dz => {
    const p = body.translation();
    body.setTranslation({ x: p.x, y: p.y, z: p.z + dz }, true);
  };
  return {
    scene, effects, body, run, shift, hz,
    points: scene.children.find(object => object.isPoints),
    marks: scene.children.find(object => object.isMesh),
  };
}

test('no smoke and no marks at rest, rolling straight or in the air', t => {
  const r = rig(t);
  r.run(2);
  assert.equal(r.effects.smokeCount, 0, 'settling at rest');
  assert.equal(r.effects.skidSegmentCount, 0);
  r.body.setLinvel({ x: 0, y: 0, z: -20 }, true);
  r.run(0.5);
  assert.equal(r.effects.smokeCount, 0, 'rolling straight');
  assert.equal(r.effects.skidSegmentCount, 0);
  r.body.setTranslation({ x: 0, y: 10, z: 0 }, true);
  r.body.setLinvel({ x: 20, y: 0, z: 0 }, true);
  r.run(0.3);
  assert.equal(r.effects.smokeCount, 0, 'sideways in the air');
  assert.equal(r.effects.skidSegmentCount, 0);
  r.effects.render(0.5, 1080);
  assert.equal(r.points.visible, false);
  assert.equal(r.points.geometry.drawRange.count, 0);
  assert.equal(r.marks.geometry.drawRange.count, 0);
});

function longSlide(t, quality) {
  const r = rig(t, quality);
  const smokeCap = EFFECTS.smoke[quality].capacity;
  const skidCap = EFFECTS.skid.segments[quality];
  r.run(2);
  const smokeArray = r.points.geometry.attributes.position.array;
  const skidArray = r.marks.geometry.attributes.position.array;
  let maxSmoke = 0;
  r.run(20, true, () => {
    r.effects.render(0.5, 1080);
    maxSmoke = Math.max(maxSmoke, r.effects.smokeCount);
    assert.ok(r.effects.smokeCount <= smokeCap, `smoke ${r.effects.smokeCount}`);
    assert.ok(r.effects.skidSegmentCount <= skidCap, `segments ${r.effects.skidSegmentCount}`);
    assert.equal(r.points.geometry.drawRange.count, r.effects.smokeCount);
    assert.equal(r.marks.geometry.drawRange.count, r.effects.skidSegmentCount * 6);
  });
  assert.ok(maxSmoke > 0, 'the slide made smoke');
  assert.equal(r.effects.skidSegmentCount, skidCap, 'the ring filled up and kept overwriting');
  assert.equal(r.points.geometry.attributes.position.array, smokeArray, 'smoke buffer was not reallocated');
  assert.equal(r.marks.geometry.attributes.position.array, skidArray, 'skid buffer was not reallocated');
  assert.equal(smokeArray.length, EFFECTS.smoke.high.capacity * 3);
  assert.equal(skidArray.length, EFFECTS.skid.segments.high * 18);
  assert.equal(r.scene.children.length, 2, 'still exactly one smoke object and one mark object');
  for (let i = 0; i < skidCap * 18; i++) assert.ok(Number.isFinite(skidArray[i]));
}

test('a long slide stays inside the high-quality pools and overwrites the oldest marks', t => longSlide(t, 'high'));
test('a long slide stays inside the smaller low-quality pools', t => longSlide(t, 'low'));

test('reset clears smoke and contact history, keeps existing marks and never bridges to the new position', t => {
  const r = rig(t);
  r.run(2);
  r.run(1, true);
  const before = r.effects.skidSegmentCount;
  assert.ok(before > 0 && r.effects.smokeCount > 0);
  r.effects.reset();
  assert.equal(r.effects.smokeCount, 0, 'smoke is cleared');
  assert.equal(r.effects.skidSegmentCount, before, 'marks persist');
  r.shift(1); // near enough to join if the contact history had survived
  r.run(1 / r.hz, true);
  assert.equal(r.effects.skidSegmentCount, before, 'the first contact after a reset only starts a new strip');
  r.run(1 / r.hz, true);
  const resumed = r.effects.skidSegmentCount;
  assert.ok(resumed > before && resumed <= before + 2, `resumed ${resumed} from ${before}`);
  r.shift(5); // a contact jump above 2 m without any reset
  r.run(1 / r.hz, true);
  assert.equal(r.effects.skidSegmentCount, resumed, 'a large contact jump is not joined');
});

test('the same slide emits the same smoke at 30, 60 and 120 Hz within one particle', t => {
  const counts = [30, 60, 120].map(hz => {
    const r = rig(t, 'high', hz);
    r.run(2);
    r.run(0.5, true); // shorter than a particle life, so nothing has expired
    return r.effects.smokeCount;
  });
  t.diagnostic(JSON.stringify(counts));
  assert.ok(Math.min(...counts) > 0);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `counts ${counts}`);
});

test('render uploads finite positions interpolated between the last two fixed steps', t => {
  const r = rig(t);
  r.run(2);
  r.run(0.5, true);
  const live = r.effects.smokeCount * 3;
  assert.ok(live > 0);
  const upload = alpha => {
    r.effects.render(alpha, 1080);
    return Float32Array.from(r.points.geometry.attributes.position.array.subarray(0, live));
  };
  const from = upload(0);
  const to = upload(1);
  const mid = upload(0.5);
  let moved = false;
  for (let i = 0; i < live; i++) {
    assert.ok(Number.isFinite(from[i]) && Number.isFinite(to[i]) && Number.isFinite(mid[i]));
    assert.ok(Math.abs(mid[i] - (from[i] + to[i]) / 2) < 1e-3, `component ${i}`);
    if (Math.abs(to[i] - from[i]) > 1e-4) moved = true;
  }
  assert.ok(moved, 'particles moved during the last step');
  for (const value of upload(Number.NaN)) assert.ok(Number.isFinite(value));
  assert.equal(r.points.visible, true);
});

test('dispose removes both objects and later calls are harmless', t => {
  const r = rig(t);
  r.run(2);
  r.run(0.5, true);
  r.effects.dispose();
  assert.equal(r.scene.children.length, 0);
  const segments = r.effects.skidSegmentCount;
  r.run(0.2, true);
  r.effects.render(0.5, 1080);
  r.effects.setQuality('low');
  r.effects.reset();
  assert.equal(r.effects.skidSegmentCount, segments);
});

test('quality switches lower the smoke pixel bound, clear visual history and reuse GPU buffers',t=>{
 const r=rig(t);r.run(2);r.run(0.5,true);
 const smokeBuffer=r.points.geometry.attributes.position.array;
 const skidBuffer=r.marks.geometry.attributes.position.array;
 assert.ok(r.effects.smokeCount>0&&r.effects.skidSegmentCount>0);
 assert.equal(r.points.material.uniforms.uMaxSize.value,EFFECTS.smoke.maxPointPx.high);
 r.effects.setQuality('low');
 assert.equal(r.points.material.uniforms.uMaxSize.value,EFFECTS.smoke.maxPointPx.low);
 assert.ok(EFFECTS.smoke.maxPointPx.low<EFFECTS.smoke.maxPointPx.high);
 assert.equal(r.effects.smokeCount,0);assert.equal(r.effects.skidSegmentCount,0);
 assert.equal(r.points.geometry.attributes.position.array,smokeBuffer);
 assert.equal(r.marks.geometry.attributes.position.array,skidBuffer);
 r.effects.setQuality('high');
 assert.equal(r.points.material.uniforms.uMaxSize.value,EFFECTS.smoke.maxPointPx.high);
});
