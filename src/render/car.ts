/**
 * The neon cars' 3D view: the LMP-X, the Volta and the Dieci as dark bodies with glowing edges and light strips, in Neon-Flight's
 * look, on the silhouettes of Xeno-Racer's models (src/render/car-bodies.ts).
 *
 *   const view = new CarView(def);            // or new CarView(def, { ghost: true })
 *   scene.add(view.object);
 *   view.update(vehicleState, dt);             // every rendered frame
 *   view.dispose();
 *
 * What it draws, per car: one merged body mesh (body, lamps, helmet, wings: one shared shader), one fat-line object with every neon
 * edge, four wheels (each one mesh: tyre, rim, glowing lip, spokes), and a soft additive pool of light under the car; the Volta adds
 * its two moving flaps (a mesh and a line object each). update() only moves objects and sets uniforms: no buffer is ever rewritten
 * after the build (Neon-Flight's lesson: a buffer upload a frame stalled Intel/ANGLE for about 7 ms). The geometry of a car is built
 * once and shared by every view of it (a player and a ghost of the same car share it).
 *
 * The ghost (opts.ghost): one pale colour, additive and faint, after a depth-only pass so it reads as a solid hologram; nothing in it
 * reaches the bloom threshold, and it fades further when it is right in front of the camera.
 *
 * Frames: the pose is the physics' centre of mass and orientation (car frame +Z forward, +Y up, +X LEFT). The model is built in the
 * body frame (origin on the ground between the axles and between the wheels), where the centre of mass is (0, cgHeight, bodyCgZ),
 * so the body sits at -that from the pose. Wheels: chassis * rotY(steerAngle) * rotX(spin); their hubs ride up and down with
 * `compression` (0 fully extended .. 1 bump stop; at rest the physics sits at 0.38 of the travel, where the body's wheels are drawn).
 */
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import type { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { bodyCgZ, type CarDefinition } from '../core/contracts';
import { buildDieci, buildLmp, buildVolta, inkFor, styleFor, type Ink } from './car-bodies';
import { LineBuilder, MeshBuilder, neon } from './car-geom';
import { carMaterial, depthOnlyMaterial, lineMaterial, underglowMaterial, type CarUniforms } from './car-material';
import { wheelGeometry } from './car-wheel';

/** What the view needs from a car each frame. VehicleState (src/core/contracts.ts) satisfies it; so will a ghost replay frame. */
export interface CarPose {
  /** the centre of mass, world (VehicleState.position) */
  position: THREE.Vector3;
  /** car frame -> world (+Z forward, +Y up, +X LEFT) */
  quaternion: THREE.Quaternion;
  /** 0..1, brake lights */
  brake: number;
  /** the Volta's flaps, 0 corner mode .. 1 straight mode */
  aeroOpen?: number;
  /** 0 FL, 1 FR, 2 RL, 3 RR; see the conventions in contracts.ts */
  wheels: ReadonlyArray<{ steerAngle: number; spin: number; compression?: number }>;
}

/** The physics' static sag: the share of the travel the suspension sits at, at rest (src/physics/vehicle.ts STATIC_SAG). */
const STATIC_SAG = 0.38;
/** The ghost's colour: a pale violet-white, clearly not a car's own neon. */
export const GHOST_COLOR = 0xc9bcff;
/** Spokes show up to this wheel speed (rad/s) and are gone (a faint disc instead) from the second: at 60 fps a five-spoke wheel
 * strobes once it turns more than a tenth of a turn a frame (38 rad/s). */
/** The edge lines' width: this much of the car (m) on the screen, within these many drawn pixels per 1000 of height (onBeforeRender). */
const LINE_WIDTH_M = 0.012;
const LINE_MIN_PX = 1.7;
const LINE_MAX_PX = 3.4;
const SPOKES_CLEAR = 18;
const SPOKES_GONE = 34;

interface WheelAsset {
  geometry: THREE.BufferGeometry;
  /** hub at rest, body frame */
  hub: THREE.Vector3;
  travel: number;
}

interface MoverAsset {
  name: string;
  pivot: THREE.Vector3;
  axis: THREE.Vector3;
  angle: number;
  geometry: THREE.BufferGeometry;
  lines: LineSegmentsGeometry;
}

/** Everything built for one car, shared by its views. */
interface CarAssets {
  body: THREE.BufferGeometry;
  lines: LineSegmentsGeometry;
  wheels: WheelAsset[];
  movers: MoverAsset[];
  underglow: THREE.PlaneGeometry;
  ink: Ink;
  accent: THREE.Color;
  users: number;
}

const cache = new Map<string, CarAssets>();

function buildAssets(def: CarDefinition): CarAssets {
  const v = def.visual;
  const st = styleFor(def.id);
  const ink = inkFor(st);
  const mb = new MeshBuilder(ink.body);
  const lb = new LineBuilder();
  const builder = v.style === 'formula' ? (v.formulaEra === 2004 ? buildDieci : buildVolta) : buildLmp;
  const out = builder(v, mb, lb, ink);
  const body = mb.build();
  const lines = lb.build();

  const look = {
    tyre: [0.012, 0.011, 0.02] as const,
    rim: [0.02, 0.018, 0.04] as const,
    glow: neon(st.accent, 1.0),
    soft: neon(st.accent, 0.22),
    hub: neon(0xffffff, 0.55),
  };
  const wheels: WheelAsset[] = [];
  for (let i = 0; i < 4; i++) {
    const front = i < 2;
    const left = i % 2 === 0;
    const r = front ? v.wheelRadiusFront : v.wheelRadiusRear;
    const rim = front ? v.rimRadiusFront : v.rimRadiusRear;
    const w = front ? v.tireWidthFront : v.tireWidthRear;
    const track = front ? v.trackFront : v.trackRear;
    const susp = front ? def.physics.suspFront : def.physics.suspRear;
    wheels.push({
      geometry: wheelGeometry(r, rim, w, left ? 1 : -1, look),
      hub: new THREE.Vector3((left ? 1 : -1) * (track / 2), r, (front ? 1 : -1) * (v.wheelbase / 2)),
      travel: susp?.travel ?? 0.06,
    });
  }

  const movers: MoverAsset[] = out.movers.map((m) => {
    const g = m.mb.build();
    g.translate(-m.pivot.x, -m.pivot.y, -m.pivot.z);
    const l = m.lb.build();
    l.applyMatrix4(new THREE.Matrix4().makeTranslation(-m.pivot.x, -m.pivot.y, -m.pivot.z));
    return { name: m.name, pivot: m.pivot, axis: m.axis, angle: m.angle, geometry: g, lines: l };
  });

  // the pool of light under the car: a little wider than the track, a little longer than the wheelbase
  const ug = new THREE.PlaneGeometry(Math.max(v.trackFront, v.trackRear) + 0.9, v.wheelbase + 1.6);
  ug.rotateX(-Math.PI / 2);

  return { body, lines, wheels, movers, underglow: ug, ink, accent: new THREE.Color(st.accent), users: 0 };
}

function acquire(def: CarDefinition): CarAssets {
  let a = cache.get(def.id);
  if (!a) {
    a = buildAssets(def);
    cache.set(def.id, a);
  }
  a.users++;
  return a;
}

function release(def: CarDefinition, a: CarAssets): void {
  a.users--;
  if (a.users > 0 || cache.get(def.id) !== a) return;
  cache.delete(def.id);
  a.body.dispose();
  a.lines.dispose();
  a.underglow.dispose();
  for (const w of a.wheels) w.geometry.dispose();
  for (const m of a.movers) {
    m.geometry.dispose();
    m.lines.dispose();
  }
}

const _q = new THREE.Quaternion();
const _ax = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _vp = new THREE.Vector4();
const _vc = new THREE.Vector4();
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);

interface WheelNode {
  /** steers (about y), rides with the suspension */
  pivot: THREE.Object3D;
  /** spins (about x) */
  spinner: THREE.Mesh;
  asset: WheelAsset;
  lastSpin: number | null;
}

export class CarView {
  /** Add this to the scene; it follows the pose. */
  readonly object = new THREE.Group();
  /** The body frame (origin on the ground between the axles), offset from the centre of mass. */
  private readonly body = new THREE.Group();
  private readonly assets: CarAssets;
  private readonly material: THREE.ShaderMaterial & { uniforms: CarUniforms };
  private readonly lineMat: LineMaterial;
  /** the moving flaps' edges: their own copy of the line material, brightening as the flaps open (a DRS cue from the chase camera) */
  private readonly moverLineMat: LineMaterial;
  private readonly extraMaterials: THREE.Material[] = [];
  private readonly wheels: WheelNode[] = [];
  private readonly movers: { node: THREE.Object3D; asset: MoverAsset }[] = [];
  private readonly ghost: boolean;
  private spokeSpeed = 0;
  private aero = 0;
  private disposed = false;

  constructor(readonly def: CarDefinition, opts: { ghost?: boolean } = {}) {
    this.ghost = !!opts.ghost;
    const a = (this.assets = acquire(def));
    const v = def.visual;
    const ghostColor = this.ghost ? new THREE.Color(GHOST_COLOR) : null;
    this.object.name = `car:${def.id}${this.ghost ? ':ghost' : ''}`;
    this.body.position.set(0, -v.cgHeight, -bodyCgZ({ wheelbase: v.wheelbase, cgToFrontAxle: v.cgToFrontAxle }));
    this.object.add(this.body);

    this.material = carMaterial({ rim: new THREE.Color(...neon(a.accent.getHex(), 0.035)), ghost: ghostColor });
    this.lineMat = lineMaterial({ ghost: ghostColor });
    this.moverLineMat = lineMaterial({ ghost: ghostColor });

    const bodyMesh = new THREE.Mesh(a.body, this.material);
    bodyMesh.name = 'body';
    this.body.add(bodyMesh);
    const lines = new LineSegments2(a.lines, this.lineMat);
    lines.name = 'edges';
    this.body.add(lines);

    if (this.ghost) {
      // depth first (after the opaque world), then the additive colour over it; the lines are drawn last
      const depth = depthOnlyMaterial();
      this.extraMaterials.push(depth);
      const pre = new THREE.Mesh(a.body, depth);
      pre.name = 'ghost-depth';
      pre.renderOrder = 10;
      this.body.add(pre);
      bodyMesh.renderOrder = 11;
      lines.renderOrder = 12;
    } else {
      const ugMat = underglowMaterial(a.accent.clone().multiplyScalar(0.14));
      this.extraMaterials.push(ugMat);
      const ug = new THREE.Mesh(a.underglow, ugMat);
      ug.name = 'underglow';
      ug.position.set(0, 0.02, 0);
      this.body.add(ug);
    }

    for (const w of a.wheels) {
      const pivot = new THREE.Object3D();
      pivot.position.copy(w.hub);
      const spinner = new THREE.Mesh(w.geometry, this.material);
      spinner.name = 'wheel';
      if (this.ghost) spinner.renderOrder = 11;
      pivot.add(spinner);
      this.body.add(pivot);
      this.wheels.push({ pivot, spinner, asset: w, lastSpin: null });
    }
    for (const m of a.movers) {
      const node = new THREE.Object3D();
      node.position.copy(m.pivot);
      const mesh = new THREE.Mesh(m.geometry, this.material);
      mesh.name = m.name;
      const l = new LineSegments2(m.lines, this.moverLineMat);
      l.name = `${m.name}-edges`;
      if (this.ghost) {
        mesh.renderOrder = 11;
        l.renderOrder = 12;
      }
      node.add(mesh, l);
      this.body.add(node);
      this.movers.push({ node, asset: m });
    }

    // per draw: the line width, and the ghost's fade when it is close to the camera.
    // The width follows the car's size on the screen: about 1.2 cm of car, so the lines stay fine from the chase camera (where a car
    // full of thick lines blurs into one glow) and fuller on the car-select turntable; never under LINE_MIN_PX drawn pixels per 1000
    // of height. Drawn pixels, because LineMaterial counts its width in the canvas's CSS pixels (LineSegments2 sets its resolution
    // from getViewport) while the quality levels draw at 0.6 to 1.5 of the CSS size: a line under one drawn pixel breaks into dashes,
    // and a thin one pulses across the bloom threshold as it crosses pixel rows (its glow beads along a shallow slope).
    bodyMesh.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getCurrentViewport(_vp);
      renderer.getViewport(_vc);
      const drawnH = Math.max(1, _vp.w);
      const ratio = drawnH / Math.max(1, _vc.w);
      const d = Math.max(0.5, camera.getWorldPosition(_v).distanceTo(this.object.getWorldPosition(_w)));
      const fov = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? (camera as THREE.PerspectiveCamera).fov : 60;
      const pxPerMetre = drawnH / (2 * d * Math.tan((fov * Math.PI) / 360));
      const minPx = LINE_MIN_PX * Math.max(1, drawnH / 1000);
      const drawnWidth = Math.max(minPx, Math.min(LINE_MAX_PX * Math.max(1, drawnH / 1000), LINE_WIDTH_M * pxPerMetre));
      this.lineMat.linewidth = drawnWidth / ratio;
      this.moverLineMat.linewidth = this.lineMat.linewidth;
      if (this.ghost) {
        const near = THREE.MathUtils.smoothstep(d, 2.5, 9);
        const o = 0.3 + 0.7 * near;
        this.material.uniforms.uOpacity.value = o;
        this.lineMat.opacity = 0.75 * o;
        this.moverLineMat.opacity = this.lineMat.opacity;
      }
    };
  }

  /** How many draw calls the car costs (renderable objects), for the HUD or a test. */
  get drawCalls(): number {
    let n = 0;
    this.object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.visible) n++;
    });
    return n;
  }

  /** Pose the car: call once per rendered frame. */
  update(pose: CarPose, dt: number): void {
    this.object.position.copy(pose.position);
    this.object.quaternion.copy(pose.quaternion);
    const u = this.material.uniforms;
    // the tail lights glow always, the brake lights much brighter when braking
    const b = Math.min(1, Math.max(0, pose.brake));
    u.uBrake.value = 0.55 + 1.05 * b;

    let fastest = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      const p = pose.wheels[i];
      if (!p) continue;
      const c = p.compression;
      w.pivot.position.y = w.asset.hub.y + (c === undefined ? 0 : (c - STATIC_SAG) * w.asset.travel);
      w.pivot.quaternion.setFromAxisAngle(Y, p.steerAngle);
      w.spinner.quaternion.setFromAxisAngle(X, p.spin);
      if (w.lastSpin !== null && dt > 1e-4) fastest = Math.max(fastest, Math.abs(p.spin - w.lastSpin) / dt);
      w.lastSpin = p.spin;
    }
    // spokes fade into the blur disc at speed (smoothed, so a dropped frame does not flash them)
    const k = dt > 0 ? 1 - Math.exp(-dt * 8) : 1;
    this.spokeSpeed += (fastest - this.spokeSpeed) * k;
    const blur = THREE.MathUtils.smoothstep(this.spokeSpeed, SPOKES_CLEAR, SPOKES_GONE);
    u.uSpoke.value = 1 - blur;
    u.uBlur.value = blur;

    // the Volta's flaps turn open on the straights (follow at the actuator's pace)
    const target = Math.min(1, Math.max(0, pose.aeroOpen ?? 0));
    this.aero += (target - this.aero) * (dt > 0 ? 1 - Math.exp(-dt * 14) : 1);
    for (const m of this.movers) m.node.quaternion.copy(_q.setFromAxisAngle(_ax.copy(m.asset.axis), m.asset.angle * this.aero));
    if (this.movers.length && !this.ghost) this.moverLineMat.color.setScalar(1 + 0.7 * this.aero);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    this.material.dispose();
    this.lineMat.dispose();
    this.moverLineMat.dispose();
    for (const m of this.extraMaterials) m.dispose();
    release(this.def, this.assets);
  }
}
