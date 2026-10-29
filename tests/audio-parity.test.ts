/**
 * The port is Xeno-Racer's car sound: driven through Neon-Racer's physics by the same programmes, the LMP-X, the Volta and the Dieci
 * render the same samples here and in Xeno-Racer, engine and chassis, from the control vector on (CarFrame: the VehicleState mapping,
 * the tyres, the surfaces, the impacts and the placement) to the voices' output.
 *
 * Needs the Xeno-Racer repository beside this one (../Xeno-Racer); without it the test is skipped. Its modules are loaded at run time,
 * so the type check and the build never look for them.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getCar } from '../src/cars';
import { CarFrame } from '../src/audio/carsound';
import { CTL, CTL_LEN, readEngineInputs } from '../src/audio/controls';
import { ChassisVoice, readChassisInputs } from '../src/audio/dsp/chassis-voice';
import { EngineVoice, calibratedExhaustGain } from '../src/audio/dsp/engine-voice';
import { PROGRAMMES, drive } from '../src/audio/lab/drive';
import { makeListener } from '../src/audio/spatial';
import type { CarDefinition } from '../src/core/contracts';

const XENO = resolve(__dirname, '../../Xeno-Racer/src/audio');
const have = existsSync(resolve(XENO, 'dsp/engine-voice.ts'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const load = (p: string): Promise<Any> => import(/* @vite-ignore */ pathToFileURL(resolve(XENO, p)).href);

const SR = 48000;
const FPS = 60;
const SPF = SR / FPS;

describe.skipIf(!have)('the same sound as Xeno-Racer', async () => {
  const X = have
    ? {
        carsound: await load('carsound.ts'),
        controls: await load('controls.ts'),
        chassis: await load('dsp/chassis-voice.ts'),
        engine: await load('dsp/engine-voice.ts'),
      }
    : null;

  /** Neon-Racer's control index -> Xeno-Racer's, by name (the per-wheel fields by their offset from the first). */
  function indexMap(): Int32Array {
    const xc = X!.controls.CTL as Record<string, number>;
    const m = new Int32Array(CTL_LEN).fill(-1);
    for (const [k, i] of Object.entries(CTL)) m[i] = xc[k];
    for (let w = 0; w < 4; w++) m[CTL.CURB_FL + w] = xc.CURB_FL + w;
    for (let j = 0; j < 16; j++) m[CTL.TIRE0 + j] = xc.TIRE0 + j;
    return m;
  }

  function compare(def: CarDefinition, programme: string, interiorAt: (t: number) => number = () => 0): { frames: number; samples: number; maxEng: number; maxCh: number; rmsEng: number; vecDiffs: number } {
    const map = indexMap();
    const nf = new CarFrame();
    const xf = new X!.carsound.CarFrame(true);
    const g = calibratedExhaustGain(def.sound, SR);
    const xg = X!.engine.calibratedExhaustGain(def.sound, SR);
    expect(g).toBe(xg);
    const open = def.visual.openCockpit === true;
    const ne = new EngineVoice(SR, def.sound, 3, g);
    const nc = new ChassisVoice(SR, 10);
    const xe = new X!.engine.EngineVoice(SR, def.sound, 3, xg);
    const xch = new X!.chassis.ChassisVoice(SR, 10);
    ne.helmet = nc.helmet = xe.helmet = xch.helmet = open;
    const L = makeListener();
    const a = new Float32Array(SPF);
    const b = new Float32Array(SPF);
    const al = new Float32Array(SPF);
    const ar = new Float32Array(SPF);
    const bl = new Float32Array(SPF);
    const br = new Float32Array(SPF);
    let maxEng = 0;
    let maxCh = 0;
    let sumEng = 0;
    let samples = 0;
    let vecDiffs = 0;
    const frames = drive(def, PROGRAMMES[programme].phases, (st, dt, t) => {
      L.px = st.position.x;
      L.py = st.position.y + 2.1;
      L.pz = st.position.z - 6.4;
      L.vx = st.velocity.x;
      L.vy = st.velocity.y;
      L.vz = st.velocity.z;
      const inter = interiorAt(t);
      nf.compute(st, dt, L, inter, false);
      xf.compute(st, dt, L, inter, 2, false, 0);
      for (let i = 0; i < CTL_LEN; i++) if (!Object.is(nf.vec[i], xf.vec[map[i]])) vecDiffs++;
      readEngineInputs(nf.vec, ne.inp);
      readChassisInputs(nf.vec, nc.inp);
      X!.controls.readEngineInputs(xf.vec, xe.inp);
      X!.chassis.readChassisInputs(xf.vec, xch.inp);
      // in render quanta, as the worklet runs them
      for (let o = 0; o < SPF; o += 128) {
        const n = Math.min(128, SPF - o);
        ne.process(a, n, o);
        xe.process(b, n, o);
        nc.process(al, ar, n, o);
        xch.process(bl, br, n, o);
      }
      for (let i = 0; i < SPF; i++) {
        maxEng = Math.max(maxEng, Math.abs(a[i] - b[i]));
        maxCh = Math.max(maxCh, Math.abs(al[i] - bl[i]), Math.abs(ar[i] - br[i]));
        sumEng += a[i] * a[i];
      }
      samples += SPF;
    });
    return { frames, samples, maxEng, maxCh, rmsEng: Math.sqrt(sumEng / samples), vecDiffs };
  }

  for (const id of ['lmp-x', 'volta', 'dieci']) {
    for (const programme of ['launch', 'tyres']) {
      it(`${id}, ${programme}: every control and every sample the same`, () => {
        const r = compare(getCar(id), programme);
        expect(r.frames).toBeGreaterThan(400);
        expect(r.vecDiffs).toBe(0);
        // (a real render, not silence)
        expect(r.rmsEng).toBeGreaterThan(0.01);
        expect(r.maxEng).toBe(0);
        expect(r.maxCh).toBe(0);
      });
    }
  }

  it("the Volta in its cockpit (a helmet, the MGU-K harvesting on the lift and the brakes): every sample the same", () => {
    const r = compare(getCar('volta'), 'launch', (t) => (t > 8 ? 1 : 0));
    expect(r.vecDiffs).toBe(0);
    expect(r.maxEng).toBe(0);
    expect(r.maxCh).toBe(0);
  });
});
