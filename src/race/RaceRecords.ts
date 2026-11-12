/**
 * Best-lap persistence. Storage is injected so this is testable; nothing here
 * can throw into the game. One versioned key per course shape; no other key is touched.
 */
import { readBestLap } from './RaceSession';
import type { BestLap } from './RaceSession';

export interface RecordStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Key scoped to course name, rounded length and point count. Bump v1 for layout changes retaining those values. */
export function courseKey(name: string, lengthMeters: number, pointCount: number): string {
  return `touge.best.${name}.v1.${Math.round(lengthMeters)}m.${pointCount}p`;
}

/** localStorage, or null when it is missing or access throws. */
export function browserStorage(): RecordStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The stored best lap, or null when missing, corrupt or unreadable. */
export function loadBestLap(storage: RecordStorage | null, key: string): BestLap | null {
  try {
    const raw = storage ? storage.getItem(key) : null;
    return raw ? readBestLap(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Writes a valid lap unless an equal or faster one is already stored (e.g. by another tab). True if written. */
export function saveBestLap(storage: RecordStorage | null, key: string, lap: unknown): boolean {
  const clean = readBestLap(lap);
  if (!storage || !clean) return false;
  try {
    const stored = loadBestLap(storage, key);
    if (stored && stored.time <= clean.time) return false;
    storage.setItem(key, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}
