import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

export interface PassRoute {
  name: string;
  width: number;
  length: number;
  points: { x: number; y: number; z: number }[];
}

export function readRoute(data: unknown): PassRoute {
  if (!data || typeof data !== 'object') throw Error('Invalid pass route metadata');
  const route = data as PassRoute;
  if (typeof route.name !== 'string' || !Number.isFinite(route.length) || route.length <= 0 ||
      !Number.isFinite(route.width) || route.width <= 0 || !Array.isArray(route.points) || route.points.length < 3 ||
      !route.points.every(point => point && [point.x, point.y, point.z].every(Number.isFinite))) {
    throw Error('Invalid pass route metadata');
  }
  return route;
}

/** Blender's collision extras follow the visual meshes, including parent transforms. */
export function addPassColliders(root: THREE.Object3D, world: RAPIER.World): number {
  root.updateWorldMatrix(true, true);
  let count = 0;
  const point = new THREE.Vector3();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    let ancestor: THREE.Object3D | null = object;
    let collides = false;
    while (ancestor !== root.parent) {
      if (!ancestor) break;
      if (ancestor.userData.collision === 'trimesh') { collides = true; break; }
      ancestor = ancestor.parent;
    }
    if (!collides) return;
    const geometry = object.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute('position');
    if (!position || position.count < 3) throw Error(`Empty collision mesh: ${object.name}`);
    const vertices = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
      if (![point.x, point.y, point.z].every(Number.isFinite)) throw Error(`Invalid collision vertex: ${object.name}`);
      vertices.set([point.x, point.y, point.z], i * 3);
    }
    const index = geometry.getIndex();
    const indices = new Uint32Array(index ? index.count : position.count);
    for (let i = 0; i < indices.length; i++) indices[i] = index ? index.getX(i) : i;
    if (indices.length % 3 !== 0) throw Error(`Invalid collision triangles: ${object.name}`);
    if (object.matrixWorld.determinant() < 0) {
      for (let i = 0; i < indices.length; i += 3) {
        [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
      }
    }
    world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices));
    count++;
  });
  if (!count) throw Error('The mountain-pass asset has no collision meshes');
  return count;
}
