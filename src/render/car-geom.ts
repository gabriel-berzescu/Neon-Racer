/**
 * The toolkit the neon cars are built with (src/render/car-bodies.ts): profile curves, lofted body sections, plates, wing
 * elements, tubes and glowing strips, all written into ONE merged mesh per car, and the neon edge lines traced over them into ONE
 * fat-line geometry per car.
 *
 * Every vertex carries a colour (`aCol`, linear, may be over 1 for glowing parts) and a glow channel (`aGlow`): 0 a lit dark surface,
 * 1 a constant glow, 2 the tail/brake lights, 3 the wheel spokes, 4 the spokes' blur disc. The car's material (car-material.ts)
 * scales the channels by uniforms, so nothing is ever rewritten in a buffer after the build.
 *
 * Body frame: +z forward, +y up, +x LEFT, the origin on the ground between the axles and the wheels (the CarVisualSpec frame).
 */
import * as THREE from 'three';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

export type V3 = readonly [number, number, number];
export type RGB = readonly [number, number, number];

export const GLOW = { surface: 0, steady: 1, brake: 2, spokes: 3, blur: 4 } as const;

/**
 * A neon colour by how bright the bloom pass sees it: a palette hex as linear RGB, scaled so its luminance (the bloom's high-pass
 * weights) is `lum`. Cyan is two and a half times as luminous as magenta at the same RGB scale, so the three cars' neons are set by
 * this, not by a multiplier, or the LMP-X would drown in its own glow while the Volta looked dim. The bloom threshold is 0.75.
 */
export function neon(hex: number, lum: number): RGB {
  const c = new THREE.Color(hex);
  const l = Math.max(1e-3, 0.299 * c.r + 0.587 * c.g + 0.114 * c.b);
  const k = lum / l;
  return [c.r * k, c.g * k, c.b * k];
}

/** A palette hex as linear RGB, times `k` (k > 1: a glowing colour). */
export function rgb(hex: number, k = 1): RGB {
  const c = new THREE.Color(hex);
  return [c.r * k, c.g * k, c.b * k];
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile curves
// ─────────────────────────────────────────────────────────────────────────────

export type Curve = (z: number) => number;

/**
 * A smooth curve through flat [z, v, z, v, ...] control points: a monotone cubic (PCHIP, no overshoot between the points),
 * clamped at the ends. The same curves as Xeno-Racer's body profiles, without their extra smoothing.
 */
export function curve(flat: readonly number[]): Curve {
  const p: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) p.push([flat[i], flat[i + 1]]);
  p.sort((a, b) => a[0] - b[0]);
  const m = p.length;
  if (m === 1) {
    const v = p[0][1];
    return () => v;
  }
  const h: number[] = [];
  const del: number[] = [];
  for (let i = 0; i < m - 1; i++) {
    h.push(p[i + 1][0] - p[i][0]);
    del.push(h[i] > 0 ? (p[i + 1][1] - p[i][1]) / h[i] : 0);
  }
  const d = new Array<number>(m).fill(0);
  d[0] = del[0];
  d[m - 1] = del[m - 2];
  for (let i = 1; i < m - 1; i++) {
    if (del[i - 1] * del[i] > 0) {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      d[i] = (w1 + w2) / (w1 / del[i - 1] + w2 / del[i]);
    }
  }
  return (z: number) => {
    if (z <= p[0][0]) return p[0][1];
    if (z >= p[m - 1][0]) return p[m - 1][1];
    let s = 0;
    while (s < m - 2 && z > p[s + 1][0]) s++;
    const hh = h[s];
    const t = hh > 0 ? (z - p[s][0]) / hh : 0;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p[s][1] + (t3 - 2 * t2 + t) * hh * d[s] + (-2 * t3 + 3 * t2) * p[s + 1][1] + (t3 - t2) * hh * d[s + 1];
  };
}

export const flat = (v: number): Curve => () => v;

/** Corners of a polygon (flat [a, b, a, b, ...]) rounded off with a short arc each (radius per corner, or one for all). */
export function roundPoly(poly: readonly number[], r: number | readonly number[], k = 3): number[] {
  const n = poly.length / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const ri = typeof r === 'number' ? r : r[i] ?? 0;
    const px = poly[i * 2], py = poly[i * 2 + 1];
    const ax = poly[((i + n - 1) % n) * 2], ay = poly[((i + n - 1) % n) * 2 + 1];
    const cx = poly[((i + 1) % n) * 2], cy = poly[((i + 1) % n) * 2 + 1];
    const la = Math.hypot(ax - px, ay - py), lc = Math.hypot(cx - px, cy - py);
    const rr = Math.min(ri, la * 0.45, lc * 0.45);
    if (rr <= 1e-4) {
      out.push(px, py);
      continue;
    }
    const s0x = px + ((ax - px) / la) * rr, s0y = py + ((ay - py) / la) * rr;
    const s1x = px + ((cx - px) / lc) * rr, s1y = py + ((cy - py) / lc) * rr;
    for (let j = 0; j <= k; j++) {
      const t = j / k, u = 1 - t;
      out.push(u * u * s0x + 2 * u * t * px + t * t * s1x, u * u * s0y + 2 * u * t * py + t * t * s1y);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

/** A lofted body section, as Xeno-Racer's (carvis/loft.ts): a rounded section swept along z through profile curves. */
export interface LoftDef {
  zr: number;
  zf: number;
  /** bottom and top heights, half-width, along z */
  yb: Curve;
  yt: Curve;
  w: Curve;
  /** centre line x (0: one loft on the centre line; otherwise a pair at +x and -x) */
  x?: number;
  /** how much lower the top is at the outer edge (m) */
  crown?: number;
  /** tumblehome: the wall leans in by this much (m) at the top, from `tumY` up */
  tum?: number;
  tumY?: number;
  /** superellipse exponents of the top and bottom halves (2: an ellipse, higher: squarer) */
  nTop?: number;
  nBot?: number;
  /** lengths over which the front and the rear end round off */
  rF?: number;
  rR?: number;
  /** raked end planes, as Xeno-Racer's: z <= zf - kf (y - yRef) and z >= zr + kr (y - yRef) */
  kf?: number;
  kr?: number;
  yRef?: number;
  /** station spacing (m) */
  step?: number;
  color?: RGB;
}

/** A built loft: its rings of vertex indices (one ring per station, `n` around, angle 0 = outboard, 90 = top) per side. */
export interface Loft {
  sides: { rings: number[][]; zs: number[] }[];
  n: number;
}

/** A wing element's section: where its quarter chord is (body frame), its chord and its incidence (negative: trailing edge up). */
export interface Section {
  x: number;
  y: number;
  z: number;
  chord: number;
  inc: number;
}

/** Leading and trailing edge of a section, [z, y] each. */
export function edges(sc: Section): { le: [number, number]; te: [number, number] } {
  const c = Math.cos(sc.inc), s = Math.sin(sc.inc);
  const a = 0.25 * sc.chord, t = 0.75 * sc.chord;
  return { le: [sc.z + a * c, sc.y + a * s], te: [sc.z - t * c, sc.y - t * s] };
}

const RING = 24;

/** One merged mesh: positions, colours and glow channels, indexed; normals made at the end. */
export class MeshBuilder {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly glow: number[] = [];
  readonly idx: number[] = [];
  private c: RGB = [0.02, 0.02, 0.04];
  private g = 0;
  private normals: Float32Array | null = null;

  constructor(readonly surface: RGB) {
    this.c = surface;
  }

  /** Paint what follows as a lit surface of colour `c` (default: the body's). */
  paint(c: RGB = this.surface): this {
    this.c = c;
    this.g = GLOW.surface;
    return this;
  }

  /** Paint what follows as a glow of colour `c` on channel `ch`. */
  lamp(c: RGB, ch: number = GLOW.steady): this {
    this.c = c;
    this.g = ch;
    return this;
  }

  vert(x: number, y: number, z: number): number {
    this.pos.push(x, y, z);
    this.col.push(this.c[0], this.c[1], this.c[2]);
    this.glow.push(this.g);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Repaint vertices [from, to) that pass `pred` as a lit surface of colour `c`. */
  recolor(from: number, to: number, pred: (x: number, y: number, z: number) => boolean, c: RGB): void {
    for (let i = from; i < to; i++) {
      if (!pred(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2])) continue;
      this.col[i * 3] = c[0];
      this.col[i * 3 + 1] = c[1];
      this.col[i * 3 + 2] = c[2];
      this.glow[i] = GLOW.surface;
    }
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** Position (and, after build(), normal) of vertex i. */
  p(i: number): THREE.Vector3 {
    return new THREE.Vector3(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
  }

  n(i: number): THREE.Vector3 {
    if (!this.normals) return new THREE.Vector3();
    return new THREE.Vector3(this.normals[i * 3], this.normals[i * 3 + 1], this.normals[i * 3 + 2]);
  }

  /** A polygon fan/triangulation of vertices `ring` (in order), oriented so its normal points along `toward`. */
  private cap(ring: number[], toward: THREE.Vector3): void {
    const pts = ring.map((i) => this.p(i));
    // project onto the plane square to `toward`
    const t = toward.clone().normalize();
    const u = new THREE.Vector3().crossVectors(t, Math.abs(t.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(t, u);
    const contour = pts.map((q) => new THREE.Vector2(q.dot(u), q.dot(v)));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const [a, b, c] of tris) this.orientedTri(ring[a], ring[b], ring[c], t);
  }

  /** A triangle wound so that its normal points along `n`. */
  orientedTri(a: number, b: number, c: number, n: THREE.Vector3): void {
    const pa = this.p(a), pb = this.p(b), pc = this.p(c);
    const f = new THREE.Vector3().crossVectors(pb.sub(pa), pc.sub(pa));
    if (f.dot(n) >= 0) this.tri(a, b, c);
    else this.tri(a, c, b);
  }

  /** A lofted section (both sides when off the centre line). */
  loft(L: LoftDef): Loft {
    if (L.color) this.paint(L.color);
    const step = L.step ?? 0.045;
    const rF = L.rF ?? 0.1, rR = L.rR ?? 0.1;
    // stations: even spacing, refined towards both ends where the section rounds off
    const zs = new Set<number>();
    const len = L.zf - L.zr;
    const nUni = Math.max(2, Math.ceil(len / step));
    for (let i = 0; i <= nUni; i++) zs.add(+(L.zr + (len * i) / nUni).toFixed(5));
    for (const f of [0.03, 0.12, 0.28, 0.5, 0.75]) {
      if (rF * f < len / 2) zs.add(+(L.zf - rF * f).toFixed(5));
      if (rR * f < len / 2) zs.add(+(L.zr + rR * f).toFixed(5));
    }
    const zl = [...zs].sort((a, b) => a - b);
    const xc = L.x ?? 0;
    const nTop = L.nTop ?? 3.2, nBot = L.nBot ?? 4;
    const crown = L.crown ?? 0, tum = L.tum ?? 0;
    const sides = xc === 0 ? [1] : [1, -1];
    const out: Loft = { sides: [], n: RING };
    const endF = (d: number, r: number) => (r <= 0 || d >= r ? 1 : Math.sqrt(Math.max(0, 1 - (1 - d / r) ** 2)));
    for (const side of sides) {
      const rings: number[][] = [];
      for (const z of zl) {
        const yb = L.yb(z), yt = Math.max(L.yt(z), yb + 0.005), w = Math.max(0.002, L.w(z));
        const mid = (yt + yb) / 2, hh = (yt - yb) / 2;
        const f = Math.min(endF(L.zf - z, rF), endF(z - L.zr, rR));
        const tumY = L.tumY ?? mid;
        const ring: number[] = [];
        for (let k = 0; k < RING; k++) {
          const th = (k / RING) * Math.PI * 2;
          const c = Math.cos(th), s = Math.sin(th);
          const n = s >= 0 ? nTop : nBot;
          const ex = Math.sign(c) * Math.abs(c) ** (2 / n);
          const ey = Math.sign(s) * Math.abs(s) ** (2 / n);
          let x = w * ex;
          let y = mid + hh * ey;
          if (s > 0) y -= crown * ex * ex * Math.min(1, ey * 2);
          if (tum > 0 && y > tumY && yt > tumY) {
            const t = Math.min(1, (y - tumY) / (yt - tumY));
            x -= Math.sign(x) * tum * t * t;
          }
          x *= f;
          y = mid + (y - mid) * f;
          let zz = z;
          if (L.kf) zz = Math.min(zz, L.zf - L.kf * (y - (L.yRef ?? 0)));
          if (L.kr) zz = Math.max(zz, L.zr + L.kr * (y - (L.yRef ?? 0)));
          ring.push(this.vert(xc * side + side * x, y, zz));
        }
        rings.push(ring);
      }
      for (let i = 0; i < rings.length - 1; i++) {
        for (let k = 0; k < RING; k++) {
          const a = rings[i][k], b = rings[i][(k + 1) % RING];
          const c = rings[i + 1][k], d = rings[i + 1][(k + 1) % RING];
          if (side > 0) {
            this.tri(a, b, c);
            this.tri(b, d, c);
          } else {
            this.tri(a, c, b);
            this.tri(b, c, d);
          }
        }
      }
      out.sides.push({ rings, zs: zl });
    }
    return out;
  }

  /**
   * A flat plate: polygon `poly` ([a, b, ...] in the frame's u, v axes) at origin `o`, `thick` along u x v (centred on the plane).
   * Returns the outline at each face (for edge lines).
   */
  slab(poly: readonly number[], o: V3, u: V3, v: V3, thick: number): { front: THREE.Vector3[]; back: THREE.Vector3[] } {
    const U = new THREE.Vector3(...u), Vv = new THREE.Vector3(...v), O = new THREE.Vector3(...o);
    const N = new THREE.Vector3().crossVectors(U, Vv).normalize();
    const n = poly.length / 2;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) pts.push(O.clone().addScaledVector(U, poly[i * 2]).addScaledVector(Vv, poly[i * 2 + 1]));
    const front = pts.map((p) => p.clone().addScaledVector(N, thick / 2));
    const back = pts.map((p) => p.clone().addScaledVector(N, -thick / 2));
    const fi = front.map((p) => this.vert(p.x, p.y, p.z));
    const bi = back.map((p) => this.vert(p.x, p.y, p.z));
    this.cap(fi, N);
    this.cap(bi, N.clone().negate());
    // the rim: separate vertices so its normals stay square to the faces
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = this.vert(front[i].x, front[i].y, front[i].z), b = this.vert(front[j].x, front[j].y, front[j].z);
      const c = this.vert(back[i].x, back[i].y, back[i].z), d = this.vert(back[j].x, back[j].y, back[j].z);
      const mid = front[i].clone().add(front[j]).multiplyScalar(0.5);
      const centre = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / n);
      const outward = mid.sub(centre);
      outward.addScaledVector(N, -outward.dot(N));
      this.orientedTri(a, b, c, outward);
      this.orientedTri(b, d, c, outward);
    }
    return { front, back };
  }

  /** A vertical plate in the (z, y) plane, its faces square to x, centred on x = `x`; `poly` is [z, y, ...]. */
  plateX(poly: readonly number[], x: number, thick: number): { front: THREE.Vector3[]; back: THREE.Vector3[] } {
    return this.slab(poly, [x, 0, 0], [0, 0, 1], [0, 1, 0], thick);
  }

  /** A horizontal plate, `poly` is [z, x, ...], centred on y = `y`. */
  plateY(poly: readonly number[], y: number, thick: number): { front: THREE.Vector3[]; back: THREE.Vector3[] } {
    return this.slab(poly, [0, y, 0], [0, 0, 1], [1, 0, 0], thick);
  }

  /** An axis-aligned box. */
  box(c: V3, hx: number, hy: number, hz: number): void {
    const P = (sx: number, sy: number, sz: number) => [c[0] + sx * hx, c[1] + sy * hy, c[2] + sz * hz] as const;
    const faces: [V3, [number, number, number][]][] = [
      [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
      [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
      [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
      [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
      [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
      [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
    ];
    for (const [nrm, q] of faces) {
      const ids = q.map(([sx, sy, sz]) => {
        const p = P(sx, sy, sz);
        return this.vert(p[0], p[1], p[2]);
      });
      const N = new THREE.Vector3(...nrm);
      this.orientedTri(ids[0], ids[1], ids[2], N);
      this.orientedTri(ids[0], ids[2], ids[3], N);
    }
  }

  /** An ellipsoid. */
  ellipsoid(c: V3, rx: number, ry: number, rz: number, seg = 14, rings = 8): void {
    const grid: number[][] = [];
    for (let i = 0; i <= rings; i++) {
      const phi = (i / rings) * Math.PI;
      const row: number[] = [];
      for (let j = 0; j < seg; j++) {
        const th = (j / seg) * Math.PI * 2;
        row.push(this.vert(c[0] + rx * Math.sin(phi) * Math.cos(th), c[1] + ry * Math.cos(phi), c[2] + rz * Math.sin(phi) * Math.sin(th)));
      }
      grid.push(row);
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < seg; j++) {
        const a = grid[i][j], b = grid[i][(j + 1) % seg], cc = grid[i + 1][j], d = grid[i + 1][(j + 1) % seg];
        this.tri(a, cc, b);
        this.tri(b, cc, d);
      }
    }
  }

  /** A tube along `path`, radius r (or r(t) for t in 0..1); returns its rings (vertex 0 of each ring on the side nearest `up`). */
  tube(path: readonly V3[], r: number | ((t: number) => number), seg = 8, up: V3 = [0, 1, 0], capEnds = true): number[][] {
    const P = path.map((p) => new THREE.Vector3(...p));
    const U = new THREE.Vector3(...up);
    const rings: number[][] = [];
    for (let i = 0; i < P.length; i++) {
      const t = new THREE.Vector3().subVectors(P[Math.min(P.length - 1, i + 1)], P[Math.max(0, i - 1)]).normalize();
      const a = U.clone().addScaledVector(t, -U.dot(t));
      if (a.lengthSq() < 1e-6) a.set(1, 0, 0).addScaledVector(t, -t.x);
      a.normalize();
      const b = new THREE.Vector3().crossVectors(t, a);
      const rr = typeof r === 'number' ? r : r(i / (P.length - 1));
      const ring: number[] = [];
      for (let k = 0; k < seg; k++) {
        const th = (k / seg) * Math.PI * 2;
        const q = P[i].clone().addScaledVector(a, Math.cos(th) * rr).addScaledVector(b, Math.sin(th) * rr);
        ring.push(this.vert(q.x, q.y, q.z));
      }
      rings.push(ring);
    }
    for (let i = 0; i < rings.length - 1; i++) {
      const t = new THREE.Vector3().subVectors(P[i + 1], P[i]);
      for (let k = 0; k < seg; k++) {
        const a = rings[i][k], b = rings[i][(k + 1) % seg], c = rings[i + 1][k], d = rings[i + 1][(k + 1) % seg];
        // outward = away from the path
        const out = this.p(a).sub(P[i]);
        void t;
        this.orientedTri(a, b, c, out);
        this.orientedTri(b, d, c, out);
      }
    }
    if (capEnds) {
      this.cap(rings[0], new THREE.Vector3().subVectors(P[0], P[1]));
      this.cap(rings[rings.length - 1], new THREE.Vector3().subVectors(P[P.length - 1], P[P.length - 2]));
    }
    return rings;
  }

  /** A flat ring (annulus) round `c` facing `axis`, radii r0 < r1 (r0 = 0: a disc). */
  ring(c: V3, axis: V3, r0: number, r1: number, seg = 24): void {
    const A = new THREE.Vector3(...axis).normalize();
    const u = new THREE.Vector3().crossVectors(A, Math.abs(A.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(A, u);
    const C = new THREE.Vector3(...c);
    const inner: number[] = [], outer: number[] = [];
    for (let k = 0; k < seg; k++) {
      const th = (k / seg) * Math.PI * 2;
      const d = u.clone().multiplyScalar(Math.cos(th)).addScaledVector(v, Math.sin(th));
      const po = C.clone().addScaledVector(d, r1);
      outer.push(this.vert(po.x, po.y, po.z));
      if (r0 > 0) {
        const pi = C.clone().addScaledVector(d, r0);
        inner.push(this.vert(pi.x, pi.y, pi.z));
      }
    }
    if (r0 <= 0) {
      const ci = this.vert(C.x, C.y, C.z);
      for (let k = 0; k < seg; k++) this.orientedTri(ci, outer[k], outer[(k + 1) % seg], A);
      return;
    }
    for (let k = 0; k < seg; k++) {
      const j = (k + 1) % seg;
      this.orientedTri(inner[k], outer[k], outer[j], A);
      this.orientedTri(inner[k], outer[j], inner[j], A);
    }
  }

  /** A wing element: an inverted aerofoil lofted through `secs` (across the car), capped; returns its leading/trailing edge points. */
  element(secs: readonly Section[], thick: number, camber: number, m = 8): { le: THREE.Vector3[]; te: THREE.Vector3[] } {
    const rings: number[][] = [];
    const le: THREE.Vector3[] = [];
    const te: THREE.Vector3[] = [];
    for (const sc of secs) {
      const c = Math.cos(sc.inc), s = Math.sin(sc.inc);
      const pts: [number, number][] = [];
      // upper surface from the leading edge back, then the lower one forward (u along the chord from the LE, v up)
      const prof = (t: number) => 5 * thick * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1036 * t ** 4);
      for (let i = 0; i <= m; i++) {
        const t = (1 - Math.cos((i / m) * Math.PI)) / 2;
        const mean = -camber * 4 * t * (1 - t);
        pts.push([t, mean + prof(t)]);
      }
      for (let i = m - 1; i >= 1; i--) {
        const t = (1 - Math.cos((i / m) * Math.PI)) / 2;
        const mean = -camber * 4 * t * (1 - t);
        pts.push([t, mean - prof(t)]);
      }
      const ring = pts.map(([t, vv]) => {
        const u = (0.25 - t) * sc.chord;
        const v = vv * sc.chord;
        return this.vert(sc.x, sc.y + u * s + v * c, sc.z + u * c - v * s);
      });
      rings.push(ring);
      const e = edges(sc);
      le.push(new THREE.Vector3(sc.x, e.le[1], e.le[0]));
      te.push(new THREE.Vector3(sc.x, e.te[1], e.te[0]));
    }
    const n = rings[0].length;
    const across = new THREE.Vector3(secs[secs.length - 1].x - secs[0].x, 0, 0);
    for (let i = 0; i < rings.length - 1; i++) {
      const sc = secs[i];
      for (let k = 0; k < n; k++) {
        const a = rings[i][k], b = rings[i][(k + 1) % n], cc = rings[i + 1][k], d = rings[i + 1][(k + 1) % n];
        const centre = new THREE.Vector3(sc.x, sc.y, sc.z - 0.25 * sc.chord);
        const out = this.p(a).sub(centre);
        out.x = 0;
        this.orientedTri(a, b, cc, out);
        this.orientedTri(b, d, cc, out);
      }
    }
    this.cap(rings[0], across.clone().negate());
    this.cap(rings[rings.length - 1], across);
    return { le, te };
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 1));
    g.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeVertexNormals();
    this.normals = (g.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array;
    g.computeBoundingSphere();
    return g;
  }
}

/** The neon edge lines of one car: pairs of points with colours, traced over the mesh (offset off its surface so they win the depth test). */
export class LineBuilder {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  private traces: { mb: MeshBuilder; ids: number[]; c: RGB; closed: boolean; off: number }[] = [];

  seg(a: THREE.Vector3, b: THREE.Vector3, c: RGB): void {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    this.col.push(c[0], c[1], c[2], c[0], c[1], c[2]);
  }

  /** A polyline through `pts`. */
  poly(pts: readonly THREE.Vector3[], c: RGB, closed = false): void {
    for (let i = 0; i < pts.length - 1; i++) this.seg(pts[i], pts[i + 1], c);
    if (closed && pts.length > 2) this.seg(pts[pts.length - 1], pts[0], c);
  }

  /** The same polyline and its mirror image across the centre line. */
  polySym(pts: readonly THREE.Vector3[], c: RGB, closed = false): void {
    this.poly(pts, c, closed);
    this.poly(pts.map((p) => new THREE.Vector3(-p.x, p.y, p.z)), c, closed);
  }

  /** A line along mesh vertices `ids`, pushed `off` metres out along their normals (resolved after the mesh is built). */
  trace(mb: MeshBuilder, ids: number[], c: RGB, closed = false, off = 0.006): void {
    this.traces.push({ mb, ids, c, closed, off });
  }

  /**
   * A line along a loft at ring angle `deg` (0 outboard, 90 top, 270 bottom), from z0 to z1, on each side of a pair; on a centred
   * loft, `sym` also traces the mirror angle (180 - deg), the other side.
   */
  loftLine(mb: MeshBuilder, L: Loft, deg: number, c: RGB, z0 = -1e9, z1 = 1e9, sym = true): void {
    const angles = L.sides.length === 1 && sym ? [deg, 180 - deg] : [deg];
    for (const side of L.sides) {
      for (const a of angles) {
        const k = ((Math.round((a / 360) * L.n) % L.n) + L.n) % L.n;
        const ids: number[] = [];
        side.rings.forEach((r, i) => {
          if (side.zs[i] >= z0 && side.zs[i] <= z1) ids.push(r[k]);
        });
        if (ids.length > 1) this.trace(mb, ids, c);
      }
    }
  }

  /** A section ring of a loft, at the station nearest z. */
  loftRing(mb: MeshBuilder, L: Loft, z: number, c: RGB, k0 = 0, k1 = -1): void {
    for (const side of L.sides) {
      let best = 0;
      side.zs.forEach((zz, i) => {
        if (Math.abs(zz - z) < Math.abs(side.zs[best] - z)) best = i;
      });
      const ring = side.rings[best];
      if (k1 < 0) this.trace(mb, ring, c, true);
      else {
        const ids: number[] = [];
        for (let k = k0; k <= k1; k++) ids.push(ring[((k % L.n) + L.n) % L.n]);
        this.trace(mb, ids, c);
      }
    }
  }

  build(): LineSegmentsGeometry {
    for (const t of this.traces) {
      const pts = t.ids.map((i) => t.mb.p(i).addScaledVector(t.mb.n(i), t.off));
      this.poly(pts, t.c, t.closed);
    }
    this.traces = [];
    const g = new LineSegmentsGeometry();
    g.setPositions(this.pos);
    g.setColors(this.col);
    return g;
  }
}
