/**
 * Race presentation layer: timing lines on the left, countdown and notices in
 * the centre. It never takes input (pointer-events: none) and does not touch
 * the existing Hud. No DOM access at import time.
 *
 * Integration contract for main.ts (next increment):
 *  - construct once: new RaceHud(document)
 *  - after each fixed step: for (const e of session.drainEvents()) raceHud.handleEvent(e)
 *  - once per rendered frame: raceHud.render(session, drift, frameDt, menuOpen)
 * Event text is written at once; continuous text at ~10 Hz and only when it
 * changed. Event lifetimes run on frameDt and freeze while paused.
 */
import type { RaceEvent, RaceSession } from '../race/RaceSession';
import type { DriftScore } from '../race/DriftScore';

/** m:ss.cc, truncated to hundredths. */
export function formatRaceTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-:--.--';
  const c = Math.floor(seconds * 100 + 1e-6);
  const s = Math.floor((c % 6000) / 100);
  return `${Math.floor(c / 6000)}:${String(s).padStart(2, '0')}.${String(c % 100).padStart(2, '0')}`;
}

/** Signed seconds against the best lap, or '' when there is no reference. */
export function formatSplit(delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return '';
  const rounded = Math.round(delta * 100) / 100;
  return `${rounded < 0 ? '-' : '+'}${Math.abs(rounded).toFixed(2)}`;
}

const REFRESH_SECONDS = 0.1;
const MARKUP = '<section class="race-panel"><span class="race-panel__title"></span><span class="race-panel__time"></span>'
  + '<span class="race-panel__sectors" aria-hidden="true"><i></i><i></i><i></i></span><span class="race-panel__split"></span>'
  + '<span class="race-panel__best"></span><span class="race-panel__drift"></span></section>'
  + '<div class="race-count" role="status" aria-live="polite"></div><div class="race-notice" role="status" aria-live="polite"></div>';

export class RaceHud {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly time: HTMLElement;
  private readonly split: HTMLElement;
  private readonly best: HTMLElement;
  private readonly drift: HTMLElement;
  private readonly count: HTMLElement;
  private readonly notice: HTMLElement;
  /** Last value written per slot, so unchanged values never touch the DOM. */
  private readonly shown = new Map<string, string>();
  private result = 'FINISH';
  private countTtl = 0;
  private noticeTtl = 0;
  private since = Infinity;

  constructor(page: Document) {
    const root = page.createElement('div');
    root.className = 'race-hud';
    root.innerHTML = MARKUP;
    page.body.appendChild(root);
    const part = (name: string): HTMLElement => root.querySelector<HTMLElement>(`.race-${name}`)!;
    this.root = root;
    this.title = part('panel__title');
    this.time = part('panel__time');
    this.split = part('panel__split');
    this.best = part('panel__best');
    this.drift = part('panel__drift');
    this.count = part('count');
    this.notice = part('notice');
  }

  /** Shows one race event immediately. */
  handleEvent(event: RaceEvent): void {
    switch (event.type) {
      case 'countdown':
        if (event.value === 3) { this.setSplit(null); this.notify('', 0); }
        this.center(String(event.value), 0.9);
        break;
      case 'go': this.center('GO', 0.8); break;
      case 'checkpoint':
        this.setSplit(event.delta);
        this.notify(`CHECKPOINT ${event.index + 1}/3`, 1.6);
        break;
      case 'invalid': this.notify(event.reason === 'offcourse' ? 'OFF COURSE / LAP INVALID' : 'LAP INVALID', 2.4); break;
      case 'finish':
        this.result = 'FINISH';
        this.setSplit(event.valid && event.previousBest !== null ? event.time - event.previousBest : null);
        this.notify(event.valid ? `FINISH ${formatRaceTime(event.time)}` : 'FINISH / NO RECORD', 3);
        break;
      case 'personalBest':
        this.result = 'NEW BEST';
        this.notify(`PERSONAL BEST ${formatRaceTime(event.time)}`, 3);
        break;
      case 'cancel': this.center('', 0); this.notify('', 0); this.setSplit(null); break;
    }
    this.since = Infinity;
  }

  /** Per rendered frame. frameDt is the frame time in seconds; paused freezes event lifetimes. */
  render(session: RaceSession, drift: DriftScore, frameDt: number, paused = false): void {
    const dt = Number.isFinite(frameDt) && frameDt > 0 ? Math.min(frameDt, 0.25) : 0;
    if (!paused) {
      if (this.countTtl > 0 && (this.countTtl -= dt) <= 0) this.put('count', this.count, '');
      if (this.noticeTtl > 0 && (this.noticeTtl -= dt) <= 0) this.put('notice', this.notice, '');
    }
    if ((this.since += dt) < REFRESH_SECONDS) return;
    this.since = 0;
    const state = session.state;
    const timed = state !== 'practice';
    this.put('state', this.root, state, 'data-state');
    this.put('passed', this.root, String(session.checkpoint), 'data-passed');
    this.put('title', this.title, state === 'finished' ? this.result : !timed ? 'PRACTICE' : session.valid ? 'TIME ATTACK' : 'LAP INVALID');
    this.put('time', this.time, timed ? formatRaceTime(session.elapsed) : '');
    const best = session.best;
    this.put('best', this.best, best ? `PB ${formatRaceTime(best.time)}` : '');
    let line = `DRIFT ${Math.round(drift.total)}`;
    if (drift.pending) line += ` +${Math.round(drift.chain)}`;
    if (drift.active) line += ` ${Math.round(Math.abs(drift.angle) * 180 / Math.PI)}\u00b0`;
    this.put('drift', this.drift, line);
    this.put('active', this.root, drift.active ? '1' : '0', 'data-drift');
  }

  private center(text: string, seconds: number): void {
    this.put('count', this.count, text);
    this.countTtl = seconds;
  }

  private notify(text: string, seconds: number): void {
    this.put('notice', this.notice, text);
    this.noticeTtl = seconds;
  }

  private setSplit(delta: number | null): void {
    this.put('split', this.split, formatSplit(delta));
    this.put('sign', this.split, delta !== null && delta > 0 ? 'behind' : 'ahead', 'data-sign');
  }

  private put(key: string, el: HTMLElement, value: string, attr?: string): void {
    if (this.shown.get(key) === value) return;
    this.shown.set(key, value);
    if (attr) el.setAttribute(attr, value); else el.textContent = value;
  }
}
