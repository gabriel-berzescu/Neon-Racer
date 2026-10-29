/**
 * Neon-Racer's sound: Xeno-Racer's car sound, brought over for one player's car.
 *
 *   const sound = new Sound();
 *   sound.setCar(def)                          the player's car (its voice), null for none
 *   sound.update(state, dt, { paused })        every rendered frame
 *   sound.setListener(camera)                  optional, every frame: where the camera is (default: the chase camera's place)
 *   sound.setInterior(on)                      optional: a cockpit view (the single-seaters' helmets, a closed car's cabin)
 *   sound.setVolume(v); sound.ui('select')
 *
 * The car's voice is an AudioWorklet (engine.worklet.ts): the engine (dsp/engine-voice.ts, every car's EngineSoundProfile) and its chassis
 * (dsp/chassis-voice.ts: tyres, road and run-off, wind, thumps, scrape, impacts), as in Xeno-Racer, through the same graph: the voice ->
 * distance low-pass -> panner -> engine / effects bus -> master -> compressor -> soft limiter. The interface sounds (ui-sounds.ts) are
 * native nodes on their own bus, which the pause does not mute.
 *
 * What Xeno-Racer has and Neon-Racer does not is left out: the opponents and their level of detail, split screen, rain, wet roads and
 * the wiper, the menu music and the race album, the nitro (so the Volta's MGU-K never deploys: it murmurs and harvests, as there).
 *
 * Browsers start audio only after a user gesture (a click or a key; a gamepad press does not count): `locked` is true until then. A
 * sound asked for while locked is kept for half a second, so the click that unlocks the audio is heard. When nothing calls update()
 * for 0.6 s (a hidden tab stops the frames) the car is muted, as Xeno-Racer does, and comes back with the next update.
 */
import type * as THREE from 'three';
import type { CarDefinition, VehicleState } from '../core/contracts';
import workletUrl from './engine.worklet.ts?worker&url';
import { type CarNodes, CarFrame, applySpatial, createCarNodes } from './carsound';
import { CTL } from './controls';
import { calibratedExhaustGain } from './dsp/engine-voice';
import { DEFAULT_MIX, type MasterGraph, buildMasterGraph } from './graph';
import { type ListenerState, listenerFromMatrix, makeListener } from './spatial';
import { type UiSound, UiSynth } from './ui-sounds';

export type { UiSound } from './ui-sounds';
export { UI_SOUND_LIST } from './ui-sounds';

/** URL of the bundled worklet module (differs between `vite dev` and `vite build`; relative to the page's base in a build). */
export const AUDIO_WORKLET_URL: string = workletUrl;

/** The chase camera's place behind the car (render/chase-camera.ts 'chase'), where the listener is when setListener is not called. */
export const DEFAULT_LISTENER_BACK = 6.4;
export const DEFAULT_LISTENER_UP = 2.1;

const GESTURE_EVENTS = ['pointerdown', 'mousedown', 'keydown', 'touchend', 'click'] as const;
/** No update() for this long (ms): the car is muted (a hidden tab, a debugger). */
const STALE_MS = 600;

type Win = Window & { webkitAudioContext?: typeof AudioContext };

export interface SoundOptions {
  /** Use this context (an OfflineAudioContext in tests and renders) instead of making a live one; no gesture hooks, no watchdog. */
  ctx?: BaseAudioContext;
  /** Analysis: no compressor and limiter. */
  raw?: boolean;
}

export class Sound {
  readonly ctx: BaseAudioContext | null;
  private readonly graph: MasterGraph | null;
  private readonly synth: UiSynth | null;
  /** Resolves when the worklet has loaded (or failed to). */
  readonly ready: Promise<void>;
  private workletReady = false;
  private readonly owned: boolean;

  private def: CarDefinition | null = null;
  private frame: CarFrame | null = null;
  private nodes: CarNodes | null = null;
  private failed = false;
  private seed = 1;
  private interior = 0;
  private wasSilent = false;
  private offTick = 0;

  private readonly listener: ListenerState = makeListener();
  private listenerSet = false;

  private volume = DEFAULT_MIX.master;
  private paused = false;
  private stale = false;
  private lastUpdateAt = 0;
  private clock = 0;
  private lastResumeTry = -10;
  private resumePending: Promise<void> | null = null;
  private uiQueue: { s: UiSound; at: number }[] = [];
  private gestureHandler: (() => void) | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(opts: SoundOptions = {}) {
    this.owned = !opts.ctx;
    let ctx: BaseAudioContext | null = opts.ctx ?? null;
    if (!ctx && typeof window !== 'undefined') {
      try {
        const Ctor = window.AudioContext ?? (window as Win).webkitAudioContext;
        ctx = Ctor ? new Ctor({ latencyHint: 'interactive' }) : null;
      } catch (e) {
        console.warn('[audio] Web Audio is not available; running without sound:', e);
        ctx = null;
      }
    }
    this.ctx = ctx;
    if (!ctx) {
      this.graph = null;
      this.synth = null;
      this.ready = Promise.resolve();
      return;
    }
    this.graph = buildMasterGraph(ctx, DEFAULT_MIX, { raw: opts.raw });
    this.synth = new UiSynth(ctx, this.graph.uiBus);
    this.ready = ctx.audioWorklet
      .addModule(workletUrl)
      .then(() => {
        this.workletReady = true;
      })
      .catch((e: unknown) => {
        console.warn('[audio] worklet failed to load; the car will be silent:', e);
      });
    if (this.owned) {
      ctx.addEventListener('statechange', () => this.onState());
      this.onState();
      this.installGestureHooks();
      this.lastUpdateAt = performance.now();
      this.watchdog = setInterval(() => this.checkStale(), 250);
    }
  }

  /** True until the first click or key press: browsers only start audio after a user gesture (a gamepad press does not count). */
  get locked(): boolean {
    return this.ctx !== null && this.ctx.state !== 'running';
  }

  // ── the car ──────────────────────────────────────────────────────────────

  /** The player's car (its voice); null for none (menus with no car). Its engine's loudness is calibrated here, once per car model. */
  setCar(def: CarDefinition | null): void {
    if (def === this.def) return;
    this.dropVoice();
    this.def = def;
    this.failed = false;
    this.frame = def ? new CarFrame() : null;
    // (the one-off calibration of the engine, 50-200 ms the first time a car is heard: now, not in the first frame of the drive)
    if (def && this.ctx) calibratedExhaustGain(def.sound, this.ctx.sampleRate);
  }

  /** A cockpit view: the single-seaters (an open cockpit) are heard through a helmet, a closed car from its cabin. */
  setInterior(on: boolean): void {
    this.interior = on ? 1 : 0;
  }

  /**
   * Where the camera is, every frame before update() (optional). `velocity`: the camera's (default: the car's, a camera that rides with
   * it). Without it the listener sits where the chase camera does, 6.4 m behind the car and 2.1 m up, looking along it.
   */
  setListener(camera: THREE.Camera, velocity?: { x: number; y: number; z: number }): void {
    camera.updateMatrixWorld();
    listenerFromMatrix(camera.matrixWorld.elements, NaN, NaN, NaN, this.listener);
    if (velocity) {
      this.listener.vx = velocity.x;
      this.listener.vy = velocity.y;
      this.listener.vz = velocity.z;
    } else this.listener.vx = this.listener.vy = this.listener.vz = NaN;
    this.listenerSet = true;
  }

  private ensureNodes(): boolean {
    if (this.nodes) return true;
    const ctx = this.ctx;
    if (!ctx || !this.def || this.failed || !this.workletReady) return false;
    try {
      this.nodes = createCarNodes(ctx, this.graph!, { profile: this.def.sound, seed: this.seed++, openCockpit: this.def.visual.openCockpit === true });
      this.wasSilent = false;
      return true;
    } catch (e) {
      this.failed = true;
      console.warn('[audio] could not create the car voice:', e);
      return false;
    }
  }

  private dropVoice(): void {
    this.nodes?.dispose();
    this.nodes = null;
  }

  private placeListener(st: VehicleState): void {
    const L = this.listener;
    if (!this.listenerSet) {
      // the chase camera: behind the car along its heading, above it, level
      const q = st.quaternion;
      // the car's +Z in the world
      let fx = 2 * (q.x * q.z + q.w * q.y);
      let fz = 1 - 2 * (q.x * q.x + q.y * q.y);
      const l = Math.hypot(fx, fz) || 1;
      fx /= l;
      fz /= l;
      L.px = st.position.x - fx * DEFAULT_LISTENER_BACK;
      L.py = st.position.y + DEFAULT_LISTENER_UP;
      L.pz = st.position.z - fz * DEFAULT_LISTENER_BACK;
      L.fx = fx;
      L.fy = 0;
      L.fz = fz;
      L.ux = 0;
      L.uy = 1;
      L.uz = 0;
    }
    if (!this.listenerSet || !Number.isFinite(L.vx)) {
      L.vx = st.velocity.x;
      L.vy = st.velocity.y;
      L.vz = st.velocity.z;
    }
  }

  private applyListener(): void {
    const L = this.listener;
    const l = this.ctx!.listener;
    if (l.positionX) {
      l.positionX.value = L.px;
      l.positionY.value = L.py;
      l.positionZ.value = L.pz;
      l.forwardX.value = L.fx;
      l.forwardY.value = L.fy;
      l.forwardZ.value = L.fz;
      l.upX.value = L.ux;
      l.upY.value = L.uy;
      l.upZ.value = L.uz;
    } else {
      const old = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(a: number, b: number, c: number, d: number, e: number, f: number): void;
      };
      old.setPosition(L.px, L.py, L.pz);
      old.setOrientation(L.fx, L.fy, L.fz, L.ux, L.uy, L.uz);
    }
  }

  /** Every rendered frame. state = the player's car (null: none); paused mutes the car but not the interface sounds. */
  update(state: VehicleState | null, dt: number, opts: { paused: boolean }): void {
    const ctx = this.ctx;
    if (this.disposed || !ctx) return;
    this.lastUpdateAt = performance.now();
    const paused = opts.paused === true;
    if (this.stale || paused !== this.paused) {
      this.stale = false;
      this.paused = paused;
      this.graph!.setPaused(paused);
    }
    this.clock += Number.isFinite(dt) && dt > 0 ? dt : 0;
    // keep trying to resume: once the page has had a real activation, resume() is allowed from anywhere
    if (this.owned && ctx.state !== 'running' && this.clock - this.lastResumeTry > 0.5) {
      const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
      if (!ua || ua.hasBeenActive) {
        this.lastResumeTry = this.clock;
        void this.unlock();
      }
    }
    if (ctx.state !== 'running' && this.owned) return;

    const f = this.frame;
    if (!f || !state) {
      this.sleep();
      return;
    }
    this.placeListener(state);
    if (this.owned) this.applyListener();
    f.compute(state, dt, this.listener, this.interior, paused);
    if (!this.ensureNodes()) return;
    const n = this.nodes!;
    const v = f.vec;
    // a paused voice only needs an occasional refresh
    const silent = v[CTL.GAIN] < 0.001;
    if (silent) {
      if (this.wasSilent && this.offTick++ % 15 !== 0) return;
    } else this.offTick = 0;
    this.wasSilent = silent;
    n.node.port.postMessage(v);
    applySpatial(n, f.sp);
  }

  /** Push a zero-gain vector so the voice goes to sleep (no car, a stale frame). */
  private sleep(): void {
    if (!this.nodes || !this.frame) return;
    const v = this.frame.vec;
    if (v[CTL.GAIN] === 0 && v[CTL.CH_GAIN] === 0) return;
    v[CTL.GAIN] = 0;
    v[CTL.CH_GAIN] = 0;
    this.nodes.node.port.postMessage(v);
  }

  private checkStale(): void {
    if (this.disposed || this.stale) return;
    if (performance.now() - this.lastUpdateAt > STALE_MS) {
      this.stale = true;
      this.graph!.setPaused(true);
      this.sleep();
    }
  }

  // ── volume and the interface ─────────────────────────────────────────────

  /** 0..1, from the settings: the master (the buses keep Xeno-Racer's default balance, graph.ts DEFAULT_MIX). */
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
    this.graph?.setMix({ ...DEFAULT_MIX, master: this.volume });
  }

  /** Interface and race sounds. */
  ui(name: UiSound): void {
    const ctx = this.ctx;
    if (this.disposed || !ctx || !this.synth) return;
    if (ctx.state === 'running' || !this.owned) this.synth.play(name);
    else {
      // remember it briefly: the same user gesture that unlocks audio often triggers the sound
      this.uiQueue.push({ s: name, at: performance.now() });
      if (this.uiQueue.length > 3) this.uiQueue.shift();
      void this.unlock();
    }
  }

  // ── unlock ───────────────────────────────────────────────────────────────

  private installGestureHooks(): void {
    // real user gestures unlock audio even if the game only calls ui() from gamepad polling
    const h = (): void => {
      void this.unlock();
    };
    this.gestureHandler = h;
    for (const ev of GESTURE_EVENTS) window.addEventListener(ev, h, { capture: true, passive: true });
  }

  private removeGestureHooks(): void {
    const h = this.gestureHandler;
    if (!h) return;
    for (const ev of GESTURE_EVENTS) window.removeEventListener(ev, h, { capture: true });
    this.gestureHandler = null;
  }

  private onState(): void {
    if (this.ctx?.state !== 'running') return;
    this.removeGestureHooks();
    // play the interface sound(s) that came with the unlock, if they are fresh
    const now = performance.now();
    for (const q of this.uiQueue) if (now - q.at < 500) this.synth!.play(q.s);
    this.uiQueue.length = 0;
  }

  /** Try to start the audio (any user gesture does it on its own; this is for callers that know they are in one). */
  unlock(): Promise<void> {
    const ctx = this.ctx as AudioContext | null;
    if (!ctx || ctx.state === 'running') return Promise.resolve();
    if (this.resumePending) return this.resumePending;
    if (typeof ctx.resume !== 'function') return Promise.resolve();
    // resume() may stay pending when the browser does not count the trigger as a user activation (gamepad buttons): do not block
    // callers on it, and let later calls try again
    this.resumePending = new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        this.resumePending = null;
        resolve();
      };
      try {
        ctx.resume().then(finish, finish);
      } catch {
        finish();
      }
      setTimeout(finish, 300);
    });
    return this.resumePending;
  }

  /** Debugging (the sandbox's meters): an analyser on what goes out to the speakers, after the limiter. */
  meter(): AnalyserNode | null {
    const g = this.graph;
    if (!g || !this.ctx) return null;
    const a = this.ctx.createAnalyser();
    a.fftSize = 4096;
    g.limiter.connect(a);
    return a;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeGestureHooks();
    if (this.watchdog) clearInterval(this.watchdog);
    this.dropVoice();
    this.synth?.dispose();
    this.graph?.dispose();
    if (this.owned && this.ctx) void (this.ctx as AudioContext).close().catch(() => undefined);
  }
}
