/**
 * The three engines' voices (headless), measured as Xeno-Racer's audio tests measure them (the same analysis, src/audio/analysis.ts):
 *
 *  - each fires on its own grid: the strongest line near the firing frequency (cylinders / 2 x rpm / 60) sits on it, and the exhaust's
 *    power is in the firing orders (the LMP-X and the Dieci are flat-plane V10s, five pulses a turn; the Volta a V6, three);
 *  - louder with the revs, loudness on its calibration target, no clipping and nothing non-finite through a whole drive;
 *  - the shifts, driven through the physics: the Volta's seamless flick, the Dieci's short ignition cut, the LMP-X's road-gearbox gap;
 *  - the Volta's MGU-K: its whine on the 14th order, faint while it harvests on a lift, and, with no nitro, never deploying.
 *
 * tests/audio-parity.test.ts shows that these voices are Xeno-Racer's to the sample; this file holds them to what they are meant to be
 * without needing Xeno-Racer beside the repo.
 */
import { describe, expect, it } from 'vitest';
import { getCar } from '../src/cars';
import { bandPower, hasNonFinite, orderFamilies, peakAbs, rms, strongestPeak, welch } from '../src/audio/analysis';
import { CarFrame } from '../src/audio/carsound';
import { CTL, readEngineInputs } from '../src/audio/controls';
import { buildLayout } from '../src/audio/dsp/engine-layout';
import { EngineVoice, calibratedExhaustGain, createEngineDebug, deriveVoicing, exhaustTargetDb, measureExhaustSweepRms, type EngineDebug } from '../src/audio/dsp/engine-voice';
import { Drive, PROGRAMMES, drive } from '../src/audio/lab/drive';
import { makeListener } from '../src/audio/spatial';
import type { CarDefinition, EngineSoundProfile } from '../src/core/contracts';

const SR = 48000;
const CARS = ['lmp-x', 'volta', 'dieci'].map(getCar);
const db = (x: number): number => 20 * Math.log10(x + 1e-12);

function voice(car: CarDefinition, seed = 3, profile: EngineSoundProfile = car.sound): EngineVoice {
  const v = new EngineVoice(SR, profile, seed);
  const e = car.physics.engine;
  Object.assign(v.inp, { idleRpm: e.idleRpm, limiterRpm: e.limiterRpm, redlineRpm: e.redlineRpm });
  return v;
}

function steady(v: EngineVoice, rpm: number, thr: number, secs: number, turbo: boolean): { out: Float32Array; dbg: EngineDebug } {
  Object.assign(v.inp, { rpm, throttle: thr, load: thr, pedal: thr, boost: turbo ? 0.9 * thr : 0 });
  const n = Math.floor(secs * SR);
  const out = new Float32Array(n);
  const dbg = createEngineDebug(n);
  v.debug = dbg;
  v.process(out, n);
  return { out, dbg };
}

interface Frame {
  vec: Float32Array;
}

/** Flat out from rest through the physics, the control frames the game makes at `hz` (the aids of Xeno-Racer's tests: no ESC). */
function flatOut(car: CarDefinition, hz: number, secs: number): Frame[] {
  const d = new Drive(car, { assists: { abs: true, tcs: 'low', esc: false, autoShift: true, steeringAssist: 0, autoClutch: true } });
  const cf = new CarFrame();
  const L = makeListener();
  const frames: Frame[] = [];
  for (let f = 0; f < secs * hz; f++) {
    const st = d.step(1 / hz, { throttle: 1 });
    L.px = st.position.x;
    L.py = st.position.y + 1;
    L.pz = st.position.z - 6;
    L.vx = st.velocity.x;
    L.vy = st.velocity.y;
    L.vz = st.velocity.z;
    cf.compute(st, 1 / hz, L, 0, false);
    frames.push({ vec: cf.vec.slice() });
  }
  return frames;
}

/** The voice fed the frames of a drive as the worklet is, one frame's worth of samples at a time. */
function hear(car: CarDefinition, frames: Frame[], hz: number, seed = 1): Float32Array {
  const v = voice(car, seed);
  const spf = Math.round(SR / hz);
  const out = new Float32Array(frames.length * spf);
  frames.forEach((fr, f) => {
    readEngineInputs(fr.vec, v.inp);
    v.process(out.subarray(f * spf), spf);
  });
  return out;
}

/** Each upshift from `fromGear` on: the ms under -3 dB (4 ms windows against the 60 ms before the cut) and how deep it goes. */
function upshifts(car: CarDefinition, frames: Frame[], hz: number, fromGear: number): { gear: number; ms: number; deep: number }[] {
  const out = hear(car, frames, hz);
  const spf = Math.round(SR / hz);
  const w = Math.floor(0.004 * SR);
  const res: { gear: number; ms: number; deep: number }[] = [];
  for (let f = 1; f < frames.length; f++) {
    if (frames[f].vec[CTL.SHIFT_COUNT] <= frames[f - 1].vec[CTL.SHIFT_COUNT] || frames[f].vec[CTL.GEAR] < fromGear) continue;
    // (the cut is before the counter steps: the shift's frames start up to three frames earlier)
    const at = (f - 3) * spf;
    const ref = rms(out, at - Math.floor(0.06 * SR), at);
    let ms = 0;
    let deep = 0;
    for (let i = at; i < at + Math.floor(0.15 * SR); i += w) {
      const r = rms(out, i, i + w);
      if (r < 0.708 * ref) ms += 4;
      deep = Math.min(deep, db(r / ref));
    }
    res.push({ gear: frames[f].vec[CTL.GEAR], ms, deep });
  }
  return res;
}

describe('the firing orders', () => {
  for (const car of CARS) {
    it(`${car.id}: the strongest line near the firing frequency sits on it, and the exhaust's power is in the firing orders`, () => {
      const e = car.physics.engine;
      const fire = car.sound.cylinders / 2;
      for (const rpm of [e.idleRpm * 1.6, e.limiterRpm * 0.5, e.redlineRpm * 0.95]) {
        const { out, dbg } = steady(voice(car), rpm, 1, 2.4, car.sound.turbo);
        const f = fire * (rpm / 60);
        const pk = strongestPeak(welch(out, 32768, Math.floor(1.2 * SR), out.length), SR, f * 0.9, f * 1.1);
        expect(Math.abs(pk.freq - f) / f, `@${rpm}`).toBeLessThan(0.005);
        expect(pk.prominenceDb, `@${rpm}`).toBeGreaterThan(12);
        const f0 = rpm / 120;
        let nfft = 1 << 15;
        while (SR / nfft > f0 / 9 && nfft < 1 << 18) nfft <<= 1;
        const of = orderFamilies(welch(dbg.exhaust, nfft, Math.floor(1.2 * SR), dbg.exhaust.length), SR, f0, fire * 2, 40, 6000);
        expect(of.fire / (of.fire + of.half + of.whole), `@${rpm}`).toBeGreaterThan(0.85);
        expect(hasNonFinite(out)).toBe(false);
      }
    });
  }

  it('the layouts: the V10s fire every 72 degrees, the V6 every 120', () => {
    expect(buildLayout(getCar('lmp-x').sound).cyl.map((c) => c.fireDeg)).toEqual([0, 72, 144, 216, 288, 360, 432, 504, 576, 648]);
    expect(buildLayout(getCar('dieci').sound).cyl.map((c) => c.fireDeg)).toEqual([0, 72, 144, 216, 288, 360, 432, 504, 576, 648]);
    expect(buildLayout(getCar('volta').sound).cyl.map((c) => c.fireDeg)).toEqual([0, 120, 240, 360, 480, 600]);
  });
});

describe('level', () => {
  for (const car of CARS) {
    it(`${car.id}: louder with the revs flat out, and its loudness on its calibration target`, () => {
      const e = car.physics.engine;
      const lv = [0.35, 0.55, 0.75, 0.95].map((k) => db(rms(steady(voice(car), e.limiterRpm * k, 1, 2, car.sound.turbo).out, Math.floor(0.6 * SR))));
      expect(lv[3] - lv[0], JSON.stringify(lv)).toBeGreaterThan(4);
      const g = calibratedExhaustGain(car.sound, SR);
      expect(Math.abs(db(measureExhaustSweepRms(car.sound, SR, g)) - exhaustTargetDb(car.sound.exhaustOpenness, car.sound.displacement))).toBeLessThan(0.6);
    });
  }

  it('a whole drive (idle, launch, every gear, lift-off, braking) is finite and never above 1.4 before the limiter', () => {
    for (const car of CARS) {
      const v = voice(car);
      const cf = new CarFrame();
      const L = makeListener();
      let peak = 0;
      let bad = false;
      const buf = new Float32Array(800);
      drive(car, PROGRAMMES.launch.phases, (st, dt) => {
        L.px = st.position.x;
        L.py = st.position.y + 2.1;
        L.pz = st.position.z - 6.4;
        L.vx = st.velocity.x;
        L.vy = st.velocity.y;
        L.vz = st.velocity.z;
        cf.compute(st, dt, L, 0, false);
        readEngineInputs(cf.vec, v.inp);
        v.process(buf, 800);
        peak = Math.max(peak, peakAbs(buf));
        bad ||= hasNonFinite(buf);
      });
      expect(bad, car.id).toBe(false);
      expect(peak, car.id).toBeLessThan(1.4);
    }
  });
});

describe('the shifts, through the physics', () => {
  it("the Volta's are a seamless flick: from the 2-3 on, under -3 dB for 20 ms at most", () => {
    const car = getCar('volta');
    const d = upshifts(car, flatOut(car, 60, 9.5), 60, 3);
    expect(d.length).toBeGreaterThanOrEqual(4);
    for (const s of d) expect(s.ms, JSON.stringify(d)).toBeLessThanOrEqual(20);
  });

  it("the Dieci's are a short ignition cut: from the 2-3 on, under -3 dB for 20 to 40 ms and 6 dB deep or more", () => {
    const car = getCar('dieci');
    const d = upshifts(car, flatOut(car, 60, 12), 60, 3);
    expect(d.length).toBeGreaterThanOrEqual(4);
    for (const s of d) {
      expect(s.ms, JSON.stringify(d)).toBeGreaterThanOrEqual(20);
      expect(s.ms, JSON.stringify(d)).toBeLessThanOrEqual(40);
      expect(s.deep, JSON.stringify(d)).toBeLessThan(-6);
    }
  });

  it("the LMP-X's are a road gearbox's gap: longer than the Dieci's", () => {
    const car = getCar('lmp-x');
    const d = upshifts(car, flatOut(car, 60, 12), 60, 3);
    expect(d.length).toBeGreaterThanOrEqual(2);
    for (const s of d) expect(s.ms, JSON.stringify(d)).toBeGreaterThan(40);
  });
});

describe("the Volta's MGU-K, with no nitro", () => {
  const volta = getCar('volta');
  const ORDER = 14;

  it('is locked to the crank on its 14th order while it harvests on a lift', () => {
    for (const rpm of [5000, 8000, 11000]) {
      const x = steady(voice(volta), rpm, 0, 3, true).dbg.electric!;
      const f = (rpm / 60) * ORDER;
      const pk = strongestPeak(welch(x, 32768, Math.floor(1.2 * SR), x.length), SR, f * 0.8, f * 1.2);
      expect(Math.abs(pk.freq - f) / f, `@${rpm}`).toBeLessThan(0.001);
      expect(pk.prominenceDb, `@${rpm}`).toBeGreaterThan(30);
    }
  });

  it('whines louder harvesting on a lift than turning free on the throttle, where it is under the rest of the engine in its band (it never deploys)', () => {
    for (const rpm of [5000, 8000, 11000]) {
      const lift = steady(voice(volta), rpm, 0, 3, true);
      const on = steady(voice(volta), rpm, 1, 3, true);
      expect(db(rms(lift.dbg.electric!, SR)) - db(rms(on.dbg.electric!, SR)), `@${rpm}`).toBeGreaterThan(6);
      // its share of the band one ERB about its line: under the engine on the throttle, heard over the quieter engine on a lift
      const f = (rpm / 60) * ORDER;
      const erb = 24.7 * ((4.37 * f) / 1000 + 1);
      const over = (r: { out: Float32Array; dbg: EngineDebug }): number => {
        const w = r.dbg.electric!;
        const rest = r.out.map((x, i) => x - w[i]);
        const a = Math.floor(1.2 * SR);
        return db(Math.sqrt(bandPower(welch(w, 16384, a, w.length), SR, f - erb / 2, f + erb / 2) / bandPower(welch(rest, 16384, a, rest.length), SR, f - erb / 2, f + erb / 2)));
      };
      expect(over(on), `on the throttle @${rpm}`).toBeLessThan(0);
      if (rpm === 8000) expect(over(lift), `lift @${rpm}`).toBeGreaterThan(3);
    }
  });

  it('has no nitro to hear: the voicing keeps the motor, the inputs have no nitro', () => {
    expect(deriveVoicing(volta.sound, buildLayout(volta.sound)).electric).toBe(1);
    expect('nitro' in voice(volta).inp).toBe(false);
    expect(Object.keys(CTL)).not.toContain('NITRO');
  });
});
