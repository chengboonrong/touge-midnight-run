import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

const source = await readFile(new URL('../src/world/MountainPass.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const executable = outputText.replace(/from (['"])(three|@dimforge\/rapier3d-compat)\1/g,
  (_, _quote, specifier) => `from ${JSON.stringify(import.meta.resolve(specifier))}`);
const { addPassColliders, readRoute } = await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);
await RAPIER.init();

test('asset collisions inherit tags and match translated, mirrored visual geometry', () => {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  try {
    const root = new THREE.Group();
    const tagged = new THREE.Group();
    tagged.userData.collision = 'trimesh';
    tagged.position.set(4, 2, -3);
    tagged.scale.x = -1;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2));
    tagged.add(floor);
    root.add(tagged);
    root.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2))); // untagged decoration
    assert.equal(addPassColliders(root, world), 1);
    world.step();
    const hit = world.castRayAndGetNormal(new RAPIER.Ray({ x: 4, y: 5, z: -3 }, { x: 0, y: -1, z: 0 }), 10, true);
    assert.ok(hit);
    assert.ok(Math.abs(hit.timeOfImpact - 3) < 1e-5);
    assert.ok(hit.normal.y > 0.99);
    assert.equal(world.castRay(new RAPIER.Ray({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }), 2, true), null);
  } finally { world.free(); }
});

test('a decorative asset without collision metadata is rejected', () => {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  try { assert.throws(() => addPassColliders(new THREE.Group(), world), /no collision meshes/); }
  finally { world.free(); }
});

test('invalid route metadata is rejected before the HUD can consume it', () => {
  const valid = { name: 'Pass', width: 9, length: 1000, points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }, { x: 2, y: 0, z: 0 }] };
  assert.equal(readRoute(valid), valid);
  for (const data of [null, {}, { ...valid, length: 0 }, { ...valid, points: [{ x: NaN, y: 0, z: 0 }, ...valid.points] }]) {
    assert.throws(() => readRoute(data), /Invalid pass route/);
  }
});
