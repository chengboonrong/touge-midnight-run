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
  private disposed = false;

  constructor(ctx: AudioContext, bus: AudioNode, state: MusicState, level: number) {
    this.ctx = ctx;
    this.state = state;
    this.level = level;
    try { for (let i = 0; i < 2; i++) {
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
    } } catch (error) { this.dispose(); throw error; }
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
    const current = this.planner.current();
    const param = current ? this.gains[current.slot]?.gain : undefined;
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
    if (current && current.state === this.state) {
      this.fade(current.slot, this.level);
      this.play(current.slot);
    } else this.start();
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
    const change = this.planner.request(this.state);
    if (!change) return;
    const el = this.els[change.fadeIn];
    if (!el) return;
    if (!change.reuse) el.src = MUSIC_TRACKS[change.state];
    this.fade(change.fadeIn, this.level);
    this.play(change.fadeIn);
    this.clearTimer();
    const out = change.fadeOut;
    if (out < 0) return;
    this.fade(out, 0);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.planner.shouldStop(out, change.token)) this.els[out]?.pause();
    }, CROSSFADE_SECONDS * 1000 + 100);
  }

  private play(slot: number): void {
    const el = this.els[slot];
    if (!el) return;
    try {
      const started = el.play();
      if (started) {
        started.then(
          () => { this.blocked = false; if (this.disposed || !this.active) el.pause(); },
          (error: unknown) => { this.blocked = (error as { name?: string } | null)?.name === 'NotAllowedError'; },
        );
      }
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
