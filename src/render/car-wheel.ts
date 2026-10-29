/**
 * A neon car's wheel: a dark tyre turned on a lathe, a recessed dark rim, and glowing parts that show it spin and steer: the rim's
 * lip, a ring on the sidewall, two bands round the tread's edges (they outline the tyre from behind), five spokes and a hub. The spokes
 * fade into a faint disc when the wheel turns too fast for the frame rate to show them (car-material.ts, uSpoke / uBlur).
 *
 * Wheel frame: the axle along x, the outer face at +x for `side` +1 (a left wheel) or at -x for -1; spin turns it about x.
 */
import * as THREE from 'three';
import { GLOW, MeshBuilder, type RGB } from './car-geom';

export interface WheelLook {
  tyre: RGB;
  rim: RGB;
  /** the lip, the spokes */
  glow: RGB;
  /** the sidewall ring and the tread bands (dimmer) */
  soft: RGB;
  hub: RGB;
}

export function wheelGeometry(radius: number, rimRadius: number, width: number, side: 1 | -1, look: WheelLook): THREE.BufferGeometry {
  const mb = new MeshBuilder(look.tyre);
  const hw = width / 2;
  const sh = Math.min(0.045, hw * 0.4);
  const M = 36;
  // the tyre's section, from the inner bead round the tread to the outer bead: (x, radius)
  const prof: [number, number][] = [[-hw + 0.01, rimRadius]];
  prof.push([-hw, rimRadius + 0.3 * (radius - sh - rimRadius)]);
  prof.push([-hw, radius - sh]);
  for (let i = 1; i < 4; i++) {
    const a = (i / 4) * (Math.PI / 2);
    prof.push([-hw + sh - sh * Math.cos(a), radius - sh + sh * Math.sin(a)]);
  }
  prof.push([-hw + sh, radius], [hw - sh, radius]);
  for (let i = 1; i < 4; i++) {
    const a = (i / 4) * (Math.PI / 2);
    prof.push([hw - sh + sh * Math.sin(a), radius - sh + sh * Math.cos(a)]);
  }
  prof.push([hw, radius - sh], [hw, rimRadius + 0.3 * (radius - sh - rimRadius)], [hw - 0.01, rimRadius]);
  lathe(mb, prof, M);

  // the rim: a dark dish recessed into each face
  const xo = hw - 0.03;
  mb.paint(look.rim);
  mb.ring([xo, 0, 0], [1, 0, 0], 0, rimRadius, M);
  mb.ring([-xo, 0, 0], [-1, 0, 0], 0, rimRadius, M);
  // inner barrel so the gap between the dish and the tyre is closed
  lathe(mb, [[xo, rimRadius], [-xo, rimRadius]], M, true);

  // glowing parts on the outer face (a hair proud of what they sit on, so they win the depth test)
  mb.lamp(look.glow);
  mb.ring([xo + 0.004, 0, 0], [1, 0, 0], rimRadius - 0.016, rimRadius - 0.003, M);
  mb.lamp(look.soft);
  const swR = rimRadius + 0.55 * (radius - rimRadius);
  mb.ring([hw + 0.003, 0, 0], [1, 0, 0], swR - 0.006, swR + 0.006, M);
  // the tread's edge bands
  for (const x of [-hw + sh * 0.7, hw - sh * 0.7]) lathe(mb, [[x - 0.007, radius + 0.003], [x + 0.007, radius + 0.003]], M);
  mb.lamp(look.hub);
  mb.ring([xo + 0.006, 0, 0], [1, 0, 0], 0, 0.022, 16);
  // the spokes, and the disc that replaces them at speed
  mb.lamp(look.glow, GLOW.spokes);
  const r0 = 0.05, r1 = rimRadius - 0.018, sw = 0.013;
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const px = xo + 0.005;
    const v = [
      mb.vert(px, r0 * c - sw * s, r0 * s + sw * c),
      mb.vert(px, r1 * c - sw * 1.4 * s, r1 * s + sw * 1.4 * c),
      mb.vert(px, r1 * c + sw * 1.4 * s, r1 * s - sw * 1.4 * c),
      mb.vert(px, r0 * c + sw * s, r0 * s - sw * c),
    ];
    const n = new THREE.Vector3(1, 0, 0);
    mb.orientedTri(v[0], v[1], v[2], n);
    mb.orientedTri(v[0], v[2], v[3], n);
  }
  mb.lamp([look.glow[0] * 0.16, look.glow[1] * 0.16, look.glow[2] * 0.16], GLOW.blur);
  mb.ring([xo + 0.0045, 0, 0], [1, 0, 0], r0, r1, M);

  if (side < 0) {
    for (let i = 0; i < mb.pos.length; i += 3) mb.pos[i] = -mb.pos[i];
    for (let i = 0; i < mb.idx.length; i += 3) {
      const t = mb.idx[i + 1];
      mb.idx[i + 1] = mb.idx[i + 2];
      mb.idx[i + 2] = t;
    }
  }
  return mb.build();
}

/** Revolve a profile of (x, radius) points about the x axis; `inward` flips the faces to face the axis. */
function lathe(mb: MeshBuilder, prof: [number, number][], M: number, inward = false): void {
  const rows: number[][] = [];
  for (const [x, r] of prof) {
    const row: number[] = [];
    for (let k = 0; k < M; k++) {
      const a = (k / M) * Math.PI * 2;
      row.push(mb.vert(x, r * Math.cos(a), r * Math.sin(a)));
    }
    rows.push(row);
  }
  for (let j = 0; j < prof.length - 1; j++) {
    const dx = prof[j + 1][0] - prof[j][0], dr = prof[j + 1][1] - prof[j][1];
    for (let k = 0; k < M; k++) {
      const a = ((k + 0.5) / M) * Math.PI * 2;
      // the section's outward normal (-dr, dx) in (x, radius), turned round the axis
      const s = inward ? -1 : 1;
      const n = new THREE.Vector3(-dr * s, dx * Math.cos(a) * s, dx * Math.sin(a) * s);
      if (n.lengthSq() < 1e-12) continue;
      const k1 = (k + 1) % M;
      mb.orientedTri(rows[j][k], rows[j][k1], rows[j + 1][k], n);
      mb.orientedTri(rows[j][k1], rows[j + 1][k1], rows[j + 1][k], n);
    }
  }
}
