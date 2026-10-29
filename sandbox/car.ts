/**
 * Car sandbox: one neon car on a dark grid under the game's renderer, sky and bloom.
 *
 *   sandbox/car.html?car=lmp-x|volta|dieci&view=chase|rear34|side|front34|top|turntable|ghostnear|pair&ghost=1
 *     &q=0..3     quality level (src/render/stage.ts QUALITY; default 3 = high)
 *     &t=<s>      freeze the animation at this time (screenshots)
 *     &kmh=<v>    wheel speed (default 30; the spokes blur from about 25 km/h)
 *     &steer=0    no steering sweep          &brake=0..1 | anim (default anim)
 *     &aero=0..1 | anim (the Volta's flaps; default anim)
 *     &info=0     hide the text
 *     &cam=x,y,z&look=x,y,z&fov=30   a free camera (body frame of the car: +z forward, +x left)
 *
 * window.__READY__ turns true after the first frames; window.__CAR_STATS__ holds the draw calls and the geometry sizes.
 */
import * as THREE from 'three';
import { getCar } from '../src/cars';
import { bodyCgZ } from '../src/core/contracts';
import { CarView, type CarPose } from '../src/render/car';
import { PALETTE } from '../src/render/palette';
import { SkyView } from '../src/render/sky';
import { Stage } from '../src/render/stage';

const q = new URLSearchParams(location.search);
const carId = q.get('car') ?? 'lmp-x';
const view = q.get('view') ?? 'rear34';
const ghostOnly = q.get('ghost') === '1';
const fixedT = q.get('t') !== null ? parseFloat(q.get('t')!) : null;
const kmh = parseFloat(q.get('kmh') ?? '30');
const steerAnim = q.get('steer') !== '0';
const brakeQ = q.get('brake') ?? 'anim';
const aeroQ = q.get('aero') ?? 'anim';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const stage = new Stage(canvas, { maxPixelRatio: 2 });
stage.quality = parseInt(q.get('q') ?? '3', 10);
stage.camera.near = 0.05;
stage.camera.updateProjectionMatrix();
const sky = new SkyView();
stage.scene.add(sky.object);

// the ground: a very dark plane with a glowing cyan grid (2 m) and a brighter line every 10 m, anti-aliased in the shader
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
  new THREE.ShaderMaterial({
    uniforms: { uBody: { value: new THREE.Color(PALETTE.ground) }, uLine: { value: new THREE.Color(PALETTE.cyan).multiplyScalar(0.9) }, uFog: { value: new THREE.Color(PALETTE.skyHorizon) } },
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform vec3 uBody; uniform vec3 uLine; uniform vec3 uFog; varying vec3 vW;
      float grid(vec2 p, float s, float w) { vec2 g = abs(fract(p / s - 0.5) - 0.5) * s; vec2 f = fwidth(p); vec2 a = smoothstep(vec2(w) + f, vec2(w), g); return max(a.x, a.y); }
      void main(){
        float l = max(grid(vW.xz, 2.0, 0.012) * 0.45, grid(vW.xz, 10.0, 0.02));
        float d = length(vW.xz - cameraPosition.xz);
        vec3 c = mix(uBody, uLine, l);
        gl_FragColor = vec4(mix(c, uFog, smoothstep(30.0, 160.0, d)), 1.0);
      }`,
  }),
);
stage.scene.add(ground);

const def = getCar(carId);
const v = def.visual;
const cgZ = bodyCgZ({ wheelbase: v.wheelbase, cgToFrontAxle: v.cgToFrontAxle });
const cars: { view: CarView; pose: CarPose; base: THREE.Vector3; yaw: number }[] = [];
function addCar(ghost: boolean, x: number, z: number, yaw = 0): void {
  const cv = new CarView(def, { ghost });
  stage.scene.add(cv.object);
  const base = new THREE.Vector3(x, v.cgHeight, z);
  const pose: CarPose = {
    position: base.clone(),
    quaternion: new THREE.Quaternion(),
    brake: 0,
    aeroOpen: 0,
    wheels: [0, 1, 2, 3].map(() => ({ steerAngle: 0, spin: 0, compression: 0.38 })),
  };
  cars.push({ view: cv, pose, base, yaw });
  // &hide=edges,body,wheel,underglow : hide parts by name (debugging)
  const hide = (q.get('hide') ?? '').split(',').filter(Boolean);
  cv.object.traverse((o) => {
    if (hide.includes(o.name)) o.visible = false;
  });
}
if (view === 'pair') {
  addCar(false, 1.4, cgZ);
  addCar(true, -1.4, cgZ);
} else if (view === 'ghostnear') {
  addCar(false, 0, cgZ);
  addCar(true, 0.25, cgZ - 4.6);
} else addCar(ghostOnly, 0, cgZ);

// the views: positions relative to the body origin of the (first) car, +z forward, +x left
const L = v.length;
const cams: Record<string, { pos: [number, number, number]; look: [number, number, number]; fov: number }> = {
  // the game's chase camera (src/render/chase-camera.ts): 6.4 m behind the centre of mass and 2.1 m above it, looking 6 m ahead
  chase: { pos: [0, v.cgHeight + 2.1, cgZ - 6.4], look: [0, v.cgHeight + 0.9, cgZ + 6], fov: 62 },
  rear34: { pos: [-3.6 * (L / 4.6), 1.45, -5.0 * (L / 4.6)], look: [0, 0.45, -0.1], fov: 30 },
  front34: { pos: [3.6 * (L / 4.6), 1.3, 5.0 * (L / 4.6)], look: [0, 0.45, 0.15], fov: 30 },
  side: { pos: [9.0, 0.7, 0], look: [0, 0.5, 0], fov: 22 },
  top: { pos: [0, 10, 0.01], look: [0, 0, 0], fov: 30 },
  // the car-select turntable: close, a little above, the car turning
  turntable: { pos: [3.1, 1.25, 3.9], look: [0, 0.42, 0], fov: 34 },
  pair: { pos: [5.2, 2.0, 6.5], look: [0, 0.45, 0], fov: 34 },
  // a ghost right in front of the chase camera (where it must not dazzle)
  ghostnear: { pos: [0, v.cgHeight + 2.1, cgZ - 6.4], look: [0, v.cgHeight + 0.9, cgZ + 6], fov: 62 },
};
const free = q.get('cam');
const cam = free
  ? { pos: free.split(',').map(Number) as [number, number, number], look: (q.get('look') ?? '0,0.5,0').split(',').map(Number) as [number, number, number], fov: parseFloat(q.get('fov') ?? '30') }
  : cams[view] ?? cams.rear34;
stage.camera.fov = cam.fov;
stage.camera.position.set(...cam.pos);
if (view === 'top') stage.camera.up.set(1, 0, 0);
stage.camera.lookAt(new THREE.Vector3(...cam.look));
stage.camera.updateProjectionMatrix();

const info = document.getElementById('info')!;
if (q.get('info') === '0') info.style.display = 'none';

let t0 = performance.now();
let last = t0;
let frames = 0;
const radiusR = v.wheelRadiusRear, radiusF = v.wheelRadiusFront;
const spins = [0, 0, 0, 0];

function frame(now: number): void {
  const dt = fixedT !== null ? 1 / 60 : Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = fixedT !== null ? fixedT : (now - t0) / 1000;
  const speed = kmh / 3.6;
  for (let i = 0; i < 4; i++) spins[i] = fixedT !== null ? (speed / (i < 2 ? radiusF : radiusR)) * t : spins[i] + (speed / (i < 2 ? radiusF : radiusR)) * dt;
  const steer = steerAnim ? 0.32 * Math.sin(t * 0.9) : 0;
  const brake = brakeQ === 'anim' ? (Math.sin(t * 0.7) > 0.4 ? 1 : 0) : parseFloat(brakeQ);
  const aero = aeroQ === 'anim' ? 0.5 + 0.5 * Math.sin(t * 0.6) : parseFloat(aeroQ);
  for (const c of cars) {
    const yaw = c.yaw + (view === 'turntable' ? t * 0.35 + 0.6 : 0);
    c.pose.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    // the centre of mass turns about the body origin's vertical with the car
    const off = new THREE.Vector3(0, 0, cgZ).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    c.pose.position.set(c.base.x, c.base.y, c.base.z - cgZ).add(off);
    c.pose.brake = brake;
    c.pose.aeroOpen = aero;
    const wh = c.pose.wheels as { steerAngle: number; spin: number; compression?: number }[];
    for (let i = 0; i < 4; i++) {
      wh[i].steerAngle = i < 2 ? steer : 0;
      wh[i].spin = spins[i];
      wh[i].compression = 0.38 + 0.12 * Math.sin(t * 2.2 + i);
    }
    // a frozen frame still needs the spoke blur settled: feed it a few frames
    if (fixedT !== null && frames === 0) for (let k = 0; k < 30; k++) c.view.update(c.pose, dt);
    c.view.update(c.pose, dt);
  }
  sky.update(stage.camera, t);
  stage.render();
  frames++;
  if (frames === 20) {
    const stats = {
      car: carId,
      view,
      drawCalls: cars.map((c) => c.view.drawCalls),
      bodyVerts: (() => {
        let n = 0;
        cars[0].view.object.traverse((o) => {
          const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
          if (g && (o as THREE.Mesh).isMesh && !(o as unknown as { isLineSegments2?: boolean }).isLineSegments2) n += g.getAttribute('position')?.count ?? 0;
        });
        return n;
      })(),
      gpu: (() => {
        const gl = stage.renderer.getContext();
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '?';
      })(),
    };
    (window as unknown as Record<string, unknown>).__CAR_STATS__ = stats;
    if (q.get('bench') === '1') (stats as Record<string, unknown>).bench = bench(t);
    (window as unknown as Record<string, unknown>).__READY__ = true;
    info.textContent = `${def.name}  ${view}${ghostOnly ? '  ghost' : ''}\ndraw calls ${stats.drawCalls.join(' + ')}  quality ${stage.quality}`;
  }
  requestAnimationFrame(frame);
}

/**
 * &bench=1: the cost of a frame with and without the cars, from 150 synchronous renders each (a 1-pixel read-back after each waits for
 * the GPU), alternating so both see the same clocks; the cars still update every frame (pose, wheels, uniforms) as in the game.
 */
function bench(t: number): { withCarsMs: number; withoutCarsMs: number; carsMs: number; updateUs: number } {
  const gl = stage.renderer.getContext();
  const px = new Uint8Array(4);
  const one = (show: boolean): number => {
    for (const c of cars) c.view.object.visible = show;
    const a = performance.now();
    for (const c of cars) {
      const wh = c.pose.wheels as unknown as { spin: number }[];
      for (const w of wh) w.spin += 0.3;
      c.view.update(c.pose, 1 / 60);
    }
    sky.update(stage.camera, t);
    stage.render();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return performance.now() - a;
  };
  for (let i = 0; i < 20; i++) one(i % 2 === 0);
  const w: number[] = [], wo: number[] = [];
  for (let i = 0; i < 300; i++) (i % 2 === 0 ? w : wo).push(one(i % 2 === 0));
  for (const c of cars) c.view.object.visible = true;
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const u0 = performance.now();
  for (let i = 0; i < 1000; i++) for (const c of cars) c.view.update(c.pose, 1 / 60);
  const updateUs = ((performance.now() - u0) / 1000 / cars.length) * 1000;
  const r = (x: number) => Math.round(x * 100) / 100;
  return { withCarsMs: r(med(w)), withoutCarsMs: r(med(wo)), carsMs: r(med(w) - med(wo)), updateUs: r(updateUs) };
}
t0 = performance.now();
requestAnimationFrame(frame);
