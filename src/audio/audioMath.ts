/**
 * Pure audio mappings: telemetry in, bounded levels out. No Web Audio and no
 * imports, so the Node tests transpile and run this file standalone.
 */

export interface EngineLike {
  readonly rpm: number;
  readonly gear: number;
  readonly idleRpm: number;
  readonly redlineRpm: number;
  readonly shifting: boolean;
  readonly limiting: boolean;
}

export interface WheelLike {
  readonly grounded: boolean;
  readonly load: number;
  readonly slipSpeed: number;
}

export interface AudioPrefs {
  volume: number;
  muted: boolean;
}

export const DEFAULT_VOLUME = 0.7;

const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** A 0..1 volume, or the default for anything that is not a finite number. */
export function parseVolume(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : DEFAULT_VOLUME;
}

/** Validated preferences from a stored JSON string (or object). Never throws. */
export function parseAudioPrefs(raw: unknown): AudioPrefs {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  const fields = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  return { volume: parseVolume(fields.volume), muted: fields.muted === true };
}

/** Master gain with headroom: 0 when muted, at most 0.6. */
export function masterLevel(prefs: AudioPrefs): number {
  return prefs.muted ? 0 : 0.6 * parseVolume(prefs.volume);
}

/** 0 at idle .. 1 at the redline. 0 for nonfinite or inverted ranges. */
export function rpmFraction(rpm: number, idleRpm: number, redlineRpm: number): number {
  if (!Number.isFinite(idleRpm) || !Number.isFinite(redlineRpm)) return 0;
  const span = redlineRpm - idleRpm;
  if (!(span > 0)) return 0;
  return clamp01((num(rpm, idleRpm) - idleRpm) / span);
}

/** Four-cylinder firing frequency in Hz, kept within [10, 400]. */
export function engineFrequency(rpm: number): number {
  return Math.min(400, Math.max(10, num(rpm, 900) / 30));
}

/** Idle/low/mid/high crossfade weights written into out. They always sum to 1. */
export function engineLayers(fraction: number, out: number[]): number[] {
  const position = clamp01(num(fraction)) * 3;
  for (let i = 0; i < 4; i++) out[i] = Math.max(0, 1 - Math.abs(position - i));
  return out;
}

/** Engine loudness 0..1: a base that rises with revs plus throttle load, cut while shifting. */
export function engineLevel(fraction: number, throttle: number, shifting: boolean, limiting: boolean): number {
  const f = clamp01(num(fraction));
  const load = shifting ? 0 : clamp01(num(throttle)) * (limiting ? 0.6 : 1);
  return 0.3 + 0.2 * f + 0.5 * load;
}

/** Tire noise 0..1 from the worst grounded, loaded wheel's sideways slip speed. */
export function tireLevel(wheels: ReadonlyArray<WheelLike>): number {
  let level = 0;
  for (let i = 0; i < wheels.length; i++) {
    const wheel = wheels[i];
    if (!wheel || !wheel.grounded) continue;
    const slip = clamp01((Math.abs(num(wheel.slipSpeed)) - 1.5) / 5.5);
    const load = clamp01(num(wheel.load) / 2500);
    level = Math.max(level, slip * slip * (3 - 2 * slip) * load);
  }
  return level;
}

/** Share of wheels on the ground, 0..1. */
export function groundedFraction(wheels: ReadonlyArray<{ readonly grounded: boolean }>): number {
  let count = 0;
  for (let i = 0; i < wheels.length; i++) if (wheels[i]?.grounded) count++;
  return wheels.length > 0 ? count / wheels.length : 0;
}

/** Road rumble 0..1: linear in speed (m/s), scaled by the grounded share. */
export function roadLevel(speed: number, grounded: number): number {
  return clamp01(Math.abs(num(speed)) / 30) * clamp01(num(grounded));
}

/** Wind 0..1: quadratic in speed (m/s). */
export function windLevel(speed: number): number {
  const x = clamp01(Math.abs(num(speed)) / 55);
  return x * x;
}

/** Guardrail scrape 0..1 from the contact detector; 0 for anything that is not a finite number. */
export function scrapeLevel(value: unknown): number {
  return clamp01(num(value));
}
