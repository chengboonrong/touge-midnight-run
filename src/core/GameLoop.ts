/**
 * Fixed-timestep game loop (accumulator pattern).
 *
 * - fixedUpdate(dt) runs zero or more times per frame, always with the same dt.
 * - render(alpha, frameDt) runs once per frame. alpha is in [0, 1) and says how
 *   far the current frame is between the previous and the latest physics state.
 * - Frame time is clamped, so a long hitch or a background tab slows the
 *   simulation down instead of triggering a burst of catch-up steps.
 */

export interface GameLoopCallbacks {
  fixedUpdate: (dt: number) => void;
  render: (alpha: number, frameDt: number) => void;
}

export interface GameLoopOptions {
  /** Simulation rate in Hz. Default 60. */
  fixedHz?: number;
  /** Longest frame time fed to the accumulator, in seconds. Default 0.1. */
  maxFrameTime?: number;
}

export class GameLoop {
  readonly fixedDt: number;

  private readonly callbacks: GameLoopCallbacks;
  private readonly maxFrameTime: number;
  private accumulator = 0;
  private lastMs = -1;
  private rafId = 0;
  private running = false;

  constructor(callbacks: GameLoopCallbacks, options: GameLoopOptions = {}) {
    this.callbacks = callbacks;
    this.fixedDt = 1 / (options.fixedHz ?? 60);
    this.maxFrameTime = options.maxFrameTime ?? 0.1;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.accumulator = 0;
    this.lastMs = -1; // first tick only records the timestamp
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private readonly tick = (nowMs: number): void => {
    if (!this.running) return;

    if (this.lastMs < 0) this.lastMs = nowMs;
    let frameDt = (nowMs - this.lastMs) / 1000;
    this.lastMs = nowMs;

    if (frameDt < 0) frameDt = 0;
    if (frameDt > this.maxFrameTime) frameDt = this.maxFrameTime;

    this.accumulator += frameDt;
    while (this.accumulator >= this.fixedDt) {
      this.callbacks.fixedUpdate(this.fixedDt);
      this.accumulator -= this.fixedDt;
    }

    this.callbacks.render(this.accumulator / this.fixedDt, frameDt);

    // Scheduled last on purpose: if a callback throws, the loop stops
    // instead of logging the same error every frame.
    this.rafId = requestAnimationFrame(this.tick);
  };
}
