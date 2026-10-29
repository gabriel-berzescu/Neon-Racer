/**
 * The stage's profile: the road's height along its plan (the vertical alignment), its banking, and the speed it is designed for.
 *
 * SPEED. designSpeed() is the fastest a car could go at each point: the Dieci (the quickest of the three cars through a corner and
 * nearly the fastest on a straight) at a little above its grip, accelerating and braking harder than it can. It is an upper bound,
 * which is what the crests need.
 *
 * HEIGHT. The road follows the land, smoothed, through cut and fill, as a quadratic B-spline with a control point every KNOT metres:
 * on each knot interval the height is a parabola (a vertical curve, as road engineers draw them) and its slope is continuous. The
 * spline's grade is at most the steepest difference of two neighbouring control points over KNOT, and its vertical curvature on an
 * interval is exactly the second difference of three of them over KNOT^2, so the limits hold for the road itself, not just at its
 * samples:
 *   - grade at most MAX_GRADE (8 %), less where a tight corner would make its inside edge steeper than that, and nearly flat over
 *     the grid and the start line;
 *   - over a crest, a radius of at least CREST_K * v^2 / g for the design speed v there (the car stays pressed to the road: at
 *     v^2 / g it would just float), at least MIN_CREST;
 *   - in a dip, a radius of at least v^2 / (SAG_G * g): a dip of 1.5 g at most (the cars' suspension and downforce take that).
 * The control points are the least-squares fit to the smoothed land under those limits: a quadratic programme solved by Hildreth's
 * method (cyclic projection on the dual, over-relaxed), exact to a fraction of a millimetre.
 *
 * BANK. Mild: up to BANK_MAX (4.3 degrees) in medium and tight corners, a little in fast ones, nothing on straights, eased in along
 * the transitions.
 */
import { gaussSmooth, smoothstep } from './stage-math';
import type { Plan } from './stage-plan';

export const MAX_GRADE = 0.08;
/** Grade over the grid and the first metres past the start line. */
export const START_GRADE = 0.025;
/** Knot spacing of the height spline (m), a whole number of plan samples. */
export const KNOT = 20;
export const CREST_K = 1.15;
export const MIN_CREST = 160;
export const SAG_G = 1.5;
export const MIN_SAG = 120;
export const BANK_MAX = 0.075;
const G = 9.81;

/** The Dieci, generously: grip 2.7 g at low speed, rising with downforce (4.2 g at 250 km/h), 335 km/h. */
const V_MAX = 93;
const A_LAT0 = 2.7 * G;
const AERO_V2 = 8817;
const A_ACC = 14;
const A_BRAKE = 42;

/** The design speed (m/s) at every plan sample: see the header. */
export function designSpeed(plan: Plan): Float64Array {
  const n = plan.n;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(plan.kappa[i]);
    // v^2 k = a0 (1 + v^2 / c)  ->  v^2 = a0 / (k - a0 / c)
    const den = k - A_LAT0 / AERO_V2;
    v[i] = den <= 0 ? V_MAX : Math.min(V_MAX, Math.sqrt(A_LAT0 / den));
  }
  const h = plan.spacing;
  for (let i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] * v[i - 1] + 2 * A_ACC * h));
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * A_BRAKE * h));
  // from a standstill at the grid
  const iStart = Math.round(-plan.sStart / h);
  v[iStart] = Math.min(v[iStart], 0);
  for (let i = iStart + 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] * v[i - 1] + 2 * A_ACC * h));
  return v;
}

export interface Profile {
  /** Height (m) and its slope dy/ds at every plan sample. */
  y: Float64Array;
  m: Float64Array;
  /** Bank (rad, + = left edge higher) at every plan sample. */
  bank: Float64Array;
  /** Design speed (m/s) at every plan sample. */
  speed: Float64Array;
  /** The height spline's control points (control point k governs knot intervals k-2..k) and the s of knot 0. */
  ctrl: Float64Array;
  knotS0: number;
  /** The land the road was fitted to (smoothed), at each knot interval's middle. */
  target: Float64Array;
  /** Largest constraint violation left by the solver (m): ~0. */
  residual: number;
  sweeps: number;
}

interface Constraint {
  /** Indices and coefficients (2 or 3 terms) of a . c <= b. */
  i: number;
  a0: number;
  a1: number;
  a2: number;
  n: number;
  b: number;
}

/**
 * Hildreth's method for min 1/2 |c - t|^2 subject to A c <= b, each row touching 2 or 3 neighbouring entries of c. Returns the
 * largest violation left.
 */
function hildreth(c: Float64Array, cons: Constraint[], maxSweeps: number, tol: number): { residual: number; sweeps: number } {
  const lambda = new Float64Array(cons.length);
  const norm2 = new Float64Array(cons.length);
  for (let k = 0; k < cons.length; k++) {
    const q = cons[k];
    norm2[k] = q.a0 * q.a0 + q.a1 * q.a1 + (q.n === 3 ? q.a2 * q.a2 : 0);
  }
  const omega = 1.6;
  let worst = Infinity;
  let sweep = 0;
  for (; sweep < maxSweeps; sweep++) {
    worst = 0;
    // alternate the direction of the sweep: information travels both ways along the road
    const fwd = (sweep & 1) === 0;
    for (let kk = 0; kk < cons.length; kk++) {
      const k = fwd ? kk : cons.length - 1 - kk;
      const q = cons[k];
      const i = q.i;
      const ac = q.a0 * c[i] + q.a1 * c[i + 1] + (q.n === 3 ? q.a2 * c[i + 2] : 0);
      const viol = ac - q.b;
      if (viol > worst) worst = viol;
      let nl = lambda[k] + (omega * viol) / norm2[k];
      if (nl < 0) nl = 0;
      const dl = nl - lambda[k];
      if (dl === 0) continue;
      lambda[k] = nl;
      c[i] -= dl * q.a0;
      c[i + 1] -= dl * q.a1;
      if (q.n === 3) c[i + 2] -= dl * q.a2;
    }
    if (worst < tol && sweep > 4) break;
  }
  return { residual: worst, sweeps: sweep };
}

/**
 * Makes the control points exactly feasible, changing them as little as it can (the solver leaves a residual of millimetres to
 * centimetres where long chains of limits meet). The limits are a box on each grade g_k = c_{k+1} - c_k and a band on each change of
 * grade g_{k+1} - g_k, so the feasible grades are found exactly by an interval sweep: backwards, the interval of grades at k from
 * which the rest of the road can still be met; forwards, each grade clamped into its interval and into reach of the previous one.
 * The heights are the running sum of the grades from the first control point.
 */
function repair(c: Float64Array, cons: Constraint[], nC: number): void {
  const nG = nC - 1;
  const gMax = new Float64Array(nG).fill(Infinity);
  const gMin = new Float64Array(nG).fill(-Infinity);
  const dLo = new Float64Array(Math.max(0, nG - 1)).fill(-Infinity);
  const dHi = new Float64Array(Math.max(0, nG - 1)).fill(Infinity);
  for (const q of cons) {
    if (q.n === 2) {
      // a0 = 1, a1 = -1: c_i - c_{i+1} <= b  ->  g_i >= -b ; a0 = -1, a1 = 1: g_i <= b
      if (q.a0 > 0) gMin[q.i] = Math.max(gMin[q.i], -q.b);
      else gMax[q.i] = Math.min(gMax[q.i], q.b);
    } else {
      // (-1, 2, -1): -(g_{i+1} - g_i) <= b  ->  g_{i+1} - g_i >= -b ; (1, -2, 1): g_{i+1} - g_i <= b
      if (q.a0 < 0) dLo[q.i] = Math.max(dLo[q.i], -q.b);
      else dHi[q.i] = Math.min(dHi[q.i], q.b);
    }
  }
  const A = new Float64Array(nG);
  const B = new Float64Array(nG);
  A[nG - 1] = gMin[nG - 1];
  B[nG - 1] = gMax[nG - 1];
  for (let k = nG - 2; k >= 0; k--) {
    A[k] = Math.max(gMin[k], A[k + 1] - dHi[k]);
    B[k] = Math.min(gMax[k], B[k + 1] - dLo[k]);
  }
  let prev = 0;
  let y = c[0];
  for (let k = 0; k < nG; k++) {
    let lo = A[k];
    let hi = B[k];
    if (k > 0) {
      lo = Math.max(lo, prev + dLo[k - 1]);
      hi = Math.min(hi, prev + dHi[k - 1]);
    }
    const g = c[k + 1] - c[k];
    const gc = g < lo ? lo : g > hi ? hi : g;
    // (the next height from the repaired grades: the corrections do not pile up, the original heights pull it back)
    y += gc;
    c[k + 1] = y;
    prev = gc;
  }
}

/** The profile for a plan over the land `base` (local coordinates). */
export function buildProfile(plan: Plan, base: (x: number, z: number) => number): Profile {
  const n = plan.n;
  const h = plan.spacing;
  const per = Math.round(KNOT / h);
  const speed = designSpeed(plan);

  // the land along the road: the cross-section's footprint, then smoothed along it
  const land = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const tx = Math.sin(plan.phi[i]);
    const tz = Math.cos(plan.phi[i]);
    let sum = 0;
    let ws = 0;
    for (const [d, w] of [[0, 2], [6, 1.5], [-6, 1.5], [13, 1], [-13, 1]] as const) {
      sum += w * Math.max(base(plan.x[i] + tz * d, plan.z[i] - tx * d), 10);
      ws += w;
    }
    land[i] = sum / ws;
  }
  const smooth = gaussSmooth(land, 40 / h);

  // knot intervals: interval j covers samples j*per .. (j+1)*per; control points 0 .. nInt + 1
  const nInt = Math.ceil((n - 1) / per);
  const nC = nInt + 2;
  const target = new Float64Array(nC);
  for (let k = 0; k < nC; k++) {
    // control point k weighs most on interval k - 1 (its middle)
    const sm = (k - 0.5) * per;
    const i = Math.max(0, Math.min(n - 1, Math.round(sm)));
    target[k] = smooth[i];
  }

  // per-interval limits from the speed and the tightest corner nearby
  const cons: Constraint[] = [];
  const iStart = Math.round(-plan.sStart / h);
  for (let k = 0; k + 1 < nC; k++) {
    // grade between control points k and k + 1: the slope of the spline at the boundary between intervals k - 1 and k
    const sMid = k * per;
    let minR = Infinity;
    for (let i = Math.max(0, sMid - 2 * per); i <= Math.min(n - 1, sMid + 2 * per); i++) minR = Math.min(minR, 1 / Math.max(1e-9, Math.abs(plan.kappa[i])));
    let g = MAX_GRADE * Math.min(1, (minR - 6) / minR);
    if (sMid <= iStart + Math.round(60 / h)) g = START_GRADE;
    const b = g * KNOT;
    cons.push({ i: k, a0: 1, a1: -1, a2: 0, n: 2, b });
    cons.push({ i: k, a0: -1, a1: 1, a2: 0, n: 2, b });
  }
  for (let j = 0; j < nInt; j++) {
    let v = 0;
    for (let i = j * per; i <= Math.min(n - 1, (j + 1) * per); i++) v = Math.max(v, speed[i]);
    const rc = Math.max(MIN_CREST, (CREST_K * v * v) / G);
    const rs = Math.max(MIN_SAG, (v * v) / (SAG_G * G));
    // y'' = (c_j - 2 c_{j+1} + c_{j+2}) / KNOT^2 in [-1/rc, 1/rs]
    cons.push({ i: j, a0: -1, a1: 2, a2: -1, n: 3, b: (KNOT * KNOT) / rc });
    cons.push({ i: j, a0: 1, a1: -2, a2: 1, n: 3, b: (KNOT * KNOT) / rs });
  }
  const ctrl = Float64Array.from(target);
  const sol = hildreth(ctrl, cons, 2500, 2e-5);
  repair(ctrl, cons, nC);

  // evaluate the spline at every sample
  const y = new Float64Array(n);
  const m = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let j = Math.floor(i / per);
    if (j >= nInt) j = nInt - 1;
    const u = (i - j * per) / per;
    const c0 = ctrl[j];
    const c1 = ctrl[j + 1];
    const c2 = ctrl[j + 2];
    y[i] = 0.5 * (1 - u) * (1 - u) * c0 + (0.5 + u - u * u) * c1 + 0.5 * u * u * c2;
    m[i] = ((1 - u) * (c1 - c0) + u * (c2 - c1)) / KNOT;
  }

  // the bank: by the corner's tightness, eased along the road
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = plan.kappa[i];
    raw[i] = Math.sign(k) * BANK_MAX * smoothstep(1 / 1400, 1 / 160, Math.abs(k));
  }
  const bank = gaussSmooth(raw, 8 / h);

  return { y, m, bank, speed, ctrl, knotS0: plan.sStart, target, residual: sol.residual, sweeps: sol.sweeps };
}
