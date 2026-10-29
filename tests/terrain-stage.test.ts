/**
 * The terrain with a stage: the world shifted so the stage lies at the origin, and the road carved in (src/world/stage-field.ts),
 * on the CPU. (The GPU twin is compared with this in the browser: sandbox/road.html?check=1, window.__CHECK__.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { generateStage, groundHeightAt, setActiveStage } from '../src/world/stage';
import { carveHeight, SC } from '../src/world/stage-field';
import { FORMATION } from '../src/world/stage-track';
import { baseHeightAt, getTerrainShift, heightAt, worldHeightAt } from '../src/world/terrain';

const stages = [generateStage(12345), generateStage(1), generateStage(110)];
afterEach(() => setActiveStage(null));

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('the terrain with a stage', () => {
  it('without a stage is Neon-Flight\'s world, unshifted and untouched', () => {
    setActiveStage(null);
    expect(getTerrainShift()).toEqual({ x: 0, z: 0 });
    for (const [x, z] of [[0, 0], [1234.5, -987.25], [-30000, 41000]]) {
      expect(heightAt(x, z)).toBe(worldHeightAt(x, z));
      expect(baseHeightAt(x, z)).toBe(worldHeightAt(x, z));
    }
  });

  it('moves the world so the stage lies at the origin', () => {
    const st = stages[0];
    setActiveStage(st);
    expect(getTerrainShift()).toEqual(st.shift);
    expect(Math.hypot(st.shift.x, st.shift.z)).toBeGreaterThan(1000);
    for (const [x, z] of [[0, 0], [500, -700], [-6000, 3000]]) expect(baseHeightAt(x, z)).toBe(worldHeightAt(x + st.shift.x, z + st.shift.z));
  });

  it('lies just under the road across the whole formation (the road\'s mesh lies on it)', () => {
    for (const st of stages) {
      setActiveStage(st);
      const tr = st.track;
      const p = new Vector3();
      const r = rng(st.seed);
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 0; k < 3000; k++) {
        const s = tr.sStart + r() * (tr.sEnd - tr.sStart);
        const d = (r() * 2 - 1) * (FORMATION - 0.6);
        tr.pointAt(s, d, p);
        const below = p.y - heightAt(p.x, p.z);
        lo = Math.min(lo, below);
        hi = Math.max(hi, below);
      }
      // (depth0 under the road, and a quarter of the smooth minimum's width more where the land is level with it)
      expect(lo).toBeGreaterThan(SC.depth0 - 0.05);
      expect(hi).toBeLessThan(SC.depth0 + SC.k0 / 4 + 0.1);
    }
  });

  it('meets the land with embankments and cuttings: never steeper than the cut, the land itself or the fade allows', () => {
    for (const st of stages) {
      setActiveStage(st);
      const tr = st.track;
      const a = new Vector3();
      let worst = 0;
      for (let s = 50; s < tr.length; s += 97) {
        // a line across the road from 200 m left to 200 m right, every 0.5 m
        let prev = NaN;
        let prevBase = NaN;
        for (let d = -200; d <= 200; d += 0.5) {
          tr.pointAt(s, d, a);
          const h = heightAt(a.x, a.z);
          const b = baseHeightAt(a.x, a.z);
          if (!Number.isNaN(prev)) {
            // the carve's slope beyond the land's own (the cut is the steepest designed slope; the fade adds the difference between
            // the carve and the land over its 60 m)
            const extra = Math.abs(h - prev) - Math.abs(b - prevBase);
            worst = Math.max(worst, extra / 0.5);
          }
          prev = h;
          prevBase = b;
        }
      }
      expect(worst).toBeLessThan(SC.cut + 0.5);
    }
  });

  it('is the plain terrain, exactly, away from the road', () => {
    for (const st of stages) {
      setActiveStage(st);
      const tr = st.track;
      const r = rng(st.seed + 1);
      let far = 0;
      for (let k = 0; k < 4000; k++) {
        const x = tr.bounds.minX - 500 + r() * (tr.bounds.maxX - tr.bounds.minX + 1000);
        const z = tr.bounds.minZ - 500 + r() * (tr.bounds.maxZ - tr.bounds.minZ + 1000);
        let dmin = Infinity;
        for (let i = 0; i < tr.nAll; i += 2) dmin = Math.min(dmin, Math.hypot(tr.X[i] - x, tr.Z[i] - z));
        if (dmin > FORMATION + SC.fade1 + 6) {
          expect(heightAt(x, z)).toBe(baseHeightAt(x, z));
          far++;
        }
      }
      expect(far).toBeGreaterThan(1000);
    }
  });

  it('has a field that knows the distance to the road and the road\'s level', () => {
    const st = stages[1];
    const tr = st.track;
    const out = new Float64Array(2);
    const p = new Vector3();
    const r = rng(7);
    let worstU = 0;
    let worstF = 0;
    for (let k = 0; k < 4000; k++) {
      const s = r() * tr.length;
      const d = (r() * 2 - 1) * FORMATION;
      tr.pointAt(s, d, p);
      expect(st.field.sample(p.x, p.z, out)).toBe(true);
      worstU = Math.max(worstU, Math.abs(out[0] - Math.abs(d)));
      worstF = Math.max(worstF, Math.abs(out[1] - p.y));
    }
    // (bilinear over 4 m: the distance creases on the centreline itself, where the formation is flat whatever it says; the level
    // is the road's to a few centimetres, well inside the formation's depth under the road)
    expect(worstU).toBeLessThan(2.1);
    expect(worstF).toBeLessThan(0.1);
  });

  it('is continuous everywhere around the road (no steps for the mesh, the camera or the shading)', () => {
    for (const st of stages) {
      setActiveStage(st);
      const b = st.track.bounds;
      const r = rng(st.seed + 2);
      let worst = 0;
      for (let k = 0; k < 3000; k++) {
        const x = b.minX + r() * (b.maxX - b.minX);
        const z = b.minZ + r() * (b.maxZ - b.minZ);
        const e = 0.01;
        const g = Math.abs(heightAt(x + e, z) - heightAt(x, z)) / e;
        const gb = Math.abs(baseHeightAt(x + e, z) - baseHeightAt(x, z)) / e;
        worst = Math.max(worst, g - gb);
      }
      expect(worst).toBeLessThan(3);
    }
  });

  it('carves the same function the shader does at every level: identity beyond the fade, the formation widening with q', () => {
    // the formation is flat to its edge plus pad, sinking with q, and the carve is continuous in q (no cracks between levels)
    const F = 100;
    for (const q of [0, 2, 6, 14, 30, 62, 126]) {
      const pad = Math.min(q, SC.padMax);
      const depth = Math.min(SC.depth0 + SC.depthK * q * q, SC.depthMax);
      expect(carveHeight(F + 30, FORMATION + pad - 0.01, F, q)).toBeLessThanOrEqual(F - depth + 1e-9);
      expect(carveHeight(F - 30, FORMATION + pad - 0.01, F, q)).toBeGreaterThanOrEqual(F - depth - SC.k0 / 4 - 1e-9);
      expect(carveHeight(F + 50, FORMATION + pad + SC.fade1 + 0.01, F, q)).toBe(F + 50);
      expect(Math.abs(carveHeight(F + 20, 30, F, q + 1e-4) - carveHeight(F + 20, 30, F, q))).toBeLessThan(1e-3);
    }
  });

  it('keeps heightAt fast with a stage carved in', () => {
    const st = stages[0];
    setActiveStage(st);
    const p = new Vector3();
    const pts: number[] = [];
    for (let s = 0; s < 4000; s += 2) {
      st.track.pointAt(s, ((s * 13) % 160) - 80, p);
      pts.push(p.x, p.z);
    }
    let acc = 0;
    const t0 = performance.now();
    for (let rep = 0; rep < 5; rep++) for (let k = 0; k < pts.length; k += 2) acc += heightAt(pts[k], pts[k + 1]);
    const us = ((performance.now() - t0) * 1000) / ((pts.length / 2) * 5);
    console.log(`heightAt near the road: ${us.toFixed(2)} us per call`);
    expect(Number.isFinite(acc)).toBe(true);
    expect(us).toBeLessThan(3);
    // and the camera's ground is that terrain, the sea's surface where it is below
    expect(groundHeightAt(pts[0], pts[1])).toBe(Math.max(0, heightAt(pts[0], pts[1])));
  });

  it('generates complete GLSL for the shader twin', async () => {
    const { STAGE_GLSL, TERRAIN_VERT, TERRAIN_FRAG } = await import('../src/render/terrainGlsl');
    for (const src of [STAGE_GLSL, TERRAIN_VERT, TERRAIN_FRAG]) expect(src).not.toMatch(/NaN|undefined|Infinity|object Object/);
    expect(TERRAIN_VERT).toContain('stageApply(hd, P, c * (1.0 + alpha) - 2.0)');
  });
});
