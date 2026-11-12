import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const load = async file => {
  const source = await readFile(new URL(`../src/physics/${file}.ts`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
};
const { NearMiss } = await load('NearMiss');
const { GuardrailScrape } = await load('GuardrailScrape');
// Read the actual exported collider, including its corrugation; no replacement vertical-wall geometry.
const bytes = await readFile(new URL('../public/assets/touge/mountain_pass.glb', import.meta.url));
const jsonLength = bytes.readUInt32LE(12);
const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
const binStart = 20 + jsonLength + 8;
const railNode = gltf.nodes.find(node => node.name === 'Guardrails');
assert.equal(railNode.extras.collision, 'trimesh');
assert.ok(!railNode.matrix && !railNode.translation && !railNode.rotation && !railNode.scale, 'exported rail coordinates are world space');
const primitive = gltf.meshes[railNode.mesh].primitives[0];
function accessor(index, count) {
  const a = gltf.accessors[index], view = gltf.bufferViews[a.bufferView];
  const size = { 5123: 2, 5125: 4, 5126: 4 }[a.componentType];
  assert.ok(size && !a.sparse);
  const start = binStart + (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const output = a.componentType === 5126 ? new Float32Array(a.count * count) : new Uint32Array(a.count * count);
  const stride = view.byteStride ?? count * size;
  for (let i = 0; i < a.count; i++) for (let j = 0; j < count; j++) {
    const offset = start + i * stride + j * size;
    output[i * count + j] = a.componentType === 5126 ? bytes.readFloatLE(offset) : size === 2 ? bytes.readUInt16LE(offset) : bytes.readUInt32LE(offset);
  }
  return output;
}
const vertices = accessor(primitive.attributes.POSITION, 3), indices = accessor(primitive.indices, 1);
const DT = 1 / 60;
function rig(t, x = 0, speed = 25) {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 }); world.timestep = DT;
  t.after(() => world.free());
  const rail = world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices).setFriction(0));
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 0.6, 10).lockRotations());
  const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(0.96, 0.3, 2).setMass(1200).setFriction(0), body);
  body.setLinvel({ x: 0, y: 0, z: -speed }, true);
  return { world, rail, body, collider };
}

test('real exported corrugated rail triggers a fast clear near pass on both sides', t => {
  for (const side of [-1, 1]) {
    const { world, rail, body, collider } = rig(t);
    const detector = new NearMiss(RAPIER, world, body, collider, 0.96);
    for (let i = 0; i < 12; i++) { world.step(); assert.equal(detector.update(DT, 4), false); }
    body.setTranslation({ x: side * 4.05, y: 0.6, z: -10 }, true);
    world.step();
    const hit = world.castRayAndGetNormal(new RAPIER.Ray(body.translation(), { x: side, y: 0, z: 0 }), 1.41, true, undefined, undefined, undefined, body);
    assert.equal(hit?.collider.handle, rail.handle);
    t.diagnostic(JSON.stringify({ side, normalY: hit.normal.y, range: hit.timeOfImpact }));
    let contacts = 0;
    world.contactPair(collider, rail, m => { contacts += m.numSolverContacts(); });
    assert.equal(contacts, 0, 'clear of the rail');
    let events = Number(detector.update(DT, 4));
    for (let i = 0; i < 12; i++) { world.step(); events += Number(detector.update(DT, 4)); }
    assert.equal(events, 1, 'corrugation is still a roadside obstacle');
  }
});

test('actual exported rail produces scrape feedback during a physically held sliding contact', t => {
  const { world, rail, body, collider } = rig(t, 4.25, 10);
  body.setTranslation({ x: 4.25, y: 0.6, z: -10 }, true);
  const detector = new GuardrailScrape(world, body, collider, new Set([rail.handle]));
  let max = 0, contacts = 0;
  const normals = new Set();
  for (let i = 0; i < 60; i++) {
    body.applyImpulse({ x: 1200 * 8 * DT, y: 0, z: 0 }, true);
    world.step();
    world.contactPair(collider, rail, m => { if (m.numSolverContacts()) { contacts++; normals.add(m.normal().y.toFixed(3)); } });
    max = Math.max(max, detector.update(DT));
  }
  t.diagnostic(JSON.stringify({ contacts, normals: [...normals], max }));
  assert.ok(contacts > 0);
  assert.ok(max > 0 && max <= 1, 'actual corrugated contact must be audible');
});
