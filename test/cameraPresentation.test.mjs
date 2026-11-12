// Camera presentation modes. Transpiles the real config.ts and ChaseCamera.ts standalone, like chaseCamera.test.mjs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three';
import ts from 'typescript';

async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/from\s+['"]three['"]/, `from ${JSON.stringify(import.meta.resolve('three'))}`);
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

const { CHASE_CAMERA, CAMERA_PRESENTATION: P } = await load('../src/config.ts');
const { ChaseCamera } = await load('../src/render/ChaseCamera.ts');

const STILL = { x: 0, y: 0, z: 0 };
const rig = (withPresentation = true) => {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  const car = new THREE.Object3D();
  const chase = withPresentation ? new ChaseCamera(camera, CHASE_CAMERA, P) : new ChaseCamera(camera, CHASE_CAMERA);
  chase.update(car, STILL, 0, 0, true);
  return { camera, car, chase };
};
// Driving rest pose of a still, unrotated car: heading is -Z, so 'behind' is +Z.
const REST = rig(false).camera.position.clone();
const extra = camera => ({ back: camera.position.z - REST.z, up: camera.position.y - REST.y, side: camera.position.x - REST.x });
const left = t => { const u = Math.min(1, t / P.introSeconds); return 1 - u * u * (3 - 2 * u); };
const run = (r, frames, hz, mode) => {
  for (let i = 0; i < frames; i++) { if (mode) r.chase.setPresentation(mode); r.chase.update(r.car, STILL, 0, 1 / hz); }
};

test('default drive presentation is identical to the camera without presentation tuning', () => {
  const a = rig(false), b = rig(true);
  b.chase.setPresentation('drive');
  for (let i = 0; i < 180; i++) {
    for (const r of [a, b]) {
      r.car.position.z -= 30 / 60;
      r.car.rotation.y = i * 0.002;
      r.chase.update(r.car, { x: 2, y: 0, z: -30 }, 0.3, 1 / 60);
    }
  }
  assert.equal(a.camera.position.distanceTo(b.camera.position), 0);
  assert.equal(a.camera.quaternion.angleTo(b.camera.quaternion), 0);
  assert.equal(a.camera.fov, b.camera.fov);
});

test('intro eases by elapsed time at 60/120/144 Hz and is exactly the driving pose from 3 s on', () => {
  assert.equal(P.introSeconds, 3);
  for (const hz of [60, 120, 144]) {
    const r = rig();
    run(r, 1, hz, 'intro');
    let e = extra(r.camera);
    assert.ok(e.back > 0 && e.back <= P.introDistance + 1e-9, `${hz} start back ${e.back}`);
    assert.ok(e.up > 0 && e.up <= P.introHeight + 1e-9, `${hz} start up ${e.up}`);
    // Setting the same mode every frame must not restart the intro.
    run(r, hz * 1.5 - 1, hz, 'intro');
    e = extra(r.camera);
    assert.ok(Math.abs(e.back - P.introDistance * left(1.5)) < 1e-6, `${hz} back ${e.back}`);
    assert.ok(Math.abs(e.up - P.introHeight * left(1.5)) < 1e-6, `${hz} up ${e.up}`);
    assert.ok(Math.abs(e.side) < 1e-9);
    run(r, hz * 1.5 + 1, hz, 'intro');
    assert.ok(r.camera.position.distanceTo(REST) < 1e-12, `${hz} intro end`);
    run(r, 1, hz, 'drive');
    assert.ok(r.camera.position.distanceTo(REST) < 1e-12, `${hz} drive after intro`);
  }
});

test('dt 0 (Options pause) freezes intro and finish', () => {
  for (const mode of ['intro', 'finish']) {
    const r = rig();
    run(r, 30, 60, mode);
    const before = r.camera.position.clone();
    for (let i = 0; i < 50; i++) { r.chase.setPresentation(mode); r.chase.update(r.car, STILL, 0, 0); }
    assert.equal(before.distanceTo(r.camera.position), 0, mode);
  }
});

test('finish eases monotonically to its bounded target, frame-rate independent', () => {
  const r = rig();
  let worst = 0;
  for (let i = 0; i < 600; i++) { run(r, 1, 60, 'finish'); worst = Math.max(worst, extra(r.camera).back); }
  const e = extra(r.camera);
  assert.ok(worst <= P.finishDistance + 1e-9, `overshoot ${worst}`);
  assert.ok(Math.abs(e.back - P.finishDistance) < 1e-3 && Math.abs(e.up - P.finishHeight) < 1e-3);
  const a = rig(), b = rig();
  run(a, 60, 60, 'finish');
  run(b, 144, 144, 'finish');
  assert.ok(Math.abs(extra(a.camera).back - extra(b.camera).back) < 1e-9);
  assert.ok(extra(a.camera).back > 0 && extra(a.camera).back < P.finishDistance);
});

test('menu is a static bounded offset and leaving it snaps to the driving pose', () => {
  const r = rig();
  run(r, 1, 60, 'menu');
  const e = extra(r.camera);
  assert.ok(Math.abs(e.back - P.menuDistance) < 1e-9 && Math.abs(e.up - P.menuHeight) < 1e-9 && Math.abs(e.side) < 1e-9);
  assert.ok(P.menuDistance <= 2.5 && P.menuHeight <= 1);
  const held = r.camera.position.clone();
  run(r, 120, 60, 'menu');
  assert.equal(held.distanceTo(r.camera.position), 0, 'no orbit or drift');
  run(r, 1, 60, 'drive');
  assert.ok(r.camera.position.distanceTo(REST) < 1e-12, 'no latency after the menu');
});

test('a snap during the intro does not restart it', () => {
  const r = rig();
  run(r, 60, 60, 'intro');
  r.chase.update(r.car, STILL, 0, 1 / 60, true);
  assert.ok(Math.abs(extra(r.camera).back - P.introDistance * left(61 / 60)) < 1e-6);
});
