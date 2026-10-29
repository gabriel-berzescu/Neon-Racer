/**
 * The neon cars' view (src/render/car.ts): built to the cars' dimensions, posed by the physics' conventions (centre of mass, +X left,
 * wheels chassis * rotY(steer) * rotX(spin), compression about the static sag), cheap (few draw calls, no buffer written after the
 * build) and a ghost that never reaches the bloom threshold.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CARS, getCar } from '../src/cars';
import { bodyCgZ } from '../src/core/contracts';
import { CarView, type CarPose } from '../src/render/car';

const BLOOM = 0.75;
const lum = (c: THREE.Color) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

function pose(over: Partial<CarPose> = {}): CarPose {
  return {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    brake: 0,
    aeroOpen: 0,
    wheels: [0, 1, 2, 3].map(() => ({ steerAngle: 0, spin: 0, compression: 0.38 })),
    ...over,
  };
}

function named(v: CarView, name: string): THREE.Mesh {
  const o = v.object.getObjectByName(name);
  if (!o) throw new Error(`no ${name}`);
  return o as THREE.Mesh;
}

function wheels(v: CarView): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  v.object.traverse((o) => {
    if (o.name === 'wheel') out.push(o as THREE.Mesh);
  });
  return out;
}

/** Every buffer's version (they must not change after the build). */
function versions(v: CarView): number[] {
  const out: number[] = [];
  v.object.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!g) return;
    for (const a of Object.values(g.attributes)) {
      const ia = a as THREE.BufferAttribute & { data?: THREE.InterleavedBuffer };
      out.push(ia.data ? ia.data.version : ia.version);
    }
  });
  return out;
}

describe('car view', () => {
  for (const def of CARS) {
    describe(def.name, () => {
      it('is built to the car’s size, with finite geometry and few draw calls', () => {
        const v = new CarView(def);
        const s = def.visual;
        const body = named(v, 'body').geometry as THREE.BufferGeometry;
        const pos = body.getAttribute('position').array as Float32Array;
        for (const x of pos) expect(Number.isFinite(x)).toBe(true);
        body.computeBoundingBox();
        const bb = body.boundingBox!;
        const len = bb.max.z - bb.min.z;
        // (the LMP-X's splitter reaches 14 cm past its nose and its wing's end plates 14 cm past its tail, as on Xeno-Racer's model)
        expect(len).toBeGreaterThan(s.length - 0.1);
        expect(len).toBeLessThan(s.length + 0.3);
        expect(bb.max.x).toBeLessThan(s.width / 2 + 0.06);
        expect(bb.max.y).toBeGreaterThan(s.height - 0.08);
        expect(bb.max.y).toBeLessThan(s.height + 0.15);
        expect(bb.min.y).toBeGreaterThanOrEqual(0.03);
        expect(body.getAttribute('position').count).toBeLessThan(40000);
        // body, edges, 4 wheels, underglow; the Volta adds its two flaps (a mesh and edges each)
        expect(v.drawCalls).toBe(def.id === 'volta' ? 11 : 7);
        v.dispose();
      });

      it('sits its centre of mass on the pose, the body origin under it', () => {
        const v = new CarView(def);
        const s = def.visual;
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7);
        const p = new THREE.Vector3(100, 5, -2000);
        v.update(pose({ position: p, quaternion: q }), 1 / 60);
        v.object.updateMatrixWorld(true);
        const bodyMesh = named(v, 'body');
        const cgLocal = new THREE.Vector3(0, s.cgHeight, bodyCgZ(s));
        const cgWorld = cgLocal.clone().applyMatrix4(bodyMesh.matrixWorld);
        expect(cgWorld.distanceTo(p)).toBeLessThan(1e-4);
        v.dispose();
      });

      it('puts its wheels on the hubs (front-left at +x), steers them left for a positive angle and spins them forward', () => {
        const v = new CarView(def);
        const s = def.visual;
        const ws = wheels(v);
        expect(ws.length).toBe(4);
        v.update(pose(), 1 / 60);
        v.object.updateMatrixWorld(true);
        const body = named(v, 'body');
        const inv = body.matrixWorld.clone().invert();
        const hub = (i: number) => new THREE.Vector3().setFromMatrixPosition(ws[i].matrixWorld).applyMatrix4(inv);
        expect(hub(0).x).toBeCloseTo(s.trackFront / 2, 4);
        expect(hub(1).x).toBeCloseTo(-s.trackFront / 2, 4);
        expect(hub(2).x).toBeCloseTo(s.trackRear / 2, 4);
        expect(hub(0).z).toBeCloseTo(s.wheelbase / 2, 4);
        expect(hub(2).z).toBeCloseTo(-s.wheelbase / 2, 4);
        expect(hub(0).y).toBeCloseTo(s.wheelRadiusFront, 4);

        // steer left (+): the wheel's forward turns to the left (+x)
        const rel = (steerAngle: number, spin: number) => {
          const p = pose();
          (p.wheels as { steerAngle: number; spin: number }[])[0].steerAngle = steerAngle;
          (p.wheels as { steerAngle: number; spin: number }[])[0].spin = spin;
          v.update(p, 1 / 60);
          v.object.updateMatrixWorld(true);
          return body.matrixWorld.clone().invert().multiply(ws[0].matrixWorld);
        };
        const fwd = new THREE.Vector3(0, 0, 1).transformDirection(rel(0.3, 0));
        expect(fwd.x).toBeCloseTo(Math.sin(0.3), 4);
        // and roll forward (spin grows): the top of the wheel moves forward; the axle stays the steered one (rotY then rotX)
        const r = rel(0.3, 0.4);
        expect(new THREE.Vector3(0, 1, 0).transformDirection(r).z).toBeGreaterThan(0.3);
        const axle = new THREE.Vector3(1, 0, 0).transformDirection(r);
        expect(axle.z).toBeCloseTo(-Math.sin(0.3), 4);
        v.dispose();
      });

      it('rides its wheels with the suspension: compression 1 lifts the hub by the travel past the static sag', () => {
        const v = new CarView(def);
        const ws = wheels(v);
        const travel = def.physics.suspFront.travel;
        const p = pose();
        (p.wheels as unknown as { compression?: number }[])[0].compression = 1;
        v.update(p, 1 / 60);
        expect(ws[0].parent!.position.y - def.visual.wheelRadiusFront).toBeCloseTo((1 - 0.38) * travel, 5);
        v.dispose();
      });

      it('never writes a buffer after the build', () => {
        const v = new CarView(def);
        const before = versions(v);
        for (let i = 0; i < 120; i++) {
          v.update(
            pose({ brake: i % 2, aeroOpen: (i % 60) / 60, wheels: [0, 1, 2, 3].map((k) => ({ steerAngle: Math.sin(i * 0.1), spin: i * 0.7, compression: 0.3 + 0.01 * k })) }),
            1 / 60,
          );
        }
        expect(versions(v)).toEqual(before);
        v.dispose();
      });

      it('lights its brake lights and blurs its spokes by uniforms', () => {
        const v = new CarView(def);
        const u = (named(v, 'body').material as THREE.ShaderMaterial).uniforms;
        v.update(pose({ brake: 0 }), 1 / 60);
        const rest = u.uBrake.value as number;
        v.update(pose({ brake: 1 }), 1 / 60);
        expect(u.uBrake.value).toBeGreaterThan(rest * 2.5);
        // 300 km/h on these wheels: about 240 rad/s
        let spin = 0;
        for (let i = 0; i < 60; i++) {
          spin += 240 / 60;
          v.update(pose({ wheels: [0, 1, 2, 3].map(() => ({ steerAngle: 0, spin })) }), 1 / 60);
        }
        expect(u.uSpoke.value).toBeLessThan(0.02);
        expect(u.uBlur.value).toBeGreaterThan(0.98);
        v.dispose();
      });

      it('makes a ghost that stays under the bloom threshold and hides its own far side', () => {
        const v = new CarView(def, { ghost: true });
        const body = named(v, 'body');
        const m = body.material as THREE.ShaderMaterial;
        expect(m.transparent).toBe(true);
        expect(m.depthWrite).toBe(false);
        expect(m.blending).toBe(THREE.AdditiveBlending);
        // the brightest it draws: a glowing part at full opacity, 0.55 x the ghost colour; a surface at most 0.415 x it
        const g = m.uniforms.uGhost.value as THREE.Color;
        expect(lum(g) * 0.55).toBeLessThan(BLOOM);
        const edges = named(v, 'edges').material as THREE.ShaderMaterial & { color: THREE.Color; transparent: boolean };
        expect(edges.transparent).toBe(true);
        expect(lum(edges.color)).toBeLessThan(BLOOM);
        expect(v.object.getObjectByName('ghost-depth')).toBeTruthy();
        expect(v.object.getObjectByName('underglow')).toBeFalsy();
        v.dispose();
      });
    });
  }

  it('opens the Volta’s flaps with aeroOpen, and only the Volta has them', () => {
    const v = new CarView(getCar('volta'));
    const flap = named(v, 'rearFlaps').parent!;
    v.update(pose({ aeroOpen: 0 }), 1 / 60);
    const shut = flap.quaternion.angleTo(new THREE.Quaternion());
    for (let i = 0; i < 60; i++) v.update(pose({ aeroOpen: 1 }), 1 / 60);
    const open = flap.quaternion.angleTo(new THREE.Quaternion());
    expect(shut).toBeLessThan(0.01);
    expect(open).toBeGreaterThan(0.4);
    v.dispose();
    for (const id of ['lmp-x', 'dieci']) {
      const o = new CarView(getCar(id));
      expect(o.object.getObjectByName('rearFlaps')).toBeFalsy();
      o.dispose();
    }
  });

  it('shares one build between the views of a car and frees it with the last', () => {
    const def = getCar('dieci');
    const a = new CarView(def);
    const b = new CarView(def, { ghost: true });
    const ga = named(a, 'body').geometry;
    expect(named(b, 'body').geometry).toBe(ga);
    let freed = false;
    ga.addEventListener('dispose', () => (freed = true));
    a.dispose();
    expect(freed).toBe(false);
    b.dispose();
    expect(freed).toBe(true);
    // and a new view builds afresh
    const c = new CarView(def);
    expect(named(c, 'body').geometry).not.toBe(ga);
    c.dispose();
  });
});

// VehicleState is a CarPose (the game passes the physics state straight in)
import type { VehicleState } from '../src/core/contracts';
export const _vehicleStateIsAPose = (s: VehicleState): CarPose => s;
