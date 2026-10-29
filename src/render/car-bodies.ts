/**
 * The three neon bodies: the LMP-X, the Volta and the Dieci, each drawn as Xeno-Racer draws it (src/carvis/bodies/prototype.ts,
 * formula.ts + formulaParts.ts, formula04.ts + formula04Parts.ts there): the same lofted sections (their profile curves copied) and
 * the same parts in the same places, so the silhouettes match; but dark, with neon edges and light strips instead of paint.
 *
 * Each builder writes the body into one MeshBuilder and its edges into one LineBuilder; the Volta's moving flaps go into meshes and
 * lines of their own (they turn on their hinges with VehicleState.aeroOpen).
 */
import * as THREE from 'three';
import type { CarVisualSpec } from '../core/contracts';
import { PALETTE } from './palette';
import { curve, edges, flat, LineBuilder, MeshBuilder, neon, roundPoly, GLOW, type RGB, type Section, type V3 } from './car-geom';

export interface CarStyle {
  /** the main neon (the body's edges, the wheels) */
  accent: number;
  /** the second neon (wings, details) */
  second: number;
}

export const CAR_STYLES: Record<string, CarStyle> = {
  'lmp-x': { accent: PALETTE.cyan, second: PALETTE.magenta },
  volta: { accent: PALETTE.magenta, second: 0x9b7bff },
  dieci: { accent: PALETTE.amber, second: 0xfff1dc },
};

export function styleFor(id: string): CarStyle {
  return CAR_STYLES[id] ?? CAR_STYLES['lmp-x'];
}

/** The colours a builder paints with. */
export interface Ink {
  body: RGB;
  dark: RGB;
  /** bright main edges, softer main edges, second-colour edges, faint detail */
  A: RGB;
  a: RGB;
  B: RGB;
  d: RGB;
  head: RGB;
  tail: RGB;
  exhaust: RGB;
  strip: RGB;
  visor: RGB;
}

export function inkFor(st: CarStyle): Ink {
  return {
    body: [0.016, 0.014, 0.036],
    dark: [0.004, 0.003, 0.008],
    A: neon(st.accent, 1.15),
    a: neon(st.accent, 0.42),
    B: neon(st.second, 1.0),
    d: neon(st.accent, 0.2),
    head: neon(0xe6f7ff, 1.4),
    tail: neon(0xff1e4a, 1.3),
    exhaust: neon(PALETTE.amber, 1.6),
    strip: neon(st.accent, 0.9),
    visor: neon(st.second, 0.5),
  };
}

/** A part that turns on a hinge (the Volta's flaps): its own mesh and lines, the pivot and axis in the body frame, its full angle. */
export interface Mover {
  name: string;
  pivot: THREE.Vector3;
  axis: THREE.Vector3;
  angle: number;
  mb: MeshBuilder;
  lb: LineBuilder;
}

export interface BodyOut {
  movers: Mover[];
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const mirror = (p: THREE.Vector3) => new THREE.Vector3(-p.x, p.y, p.z);

/** The outline of a plate built by MeshBuilder.slab, on its outer face (or both), on both sides of the car when `sym`. */
function plateLines(lb: LineBuilder, o: { front: THREE.Vector3[]; back: THREE.Vector3[] }, c: RGB, sym: boolean, both = false, off = 0.004): void {
  const push = (pts: THREE.Vector3[], dir: number) => {
    const q = pts.map((p) => p.clone());
    // push the outline off the face, along x (plates here face x) or y
    const n = new THREE.Vector3().subVectors(o.front[0], o.back[0]).normalize().multiplyScalar(off * dir);
    for (const p of q) p.add(n);
    if (sym) lb.polySym(q, c, true);
    else lb.poly(q, c, true);
  };
  push(o.front, 1);
  if (both) push(o.back, -1);
}

/** A wing element's leading and trailing edges as lines, lifted a hair off the surface. */
function wingLines(lb: LineBuilder, e: { le: THREE.Vector3[]; te: THREE.Vector3[] }, cLe: RGB, cTe: RGB | null): void {
  lb.poly(e.le.map((p) => p.clone().add(v3(0, 0.004, 0.006))), cLe);
  if (cTe) lb.poly(e.te.map((p) => p.clone().add(v3(0, 0.006, -0.004))), cTe);
}

/** A plate on both sides of the car, its centre at |x| = x. */
function plates(mb: MeshBuilder, poly: number[], x: number, thick: number) {
  const l = mb.plateX(poly, x, thick);
  const r = mb.plateX(poly, -x, thick);
  return { l, r };
}

/** A glowing box and its mirror image. */
function lampSym(mb: MeshBuilder, c: V3, hx: number, hy: number, hz: number): void {
  mb.box(c, hx, hy, hz);
  mb.box([-c[0], c[1], c[2]], hx, hy, hz);
}

// ─────────────────────────────────────────────────────────────────────────────
// LMP-X: the Le Mans prototype
// ─────────────────────────────────────────────────────────────────────────────

/** The bottom of a fender over a wheel: level at `base`, arching over the wheel (hub height `hub`, arch radius `R`) at zc. */
function archCurve(zr: number, zf: number, zc: number, hub: number, R: number, base: number) {
  const pts: number[] = [zr, base, zc - R - 0.02, base];
  for (let i = 0; i <= 12; i++) {
    const dz = -R + (2 * R * i) / 12;
    pts.push(zc + dz, Math.max(base, hub + Math.sqrt(Math.max(0, R * R - dz * dz))));
  }
  pts.push(zc + R + 0.02, base, zf, base);
  return curve(pts);
}

export function buildLmp(v: CarVisualSpec, mb: MeshBuilder, lb: LineBuilder, k: Ink): BodyOut {
  const zF = v.wheelbase / 2, zR = -zF;
  const zNose = zF + v.frontOverhang;
  const zTail = -(zF + (v.length - v.wheelbase - v.frontOverhang));
  const hk = v.height / 1.05;

  // the central tub, nose and engine cover
  const tub = mb.loft({
    zr: zTail,
    zf: zNose,
    yb: curve([zTail, 0.14, zTail + 0.4, 0.08, zTail + 0.9, 0.06, zNose - 0.5, 0.06, zNose - 0.1, 0.07, zNose, 0.12]),
    yt: curve([zTail, 0.58 * hk, zTail + 0.3, 0.64 * hk, -1.5, 0.76 * hk, -1.0, 0.84 * hk, -0.5, 0.86 * hk, -0.1, 0.8 * hk, 0.3, 0.66 * hk, 0.9, 0.62 * hk, 1.3, 0.57 * hk, 1.7, 0.5 * hk, 2.05, 0.4 * hk, zNose - 0.2, 0.3 * hk, zNose, 0.2 * hk]),
    w: curve([zTail, 0.34, zTail + 0.3, 0.48, -1.6, 0.58, -1.0, 0.63, -0.3, 0.62, 0.3, 0.55, 0.9, 0.46, 1.4, 0.4, 1.9, 0.34, zNose - 0.2, 0.26, zNose, 0.16]),
    crown: 0.05,
    tum: 0.1,
    tumY: 0.3,
    rF: 0.16,
    rR: 0.1,
    kf: 0.28,
    kr: 0.1,
    yRef: 0.1,
  });
  // the canopy: a dome over the cockpit, its windscreen raked well back
  const canopyFrom = mb.vertexCount;
  const canopy = mb.loft({
    zr: -0.62,
    zf: 1.38,
    yb: flat(0.5),
    yt: curve([-0.62, 0.78 * hk, -0.45, 0.93 * hk, -0.2, 1.02 * hk, 0.05, 1.05 * hk, 0.3, 1.02 * hk, 0.55, 0.96 * hk, 0.8, 0.9 * hk, 1.0, 0.85 * hk]),
    w: curve([-0.62, 0.34, -0.4, 0.46, 0.0, 0.53, 0.4, 0.5, 0.8, 0.44, 1.0, 0.4]),
    crown: 0.1,
    tum: 0.2,
    tumY: 0.62,
    nTop: 2.6,
    rF: 0.12,
    rR: 0.12,
    kf: 1.05,
    kr: 0.5,
    yRef: 0.55,
  });
  // the glass: the canopy's upper part a shade darker and bluer
  mb.recolor(canopyFrom, mb.vertexCount, (_x, y) => y > 0.66 * hk, [0.006, 0.008, 0.03]);
  // the side pods between the wheels
  const side = mb.loft({ zr: -0.9, zf: 1.0, yb: flat(0.09), yt: flat(0.51), w: flat(0.28), x: 0.62, nTop: 5, nBot: 5, rF: 0.14, rR: 0.14 });
  // the fenders: tall pods over the wheels, arching over them (the wheels show through the arch)
  const podX = 0.745;
  const rF = v.wheelRadiusFront, rRr = v.wheelRadiusRear;
  const fzr = zF - 0.98, fzf = zF + 0.93;
  const front = mb.loft({
    zr: fzr,
    zf: fzf,
    x: podX,
    yb: archCurve(fzr, fzf, zF, rF, rF + 0.045, 0.11),
    yt: curve([zF - 0.95, 0.56 * hk, zF - 0.5, 0.7 * hk, zF - 0.05, 0.77 * hk, zF + 0.4, 0.72 * hk, zF + 0.75, 0.56 * hk, zF + 0.9, 0.42 * hk]),
    w: curve([zF - 1.0, 0.2, zF - 0.5, 0.235, zF + 0.3, 0.24, zF + 0.7, 0.215, zF + 0.9, 0.16]),
    crown: 0.05,
    tum: 0.03,
    tumY: 0.4,
    nTop: 3,
    rF: 0.2,
    rR: 0.2,
    kf: 0.35,
    yRef: 0.1,
    step: 0.035,
  });
  const rzr = zTail, rzf = zR + 0.98;
  const rear = mb.loft({
    zr: rzr,
    zf: rzf,
    x: podX,
    yb: archCurve(rzr, rzf, zR, rRr, rRr + 0.045, 0.11),
    yt: curve([zR + 0.95, 0.6 * hk, zR + 0.5, 0.76 * hk, zR + 0.05, 0.88 * hk, zR - 0.45, 0.9 * hk, zR - 0.85, 0.82 * hk]),
    w: curve([zR + 1.0, 0.18, zR + 0.5, 0.235, zR - 0.4, 0.24, zR - 0.8, 0.2]),
    crown: 0.05,
    tum: 0.03,
    tumY: 0.4,
    nTop: 3,
    rF: 0.18,
    rR: 0.07,
    kf: 0.3,
    kr: 0.2,
    yRef: 0.1,
    step: 0.035,
  });

  // edges: the fenders' crests and the arches (the lower outer corner follows the arch), the nose deck, the canopy's glass line
  lb.loftLine(mb, front, 90, k.A);
  lb.loftLine(mb, rear, 90, k.A);
  lb.loftLine(mb, front, 330, k.A);
  lb.loftLine(mb, rear, 330, k.A);
  lb.loftLine(mb, front, 165, k.d);
  lb.loftLine(mb, rear, 165, k.d);
  lb.loftLine(mb, tub, 55, k.a, zF - 0.6, zNose);
  lb.loftLine(mb, tub, 50, k.a, zTail, -0.7);
  lb.loftLine(mb, canopy, 30, k.B);
  lb.loftLine(mb, canopy, 90, k.a, -0.62, 0.8);
  lb.loftLine(mb, side, 30, k.a);
  lb.loftLine(mb, side, 330, k.d);

  // splitter
  {
    const poly = roundPoly([zNose + 0.14, 0, zNose + 0.1, 0.5, zNose - 0.2, 0.86, zNose - 0.45, 0.97, zNose - 0.95, 0.97, zNose - 0.95, -0.97, zNose - 0.45, -0.97, zNose - 0.2, -0.86, zNose + 0.1, -0.5], 0.03);
    mb.paint(k.dark);
    const s = mb.plateY(poly, 0.075, 0.016);
    lb.poly(s.front.slice(0, Math.floor(s.front.length * 0.42)).map((p) => p.clone().add(v3(0, 0.004, 0))), k.a);
    lb.poly(s.front.slice(Math.floor(s.front.length * 0.6)).map((p) => p.clone().add(v3(0, 0.004, 0))), k.a);
    mb.paint();
  }
  // the shark fin from the roof to the wing
  {
    const fin = roundPoly([-0.3, 0.86 * hk, -0.42, 1.0 * hk, -1.95, 1.06 * hk, -2.04, 0.98 * hk, -2.04, 0.6 * hk, -1.0, 0.78 * hk], [0, 0.05, 0.05, 0.03, 0, 0], 3);
    const f = mb.plateX(fin, 0, 0.012);
    // the fin's top edge in the second colour, both faces
    for (const face of [f.front, f.back]) {
      const top = face.filter((p) => p.y > 0.95 * hk && p.z > -2.03);
      lb.poly(top.map((p) => p.clone().add(v3(Math.sign(p.x) * 0.004, 0.004, 0))), k.B);
    }
  }
  // rear wing: a two-element wing on a central pylon, with big end plates; a beam wing under it
  {
    const zW = zTail + 0.3, yW = 0.9 * hk;
    const xs = [-0.92, -0.6, -0.3, 0, 0.3, 0.6, 0.92];
    mb.paint(k.body);
    const main = mb.element(xs.map((x) => ({ x, y: yW, z: zW, chord: 0.4, inc: -0.1 })), 0.12, 0.05);
    const flap = mb.element(xs.map((x) => ({ x, y: yW + 0.1, z: zW - 0.25, chord: 0.24, inc: -0.42 })), 0.12, 0.05);
    wingLines(lb, main, k.A, null);
    wingLines(lb, flap, k.a, k.B);
    const ep = roundPoly([zW + 0.2, yW - 0.12, zW + 0.2, yW + 0.1, zW + 0.05, yW + 0.22, zW - 0.44, yW + 0.22, zW - 0.44, yW - 0.12], 0.04);
    const e = plates(mb, ep, 0.935, 0.014);
    plateLines(lb, e.l, k.A, false, true);
    plateLines(lb, e.r, k.A, false, true);
    mb.plateX(roundPoly([zW + 0.16, 0.6 * hk, zW + 0.06, yW, zW - 0.12, yW, zW - 0.1, 0.6 * hk], 0.02), 0, 0.03);
    const beam = mb.element([-0.56, 0, 0.56].map((x) => ({ x, y: 0.7 * hk, z: zTail + 0.1, chord: 0.16, inc: -0.15 })), 0.12, 0.04);
    wingLines(lb, beam, k.d, null);
  }
  // diffuser strakes
  for (const x of [-0.42, -0.28, -0.14, 0, 0.14, 0.28, 0.42]) {
    const s = mb.plateX([zTail + 0.55, 0.07, zTail + 0.02, 0.07, zTail + 0.02, 0.34], x, 0.01);
    lb.poly([s.front[0], s.front[2]].map((p) => p.clone()), k.d);
  }
  // roof scoop
  mb.paint(k.dark);
  mb.ellipsoid([0, 1.04 * hk, -0.1], 0.13, 0.05, 0.28, 12, 6);
  mb.paint();

  // lights: the DRL bars and lamps in the fenders' faces, the tail lamps and the brake bar, the exhausts, a strip along each side pod
  mb.lamp(k.head);
  lampSym(mb, [podX, 0.5 * hk, fzf - 0.11], 0.14, 0.006, 0.05);
  lampSym(mb, [podX, 0.41 * hk, fzf - 0.07], 0.035, 0.016, 0.03);
  mb.lamp(k.tail, GLOW.brake);
  lampSym(mb, [podX, 0.62 * hk, zTail + 0.01], 0.035, 0.17, 0.03);
  mb.box([0, 0.47 * hk, zTail + 0.05], 0.3, 0.012, 0.03);
  mb.lamp(k.exhaust);
  for (const x of [-0.1, 0.1]) mb.ring([x, 0.52, zTail - 0.03], [0, 0, -1], 0.028, 0.043, 16);
  mb.lamp(k.strip);
  lampSym(mb, [0.9, 0.1, 0.05], 0.006, 0.006, 0.85);
  mb.paint();
  void side;
  return { movers: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Volta: the 2026 single-seater
// ─────────────────────────────────────────────────────────────────────────────

/** The cockpit reference of a single-seater, as Xeno-Racer's layouts.ts formulaCockpit: the driver's eye, and `sz` 5 cm behind it. */
function cockpit(v: CarVisualSpec): { eye: V3; sz: number } {
  const eye: V3 = v.formulaEra === 2004 ? [v.seat.x, v.seat.y + 0.51, v.seat.z - 0.37] : [v.seat.x, v.seat.y + 0.55, v.seat.z - 0.37];
  return { eye, sz: eye[2] - 0.05 };
}

function voltaFrontMain(zNose: number): Section[] {
  const xs = [-0.86, -0.62, -0.36, -0.17, 0, 0.17, 0.36, 0.62, 0.86];
  const yOf = (ax: number): number => (ax < 0.17 ? 0.128 - (0.01 * ax) / 0.17 : ax < 0.36 ? 0.118 - (0.03 * (ax - 0.17)) / 0.19 : ax < 0.62 ? 0.088 - (0.01 * (ax - 0.36)) / 0.26 : 0.078 + (0.004 * (ax - 0.62)) / 0.24);
  return xs.map((x) => {
    const ax = Math.abs(x);
    return { x, y: yOf(ax), z: zNose - 0.085 - (0.015 * Math.max(0, ax - 0.6)) / 0.26, chord: 0.3 - 0.02 * Math.min(1, ax / 0.86), inc: -0.05 - 0.05 * Math.min(1, ax / 0.62) };
  });
}

/** The two flaps of one side of a front wing, each over the trailing edge of the element ahead of it, rising at the tips. */
function flapsOver(main: Section[], sg: number, xs: number[], c1: number, i1: number, c2: number, i2: number, riseAmp: number, riseFrom: number, riseSpan: number, riseExp: number, g2: number, r2: number): [Section[], Section[]] {
  const right = main.filter((m) => m.x >= 0);
  const mainAt = (ax: number): Section => {
    for (let i = 0; i < right.length - 1; i++) {
      const a = right[i], c = right[i + 1];
      if (ax <= c.x) {
        const t = (ax - a.x) / (c.x - a.x);
        return { x: ax, y: a.y + (c.y - a.y) * t, z: a.z + (c.z - a.z) * t, chord: a.chord + (c.chord - a.chord) * t, inc: a.inc + (c.inc - a.inc) * t };
      }
    }
    return right[right.length - 1];
  };
  const f1: Section[] = [];
  const f2: Section[] = [];
  for (const ax of xs) {
    const rise = riseAmp * Math.max(0, (ax - riseFrom) / riseSpan) ** riseExp;
    const m = edges(mainAt(ax));
    const a1: Section = { x: sg * ax, y: 0, z: 0, chord: c1, inc: i1 };
    const e1 = edges(a1);
    a1.z = m.te[0] + 0.004 - e1.le[0];
    a1.y = m.te[1] + 0.012 + rise - e1.le[1];
    f1.push(a1);
    const t1 = edges(a1);
    const a2: Section = { x: sg * ax, y: 0, z: 0, chord: c2, inc: i2 };
    const e2 = edges(a2);
    a2.z = t1.te[0] + g2 - e2.le[0];
    a2.y = t1.te[1] + 0.01 + r2 * rise - e2.le[1];
    f2.push(a2);
  }
  if (sg < 0) {
    f1.reverse();
    f2.reverse();
  }
  return [f1, f2];
}

export function buildVolta(v: CarVisualSpec, mb: MeshBuilder, lb: LineBuilder, k: Ink): BodyOut {
  const zF = v.wheelbase / 2, zR = -zF;
  const zNose = zF + v.frontOverhang;
  const zTail = -(zF + (v.length - v.wheelbase - v.frontOverhang));
  const hk = v.height / 0.95;
  const { eye, sz } = cockpit(v);

  const tubF = zF + 0.62, tubR = sz - 0.6;
  const tubYt = curve([tubR, 0.665 * hk, sz - 0.35, 0.645 * hk, sz, 0.625 * hk, sz + 0.55, 0.645 * hk, zF - 0.5, 0.66 * hk, zF - 0.1, 0.645 * hk, zF + 0.2, 0.59 * hk, zF + 0.45, 0.515 * hk, tubF, 0.465 * hk]);
  const tubFrom = mb.vertexCount;
  const tub = mb.loft({
    zr: tubR,
    zf: tubF,
    yb: curve([tubR, 0.07, sz + 0.5, 0.07, zF - 0.5, 0.1, zF - 0.15, 0.17, zF + 0.2, 0.235, tubF, 0.27]),
    yt: tubYt,
    w: curve([tubR, 0.27, sz, 0.28, sz + 0.55, 0.272, zF - 0.5, 0.235, zF - 0.1, 0.195, zF + 0.2, 0.165, zF + 0.45, 0.143, tubF, 0.132]),
    crown: 0.055,
    tum: 0.035,
    tumY: 0.4,
    rF: 0.045,
    rR: 0.045,
    kf: 0.12,
    yRef: 0.35,
  });
  const snout = mb.loft({
    zr: zF + 0.15,
    zf: zNose,
    yb: curve([zF + 0.15, 0.22, zF + 0.6, 0.2, zNose - 0.15, 0.155, zNose, 0.14]),
    yt: curve([zF + 0.15, 0.42 * hk, zF + 0.6, 0.345 * hk, zNose - 0.15, 0.285 * hk, zNose, 0.25 * hk]),
    w: curve([zF + 0.15, 0.12, zF + 0.6, 0.104, zNose - 0.15, 0.085, zNose, 0.07]),
    crown: 0.03,
    rF: 0.06,
    rR: 0.04,
    kf: 0.35,
    yRef: 0.2,
  });
  const coverF = sz - 0.1, coverR = zR - 0.38;
  const cover = mb.loft({
    zr: coverR,
    zf: coverF,
    yb: curve([coverF, 0.07, zR + 0.4, 0.07, zR, 0.12, coverR, 0.2]),
    yt: curve([coverF, 0.68 * hk, sz - 0.6, 0.72 * hk, sz - 1.0, 0.7 * hk, zR + 0.55, 0.6 * hk, zR + 0.2, 0.535 * hk, zR - 0.1, 0.505 * hk, coverR, 0.49 * hk]),
    w: curve([coverF, 0.27, sz - 0.6, 0.26, sz - 1.1, 0.225, zR + 0.55, 0.17, zR + 0.2, 0.13, zR - 0.1, 0.105, coverR, 0.095]),
    crown: 0.08,
    tum: 0.05,
    tumY: 0.45,
    rF: 0.07,
    rR: 0.07,
    kr: 0.3,
    yRef: 0.4,
  });
  const boxF = sz - 0.32, boxR = sz - 1.45;
  const airbox = mb.loft({
    zr: boxR,
    zf: boxF,
    yb: flat(0.5),
    yt: curve([boxF, 0.9 * hk, sz - 0.42, 0.95 * hk, sz - 0.62, 0.95 * hk, sz - 0.9, 0.865 * hk, sz - 1.2, 0.765 * hk, boxR, 0.7 * hk]),
    w: curve([boxF, 0.075, sz - 0.45, 0.095, sz - 0.8, 0.12, boxR, 0.15]),
    crown: 0.03,
    tum: 0.02,
    tumY: 0.7,
    rF: 0.04,
    rR: 0.04,
    kf: 0.35,
    yRef: 0.8,
  });
  const podX = 0.36, podF = sz + 0.42, podR = zR + 0.3;
  const pod = mb.loft({
    zr: podR,
    zf: podF,
    x: podX,
    yb: curve([podF, 0.2, sz, 0.17, zR + 1, 0.14, podR, 0.14]),
    yt: curve([podF, 0.56 * hk, sz + 0.2, 0.585 * hk, sz - 0.4, 0.56 * hk, sz - 0.9, 0.47 * hk, zR + 0.6, 0.36 * hk, podR, 0.27 * hk]),
    w: curve([podF, 0.13, sz + 0.1, 0.145, sz - 0.5, 0.14, sz - 1.0, 0.105, zR + 0.6, 0.07, podR, 0.04]),
    crown: 0.02,
    tum: 0.05,
    tumY: 0.42,
    rF: 0.08,
    rR: 0.08,
    kf: -0.3,
    yRef: 0.35,
  });
  const gearF = zR + 0.3;
  const gearbox = mb.loft({
    zr: zTail,
    zf: gearF,
    yb: curve([gearF, 0.16, zR - 0.4, 0.22, zTail, 0.26]),
    yt: curve([gearF, 0.44 * hk, zR - 0.3, 0.42 * hk, zR - 0.6, 0.39 * hk, zTail, 0.36 * hk]),
    w: curve([gearF, 0.13, zR, 0.11, zR - 0.5, 0.075, zTail, 0.055]),
    crown: 0.02,
    rF: 0.03,
    rR: 0.025,
  });
  // the cockpit opening: painted black on the tub's top, outlined
  const wellZ = sz + 0.09;
  const inWell = (x: number, z: number, g = 0) => {
    const dx = Math.max(0, Math.abs(x) - (0.205 - 0.12)), dz = Math.max(0, Math.abs(z - wellZ) - (0.41 - 0.12));
    return Math.hypot(dx, dz) < 0.12 + g;
  };
  mb.recolor(tubFrom, mb.vertexCount, (x, y, z) => y > 0.45 && inWell(x, z), k.dark);
  lb.poly(wellOutline(wellZ, 0.205, 0.41, 0.12, (x, z) => tubYt(z) - 0.055 * (x / 0.27) ** 2 + 0.012), k.B, true);

  // edges
  lb.loftLine(mb, tub, 40, k.A, tubR + 0.1, tubF);
  lb.loftLine(mb, snout, 40, k.A, zF + 0.5, zNose);
  lb.loftLine(mb, snout, 330, k.a, zF + 0.5, zNose);
  lb.loftLine(mb, tub, 320, k.d);
  lb.loftLine(mb, cover, 45, k.A, coverR, sz - 0.6);
  lb.loftLine(mb, airbox, 90, k.B);
  lb.loftLine(mb, pod, 50, k.A);
  lb.loftLine(mb, pod, 320, k.a);
  lb.loftRing(mb, pod, podF - 0.02, k.B);
  lb.loftLine(mb, gearbox, 40, k.a);
  void eye;

  // the helmet, its visor glowing
  mb.paint([0.03, 0.026, 0.06]);
  mb.ellipsoid([eye[0], eye[1] - 0.03, eye[2] - 0.07], 0.11, 0.125, 0.14, 14, 8);
  mb.lamp(k.visor);
  mb.box([0, eye[1] - 0.005, eye[2] + 0.06], 0.07, 0.013, 0.012);
  mb.paint();

  // the halo
  {
    const left: V3[] = [
      [0.255, 0.585 * hk, sz - 0.36],
      [0.262, 0.7 * hk, sz - 0.27],
      [0.255, 0.8 * hk, sz - 0.14],
      [0.235, 0.855 * hk, sz + 0.02],
      [0.19, 0.875 * hk, sz + 0.16],
      [0.11, 0.882 * hk, sz + 0.26],
    ];
    const ctrl: V3[] = [...left, [0, 0.885 * hk, sz + 0.3], ...left.slice().reverse().map((p) => [-p[0], p[1], p[2]] as V3)];
    const hoop = smooth(ctrl, 4);
    mb.tube(hoop, 0.024, 8);
    mb.tube([[0, 0.878 * hk, sz + 0.285], [0, 0.63 * hk, sz + 0.57]], 0.024, 8);
    lb.poly(hoop.map((p) => v3(p[0], p[1] + 0.026, p[2])), k.B);
    lb.poly([v3(0, 0.878 * hk + 0.026, sz + 0.285), v3(0, 0.63 * hk + 0.026, sz + 0.57)], k.B);
  }

  // front wing: the mainplane fixed, its flaps moving
  const fMain = voltaFrontMain(zNose);
  mb.paint();
  const fm = mb.element(fMain, 0.08, 0.05);
  wingLines(lb, fm, k.A, null);
  const fe = roundPoly([zNose - 0.04, 0.035, zNose - 0.06, 0.13, zNose - 0.28, 0.17, zNose - 0.46, 0.29, zNose - 0.53, 0.3, zNose - 0.53, 0.04], [0.01, 0.03, 0.06, 0.03, 0.01, 0.01]);
  const fep = plates(mb, fe, 0.871, 0.012);
  plateLines(lb, fep.l, k.A, false, true);
  plateLines(lb, fep.r, k.A, false, true);
  const frontFlaps = (sg: number) => flapsOver(fMain, sg, [0.2, 0.4, 0.62, 0.85], 0.16, -0.42, 0.12, -0.72, 0.035, 0.45, 0.4, 1.5, 0.025, 0.4);

  // rear wing: the mainplane and end plates fixed, its two-element flap moving
  const rMain: Section[] = [-0.51, -0.3, 0, 0.3, 0.51].map((x) => ({ x, y: (0.765 + 0.012 * Math.abs(x)) * hk, z: zTail + 0.29, chord: 0.24, inc: -0.1 }));
  const rm = mb.element(rMain, 0.1, 0.06);
  wingLines(lb, rm, k.A, null);
  const rearFlaps = (): [Section[], Section[]] => {
    const f1: Section[] = [], f2: Section[] = [];
    for (const m of rMain) {
      const e = edges(m);
      const a1: Section = { x: m.x, y: 0, z: 0, chord: 0.17, inc: -0.48 };
      const e1 = edges(a1);
      a1.z = e.te[0] - 0.005 - e1.le[0];
      a1.y = e.te[1] + 0.012 - e1.le[1];
      f1.push(a1);
      const t1 = edges(a1);
      const a2: Section = { x: m.x, y: 0, z: 0, chord: 0.11, inc: -0.78 };
      const e2 = edges(a2);
      a2.z = t1.te[0] + 0.03 - e2.le[0];
      a2.y = t1.te[1] + 0.01 - e2.le[1];
      f2.push(a2);
    }
    return [f1, f2];
  };
  const wingLedZ = zTail - 0.1;
  const rep = roundPoly([zTail + 0.33, 0.69 * hk, zTail + 0.37, 0.8 * hk, zTail + 0.3, 0.935 * hk, zTail + 0.15, 0.975 * hk, wingLedZ + 0.002, 0.975 * hk, wingLedZ + 0.002, 0.68 * hk, zTail + 0.12, 0.655 * hk], [0.03, 0.06, 0.1, 0.06, 0.01, 0.01, 0.06]);
  const repp = plates(mb, rep, 0.521, 0.012);
  plateLines(lb, repp.l, k.A, false, true);
  plateLines(lb, repp.r, k.A, false, true);
  plates(mb, roundPoly([zTail + 0.43, 0.36 * hk, zTail + 0.35, 0.765 * hk, zTail + 0.22, 0.76 * hk, zTail + 0.22, 0.35 * hk], 0.015), 0.055, 0.014);

  // the floor, its edge lit
  {
    const sideOut: [number, number][] = [[zF - 0.38, 0.2], [zF - 0.6, 0.48], [zF - 0.85, 0.62], [zF - 1.3, 0.68], [zR + 0.8, 0.68], [zR + 0.5, 0.6], [zR + 0.36, 0.52], [zR + 0.25, 0.5]];
    floor(mb, lb, sideOut, v.rideHeight + 0.009, k);
  }
  // suspension arms (lines only) and the fin on the engine cover
  suspension(lb, v, zF, zR, hk, k.d, false);
  {
    const f = mb.plateX(roundPoly([sz - 0.95, 0.86 * hk, sz - 1.75, 0.63 * hk, sz - 1.75, 0.5 * hk, sz - 0.95, 0.75 * hk], 0.02), 0, 0.01);
    lb.poly([f.front[0], f.front[Math.floor(f.front.length / 4)]].map((p) => p.clone()), k.a);
  }

  // lights: the LED lamps in the nose's step, the rain light and the end plates' LED strips (tail/brake), the tailpipe
  mb.lamp(k.head);
  lampSym(mb, [0.072, 0.405 * hk, zF + 0.6], 0.03, 0.013, 0.012);
  mb.lamp(k.tail, GLOW.brake);
  mb.box([0, 0.31 * hk, zTail - 0.004], 0.034, 0.02, 0.008);
  lampSym(mb, [0.526, 0.785 * hk, wingLedZ - 0.002], 0.009, 0.085 * hk, 0.008);
  mb.paint([0.02, 0.018, 0.03]);
  mb.tube([[0, v.rideHeight + 0.41, zR - 0.34], [0, v.rideHeight + 0.41, zR - 0.5]], 0.042, 12);
  mb.lamp(k.exhaust);
  mb.ring([0, v.rideHeight + 0.41, zR - 0.503], [0, 0, -1], 0.02, 0.04, 16);
  mb.paint();

  // the moving flaps
  const movers: Mover[] = [];
  {
    const m = new Mover0('frontFlaps', -0.17, k);
    const [, l2] = frontFlaps(1);
    const piv = edges(l2[0]).te;
    for (const sg of [1, -1]) {
      const [f1, f2] = frontFlaps(sg);
      const e1 = m.mb.element(f1, 0.09, 0.05);
      const e2 = m.mb.element(f2, 0.09, 0.05);
      wingLines(m.lb, e1, k.a, null);
      wingLines(m.lb, e2, k.d, k.B);
    }
    movers.push(m.done(v3(0, piv[1], piv[0])));
  }
  {
    const m = new Mover0('rearFlaps', -0.45, k);
    const [r1, r2] = rearFlaps();
    const piv = edges(r2[2]).te;
    const e1 = m.mb.element(r1, 0.1, 0.06);
    const e2 = m.mb.element(r2, 0.1, 0.06);
    wingLines(m.lb, e1, k.a, null);
    wingLines(m.lb, e2, k.d, k.B);
    movers.push(m.done(v3(0, piv[1], piv[0])));
  }
  return { movers };
}

class Mover0 {
  readonly mb: MeshBuilder;
  readonly lb = new LineBuilder();
  constructor(readonly name: string, readonly angle: number, k: Ink) {
    this.mb = new MeshBuilder(k.body);
  }
  done(pivot: THREE.Vector3): Mover {
    return { name: this.name, pivot, axis: v3(1, 0, 0), angle: this.angle, mb: this.mb, lb: this.lb };
  }
}

/** The outline of the cockpit's opening (a rounded slot in plan), riding on the tub's top `top(x, z)`. */
function wellOutline(zc: number, hx: number, hz: number, r: number, top: (x: number, z: number) => number): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const corners: [number, number, number][] = [
    [hx - r, zc + hz - r, 0],
    [-(hx - r), zc + hz - r, Math.PI / 2],
    [-(hx - r), zc - hz + r, Math.PI],
    [hx - r, zc - hz + r, (3 * Math.PI) / 2],
  ];
  for (const [cx, cz, a0] of corners) {
    for (let i = 0; i <= 5; i++) {
      const a = a0 + (i / 5) * (Math.PI / 2);
      const x = cx + r * Math.cos(a), z = cz + r * Math.sin(a);
      pts.push(v3(x, top(x, z), z));
    }
  }
  return pts;
}

/** A Catmull-Rom curve through `p`, `k` points per span. */
function smooth(p: readonly V3[], k: number): V3[] {
  const out: V3[] = [];
  const at = (i: number): V3 => p[Math.min(p.length - 1, Math.max(0, i))];
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let j = 0; j < k; j++) {
      const t = j / k, t2 = t * t, t3 = t2 * t;
      const q = [0, 1, 2].map((a) => 0.5 * (2 * p1[a] + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3));
      out.push([q[0], q[1], q[2]]);
    }
  }
  out.push(p[p.length - 1]);
  return out;
}

/** A single-seater's flat floor from its left outline [z, x] (mirrored), its edge lit along the sides. */
function floor(mb: MeshBuilder, lb: LineBuilder, sideOut: [number, number][], y: number, k: Ink): void {
  const outline: number[] = [];
  for (const [z, x] of sideOut) outline.push(z, x);
  for (let i = sideOut.length - 1; i >= 0; i--) outline.push(sideOut[i][0], -sideOut[i][1]);
  mb.paint(k.dark);
  mb.plateY(roundPoly(outline, 0.03), y, 0.014);
  mb.paint();
  lb.polySym(sideOut.map(([z, x]) => v3(x + 0.004, y + 0.01, z)), k.strip);
}

/** Wishbones, pushrods and track rods as faint lines, both ends of the car. */
function suspension(lb: LineBuilder, v: CarVisualSpec, zF: number, zR: number, hk: number, c: RGB, era04: boolean): void {
  const xf = v.trackFront / 2 - 0.43 * v.tireWidthFront - 0.015;
  const xr = v.trackRear / 2 - 0.43 * v.tireWidthRear - 0.014;
  const loF = era04 ? v.wheelRadiusFront - 0.7 * v.rimRadiusFront : 0.17;
  const upF = era04 ? v.wheelRadiusFront + 0.7 * v.rimRadiusFront : 0.52;
  const loR = era04 ? v.wheelRadiusRear - 0.7 * v.rimRadiusRear : 0.17;
  const upR = era04 ? v.wheelRadiusRear + 0.7 * v.rimRadiusRear : 0.53;
  const rods: [V3, V3][] = [
    [[xf, loF, zF], [era04 ? 0.02 : 0.15, era04 ? 0.205 : 0.265, zF + 0.27]],
    [[xf, loF, zF], [era04 ? 0.02 : 0.17, era04 ? 0.2 : 0.25, zF - 0.28]],
    [[xf - 0.01, upF, zF - 0.02], [0.13, era04 ? 0.47 * hk : 0.5, zF + 0.24]],
    [[xf - 0.01, upF, zF - 0.02], [0.15, era04 ? 0.47 * hk : 0.5, zF - 0.26]],
    [[xr, loR, zR], [0.09, 0.2, zR + 0.3]],
    [[xr, loR, zR], [0.09, 0.22, zR - 0.22]],
    [[xr - 0.01, upR, zR - 0.02], [0.08, era04 ? 0.42 * hk : 0.44, zR + 0.28]],
    [[xr - 0.01, upR, zR - 0.02], [0.08, era04 ? 0.41 * hk : 0.43, zR - 0.22]],
  ];
  for (const [a, b] of rods) lb.polySym([v3(...a), v3(...b)], c);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dieci: the 2004 single-seater
// ─────────────────────────────────────────────────────────────────────────────

export function buildDieci(v: CarVisualSpec, mb: MeshBuilder, lb: LineBuilder, k: Ink): BodyOut {
  const zF = v.wheelbase / 2, zR = -zF;
  const zNose = zF + v.frontOverhang;
  const zTail = -(zF + (v.length - v.wheelbase - v.frontOverhang));
  const hk = v.height / 0.95;
  const { eye, sz } = cockpit(v);
  const ey = eye[1];

  // the monocoque and the high nose, one piece
  const tubR = sz - 0.55;
  const tubYt = curve([tubR, ey - 0.1, sz - 0.3, ey - 0.085, sz, ey - 0.07, sz + 0.3, ey - 0.08, sz + 0.58, ey - 0.105, zF - 0.5, 0.62 * hk, zF, 0.585 * hk, zF + 0.5, 0.48 * hk, zNose - 0.15, 0.405 * hk, zNose, 0.375 * hk]);
  const tubFrom = mb.vertexCount;
  const tub = mb.loft({
    zr: tubR,
    zf: zNose,
    yb: curve([tubR, 0.07, sz + 0.45, 0.07, zF - 0.75, 0.1, zF - 0.3, 0.22, zF + 0.05, 0.275, zF + 0.5, 0.29, zNose - 0.1, 0.29, zNose, 0.285]),
    yt: tubYt,
    w: curve([tubR, 0.27, sz, 0.285, sz + 0.55, 0.265, zF - 0.5, 0.225, zF, 0.175, zF + 0.45, 0.13, zNose - 0.15, 0.095, zNose, 0.08]),
    crown: 0.045,
    tum: 0.035,
    tumY: 0.42,
    rF: 0.06,
    rR: 0.045,
    yRef: 0.33,
  });
  const coverF = sz - 0.1, coverR = zR - 0.3;
  const cover = mb.loft({
    zr: coverR,
    zf: coverF,
    yb: curve([coverF, 0.07, zR + 0.45, 0.07, zR, 0.13, coverR, 0.2]),
    yt: curve([coverF, 0.68 * hk, sz - 0.5, 0.79 * hk, sz - 0.9, 0.76 * hk, zR + 0.5, 0.7 * hk, zR, 0.555 * hk, coverR, 0.47 * hk]),
    w: curve([coverF, 0.27, sz - 0.5, 0.25, sz - 0.9, 0.21, zR + 0.5, 0.165, zR, 0.12, coverR, 0.095]),
    crown: 0.05,
    tum: 0.08,
    tumY: 0.42,
    rF: 0.06,
    rR: 0.06,
    kr: 0.3,
    yRef: 0.4,
  });
  const boxF = sz - 0.265, boxR = sz - 1.2;
  const airbox = mb.loft({
    zr: boxR,
    zf: boxF,
    yb: flat(0.52),
    yt: curve([boxF, 0.94 * hk, sz - 0.36, 0.95 * hk, sz - 0.55, 0.94 * hk, sz - 0.8, 0.875 * hk, sz - 1.0, 0.79 * hk, boxR, 0.71 * hk]),
    w: curve([boxF, 0.115, sz - 0.45, 0.12, sz - 0.8, 0.125, boxR, 0.13]),
    crown: 0.035,
    tum: 0.02,
    tumY: 0.75,
    rF: 0.045,
    rR: 0.045,
    kf: 0.19,
    yRef: 0.75,
  });
  const podX = 0.335, podF = sz + 0.44, podR = zR + 0.25;
  const pod = mb.loft({
    zr: podR,
    zf: podF,
    x: podX,
    yb: curve([podF, 0.22, sz, 0.18, zR + 1, 0.15, podR, 0.14]),
    yt: curve([podF, 0.55 * hk, sz + 0.2, 0.575 * hk, sz - 0.3, 0.565 * hk, zR + 0.95, 0.52 * hk, zR + 0.6, 0.47 * hk, zR + 0.3, 0.37 * hk, podR, 0.31 * hk]),
    w: curve([podF, 0.16, sz + 0.15, 0.163, sz - 0.45, 0.152, zR + 0.8, 0.12, zR + 0.5, 0.09, podR, 0.05]),
    crown: 0.02,
    tum: 0.05,
    tumY: 0.42,
    rF: 0.08,
    rR: 0.08,
    kf: -0.3,
    yRef: 0.35,
  });
  const gearF = zR + 0.35;
  const gearbox = mb.loft({
    zr: zTail,
    zf: gearF,
    yb: curve([gearF, 0.15, zR, 0.17, zR - 0.25, 0.25, zTail, 0.325]),
    yt: curve([gearF, 0.47 * hk, zR, 0.45 * hk, zR - 0.3, 0.45 * hk, zTail, 0.49 * hk]),
    w: curve([gearF, 0.13, zR, 0.11, zR - 0.25, 0.08, zTail, 0.065]),
    crown: 0.015,
    rF: 0.03,
    rR: 0.02,
  });
  // the cockpit opening
  const wellZ = sz + 0.19;
  const inWell = (x: number, z: number) => {
    const dx = Math.max(0, Math.abs(x) - (0.2 - 0.13)), dz = Math.max(0, Math.abs(z - wellZ) - (0.39 - 0.13));
    return Math.hypot(dx, dz) < 0.13;
  };
  mb.recolor(tubFrom, mb.vertexCount, (x, y, z) => y > 0.5 && inWell(x, z), k.dark);
  lb.poly(wellOutline(wellZ, 0.2, 0.39, 0.13, (x, z) => tubYt(z) - 0.045 * (x / 0.28) ** 2 + 0.012), k.B, true);

  // the periscopes: stacks on the sidepods' tops, their mouths glowing
  const per = { at: [0.25, 0.585 * hk, zR + 0.6] as V3, dir: new THREE.Vector3(0.12, 0.77, -0.63).normalize() };
  mb.paint();
  for (const sg of [1, -1]) {
    const at = v3(sg * per.at[0], per.at[1], per.at[2]);
    const d = per.dir.clone().setX(sg * per.dir.x);
    const base = at.clone().addScaledVector(d, -0.2);
    mb.tube([[base.x, base.y, base.z], [at.x, at.y, at.z]], (t) => 0.075 - 0.013 * t, 12);
    mb.lamp(k.exhaust);
    const mouth = at.clone().addScaledVector(d, 0.002);
    mb.ring([mouth.x, mouth.y, mouth.z], [d.x, d.y, d.z], 0.03, 0.058, 16);
    mb.paint();
  }

  // edges
  lb.loftLine(mb, tub, 40, k.A, tubR + 0.1, zNose);
  lb.loftLine(mb, tub, 320, k.a, zF - 0.6, zNose);
  lb.loftLine(mb, cover, 50, k.A, coverR, sz - 0.5);
  lb.loftLine(mb, airbox, 90, k.B);
  lb.loftLine(mb, airbox, 30, k.a);
  lb.loftLine(mb, pod, 50, k.A);
  lb.loftLine(mb, pod, 320, k.a);
  lb.loftRing(mb, pod, podF - 0.02, k.B);
  lb.loftLine(mb, gearbox, 40, k.a);
  // the airbox's mouth over the driver's head, framed
  {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      const y = 0.8 * hk + 0.09 * Math.sin(a);
      pts.push(v3(0.065 * Math.cos(a), y, boxF + 0.19 * (y - 0.75) + 0.008));
    }
    mb.paint(k.dark);
    mb.ellipsoid([0, 0.8 * hk, boxF - 0.01], 0.06, 0.085, 0.03, 12, 6);
    mb.paint();
    lb.poly(pts, k.B);
  }

  // the helmet, its visor glowing
  mb.paint([0.03, 0.026, 0.06]);
  mb.ellipsoid([eye[0], eye[1] - 0.03, eye[2] - 0.07], 0.11, 0.125, 0.14, 14, 8);
  mb.lamp(k.visor);
  mb.box([0, eye[1] - 0.005, eye[2] + 0.06], 0.07, 0.013, 0.012);
  mb.paint();

  // the front wing hung under the high nose: the spoon mainplane, two flaps a side, big end plates, two pylons
  const fMain: Section[] = [-0.688, -0.56, -0.43, -0.31, -0.24, -0.17, -0.09, 0, 0.09, 0.17, 0.24, 0.31, 0.43, 0.56, 0.688].map((x) => {
    const ax = Math.abs(x);
    const u = Math.min(1, Math.max(0, (ax - 0.12) / 0.19));
    const t = u * u * (3 - 2 * u);
    return { x, y: 0.072 + 0.056 * t + (0.008 * Math.max(0, ax - 0.31)) / 0.38, z: zNose - 0.083 - 0.06 * t, chord: 0.25 + 0.05 * t, inc: -0.04 - 0.06 * t };
  });
  const fm = mb.element(fMain, 0.08, 0.05);
  wingLines(lb, fm, k.A, null);
  for (const sg of [1, -1]) {
    const [f1, f2] = flapsOver(fMain, sg, [0.29, 0.4, 0.52, 0.63, 0.688], 0.15, -0.4, 0.11, -0.72, 0.04, 0.4, 0.288, 1.4, 0.022, 0.5);
    const e1 = mb.element(f1, 0.09, 0.05);
    const e2 = mb.element(f2, 0.09, 0.05);
    wingLines(lb, e1, k.a, null);
    wingLines(lb, e2, k.d, k.B);
  }
  const fe = roundPoly([zNose - 0.045, 0.115, zNose - 0.06, 0.245, zNose - 0.2, 0.315, zNose - 0.44, 0.322, zNose - 0.565, 0.275, zNose - 0.565, 0.115], [0.01, 0.04, 0.06, 0.04, 0.02, 0.01]);
  const fep = plates(mb, fe, 0.694, 0.012);
  plateLines(lb, fep.l, k.A, false, true);
  plateLines(lb, fep.r, k.A, false, true);
  const py = plates(mb, roundPoly([zNose - 0.085, 0.08, zNose - 0.07, 0.315, zNose - 0.235, 0.315, zNose - 0.255, 0.08], 0.012), 0.065, 0.01);
  lb.poly([py.l.front[0], py.l.front[Math.floor(py.l.front.length * 0.3)]].map((p) => p.clone()), k.d);
  lb.poly([py.r.back[0], py.r.back[Math.floor(py.r.back.length * 0.3)]].map((p) => p.clone()), k.d);

  // bargeboards between the front wheels and the sidepods
  {
    const ey0 = v.rideHeight + 0.016;
    const bb = roundPoly([zF - 0.4, ey0, zF - 0.4, ey0 + 0.07, zF - 0.6, 0.24 * hk, zF - 0.85, 0.33 * hk, zF - 1.05, 0.31 * hk, zF - 1.14, 0.21 * hk, zF - 1.14, ey0], [0, 0.02, 0.05, 0.05, 0.03, 0.02, 0], 2);
    const b = plates(mb, bb, 0.47, 0.008);
    plateLines(lb, b.l, k.a, false);
    plateLines(lb, { front: b.r.back, back: b.r.front }, k.a, false);
  }

  // rear wing: two elements between big flat end plates, and the beam wing under them
  {
    const xs = [-0.494, -0.3, 0, 0.3, 0.494];
    const main: Section[] = xs.map((x) => ({ x, y: 0.71 * hk, z: zR - 0.19, chord: 0.24, inc: -0.12 }));
    const flap: Section[] = main.map((m) => {
      const e = edges(m);
      const a: Section = { x: m.x, y: 0, z: 0, chord: 0.15, inc: -0.6 };
      const ea = edges(a);
      a.z = e.te[0] + 0.012 - ea.le[0];
      a.y = e.te[1] + 0.013 - ea.le[1];
      return a;
    });
    const em = mb.element(main, 0.1, 0.06);
    const ef = mb.element(flap, 0.1, 0.06);
    wingLines(lb, em, k.A, null);
    wingLines(lb, ef, k.a, k.B);
    const beam = mb.element([-0.488, -0.36, -0.2, 0, 0.2, 0.36, 0.488].map((x) => {
      const u = Math.abs(x) / 0.488;
      return { x, y: (0.41 + 0.04 * u * u) * hk, z: zR - 0.11, chord: 0.2, inc: -0.16 };
    }), 0.1, 0.05);
    wingLines(lb, beam, k.B, null);
    const zb = zTail - 0.008;
    const ep = roundPoly([zR - 0.07, 0.3 * hk, zR - 0.07, 0.775 * hk, zR - 0.13, 0.845 * hk, zb, 0.845 * hk, zb, 0.3 * hk], [0.02, 0.03, 0.02, 0.02, 0.02]);
    const e = plates(mb, ep, 0.5, 0.012);
    plateLines(lb, e.l, k.A, false, true);
    plateLines(lb, e.r, k.A, false, true);
  }

  // the floor and its diffuser, the suspension
  {
    const sideOut: [number, number][] = [[zF - 0.33, 0.26], [zF - 0.45, 0.45], [zF - 0.7, 0.58], [zF - 1.0, 0.64], [zR + 0.85, 0.64], [zR + 0.55, 0.56], [zR + 0.4, 0.5], [zR + 0.33, 0.48]];
    floor(mb, lb, sideOut, v.rideHeight + 0.009, k);
  }
  suspension(lb, v, zF, zR, hk, k.d, true);

  // lights: the LED lamps in the nose's tip, the rain light (the car's only rear light)
  mb.lamp(k.head);
  lampSym(mb, [0.052, 0.335 * hk, zNose - 0.025], 0.016, 0.01, 0.012);
  mb.lamp(k.tail, GLOW.brake);
  mb.box([0, v.rideHeight + 0.355, zTail - 0.006], 0.05, 0.022, 0.008);
  mb.paint();
  return { movers: [] };
}
