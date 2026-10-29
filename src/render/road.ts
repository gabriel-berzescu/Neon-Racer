/**
 * RoadView: the stage's road as the player sees it. A very dark road surface with glowing edge lines, a dashed centre line and kerbs
 * in the corners; a paved shoulder, the run-off and a verge out to the formation's edge, with a skirt down into the terrain; barriers as dark panels with a
 * glowing top rail and posts every 4 m (they stream past at speed), amber chevron boards on the outside of the tight corners; a
 * start gantry, a gantry at every checkpoint, a finish gantry with its chequered line.
 *
 * Built once per stage (setStage), from the very surface the physics drives on (StageTrack.pointAt), in chunks of CHUNK m of road:
 * each chunk is one road mesh and one barrier mesh, sitting at the chunk's own origin (small vertex coordinates), culled by its
 * bounding sphere; two shared materials for all of them. Rows every 2 m in the tight corners, 4 m in the medium ones, 8 m on the
 * straights and sweepers (the surface is a plane across, so a row needs only the columns where its colour zones change).
 *
 * Checkpoints swap materials (setCheckpoint): three shared materials, 'ahead', 'next' (it pulses: a uniform) and 'passed'. Nothing is
 * rewritten in a buffer after setStage.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TrackFrame } from '../core/contracts';
import type { Stage } from '../world/stage';
import { FORMATION, SHOULDER, WALL, type StageTrack } from '../world/stage-track';
import { PALETTE } from './palette';
import { BARRIER_FRAG, BARRIER_VERT, NEON_FRAG, NEON_VERT, ROAD_FRAG, ROAD_VERT } from './road-shaders';
import { SKY_UNIFORMS } from './skyGlsl';

/** Metres of road per chunk. */
const CHUNK = 240;
/** The skirt below the formation's edge (m). */
const SKIRT = 1.6;
/** Columns across the road (m from the centreline, + = left). */
const COLS = [FORMATION, WALL, SHOULDER, 6, 0, -6, -SHOULDER, -WALL, -FORMATION];
/** The barrier panel starts this far below the road (it hides its foot) and its rail is 1 m up (1.6 m with chevron boards). */
const BAR_FOOT = 0.35;
/** Chevrons on the outside of corners tighter than this (m). */
const CHEVRON_R = 75;
/** The gantries: pillars this far out (m), the beam this high. */
const GANTRY_D = WALL + 1.1;
const GANTRY_H = 7.2;

export type CheckpointState = 'ahead' | 'next' | 'passed';

function frame(): TrackFrame {
  return { position: new THREE.Vector3(), tangent: new THREE.Vector3(), normal: new THREE.Vector3(), left: new THREE.Vector3(), widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0 };
}

function neon(color: THREE.ColorRepresentation, intensity: number, body = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...SKY_UNIFORMS, uColor: { value: new THREE.Color(color) }, uIntensity: { value: intensity }, uBody: { value: body ? 1 : 0 } },
    vertexShader: NEON_VERT,
    fragmentShader: NEON_FRAG,
  });
}

export class RoadView {
  readonly object = new THREE.Group();

  private readonly roadMat: THREE.ShaderMaterial;
  private readonly barrierMat: THREE.ShaderMaterial;
  private readonly bodyMat = neon(0x0b0818, 1, true);
  private readonly stateMats: Record<CheckpointState, THREE.ShaderMaterial> = {
    ahead: neon(PALETTE.cyan, 0.85),
    next: neon(PALETTE.magenta, 2.2),
    passed: neon(0x6a4cff, 0.32),
  };
  private readonly startMat = neon(PALETTE.amber, 1.6);
  private readonly finishMat = neon(0xffffff, 1.5);
  /** The glowing rail along the top of the barriers across the road's two ends. */
  private readonly endRailMat = neon(PALETTE.magenta, 1.4);
  /** Per checkpoint: the meshes whose material shows its state. */
  private gates: THREE.Mesh[][] = [];
  private stage: Stage | null = null;
  private readonly owned: THREE.BufferGeometry[] = [];

  constructor() {
    this.object.name = 'road';
    this.roadMat = new THREE.ShaderMaterial({
      uniforms: {
        ...SKY_UNIFORMS,
        uAsphalt: { value: new THREE.Color(0x0a0816) },
        uRunoff: { value: new THREE.Color(0x150a26) },
        uVerge: { value: new THREE.Color(PALETTE.ground) },
        uCyan: { value: new THREE.Color(PALETTE.cyan) },
        uMagenta: { value: new THREE.Color(PALETTE.magenta) },
        uAmber: { value: new THREE.Color(PALETTE.amber) },
        uFinish: { value: 1e9 },
        uTime: { value: 0 },
      },
      vertexShader: ROAD_VERT,
      fragmentShader: ROAD_FRAG,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    this.barrierMat = new THREE.ShaderMaterial({
      uniforms: {
        ...SKY_UNIFORMS,
        uPanel: { value: new THREE.Color(0x0d0a1c) },
        uCyan: { value: new THREE.Color(PALETTE.cyan) },
        uMagenta: { value: new THREE.Color(PALETTE.magenta) },
        uAmber: { value: new THREE.Color(PALETTE.amber) },
      },
      vertexShader: BARRIER_VERT,
      fragmentShader: BARRIER_FRAG,
      side: THREE.DoubleSide,
    });
  }

  /** Builds the road of `stage` (null: none). About 30-60 ms. */
  setStage(stage: Stage | null): void {
    this.clear();
    this.stage = stage;
    if (!stage) return;
    const tr = stage.track;
    this.roadMat.uniforms.uFinish.value = tr.length;
    const rows = this.rows(tr);
    // chunks: consecutive rows covering CHUNK m each, sharing their boundary row
    let a = 0;
    while (a < rows.length - 1) {
      const sA = tr.sStart + rows[a] * tr.spacing;
      let b = a + 1;
      while (b < rows.length - 1 && tr.sStart + rows[b] * tr.spacing < sA + CHUNK) b++;
      this.buildChunk(tr, rows.slice(a, b + 1));
      a = b;
    }
    this.buildEnds(tr);
    // the gantries
    this.buildGantry(tr, 0, 'start', -1);
    stage.checkpoints.forEach((s, i) => this.buildGantry(tr, s, i === stage.checkpoints.length - 1 ? 'finish' : 'checkpoint', i));
    for (let i = 0; i < stage.checkpoints.length; i++) this.setCheckpoint(i, i === 0 ? 'next' : 'ahead');
  }

  /** Shows checkpoint `index` (the last one is the finish) as ahead, next or passed: swaps shared materials. */
  setCheckpoint(index: number, state: CheckpointState): void {
    const g = this.gates[index];
    if (!g) return;
    for (const m of g) m.material = this.stateMats[state];
  }

  /** Call every frame before rendering. */
  update(_camera: THREE.PerspectiveCamera, timeSeconds: number): void {
    this.roadMat.uniforms.uTime.value = timeSeconds;
    this.stateMats.next.uniforms.uIntensity.value = 1.7 + 0.8 * Math.sin(timeSeconds * 5.0);
  }

  dispose(): void {
    this.clear();
    this.roadMat.dispose();
    this.barrierMat.dispose();
    this.bodyMat.dispose();
    for (const m of Object.values(this.stateMats)) m.dispose();
    this.startMat.dispose();
    this.finishMat.dispose();
    this.endRailMat.dispose();
  }

  private clear(): void {
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    this.object.clear();
    this.gates = [];
    this.stage = null;
  }

  /** The internal samples that get a row: every one in tight corners, every 2nd in medium ones, every 4th elsewhere. */
  private rows(tr: StageTrack): number[] {
    const n = tr.nAll;
    const rows = [0];
    let e = 0;
    const kAt = (i: number): number => Math.abs(tr.KAP[Math.max(0, Math.min(n - 1, i))]);
    while (e < n - 1) {
      let k = 0;
      for (let i = e - 1; i <= e + 4; i++) k = Math.max(k, kAt(i));
      const step = k > 1 / 160 ? 1 : k > 1 / 900 ? 2 : 4;
      e = Math.min(n - 1, e + step);
      rows.push(e);
    }
    return rows;
  }

  private buildChunk(tr: StageTrack, rows: number[]): void {
    const p = new THREE.Vector3();
    const o = new THREE.Vector3();
    tr.pointAt(tr.sStart + rows[0] * tr.spacing, 0, o);
    const nc = COLS.length + 2; // + the two skirt vertices
    const nr = rows.length;
    // ── the road surface
    {
      const pos = new Float32Array(nr * nc * 3);
      const nor = new Float32Array(nr * nc * 3);
      const att = new Float32Array(nr * nc * 3);
      const fr = frame();
      for (let r = 0; r < nr; r++) {
        const e = rows[r];
        const s = tr.sStart + e * tr.spacing;
        tr.frameAt(s, fr);
        const kap = tr.KAP[e];
        for (let c = 0; c < nc; c++) {
          // column 0 and nc - 1 are the skirts (below the formation's edges)
          const cc = c === 0 ? 0 : c === nc - 1 ? COLS.length - 1 : c - 1;
          const d = COLS[cc];
          tr.pointAt(s, d, p);
          let dd = d;
          if (c === 0 || c === nc - 1) {
            p.y -= SKIRT;
            dd = d > 0 ? FORMATION + 1 : -FORMATION - 1;
          }
          const k = (r * nc + c) * 3;
          pos[k] = p.x - o.x;
          pos[k + 1] = p.y - o.y;
          pos[k + 2] = p.z - o.z;
          nor[k] = fr.normal.x;
          nor[k + 1] = fr.normal.y;
          nor[k + 2] = fr.normal.z;
          att[k] = s;
          att[k + 1] = dd;
          att[k + 2] = kap;
        }
      }
      const idx: number[] = [];
      for (let r = 0; r + 1 < nr; r++) {
        for (let c = 0; c + 1 < nc; c++) {
          const a = r * nc + c;
          const b = a + 1;
          const a2 = a + nc;
          const b2 = b + nc;
          // columns run from left (+d) to right: (a, a2, b) is counter-clockwise seen from above when travelling forwards
          idx.push(a, b, a2, b, b2, a2);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('aRoad', new THREE.BufferAttribute(att, 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, this.roadMat);
      m.position.copy(o);
      m.name = 'road-chunk';
      this.owned.push(g);
      this.object.add(m);
    }
    // ── the barriers: a vertical ribbon on each side
    {
      const pos = new Float32Array(nr * 4 * 3);
      const att = new Float32Array(nr * 4 * 4);
      for (let r = 0; r < nr; r++) {
        const e = rows[r];
        const s = tr.sStart + e * tr.spacing;
        const kap = this.smoothKappa(tr, e);
        for (let side = 0; side < 2; side++) {
          const sg = side === 0 ? 1 : -1;
          // chevrons on the outside: the right barrier of a left turn (kappa > 0), the left one of a right turn
          const outside = sg * kap < 0;
          const ch = outside ? THREE.MathUtils.smoothstep(Math.abs(kap), 1 / (CHEVRON_R * 1.3), 1 / CHEVRON_R) : 0;
          const top = 1.0 + 0.6 * ch;
          tr.pointAt(s, sg * WALL, p);
          for (let v = 0; v < 2; v++) {
            const k = r * 4 + side * 2 + v;
            const hh = v === 0 ? -BAR_FOOT : top;
            pos[k * 3] = p.x - o.x;
            pos[k * 3 + 1] = p.y + hh - o.y;
            pos[k * 3 + 2] = p.z - o.z;
            att[k * 4] = s;
            att[k * 4 + 1] = hh;
            att[k * 4 + 2] = ch * Math.sign(kap);
            att[k * 4 + 3] = sg;
          }
        }
      }
      const idx: number[] = [];
      for (let r = 0; r + 1 < nr; r++) {
        for (let side = 0; side < 2; side++) {
          const a = r * 4 + side * 2;
          const b = a + 1;
          const a2 = a + 4;
          const b2 = b + 4;
          idx.push(a, a2, b, b, a2, b2);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aBar', new THREE.BufferAttribute(att, 4));
      g.setIndex(idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, this.barrierMat);
      m.position.copy(o);
      m.name = 'barrier-chunk';
      this.owned.push(g);
      this.object.add(m);
    }
  }

  /** Curvature at sample e, the largest within 30 m (so a corner's chevrons start before it and end after it). */
  private smoothKappa(tr: StageTrack, e: number): number {
    let best = 0;
    for (let i = Math.max(0, e - 15); i <= Math.min(tr.nAll - 1, e + 15); i++) if (Math.abs(tr.KAP[i]) > Math.abs(best)) best = tr.KAP[i];
    return best;
  }

  /** The barriers across both ends of the road (behind the grid, at the end of the run-out): a dark body with a glowing rail on top. */
  private buildEnds(tr: StageTrack): void {
    for (const s of [tr.sStart, tr.sEnd]) {
      const fr = frame();
      tr.frameAt(s, fr);
      const up = new THREE.Vector3(0, 1, 0);
      const left = new THREE.Vector3(fr.left.x, 0, fr.left.z).normalize();
      const m = new THREE.Matrix4().makeBasis(left, up, new THREE.Vector3().crossVectors(left, up));
      for (const [h, y, mat] of [[1.4, 0.5, this.bodyMat], [0.08, 1.24, this.endRailMat]] as const) {
        const g = new THREE.BoxGeometry(2 * WALL, h, h > 1 ? 0.4 : 0.44);
        m.setPosition(fr.position.x, fr.position.y + y, fr.position.z);
        g.applyMatrix4(m);
        g.computeBoundingSphere();
        this.owned.push(g);
        this.object.add(new THREE.Mesh(g, mat));
      }
    }
  }

  /**
   * A gantry over the road at s: two pillars and a beam (dark bodies) with neon on their road-facing edges, and a glowing line across
   * the road. `index` >= 0: a checkpoint (its neon shows its state; the finish also has a chequered banner and line).
   */
  private buildGantry(tr: StageTrack, s: number, kind: 'start' | 'checkpoint' | 'finish', index: number): void {
    const fr = frame();
    tr.frameAt(s, fr);
    const up = new THREE.Vector3(0, 1, 0);
    const left = new THREE.Vector3(fr.left.x, 0, fr.left.z).normalize();
    const fwd = new THREE.Vector3().crossVectors(left, up); // (left x up = forward)
    const pL = tr.pointAt(s, GANTRY_D, new THREE.Vector3());
    const pR = tr.pointAt(s, -GANTRY_D, new THREE.Vector3());
    const top = Math.max(pL.y, pR.y) + GANTRY_H;
    const centre = new THREE.Vector3((pL.x + pR.x) / 2, top, (pL.z + pR.z) / 2);
    const place = (g: THREE.BufferGeometry, at: THREE.Vector3): THREE.BufferGeometry => {
      const m = new THREE.Matrix4().makeBasis(left, up, fwd);
      m.setPosition(at);
      return g.applyMatrix4(m);
    };
    const big = kind === 'finish' ? 1.25 : 1;
    const span = 2 * GANTRY_D;
    const bodies: THREE.BufferGeometry[] = [];
    const glows: THREE.BufferGeometry[] = [];
    for (const [p, sg] of [[pL, 1], [pR, -1]] as const) {
      const h = top - p.y + 0.6;
      bodies.push(place(new THREE.BoxGeometry(0.8 * big, h, 0.8 * big), new THREE.Vector3(p.x, p.y - 0.6 + h / 2, p.z)));
      // a neon strip down the pillar's face towards the road, and one on its front
      const inner = new THREE.Vector3(p.x, p.y + h / 2 - 0.6, p.z).addScaledVector(left, -sg * 0.42 * big);
      glows.push(place(new THREE.BoxGeometry(0.06, h - 0.4, 0.5 * big), inner));
      glows.push(place(new THREE.BoxGeometry(0.5 * big, h - 0.4, 0.06), new THREE.Vector3(p.x, p.y + h / 2 - 0.6, p.z).addScaledVector(fwd, -0.42 * big)));
    }
    const beamH = 1.1 * big;
    bodies.push(place(new THREE.BoxGeometry(span + 0.8, beamH, 0.7), centre));
    // the beam's neon outline (front face) and its underside
    const fz = -0.37;
    const c0 = centre.clone().addScaledVector(fwd, fz);
    glows.push(place(new THREE.BoxGeometry(span + 0.8, 0.09, 0.05), c0.clone().addScaledVector(up, beamH / 2 - 0.05)));
    glows.push(place(new THREE.BoxGeometry(span + 0.8, 0.09, 0.05), c0.clone().addScaledVector(up, -beamH / 2 + 0.05)));
    glows.push(place(new THREE.BoxGeometry(span - 1.2, 0.05, 0.5), centre.clone().addScaledVector(up, -beamH / 2 - 0.03)));
    // a row of lamps along the beam
    const lamps = kind === 'finish' ? 12 : 8;
    for (let k = 0; k < lamps; k++) {
      const x = (k - (lamps - 1) / 2) * ((span - 3) / (lamps - 1));
      glows.push(place(new THREE.BoxGeometry(0.42, 0.42, 0.06), c0.clone().addScaledVector(left, x).addScaledVector(fwd, -0.01)));
    }
    // the line across the road (a thin slab on the surface)
    const line = this.lineAcross(tr, s, kind === 'finish' ? 0.5 : 0.35);

    const body = mergeGeometries(bodies)!;
    const glow = mergeGeometries(glows)!;
    for (const g of [...bodies, ...glows]) g.dispose();
    body.computeBoundingSphere();
    glow.computeBoundingSphere();
    this.owned.push(body, glow, line);
    this.object.add(new THREE.Mesh(body, this.bodyMat));
    const glowMesh = new THREE.Mesh(glow, kind === 'start' ? this.startMat : this.stateMats.ahead);
    const lineMesh = new THREE.Mesh(line, kind === 'start' ? this.startMat : this.stateMats.ahead);
    this.object.add(glowMesh, lineMesh);
    if (kind === 'finish') {
      // a chequered banner hanging under the beam
      const banner = this.chequer(span - 2, 1.0, 8);
      place(banner, centre.clone().addScaledVector(up, -beamH / 2 - 0.62).addScaledVector(fwd, -0.38));
      banner.computeBoundingSphere();
      this.owned.push(banner);
      this.object.add(new THREE.Mesh(banner, this.finishMat));
    }
    if (index >= 0) this.gates[index] = [glowMesh, lineMesh];
  }

  /** A thin glowing band across the road at s, `w` m long (along the road), lifted a little off the surface. */
  private lineAcross(tr: StageTrack, s: number, w: number): THREE.BufferGeometry {
    const pos: number[] = [];
    const p = new THREE.Vector3();
    const n = 8;
    for (let k = 0; k <= n; k++) {
      const d = WALL - (2 * WALL * k) / n;
      for (const ds of [-w / 2, w / 2]) {
        tr.pointAt(s + ds, d, p);
        pos.push(p.x, p.y + 0.025, p.z);
      }
    }
    const idx: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }

  /** A chequered panel (w x h m, `rows` squares high) as separate white squares (the gaps are the dark beam behind). */
  private chequer(w: number, h: number, cols: number): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const sq = h / 2;
    const n = Math.round(w / sq);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 2; j++) {
        if ((i + j) % 2) continue;
        const g = new THREE.PlaneGeometry(sq * 0.96, sq * 0.96);
        g.rotateY(Math.PI);
        g.translate((i - (n - 1) / 2) * sq, (j - 0.5) * sq, 0);
        parts.push(g);
      }
    }
    void cols;
    const out = mergeGeometries(parts)!;
    for (const g of parts) g.dispose();
    return out;
  }
}
