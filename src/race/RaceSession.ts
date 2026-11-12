/**
 * Pure one-lap time-attack logic for a closed, planar route.
 *
 * No imports, DOM, audio, storage or wall clock: the host calls update() once
 * per fixed physics step with the real chassis position. A paused host simply
 * stops calling update(), so there is never any time to catch up.
 * See docs/race-session.md for the integration contract.
 */

export interface RacePoint { x: number; y: number; z: number }
export type RaceState = 'practice' | 'countdown' | 'racing' | 'finished';
export type InvalidReason = 'offcourse' | 'teleport';
/** Lap time and the three checkpoint times, in seconds from GO. */
export interface BestLap { time: number; splits: number[] }
/** A gate: a point on the centre line and the planar forward tangent there. */
export interface RaceGate { station: number; x: number; y: number; z: number; tx: number; tz: number }

export type RaceEvent =
  | { type: 'countdown'; value: 3 | 2 | 1 }
  | { type: 'go' }
  | { type: 'checkpoint'; index: number; time: number; delta: number | null }
  | { type: 'invalid'; reason: InvalidReason }
  | { type: 'finish'; time: number; valid: boolean; personalBest: boolean; previousBest: number | null }
  | { type: 'personalBest'; time: number; previousBest: number | null }
  | { type: 'cancel' };

export const COUNTDOWN_SECONDS = 3;
export const CHECKPOINTS = 3;
/** Preferred music state per race state, for the upcoming audio integration. */
export const RACE_MUSIC: Readonly<Record<RaceState, 'prepare' | 'race' | 'results'>> = {
  practice: 'race', countdown: 'prepare', racing: 'race', finished: 'results',
};

/** Gates and the course reach this far beyond the road edge, m. */
const EDGE_MARGIN = 1;
/** Gate crossings count within this height of the centre line, m. */
const GATE_HEIGHT = 4;
/** Further than this above or below the road is off course, m. */
const MAX_HEIGHT = 3;
/** Total off-course time that invalidates a run, s. */
const OFF_COURSE_LIMIT = 0.5;
/** A step longer than TELEPORT_SPEED * dt + TELEPORT_SLACK is a teleport. */
const TELEPORT_SPEED = 100;
const TELEPORT_SLACK = 2;
const EPS = 1e-9;
const NO_EVENTS: readonly RaceEvent[] = [];

function finite(p: RacePoint | null | undefined): p is RacePoint {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

/** Returns a clean copy of saved best-lap data, or null if it is not usable. */
export function readBestLap(value: unknown): BestLap | null {
  if (!value || typeof value !== 'object') return null;
  const { time, splits } = value as { time?: unknown; splits?: unknown };
  if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) return null;
  if (!Array.isArray(splits) || splits.length !== CHECKPOINTS) return null;
  const copy: number[] = [];
  let last = 0;
  for (const split of splits as unknown[]) {
    if (typeof split !== 'number' || !Number.isFinite(split) || split <= last) return null;
    copy.push(last = split);
  }
  return last < time ? { time, splits: copy } : null;
}

export class RaceSession {
  /** Length of the closed centre line, m. */
  readonly lapLength: number;
  /** Distance along the centre line of the spawn's closest projection, m. */
  readonly startStation: number;
  /** Three quarter-lap checkpoints, then the start/finish gate. */
  readonly gates: readonly RaceGate[];

  private readonly n: number;
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;
  private readonly tx: Float64Array;
  private readonly tz: Float64Array;
  private readonly len: Float64Array;
  private readonly cum: Float64Array;
  private readonly reach: number;

  private events: RaceEvent[] = [];
  private _state: RaceState = 'practice';
  private _best: BestLap | null;
  private _splits: number[] = [];
  private _elapsed = 0;
  private _checkpoint = 0;
  private _valid = true;
  private _offCourse = false;
  private clock = 0;
  private offTime = 0;
  private lastX = 0;
  private lastY = 0;
  private lastZ = 0;
  private projStation = 0;
  private projDistance = 0;
  private projY = 0;

  /** points: ordered centre line in forward direction, closed implicitly. */
  constructor(points: readonly RacePoint[], width: number, spawn: RacePoint, best?: unknown) {
    if (!points || points.length < 3 || !points.every(p => finite(p)) || !Number.isFinite(width) || width <= 0 || !finite(spawn)) {
      throw new Error('Invalid race route');
    }
    let n = points.length;
    if (Math.hypot(points[0]!.x - points[n - 1]!.x, points[0]!.z - points[n - 1]!.z) < 1e-6) n--;
    if (n < 3) throw new Error('Invalid race route');
    this.n = n;
    this.px = new Float64Array(n);
    this.py = new Float64Array(n);
    this.pz = new Float64Array(n);
    this.tx = new Float64Array(n);
    this.tz = new Float64Array(n);
    this.len = new Float64Array(n);
    this.cum = new Float64Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const a = points[i]!, b = points[(i + 1) % n]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      this.px[i] = a.x; this.py[i] = a.y; this.pz[i] = a.z;
      this.len[i] = length;
      this.cum[i] = total;
      if (length > EPS) { this.tx[i] = (b.x - a.x) / length; this.tz[i] = (b.z - a.z) / length; }
      total += length;
    }
    if (!(total > EPS)) throw new Error('Invalid race route');
    this.lapLength = total;
    this.reach = width / 2 + EDGE_MARGIN;
    this.project(spawn.x, spawn.z);
    this.startStation = this.projStation % total;
    const gates: RaceGate[] = [];
    for (let k = 1; k <= CHECKPOINTS + 1; k++) gates.push(this.gateAt(this.startStation + total * k / (CHECKPOINTS + 1)));
    this.gates = gates;
    this._best = readBestLap(best);
    this.remember(spawn);
  }

  get state(): RaceState { return this._state; }
  /** Seconds since GO; frozen at the lap time once finished. */
  get elapsed(): number { return this._elapsed; }
  /** 3, 2 or 1 during the countdown, otherwise 0. */
  get countdown(): number { return this._state === 'countdown' ? 3 - Math.min(2, Math.floor(this.clock + EPS)) : 0; }
  /** Checkpoints passed in this run, 0..3. */
  get checkpoint(): number { return this._checkpoint; }
  /** Checkpoint times of this run. Do not mutate. */
  get splits(): readonly number[] { return this._splits; }
  /** Best valid lap, or null. Do not mutate; the host persists it. */
  get best(): BestLap | null { return this._best; }
  /** False once this run can no longer set a record. */
  get valid(): boolean { return this._valid; }
  /** True while the last racing step was off the course. */
  get offCourse(): boolean { return this._offCourse; }

  /** Begins (or restarts) a timed run: countdown first, the timer starts at GO. */
  start(position: RacePoint): void {
    this.reset('countdown', position);
    this.events.push({ type: 'countdown', value: 3 });
  }

  /** Drops the current run or result and returns to practice. Keeps the best lap. */
  cancel(position: RacePoint): void {
    const active = this._state !== 'practice';
    this.reset('practice', position);
    if (active) this.events.push({ type: 'cancel' });
  }

  /** Events since the last call, oldest first. Call after every update(). */
  drainEvents(): readonly RaceEvent[] {
    if (this.events.length === 0) return NO_EVENTS;
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Advances by one physics step; position is the chassis position after it. */
  update(dt: number, position: RacePoint): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (this._state === 'countdown') {
      const before = this.clock;
      this.clock += dt;
      for (let second = 1; second < COUNTDOWN_SECONDS; second++) {
        if (before < second - EPS && this.clock >= second - EPS) {
          this.events.push({ type: 'countdown', value: (COUNTDOWN_SECONDS - second) as 2 | 1 });
        }
      }
      if (this.clock >= COUNTDOWN_SECONDS - EPS) {
        const extra = this.clock - COUNTDOWN_SECONDS;
        this._state = 'racing';
        this._elapsed = extra > EPS ? extra : 0;
        this.events.push({ type: 'go' });
      }
      this.remember(position);
      return;
    }
    if (this._state !== 'racing') return;
    if (!finite(position)) {
      this.invalidate('teleport');
      this._elapsed += dt;
      return;
    }
    const dx = position.x - this.lastX, dy = position.y - this.lastY, dz = position.z - this.lastZ;
    if (Math.hypot(dx, dy, dz) > TELEPORT_SPEED * dt + TELEPORT_SLACK) {
      this.invalidate('teleport');
    } else {
      const gate = this.gates[this._checkpoint]!;
      const d0 = (this.lastX - gate.x) * gate.tx + (this.lastZ - gate.z) * gate.tz;
      const d1 = (position.x - gate.x) * gate.tx + (position.z - gate.z) * gate.tz;
      if (d0 < 0 && d1 >= 0) {
        const f = d0 / (d0 - d1);
        const hx = this.lastX + dx * f - gate.x, hy = this.lastY + dy * f - gate.y, hz = this.lastZ + dz * f - gate.z;
        if (Math.abs(hz * gate.tx - hx * gate.tz) <= this.reach && Math.abs(hy) <= GATE_HEIGHT) this.pass(this._elapsed + f * dt);
      }
    }
    this.remember(position);
    if (this._state !== 'racing') return;
    this._elapsed += dt;
    this.project(position.x, position.z);
    this._offCourse = this.projDistance > this.reach || Math.abs(position.y - this.projY) > MAX_HEIGHT;
    if (this._offCourse && (this.offTime += dt) >= OFF_COURSE_LIMIT - EPS) this.invalidate('offcourse');
  }

  private reset(state: RaceState, position: RacePoint): void {
    this.events.length = 0; // Undrained events of the dropped run must not reach the HUD or audio.
    this._state = state;
    this._splits = [];
    this._elapsed = 0;
    this._checkpoint = 0;
    this._valid = true;
    this._offCourse = false;
    this.clock = 0;
    this.offTime = 0;
    this.remember(position);
  }

  private remember(position: RacePoint): void {
    if (!finite(position)) return;
    this.lastX = position.x;
    this.lastY = position.y;
    this.lastZ = position.z;
  }

  private invalidate(reason: InvalidReason): void {
    if (!this._valid) return;
    this._valid = false;
    this.events.push({ type: 'invalid', reason });
  }

  /** The current gate was crossed forwards at the given run time. */
  private pass(time: number): void {
    if (this._checkpoint < CHECKPOINTS) {
      const index = this._checkpoint;
      const delta = this._best ? time - this._best.splits[index]! : null;
      this._splits.push(time);
      this._checkpoint = index + 1;
      this.events.push({ type: 'checkpoint', index, time, delta });
      return;
    }
    const previousBest = this._best ? this._best.time : null;
    const lap = this._valid ? readBestLap({ time, splits: this._splits }) : null;
    const personalBest = lap !== null && (previousBest === null || time < previousBest);
    this._elapsed = time;
    this._state = 'finished';
    this._offCourse = false;
    if (personalBest) this._best = lap;
    this.events.push({ type: 'finish', time, valid: this._valid, personalBest, previousBest });
    if (personalBest) this.events.push({ type: 'personalBest', time, previousBest });
  }

  /** Gate on the centre line at a station (wrapped into one lap). */
  private gateAt(station: number): RaceGate {
    const total = this.lapLength, n = this.n;
    const s = ((station % total) + total) % total;
    let i = 0;
    while (i < n - 1 && (this.cum[i]! + this.len[i]! <= s || this.len[i]! <= EPS)) i++;
    const length = this.len[i]!;
    const f = length > EPS ? Math.min(1, Math.max(0, (s - this.cum[i]!) / length)) : 0;
    const j = (i + 1) % n;
    return {
      station: s,
      x: this.px[i]! + (this.px[j]! - this.px[i]!) * f,
      y: this.py[i]! + (this.py[j]! - this.py[i]!) * f,
      z: this.pz[i]! + (this.pz[j]! - this.pz[i]!) * f,
      tx: this.tx[i]!,
      tz: this.tz[i]!,
    };
  }

  /** Closest planar point on the centre line; fills projStation/projDistance/projY. */
  private project(x: number, z: number): void {
    let best = Infinity;
    for (let i = 0; i < this.n; i++) {
      const length = this.len[i]!, ax = this.px[i]!, az = this.pz[i]!, tx = this.tx[i]!, tz = this.tz[i]!;
      const t = Math.min(length, Math.max(0, (x - ax) * tx + (z - az) * tz));
      const distance = Math.hypot(x - ax - tx * t, z - az - tz * t);
      if (distance < best) {
        best = distance;
        const y0 = this.py[i]!;
        this.projStation = this.cum[i]! + t;
        this.projDistance = distance;
        this.projY = length > EPS ? y0 + (this.py[(i + 1) % this.n]! - y0) * t / length : y0;
      }
    }
  }
}
