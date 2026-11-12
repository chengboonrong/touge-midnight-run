import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const THREE = require('three');

function load(path) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('exports', 'require', 'module', js)(module.exports, require, module);
  return module.exports;
}

const { CHASE_CAMERA } = load('../src/config.ts');
const { ChaseCamera } = load('../src/render/ChaseCamera.ts');
const STILL = { x: 0, z: 0 };

function rig() {
  const camera = new THREE.PerspectiveCamera();
  const car = new THREE.Object3D();
  const chase = new ChaseCamera(camera, CHASE_CAMERA);
  chase.update(car, STILL, 0, 1 / 60, true);
  return { camera, car, chase, base: camera.position.y };
}
const offset = r => r.camera.position.y - r.base;
function run(r, dt, frames) {
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    r.chase.update(r.car, STILL, 0, dt);
    peak = Math.max(peak, Math.abs(offset(r)));
  }
  return peak;
}

test('no impact, or an invalid one, means no shake', () => {
  const r = rig();
  r.chase.impact(0);
  r.chase.impact(-1);
  r.chase.impact(NaN);
  assert.ok(run(r, 1 / 60, 30) < 1e-9);
});

test('impact shake is visible, bounded below 0.08 m and decays away', () => {
  for (const strength of [1, 50]) {
    const r = rig();
    r.chase.impact(strength);
    const peak = run(r, 1 / 60, 120);
    assert.ok(peak > 0.005);
    assert.ok(peak < 0.08);
    assert.ok(Math.abs(offset(r)) < 1e-3);
    assert.ok(run(r, 1 / 60, 30) < 1e-3);
  }
  const weak = rig();
  weak.chase.impact(0.2);
  const strong = rig();
  strong.chase.impact(1);
  assert.ok(run(weak, 1 / 60, 60) < run(strong, 1 / 60, 60));
});

test('a camera reset clears the shake', () => {
  const r = rig();
  r.chase.impact(1);
  assert.ok(run(r, 1 / 60, 1) > 0.005);
  r.chase.update(r.car, STILL, 0, 1 / 60, true);
  assert.ok(Math.abs(offset(r)) < 1e-9);
  assert.ok(run(r, 1 / 60, 30) < 1e-9);
});

test('shake depends on elapsed time, not on frame rate', () => {
  const a = rig();
  const b = rig();
  a.chase.impact(1);
  b.chase.impact(1);
  run(a, 1 / 60, 12);
  run(b, 1 / 120, 24);
  assert.ok(Math.abs(offset(a)) > 1e-4);
  assert.ok(Math.abs(offset(a) - offset(b)) < 1e-9);
});
