/**
 * The chassis voice (headless): tyres, road and run-off, wind, impacts and scrape, from VehicleStates the physics makes.
 *
 *  - the tyre mapping: silent with grip, a scrub before any skid, then the tone, then the howl; only paved surfaces squeal;
 *  - the run-off sounds as itself: rolling on the grass is louder than on the asphalt, the gravel brighter than the grass;
 *  - an impact on the barrier is an event (one per impactCount step), louder on the side it hits; the scrape along it grinds;
 *  - nothing non-finite, nothing out of bounds, through a whole drive of each car.
 */
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { getCar } from '../src/cars';
import { bandPower, hasNonFinite, peakAbs, rms, spectralCentroid, welch } from '../src/audio/analysis';
import { CarFrame } from '../src/audio/carsound';
import { ChassisMapper } from '../src/audio/chassis-controls';
import { CTL, TIRE_STRIDE, makeControlVector } from '../src/audio/controls';
import { ChassisVoice, readChassisInputs } from '../src/audio/dsp/chassis-voice';
import { Drive, PROGRAMMES, drive } from '../src/audio/lab/drive';
import { makeListener } from '../src/audio/spatial';
import { makeSquealLevels, tireSqueal } from '../src/audio/tires';
import type { SurfaceType, VehicleState, WheelState } from '../src/core/contracts';

const SR = 48000;
const SPF = SR / 60;
const db = (x: number): number => 20 * Math.log10(x + 1e-12);

function wheel(over: Partial<WheelState> = {}): WheelState {
  return {
    hub: new Vector3(), contactPoint: new Vector3(), contactNormal: new Vector3(0, 1, 0), steerAngle: 0, spin: 0, omega: 0, radius: 0.33, width: 0.3,
    compression: 0.3, suspensionVelocity: 0, contact: true, surface: 'asphalt', load: 4000, slipRatio: 0, slipAngle: 0, forceLong: 0, forceLat: 0,
    skid: 0, tempC: 80, brakeTempC: 200, ...over,
  };
}

describe('tyre squeal mapping', () => {
  it('grip is silent; scrub comes before any skid, then the tone, then the howl', () => {
    const L = makeSquealLevels();
    tireSqueal(wheel({ slipAngle: 0.02 }), 0, 30, L);
    expect(L.scrub + L.tone + L.howl).toBe(0);
    tireSqueal(wheel({ slipAngle: 0.12 }), 0, 30, L);
    expect(L.scrub).toBeGreaterThan(0.1);
    expect(L.tone).toBe(0);
    tireSqueal(wheel({ slipAngle: 0.14, skid: 0.4 }), 0, 30, L);
    expect(L.tone).toBeGreaterThan(0.3);
    tireSqueal(wheel({ slipAngle: 0.3, skid: 1 }), 0, 30, L);
    expect(L.howl).toBeGreaterThan(0.8);
  });

  it('only paved surfaces squeal; the run-off (grass, gravel, sand, dirt) does not', () => {
    const L = makeSquealLevels();
    const at = (surface: SurfaceType): number => {
      tireSqueal(wheel({ surface, slipAngle: 0.2, skid: 0.6 }), 0, 30, L);
      return L.tone + L.howl;
    };
    for (const s of ['asphalt', 'concrete', 'curb'] as SurfaceType[]) expect(at(s), s).toBeGreaterThan(0.2);
    for (const s of ['grass', 'gravel', 'sand', 'dirt'] as SurfaceType[]) expect(at(s), s).toBe(0);
  });

  it('the mapper puts the shares of the wheels on each surface and every wheel\'s levels in the vector', () => {
    const m = new ChassisMapper();
    const d = new Drive(getCar('lmp-x'));
    const st: VehicleState = d.state;
    const v = makeControlVector();
    const surf: SurfaceType[] = ['asphalt', 'grass', 'grass', 'gravel'];
    st.wheels.forEach((w, i) => {
      w.surface = surf[i];
      w.contact = true;
    });
    st.wheels[0].skid = 0.6;
    st.wheels[0].slipAngle = 0.2;
    st.speed = 30;
    m.update(st, 1 / 60, v);
    expect([v[CTL.SURF_HARD], v[CTL.SURF_GRASS], v[CTL.SURF_GRAVEL]]).toEqual([0.25, 0.5, 0.25]);
    expect(v[CTL.TIRE0 + 1]).toBeGreaterThan(0.2);
    expect(v[CTL.TIRE0 + TIRE_STRIDE + 1]).toBe(0);
  });
});

/** A whole programme of a car, the chassis voice fed as the worklet is; per frame: the state's facts and the stereo output's rms. */
function run(id: string, programme: string): { rows: { skid: number; grass: number; speed: number; imp: number; scrape: number; airborne: boolean; l: number; r: number }[]; out: Float32Array[] } {
  const car = getCar(id);
  const cf = new CarFrame();
  const v = new ChassisVoice(SR, 10);
  const L = makeListener();
  const rows: ReturnType<typeof run>['rows'] = [];
  const outL: Float32Array[] = [];
  const outR: Float32Array[] = [];
  drive(car, PROGRAMMES[programme].phases, (st, dt) => {
    L.px = st.position.x;
    L.py = st.position.y + 2.1;
    L.pz = st.position.z - 6.4;
    L.vx = st.velocity.x;
    L.vy = st.velocity.y;
    L.vz = st.velocity.z;
    cf.compute(st, dt, L, 0, false);
    readChassisInputs(cf.vec, v.inp);
    const l = new Float32Array(SPF);
    const r = new Float32Array(SPF);
    for (let o = 0; o < SPF; o += 128) v.process(l, r, Math.min(128, SPF - o), o);
    outL.push(l);
    outR.push(r);
    rows.push({
      skid: Math.max(...st.wheels.map((w) => (w.surface === 'asphalt' ? w.skid : 0))),
      grass: st.wheels.filter((w) => w.contact && w.surface === 'grass').length,
      speed: st.speed,
      imp: st.impactCount,
      scrape: st.scrape,
      airborne: st.airborne,
      l: rms(l),
      r: rms(r),
    });
  });
  return { rows, out: [concat(outL), concat(outR)] };
}

function concat(a: Float32Array[]): Float32Array {
  const o = new Float32Array(a.length * SPF);
  a.forEach((x, i) => o.set(x, i * SPF));
  return o;
}

describe('through the physics', () => {
  for (const id of ['lmp-x', 'volta', 'dieci']) {
    it(`${id}: the squeal of a slide on the asphalt, the run-off, the barrier`, () => {
      const { rows, out } = run(id, 'tyres');
      const [l, r] = out;
      expect(hasNonFinite(l) || hasNonFinite(r)).toBe(false);
      expect(Math.max(peakAbs(l), peakAbs(r))).toBeLessThan(1.5);
      const frames = (pred: (x: (typeof rows)[number], i: number) => boolean): number[] => rows.map((x, i) => (pred(x, i) ? i : -1)).filter((i) => i >= 0);
      const band = (idx: number[], lo: number, hi: number): number => {
        let s = 0;
        for (const i of idx) s += bandPower(welch(l.subarray(i * SPF, (i + 1) * SPF), 512), SR, lo, hi);
        return s / Math.max(1, idx.length);
      };
      // the slide on the asphalt against the same car on the asphalt with its grip (the run up to speed): the squeal band (0.8..3 kHz)
      // 10 dB and more up
      const sliding = frames((x) => x.skid > 0.6 && x.grass === 0 && x.imp === 0);
      const gripping = frames((x) => x.skid < 0.1 && x.grass === 0 && x.imp === 0 && x.speed > 10);
      expect(sliding.length, 'frames sliding').toBeGreaterThan(10);
      expect(gripping.length, 'frames gripping').toBeGreaterThan(10);
      const squealUp = 10 * Math.log10(band(sliding, 800, 3000) / band(gripping, 800, 3000));
      expect(squealUp).toBeGreaterThan(10);
      // impacts: each step of the counter a jump in the level of the frame it lands in, louder on the left, where the barrier is (+X)
      const hits = frames((x, i) => i > 2 && x.imp > rows[i - 1].imp);
      expect(hits.length).toBeGreaterThan(0);
      const jump = Math.max(...hits.map((i) => db(Math.max(rows[i].l, rows[i + 1]?.l ?? 0) / Math.max(rows[i - 2].l, 1e-6))));
      expect(jump, 'the biggest hit over the frames before it, dB').toBeGreaterThan(6);
      const lr = Math.max(...hits.map((i) => db(rows[i].l / rows[i].r)));
      expect(lr, 'left over right in a hit, dB').toBeGreaterThan(1);
      // the scrape along it: the grinding bands (0.6..4 kHz) up over the run-off before the barrier
      const scraping = frames((x) => x.scrape > 0.3);
      const offRoad = frames((x) => x.grass === 4 && x.scrape === 0 && x.imp === 0);
      expect(scraping.length).toBeGreaterThan(20);
      expect(offRoad.length).toBeGreaterThan(5);
      expect(10 * Math.log10(band(scraping, 600, 4000) / band(offRoad, 600, 4000))).toBeGreaterThan(3);
    });
  }

  it('the run-off sounds as itself: rolling at 20 m/s, the grass 3 dB and more louder than the asphalt, the gravel over twice as bright as the grass', () => {
    const at = (surface: SurfaceType): { level: number; centroid: number } => {
      const d = new Drive(getCar('lmp-x'), { runoff: surface === 'asphalt' ? 'grass' : surface });
      d.car.placeOnGround(new Vector3(surface === 'asphalt' ? -6 : 6, 0, 0), new Quaternion(), 20);
      const cf = new CarFrame();
      const v = new ChassisVoice(SR, 10);
      const L = makeListener();
      const l = new Float32Array(SPF * 90);
      const r = new Float32Array(SPF * 90);
      for (let f = 0; f < 90; f++) {
        const st = d.step(1 / 60, { throttle: 0.25 });
        L.px = st.position.x;
        L.py = st.position.y + 2;
        L.pz = st.position.z - 6;
        L.vx = st.velocity.x;
        L.vz = st.velocity.z;
        cf.compute(st, 1 / 60, L, 0, false);
        expect(st.wheels.every((w) => w.surface === surface)).toBe(true);
        readChassisInputs(cf.vec, v.inp);
        for (let o = 0; o < SPF; o += 128) v.process(l, r, Math.min(128, SPF - o), f * SPF + o);
      }
      const psd = welch(l, 8192, SPF * 30, l.length);
      return { level: db(rms(l, SPF * 30)), centroid: spectralCentroid(psd, SR, 60, 12000) };
    };
    const asphalt = at('asphalt');
    const grass = at('grass');
    const gravel = at('gravel');
    expect(grass.level - asphalt.level).toBeGreaterThan(3);
    expect(gravel.centroid).toBeGreaterThan(2 * grass.centroid);
  });
});
