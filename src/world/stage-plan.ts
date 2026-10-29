/**
 * The stage's plan: the road's line seen from above (its horizontal alignment), laid out from a seed over the land.
 *
 * The road is a curvature profile, the way road engineers draw one: curvature kappa(s) is piecewise linear in s, so every corner is
 * an entry transition (a clothoid: the curvature grows steadily from 0, the steering winds on at a steady rate), an arc of constant
 * radius, and an exit transition back to 0; esses reverse through 0 the same way. The heading is the integral of kappa and the
 * position the integral of the heading (exact quadratic heading per piece, Simpson's rule in 0.5 m steps).
 *
 * The profile is built section by section from a menu of designed patterns (a long straight, a fast sweeper, a braking zone into a
 * tight corner or a hairpin, esses, a chicane at the end of a straight, two corners in a row, a corner that tightens or opens), each
 * drawn with random sizes inside the ranges these cars want (below). For every section a dozen candidates are drawn and the best
 * one is kept, judged on:
 *   - the land: no sea, little cut and fill for a road that climbs at most ~7 % (a rough grade-limited height that follows the
 *     terrain; never more than MAX_DEV: the land's deep valleys and slot canyons are gone round, not dammed), gentle cross-slopes
 *     (a road along a steep hillside needs deep cuts);
 *   - the stage as a whole: it never comes back near itself (any two points of the road more than 160 m apart along it stay at
 *     least SEP metres apart; closer than that, at least 0.42 x the distance along it), stays within RMAX of the start, and keeps
 *     roughly to a bearing that drifts slowly, so it travels;
 *   - its balance: tight corners and long straights are asked for until the stage has its share of them.
 * If no candidate fits, the generator backs up a section and tries again.
 *
 * s = 0 is the start line. The plan runs from s = -PRE (the grid area behind the start line) to the finish line at s = length, and on
 * through a run-out of RUNOUT metres past it.
 */
import { clamp, logUni, rng, uni, wrapAngle } from './stage-math';

/** Metres between plan samples (also the physics' centreline spacing). */
export const PLAN_SPACING = 2;
/** Road behind the start line (the grid). */
export const PRE = 100;
/** Road past the finish line (braking and stopping). */
export const RUNOUT = 640;
/** Distant parts of the road stay at least this far apart (centreline to centreline, m). */
export const SEP = 80;
/** Parts of the road closer than this along it are "near": they only need 0.42 x their distance along the road. */
const NEAR_S = 160;
/** The road stays within this distance of the start (m): float32 keeps millimetres there. */
export const RMAX = 8000;

export type CornerKind = 'sweeper' | 'fast' | 'medium' | 'tight' | 'hairpin';

/** One corner of the plan. */
export interface PlanCorner {
  kind: CornerKind;
  /** +1 = left, -1 = right. */
  dir: 1 | -1;
  radius: number;
  /** Total turn (rad, positive). */
  angle: number;
  /** Where the corner starts (entry transition) and ends (exit transition), s (m). */
  s0: number;
  s1: number;
}

export interface Plan {
  spacing: number;
  /** s of sample 0 (= -PRE). */
  sStart: number;
  /** Samples: i at s = sStart + i * spacing, from -PRE to length + RUNOUT. */
  n: number;
  x: Float64Array;
  z: Float64Array;
  /** Heading: the unit tangent is (sin phi, cos phi) (phi = 0: +z, south; pi: north). */
  phi: Float64Array;
  /** Signed curvature (1/m, + = turning left). */
  kappa: Float64Array;
  /** Start line to finish line (m), a whole number of samples. */
  length: number;
  corners: PlanCorner[];
  /** The patterns the stage was built from, in order (for names and debugging). */
  sections: string[];
  /** Retries the generator needed (backtracks). */
  retries: number;
}

type Ramp = [length: number, kappaEnd: number];

interface Section {
  kind: string;
  ramps: Ramp[];
  corners: { kind: CornerKind; dir: 1 | -1; radius: number; angle: number; from: number; to: number }[];
}

interface State {
  s: number;
  x: number;
  z: number;
  phi: number;
  k: number;
}

interface Point {
  s: number;
  x: number;
  z: number;
  phi: number;
  k: number;
}

/**
 * Integrates `ramps` from `st` (updated in place), emitting a point every `spacing` metres of s (at multiples of spacing) into `out`.
 * Kappa is linear over each ramp, so the heading is an exact quadratic; positions use Simpson's rule in steps of at most `sub`.
 */
function integrate(st: State, ramps: readonly Ramp[], spacing: number, sub: number, out: Point[]): void {
  for (const [L, kEnd] of ramps) {
    if (L <= 0) {
      st.k = kEnd;
      continue;
    }
    const s0 = st.s;
    const k0 = st.k;
    const phi0 = st.phi;
    const dk = (kEnd - k0) / L;
    const head = (u: number): number => phi0 + k0 * u + 0.5 * dk * u * u;
    let u = 0;
    let x = st.x;
    let z = st.z;
    while (u < L - 1e-9) {
      const nextEmit = (Math.floor((s0 + u) / spacing + 1e-7) + 1) * spacing;
      const stop = Math.min(L, nextEmit - s0);
      const n = Math.max(1, Math.ceil((stop - u) / sub - 1e-9));
      const h = (stop - u) / n;
      for (let i = 0; i < n; i++) {
        const a = u + i * h;
        const pa = head(a);
        const pm = head(a + h / 2);
        const pb = head(a + h);
        x += (h / 6) * (Math.sin(pa) + 4 * Math.sin(pm) + Math.sin(pb));
        z += (h / 6) * (Math.cos(pa) + 4 * Math.cos(pm) + Math.cos(pb));
      }
      u = stop;
      if (Math.abs(s0 + u - nextEmit) < 1e-6) out.push({ s: nextEmit, x, z, phi: head(u), k: k0 + dk * u });
    }
    st.s = s0 + L;
    st.x = x;
    st.z = z;
    st.phi = head(L);
    st.k = kEnd;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The corner menu
// ---------------------------------------------------------------------------------------------------------------------------------

const DEG = Math.PI / 180;

/** Radius range (m), turn range (deg) and transition length as a fraction of the radius (clamped to [cloMin, cloMax] m). */
const KIND: Record<CornerKind, { R: [number, number]; ang: [number, number]; clo: [number, number]; cloMin: number; cloMax: number }> = {
  sweeper: { R: [300, 1200], ang: [14, 50], clo: [0.25, 0.5], cloMin: 60, cloMax: 260 },
  fast: { R: [180, 320], ang: [20, 75], clo: [0.3, 0.6], cloMin: 50, cloMax: 160 },
  medium: { R: [70, 180], ang: [30, 105], clo: [0.4, 0.8], cloMin: 30, cloMax: 110 },
  tight: { R: [25, 50], ang: [60, 135], clo: [0.55, 1.0], cloMin: 16, cloMax: 40 },
  hairpin: { R: [25, 32], ang: [145, 175], clo: [0.6, 0.9], cloMin: 16, cloMax: 28 },
};

interface CornerDraw {
  kind: CornerKind;
  dir: 1 | -1;
  R: number;
  angle: number;
  lin: number;
  lout: number;
}

function drawCorner(r: () => number, kind: CornerKind, dir: 1 | -1, angleDeg?: number): CornerDraw {
  const K = KIND[kind];
  const R = logUni(r, K.R[0], K.R[1]);
  const angle = (angleDeg ?? uni(r, K.ang[0], K.ang[1])) * DEG;
  const lin = clamp(R * uni(r, K.clo[0], K.clo[1]), K.cloMin, K.cloMax);
  const lout = clamp(R * uni(r, K.clo[0], K.clo[1]), K.cloMin, K.cloMax);
  return { kind, dir, R, angle, lin, lout };
}

/**
 * Appends one corner's ramps: entry transition to dir/R, the arc, exit transition to 0. The transitions turn the road by half their
 * length over R each, so the arc is what is left of the angle; a corner too small for its transitions is all transition.
 */
function pushCorner(sec: Section, c: CornerDraw, at: number): number {
  const k = c.dir / c.R;
  let lin = c.lin;
  let lout = c.lout;
  let la = c.R * c.angle - (lin + lout) / 2;
  if (la < 0) {
    const f = (c.R * c.angle) / ((lin + lout) / 2);
    lin *= f;
    lout *= f;
    la = 0;
  }
  sec.ramps.push([lin, k]);
  if (la > 0) sec.ramps.push([la, k]);
  sec.ramps.push([lout, 0]);
  const len = lin + la + lout;
  sec.corners.push({ kind: c.kind, dir: c.dir, radius: c.R, angle: c.angle, from: at, to: at + len });
  return at + len;
}

/** A compound corner (same direction, radius R1 then R2), joined by a transition. */
function pushCompound(sec: Section, a: CornerDraw, b: CornerDraw, at: number): number {
  const k1 = a.dir / a.R;
  const k2 = a.dir / b.R;
  const lt = Math.max(20, Math.abs(a.R - b.R) * 0.35);
  // the transition turns by lt * (k1 + k2) / 2 (in |k|)
  const turnT = (lt * (Math.abs(k1) + Math.abs(k2))) / 2;
  const la1 = Math.max(0, a.R * a.angle - a.lin / 2 - turnT / 2);
  const la2 = Math.max(0, b.R * b.angle - b.lout / 2 - turnT / 2);
  sec.ramps.push([a.lin, k1]);
  if (la1 > 0) sec.ramps.push([la1, k1]);
  sec.ramps.push([lt, k2]);
  if (la2 > 0) sec.ramps.push([la2, k2]);
  sec.ramps.push([b.lout, 0]);
  const len = a.lin + la1 + lt + la2 + b.lout;
  const angle = a.lin / (2 * a.R) + la1 / a.R + turnT + la2 / b.R + b.lout / (2 * b.R);
  sec.corners.push({ kind: b.R < a.R ? b.kind : a.kind, dir: a.dir, radius: Math.min(a.R, b.R), angle, from: at, to: at + len });
  return at + len;
}

function pushStraight(sec: Section, L: number, at: number): number {
  sec.ramps.push([L, 0]);
  return at + L;
}

const flip = (d: 1 | -1): 1 | -1 => (d === 1 ? -1 : 1);

type PatternName = 'straight' | 'long' | 'sweeper' | 'medium' | 'tight' | 'hairpin' | 'esses' | 'chicane' | 'double' | 'tightening' | 'opening';

/** One instance of a pattern, with random sizes and its first corner turning `dir`. */
function drawPattern(r: () => number, name: PatternName, dir: 1 | -1): Section {
  const sec: Section = { kind: name, ramps: [], corners: [] };
  let at = 0;
  switch (name) {
    case 'straight':
      pushStraight(sec, r() < 0.5 ? uni(r, 40, 160) : uni(r, 160, 420), at);
      break;
    case 'long':
      pushStraight(sec, uni(r, 480, 1000), at);
      break;
    case 'sweeper':
      at = pushCorner(sec, drawCorner(r, r() < 0.6 ? 'sweeper' : 'fast', dir), at);
      if (r() < 0.5) pushStraight(sec, uni(r, 40, 200), at);
      break;
    case 'medium':
      at = pushCorner(sec, drawCorner(r, 'medium', dir), at);
      if (r() < 0.6) pushStraight(sec, uni(r, 30, 160), at);
      break;
    case 'tight':
      at = pushStraight(sec, uni(r, 120, 360), at);
      at = pushCorner(sec, drawCorner(r, 'tight', dir), at);
      pushStraight(sec, uni(r, 40, 180), at);
      break;
    case 'hairpin':
      at = pushStraight(sec, uni(r, 160, 400), at);
      at = pushCorner(sec, drawCorner(r, 'hairpin', dir), at);
      pushStraight(sec, uni(r, 60, 200), at);
      break;
    case 'esses': {
      const n = r() < 0.6 ? 2 : r() < 0.7 ? 3 : 4;
      let d = dir;
      for (let i = 0; i < n; i++) {
        const kind: CornerKind = r() < 0.45 ? 'medium' : r() < 0.7 ? 'fast' : 'sweeper';
        const c = drawCorner(r, kind, d, kind === 'sweeper' ? uni(r, 15, 40) : uni(r, 25, 70));
        at = pushCorner(sec, c, at);
        if (i < n - 1 && r() < 0.35) at = pushStraight(sec, uni(r, 10, 60), at);
        d = flip(d);
      }
      if (r() < 0.5) pushStraight(sec, uni(r, 40, 160), at);
      break;
    }
    case 'chicane': {
      at = pushStraight(sec, uni(r, 260, 600), at);
      const a1 = uni(r, 28, 55);
      const R = logUni(r, 35, 70);
      const mk = (d: 1 | -1, ang: number): CornerDraw => ({ kind: R < 50 ? 'tight' : 'medium', dir: d, R, angle: ang * DEG, lin: uni(r, 14, 26), lout: uni(r, 14, 26) });
      at = pushCorner(sec, mk(dir, a1), at);
      at = pushCorner(sec, mk(flip(dir), a1 * uni(r, 0.85, 1.15)), at);
      pushStraight(sec, uni(r, 60, 220), at);
      break;
    }
    case 'double': {
      const k1: CornerKind = r() < 0.5 ? 'medium' : 'tight';
      at = pushCorner(sec, drawCorner(r, k1, dir, uni(r, 35, 80)), at);
      at = pushStraight(sec, uni(r, 25, 90), at);
      at = pushCorner(sec, drawCorner(r, r() < 0.6 ? 'medium' : 'fast', dir, uni(r, 30, 75)), at);
      pushStraight(sec, uni(r, 40, 160), at);
      break;
    }
    case 'tightening': {
      const a = drawCorner(r, r() < 0.5 ? 'fast' : 'sweeper', dir, uni(r, 20, 45));
      const b = drawCorner(r, r() < 0.65 ? 'medium' : 'tight', dir, uni(r, 30, 80));
      at = pushCompound(sec, a, b, at);
      pushStraight(sec, uni(r, 40, 180), at);
      break;
    }
    case 'opening': {
      const a = drawCorner(r, r() < 0.6 ? 'medium' : 'tight', dir, uni(r, 30, 70));
      const b = drawCorner(r, 'fast', dir, uni(r, 20, 45));
      at = pushCompound(sec, a, b, at);
      pushStraight(sec, uni(r, 60, 220), at);
      break;
    }
  }
  return sec;
}

const BASE_WEIGHTS: Record<PatternName, number> = {
  straight: 0.9,
  long: 0.35,
  sweeper: 1.3,
  medium: 1.0,
  tight: 0.55,
  hairpin: 0.15,
  esses: 1.1,
  chicane: 0.35,
  double: 0.5,
  tightening: 0.45,
  opening: 0.4,
};

// ---------------------------------------------------------------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------------------------------------------------------------

/** A spatial hash of the accepted road's coarse points (every COARSE m). */
class RoadHash {
  private readonly cells = new Map<number, number[]>();
  readonly pts: Point[] = [];
  constructor(private readonly cell: number) {}
  private key(x: number, z: number): number {
    return (Math.floor(x / this.cell) + 4096) * 8192 + (Math.floor(z / this.cell) + 4096);
  }
  add(p: Point): void {
    const k = this.key(p.x, p.z);
    let a = this.cells.get(k);
    if (!a) this.cells.set(k, (a = []));
    a.push(this.pts.length);
    this.pts.push(p);
  }
  /** Drops every point from index `n` on (they were the last added). */
  truncate(n: number): void {
    while (this.pts.length > n) {
      const p = this.pts.pop()!;
      const a = this.cells.get(this.key(p.x, p.z))!;
      a.pop();
    }
  }
  /** True if (x, z) at road distance s is too close to an accepted point (see the header). */
  conflicts(x: number, z: number, s: number): boolean {
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cz - 1; j <= cz + 1; j++) {
        const a = this.cells.get((i + 4096) * 8192 + (j + 4096));
        if (!a) continue;
        for (const idx of a) {
          const p = this.pts[idx];
          const ds = s - p.s;
          const need = ds >= NEAR_S ? SEP : 0.42 * ds;
          const dx = p.x - x;
          const dz = p.z - z;
          if (dx * dx + dz * dz < need * need) return true;
        }
      }
    }
    return false;
  }
}

/** Coarse spacing for candidate points (m). */
const COARSE = 10;
/** Candidates drawn per section. */
const CANDIDATES = 14;

/** A rough road height, grade-limited, following the terrain: for judging cut and fill. */
const ROUGH_GRADE = 0.07;
/** No candidate needs more cut or fill than this under its rough height (m). */
const MAX_DEV = 36;
/** The land 110 m either side of the road is never further than this below (or above) it (m). */
const MAX_DROP = 75;
/** No straight is longer than this (m): two straight patterns in a row, or a corner's straight ends, add up. */
const MAX_STRAIGHT = 1100;

/** The straight at the start of a section and at its end (m), and its total length. */
function straightEnds(sec: Section): { lead: number; trail: number; all: boolean } {
  let lead = 0;
  let k = 0;
  for (; k < sec.ramps.length && sec.ramps[k][1] === 0; k++) lead += sec.ramps[k][0];
  if (k === sec.ramps.length) return { lead, trail: lead, all: true };
  let trail = 0;
  for (let j = sec.ramps.length - 1; j >= 0 && sec.ramps[j][1] === 0; j--) {
    // (a ramp to 0 ends a corner: only a ramp that starts and ends at 0 is straight)
    if (j > 0 && sec.ramps[j - 1][1] !== 0) break;
    trail += sec.ramps[j][0];
  }
  return { lead, trail, all: false };
}

interface Judged {
  sec: Section;
  pts: Point[];
  end: State;
  yEnd: number;
  cost: number;
}

export interface PlanInput {
  seed: number;
  /** The terrain (local coordinates: the stage starts at the origin). */
  base: (x: number, z: number) => number;
  /** The start line's heading (rad); the plan starts PRE metres behind (0, 0) on it. */
  heading: number;
}

/** Restarts of the whole plan before the place is given up (the caller then tries another place). */
const ATTEMPTS = 7;

/**
 * Lays out the plan for a seed over `base`. Deterministic. Null if no road fits this land after ATTEMPTS restarts: the caller tries
 * another place (src/world/stage.ts).
 */
export function generatePlan(input: PlanInput): Plan | null {
  const r = rng((input.seed ^ 0x2c1b3c6d) >>> 0);
  const base = input.base;
  const target = uni(r, 9000, 13000);
  const goalAmp = uni(r, 0.5, 1.2);
  const goalPeriod = uni(r, 5000, 10000);
  const goalPhase = r() < 0.5 ? 0 : Math.PI;
  let retries = 0;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const heading = input.heading + (attempt === 0 ? 0 : uni(r, -0.6, 0.6));
    // (the land's limits ease on the later attempts: hard land still gets a road, with taller banks)
    const relax = attempt < 3 ? 1 : attempt < 5 ? 1.35 : 1.8;
    const maxDev = MAX_DEV * relax;
    const maxDrop = MAX_DROP * relax;
    const goal = (s: number): number => heading + goalAmp * Math.sin((2 * Math.PI * s) / goalPeriod + goalPhase) * (goalPhase === 0 ? 1 : -1);
    const hash = new RoadHash(SEP);
    // the grid area behind the start line
    const st0: State = { s: -PRE, x: -Math.sin(heading) * PRE, z: -Math.cos(heading) * PRE, phi: heading, k: 0 };
    const first: Point[] = [{ s: -PRE, x: st0.x, z: st0.z, phi: heading, k: 0 }];
    integrate(st0, [[PRE, 0]], COARSE, 2, first);
    for (const p of first) hash.add(p);
    const y0 = base(0, 0);
    const stack: { sec: Section; end: State; yEnd: number; hashLen: number; trail: number }[] = [];
    let cur: State = { ...st0 };
    let yCur = Math.max(y0, 12);
    let fails = 0;
    let tightCount = 0;
    let longCount = 0;
    let lastKind = '';
    let finished = false;

    // the straight the accepted road ends with (m)
    let trail = 0;
    const judge = (sec: Section, from: State, yFrom: number): Judged | null => {
      const ends = straightEnds(sec);
      if (sec.kind !== 'runout' && trail + ends.lead > MAX_STRAIGHT) return null;
      const st: State = { ...from };
      const pts: Point[] = [];
      integrate(st, sec.ramps, COARSE, 2, pts);
      let cost = 0;
      let y = yFrom;
      // the geometry first (cheap), then the land
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (p.x * p.x + p.z * p.z > RMAX * RMAX) return null;
        if (hash.conflicts(p.x, p.z, p.s)) return null;
        // against itself
        for (let j = 0; j < i; j++) {
          const q = pts[j];
          const ds = p.s - q.s;
          const need = ds >= NEAR_S ? SEP : 0.42 * ds;
          if ((p.x - q.x) ** 2 + (p.z - q.z) ** 2 < need * need) return null;
        }
      }
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (i % 2 === 1) {
          // the land, every 20 m
          const tx = Math.sin(p.phi);
          const tz = Math.cos(p.phi);
          const tc = base(p.x, p.z);
          if (tc < 8) return null;
          const tl = base(p.x + tz * 40, p.z - tx * 40);
          const tr = base(p.x - tz * 40, p.z + tx * 40);
          if (tc < 16) cost += (16 - tc) * 0.5;
          const lo = Math.min(tl, tr);
          if (lo < 4) cost += (4 - lo) * 0.3;
          const step = ROUGH_GRADE * 2 * COARSE;
          y = clamp(Math.max(tc, 12), y - step, y + step);
          const dev = Math.abs(y - tc);
          // (a deep valley or one of the land's slot canyons: go round it, the road would need a dam or a tunnel)
          if (dev > maxDev) return null;
          if (dev > 3) cost += (dev - 3) * (dev - 3) * 0.02;
          const side = Math.abs(tl - tr) / 80;
          if (side > 0.16) cost += (side - 0.16) * 4;
          // a road perched above a big drop (or deep in a trench) needs embankments (cuttings) taller than the carve reaches
          const fl = base(p.x + tz * 110, p.z - tx * 110);
          const fr = base(p.x - tz * 110, p.z + tx * 110);
          const drop = Math.max(y - Math.min(fl, fr), Math.max(fl, fr) - y);
          if (drop > maxDrop) return null;
          if (drop > 40) cost += (drop - 40) * 0.08;
        }
      }
      const len = st.s - from.s;
      const dev = Math.abs(wrapAngle(st.phi - goal(st.s)));
      // cost per 100 m of road, plus a pull towards the bearing
      const total = (cost / Math.max(len, 50)) * 100 + 3 * Math.max(0, dev - 0.7) ** 2;
      return { sec, pts, end: st, yEnd: y, cost: total };
    };

    const accept = (j: Judged): void => {
      stack.push({ sec: j.sec, end: { ...cur }, yEnd: yCur, hashLen: hash.pts.length, trail });
      const e = straightEnds(j.sec);
      trail = e.all ? trail + e.lead : e.trail;
      for (const p of j.pts) hash.add(p);
      cur = j.end;
      yCur = j.yEnd;
      lastKind = j.sec.kind;
      for (const c of j.sec.corners) if (c.radius < 52) tightCount++;
      if (j.sec.kind === 'long') longCount++;
    };
    const backtrack = (): void => {
      const top = stack.pop();
      if (!top) return;
      hash.truncate(top.hashLen);
      cur = top.end;
      yCur = top.yEnd;
      trail = top.trail;
      for (const c of top.sec.corners) if (c.radius < 52) tightCount--;
      if (top.sec.kind === 'long') longCount--;
      lastKind = stack.length ? stack[stack.length - 1].sec.kind : '';
    };

    // the start straight
    {
      const sec: Section = { kind: 'start', ramps: [[uni(r, 160, 420), 0]], corners: [] };
      const j = judge(sec, cur, yCur);
      if (!j) continue;
      accept(j);
    }

    let stuck = 0;
    while (fails < 36) {
      if (cur.s >= target - 420) {
        // the finish straight (ending on a whole sample) and the run-out
        const Lf0 = uni(r, 300, 440);
        const sFinish = Math.ceil((cur.s + Lf0) / PLAN_SPACING) * PLAN_SPACING;
        const sec: Section = { kind: 'finish', ramps: [[sFinish - cur.s, 0]], corners: [] };
        const runout: Section = { kind: 'runout', ramps: [[RUNOUT, 0]], corners: [] };
        const jf = judge(sec, cur, yCur);
        const jr = jf && judge(runout, jf.end, jf.yEnd);
        if (jf && jr) {
          accept(jf);
          accept(jr);
          finished = true;
          break;
        }
        fails++;
        backtrack();
        continue;
      }
      // weights: the stage's balance so far
      const done = Math.max(cur.s, 1);
      const w: Record<PatternName, number> = { ...BASE_WEIGHTS };
      const tightWant = (done / 2600) - tightCount;
      if (tightWant > 0.3) {
        w.tight *= 3;
        w.hairpin *= 2;
        w.chicane *= 1.6;
      } else if (tightWant < -1.5) {
        w.tight *= 0.3;
        w.hairpin *= 0.2;
        w.chicane *= 0.4;
      }
      if (longCount < Math.floor(done / 4500) + 1 && done > 1500) w.long *= 3;
      if (lastKind === 'straight' || lastKind === 'long' || lastKind === 'start') {
        w.straight *= 0.15;
        w.long *= 0.1;
        w.tight *= 0.4; // (its braking zone is a straight already)
        w.hairpin *= 0.4;
        w.chicane *= 0.3;
      }
      if (lastKind in w) w[lastKind as PatternName] *= 0.45;
      const names = Object.keys(w) as PatternName[];
      const total = names.reduce((a, n) => a + w[n], 0);

      let best: Judged | null = null;
      let bestScore = Infinity;
      for (let c = 0; c < CANDIDATES; c++) {
        let pick = r() * total;
        let name: PatternName = names[0];
        for (const n of names) {
          pick -= w[n];
          if (pick <= 0) {
            name = n;
            break;
          }
        }
        const dir: 1 | -1 = r() < 0.5 ? 1 : -1;
        const sec = drawPattern(r, name, dir);
        const j = judge(sec, cur, yCur);
        if (!j) continue;
        // what the stage still needs counts for a candidate that brings it
        let need = 0;
        if (tightWant > 0.3 && sec.corners.some((c) => c.radius < 52)) need += 0.9 + 0.5 * tightWant;
        if (name === 'long' && w.long > BASE_WEIGHTS.long * 1.5) need += 0.8;
        const score = j.cost + uni(r, 0, 0.8) - need;
        if (score < bestScore) {
          bestScore = score;
          best = j;
        }
      }
      if (best) {
        accept(best);
        stuck = 0;
      } else {
        // back up a section, and further the longer it stays stuck
        fails++;
        retries++;
        stuck++;
        for (let k = 0; k < 1 + Math.floor(stuck / 3); k++) backtrack();
      }
    }
    if (!finished) {
      retries++;
      continue;
    }

    // the final plan at PLAN_SPACING
    const st: State = { s: -PRE, x: -Math.sin(heading) * PRE, z: -Math.cos(heading) * PRE, phi: heading, k: 0 };
    const pts: Point[] = [{ ...st }];
    const ramps: Ramp[] = [[PRE, 0]];
    const corners: PlanCorner[] = [];
    let s = 0;
    for (const e of stack) {
      for (const c of e.sec.corners) corners.push({ kind: c.kind, dir: c.dir, radius: c.radius, angle: c.angle, s0: s + c.from, s1: s + c.to });
      for (const rp of e.sec.ramps) {
        ramps.push(rp);
        s += rp[0];
      }
    }
    integrate(st, ramps, PLAN_SPACING, 0.5, pts);
    const n = pts.length;
    const plan: Plan = {
      spacing: PLAN_SPACING,
      sStart: -PRE,
      n,
      x: new Float64Array(n),
      z: new Float64Array(n),
      phi: new Float64Array(n),
      kappa: new Float64Array(n),
      length: 0,
      corners,
      sections: stack.map((e) => e.sec.kind),
      retries,
    };
    for (let i = 0; i < n; i++) {
      plan.x[i] = pts[i].x;
      plan.z[i] = pts[i].z;
      plan.phi[i] = pts[i].phi;
      plan.kappa[i] = pts[i].k;
    }
    const sEnd = -PRE + (n - 1) * PLAN_SPACING;
    plan.length = Math.round(sEnd - RUNOUT);
    return plan;
  }
  return null;
}
