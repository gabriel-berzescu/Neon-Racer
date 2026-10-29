/**
 * RoadView (src/render/road.ts), headless: it builds the road in culled chunks with few materials, and the checkpoints swap shared
 * materials without touching a buffer.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { RoadView } from '../src/render/road';
import { generateStage } from '../src/world/stage';
import { FORMATION } from '../src/world/stage-track';

const stage = generateStage(4242);

describe('the road view', () => {
  const road = new RoadView();
  road.setStage(stage);
  const meshes: THREE.Mesh[] = [];
  road.object.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });

  it('builds the stage in chunks, each culled by its own bounds, from a handful of materials', () => {
    const chunks = meshes.filter((m) => m.name === 'road-chunk');
    expect(chunks.length).toBeGreaterThan(30);
    expect(chunks.length).toBeLessThan(80);
    for (const m of meshes) {
      expect(m.frustumCulled).toBe(true);
      expect(m.geometry.boundingSphere).not.toBeNull();
      expect(m.geometry.boundingSphere!.radius).toBeLessThan(400);
    }
    const mats = new Set(meshes.map((m) => m.material));
    expect(mats.size).toBeLessThanOrEqual(8);
    let tris = 0;
    for (const m of meshes) tris += (m.geometry.index?.count ?? 0) / 3;
    expect(tris).toBeLessThan(150000);
  });

  it('lies on the surface the physics drives on, in small coordinates around each chunk', () => {
    const p = new THREE.Vector3();
    for (const m of meshes.filter((x) => x.name === 'road-chunk').slice(0, 12)) {
      const pos = m.geometry.getAttribute('position');
      const att = m.geometry.getAttribute('aRoad');
      for (let i = 0; i < pos.count; i += 7) {
        const d = att.getY(i);
        if (Math.abs(d) > FORMATION) continue; // (the skirt)
        stage.track.pointAt(att.getX(i), d, p);
        expect(Math.abs(pos.getX(i) + m.position.x - p.x)).toBeLessThan(0.01);
        expect(Math.abs(pos.getY(i) + m.position.y - p.y)).toBeLessThan(0.01);
        expect(Math.abs(pos.getZ(i))).toBeLessThan(400);
      }
    }
  });

  it('shows a checkpoint\'s state by swapping shared materials, never by rewriting buffers', () => {
    const versions = meshes.map((m) => Object.values(m.geometry.attributes).map((a) => (a as THREE.BufferAttribute).version).join(','));
    const n = stage.checkpoints.length;
    const before = new Set(meshes.map((m) => m.material));
    road.setCheckpoint(0, 'passed');
    road.setCheckpoint(1, 'next');
    road.setCheckpoint(n - 1, 'ahead');
    road.update(new THREE.PerspectiveCamera(), 1.25);
    const after = new Set(meshes.map((m) => m.material));
    expect(meshes.map((m) => Object.values(m.geometry.attributes).map((a) => (a as THREE.BufferAttribute).version).join(','))).toEqual(versions);
    for (const m of after) expect(before.has(m) || m instanceof THREE.ShaderMaterial).toBe(true);
    // the three states are three different materials
    const states = new Set<THREE.Material>();
    road.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) states.add(m.material as THREE.Material);
    });
    expect(states.size).toBeGreaterThanOrEqual(5);
  });

  it('clears and rebuilds for another stage', () => {
    road.setStage(generateStage(777));
    let n = 0;
    road.object.traverse(() => n++);
    expect(n).toBeGreaterThan(50);
    road.setStage(null);
    expect(road.object.children.length).toBe(0);
    road.dispose();
  });
});
