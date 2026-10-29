/**
 * Small helpers shared by the stage generator (src/world/stage*.ts): a seeded random generator and a few scalar functions.
 */

/** A small, fast, seeded random generator (mulberry32): uniform in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Uniform in [a, b). */
export const uni = (r: () => number, a: number, b: number): number => a + (b - a) * r();

/** Log-uniform in [a, b): as many small values as large ones, per octave. */
export const logUni = (r: () => number, a: number, b: number): number => a * Math.pow(b / a, r());

/** Wraps an angle into (-pi, pi]. */
export function wrapAngle(a: number): number {
  const t = Math.PI * 2;
  a = a % t;
  if (a > Math.PI) a -= t;
  else if (a <= -Math.PI) a += t;
  return a;
}

/** Cubic Hermite on [0, h]: value at t in [0, 1] from end values and slopes (per metre). */
export function hermite(y0: number, m0: number, y1: number, m1: number, h: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m1;
}

/** d/ds of hermite() (per metre). */
export function hermiteSlope(y0: number, m0: number, y1: number, m1: number, h: number, t: number): number {
  const t2 = t * t;
  return ((6 * t2 - 6 * t) * y0 + (3 * t2 - 4 * t + 1) * h * m0 + (-6 * t2 + 6 * t) * y1 + (3 * t2 - 2 * t) * h * m1) / h;
}

/** Zero-phase gaussian smoothing of a uniformly sampled series (sigma in samples), clamped at the ends. */
export function gaussSmooth(v: Float64Array, sigma: number): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  if (sigma <= 0) {
    out.set(v);
    return out;
  }
  const r = Math.ceil(sigma * 3);
  const w = new Float64Array(2 * r + 1);
  for (let k = -r; k <= r; k++) w[k + r] = Math.exp((-0.5 * k * k) / (sigma * sigma));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let ws = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k < 0 ? 0 : i + k >= n ? n - 1 : i + k;
      sum += v[j] * w[k + r];
      ws += w[k + r];
    }
    out[i] = sum / ws;
  }
  return out;
}
