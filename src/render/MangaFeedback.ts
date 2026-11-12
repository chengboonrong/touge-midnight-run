/**
 * Restrained manga feedback: static speed streaks at the screen edge, brief corner strokes on a real
 * impact and a short CLOSE CALL word on a real near miss. One overlay above the canvas and below the HUD.
 * Only opacity changes, driven from the main render call: no timers, no animation frames, no per-frame DOM nodes.
 *
 * No imports on purpose: the Node tests transpile this file and use MangaState without a DOM.
 */
export const MANGA = {
  streakFrom: 20, streakFull: 36, streakMax: 0.12,
  impactMin: 0.55, impactMax: 0.12, impactDecay: 0.1, impactCooldown: 0.5,
  nearTime: 0.3, nearFade: 0.1, maxDt: 0.25,
} as const;

/** Streak opacity for a planar speed in m/s: 0 up to 20 m/s, linear to 0.12 at 36 m/s and above. */
export function streakOpacity(speed: number): number {
  if (!Number.isFinite(speed)) return 0;
  const t = Math.min(1, Math.max(0, (speed - MANGA.streakFrom) / (MANGA.streakFull - MANGA.streakFrom)));
  return MANGA.streakMax * t;
}

/** Pure feedback state. Pulses start only from impact() and nearMiss(); update() only decays them. */
export class MangaState {
  streak = 0;
  impactAlpha = 0;
  nearAlpha = 0;
  low = false;
  reduced = false;
  private cooldown = 0;
  private nearLeft = 0;

  /** True if the corner strokes fired: strength above 0.55, at most every 0.5 s, never in low quality or reduced motion. */
  impact(strength: number): boolean {
    if (this.low || this.reduced || !(strength > MANGA.impactMin) || this.cooldown > 1e-9) return false;
    this.cooldown = MANGA.impactCooldown;
    this.impactAlpha = MANGA.impactMax * Math.min(1, strength);
    return true;
  }

  /** True if the word is shown for the next 0.3 s. Off under reduced motion. */
  nearMiss(): boolean {
    if (this.reduced) return false;
    this.nearLeft = MANGA.nearTime;
    this.nearAlpha = 1;
    return true;
  }

  /** Advances event time by dt (s, clamped) and maps speed (m/s) to the streak opacity. */
  update(dt: number, speed: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, MANGA.maxDt) : 0;
    this.cooldown = Math.max(0, this.cooldown - step);
    const alpha = this.impactAlpha * Math.exp(-step / MANGA.impactDecay);
    this.impactAlpha = alpha > 0.001 ? alpha : 0;
    this.nearLeft = Math.max(0, this.nearLeft - step);
    this.nearAlpha = Math.min(1, this.nearLeft / MANGA.nearFade);
    this.streak = this.low || this.reduced ? 0 : streakOpacity(speed);
  }

  setLow(low: boolean): void {
    this.low = low;
    if (low) { this.impactAlpha = 0; this.streak = 0; }
  }

  setReduced(reduced: boolean): void {
    this.reduced = reduced;
    if (reduced) { this.streak = 0; this.impactAlpha = 0; this.nearLeft = 0; this.nearAlpha = 0; }
  }

  reset(): void {
    this.streak = 0;
    this.impactAlpha = 0;
    this.nearAlpha = 0;
    this.cooldown = 0;
    this.nearLeft = 0;
  }
}

export class MangaFeedback {
  readonly state = new MangaState();
  private readonly root: HTMLElement;
  private readonly parts: HTMLElement[];
  private readonly shown = [0, 0, 0];
  private readonly media: MediaQueryList | null;
  private disposed = false;

  constructor(page: Document, initialQuality: string) {
    // 14 fixed radial strokes in the outer band of the screen; the centre stays clear.
    let streaks = '';
    for (let i = 0; i < 14; i++) {
      const a = ((i + 0.5) / 14) * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
      const k = 50 / Math.max(Math.abs(dx), Math.abs(dy)), inner = k * (0.8 + 0.05 * (i % 3));
      streaks += `<path d="M${(50 + dx * k).toFixed(1)} ${(50 + dy * k).toFixed(1)}L${(50 + dx * inner).toFixed(1)} ${(50 + dy * inner).toFixed(1)}"/>`;
    }
    const root = page.createElement('div');
    root.className = 'manga';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false"><g data-m class="manga__streaks">${streaks}</g>`
      + '<g data-m class="manga__impact"><path d="M2 12V2H10M90 2H98V12M98 88V98H90M10 98H2V88"/></g></svg>'
      + '<div data-m class="manga__near">CLOSE CALL</div>';
    page.body.append(root);
    this.root = root;
    this.parts = Array.from(root.querySelectorAll<HTMLElement>('[data-m]'));
    this.state.low = initialQuality === 'low';
    this.media = page.defaultView?.matchMedia('(prefers-reduced-motion: reduce)') ?? null;
    this.state.reduced = this.media?.matches === true;
    this.media?.addEventListener('change', this.onMedia);
  }

  /** A real collision, strength 0..1 from ImpactFeedback. */
  impact(strength: number): void { if (!this.disposed) this.state.impact(strength); }
  /** A real near-miss event from the NearMiss detector. */
  nearMiss(): void { if (!this.disposed) this.state.nearMiss(); }
  setQuality(quality: string): void { this.state.setLow(quality === 'low'); }
  reset(): void { this.state.reset(); }

  /** Once per rendered frame. Paused: event time is frozen and the last opacities stay. */
  render(dt: number, speed: number, paused = false): void {
    if (this.disposed) return;
    const s = this.state;
    if (!paused) s.update(dt, speed);
    this.put(0, s.streak);
    this.put(1, s.impactAlpha);
    this.put(2, s.nearAlpha);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.media?.removeEventListener('change', this.onMedia);
    this.root.remove();
  }

  private readonly onMedia = (): void => { this.state.setReduced(this.media?.matches === true); };

  /** Writes an opacity only when it moved by more than 0.002 or reached zero. */
  private put(index: number, value: number): void {
    const v = value >= 0.002 ? value : 0, last = this.shown[index] ?? 0, part = this.parts[index];
    if (!part || (Math.abs(v - last) <= 0.002 && (v !== 0 || last === 0))) return;
    this.shown[index] = v;
    part.style.opacity = v.toFixed(3);
  }
}
