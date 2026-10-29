/**
 * Road sandbox: one stage with the terrain, the road and the sky, seen from a car's height or from above.
 *
 *   ?seed=12345          the stage (default 12345)
 *   ?s=0                 start this far along the road (m; negative: on the grid)
 *   ?cam=chase           car: 1.1 m up, on the lane | chase: 2.6 m up, 7.5 m behind (default) | high: 6 m up, 15 m behind |
 *                        drone: 120 m up, 160 m behind | over: an oblique view of the whole stage | top: straight down on it |
 *                        free: fly (mouse drag = look, W/S/A/D/Q/E = move, Shift = fast)
 *   ?lane=0 ?h=          lateral offset on the road (m, + = left); camera height override (m)
 *   ?yaw=&pitch=         look offset (deg) on the road cameras; the view for over/top/free
 *   ?speed=60            ride along the road at 60 m/s on the rail cameras (0 = stand still, the default)
 *   ?drive=lmp-x         drive that car (lmp-x | volta | dieci) on the physics, from the grid; the camera follows it.
 *                        ?auto=0.55: the autopilot drives it at that fraction of the design speed. Keys: arrows or W/A/S/D.
 *   ?check=1             CPU vs GPU check of the carve: window.__CHECK__ (heights in metres; see runCheck)
 *   ?q=low|...  ?bloom=0  ?hud=0  ?freeze=1  ?carve=0 (the terrain without the road's carve: to measure its cost)
 *
 * The corner shows fps, CPU ms per frame, GPU ms per frame (timer queries when the browser has them), draw calls and triangles.
 * window.__READY__ once the first frames are drawn; window.__sandbox: { stage, stats(n), bench(n), setS(s) }.
 */
import * as THREE from 'three';
import { CARS } from '../src/cars';
import type { TrackFrame } from '../src/core/contracts';
import { PhysicsWorld, type Vehicle } from '../src/physics';
import { RoadView } from '../src/render/road';
import { SkyView } from '../src/render/sky';
import { QUALITY, Stage as RenderStage } from '../src/render/stage';
import { StageUniforms, TerrainView } from '../src/render/terrain';
import { TERRAIN_HEIGHT_GLSL, STAGE_GLSL } from '../src/render/terrainGlsl';
import { generateStage, groundHeightAt, setActiveStage } from '../src/world/stage';
import { StagePilot } from '../src/world/stage-pilot';
import { getTerrainShift, heightAt, TERRAIN_SLOT_COUNT, terrainLattice } from '../src/world/terrain';

declare global {
  interface Window {
    __READY__?: boolean;
    __CHECK__?: unknown;
    __sandbox?: unknown;
  }
}

const PALETTE_MAGENTA = 0xff2bd6;
const q = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(+q.get(k)!) ? +q.get(k)! : d);

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
if (q.get('hud') === '0') hud.style.display = 'none';
const rs = new RenderStage(canvas, { maxPixelRatio: num('dpr', 1.5), bloom: q.get('bloom') !== '0' });
rs.renderer.info.autoReset = false;
if (q.has('q')) {
  const ql = q.get('q')!;
  rs.quality = /^\d$/.test(ql) ? +ql : QUALITY.findIndex((l) => l.name === ql);
}
const cam = rs.camera;
cam.near = 0.3;
cam.updateProjectionMatrix();

// ---- the stage
const t0 = performance.now();
const stage = generateStage(num('seed', 12345));
const genMs = performance.now() - t0;
setActiveStage(stage);
const sky = new SkyView();
const terrain = new TerrainView();
// (?carve=0: the terrain without the road's carve, to measure what it costs)
terrain.setStage(q.get('carve') === '0' ? null : stage);
const road = new RoadView();
const t1 = performance.now();
road.setStage(stage);
const roadMs = performance.now() - t1;
rs.scene.add(sky.object, terrain.object, road.object);
const tr = stage.track;
console.info(`stage ${stage.seed} "${stage.name}": ${(tr.length / 1000).toFixed(2)} km, generated in ${genMs.toFixed(0)} ms, road built in ${roadMs.toFixed(0)} ms; ${JSON.stringify(stage.stats)}`);
stage.checkpoints.forEach((_, i) => road.setCheckpoint(i, i === 0 ? 'next' : 'ahead'));

// ---- the camera
type CamMode = 'car' | 'chase' | 'high' | 'drone' | 'over' | 'top' | 'free';
const mode = (q.get('cam') ?? 'chase') as CamMode;
let s = num('s', 0);
const lane = num('lane', 0);
const speed = num('speed', 0);
const look = { yaw: num('yaw', 0), pitch: num('pitch', mode === 'drone' ? -25 : -2) };
const free = { x: 0, y: 0, z: 0, yaw: 0, pitch: -20 };
const fr: TrackFrame = { position: new THREE.Vector3(), tangent: new THREE.Vector3(), normal: new THREE.Vector3(), left: new THREE.Vector3(), widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0 };
const b = tr.bounds;
const cx = (b.minX + b.maxX) / 2;
const cz = (b.minZ + b.maxZ) / 2;
const extent = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
if (mode === 'free') {
  tr.frameAt(s, fr);
  Object.assign(free, { x: fr.position.x, y: fr.position.y + num('h', 40), z: fr.position.z, yaw: (Math.atan2(fr.tangent.x, -fr.tangent.z) * 180) / Math.PI, pitch: num('pitch', -15) });
}

// ---- a car (optional)
const world = new PhysicsWorld(tr);
let car: Vehicle | null = null;
let pilot: StagePilot | null = null;
let carMesh: THREE.Object3D | null = null;
if (q.has('drive')) {
  const def = CARS.find((c) => c.id === q.get('drive')) ?? CARS[0];
  car = world.addVehicle(def);
  const g = tr.grid[0];
  if (q.has('s')) {
    tr.frameAt(s, fr);
    const m = new THREE.Matrix4().makeBasis(fr.left, fr.normal, fr.tangent);
    car.placeOnGround(tr.pointAt(s, lane, new THREE.Vector3()), new THREE.Quaternion().setFromRotationMatrix(m), num('v0', 0));
  } else car.placeOnGround(g.position, g.quaternion, 0);
  if (q.has('auto')) pilot = new StagePilot(stage, def.physics.chassis.wheelbase, def.physics.chassis.maxSteer, num('auto', 0.55), lane);
  // a stand-in body: a dark box with neon edges, the car's size
  const v = def.visual;
  const box = new THREE.BoxGeometry(v.width, v.height, v.length);
  const body = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: 0x0a0716 }));
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: new THREE.Color(PALETTE_MAGENTA).multiplyScalar(2.5) }));
  const grp = new THREE.Group();
  body.position.y = v.height / 2 - def.physics.chassis.cgHeight + 0.05;
  edges.position.copy(body.position);
  grp.add(body, edges);
  carMesh = grp;
  rs.scene.add(grp);
}
const keys = new Set<string>();
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const t = mode === 'free' ? free : look;
  t.yaw += e.movementX * 0.15;
  t.pitch = Math.max(-89, Math.min(89, t.pitch - e.movementY * 0.15));
});

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
function placeCamera(dt: number): void {
  cam.rotation.order = 'YXZ';
  if (mode === 'over' || mode === 'top') {
    const h = mode === 'top' ? extent * 0.85 : extent * 0.45;
    const g = groundHeightAt(cx, cz);
    if (mode === 'top') {
      cam.position.set(cx, g + h, cz);
      cam.rotation.set(-Math.PI / 2, 0, 0);
    } else {
      const yaw = THREE.MathUtils.degToRad(look.yaw);
      cam.position.set(cx - Math.sin(yaw) * extent * 0.55, g + h, cz + Math.cos(yaw) * extent * 0.55);
      cam.lookAt(cx, g, cz);
    }
    return;
  }
  if (mode === 'free') {
    const sp = (keys.has('ShiftLeft') ? 600 : 80) * dt;
    cam.rotation.set(THREE.MathUtils.degToRad(free.pitch), -THREE.MathUtils.degToRad(free.yaw), 0);
    cam.getWorldDirection(tmp);
    tmp2.crossVectors(tmp, cam.up).normalize();
    const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const r = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    const u = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
    free.x += (tmp.x * f + tmp2.x * r) * sp;
    free.y += (tmp.y * f + u) * sp;
    free.z += (tmp.z * f + tmp2.z * r) * sp;
    free.y = Math.max(free.y, groundHeightAt(free.x, free.z) + 1);
    cam.position.set(free.x, free.y, free.z);
    return;
  }
  // the road cameras: behind and above a point on the road (the car's, or the rail's)
  const back = mode === 'car' ? -0.6 : mode === 'chase' ? 7.5 : mode === 'high' ? 15 : 160;
  const up = num('h', mode === 'car' ? 1.1 : mode === 'chase' ? 2.6 : mode === 'high' ? 6 : 120);
  let px: number, py: number, pz: number, hx: number, hz: number;
  if (car) {
    const st = car.state;
    tmp.set(0, 0, 1).applyQuaternion(st.quaternion);
    hx = tmp.x;
    hz = tmp.z;
    const l = Math.hypot(hx, hz) || 1;
    hx /= l;
    hz /= l;
    px = st.position.x;
    py = st.position.y;
    pz = st.position.z;
  } else {
    tr.frameAt(s, fr);
    const p = tr.pointAt(s, lane, tmp);
    px = p.x;
    py = p.y;
    pz = p.z;
    const l = Math.hypot(fr.tangent.x, fr.tangent.z);
    hx = fr.tangent.x / l;
    hz = fr.tangent.z / l;
  }
  const x = px - hx * back;
  const z = pz - hz * back;
  const y = Math.max(py + up, groundHeightAt(x, z) + 0.8);
  cam.position.set(x, y, z);
  const yaw = Math.atan2(hx, hz) + Math.PI + THREE.MathUtils.degToRad(-look.yaw);
  cam.rotation.set(THREE.MathUtils.degToRad(look.pitch), yaw, 0);
}

// ---- GPU timing (EXT_disjoint_timer_query_webgl2 when the browser offers it)
const gl = rs.renderer.getContext() as WebGL2RenderingContext;
const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
let pending: WebGLQuery | null = null;
const gpuHist: number[] = [];
let gpuMs = NaN;
function renderTimed(): void {
  if (timer && !pending) {
    const qq = gl.createQuery()!;
    gl.beginQuery(timer.TIME_ELAPSED_EXT, qq);
    rs.render();
    gl.endQuery(timer.TIME_ELAPSED_EXT);
    pending = qq;
  } else rs.render();
  if (timer && pending && gl.getQueryParameter(pending, gl.QUERY_RESULT_AVAILABLE)) {
    if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) {
      gpuHist.push((gl.getQueryParameter(pending, gl.QUERY_RESULT) as number) / 1e6);
      if (gpuHist.length > 60) gpuHist.shift();
      gpuMs = [...gpuHist].sort((a, c) => a - c)[gpuHist.length >> 1];
    }
    gl.deleteQuery(pending);
    pending = null;
  }
}

// ---- the loop
const freeze = q.get('freeze') === '1';
let last = performance.now();
const start = last;
let frames = 0;
let fps = 0;
let fpsT = last;
let fpsN = 0;
let cpuMs = 0;
const frameMs: number[] = [];
let benching = false;

function frame(now: number): void {
  frameMs.push(now - last);
  if (frameMs.length > 3000) frameMs.shift();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const t = freeze ? 0 : (now - start) / 1000;
  const c0 = performance.now();
  if (car) {
    if (pilot) pilot.drive(car.state, car.controls);
    else {
      const k = (c: string, c2: string) => keys.has(c) || keys.has(c2);
      car.controls.throttle = k('ArrowUp', 'KeyW') ? 1 : 0;
      car.controls.brake = k('ArrowDown', 'KeyS') ? 1 : 0;
      const st = (k('ArrowRight', 'KeyD') ? 1 : 0) - (k('ArrowLeft', 'KeyA') ? 1 : 0);
      car.controls.steer += (st - car.controls.steer) * Math.min(1, dt * 6);
    }
    world.step(freeze ? 0 : dt);
    carMesh!.position.copy(car.state.position);
    carMesh!.quaternion.copy(car.state.quaternion);
  } else if (speed && mode !== 'free' && mode !== 'over' && mode !== 'top') {
    s += speed * dt;
    if (s > tr.length) s = 0;
  }
  if (!benching) {
    placeCamera(dt);
    rs.renderer.info.reset();
    sky.update(cam, t);
    terrain.update(cam, t);
    road.update(cam, t);
    renderTimed();
  }
  const c1 = performance.now();
  cpuMs = cpuMs * 0.95 + (c1 - c0) * 0.05;
  frames++;
  fpsN++;
  if (now - fpsT > 500) {
    fps = (fpsN * 1000) / (now - fpsT);
    fpsT = now;
    fpsN = 0;
  }
  const info = rs.renderer.info.render;
  const g = groundHeightAt(cam.position.x, cam.position.z);
  const carS = pilot ? pilot.s : s;
  hud.textContent =
    `${stage.name}  seed ${stage.seed}  ${(tr.length / 1000).toFixed(2)} km  (${genMs.toFixed(0)} ms + road ${roadMs.toFixed(0)} ms)\n` +
    `fps ${fps.toFixed(0)}   cpu ${cpuMs.toFixed(2)} ms   gpu ${Number.isFinite(gpuMs) ? gpuMs.toFixed(2) + ' ms' : 'n/a'}   draws ${info.calls}   tris ${(info.triangles / 1000).toFixed(0)}k   q ${QUALITY[rs.quality].name}\n` +
    `s ${carS.toFixed(0)} m   camera ${(cam.position.y - g).toFixed(1)} m above the ground` +
    (car ? `   ${(car.state.speed * 3.6).toFixed(0)} km/h  gear ${car.state.gear}${car.state.airborne ? '  AIRBORNE' : ''}` : '');
  if (frames === 8 && q.get('check') !== '1') window.__READY__ = true;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- the CPU vs GPU check of the carve: renders stageApply(terrainHD(p)) at a grid of points around origins along the road (and
// across it: the formation, the slopes, the fade) into a float target and compares with heightAt() in float64.
async function runCheck(): Promise<unknown> {
  const N = 48;
  const STEP = 3.7;
  const target = new THREE.WebGLRenderTarget(N, N, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
  const lattice = new Float32Array(TERRAIN_SLOT_COUNT * 4);
  const su = new StageUniforms();
  su.set(stage.field);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uSlot: { value: lattice as unknown as THREE.Vector4[] }, uCam: { value: new THREE.Vector2() }, ...su.uniforms },
    vertexShader: /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
${TERRAIN_HEIGHT_GLSL}
${STAGE_GLSL}
uniform vec2 uCam;
void main() {
  vec2 ij = floor(gl_FragCoord.xy);
  vec2 p = (ij - ${(N / 2 - 0.5).toFixed(1)}) * ${STEP.toFixed(2)};
  vec3 hd = stageApply(terrainHD(p, uCam), p, 0.0);
  gl_FragColor = vec4(hd, 1.0);
}`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  const sc = new THREE.Scene();
  sc.add(quad);
  const oc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const buf = new Float32Array(N * N * 4);
  const fieldTmp = new Float64Array(2);
  const errs: number[] = [];
  let worst = { err: 0, x: 0, z: 0, gpu: 0, cpu: 0 };
  let carved = 0;
  const shift = getTerrainShift();
  for (let sAt = -80; sAt < tr.length + 500; sAt += 157) {
    // an origin on the road, a few metres off it at random, snapped to 2 m like the terrain's
    const p = tr.pointAt(sAt, ((sAt * 7.31) % 40) - 20, new THREE.Vector3());
    const ox = Math.floor(p.x / 2) * 2;
    const oz = Math.floor(p.z / 2) * 2;
    terrainLattice(ox + shift.x, oz + shift.z, lattice);
    su.update(ox, oz);
    rs.renderer.setRenderTarget(target);
    rs.renderer.render(sc, oc);
    rs.renderer.readRenderTargetPixels(target, 0, 0, N, N, buf);
    rs.renderer.setRenderTarget(null);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const lx = (i - (N / 2 - 0.5)) * STEP;
        const lz = (j - (N / 2 - 0.5)) * STEP;
        const gpu = buf[(j * N + i) * 4];
        const x = ox + lx;
        const z = oz + lz;
        const cpu = heightAt(x, z);
        const err = Math.abs(gpu - cpu);
        errs.push(err);
        if (stage.field.sample(x, z, fieldTmp) && fieldTmp[0] < 135) carved++;
        if (err > worst.err) worst = { err, x, z, gpu, cpu };
      }
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  errs.sort((a, c) => a - c);
  const res = {
    samples: errs.length,
    carved,
    maxErr: errs[errs.length - 1],
    p999: errs[Math.floor(errs.length * 0.999)],
    p99: errs[Math.floor(errs.length * 0.99)],
    median: errs[errs.length >> 1],
    worst,
  };
  target.dispose();
  mat.dispose();
  su.dispose();
  return res;
}
if (q.get('check') === '1') {
  window.__READY__ = false;
  runCheck().then((r) => {
    window.__CHECK__ = r;
    console.info('check', JSON.stringify(r));
    window.__READY__ = true;
  });
}

// ---- scripted helpers
function stats(n = 600): Record<string, number> {
  const a = frameMs.slice(-n).slice(1);
  const sorted = [...a].sort((x, y) => x - y);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { frames: a.length, fps: (1000 * a.length) / a.reduce((x, y) => x + y, 0), p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1], cpuMs, gpuMs };
}

/** Median GPU ms of the full pipeline, of the scene without the road, and of the road alone (timer queries). */
async function bench(n = 90): Promise<Record<string, number>> {
  if (!timer) return { error: -1 };
  benching = true;
  const nextFrame = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));
  const time = async (render: () => void): Promise<number> => {
    const times: number[] = [];
    const queue: WebGLQuery[] = [];
    const collect = (): void => {
      while (queue.length && gl.getQueryParameter(queue[0], gl.QUERY_RESULT_AVAILABLE)) {
        const qq = queue.shift()!;
        if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) times.push((gl.getQueryParameter(qq, gl.QUERY_RESULT) as number) / 1e6);
        gl.deleteQuery(qq);
      }
    };
    for (let i = 0; i < n + 6; i++) {
      await nextFrame();
      const qq = gl.createQuery()!;
      gl.beginQuery(timer.TIME_ELAPSED_EXT, qq);
      render();
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      queue.push(qq);
      collect();
    }
    for (let i = 0; i < 20 && queue.length; i++) {
      await nextFrame();
      collect();
    }
    times.splice(0, 4);
    times.sort((a, c) => a - c);
    return times.length ? times[times.length >> 1] : NaN;
  };
  const draw = (): void => {
    placeCamera(0);
    sky.update(cam, 0);
    terrain.update(cam, 0);
    road.update(cam, 0);
    rs.render();
  };
  const out: Record<string, number> = {};
  out.full = await time(draw);
  road.object.visible = false;
  out.noRoad = await time(draw);
  road.object.visible = true;
  out.road = out.full - out.noRoad;
  benching = false;
  return out;
}

window.__sandbox = { stage, stats, bench, setS: (v: number) => (s = v), terrain, road, rs };
