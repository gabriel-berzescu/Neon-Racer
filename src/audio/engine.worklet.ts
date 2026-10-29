/**
 * AudioWorklet entry. Registers
 *   'nr-car'   the player's car: the engine (output 0, mono) and the chassis sounds (output 1, stereo: tyres, road, wind, thumps,
 *              scrape, impacts)
 *
 * Control arrives as Float32Array snapshots on the message port (see controls.ts), or, for deterministic offline renders, as a
 * pre-recorded `script` passed through processorOptions.
 *
 * Xeno-Racer's src/audio/engine.worklet.ts without its opponents' mono voices, the rain and the wiper.
 * Keep this file free of DOM / Web Audio *main thread* APIs: it runs inside AudioWorkletGlobalScope.
 */
import type { EngineSoundProfile } from '../core/contracts';
import { CTL_LEN, makeControlVector, readEngineInputs } from './controls';
import { ChassisVoice, readChassisInputs } from './dsp/chassis-voice';
import { EngineVoice } from './dsp/engine-voice';

// AudioWorkletGlobalScope globals (not in the project's lib set)
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: new (options: any) => unknown): void; // eslint-disable-line
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

export interface CarProcessorOptions {
  profile: EngineSoundProfile;
  seed: number;
  /** Calibrated exhaust gain computed on the main thread (avoids a spike on the audio thread). */
  exGain?: number;
  /** Offline mode: control frames played back on the audio clock, `step` samples apart. */
  script?: { step: number; data: Float32Array };
  /** An open cockpit (CarVisualSpec.openCockpit): the cockpit views hear the car through a helmet, not a closed cabin. */
  openCockpit?: boolean;
}

class CarProcessor extends AudioWorkletProcessor {
  private engine: EngineVoice;
  private chassis: ChassisVoice;
  private vec = makeControlVector();
  private dead = false;
  private script: { step: number; data: Float32Array } | null;
  private lastScriptFrame = -1;

  constructor(options: { processorOptions: CarProcessorOptions }) {
    super();
    const o = options.processorOptions;
    this.engine = new EngineVoice(sampleRate, o.profile, o.seed, o.exGain);
    this.chassis = new ChassisVoice(sampleRate, o.seed + 7);
    this.engine.helmet = this.chassis.helmet = o.openCockpit === true;
    this.script = o.script ?? null;
    this.port.onmessage = (e: MessageEvent): void => {
      const d = e.data;
      if (d instanceof Float32Array) this.apply(d);
      else if (d === 'dispose') this.dead = true;
    };
    this.apply(this.vec);
  }

  private apply(v: Float32Array): void {
    if (v !== this.vec) this.vec.set(v.length > CTL_LEN ? v.subarray(0, CTL_LEN) : v);
    readEngineInputs(this.vec, this.engine.inp);
    readChassisInputs(this.vec, this.chassis.inp);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.dead) return false;
    const eng = outputs[0] && outputs[0][0];
    if (!eng) return true;
    const n = eng.length;

    if (this.script) {
      const frame = Math.min(Math.floor(currentFrame / this.script.step), Math.floor(this.script.data.length / CTL_LEN) - 1);
      if (frame !== this.lastScriptFrame && frame >= 0) {
        this.lastScriptFrame = frame;
        this.apply(this.script.data.subarray(frame * CTL_LEN, (frame + 1) * CTL_LEN));
      }
    }

    this.engine.process(eng, n);
    const ch = outputs[1];
    if (ch && ch[0]) this.chassis.process(ch[0], ch[1] ?? null, n);
    return true;
  }
}

registerProcessor('nr-car', CarProcessor);
