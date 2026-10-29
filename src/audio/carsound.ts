/**
 * Main-thread side of the player's car sound: the node graph (worklet voice -> distance filter -> panner -> bus) and the per-frame
 * VehicleState -> control-vector mapping. The DSP itself lives in the worklet.
 *
 * Xeno-Racer's src/audio/carsound.ts for its player's car: the opponents (their mono voices, level of detail and panned chassis) and the
 * split screen are left out, as is the wet road.
 */
import type { EngineSoundProfile, VehicleState } from '../core/contracts';
import { ChassisMapper } from './chassis-controls';
import { CTL, makeControlVector, writeEngineControls } from './controls';
import { calibratedExhaustGain } from './dsp/engine-voice';
import type { MasterGraph } from './graph';
import { type ListenerState, type SpatialOut, computeSpatial, makeSpatialOut } from './spatial';

export interface CarNodes {
  node: AudioWorkletNode;
  engineLp: BiquadFilterNode;
  enginePanner: PannerNode;
  chLp: BiquadFilterNode;
  chGain: GainNode;
  dispose(): void;
}

export interface CarNodeOptions {
  profile: EngineSoundProfile;
  seed: number;
  /** The calibrated exhaust gain (default: calibratedExhaustGain, worked out here on the main thread, not on the audio thread). */
  exGain?: number;
  /** Offline mode: pre-recorded control frames played on the audio clock. */
  script?: { step: number; data: Float32Array };
  /** An open cockpit (CarVisualSpec.openCockpit): its interior views are a helmet's, not a closed cabin's. */
  openCockpit?: boolean;
}

/** Name of the car processor in engine.worklet.ts. */
export const CAR_PROCESSOR = 'nr-car';

function makePanner(ctx: BaseAudioContext, ref: number, rolloff: number): PannerNode {
  const p = ctx.createPanner();
  p.panningModel = 'equalpower';
  p.distanceModel = 'inverse';
  p.refDistance = ref;
  p.maxDistance = 600;
  p.rolloffFactor = rolloff;
  p.coneInnerAngle = 360;
  p.coneOuterAngle = 360;
  p.coneOuterGain = 1;
  return p;
}

/** Build the graph for the player's car. The worklet module must already be loaded into `ctx`. */
export function createCarNodes(ctx: BaseAudioContext, g: MasterGraph, o: CarNodeOptions): CarNodes {
  const node = new AudioWorkletNode(ctx, CAR_PROCESSOR, {
    numberOfInputs: 0,
    numberOfOutputs: 2,
    outputChannelCount: [1, 2],
    processorOptions: {
      profile: o.profile,
      seed: o.seed,
      exGain: o.exGain ?? calibratedExhaustGain(o.profile, ctx.sampleRate),
      script: o.script,
      openCockpit: o.openCockpit === true,
    },
  });
  const engineLp = ctx.createBiquadFilter();
  engineLp.type = 'lowpass';
  engineLp.Q.value = 0.6;
  engineLp.frequency.value = 18000;
  const enginePanner = makePanner(ctx, 6, 0.85);
  node.connect(engineLp, 0);
  engineLp.connect(enginePanner);
  enginePanner.connect(g.engineBus);

  const chLp = ctx.createBiquadFilter();
  chLp.type = 'lowpass';
  chLp.Q.value = 0.6;
  chLp.frequency.value = 18000;
  node.connect(chLp, 1);
  const chGain = ctx.createGain();
  chLp.connect(chGain);
  chGain.connect(g.effectsBus);
  return {
    node,
    engineLp,
    enginePanner,
    chLp,
    chGain,
    dispose(): void {
      try {
        node.port.postMessage('dispose');
        node.port.close();
      } catch {
        /* ignore */
      }
      for (const n of [node, engineLp, enginePanner, chLp, chGain]) {
        try {
          n.disconnect();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/** Set a panner's position (AudioParam API, falling back to the legacy setter). `at` schedules (offline). */
export function setPannerPosition(p: PannerNode, x: number, y: number, z: number, at?: number): void {
  if (p.positionX) {
    if (at === undefined) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    } else {
      p.positionX.setValueAtTime(x, at);
      p.positionY.setValueAtTime(y, at);
      p.positionZ.setValueAtTime(z, at);
    }
  } else (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
}

/**
 * One frame of control: VehicleState + listener -> control vector + spatial placement. Shared by the live Sound and the offline
 * renders and tests, so that all of them exercise exactly the same mapping.
 */
export class CarFrame {
  readonly vec = makeControlVector();
  readonly sp: SpatialOut = makeSpatialOut();
  private mapper = new ChassisMapper();

  compute(st: VehicleState, dt: number, listener: ListenerState, interior: number, paused: boolean): void {
    const v = this.vec;
    writeEngineControls(v, st);
    this.mapper.update(st, dt, v);
    const sp = this.sp;
    computeSpatial(listener, st.position.x, st.position.y, st.position.z, st.velocity.x, st.velocity.y, st.velocity.z, true, sp);
    v[CTL.TIMESCALE] = sp.timeScale;
    v[CTL.INTERIOR] = interior;
    v[CTL.CH_INTERIOR] = interior;
    const gain = paused ? 0 : 1;
    v[CTL.QUALITY] = 2;
    v[CTL.CH_QUALITY] = 2;
    v[CTL.GAIN] = gain;
    v[CTL.CH_GAIN] = gain;
  }
}

/** Push spatial values into the nodes (live: immediate; offline: scheduled at `at`). */
export function applySpatial(n: CarNodes, sp: SpatialOut, at?: number): void {
  setPannerPosition(n.enginePanner, sp.x, sp.y, sp.z, at);
  const setF = (p: AudioParam, v: number): void => {
    if (at === undefined) p.value = v;
    else p.setValueAtTime(v, at);
  };
  setF(n.engineLp.frequency, sp.lpHz);
  setF(n.chLp.frequency, sp.lpHz);
  // the player's own tires / wind are attached to the car; recede with distance for far cameras
  setF(n.chGain.gain, 1 / (1 + Math.max(0, sp.distance - 10) / 12));
}
