/**
 * The stage's TrackRuntime (src/world/stage-track.ts): project, pointAt, groundAt and frameAt agree with each other, the hints work,
 * the surfaces and the barriers are where they should be, and the cars drive on it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { GroundSample, TrackFrame, TrackPoint } from '../src/core/contracts';
import { CARS } from '../src/cars';
import { PhysicsWorld } from '../src/physics';
import { generateStage, setActiveStage } from '../src/world/stage';
import { StagePilot } from '../src/world/stage-pilot';
import { FORMATION, GRID_TRAP, ROAD_HALF, RUNOFF_SURFACE, SHOULDER, WALL } from '../src/world/stage-track';

const stage = generateStage(12345);
const tr = stage.track;
afterAll(() => setActiveStage(null));

const tp = (): TrackPoint => ({ s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 });
const gs = (): GroundSample => ({ height: 0, normal: new Vector3(), surface: 'asphalt' });
const fr = (): TrackFrame => ({ position: new Vector3(), tangent: new Vector3(), normal: new Vector3(), left: new Vector3(), widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0 });

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('the stage track', () => {
  it('is an open road: s = 0 at the start line, length at the finish, arrays sampled every spacing over [0, length]', () => {
    expect(tr.count * tr.spacing).toBe(tr.length);
    expect(tr.px.length).toBe(tr.count + 1);
    const p = new Vector3();
    for (const i of [0, 1, 17, Math.floor(tr.count / 2), tr.count]) {
      tr.pointAt(i * tr.spacing, 0, p);
      expect(tr.px[i]).toBeCloseTo(p.x, 2);
      expect(tr.py[i]).toBeCloseTo(p.y, 2);
      expect(tr.pz[i]).toBeCloseTo(p.z, 2);
    }
    expect(tr.wrapS(-50)).toBe(0);
    expect(tr.wrapS(tr.length + 50)).toBe(tr.length);
    expect(tr.wrapS(1234.5)).toBe(1234.5);
    expect(tr.bounds.minX).toBeLessThan(tr.bounds.maxX);
  });

  it('round-trips pointAt -> project, with and without hints, on the grid and in the run-out too', () => {
    const r = rng(1);
    const out = tp();
    const p = new Vector3();
    let hint = -1;
    let worstS = 0;
    let worstD = 0;
    for (let k = 0; k < 4000; k++) {
      const s = tr.sStart + 1 + r() * (tr.sEnd - tr.sStart - 2);
      const d = (r() * 2 - 1) * FORMATION;
      tr.pointAt(s, d, p);
      // half the queries with the previous hint (far away: a stale one), half without
      hint = tr.project(p.x, p.z, out, k % 2 ? hint : -1);
      worstS = Math.max(worstS, Math.abs(out.s - s));
      worstD = Math.max(worstD, Math.abs(out.d - d));
    }
    expect(worstS).toBeLessThan(1e-6);
    expect(worstD).toBeLessThan(1e-6);
  });

  it('follows a car with hints: walking along the road, the hint keeps up', () => {
    const out = tp();
    const p = new Vector3();
    let hint = tr.project(tr.grid[0].position.x, tr.grid[0].position.z, out);
    for (let s = -40; s < tr.length + 300; s += 0.9) {
      tr.pointAt(s, 3 * Math.sin(s / 50), p);
      hint = tr.project(p.x, p.z, out, hint);
      expect(Math.abs(out.s - s)).toBeLessThan(1e-6);
    }
  });

  it('has its ground on the road surface, with the normal of its slope and bank', () => {
    const r = rng(2);
    const g = gs();
    const g2 = gs();
    const out = tp();
    const p = new Vector3();
    let hint = -1;
    let worstH = 0;
    let worstN = 0;
    for (let k = 0; k < 3000; k++) {
      const s = r() * tr.length;
      const d = (r() * 2 - 1) * (FORMATION - 0.5);
      tr.pointAt(s, d, p);
      hint = tr.groundAt(p.x, p.z, g, hint);
      worstH = Math.max(worstH, Math.abs(g.height - p.y));
      // the normal against central differences of the height
      const e = 0.02;
      const h = (x: number, z: number): number => (tr.groundAt(x, z, g2, hint), g2.height);
      const hx = (h(p.x + e, p.z) - h(p.x - e, p.z)) / (2 * e);
      const hz = (h(p.x, p.z + e) - h(p.x, p.z - e)) / (2 * e);
      const n = new Vector3(-hx, 1, -hz).normalize();
      worstN = Math.max(worstN, n.angleTo(g.normal));
      tr.project(p.x, p.z, out, hint);
      expect(out.y).toBeCloseTo(tr.pointAt(out.s, 0, new Vector3()).y, 6);
    }
    expect(worstH).toBeLessThan(1e-6);
    expect(worstN).toBeLessThan(2e-3);
  });

  it('has frames that agree with pointAt and groundAt', () => {
    const f = fr();
    const g = gs();
    const a = new Vector3();
    const b = new Vector3();
    for (let s = 1; s < tr.length; s += 37.3) {
      tr.frameAt(s, f);
      tr.pointAt(s, 0, a);
      expect(f.position.distanceTo(a)).toBeLessThan(1e-6);
      expect(Math.abs(f.tangent.dot(f.normal))).toBeLessThan(1e-6);
      expect(f.left.clone().sub(new Vector3().crossVectors(f.normal, f.tangent)).length()).toBeLessThan(1e-6);
      // the tangent points along the road (the centreline is straight between samples: within half the turn of a sample), the left
      // vector to the left of it
      tr.pointAt(s + 0.5, 0, b);
      b.sub(tr.pointAt(s - 0.5, 0, a)).normalize();
      expect(f.tangent.angleTo(b)).toBeLessThan(0.5 * Math.abs(f.curvature) * tr.spacing + 0.002);
      tr.pointAt(s, 5, b);
      expect(b.sub(f.position).normalize().dot(f.left)).toBeGreaterThan(0.999);
      // the frame's normal is the ground's on the centreline
      tr.groundAt(f.position.x, f.position.z, g);
      expect(f.normal.angleTo(g.normal)).toBeLessThan(0.005);
      expect(f.wallLeft).toBe(WALL);
      expect(f.widthRight).toBe(ROAD_HALF);
    }
  });

  it('has asphalt, a shoulder, a run-off, barriers at WALL, and sand traps at the two ends', () => {
    const g = gs();
    const p = new Vector3();
    const at = (s: number, d: number): string => {
      tr.pointAt(s, d, p);
      tr.groundAt(p.x, p.z, g);
      return g.surface;
    };
    expect(at(500, 0)).toBe('asphalt');
    expect(at(500, -ROAD_HALF + 0.1)).toBe('asphalt');
    expect(at(500, (ROAD_HALF + SHOULDER) / 2)).toBe('concrete');
    expect(at(500, -(SHOULDER + WALL) / 2)).toBe(RUNOFF_SURFACE);
    expect(at(-GRID_TRAP - 10, 0)).toBe('sand');
    expect(at(tr.sEnd - 20, 0)).toBe('sand');
    expect(at(tr.length + 200, 0)).toBe('asphalt');
    const out = tp();
    tr.pointAt(800, 11, p);
    tr.project(p.x, p.z, out);
    expect(out.wallLeft).toBe(WALL);
    expect(out.wallRight).toBe(WALL);
    expect(out.softLeft).toBe(0);
  });

  it('starts the car on the centreline just behind the start line, facing along the road', () => {
    const g0 = tr.grid[0];
    expect(tr.grid.length).toBeGreaterThanOrEqual(12);
    expect(g0.s).toBeLessThan(0);
    expect(g0.s).toBeGreaterThan(-8);
    expect(g0.d).toBe(0);
    const f = fr();
    tr.frameAt(g0.s, f);
    const fwd = new Vector3(0, 0, 1).applyQuaternion(g0.quaternion);
    const up = new Vector3(0, 1, 0).applyQuaternion(g0.quaternion);
    expect(fwd.angleTo(f.tangent)).toBeLessThan(1e-3);
    expect(up.angleTo(f.normal)).toBeLessThan(1e-3);
    for (const slot of tr.grid) expect(slot.s).toBeGreaterThan(-GRID_TRAP);
  });

  it('answers groundAt fast with hints (the physics asks ~16,000 times a second)', () => {
    const g = gs();
    const p = new Vector3();
    const pts: number[] = [];
    for (let s = 100; s < 2100; s += 0.125) {
      tr.pointAt(s, 2 * Math.sin(s / 30), p);
      pts.push(p.x, p.z);
    }
    let hint = -1;
    const t0 = performance.now();
    for (let rep = 0; rep < 4; rep++) for (let k = 0; k < pts.length; k += 2) hint = tr.groundAt(pts[k], pts[k + 1], g, hint);
    const us = ((performance.now() - t0) * 1000) / (pts.length * 2);
    console.log(`groundAt with hints: ${us.toFixed(3)} us per call`);
    expect(us).toBeLessThan(1.5);
  });
});

describe('driving a stage', () => {
  it('takes the LMP-X off the grid and 1.5 km down the road with nothing odd happening', () => {
    setActiveStage(stage);
    const world = new PhysicsWorld(tr);
    const def = CARS.find((c) => c.id === 'lmp-x')!;
    const car = world.addVehicle(def);
    const g0 = tr.grid[0];
    car.placeOnGround(g0.position, g0.quaternion, 0);
    const pilot = new StagePilot(stage, def.physics.chassis.wheelbase, def.physics.chassis.maxSteer, 0.6);
    const dt = 1 / 60;
    // settled on its wheels on the grid
    world.simulate(1);
    expect(car.state.speed).toBeLessThan(0.2);
    expect(car.state.wheels.every((w) => w.contact)).toBe(true);
    let lastS = -Infinity;
    let maxD = 0;
    let air = 0;
    let vmax = 0;
    let t = 0;
    for (; t < 90 && pilot.s < 1500; t += dt) {
      pilot.drive(car.state, car.controls);
      world.step(dt);
      const st = car.state;
      expect(Number.isFinite(st.position.x + st.position.y + st.position.z)).toBe(true);
      if (st.airborne) air++;
      maxD = Math.max(maxD, Math.abs(pilot.d));
      vmax = Math.max(vmax, st.speed);
      // never backwards along the road by more than a whisker
      expect(pilot.s).toBeGreaterThan(lastS - 0.05);
      lastS = Math.max(lastS, pilot.s);
      // on the road's surface, the right way up
      const f = fr();
      tr.frameAt(pilot.s, f);
      expect(Math.abs(st.position.y - tr.pointAt(pilot.s, pilot.d, new Vector3()).y)).toBeLessThan(1.5);
      expect(new Vector3(0, 1, 0).applyQuaternion(st.quaternion).y).toBeGreaterThan(0.9);
    }
    expect(pilot.s).toBeGreaterThan(1500);
    expect(air).toBe(0);
    expect(maxD).toBeLessThan(WALL - 1);
    expect(car.state.impactCount).toBe(0);
    expect(vmax * 3.6).toBeGreaterThan(150);
    setActiveStage(null);
  });

  it('keeps the Dieci on the ground over the sharpest crests at the speed it can carry there', () => {
    for (const st of [stage, generateStage(119), generateStage(1)]) {
      const t = st.track;
      const v = st.profile.speed;
      // the crests that come nearest to v^2 / g, each taken at its design speed (capped at the car's top speed)
      const crests: { i: number; k: number }[] = [];
      for (let i = t.i0 + 100; i + 1 < t.i0 + t.count; i++) {
        const ypp = (t.M[i + 1] - t.M[i]) / t.spacing;
        if (ypp >= -1e-9) continue;
        crests.push({ i, k: -1 / ypp / ((v[i] * v[i]) / 9.81) });
      }
      crests.sort((a, b) => a.k - b.k);
      const picked: number[] = [];
      for (const c of crests) if (picked.length < 3 && picked.every((p) => Math.abs(p - c.i) > 200)) picked.push(c.i);
      for (const ic of picked) {
        const world = new PhysicsWorld(t);
        const def = CARS.find((c) => c.id === 'dieci')!;
        const car = world.addVehicle(def);
        const sc = t.sStart + ic * t.spacing;
        const v0 = Math.min(v[ic], 90);
        const s0 = sc - 150;
        const f = fr();
        t.frameAt(s0, f);
        car.placeOnGround(t.pointAt(s0, 0, new Vector3()), new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(f.left, f.normal, f.tangent)), v0);
        const pilot = new StagePilot(st, def.physics.chassis.wheelbase, def.physics.chassis.maxSteer, 1, 0, v0);
        let air = 0;
        for (let k = 0; k < 240 && pilot.s < sc + 100; k++) {
          pilot.drive(car.state, car.controls);
          // (hold the speed: no braking for what the autopilot thinks is ahead)
          car.controls.brake = 0;
          car.controls.throttle = car.state.forwardSpeed < v0 ? 1 : 0.3;
          world.step(1 / 60);
          if (car.state.airborne) air++;
        }
        expect(pilot.s, `seed ${st.seed} crest at ${sc.toFixed(0)}`).toBeGreaterThan(sc + 50);
        expect(air, `seed ${st.seed}: crest at ${sc.toFixed(0)} m taken at ${(v0 * 3.6).toFixed(0)} km/h`).toBe(0);
      }
    }
  });

  it('bounces a car that runs straight at a barrier back onto the road, and nothing gets stuck or falls through', () => {
    const world = new PhysicsWorld(tr);
    const car = world.addVehicle(CARS.find((c) => c.id === 'volta')!);
    const f = fr();
    const s0 = 2000;
    tr.frameAt(s0, f);
    // aimed 30 degrees to the left of the road at 120 km/h
    const fwd = f.tangent.clone().applyAxisAngle(f.normal, 0.52);
    const left = new Vector3().crossVectors(f.normal, fwd).normalize();
    const quat = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(left, f.normal, fwd));
    car.placeOnGround(tr.pointAt(s0, 0, new Vector3()), quat, 33);
    car.controls.throttle = 0;
    const out = tp();
    let hint = -1;
    let hit = false;
    for (let t = 0; t < 6; t += 1 / 60) {
      world.step(1 / 60);
      hint = tr.project(car.state.position.x, car.state.position.z, out, hint);
      expect(Math.abs(out.d)).toBeLessThan(WALL + 0.5);
      expect(car.state.position.y).toBeGreaterThan(tr.pointAt(out.s, out.d, new Vector3()).y - 0.5);
      if (car.state.impactCount > 0) hit = true;
    }
    expect(hit).toBe(true);
    // still upright on the road, and it can drive away
    expect(new Vector3(0, 1, 0).applyQuaternion(car.state.quaternion).y).toBeGreaterThan(0.9);
    car.controls.throttle = 1;
    const sBefore = out.s;
    for (let t = 0; t < 3; t += 1 / 60) world.step(1 / 60);
    tr.project(car.state.position.x, car.state.position.z, out, hint);
    expect(Math.hypot(out.s - sBefore, out.d)).toBeGreaterThan(3);
  });
});
