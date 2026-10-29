/**
 * Offline renders (browser): the REAL audio stack (the worklet voice, the distance filters, the panner, the buses, the compressor and the
 * limiter) in an OfflineAudioContext, driven by the control frames of a scripted drive (drive.ts), so the result is deterministic. The
 * sandbox's render buttons and the preview MP3s use it (Xeno-Racer's sandbox/audio/harness.ts, for one player's car).
 */
import type { CarDefinition } from '../../core/contracts';
import { CarFrame, applySpatial, createCarNodes } from '../carsound';
import { CTL_LEN } from '../controls';
import { DEFAULT_MIX, type Mix, buildMasterGraph } from '../graph';
import { AUDIO_WORKLET_URL, DEFAULT_LISTENER_BACK, DEFAULT_LISTENER_UP } from '../index';
import { makeListener, makeSpatialOut } from '../spatial';
import { type UiSound, UiSynth } from '../ui-sounds';
import { type DriveOptions, type Phase, drive } from './drive';

export const SR = 48000;

export interface RenderResult {
  left: Float32Array;
  right: Float32Array;
  sr: number;
  /** One row per control frame: time, phase, speed (km/h), gear, rpm. */
  frames: { t: number; phase: string; kmh: number; gear: number; rpm: number }[];
  renderMs: number;
}

export interface RenderOptions extends DriveOptions {
  /** The bus levels (default DEFAULT_MIX, Xeno-Racer's defaults: the master at 0.85). */
  mix?: Mix;
  /** No compressor and limiter (measurements). */
  raw?: boolean;
  /** 1 = a cockpit view (the single-seaters' helmet). */
  interior?: number;
  seed?: number;
}

/** Drive a programme through the physics and render the car's sound offline, heard from the chase camera's place. */
export async function renderDrive(def: CarDefinition, phases: Phase[], o: RenderOptions = {}): Promise<RenderResult> {
  const fps = o.fps ?? 60;
  const step = Math.round(SR / fps);
  // 1) the control and spatial frames
  const cf = new CarFrame();
  const L = makeListener();
  const vecs: Float32Array[] = [];
  const sps: number[][] = [];
  const frames: RenderResult['frames'] = [];
  drive(
    def,
    phases,
    (st, dt, t, phase) => {
      const q = st.quaternion;
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
      L.vx = st.velocity.x;
      L.vy = st.velocity.y;
      L.vz = st.velocity.z;
      cf.compute(st, dt, L, o.interior ?? 0, false);
      vecs.push(cf.vec.slice());
      const sp = cf.sp;
      sps.push([sp.x, sp.y, sp.z, sp.lpHz, sp.distance, L.px, L.py, L.pz, L.fx, L.fy, L.fz]);
      frames.push({ t, phase, kmh: st.speed * 3.6, gear: st.gear, rpm: st.rpm });
    },
    o,
  );
  const n = vecs.length;
  const length = n * step;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: SR });
  await ctx.audioWorklet.addModule(AUDIO_WORKLET_URL);
  const graph = buildMasterGraph(ctx, o.mix ?? DEFAULT_MIX, { raw: o.raw });
  const script = new Float32Array(n * CTL_LEN);
  vecs.forEach((v, k) => script.set(v, k * CTL_LEN));
  // 2) the voice with its script, and the spatial automation
  const nodes = createCarNodes(ctx, graph, { profile: def.sound, seed: o.seed ?? 1, script: { step, data: script }, openCockpit: def.visual.openCockpit === true });
  const tmp = makeSpatialOut();
  const lis = ctx.listener;
  for (let k = 0; k < n; k++) {
    const s = sps[k];
    const at = k / fps;
    tmp.x = s[0];
    tmp.y = s[1];
    tmp.z = s[2];
    tmp.lpHz = s[3];
    tmp.distance = s[4];
    applySpatial(nodes, tmp, at);
    lis.positionX.setValueAtTime(s[5], at);
    lis.positionY.setValueAtTime(s[6], at);
    lis.positionZ.setValueAtTime(s[7], at);
    lis.forwardX.setValueAtTime(s[8], at);
    lis.forwardY.setValueAtTime(s[9], at);
    lis.forwardZ.setValueAtTime(s[10], at);
    lis.upX.setValueAtTime(0, at);
    lis.upY.setValueAtTime(1, at);
    lis.upZ.setValueAtTime(0, at);
  }
  // 3) render
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  return { left: buf.getChannelData(0).slice(), right: buf.getChannelData(1).slice(), sr: SR, frames, renderMs: performance.now() - t0 };
}

/** The interface sounds in sequence (through the ui bus and the master chain). */
export async function renderUi(events: { t: number; sound: UiSound }[], seconds: number, o: { mix?: Mix; raw?: boolean } = {}): Promise<RenderResult> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(seconds * SR), sampleRate: SR });
  const graph = buildMasterGraph(ctx, o.mix ?? DEFAULT_MIX, { raw: o.raw });
  const ui = new UiSynth(ctx, graph.uiBus);
  for (const e of events) ui.play(e.sound, e.t + 0.02);
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  return { left: buf.getChannelData(0).slice(), right: buf.getChannelData(1).slice(), sr: SR, frames: [], renderMs: performance.now() - t0 };
}
