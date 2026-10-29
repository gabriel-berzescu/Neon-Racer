import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { COUNTDOWN, StageRun, formatDelta, formatTime } from '../src/game/run';
import { GhostPlayer, GhostRecorder, decodeGhost, encodeGhost, makeGhostPose } from '../src/game/ghost';
import { Records, type StorageLike } from '../src/game/records';

describe('a stage run', () => {
  it('counts down, then times the checkpoints and stops at the finish', () => {
    const run = new StageRun([1000, 2000, 3000], [10, 20, 30]);
    const dt = 1 / 60;
    for (let t = 0; t < COUNTDOWN + 1e-9; t += dt) run.update(dt, 0);
    expect(run.phase).toBe('running');
    // 100 m/s: checkpoint 1 at 10 s, a reference split of 10 s
    let s = 0;
    const events = [];
    while (!run.finished && run.time < 60) {
      s += 100 * dt;
      const e = run.update(dt, s, 100);
      if (e) events.push(e);
    }
    expect(events.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(events[2].finish).toBe(true);
    expect(run.time).toBeCloseTo(30, 1);
    expect(Math.abs(events[0].delta!)).toBeLessThan(0.05);
    // the clock stops at the finish
    const t = run.time;
    run.update(dt, s + 10, 100);
    expect(run.time).toBe(t);
  });

  it('ignores a progress jump no car could make', () => {
    const run = new StageRun([500, 1000], null);
    run.update(COUNTDOWN, 0);
    run.update(1 / 60, 10, 50);
    expect(run.update(1 / 60, 700, 50)).toBeNull(); // a glitch onto another part of the road, not driving
    expect(run.progress).toBe(10);
    run.update(1 / 60, 11, 50); // and back where it was
    expect(run.progress).toBe(11);
  });

  it('warns about driving the wrong way after a moment', () => {
    const run = new StageRun([500], null);
    run.update(COUNTDOWN, 0);
    for (let i = 0; i < 90; i++) run.update(1 / 60, 0, -10);
    expect(run.wrongWay).toBeGreaterThan(1.4);
  });

  it('formats times and deltas', () => {
    expect(formatTime(83.4564)).toBe('1:23.456');
    expect(formatTime(9.5)).toBe('9.500');
    expect(formatTime(119.9999)).toBe('2:00.000');
    expect(formatTime(61.05, 2)).toBe('1:01.05');
    expect(formatDelta(-1.234)).toBe('-1.23');
    expect(formatDelta(0.5)).toBe('+0.50');
  });
});

describe('ghosts', () => {
  /** A car going round a 50 m circle at 20 m/s, filmed at an uneven frame rate. */
  function circle(t: number) {
    const w = 20 / 50;
    const a = w * t;
    return {
      position: new Vector3(50 * Math.sin(a), 1, 50 * (1 - Math.cos(a))),
      quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), a),
      brake: t > 5 ? 1 : 0,
      wheels: [{ steerAngle: 0.06 }, { steerAngle: 0.05 }, { steerAngle: 0 }, { steerAngle: 0 }],
    };
  }

  it('plays back what it recorded, between the samples too', () => {
    const rec = new GhostRecorder();
    let t = 0;
    for (let i = 0; t < 10; i++) {
      rec.record(t, circle(t));
      t += i % 3 === 0 ? 1 / 30 : 1 / 144; // uneven frames
    }
    const ghost = decodeGhost(encodeGhost(rec.finish()))!;
    expect(ghost.count).toBeGreaterThan(195);
    const player = new GhostPlayer(ghost, 0.33, 0.34);
    expect(player.duration).toBeGreaterThan(9.9);
    const pose = makeGhostPose();
    for (const tt of [0.5, 3.333, 7.77, 9.21]) {
      player.pose(tt, pose);
      const want = circle(tt);
      expect(pose.position.distanceTo(want.position)).toBeLessThan(0.02);
      expect(Math.abs(pose.quaternion.angleTo(want.quaternion))).toBeLessThan(0.01);
    }
    player.pose(8, pose);
    expect(pose.brake).toBe(1);
    expect(pose.wheels[0].steerAngle).toBeCloseTo(0.055, 2);
    // the wheels roll by the distance covered: 20 m/s for 8 s on a 0.33 m wheel
    expect(pose.wheels[0].spin).toBeCloseTo((20 * 8) / 0.33, -1);
  });

  it('refuses text that is not a ghost', () => {
    expect(decodeGhost('nonsense')).toBeNull();
    expect(decodeGhost('1.20.5.AAAA')).toBeNull();
    expect(decodeGhost(null)).toBeNull();
  });
});

describe('records', () => {
  class MapStore implements StorageLike {
    readonly m = new Map<string, string>();
    limit = Infinity;
    getItem(k: string) {
      return this.m.get(k) ?? null;
    }
    setItem(k: string, v: string) {
      const size = [...this.m.entries()].reduce((n, [kk, vv]) => n + (kk === k ? 0 : vv.length), 0) + v.length;
      if (size > this.limit) throw new Error('QuotaExceededError');
      this.m.set(k, v);
    }
    removeItem(k: string) {
      this.m.delete(k);
    }
  }
  const ghost = () => {
    const rec = new GhostRecorder();
    for (let t = 0; t < 30; t += 1 / 60) rec.record(t, { position: new Vector3(t, 0, 0), quaternion: new Quaternion(), brake: 0, wheels: [{ steerAngle: 0 }, { steerAngle: 0 }] });
    return rec.finish();
  };

  it('keeps the best time with its ghost and each car best', () => {
    const r = new Records(new MapStore());
    expect(r.save({ seed: 42, car: 'volta', time: 100, splits: [50, 100], ghost: ghost() }).best).toBe(true);
    const slower = r.save({ seed: 42, car: 'dieci', time: 105, splits: [52, 105], ghost: ghost() });
    expect(slower.best).toBe(false);
    expect(slower.carBest).toBe(true);
    expect(slower.previous).toBe(100);
    const rec = r.get(42)!;
    expect(rec.best).toBe(100);
    expect(rec.car).toBe('volta');
    expect(rec.byCar).toEqual({ volta: 100, dieci: 105 });
    expect(rec.runs).toBe(2);
    expect(r.ghost(42)?.count).toBeGreaterThan(500);
  });

  it('drops the oldest ghosts when storage is full, never the times', () => {
    const store = new MapStore();
    const r = new Records(store);
    const g = ghost();
    const size = encodeGhost(g).length;
    store.limit = size * 3.5;
    for (let seed = 1; seed <= 5; seed++) r.save({ seed, car: 'lmp-x', time: 90 + seed, splits: [90 + seed], ghost: g });
    expect(r.ghost(5)).not.toBeNull();
    expect(r.ghost(1)).toBeNull();
    expect(Object.keys(r.all())).toHaveLength(5);
  });

  it('works without storage', () => {
    const r = new Records(null);
    expect(r.save({ seed: 1, car: 'volta', time: 1, splits: [1], ghost: ghost() }).best).toBe(true);
    expect(r.recent()).toEqual([]);
  });
});
