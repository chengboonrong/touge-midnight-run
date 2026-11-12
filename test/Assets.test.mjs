import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function glb(name) {
  const bytes = await readFile(new URL(`../public/assets/touge/${name}.glb`, import.meta.url));
  assert.equal(bytes.readUInt32LE(0), 0x46546c67);
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a);
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
}

test('Blender coupe exports independent, correctly oriented wheel pivots without studio objects', async () => {
  const data = await glb('coupe');
  const expected = {
    Wheel_FL: [-0.86, 0, -1.25], Wheel_FR: [0.86, 0, -1.25],
    Wheel_RL: [-0.86, 0, 1.25], Wheel_RR: [0.86, 0, 1.25],
  };
  for (const [name, position] of Object.entries(expected)) {
    const matches = data.nodes.filter(node => node.name === name);
    assert.equal(matches.length, 1);
    const node = matches[0];
    position.forEach((value, i) => assert.ok(Math.abs(node.translation[i] - value) < 1e-5));
    assert.deepEqual(node.rotation ?? [0, 0, 0, 1], [0, 0, 0, 1]);
    assert.deepEqual(node.scale ?? [1, 1, 1], [1, 1, 1]);
    assert.ok(node.children.length > 0);
  }
  assert.equal(data.nodes.some(node => /Studio|PreviewFloor|Cam_|Light$/.test(node.name)), false);
  assert.equal(data.cameras?.length ?? 0, 0);
  const triangles = data.meshes.flatMap(mesh => mesh.primitives)
    .reduce((sum, primitive) => sum + data.accessors[primitive.indices].count / 3, 0);
  assert.ok(triangles > 20000 && triangles < 80000);
});

test('the pass contains collision geometry and a closed route aligned with the spawn lane', async () => {
  const data = await glb('mountain_pass');
  const collisionNames = data.nodes.filter(node => node.extras?.collision === 'trimesh').map(node => node.name);
  assert.ok(collisionNames.includes('Road_Surface'));
  assert.ok(collisionNames.includes('Guardrails'));
  assert.ok(collisionNames.includes('Terrain_Cut_Bench'));
  const route = JSON.parse(await readFile(new URL('../public/assets/touge/route.json', import.meta.url), 'utf8'));
  assert.ok(route.length > 800 && route.length < 1300);
  assert.equal(route.width, 9);
  assert.ok(route.points.every(point => [point.x, point.y, point.z].every(Number.isFinite)));
  const lane = route.points.findIndex((point, i) => i + 1 < route.points.length &&
    Math.abs(point.x) < 0.05 && Math.abs(route.points[i + 1].x) < 0.05 &&
    point.z >= 0 && route.points[i + 1].z <= 0);
  assert.ok(lane >= 0, 'the start straight points forward along -Z');
  const first = route.points[0], last = route.points.at(-1);
  assert.ok(Math.hypot(first.x - last.x, first.z - last.z) < 8);
});
