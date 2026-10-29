/**
 * StageTrack: the TrackRuntime of a stage, the open road the physics drives on (headless, allocation-free queries).
 *
 * Geometry. The centreline is the plan (src/world/stage-plan.ts) sampled every SPACING m, from PRE metres behind the start line (the
 * grid) to RUNOUT metres past the finish line. Between samples i and i + 1 the world position of (s, d) is the BILINEAR map
 *   P(t, d) = P_i + t (P_{i+1} - P_i) + d (L_i + t (L_{i+1} - L_i))      (L: the horizontal unit left vector at the samples)
 * which project() inverts exactly (a quadratic in t), so pointAt and project round-trip to float precision and the patches tile the
 * plane without gaps (as in Xeno-Racer's circuits). d is horizontal.
 *
 * Height. The centreline height is a cubic Hermite between samples from the profile's height and slope there (src/world/stage-profile.ts;
 * the profile is a quadratic spline whose knots fall on samples, which the Hermite reproduces exactly). Across, the whole formation
 * (out to FORMATION m each side: asphalt, shoulder, run-off, the barrier's foot and a verge behind it) is one plane tilted by the bank:
 *   h(s, d) = y(s) + d tan(bank(s)).
 * Beyond the formation (nothing drivable: the barriers are at WALL) it is the carved terrain the stage was given (`outside`).
 *
 * Cross-section, from the centreline out (each side):
 *   0 .. ROAD_HALF (6 m)       asphalt
 *   .. SHOULDER (9 m)          a concrete shoulder (paved: a slick keeps nearly all its grip, so a car that runs wide is not spun)
 *   .. WALL (12 m)             run-off: RUNOFF_SURFACE (dirt: slower; see the note on it below)
 *   WALL                       the barrier face (TrackRuntime walls: hard)
 *   .. FORMATION (14.5 m)      the barrier's foot and a verge; the terrain's cut and fill start there
 * The grid area behind the start (from GRID_TRAP m back) and the end of the run-out (the last END_TRAP m) are sand traps: a car that
 * reverses off the grid or does not brake after the finish is stopped there. Past the very ends the ground rises steeply.
 *
 * s runs from -PRE (behind the start line) to length + RUNOUT (past the finish line): project() returns those values, so s < 0 on
 * the grid and s > length past the finish. wrapS() clamps to [0, length]. The public per-sample arrays (px, tx, ...) cover the
 * stage itself, sample i at s = i * spacing for i = 0 .. count (count = length / spacing); the hints that project() and groundAt()
 * return are opaque (indices into the internal, longer arrays): pass back the RETURN value. TrackPoint.segment is the nearest public
 * sample index, clamped to [0, count].
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { GridSlot, GroundSample, SurfaceType, TrackFrame, TrackInfo, TrackPoint, TrackRuntime } from '../core/contracts';
import { clamp, hermite, hermiteSlope } from './stage-math';
import type { Plan } from './stage-plan';
import type { Profile } from './stage-profile';

/** Asphalt half-width (m). */
export const ROAD_HALF = 6;
/** The paved shoulder's outer edge (m from the centreline). */
export const SHOULDER = 9;
/** The barrier face (m from the centreline). */
export const WALL = 12;
/** The formation's edge: where the terrain's cut and fill begin (m from the centreline). */
export const FORMATION = 14.5;
/**
 * The run-off beyond the shoulder. On loose ground a slick keeps little grip (src/physics/surfaces.ts: 0.23 of asphalt on grass,
 * 0.28 on dirt) and drags: a car that gets there is slowed. Measured (the autopilot, 140-180 km/h, sliding onto it angled at the
 * barrier and steering back): without the stability assists every car spins there, with ESC and TCS none does; two wheels off on
 * the shoulder at 220 km/h spins nobody. StageTrack.runoff can change it per track ('concrete': nothing spins, nothing is slower).
 */
export const RUNOFF_SURFACE: SurfaceType = 'dirt';
/** The sand traps: behind the grid from s < -GRID_TRAP, and over the last END_TRAP m of the run-out. */
export const GRID_TRAP = 58;
export const END_TRAP = 180;

const _m = new Matrix4();
const _a = new Vector3();
const _b = new Vector3();

export interface StageTrackParts {
  plan: Plan;
  profile: Profile;
  info: TrackInfo;
  /** The ground beyond the formation (the carved terrain, local coordinates, the sea's surface at 0 included). */
  outside: (x: number, z: number) => number;
}

export class StageTrack implements TrackRuntime {
  readonly info: TrackInfo;
  readonly length: number;
  readonly spacing: number;
  readonly count: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly tx: Float32Array;
  readonly ty: Float32Array;
  readonly tz: Float32Array;
  readonly nx: Float32Array;
  readonly ny: Float32Array;
  readonly nz: Float32Array;
  readonly lx: Float32Array;
  readonly ly: Float32Array;
  readonly lz: Float32Array;
  readonly widthLeft: Float32Array;
  readonly widthRight: Float32Array;
  readonly wallLeft: Float32Array;
  readonly wallRight: Float32Array;
  readonly curvature: Float32Array;
  readonly bank: Float32Array;
  readonly sectors: readonly [number, number];
  readonly grid: readonly GridSlot[];
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number };

  // ── the whole road, grid and run-out included (float64; index e at s = sStart + e * spacing) ──
  /** s of internal sample 0 (negative). */
  readonly sStart: number;
  /** s where the road ends (length + RUNOUT). */
  readonly sEnd: number;
  /** Internal samples. */
  readonly nAll: number;
  /** Internal index of the start line (s = 0). */
  readonly i0: number;
  readonly X: Float64Array;
  readonly Z: Float64Array;
  readonly Y: Float64Array;
  readonly M: Float64Array;
  readonly HTX: Float64Array;
  readonly HTZ: Float64Array;
  readonly HLX: Float64Array;
  readonly HLZ: Float64Array;
  readonly TB: Float64Array;
  readonly KAP: Float64Array;
  /** Float32 copies over the whole road (the renderer builds from these). */
  readonly all: { px: Float32Array; py: Float32Array; pz: Float32Array; tx: Float32Array; ty: Float32Array; tz: Float32Array; nx: Float32Array; ny: Float32Array; nz: Float32Array; lx: Float32Array; ly: Float32Array; lz: Float32Array; curvature: Float32Array; bank: Float32Array };
  readonly outside: (x: number, z: number) => number;
  /** The run-off's surface (RUNOFF_SURFACE unless changed). */
  runoff: SurfaceType = RUNOFF_SURFACE;

  // spatial grid of the samples (CSR)
  private gMinX = 0;
  private gMinZ = 0;
  private readonly gCell = 32;
  private gNx = 1;
  private gNz = 1;
  private gStart: Int32Array = new Int32Array(0);
  private gItems: Int32Array = new Int32Array(0);

  // scratch
  private _t = 0;
  private _d = 0;

  constructor(p: StageTrackParts) {
    const { plan, profile } = p;
    const n = plan.n;
    const h = plan.spacing;
    this.info = p.info;
    this.outside = p.outside;
    this.spacing = h;
    this.length = plan.length;
    this.count = Math.round(plan.length / h);
    this.sStart = plan.sStart;
    this.nAll = n;
    this.i0 = Math.round(-plan.sStart / h);
    this.sEnd = plan.sStart + (n - 1) * h;
    this.sectors = [plan.length / 3, (2 * plan.length) / 3];

    this.X = plan.x;
    this.Z = plan.z;
    this.Y = profile.y;
    this.M = profile.m;
    this.KAP = plan.kappa;
    this.HTX = new Float64Array(n);
    this.HTZ = new Float64Array(n);
    this.HLX = new Float64Array(n);
    this.HLZ = new Float64Array(n);
    this.TB = new Float64Array(n);
    const f = (): Float32Array => new Float32Array(n);
    const all = { px: f(), py: f(), pz: f(), tx: f(), ty: f(), tz: f(), nx: f(), ny: f(), nz: f(), lx: f(), ly: f(), lz: f(), curvature: f(), bank: f() };
    this.all = all;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const sp = Math.sin(plan.phi[i]);
      const cp = Math.cos(plan.phi[i]);
      this.HTX[i] = sp;
      this.HTZ[i] = cp;
      this.HLX[i] = cp;
      this.HLZ[i] = -sp;
      const bk = profile.bank[i];
      this.TB[i] = Math.tan(bk);
      const m = profile.m[i];
      const inv = 1 / Math.sqrt(1 + m * m);
      const ca = inv;
      const sa = m * inv;
      const cb = Math.cos(bk);
      const sb = Math.sin(bk);
      // t3 = (ca sp, sa, ca cp); hl = (cp, 0, -sp); n0 = t3 x hl = (-sa sp, ca, -sa cp); left = cb hl + sb n0; normal = cb n0 - sb hl
      all.px[i] = plan.x[i];
      all.py[i] = profile.y[i];
      all.pz[i] = plan.z[i];
      all.tx[i] = ca * sp;
      all.ty[i] = sa;
      all.tz[i] = ca * cp;
      all.lx[i] = cb * cp - sb * sa * sp;
      all.ly[i] = sb * ca;
      all.lz[i] = -cb * sp - sb * sa * cp;
      all.nx[i] = -cb * sa * sp - sb * cp;
      all.ny[i] = cb * ca;
      all.nz[i] = -cb * sa * cp + sb * sp;
      all.curvature[i] = plan.kappa[i];
      all.bank[i] = bk;
      for (const dd of [WALL, -WALL]) {
        const x = plan.x[i] + dd * cp;
        const z = plan.z[i] - dd * sp;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      if (profile.y[i] < minY) minY = profile.y[i];
      if (profile.y[i] > maxY) maxY = profile.y[i];
    }
    this.bounds = { minX, maxX, minZ, maxZ, minY: minY - 2, maxY: maxY + 2 };
    const a = this.i0;
    const b = a + this.count + 1;
    this.px = all.px.subarray(a, b);
    this.py = all.py.subarray(a, b);
    this.pz = all.pz.subarray(a, b);
    this.tx = all.tx.subarray(a, b);
    this.ty = all.ty.subarray(a, b);
    this.tz = all.tz.subarray(a, b);
    this.nx = all.nx.subarray(a, b);
    this.ny = all.ny.subarray(a, b);
    this.nz = all.nz.subarray(a, b);
    this.lx = all.lx.subarray(a, b);
    this.ly = all.ly.subarray(a, b);
    this.lz = all.lz.subarray(a, b);
    this.curvature = all.curvature.subarray(a, b);
    this.bank = all.bank.subarray(a, b);
    this.widthLeft = new Float32Array(this.count + 1).fill(ROAD_HALF);
    this.widthRight = new Float32Array(this.count + 1).fill(ROAD_HALF);
    this.wallLeft = new Float32Array(this.count + 1).fill(WALL);
    this.wallRight = new Float32Array(this.count + 1).fill(WALL);
    this.buildGrid();
    this.grid = this.buildStartGrid();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Nearest sample (a uniform grid over every sample)
  // ───────────────────────────────────────────────────────────────────────────

  private buildGrid(): void {
    const n = this.nAll;
    const cell = this.gCell;
    const minX = this.bounds.minX - 64;
    const minZ = this.bounds.minZ - 64;
    const nx = Math.ceil((this.bounds.maxX + 64 - minX) / cell) + 1;
    const nz = Math.ceil((this.bounds.maxZ + 64 - minZ) / cell) + 1;
    const counts = new Int32Array(nx * nz + 1);
    const cellOf = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const c = Math.floor((this.Z[i] - minZ) / cell) * nx + Math.floor((this.X[i] - minX) / cell);
      cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < nx * nz; c++) counts[c + 1] += counts[c];
    const fill = counts.slice(0, nx * nz);
    const items = new Int32Array(n);
    for (let i = 0; i < n; i++) items[fill[cellOf[i]]++] = i;
    this.gMinX = minX;
    this.gMinZ = minZ;
    this.gNx = nx;
    this.gNz = nz;
    this.gStart = counts;
    this.gItems = items;
  }

  /** Internal index of the sample nearest to (x, z) (global search). */
  nearestSample(x: number, z: number): number {
    const X = this.X;
    const Z = this.Z;
    const nx = this.gNx;
    const nz = this.gNz;
    const cell = this.gCell;
    const fx = (x - this.gMinX) / cell;
    const fz = (z - this.gMinZ) / cell;
    const cx = Math.min(nx - 1, Math.max(0, Math.floor(fx)));
    const cz = Math.min(nz - 1, Math.max(0, Math.floor(fz)));
    // (outside the grid the search starts at its nearest cell and widens until it has something)
    const extra = Math.max(0, Math.ceil(Math.max(-fx, fx - nx, -fz, fz - nz)));
    let best = -1;
    let bd = Infinity;
    const maxR = Math.max(nx, nz) + extra;
    const start = this.gStart;
    const items = this.gItems;
    for (let r = 0; r <= maxR; r++) {
      const z0 = cz - r;
      const z1 = cz + r;
      const x0 = cx - r;
      const x1 = cx + r;
      for (let gz = z0; gz <= z1; gz++) {
        if (gz < 0 || gz >= nz) continue;
        const edge = gz === z0 || gz === z1;
        const step = edge || r === 0 ? 1 : x1 - x0;
        for (let gx = x0; gx <= x1; gx += step) {
          if (gx < 0 || gx >= nx) continue;
          const c = gz * nx + gx;
          for (let k = start[c], ke = start[c + 1]; k < ke; k++) {
            const i = items[k];
            const dx = X[i] - x;
            const dz = Z[i] - z;
            const dd = dx * dx + dz * dz;
            if (dd < bd) {
              bd = dd;
              best = i;
            }
          }
        }
      }
      if (best >= 0) {
        const lim = (r - extra) * cell;
        if (lim > 0 && bd <= lim * lim) break;
      }
    }
    return best < 0 ? 0 : best;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Projection (the bilinear patch, inverted)
  // ───────────────────────────────────────────────────────────────────────────

  /** Solves patch i for the point: this._t (unclamped) and this._d. */
  private solve(i: number, x: number, z: number): void {
    const X = this.X;
    const Z = this.Z;
    const HLX = this.HLX;
    const HLZ = this.HLZ;
    const j = i + 1;
    const ax = X[j] - X[i];
    const az = Z[j] - Z[i];
    const bx = HLX[i];
    const bz = HLZ[i];
    const cx = HLX[j] - bx;
    const cz = HLZ[j] - bz;
    const qx = x - X[i];
    const qz = z - Z[i];
    // cross(q - t a, b + t c) = 0: A t^2 + B t + C = 0
    const A = ax * cz - az * cx;
    const B = ax * bz - az * bx - (qx * cz - qz * cx);
    const C = -(qx * bz - qz * bx);
    let t: number;
    if (B > -1e-12 && B < 1e-12) t = 0;
    else {
      const t0 = -C / B;
      if (A > -1e-12 && A < 1e-12) t = t0;
      else {
        const disc = B * B - 4 * A * C;
        if (disc < 0) t = t0;
        else {
          const sq = Math.sqrt(disc);
          const qq = -0.5 * (B + (B >= 0 ? sq : -sq));
          const r1 = qq / A;
          const r2 = qq !== 0 ? C / qq : t0;
          t = Math.abs(r1 - t0) < Math.abs(r2 - t0) ? r1 : r2;
        }
      }
    }
    if (t !== t) t = 0;
    const lx = bx + t * cx;
    const lz = bz + t * cz;
    this._t = t;
    this._d = ((qx - t * ax) * lx + (qz - t * az) * lz) / (lx * lx + lz * lz);
  }

  /** Walks from patch i to the patch holding (x, z); t may fall outside [0, 1] only beyond the two ends. */
  private walk(i: number, x: number, z: number): number {
    const last = this.nAll - 2;
    for (let steps = 0; steps < 200; steps++) {
      this.solve(i, x, z);
      const t = this._t;
      if (t > 1 && i < last) i++;
      else if (t < 0 && i > 0) i--;
      else return i;
    }
    return -1;
  }

  /** The patch holding (x, z), starting from `hint`; sets this._t and this._d. */
  private locate(x: number, z: number, hint: number): number {
    const last = this.nAll - 2;
    const hinted = hint >= 0 && hint <= last;
    let i = this.walk(hinted ? hint | 0 : Math.min(last, this.nearestSample(x, z)), x, z);
    if (i < 0) i = this.walk(Math.min(last, this.nearestSample(x, z)), x, z);
    if (i < 0) {
      i = Math.min(last, this.nearestSample(x, z));
      this.solve(i, x, z);
      this._t = clamp(this._t, 0, 1);
    }
    // A stale hint can latch onto another leg of the road (a patch reaches any lateral offset): check globally whenever the result
    // lies beyond the barriers of the patch it found.
    const ad = this._d < 0 ? -this._d : this._d;
    if (ad > WALL + 3 && hinted) {
      const g = Math.min(last, this.nearestSample(x, z));
      if (Math.abs(g - i) > 2) {
        const d0 = this._d;
        const t0 = this._t;
        const k = this.walk(g, x, z);
        if (k >= 0 && Math.abs(this._d) < ad) return k;
        this._d = d0;
        this._t = t0;
      }
    }
    return i;
  }

  project(x: number, z: number, out: TrackPoint, hint = -1): number {
    const i = this.locate(x, z, hint);
    const t = this._t;
    const j = i + 1;
    const tc = t < 0 ? 0 : t > 1 ? 1 : t;
    const om = 1 - tc;
    const h = this.spacing;
    out.s = this.sStart + (i + t) * h;
    out.d = this._d;
    out.segment = clamp(Math.round(i + tc) - this.i0, 0, this.count);
    out.widthLeft = ROAD_HALF;
    out.widthRight = ROAD_HALF;
    out.wallLeft = WALL;
    out.wallRight = WALL;
    out.softLeft = 0;
    out.softRight = 0;
    let tx = this.HTX[i] * om + this.HTX[j] * tc;
    let tz = this.HTZ[i] * om + this.HTZ[j] * tc;
    const inv = 1 / Math.sqrt(tx * tx + tz * tz);
    tx *= inv;
    tz *= inv;
    out.tx = tx;
    out.tz = tz;
    out.lx = tz;
    out.lz = -tx;
    out.y = this.centreHeight(i, t);
    return i;
  }

  /** Centreline height on patch i at t (extrapolated past the ends: on the end slope, and rising steeply beyond the very end). */
  private centreHeight(i: number, t: number): number {
    const h = this.spacing;
    if (t >= 0 && t <= 1) return hermite(this.Y[i], this.M[i], this.Y[i + 1], this.M[i + 1], h, t);
    if (t < 0) {
      const u = -t * h;
      return this.Y[i] - this.M[i] * u + 0.15 * u * u;
    }
    const u = (t - 1) * h;
    return this.Y[i + 1] + this.M[i + 1] * u + 0.15 * u * u;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Ground
  // ───────────────────────────────────────────────────────────────────────────

  groundAt(x: number, z: number, out: GroundSample, hint = -1): number {
    const i = this.locate(x, z, hint);
    const t = this._t;
    const d = this._d;
    const ad = d < 0 ? -d : d;
    if (ad > FORMATION) {
      // beyond the formation: the carved terrain (never reached through the barriers; a normal by finite differences)
      const e = 0.5;
      const h0 = this.outside(x, z);
      const hx = this.outside(x + e, z);
      const hz = this.outside(x, z + e);
      out.height = h0;
      out.normal.set(-(hx - h0) / e, 1, -(hz - h0) / e).normalize();
      out.surface = 'grass';
      return i;
    }
    const j = i + 1;
    const h = this.spacing;
    const tc = t < 0 ? 0 : t > 1 ? 1 : t;
    let yc: number;
    let mc: number;
    if (t >= 0 && t <= 1) {
      yc = hermite(this.Y[i], this.M[i], this.Y[j], this.M[j], h, t);
      mc = hermiteSlope(this.Y[i], this.M[i], this.Y[j], this.M[j], h, t);
    } else if (t < 0) {
      const u = -t * h;
      yc = this.Y[i] - this.M[i] * u + 0.15 * u * u;
      mc = this.M[i] - 0.3 * u;
    } else {
      const u = (t - 1) * h;
      yc = this.Y[j] + this.M[j] * u + 0.15 * u * u;
      mc = this.M[j] + 0.3 * u;
    }
    const tb = this.TB[i] + (this.TB[j] - this.TB[i]) * tc;
    const dtb = (this.TB[j] - this.TB[i]) / h;
    out.height = yc + d * tb;
    // the gradient: dh/ds = mc + d dtb along s, dh/dd = tb across, through the patch's Jacobian
    const hs = (mc + d * dtb) * h; // per unit t
    const ax = this.X[j] - this.X[i] + d * (this.HLX[j] - this.HLX[i]);
    const az = this.Z[j] - this.Z[i] + d * (this.HLZ[j] - this.HLZ[i]);
    const bx = this.HLX[i] + tc * (this.HLX[j] - this.HLX[i]);
    const bz = this.HLZ[i] + tc * (this.HLZ[j] - this.HLZ[i]);
    const det = ax * bz - az * bx;
    const gx = (hs * bz - tb * az) / det;
    const gz = (ax * tb - bx * hs) / det;
    const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
    out.normal.set(-gx * inv, inv, -gz * inv);
    const s = this.sStart + (i + t) * h;
    if (s < -GRID_TRAP || s > this.sEnd - END_TRAP) out.surface = 'sand';
    else out.surface = ad <= ROAD_HALF ? 'asphalt' : ad <= SHOULDER ? 'concrete' : this.runoff;
    return i;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Frames
  // ───────────────────────────────────────────────────────────────────────────

  /** Internal patch and t for s (clamped to the road). */
  private at(s: number): number {
    const u = (clamp(s, this.sStart, this.sEnd) - this.sStart) / this.spacing;
    let i = Math.floor(u);
    if (i > this.nAll - 2) i = this.nAll - 2;
    this._t = u - i;
    return i;
  }

  pointAt(s: number, d: number, out: Vector3): Vector3 {
    const i = this.at(s);
    const t = this._t;
    const j = i + 1;
    const lx = this.HLX[i] + t * (this.HLX[j] - this.HLX[i]);
    const lz = this.HLZ[i] + t * (this.HLZ[j] - this.HLZ[i]);
    const x = this.X[i] + t * (this.X[j] - this.X[i]) + d * lx;
    const z = this.Z[i] + t * (this.Z[j] - this.Z[i]) + d * lz;
    const tb = this.TB[i] + (this.TB[j] - this.TB[i]) * t;
    return out.set(x, hermite(this.Y[i], this.M[i], this.Y[j], this.M[j], this.spacing, t) + d * tb, z);
  }

  frameAt(s: number, out: TrackFrame): TrackFrame {
    const i = this.at(s);
    const t = this._t;
    const j = i + 1;
    const A = this.all;
    this.pointAt(s, 0, out.position);
    out.tangent.set(A.tx[i] + t * (A.tx[j] - A.tx[i]), A.ty[i] + t * (A.ty[j] - A.ty[i]), A.tz[i] + t * (A.tz[j] - A.tz[i])).normalize();
    out.normal.set(A.nx[i] + t * (A.nx[j] - A.nx[i]), A.ny[i] + t * (A.ny[j] - A.ny[i]), A.nz[i] + t * (A.nz[j] - A.nz[i]));
    // (keep the frame orthonormal)
    out.normal.addScaledVector(out.tangent, -out.normal.dot(out.tangent)).normalize();
    out.left.crossVectors(out.normal, out.tangent).normalize();
    out.widthLeft = ROAD_HALF;
    out.widthRight = ROAD_HALF;
    out.wallLeft = WALL;
    out.wallRight = WALL;
    out.curvature = this.KAP[i] + t * (this.KAP[j] - this.KAP[i]);
    out.bank = A.bank[i] + t * (A.bank[j] - A.bank[i]);
    return out;
  }

  wrapS(s: number): number {
    return s < 0 ? 0 : s > this.length ? this.length : s;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The grid: slot 0 on the centreline just behind the start line, the rest two-wide behind it
  // ───────────────────────────────────────────────────────────────────────────

  private buildStartGrid(): GridSlot[] {
    const slots: GridSlot[] = [];
    const frame: TrackFrame = {
      position: new Vector3(), tangent: new Vector3(), normal: new Vector3(), left: new Vector3(),
      widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0,
    };
    for (let k = 0; k < 12; k++) {
      const row = Math.ceil(k / 2);
      const s = -4.5 - row * 7.5;
      const d = k === 0 ? 0 : k % 2 === 1 ? 2.8 : -2.8;
      this.frameAt(s, frame);
      const position = this.pointAt(s, d, new Vector3());
      _a.copy(frame.left);
      _b.copy(frame.normal);
      _m.makeBasis(_a, _b, frame.tangent);
      slots.push({ position, quaternion: new Quaternion().setFromRotationMatrix(_m), s, d });
    }
    return slots;
  }
}
