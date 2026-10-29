/**
 * The road carved into the terrain: a precomputed field around the stage's road that turns the base terrain height T(x, z) into the
 * carved one, the SAME way on the CPU (heightAt / groundAt in src/world/terrain.ts: the chase camera's ground, the physics beyond the
 * formation) and on the GPU (the terrain vertex shader, STAGE_GLSL in src/render/terrainGlsl.ts: the picture).
 *
 * The shape: the road's formation (out to SC.edge = FORMATION m each side of the centreline: asphalt, run-off, the barriers and a verge)
 * is flat at the road's level, a little below it (the road's own mesh lies on top); beyond it the land is held between a fill slope
 * going down (SC.fill: the embankment of a road on a bank) and a cut slope going up (SC.cut: the cutting of a road through a rise),
 * which open out from the formation's edge with a rounded foot. Where the land lies between the two it is untouched, so the slopes
 * end where they meet the land (smooth minimum and maximum: no creases); and the whole carve fades out between SC.fade0 and
 * SC.fade1 m beyond the formation.
 *
 * Representation. A world-aligned grid of SC.cell m (4 m) texels, kept only near the road: TILE x TILE-cell tiles (128 m) wherever the
 * road passes within reach, stored in an atlas (each tile (TILE + 1)^2 texels, sharing its border with its neighbours, so a
 * bilinear lookup never leaves its tile) with a page table that says where each tile is (-1: none, the carve is the identity there).
 * Two float32 channels per texel:
 *   .x u  the distance (m) to the road's centreline (exact: the nearest point of the 2 m polyline)
 *   .y F  the road level there: the height of the formation's plane (the road's height and bank) at the nearest centreline point,
 *         with the lateral offset clamped to the formation
 * Both are smooth enough for bilinear interpolation over 4 m (u has a crease on the centreline, inside the formation, where it does
 * not matter); the formation's edge and the slopes are evaluated exactly from them (carveHeight). The CPU and the GPU read the same
 * float32 numbers in the same bilinear order (texelFetch in the shader), so they agree to about a millimetre.
 *
 * Levels of detail. The terrain's clipmap draws coarser cells further out; a cell c m wide that straddles the formation's edge would
 * poke its far corner through the road. So the shader widens the formation by `pad` and sinks it by `depth`, both growing with the
 * level's cell size (carveHeight's `q`: 0 for the finest level at the camera, which is what the CPU uses).
 */
import { FORMATION } from './stage-track';
import type { StageTrack } from './stage-track';
import { hermite } from './stage-math';

/** The field's tunables; the shader pastes them in from here. */
export const SC = {
  /** Texel spacing (m): a power of two. */
  cell: 4,
  /** Cells per tile side. */
  tile: 32,
  /** The formation's half-width (m): flat at the road's level out to here. */
  edge: FORMATION,
  /** The rounded foot of the slopes (m). */
  foot: 3,
  /** Fill (embankment) slope, and cut slope (rise per metre). */
  fill: 0.6,
  cut: 0.9,
  /** Width of the smooth minimum and maximum (m): k0 + k1 * (metres up the slope). */
  k0: 1,
  k1: 0.3,
  /** The carve fades out between these distances beyond the formation's edge (m). */
  fade0: 75,
  fade1: 135,
  /** The formation lies this far below the road (m): depth0 + depthK * q^2, at most depthMax. */
  depth0: 0.15,
  depthK: 0.004,
  depthMax: 3,
  /** The formation's widening for a coarse clipmap level: min(q, padMax) (m). */
  padMax: 24,
  /** Finite-difference step for the shading gradient on the GPU (m). */
  gradStep: 0.1,
} as const;

/** How far from the centreline the field must reach (m): everything the carve can touch, plus a texel. */
export const FIELD_REACH = SC.edge + SC.padMax + SC.fade1 + 2 * SC.cell;

export interface StageField {
  /** Texel spacing (m); texel (i, j) of the grid is at (x0 + i * cell, z0 + j * cell). */
  readonly cell: number;
  readonly x0: number;
  readonly z0: number;
  /** Tiles across and down the page table; cells per tile side. */
  readonly ntx: number;
  readonly ntz: number;
  readonly tile: number;
  /** ntx * ntz * 2 floats: the atlas texel of each tile's corner, or (-1, -1). Upload as an RG32F texture. */
  readonly page: Float32Array;
  /** aw * ah * 2 floats: u, F per texel (see the header). Upload as an RG32F texture. */
  readonly atlas: Float32Array;
  readonly aw: number;
  readonly ah: number;
  /** Tiles in use. */
  readonly tiles: number;
  /** World extent of the page table. */
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  /** How long the build took (ms). */
  readonly buildMs: number;
  /** The carved height at (x, z), given the base terrain height h there. */
  apply(h: number, x: number, z: number): number;
  /** The field's (u, F) at (x, z) into out[0..1]; false where it has no tile. */
  sample(x: number, z: number, out: Float64Array): boolean;
}

/** Polynomial smooth minimum (C1): min(a, b) rounded over |a - b| < k. */
function smin(a: number, b: number, k: number): number {
  let hh = 0.5 + (0.5 * (b - a)) / k;
  hh = hh < 0 ? 0 : hh > 1 ? 1 : hh;
  return b + (a - b) * hh - k * hh * (1 - hh);
}

/**
 * The carve, given the base height T, the field (u, F) and the level parameter q (0 on the CPU; see the header).
 * The GLSL twin is stageCarve() in src/render/terrainGlsl.ts: keep them in step.
 */
export function carveHeight(T: number, u: number, F: number, q: number): number {
  const pad = q < SC.padMax ? q : SC.padMax;
  const dq = SC.depth0 + SC.depthK * q * q;
  const depth = dq < SC.depthMax ? dq : SC.depthMax;
  const t = u - (SC.edge + pad);
  if (t >= SC.fade1) return T;
  const a = SC.foot;
  const ramp = t <= 0 ? 0 : t < a ? (t * t) / (2 * a) : t - 0.5 * a;
  const base = F - depth;
  const lo = base - SC.fill * ramp;
  const hi = base + SC.cut * ramp;
  const k = SC.k0 + SC.k1 * ramp;
  // smax(T, lo) = -smin(-T, -lo), then smin with hi
  const c = smin(-smin(-T, -lo, k), hi, k);
  let w = (t - SC.fade0) / (SC.fade1 - SC.fade0);
  w = w < 0 ? 0 : w > 1 ? 1 : w;
  w = 1 - w * w * (3 - 2 * w);
  return T + w * (c - T);
}

/** Builds the field for a stage's road (about 100-200 ms). */
export function buildStageField(track: StageTrack): StageField {
  const t0 = performance.now();
  const g = SC.cell;
  const TILE = SC.tile;
  const TS = TILE * g;
  const X = track.X;
  const Z = track.Z;
  const n = track.nAll;
  const reach = FIELD_REACH;

  // the page table's extent
  const b = track.bounds;
  const x0 = Math.floor((b.minX - reach - TS) / TS) * TS;
  const z0 = Math.floor((b.minZ - reach - TS) / TS) * TS;
  const ntx = Math.ceil((b.maxX + reach + TS - x0) / TS);
  const ntz = Math.ceil((b.maxZ + reach + TS - z0) / TS);

  // the tiles the road passes within reach of
  const used = new Uint8Array(ntx * ntz);
  const rr = reach + TS * 0.75; // (the tile's half diagonal)
  for (let i = 0; i < n; i += 4) {
    const cx = (X[i] - x0) / TS - 0.5;
    const cz = (Z[i] - z0) / TS - 0.5;
    const r = Math.ceil(rr / TS);
    for (let tj = Math.max(0, Math.floor(cz) - r); tj <= Math.min(ntz - 1, Math.ceil(cz) + r); tj++) {
      for (let ti = Math.max(0, Math.floor(cx) - r); ti <= Math.min(ntx - 1, Math.ceil(cx) + r); ti++) {
        const dx = (ti - cx) * TS;
        const dz = (tj - cz) * TS;
        if (dx * dx + dz * dz <= rr * rr) used[tj * ntx + ti] = 1;
      }
    }
  }
  let tiles = 0;
  for (let k = 0; k < used.length; k++) tiles += used[k];
  const T1 = TILE + 1;
  const perRow = Math.max(1, Math.min(tiles, Math.floor(4096 / T1)));
  const aw = perRow * T1;
  const ah = Math.ceil(tiles / perRow) * T1;
  const page = new Float32Array(ntx * ntz * 2).fill(-1);
  const atlas = new Float32Array(aw * ah * 2);

  // coarse segments (every CO samples) for the nearest-point search
  const CO = 5;
  const nCo = Math.floor((n - 1) / CO);
  const Y = track.Y;
  const M = track.M;
  const TB = track.TB;
  const h = track.spacing;
  const E = SC.edge;
  const cand: number[] = [];
  const midX = new Float64Array(nCo + 1);
  const midZ = new Float64Array(nCo + 1);
  const halfL = new Float64Array(nCo + 1);
  let k = 0;
  for (let tj = 0; tj < ntz; tj++) {
    for (let ti = 0; ti < ntx; ti++) {
      if (!used[tj * ntx + ti]) continue;
      const ax = (k % perRow) * T1;
      const az = Math.floor(k / perRow) * T1;
      k++;
      page[(tj * ntx + ti) * 2] = ax;
      page[(tj * ntx + ti) * 2 + 1] = az;
      // coarse segments that can be nearest to some texel of this tile
      const tx0 = x0 + ti * TS;
      const tz0 = z0 + tj * TS;
      const cxm = tx0 + TS / 2;
      const czm = tz0 + TS / 2;
      cand.length = 0;
      // (the nearest point of the road to any texel here is within reach + the tile's half diagonal of the tile's centre, unless
      // the texel is further than reach from the road, where u only needs to be at least reach)
      const lim = reach + TS * 0.75 + CO * h;
      for (let c = 0; c < nCo; c++) {
        const i = c * CO;
        const dx = X[i] - cxm;
        const dz = Z[i] - czm;
        if (dx * dx + dz * dz <= lim * lim) cand.push(c);
      }
      // each candidate's middle and half-length: a texel further than best + half-length from the middle cannot be nearer
      const nc = cand.length;
      for (let q = 0; q < nc; q++) {
        const i = cand[q] * CO;
        midX[q] = 0.5 * (X[i] + X[i + CO]);
        midZ[q] = 0.5 * (Z[i] + Z[i + CO]);
        halfL[q] = 0.5 * Math.hypot(X[i + CO] - X[i], Z[i + CO] - Z[i]) + 0.01;
      }
      let warm = 0;
      for (let jj = 0; jj <= TILE; jj++) {
        const pz = tz0 + jj * g;
        for (let ii = 0; ii <= TILE; ii++) {
          const px = tx0 + ii * g;
          let u: number;
          let F: number;
          if (cand.length === 0) {
            u = 4 * reach;
            F = 0;
          } else {
            // nearest coarse segment (starting from the last texel's, pruned by the middles), then the fine segments around it
            let bc = cand[warm];
            let bd = Infinity;
            let br = Infinity;
            for (let qq = 0; qq < nc; qq++) {
              const q = qq === 0 ? warm : qq === warm ? 0 : qq;
              const mx = px - midX[q];
              const mz = pz - midZ[q];
              const lim2 = br + halfL[q];
              if (mx * mx + mz * mz > lim2 * lim2) continue;
              const c = cand[q];
              const i = c * CO;
              const j = i + CO;
              const ex = X[j] - X[i];
              const ez = Z[j] - Z[i];
              const wx = px - X[i];
              const wz = pz - Z[i];
              let tt = (wx * ex + wz * ez) / (ex * ex + ez * ez);
              tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
              const dx = wx - tt * ex;
              const dz = wz - tt * ez;
              const dd = dx * dx + dz * dz;
              if (dd < bd) {
                bd = dd;
                br = Math.sqrt(dd);
                bc = c;
                warm = q;
              }
            }
            // (beyond the reach the carve is the identity whatever the texel says: the coarse distance will do)
            if (br > reach + CO * h) {
              const o = ((az + jj) * aw + ax + ii) * 2;
              atlas[o] = br;
              atlas[o + 1] = Y[bc * CO];
              continue;
            }
            let best = Infinity;
            let bi = 0;
            let bt = 0;
            const f0 = Math.max(0, bc * CO - CO);
            const f1 = Math.min(n - 2, bc * CO + 2 * CO);
            for (let i = f0; i <= f1; i++) {
              const ex = X[i + 1] - X[i];
              const ez = Z[i + 1] - Z[i];
              const wx = px - X[i];
              const wz = pz - Z[i];
              let tt = (wx * ex + wz * ez) / (ex * ex + ez * ez);
              tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
              const dx = wx - tt * ex;
              const dz = wz - tt * ez;
              const dd = dx * dx + dz * dz;
              if (dd < best) {
                best = dd;
                bi = i;
                bt = tt;
              }
            }
            u = Math.sqrt(best);
            const ex = X[bi + 1] - X[bi];
            const ez = Z[bi + 1] - Z[bi];
            const el = Math.sqrt(ex * ex + ez * ez);
            // signed lateral offset (+ = left: the left of (ex, ez) is (ez, -ex))
            const d = ((px - X[bi] - bt * ex) * ez - (pz - Z[bi] - bt * ez) * ex) / el;
            const dc = d < -E ? -E : d > E ? E : d;
            const yc = hermite(Y[bi], M[bi], Y[bi + 1], M[bi + 1], h, bt);
            F = yc + dc * (TB[bi] + (TB[bi + 1] - TB[bi]) * bt);
          }
          const o = ((az + jj) * aw + ax + ii) * 2;
          atlas[o] = u;
          atlas[o + 1] = F;
        }
      }
    }
  }

  const inv = 1 / g;
  const maxX = x0 + ntx * TS;
  const maxZ = z0 + ntz * TS;
  const sample = (x: number, z: number, out: Float64Array): boolean => {
    const gx = (x - x0) * inv;
    const gz = (z - z0) * inv;
    if (!(gx >= 0 && gz >= 0 && gx < ntx * TILE && gz < ntz * TILE)) return false;
    const ci = Math.floor(gx);
    const cj = Math.floor(gz);
    const fu = gx - ci;
    const fv = gz - cj;
    const ti = (ci / TILE) | 0;
    const tj = (cj / TILE) | 0;
    const po = (tj * ntx + ti) * 2;
    const pax = page[po];
    if (pax < 0) return false;
    const o = ((page[po + 1] + cj - tj * TILE) * aw + pax + ci - ti * TILE) * 2;
    const o1 = o + aw * 2;
    // bilinear, in the same order as the shader: mix(mix(t00, t10, fu), mix(t01, t11, fu), fv)
    const a0 = atlas[o] + (atlas[o + 2] - atlas[o]) * fu;
    const b0 = atlas[o1] + (atlas[o1 + 2] - atlas[o1]) * fu;
    out[0] = a0 + (b0 - a0) * fv;
    const a1 = atlas[o + 1] + (atlas[o + 3] - atlas[o + 1]) * fu;
    const b1 = atlas[o1 + 1] + (atlas[o1 + 3] - atlas[o1 + 1]) * fu;
    out[1] = a1 + (b1 - a1) * fv;
    return true;
  };
  const tmp = new Float64Array(2);
  const skip = SC.edge + SC.fade1;
  const apply = (hh: number, x: number, z: number): number => {
    if (!sample(x, z, tmp)) return hh;
    if (tmp[0] >= skip) return hh;
    return carveHeight(hh, tmp[0], tmp[1], 0);
  };

  return { cell: g, x0, z0, ntx, ntz, tile: TILE, page, atlas, aw, ah, tiles, minX: x0, minZ: z0, maxX, maxZ, buildMs: performance.now() - t0, apply, sample };
}
