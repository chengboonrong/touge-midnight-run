/**
 * Temporary, original synthesized SFX: oscillators plus one generated noise
 * buffer. No samples and no music. Owns one AudioContext, created on the first
 * user gesture. The node graph is built once; per frame only AudioParams move.
 */
import {
  engineFrequency, engineLayers, engineLevel, groundedFraction, masterLevel,
  parseAudioPrefs, parseVolume, roadLevel, rpmFraction, tireLevel, windLevel,
} from './audioMath';
import type { AudioPrefs, EngineLike, WheelLike } from './audioMath';
import { AutomationThrottle, ContextGate, targetChanged } from './audioState';

const STORAGE_KEY = 'touge.audio';
/** Idle, low, mid, high layers: pitch multiple of the firing frequency, waveform, level. */
const LAYER_MULT = [0.5, 1, 1.5, 2];
const LAYER_TYPE: OscillatorType[] = ['triangle', 'sawtooth', 'square', 'sawtooth'];
const LAYER_LEVEL = [0.5, 0.3, 0.16, 0.14];

export type AudioStatus = 'locked' | 'unavailable' | 'suspended' | 'muted' | 'playing' | 'closed';

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  engineGain: GainNode;
  engineFilter: BiquadFilterNode;
  oscillators: OscillatorNode[];
  layerGains: GainNode[];
  tireGain: GainNode;
  tireFilter: BiquadFilterNode;
  roadGain: GainNode;
  windGain: GainNode;
  fxGain: GainNode;
  fxFilter: BiquadFilterNode;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
}

function buildGraph(ctx: AudioContext): Graph {
  const nodes: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];
  const gain = (to: AudioNode): GainNode => {
    const node = ctx.createGain();
    node.gain.value = 0;
    node.connect(to);
    nodes.push(node);
    return node;
  };
  const filter = (type: BiquadFilterType, frequency: number, q: number, to: AudioNode): BiquadFilterNode => {
    const node = ctx.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    node.Q.value = q;
    node.connect(to);
    nodes.push(node);
    return node;
  };
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.ratio.value = 6;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.2;
  compressor.connect(ctx.destination);
  nodes.push(compressor);
  const master = gain(compressor);

  const engineFilter = filter('lowpass', 600, 0.7, master);
  const engineGain = gain(engineFilter);
  const oscillators: OscillatorNode[] = [];
  const layerGains: GainNode[] = [];
  LAYER_MULT.forEach((mult, i) => {
    const osc = ctx.createOscillator();
    osc.type = LAYER_TYPE[i] ?? 'sawtooth';
    osc.frequency.value = 30 * mult;
    const layer = gain(engineGain);
    osc.connect(layer);
    osc.start();
    oscillators.push(osc);
    layerGains.push(layer);
    nodes.push(osc);
    sources.push(osc);
  });

  // One reusable two-second white noise buffer from a fixed-seed generator.
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 0x2f6e2b1;
  for (let i = 0; i < data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    data[i] = seed / 2147483648;
  }
  const noise = (to: AudioNode, offset: number): void => {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(to);
    source.start(0, offset);
    nodes.push(source);
    sources.push(source);
  };
  const tireGain = gain(master);
  const tireFilter = filter('bandpass', 1100, 4, tireGain);
  noise(tireFilter, 0);
  const roadGain = gain(master);
  noise(filter('lowpass', 180, 0.5, roadGain), 0.5);
  const windGain = gain(master);
  noise(filter('bandpass', 520, 0.5, windGain), 1);
  const fxGain = gain(master);
  const fxFilter = filter('lowpass', 300, 0.7, fxGain);
  noise(fxFilter, 1.5);

  return { ctx, master, engineGain, engineFilter, oscillators, layerGains, tireGain, tireFilter, roadGain, windGain, fxGain, fxFilter, sources, nodes };
}

function loadPrefs(): AudioPrefs {
  try {
    return parseAudioPrefs(localStorage.getItem(STORAGE_KEY));
  } catch {
    return parseAudioPrefs(null);
  }
}

export class GameAudio {
  private readonly win: Window;
  private readonly page: Document;
  private readonly prefs: AudioPrefs = loadPrefs();
  private readonly layers = [0, 0, 0, 0];
  private graph: Graph | null = null;
  private paused = false;
  private gate: ContextGate | null = null;
  private readonly throttle = new AutomationThrottle();
  /** Last scheduled target per continuous param slot; NaN until first scheduled. */
  private readonly targets = new Float64Array(14).fill(NaN);
  private failed = false;
  private disposed = false;
  private lastGear = 0;
  private lastHandbrake = false;

  constructor(win: Window, page: Document) {
    this.win = win;
    this.page = page;
    // Capture phase, so gestures on touch buttons and the options menu count too.
    win.addEventListener('pointerdown', this.unlock, true);
    win.addEventListener('pointerup', this.unlock, true);
    win.addEventListener('keydown', this.unlock, true);
    win.addEventListener('pageshow', this.apply);
    win.addEventListener('pagehide', this.onPageHide);
    page.addEventListener('visibilitychange', this.apply);
    this.publish();
  }

  get volume(): number { return this.prefs.volume; }
  get muted(): boolean { return this.prefs.muted; }

  /** locked = no gesture yet; suspended = paused or hidden; muted = running but silent. */
  get status(): AudioStatus {
    if (this.disposed) return 'closed';
    if (this.failed) return 'unavailable';
    if (!this.graph) return 'locked';
    if (this.paused || this.page.visibilityState !== 'visible' || this.graph.ctx.state !== 'running') return 'suspended';
    return masterLevel(this.prefs) > 0 ? 'playing' : 'muted';
  }

  setVolume(value: number): void {
    this.prefs.volume = parseVolume(value);
    this.save();
  }

  setMuted(muted: boolean): void {
    this.prefs.muted = muted === true;
    this.save();
  }

  /** True while the menu is open: master goes silent at once and the context suspends. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.apply();
  }

  /** Per rendered frame. Only retargets AudioParams; creates no nodes and never resumes. */
  update(engine: EngineLike, wheels: ReadonlyArray<WheelLike>, speed: number, throttle: number, handbrake: boolean): void {
    const shifted = engine.gear > 0 && this.lastGear > 0 && engine.gear !== this.lastGear;
    const handEdge = handbrake !== this.lastHandbrake;
    this.lastGear = engine.gear;
    this.lastHandbrake = handbrake;
    const g = this.graph;
    if (!g || this.paused || g.ctx.state !== 'running') return;
    const t = g.ctx.currentTime;
    // Continuous targets: at most ~30 Hz and only when they moved. Shift/handbrake thumps below are never throttled.
    if (this.throttle.due(t)) {
      const fraction = rpmFraction(engine.rpm, engine.idleRpm, engine.redlineRpm);
      const frequency = engineFrequency(engine.rpm);
      engineLayers(fraction, this.layers);
      for (let i = 0; i < g.oscillators.length; i++) {
        const osc = g.oscillators[i];
        const layer = g.layerGains[i];
        if (osc) this.aim(i, osc.frequency, frequency * (LAYER_MULT[i] ?? 1), t, 0.03);
        if (layer) this.aim(4 + i, layer.gain, (this.layers[i] ?? 0) * (LAYER_LEVEL[i] ?? 0), t, 0.06);
      }
      const level = engineLevel(fraction, throttle, engine.shifting, engine.limiting);
      this.aim(8, g.engineGain.gain, 0.5 * level, t, 0.08);
      this.aim(9, g.engineFilter.frequency, 400 + 3200 * fraction * level, t, 0.08);
      const tire = tireLevel(wheels);
      this.aim(10, g.tireGain.gain, 0.3 * tire, t, 0.06);
      this.aim(11, g.tireFilter.frequency, 900 + 500 * tire, t, 0.1);
      this.aim(12, g.roadGain.gain, 0.3 * roadLevel(speed, groundedFraction(wheels)), t, 0.1);
      this.aim(13, g.windGain.gain, 0.18 * windLevel(speed), t, 0.2);
    }
    if (shifted) this.thump(g, t, 260, 0.35);
    else if (handEdge) this.thump(g, t, handbrake ? 700 : 400, handbrake ? 0.3 : 0.12);
  }

  /** A low thump for a real collision, strength 0..1. Reuses the fx path; silent while locked, paused, hidden or muted. */
  impact(strength: number): void {
    const g = this.graph;
    const s = Math.min(1, Math.max(0, strength));
    if (!g || !(s > 0) || this.paused || this.page.visibilityState !== 'visible' || g.ctx.state !== 'running') return;
    this.thump(g, g.ctx.currentTime, 140, 0.35 + 0.55 * s, 0.07);
  }

  /** Removes every listener, stops and disconnects the graph and closes the context. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.win.removeEventListener('pointerdown', this.unlock, true);
    this.win.removeEventListener('pointerup', this.unlock, true);
    this.win.removeEventListener('keydown', this.unlock, true);
    this.win.removeEventListener('pageshow', this.apply);
    this.win.removeEventListener('pagehide', this.onPageHide);
    this.page.removeEventListener('visibilitychange', this.apply);
    const g = this.graph;
    this.graph = null;
    this.gate = null;
    if (g) {
      g.ctx.onstatechange = null;
      for (const source of g.sources) {
        try { source.stop(); } catch { /* already stopped */ }
      }
      for (const node of g.nodes) node.disconnect();
      g.ctx.close().catch(() => undefined);
    }
    this.publish();
  }

  /** Schedules a smoothed target only when it is finite and differs from the last one scheduled for this slot. */
  private aim(slot: number, param: AudioParam, value: number, t: number, timeConstant: number): void {
    if (!targetChanged(this.targets[slot] ?? NaN, value)) return;
    this.targets[slot] = value;
    param.setTargetAtTime(value, t, timeConstant);
  }

  /** A short filtered noise burst on the preallocated fx path. */
  private thump(g: Graph, t: number, frequency: number, level: number, decay = 0.035): void {
    g.fxFilter.frequency.setValueAtTime(frequency, t);
    g.fxGain.gain.cancelScheduledValues(t);
    g.fxGain.gain.setTargetAtTime(level, t, 0.004);
    g.fxGain.gain.setTargetAtTime(0, t + 0.03, decay);
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs));
    } catch {
      // Storage is unavailable; the choice lasts for this session only.
    }
    this.apply();
  }

  private publish(): void {
    if (this.page.body) this.page.body.dataset.audio = this.status;
  }

  private readonly onPageHide = (event: PageTransitionEvent): void => {
    // A page going into the back/forward cache must stay usable when restored.
    if (!event.persisted) this.dispose();
  };

  /** Any user gesture: build the graph once, then try to reach the wanted state. */
  private readonly unlock = (event?: Event): void => {
    if (this.disposed) return;
    if (!this.graph && !this.failed) {
      let ctx: AudioContext | null = null;
      try {
        ctx = new AudioContext();
        this.graph = buildGraph(ctx);
        this.gate = new ContextGate(ctx, changed => { if (changed) this.apply(); else this.publish(); });
        ctx.onstatechange = this.apply;
      } catch {
        this.failed = true;
        ctx?.close().catch(() => undefined);
      }
    }
    // Held-key repeats are not fresh gestures; they must not stack resume() calls.
    this.sync(!(event && (event as KeyboardEvent).repeat === true));
  };

  /**
   * Moves master gain and context state towards what is wanted now. Runs on
   * gestures, menu toggles, visibility and context state changes, never per
   * frame. Master is zero whenever paused or hidden, so a resume that lands
   * after a pause is silent and is suspended again when it settles.
   */
  private readonly apply = (): void => this.sync(false);

  /** gesture = called from a real input event, which may retry a resume that is still pending. */
  private sync(gesture: boolean): void {
    const g = this.graph;
    if (!g || this.disposed) { this.publish(); return; }
    const ctx = g.ctx;
    const want = !this.paused && this.page.visibilityState === 'visible';
    const now = ctx.currentTime;
    g.master.gain.cancelScheduledValues(now);
    if (want) g.master.gain.setTargetAtTime(masterLevel(this.prefs), now, 0.04);
    else g.master.gain.setValueAtTime(0, now);
    this.gate?.sync(want, gesture);
    this.publish();
  }
}
