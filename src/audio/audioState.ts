/**
 * Audio lifecycle helpers. No Web Audio and no imports, so the Node tests
 * transpile and run this file standalone.
 */

export interface ContextLike {
  readonly state: string;
  resume(): Promise<unknown>;
  suspend(): Promise<unknown>;
}

/**
 * Moves one context towards running (want) or suspended. A resume that is
 * still pending (for example started by a key that grants no activation) never
 * blocks a later gesture from retrying, and a pause during a pending resume
 * still suspends. `settled(changed)` fires after every attempt; the owner
 * syncs again only when the state changed, so a no-op settle cannot loop.
 */
export class ContextGate {
  private readonly ctx: ContextLike;
  private readonly settled: (changed: boolean) => void;
  private pending: 'resume' | 'suspend' | null = null;
  private token = 0;

  constructor(ctx: ContextLike, settled: (changed: boolean) => void) {
    this.ctx = ctx;
    this.settled = settled;
  }

  sync(want: boolean, gesture = false): void {
    const before = this.ctx.state;
    if (before === 'closed') return;
    let op: 'resume' | 'suspend' | null = null;
    if (want) {
      if (before !== 'running' && (gesture || this.pending !== 'resume')) op = 'resume';
    } else if (this.pending !== 'suspend' && (before === 'running' || this.pending === 'resume')) {
      op = 'suspend';
    }
    if (!op) return;
    const token = ++this.token;
    this.pending = op;
    let change: Promise<unknown>;
    try {
      change = op === 'resume' ? this.ctx.resume() : this.ctx.suspend();
    } catch (error) {
      change = Promise.reject(error);
    }
    const finish = (ok: boolean): void => {
      if (token === this.token) this.pending = null;
      this.settled(ok && this.ctx.state !== before);
    };
    change.then(() => finish(true), () => finish(false));
  }
}

/** Limits continuous AudioParam scheduling to about 30 Hz of context time. */
export class AutomationThrottle {
  private readonly interval: number;
  private last = -Infinity;

  constructor(hz = 30) {
    this.interval = 1 / hz - 1e-4;
  }

  due(now: number): boolean {
    if (now >= this.last && now - this.last < this.interval) return false;
    this.last = now;
    return true;
  }
}

/** True when a finite target differs enough from the last scheduled one (0.1 %, or any move to exact zero). */
export function targetChanged(last: number, next: number): boolean {
  if (!Number.isFinite(next)) return false;
  if (!Number.isFinite(last)) return true;
  if (next === 0) return last !== 0;
  return Math.abs(next - last) > 0.001 * Math.max(1, Math.abs(next));
}
