/**
 * A stand-in world, car model and sound for working on the game before the real ones exist (`?dev` uses it): a straight flat road
 * with three checkpoints, a box with neon edges for a car, and silence.
 */
import * as THREE from 'three';
import { createFlatTrack } from './physics';
import type { CarDefinition, VehicleState } from './core/contracts';
import type { CarPoseLike, CarViewLike, SoundLike, StageInfo, World, WorldView } from './game';
import { PALETTE } from './render/palette';
import { bodyCgZ } from './core/contracts';

export function devWorld(): World {
  const group = new THREE.Group();
  const grid = new THREE.GridHelper(20000, 1000, PALETTE.magenta, PALETTE.cyan);
  (grid.material as THREE.LineBasicMaterial).transparent = true;
  (grid.material as THREE.LineBasicMaterial).opacity = 0.35;
  grid.position.z = 9000;
  group.add(grid);
  const edge = new THREE.LineBasicMaterial({ color: new THREE.Color(PALETTE.cyan).multiplyScalar(3) });
  for (const x of [-6, 6]) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, 0.02, -50), new THREE.Vector3(x, 0.02, 6000)]);
    group.add(new THREE.Line(g, edge));
  }
  const arches: THREE.Mesh[] = [];
  const cps = [1500, 3000, 4500];
  const archMat = { ahead: new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.cyan).multiplyScalar(1.5) }), next: new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.amber).multiplyScalar(3) }), passed: new THREE.MeshBasicMaterial({ color: 0x334455 }) };
  for (const s of cps) {
    const m = new THREE.Mesh(new THREE.TorusGeometry(8, 0.15, 6, 32, Math.PI), archMat.ahead);
    m.position.set(0, 0, s);
    group.add(m);
    arches.push(m);
  }
  const view: WorldView = { object: group, update: () => {} };
  const track = createFlatTrack({ halfWidth: 6, wall: 12, length: 6000 });
  return {
    views: [view],
    sunDirection: new THREE.Vector3(0, 0.1, 1).normalize(),
    groundHeight: () => 0,
    generate: (seed: number): StageInfo => ({ seed, track, checkpoints: cps, name: 'Proving Ground' }),
    newSeed: () => 100000 + Math.floor(Math.random() * 900000),
    activate: () => {},
    setCheckpoint: (i, state) => {
      if (arches[i]) arches[i].material = archMat[state];
    },
  };
}

export function devCarView(def: CarDefinition, opts: { ghost?: boolean } = {}): CarViewLike {
  const v = def.visual;
  const group = new THREE.Group();
  const body = new THREE.BoxGeometry(v.width, v.height - v.rideHeight, v.length);
  const color = opts.ghost ? PALETTE.magenta : PALETTE.cyan;
  const mesh = new THREE.Mesh(body, new THREE.MeshBasicMaterial({ color: 0x06030c, transparent: !!opts.ghost, opacity: opts.ghost ? 0.25 : 1 }));
  const lines = new THREE.LineSegments(new THREE.EdgesGeometry(body), new THREE.LineBasicMaterial({ color: new THREE.Color(color).multiplyScalar(opts.ghost ? 0.8 : 3) }));
  const inner = new THREE.Group();
  inner.add(mesh, lines);
  // the body origin is on the ground between the axles; the box's centre sits half its height above the ride height
  inner.position.set(0, v.rideHeight + (v.height - v.rideHeight) / 2 - v.cgHeight, (v.wheelbase / 2 + v.frontOverhang) - v.length / 2 - bodyCgZ(v));
  group.add(inner);
  return {
    object: group,
    update(pose: CarPoseLike) {
      group.position.copy(pose.position);
      group.quaternion.copy(pose.quaternion);
    },
    dispose() {
      body.dispose();
    },
  };
}

export function silentSound(): SoundLike {
  return {
    locked: false,
    setCar: () => {},
    update: (_s: VehicleState | null) => {},
    setVolume: () => {},
    ui: () => {},
  };
}
