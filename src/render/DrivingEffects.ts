import * as THREE from 'three';
import { EFFECTS } from '../config';
import type { RaycastVehicle } from '../physics/RaycastVehicle';
import type { Quality } from './SceneSetup';

/**
 * Tire smoke and skid marks, driven only by the vehicle's wheel telemetry.
 * Two draw calls: one Points pool and one ring of quads. Every buffer is
 * allocated once at the high-quality capacity; nothing here touches physics.
 */

interface Vec { x: number; y: number; z: number }
type EffectsVehicle = Pick<RaycastVehicle, 'wheels' | 'body'>;

const MAX_SMOKE = EFFECTS.smoke.high.capacity;
const MAX_SKID = EFFECTS.skid.segments.high;
const WHEELS = 4;
/** Wheel order is FL, FR, RL, RR: only the rear pair smokes and marks. */
const FIRST_WHEEL = 2;

const SMOKE_VERTEX = `
attribute vec2 aLife; // x: age 0..1, y: seed 0..1
uniform float uScale;
uniform float uMaxSize;
varying float vFade;
varying float vSeed;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vSeed = aLife.y * 6.28318;
  float size = mix(0.08, 0.9, aLife.x) * (0.8 + 0.4 * aLife.y);
  gl_PointSize = min(uMaxSize, size * uScale * projectionMatrix[1][1] / max(-mvPosition.z, 0.1));
  vFade = smoothstep(0.0, 0.12, aLife.x) * (1.0 - aLife.x);
  #include <fog_vertex>
}`;

const SMOKE_FRAGMENT = `
uniform vec3 uColor;
uniform float uAlpha;
varying float vFade;
varying float vSeed;
#include <fog_pars_fragment>
void main() {
  vec2 p = (gl_PointCoord - 0.5) * 2.0;
  float angle = atan(p.y, p.x + 0.00001);
  float radius = 0.88 + 0.07 * sin(angle * 3.0 + vSeed) + 0.04 * sin(angle * 5.0 - vSeed);
  float r = length(p) / radius;
  if (r > 1.0 || vFade <= 0.0) discard;
  float edge = 1.0 - smoothstep(0.25, 1.0, r);
  float contour = smoothstep(0.5, 0.75, r);
  gl_FragColor = vec4(uColor * (1.0 - 0.2 * contour), uAlpha * vFade * edge);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

function put(a: Float32Array, at: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
  a[at] = x + sx;
  a[at + 1] = y + sy;
  a[at + 2] = z + sz;
}

export class DrivingEffects {
  private readonly prev = new Float32Array(MAX_SMOKE * 3);
  private readonly curr = new Float32Array(MAX_SMOKE * 3);
  private readonly vel = new Float32Array(MAX_SMOKE * 3);
  private readonly age = new Float32Array(MAX_SMOKE);
  private readonly seed = new Float32Array(MAX_SMOKE);
  private readonly alive = new Uint8Array(MAX_SMOKE);
  private readonly smokeArray = new Float32Array(MAX_SMOKE * 3);
  private readonly lifeArray = new Float32Array(MAX_SMOKE * 2);
  private readonly skidArray = new Float32Array(MAX_SKID * 18);
  /** Fractional particles owed per wheel. */
  private readonly emitDebt = new Float64Array(WHEELS);
  private readonly last = new Float32Array(WHEELS * 3);
  private readonly lastSide = new Float32Array(WHEELS * 3);
  /** Per wheel: 0 = no contact history, 1 = a start point, 2 = a start point and the previous segment's edge. */
  private readonly history = new Uint8Array(WHEELS);
  private readonly smokePosition = new THREE.BufferAttribute(this.smokeArray, 3);
  private readonly smokeLife = new THREE.BufferAttribute(this.lifeArray, 2);
  private readonly skidPosition = new THREE.BufferAttribute(this.skidArray, 3);
  private readonly smokeGeometry = new THREE.BufferGeometry();
  private readonly skidGeometry = new THREE.BufferGeometry();
  private readonly scale = { value: 1 };
  private readonly smokeMaterial = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uColor: { value: new THREE.Color(EFFECTS.smoke.color) },
      uAlpha: { value: EFFECTS.smoke.alpha },
      uMaxSize: { value: EFFECTS.smoke.maxPointPx.high },
      uScale: this.scale,
    },
    vertexShader: SMOKE_VERTEX,
    fragmentShader: SMOKE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  private readonly skidMaterial = new THREE.MeshBasicMaterial({
    color: EFFECTS.skid.color,
    transparent: true,
    opacity: EFFECTS.skid.alpha,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  private readonly points = new THREE.Points(this.smokeGeometry, this.smokeMaterial);
  private readonly marks = new THREE.Mesh(this.skidGeometry, this.skidMaterial);
  private readonly scene: THREE.Scene;
  private readonly vehicle: EffectsVehicle;
  private quality: Quality;
  private live = 0;
  private cursor = 0;
  private serial = 1;
  private skidHead = 0;
  private skidCount = 0;
  private disposed = false;

  constructor(scene: THREE.Scene, vehicle: EffectsVehicle, initialQuality: Quality) {
    this.scene = scene;
    this.vehicle = vehicle;
    this.quality = initialQuality;
    this.smokeMaterial.uniforms.uMaxSize.value = EFFECTS.smoke.maxPointPx[initialQuality];
    for (const attribute of [this.smokePosition, this.smokeLife, this.skidPosition]) {
      attribute.setUsage(THREE.DynamicDrawUsage);
    }
    this.smokeGeometry.setAttribute('position', this.smokePosition).setAttribute('aLife', this.smokeLife);
    this.smokeGeometry.setDrawRange(0, 0);
    this.skidGeometry.setAttribute('position', this.skidPosition);
    this.skidGeometry.setDrawRange(0, 0);
    // World-space vertices on objects at the origin: no culling, so no bounds are ever computed.
    for (const object of [this.points, this.marks]) {
      object.frustumCulled = false;
      object.visible = false;
    }
    this.marks.renderOrder = 1;
    this.points.renderOrder = 2;
    scene.add(this.marks, this.points);
  }

  /** Live smoke particles. For tests and devtools. */
  get smokeCount(): number {
    return this.live;
  }

  /** Skid segments currently drawn. For tests and devtools. */
  get skidSegmentCount(): number {
    return this.skidCount;
  }

  /** Call once per executed physics step, after the world step. */
  fixedUpdate(dt: number): void {
    if (this.disposed || !Number.isFinite(dt) || !(dt > 0)) return;
    const cfg = EFFECTS.smoke[this.quality];
    const { prev, curr, vel, age, alive } = this;
    const keep = Math.exp(-EFFECTS.smoke.drag * dt);
    for (let i = 0; i < cfg.capacity; i++) {
      if (alive[i] === 0) continue;
      age[i] += dt;
      if (age[i] >= cfg.life) {
        alive[i] = 0;
        this.live--;
        continue;
      }
      const o = i * 3;
      for (let k = 0; k < 3; k++) {
        prev[o + k] = curr[o + k];
        vel[o + k] *= keep;
        curr[o + k] += vel[o + k] * dt;
      }
      curr[o + 1] += EFFECTS.smoke.rise * dt;
    }

    const v = this.vehicle.body.linvel();
    const moving = Math.hypot(v.x, v.z) >= EFFECTS.minPlanarSpeed;
    const wheels = this.vehicle.wheels;
    const lift = EFFECTS.skid.lift;
    for (let i = FIRST_WHEEL; i < WHEELS; i++) {
      const wheel = wheels[i];
      const slip = wheel ? Math.abs(wheel.slipSpeed) : 0;
      if (!wheel || !moving || !wheel.grounded || !(wheel.load > EFFECTS.minLoad) || !(slip >= EFFECTS.minSlipSpeed)) {
        // Not sliding under load: nothing is owed and the next mark starts a new strip.
        this.history[i] = 0;
        this.emitDebt[i] = 0;
        continue;
      }
      const p = wheel.contactPoint;
      const n = wheel.contactNormal;
      this.emitDebt[i] += cfg.rate * Math.min(1, slip / EFFECTS.fullSlipSpeed) * dt;
      while (this.emitDebt[i] >= 1) {
        this.emitDebt[i] -= 1;
        this.spawn(p, n, v, cfg.capacity);
      }
      this.mark(i, p.x + n.x * lift, p.y + n.y * lift, p.z + n.z * lift, n);
    }
  }

  /** Uploads the interpolated particles. Call before renderer.render(). */
  render(alpha: number, viewportHeightPx: number): void {
    if (this.disposed) return;
    const a = alpha >= 0 && alpha <= 1 ? alpha : 1;
    const cfg = EFFECTS.smoke[this.quality];
    const { prev, curr, smokeArray, lifeArray } = this;
    let count = 0;
    for (let i = 0; i < cfg.capacity; i++) {
      if (this.alive[i] === 0) continue;
      const from = i * 3;
      const to = count * 3;
      for (let k = 0; k < 3; k++) smokeArray[to + k] = prev[from + k] + (curr[from + k] - prev[from + k]) * a;
      lifeArray[count * 2] = Math.min(1, this.age[i] / cfg.life);
      lifeArray[count * 2 + 1] = this.seed[i];
      count++;
    }
    // Live particles are packed to the front, so dead ones are never drawn.
    this.smokeGeometry.setDrawRange(0, count);
    this.points.visible = count > 0;
    if (count === 0) return;
    this.smokePosition.needsUpdate = true;
    this.smokeLife.needsUpdate = true;
    this.scale.value = viewportHeightPx > 1 ? viewportHeightPx * 0.5 : 0.5;
  }

  /** Switches pool sizes. Clears smoke, contact history and marks; never touches physics. */
  setQuality(quality: Quality): void {
    if (this.disposed || quality === this.quality) return;
    this.quality = quality;
    this.smokeMaterial.uniforms.uMaxSize.value = EFFECTS.smoke.maxPointPx[quality];
    this.reset();
    this.skidHead = 0;
    this.skidCount = 0;
    this.skidGeometry.setDrawRange(0, 0);
    this.marks.visible = false;
  }

  /** Clears smoke and contact history so nothing bridges a teleport. Existing marks stay. */
  reset(): void {
    this.alive.fill(0);
    this.history.fill(0);
    this.emitDebt.fill(0);
    this.live = 0;
    this.cursor = 0;
    this.serial = 1;
    this.smokeGeometry.setDrawRange(0, 0);
    this.points.visible = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.marks, this.points);
    this.smokeGeometry.dispose();
    this.skidGeometry.dispose();
    this.smokeMaterial.dispose();
    this.skidMaterial.dispose();
  }

  /** Deterministic 0..1 sequence: the same slide always spawns the same puffs. */
  private random(): number {
    this.serial = (Math.imul(this.serial, 1664525) + 1013904223) >>> 0;
    return this.serial / 4294967296;
  }

  private spawn(p: Vec, n: Vec, v: Vec, capacity: number): void {
    // First free slot from the cursor; with a full pool this lands on the oldest one.
    let slot = this.cursor % capacity;
    for (let tries = 0; tries < capacity && this.alive[slot] === 1; tries++) slot = (slot + 1) % capacity;
    if (this.alive[slot] === 0) this.live++;
    this.cursor = (slot + 1) % capacity;
    const { height, jitter, inheritVelocity } = EFFECTS.smoke;
    const r1 = this.random();
    const r2 = this.random();
    const o = slot * 3;
    this.curr[o] = this.prev[o] = p.x + n.x * height + (r1 - 0.5) * jitter;
    this.curr[o + 1] = this.prev[o + 1] = p.y + n.y * height;
    this.curr[o + 2] = this.prev[o + 2] = p.z + n.z * height + (r2 - 0.5) * jitter;
    this.vel[o] = v.x * inheritVelocity + (r2 - 0.5) * jitter * 2;
    this.vel[o + 1] = 0;
    this.vel[o + 2] = v.z * inheritVelocity + (r1 - 0.5) * jitter * 2;
    this.age[slot] = 0;
    this.seed[slot] = r1;
    this.alive[slot] = 1;
  }

  /** Extends wheel i's strip to (x, y, z) once the contact has travelled far enough. */
  private mark(i: number, x: number, y: number, z: number, n: Vec): void {
    const { last, lastSide, history } = this;
    const o = i * 3;
    const lx = last[o], ly = last[o + 1], lz = last[o + 2];
    const dx = x - lx, dy = y - ly, dz = z - lz;
    const distance = Math.hypot(dx, dy, dz);
    if (history[i] !== 0 && distance < EFFECTS.skid.minSegment) return;
    // Across the strip: ground normal x travel direction.
    let sx = n.y * dz - n.z * dy, sy = n.z * dx - n.x * dz, sz = n.x * dy - n.y * dx;
    const length = Math.hypot(sx, sy, sz);
    last[o] = x;
    last[o + 1] = y;
    last[o + 2] = z;
    if (history[i] === 0 || distance > EFFECTS.skid.maxJump || length < 1e-6) {
      history[i] = 1; // start a new strip here, joined to nothing
      return;
    }
    const half = (EFFECTS.skid.width * 0.5) / length;
    sx *= half;
    sy *= half;
    sz *= half;
    // Start on the previous segment's end edge so a curving strip has no gaps.
    const joined = history[i] === 2;
    const ax = joined ? lastSide[o] : sx, ay = joined ? lastSide[o + 1] : sy, az = joined ? lastSide[o + 2] : sz;
    const a = this.skidArray;
    const capacity = EFFECTS.skid.segments[this.quality];
    const w = this.skidHead * 18;
    put(a, w, lx, ly, lz, -ax, -ay, -az);
    put(a, w + 3, lx, ly, lz, ax, ay, az);
    put(a, w + 6, x, y, z, sx, sy, sz);
    put(a, w + 9, lx, ly, lz, -ax, -ay, -az);
    put(a, w + 12, x, y, z, sx, sy, sz);
    put(a, w + 15, x, y, z, -sx, -sy, -sz);
    lastSide[o] = sx;
    lastSide[o + 1] = sy;
    lastSide[o + 2] = sz;
    history[i] = 2;
    this.skidHead = (this.skidHead + 1) % capacity;
    this.skidCount = Math.min(this.skidCount + 1, capacity);
    this.skidGeometry.setDrawRange(0, this.skidCount * 6);
    this.skidPosition.needsUpdate = true;
    this.marks.visible = true;
  }
}
