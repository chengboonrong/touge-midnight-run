/**
 * Pure music rules: states, track URLs, preferences and two-slot crossfade
 * planning. No Web Audio, no DOM and no imports, so the Node tests run it standalone.
 */
export type MusicState = 'menu' | 'prepare' | 'race' | 'results';

export const MUSIC_STATES: readonly MusicState[] = ['menu', 'prepare', 'race', 'results'];
/** Free practice plays the race track. */
export const DEFAULT_MUSIC_STATE: MusicState = 'race';
export const DEFAULT_MUSIC_VOLUME = 0.25;
/** Music gain at full slider; the default 0.25 slider sits well under the effects. */
export const MUSIC_HEADROOM = 0.6;
export const CROSSFADE_SECONDS = 0.8;
export const MUSIC_TRACKS: Readonly<Record<MusicState, string>> = {
  menu: '/assets/audio/menu.mp3',
  prepare: '/assets/audio/prepare.mp3',
  race: '/assets/audio/race.mp3',
  results: '/assets/audio/results.mp3',
};

export function parseMusicState(value: unknown): MusicState {
  return MUSIC_STATES.includes(value as MusicState) ? (value as MusicState) : DEFAULT_MUSIC_STATE;
}

/** A 0..1 volume, or the default for anything that is not a finite number. */
export function parseMusicVolume(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_MUSIC_VOLUME;
}

/** The musicVolume field of the stored audio preferences. Older SFX-only data yields the default. Never throws. */
export function parseMusicVolumePref(raw: unknown): number {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  return parseMusicVolume(typeof data === 'object' && data !== null ? (data as Record<string, unknown>).musicVolume : undefined);
}

/** Music gain: 0 when everything is muted, at most MUSIC_HEADROOM. */
export function musicLevel(volume: unknown, muted: boolean): number {
  return muted ? 0 : MUSIC_HEADROOM * parseMusicVolume(volume);
}

export interface MusicChange {
  /** Slot (0 or 1) that fades in. */
  fadeIn: number;
  /** Slot that fades out, or -1 when nothing was playing. */
  fadeOut: number;
  state: MusicState;
  /** The fade-in slot already holds this track, so its source need not be set again. */
  reuse: boolean;
  token: number;
}

/** Decides which of exactly two slots plays what. Tokens make stale delayed stops harmless. */
export class MusicPlanner {
  private readonly slots: (MusicState | null)[] = [null, null];
  private active = -1;
  private token = 0;

  /** Null when the state is already the active one. */
  request(state: MusicState, live: number = this.active): MusicChange | null {
    if (this.active >= 0 && this.slots[this.active] === state) return null;
    // live = the slot audible now (-1 for none). It is never overwritten: the new track loads into the other
    // slot, or the live slot is reused when it already holds the track.
    const fadeIn = live < 0 ? 0 : this.slots[live] === state ? live : 1 - live;
    const fadeOut = live < 0 ? -1 : 1 - fadeIn;
    const reuse = this.slots[fadeIn] === state;
    this.slots[fadeIn] = state;
    this.active = fadeIn;
    this.token++;
    return { fadeIn, fadeOut, state, reuse, token: this.token };
  }

  current(): { slot: number; state: MusicState } | null {
    const state = this.active >= 0 ? this.slots[this.active] : null;
    return state ? { slot: this.active, state } : null;
  }

  /** True only for the latest plan and only for a slot that is not the active one. */
  shouldStop(slot: number, token: number): boolean {
    return token === this.token && slot !== this.active;
  }

  /** Invalidates every pending stop (pause, hide, dispose). The active slot is kept for resuming. */
  cancel(): void {
    this.token++;
  }
}
