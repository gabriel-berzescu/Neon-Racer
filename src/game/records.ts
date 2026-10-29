/**
 * Best times and ghosts, per stage (the seed), in localStorage.
 *
 *   neon-racer.records         JSON: { [seed]: StageRecord }: the best time and its splits and car, each car's best, runs, last played
 *   neon-racer.ghost.<seed>    the best run's ghost (src/game/ghost.ts encodeGhost)
 *
 * Ghosts are about 100 kB each, so only the GHOSTS_KEPT most recently played stages keep theirs (the times stay); when storage is full
 * anyway, the oldest ghosts go first. Without storage (a private window) nothing is kept and nothing fails.
 */
import { decodeGhost, encodeGhost, type Ghost } from './ghost';

const RECORDS_KEY = 'neon-racer.records';
const GHOST_PREFIX = 'neon-racer.ghost.';
export const GHOSTS_KEPT = 24;

export interface StageRecord {
  seed: number;
  /** The best time (s) on this stage, any car, and the car and the splits of that run. */
  best: number;
  car: string;
  splits: number[];
  /** Each car's best time here. */
  byCar: Record<string, number>;
  /** Runs finished here. */
  runs: number;
  /** When it was last played (ms since 1970). */
  played: number;
}

export interface FinishedRun {
  seed: number;
  car: string;
  time: number;
  splits: number[];
  ghost: Ghost;
}

export interface SaveResult {
  /** A new best on this stage (or its first finish). */
  best: boolean;
  /** A new best for this car on this stage. */
  carBest: boolean;
  /** The record after this run. */
  record: StageRecord;
  /** The previous best time, if there was one. */
  previous: number | null;
}

/** The part of Storage this module uses (tests pass a map). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class Records {
  constructor(private readonly store: StorageLike | null = defaultStorage()) {}

  all(): Record<string, StageRecord> {
    try {
      const raw = this.store?.getItem(RECORDS_KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : null;
      return v && typeof v === 'object' ? (v as Record<string, StageRecord>) : {};
    } catch {
      return {};
    }
  }

  get(seed: number): StageRecord | null {
    return this.all()[String(seed)] ?? null;
  }

  /** Stages played, most recent first. */
  recent(limit = 8): StageRecord[] {
    return Object.values(this.all())
      .sort((a, b) => b.played - a.played)
      .slice(0, limit);
  }

  ghost(seed: number): Ghost | null {
    try {
      return decodeGhost(this.store?.getItem(GHOST_PREFIX + seed));
    } catch {
      return null;
    }
  }

  /** A stage was started: it counts as played now (keeps its ghost among the recent ones). */
  touch(seed: number): void {
    const all = this.all();
    const r = all[String(seed)];
    if (!r) return;
    r.played = Date.now();
    this.write(all);
  }

  /** Files a finished run: a new best keeps its ghost and splits. */
  save(run: FinishedRun): SaveResult {
    const all = this.all();
    const key = String(run.seed);
    const old = all[key];
    const previous = old ? old.best : null;
    const best = !old || run.time < old.best;
    const carBest = !old || !(run.car in old.byCar) || run.time < old.byCar[run.car];
    const record: StageRecord = old
      ? { ...old, byCar: { ...old.byCar }, runs: old.runs + 1, played: Date.now() }
      : { seed: run.seed, best: run.time, car: run.car, splits: run.splits, byCar: {}, runs: 1, played: Date.now() };
    if (best) {
      record.best = run.time;
      record.car = run.car;
      record.splits = run.splits.slice();
    }
    if (carBest) record.byCar[run.car] = run.time;
    all[key] = record;
    this.write(all);
    if (best) this.writeGhost(run.seed, run.ghost, all);
    return { best, carBest, record, previous };
  }

  private write(all: Record<string, StageRecord>): void {
    try {
      this.store?.setItem(RECORDS_KEY, JSON.stringify(all));
    } catch {
      // full or unavailable: the times are small, so this only fails when storage is gone altogether
    }
  }

  private writeGhost(seed: number, ghost: Ghost, all: Record<string, StageRecord>): void {
    const store = this.store;
    if (!store) return;
    // keep ghosts only for the most recently played stages (this one included)
    const byAge = Object.values(all).sort((a, b) => b.played - a.played);
    for (const r of byAge.slice(GHOSTS_KEPT)) if (r.seed !== seed) this.dropGhost(r.seed);
    const text = encodeGhost(ghost);
    for (let tries = 0; tries <= byAge.length; tries++) {
      try {
        store.setItem(GHOST_PREFIX + seed, text);
        return;
      } catch {
        // storage full: drop the oldest other ghost and try again
        const victim = byAge.slice().reverse().find((r) => r.seed !== seed && this.hasGhost(r.seed));
        if (!victim) return;
        this.dropGhost(victim.seed);
      }
    }
  }

  private hasGhost(seed: number): boolean {
    try {
      return this.store?.getItem(GHOST_PREFIX + seed) != null;
    } catch {
      return false;
    }
  }

  private dropGhost(seed: number): void {
    try {
      this.store?.removeItem(GHOST_PREFIX + seed);
    } catch {
      // nothing to do
    }
  }
}
