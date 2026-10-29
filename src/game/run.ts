/**
 * One run of a stage: the countdown, the clock, the checkpoints and the splits.
 *
 * The car starts at a standstill behind the start line; the clock starts at GO (a standing start, as in a rally stage or a hill
 * climb) and stops when the car crosses the finish line, the last checkpoint. Each checkpoint's split is compared with the reference
 * run's (the best run on this stage, whose ghost is on the road), and the delta is shown for a few seconds.
 *
 * Progress is the furthest distance along the road the car has reached, from TrackRuntime.project each frame. It only moves forward,
 * and never by more than PROGRESS_WINDOW at once, so a projection that jumps to another part of the road does not tick off
 * checkpoints the car never reached; it picks up again as soon as the car is back where it was.
 */

export type RunPhase = 'countdown' | 'running' | 'finished';

/** Seconds of countdown: "3", "2", "1", then GO at 0. */
export const COUNTDOWN = 3;

/** Progress never jumps further than this in one go (m): more is a projection onto another part of the road, not driving. */
const PROGRESS_WINDOW = 60;

export interface CheckpointEvent {
  /** Index into the stage's checkpoints; the last one is the finish. */
  index: number;
  /** The split: seconds since GO. */
  time: number;
  /** Against the reference run's split at this checkpoint (negative = ahead); null without a reference. */
  delta: number | null;
  finish: boolean;
}

export class StageRun {
  phase: RunPhase = 'countdown';
  /** Seconds left of the countdown (0 once running). */
  countdown = COUNTDOWN;
  /** Seconds since GO (the final time once finished). */
  time = 0;
  /** The furthest distance along the road reached (m). */
  progress: number;
  /** The checkpoint to reach next (checkpoints.length once finished). */
  next = 0;
  readonly splits: number[] = [];
  /** The latest checkpoint passed, for the HUD. */
  last: CheckpointEvent | null = null;
  /** Seconds the car has been heading the wrong way along the road (the HUD warns after a moment). */
  wrongWay = 0;

  constructor(
    readonly checkpoints: readonly number[],
    /** The reference run's splits (its last entry is its finish time), or null. */
    readonly reference: readonly number[] | null,
    startS = 0,
  ) {
    this.progress = startS;
  }

  get finished(): boolean {
    return this.phase === 'finished';
  }

  /** The reference run's time at the finish, or null. */
  get referenceTime(): number | null {
    return this.reference && this.reference.length === this.checkpoints.length ? this.reference[this.reference.length - 1] : null;
  }

  /**
   * Advance by `dt`. `s` is the car's distance along the road now; `forward` its speed along the road (m/s, negative = backwards).
   * Returns the checkpoint passed this frame, if any.
   */
  update(dt: number, s: number, forward = 0): CheckpointEvent | null {
    if (this.phase === 'countdown') {
      this.countdown = Math.max(0, this.countdown - dt);
      if (this.countdown === 0) this.phase = 'running';
      return null;
    }
    if (this.phase === 'finished') return null;
    this.time += dt;
    this.wrongWay = forward < -2 ? this.wrongWay + dt : 0;
    if (s > this.progress && s - this.progress <= PROGRESS_WINDOW) this.progress = s;
    const cp = this.checkpoints[this.next];
    if (cp === undefined || this.progress < cp) return null;
    const index = this.next++;
    this.splits.push(this.time);
    const ref = this.reference?.[index];
    const finish = index === this.checkpoints.length - 1;
    if (finish) this.phase = 'finished';
    this.last = { index, time: this.time, delta: ref === undefined ? null : this.time - ref, finish };
    return this.last;
  }
}

/** 83.456 -> "1:23.456" (or "23.456" under a minute). */
export function formatTime(seconds: number, decimals = 3): string {
  const k = 10 ** decimals;
  const t = Math.round(Math.max(0, seconds) * k) / k;
  const m = Math.floor(t / 60);
  const rest = t - m * 60;
  const sec = rest.toFixed(decimals).padStart(decimals + 3, '0');
  return m > 0 ? `${m}:${sec}` : rest.toFixed(decimals);
}

/** -1.234 -> "-1.23", 0.5 -> "+0.50". */
export function formatDelta(delta: number): string {
  const sign = delta < 0 ? '-' : '+';
  return `${sign}${Math.abs(delta).toFixed(2)}`;
}
