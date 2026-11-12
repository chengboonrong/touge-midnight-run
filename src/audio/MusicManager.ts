/**
 * Streams the looping score through exactly two media elements, each with one
 * MediaElementAudioSourceNode and one GainNode on GameAudio's compressor bus.
 * No second AudioContext, no per-frame work, no buffer decoding. Load or play
 * failures (missing file, autoplay refusal) are swallowed: the game runs without music.
 */
import { CROSSFADE_SECONDS, MUSIC_TRACKS, MusicPlanner } from './musicState';
import type { MusicState } from './musicState';

export class MusicManager {
  private readonly ctx: AudioContext;
  private readonly els: HTMLAudioElement[] = [];
  private readonly sources: MediaElementAudioSourceNode[] = [];
  private readonly gains: GainNode[] = [];
  private readonly planner = new MusicPlanner();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: MusicState;
  private level: number;
  private active = false;
  private blocked = false;
  /** Slot audible now, or -1. An incoming slot becomes live only when its play() settles. */
  private live = -1;
  /** Bumped by every play attempt and halt, so late play promises and delayed stops are ignored. */
  private gen = 0;
  private disposed = false;

  constructor(ctx: AudioContext, bus: AudioNode, state: MusicState, level: number) {
    this.ctx = ctx;
    this.state = state;
    this.level = level;
    try {
      for (let i = 0; i < 2; i++) {
        const el = new Audio();
        this.els.push(el);
        el.loop = true;
        el.preload = 'none';
        const source = ctx.createMediaElementSource(el);
        this.sources.push(source);
        const gain = ctx.createGain();
        this.gains.push(gain);
        gain.gain.value = 0;
        source.connect(gain);
        gain.connect(bus);
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /** Remembers the wanted track; crossfades at once only while active. */
  setState(state: MusicState): void {
    this.state = state;
    if (this.active && !this.disposed) this.start();
  }

  setLevel(level: number): void {
    if (level === this.level) return;
    this.level = level;
    // Mute applies to both slots, including an outgoing crossfade.
    if (level === 0) {
      for (const gain of this.gains) {
        gain.gain.cancelScheduledValues(this.ctx.currentTime);
        gain.gain.setValueAtTime(0, this.ctx.currentTime);
      }
      return;
    }
    const param = this.gains[this.live]?.gain;
    if (!this.active || this.disposed || !param) return;
    const t = this.ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setTargetAtTime(level, t, 0.04);
  }

  /** False while paused or hidden: both gains drop to zero and both elements pause immediately. */
  setActive(active: boolean): void {
    if (this.disposed) return;
    const current = this.planner.current();
    if (active === this.active) {
      // A refused autoplay is retried on later gestures, never per frame.
      if (active && this.blocked && current) { this.blocked = false; this.play(current.slot); }
      return;
    }
    this.active = active;
    if (!active) { this.halt(); return; }
    if (current && current.state === this.state) this.play(current.slot);
    else this.start();
  }

  dispose(): void {
    if (this.disposed) return;
    this.active = false;
    this.halt();
    this.disposed = true;
    for (const el of this.els) {
      el.removeAttribute('src');
      try { el.load(); } catch { /* nothing to release */ }
    }
    for (const node of this.sources) node.disconnect();
    for (const node of this.gains) node.disconnect();
  }

  private start(): void {
    const change = this.planner.request(this.state, this.live);
    if (!change) return;
    const el = this.els[change.fadeIn];
    if (!el) return;
    if (!change.reuse) el.src = MUSIC_TRACKS[change.state];
    // The old track stays audible until the incoming one really starts.
    this.play(change.fadeIn);
  }

  /** The slot's play() settled for the latest attempt: crossfade now, stop the other slot afterwards. */
  private arrive(slot: number, gen: number): void {
    this.blocked = false;
    this.live = slot;
    this.fade(slot, this.level);
    this.fade(1 - slot, 0);
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (gen === this.gen) this.els[1 - slot]?.pause();
    }, CROSSFADE_SECONDS * 1000 + 100);
  }

  private play(slot: number): void {
    const el = this.els[slot];
    if (!el) return;
    const gen = ++this.gen;
    const fresh = (): boolean => gen === this.gen && this.active && !this.disposed;
    try {
      const started = el.play();
      if (started) {
        started.then(
          () => {
            if (fresh()) this.arrive(slot, gen);
            // Stale: never leave a slot playing that is neither audible nor the wanted one.
            else if (this.disposed || !this.active || (slot !== this.live && slot !== this.planner.current()?.slot)) el.pause();
          },
          (error: unknown) => { if (fresh()) this.blocked = (error as { name?: string } | null)?.name === 'NotAllowedError'; },
        );
      } else this.arrive(slot, gen);
    } catch {
      // No playback support: stay silent.
    }
  }

  private fade(slot: number, target: number): void {
    const param = this.gains[slot]?.gain;
    if (!param) return;
    const t = this.ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(target, t + CROSSFADE_SECONDS);
  }

  private halt(): void {
    this.clearTimer();
    this.gen++;
    this.live = -1;
    this.planner.cancel();
    const t = this.ctx.currentTime;
    for (const gain of this.gains) {
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(0, t);
    }
    for (const el of this.els) el.pause();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
