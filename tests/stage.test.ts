/**
 * The stage generator (src/world/stage*.ts): the same seed is the same stage, and every stage meets the road's design targets for
 * these cars (radii, transitions, straights, grades, crests, no part of the road near another, checkpoints) over many seeds.
 */
import { describe, expect, it } from 'vitest';
import { generateStage, newStageSeed, type Stage } from '../src/world/stage';
import { SEP } from '../src/world/stage-plan';
import { CREST_K, MAX_GRADE } from '../src/world/stage-profile';
import { worldHeightAt } from '../src/world/terrain';

const G = 9.81;
const SEEDS = [1, 2, 3, 777, 4242, 12345, 31337, 99999, 100, 101, 103, 105, 109, 110, 114, 119, 121, 127, 250001, 640512, 88888, 54321];
const stages = new Map<number, Stage>();
const stageOf = (seed: number): Stage => {
  let s = stages.get(seed);
  if (!s) stages.set(seed, (s = generateStage(seed)));
  return s;
};

describe('a stage from a seed', () => {
  it('is the same stage every time', () => {
    for (const seed of [12345, 777]) {
      const a = generateStage(seed);
      const b = generateStage(seed);
      expect(b.name).toBe(a.name);
      expect(b.track.length).toBe(a.track.length);
      expect(b.checkpoints).toEqual(a.checkpoints);
      expect(b.shift).toEqual(a.shift);
      expect(Array.from(b.track.all.px)).toEqual(Array.from(a.track.all.px));
      expect(Array.from(b.track.all.py)).toEqual(Array.from(a.track.all.py));
      expect(Array.from(b.field.atlas)).toEqual(Array.from(a.field.atlas));
    }
    // and different seeds are different stages
    expect(generateStage(12346).track.length).not.toBe(generateStage(12345).track.length);
  });

  it('is generated well under a second', () => {
    for (const seed of [12345, 4242, 31337]) {
      const st = generateStage(seed);
      expect(st.stats.ms.total).toBeLessThan(900);
    }
  });

  it('gives fresh seeds of 5 or 6 digits', () => {
    for (let i = 0; i < 200; i++) {
      const s = newStageSeed();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(10000);
      expect(s).toBeLessThan(1000000);
    }
  });

  it('has a short name, a length of 9 to 13.5 km and checkpoints about every 1.5-2 km ending at the finish', () => {
    for (const seed of SEEDS) {
      const st = stageOf(seed);
      expect(st.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(st.track.length).toBeGreaterThan(9000);
      expect(st.track.length).toBeLessThan(13500);
      const cp = st.checkpoints;
      expect(cp[cp.length - 1]).toBe(st.track.length);
      let prev = 0;
      for (const s of cp) {
        expect(s - prev).toBeGreaterThan(1200);
        expect(s - prev).toBeLessThan(2700);
        prev = s;
      }
    }
  });
});

describe('the road over many seeds', () => {
  it('has radii from 25 m to 1200 m, with tight corners, medium ones and fast sweepers on every stage', () => {
    for (const seed of SEEDS) {
      const st = stageOf(seed);
      const p = st.plan;
      let kMax = 0;
      for (let i = 0; i < p.n; i++) kMax = Math.max(kMax, Math.abs(p.kappa[i]));
      expect(1 / kMax).toBeGreaterThan(24.9);
      const inStage = p.corners.filter((c) => c.s0 >= 0 && c.s1 <= st.track.length);
      const tight = inStage.filter((c) => c.radius < 52).length;
      const medium = inStage.filter((c) => c.radius >= 52 && c.radius < 220).length;
      const fast = inStage.filter((c) => c.radius >= 220).length;
      expect(tight, `seed ${seed}: tight corners`).toBeGreaterThanOrEqual(2);
      expect(medium, `seed ${seed}: medium corners`).toBeGreaterThanOrEqual(3);
      expect(fast, `seed ${seed}: fast corners`).toBeGreaterThanOrEqual(2);
      expect(inStage.length).toBeGreaterThanOrEqual(14);
    }
  });

  it('changes its curvature gradually (transition curves everywhere: no step in curvature)', () => {
    for (const seed of SEEDS) {
      const p = stageOf(seed).plan;
      let worst = 0;
      for (let i = 1; i < p.n; i++) worst = Math.max(worst, Math.abs(p.kappa[i] - p.kappa[i - 1]) / p.spacing);
      // (the quickest: full lock of a 25 m corner wound on over 14 m)
      expect(worst).toBeLessThan(1 / 25 / 14);
    }
  });

  it('has straights for top speed: at least one of 450 m and more, none longer than about a kilometre', () => {
    for (const seed of SEEDS) {
      const st = stageOf(seed);
      const p = st.plan;
      const i0 = Math.round(-p.sStart / p.spacing);
      const iF = i0 + Math.round(st.track.length / p.spacing);
      let run = 0;
      let longest = 0;
      for (let i = i0; i <= iF; i++) {
        if (p.kappa[i] === 0) run += p.spacing;
        else run = 0;
        longest = Math.max(longest, run);
      }
      expect(longest, `seed ${seed}`).toBeGreaterThanOrEqual(450);
      expect(longest, `seed ${seed}`).toBeLessThanOrEqual(1100);
    }
  });

  it('climbs and descends at 8 % at most, and its crests keep a car on the road at the speed it can carry there', () => {
    for (const seed of SEEDS) {
      const st = stageOf(seed);
      const tr = st.track;
      const v = st.profile.speed;
      let maxGrade = 0;
      let worstCrest = Infinity;
      for (let i = 0; i < tr.nAll; i++) maxGrade = Math.max(maxGrade, Math.abs(tr.M[i]));
      for (let i = 0; i + 1 < tr.nAll; i++) {
        // the vertical curvature on each 2 m piece (the profile is a parabola there: exact)
        const ypp = (tr.M[i + 1] - tr.M[i]) / tr.spacing;
        if (ypp < -1e-9) {
          const R = -1 / ypp;
          const vv = Math.max(v[i], v[i + 1]);
          worstCrest = Math.min(worstCrest, R / ((vv * vv) / G));
        }
      }
      expect(maxGrade, `seed ${seed}`).toBeLessThanOrEqual(MAX_GRADE + 1e-9);
      // (R >= CREST_K v^2 / g for the design speed, an upper bound of the quickest car: never under v^2 / g)
      expect(worstCrest, `seed ${seed}`).toBeGreaterThanOrEqual(CREST_K - 1e-6);
    }
  });

  it('never comes near itself: distant parts of the road stay at least SEP apart, nearer ones in proportion', () => {
    for (const seed of SEEDS) {
      const st = stageOf(seed);
      const p = st.plan;
      const cell = SEP;
      const grid = new Map<string, number[]>();
      const step = 4;
      for (let i = 0; i < p.n; i += step) {
        const k = `${Math.floor(p.x[i] / cell)},${Math.floor(p.z[i] / cell)}`;
        let a = grid.get(k);
        if (!a) grid.set(k, (a = []));
        a.push(i);
      }
      let worst = Infinity;
      for (let i = 0; i < p.n; i += step) {
        const cx = Math.floor(p.x[i] / cell);
        const cz = Math.floor(p.z[i] / cell);
        for (let a = cx - 1; a <= cx + 1; a++) {
          for (let b = cz - 1; b <= cz + 1; b++) {
            for (const j of grid.get(`${a},${b}`) ?? []) {
              const ds = Math.abs(j - i) * p.spacing;
              if (ds < 200) continue;
              worst = Math.min(worst, Math.hypot(p.x[i] - p.x[j], p.z[i] - p.z[j]));
            }
          }
        }
      }
      expect(worst, `seed ${seed}`).toBeGreaterThan(SEP - 6);
    }
  });

  it('runs over land, near the origin, through cuttings and embankments of moderate height', () => {
    for (const seed of SEEDS) {
      const st = stageOf(seed);
      const tr = st.track;
      for (let i = 0; i < tr.nAll; i += 5) {
        expect(Math.hypot(tr.X[i], tr.Z[i])).toBeLessThan(8200);
        expect(tr.Y[i]).toBeGreaterThan(5);
        expect(worldHeightAt(tr.X[i] + st.shift.x, tr.Z[i] + st.shift.z)).toBeGreaterThan(0);
      }
      expect(st.stats.maxCut, `seed ${seed}`).toBeLessThan(40);
      expect(st.stats.maxFill, `seed ${seed}`).toBeLessThan(40);
    }
  });
});
