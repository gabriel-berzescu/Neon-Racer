/**
 * Master graph: per-source -> buses (engine, effects, ui) -> master -> gentle compressor -> soft limiter -> destination. Works on any
 * BaseAudioContext (live or offline).
 *
 * Xeno-Racer's src/audio/graph.ts without the music buses. Xeno-Racer has a slider per bus; Neon-Racer has one volume, the master, and
 * keeps the buses where Xeno-Racer's defaults put them (DEFAULT_MIX), so the car sits against the interface sounds as it does there.
 */

/** The levels of the buses, 0..1 slider values (through volumeCurve). */
export interface Mix {
  master: number;
  engine: number;
  effects: number;
  ui: number;
}

/** Xeno-Racer's default audio settings (src/core/settings.ts there), its music sliders left out. */
export const DEFAULT_MIX: Mix = { master: 0.85, engine: 0.9, effects: 0.85, ui: 0.6 };

export interface MasterGraph {
  readonly ctx: BaseAudioContext;
  readonly engineBus: GainNode;
  readonly effectsBus: GainNode;
  readonly uiBus: GainNode;
  readonly master: GainNode;
  readonly compressor: DynamicsCompressorNode;
  readonly limiter: WaveShaperNode;
  setMix(v: Mix, immediate?: boolean): void;
  /** Mutes the engine and effects buses (the cars), not the interface. */
  setPaused(p: boolean): void;
  dispose(): void;
}

/** Perceptual-ish slider curve: 0..1 -> gain. */
export function volumeCurve(x: number): number {
  const v = Math.min(Math.max(Number.isFinite(x) ? x : 0, 0), 1);
  return v * v;
}

/**
 * Transparent below ~0.8, then a smooth knee towards +-1: nothing can ever leave the destination
 * above full scale (inputs beyond +-1 clamp to the curve ends).
 */
export function makeLimiterCurve(points = 4097): Float32Array<ArrayBuffer> {
  const c = new Float32Array(points);
  const knee = 0.8;
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
    c[i] = Math.sign(x) * y;
  }
  return c;
}

export function buildMasterGraph(ctx: BaseAudioContext, v: Mix = DEFAULT_MIX, opts: { raw?: boolean } = {}): MasterGraph {
  const mk = (): GainNode => ctx.createGain();
  const engineBus = mk();
  const effectsBus = mk();
  const uiBus = mk();
  const master = mk();
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -12;
  compressor.knee.value = 14;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.004;
  compressor.release.value = 0.16;
  const limiter = ctx.createWaveShaper();
  limiter.curve = makeLimiterCurve();
  limiter.oversample = '2x';

  engineBus.connect(master);
  effectsBus.connect(master);
  uiBus.connect(master);
  if (opts.raw) {
    // analysis mode: no compressor / limiter in the path
    master.connect(ctx.destination);
  } else {
    master.connect(compressor);
    compressor.connect(limiter);
    limiter.connect(ctx.destination);
  }

  let mix = v;
  let paused = false;
  const apply = (immediate: boolean): void => {
    const t = ctx.currentTime;
    const tc = immediate ? 0.001 : 0.04;
    const carsMul = paused ? 0 : 1;
    master.gain.setTargetAtTime(volumeCurve(mix.master), t, tc);
    engineBus.gain.setTargetAtTime(volumeCurve(mix.engine) * carsMul, t, paused ? 0.06 : tc);
    effectsBus.gain.setTargetAtTime(volumeCurve(mix.effects) * carsMul, t, paused ? 0.06 : tc);
    uiBus.gain.setTargetAtTime(volumeCurve(mix.ui), t, tc);
  };
  // initial values without a ramp
  master.gain.value = volumeCurve(v.master);
  engineBus.gain.value = volumeCurve(v.engine);
  effectsBus.gain.value = volumeCurve(v.effects);
  uiBus.gain.value = volumeCurve(v.ui);

  return {
    ctx,
    engineBus,
    effectsBus,
    uiBus,
    master,
    compressor,
    limiter,
    setMix(nv, immediate = false): void {
      mix = nv;
      apply(immediate);
    },
    setPaused(p): void {
      if (p === paused) return;
      paused = p;
      apply(false);
    },
    dispose(): void {
      for (const n of [engineBus, effectsBus, uiBus, master, compressor, limiter]) n.disconnect();
    },
  };
}
