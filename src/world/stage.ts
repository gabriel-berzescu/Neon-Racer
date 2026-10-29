/**
 * Stages: a point-to-point road, 9 to 13 km, generated from a seed and carved into a place in Neon-Flight's world.
 *
 *   generateStage(seed)   deterministic (the same seed is the same stage on every machine); about 0.2-0.4 s
 *   setActiveStage(stage) carves it into the terrain on the CPU side (the chase camera's ground, heightAt) and moves the world so
 *                         the stage lies around the origin; also give it to TerrainView.setStage and RoadView.setStage (the picture)
 *   groundHeightAt(x, z)  the terrain as rendered, the carve included (the sea's surface where the land is below it)
 *
 * How a stage is made (each step in its own file):
 *   1. the place (here): a spot in the world chosen by the seed, on land, in plains, valleys and passes with mountains around for the
 *      view; the world is shifted so it lies at the origin (float32 keeps millimetres within the stage's 8 km);
 *   2. the plan (stage-plan.ts): the road's line, designed corner by corner (transition curves, straights up to a kilometre, sweepers,
 *      esses, chicanes, tight corners and hairpins), steered over the land;
 *   3. the profile (stage-profile.ts): its height (grades up to 8 %, crests the cars stay pressed to at their speed) and banking;
 *   4. the track (stage-track.ts): the TrackRuntime the physics drives on, with the run-off and the barriers;
 *   5. the carve (stage-field.ts): the terrain flattened under the road, with embankments and cuttings beyond, CPU = GPU;
 *   6. the checkpoints (about every 1.75 km, on the quieter parts of the road; the last is the finish line) and a name.
 */
import type { TrackInfo } from '../core/contracts';
import { buildStageField, type StageField } from './stage-field';
import { clamp, rng, uni, wrapAngle } from './stage-math';
import { generatePlan, type Plan } from './stage-plan';
import { buildProfile, type Profile } from './stage-profile';
import { StageTrack } from './stage-track';
import { groundAt, setActiveStageField, setTerrainShift, worldHeightAt } from './terrain';

export interface StageStats {
  /** Start line to finish line (m). */
  length: number;
  corners: number;
  /** Corners tighter than 52 m (full lock, both thumbs). */
  tight: number;
  /** Straights of 500 m and more. */
  longStraights: number;
  minRadius: number;
  maxGrade: number;
  /** Metres climbed and descended from start to finish. */
  climb: number;
  descent: number;
  /** Lowest and highest road (m above sea level). */
  minY: number;
  maxY: number;
  /** The deepest cutting and the highest embankment under the centreline (m: the land above the road, the road above the land). */
  maxCut: number;
  maxFill: number;
  /** Generation time (ms) and its parts. */
  ms: { total: number; place: number; plan: number; profile: number; field: number };
}

export interface Stage {
  readonly seed: number;
  /**
   * The physics' world: road, run-off, barriers. s = 0 at the start line, track.length at the finish line; project() also gives
   * s < 0 on the grid behind the start line and s > length in the run-out past the finish (wrapS clamps to [0, length]). An open
   * road: nothing wraps. grid[0] is where the car starts, at a standstill, on the centreline just behind the start line.
   */
  readonly track: StageTrack;
  /** Checkpoints along the road (s, m), ascending; the last one is the finish line (= track.length). */
  readonly checkpoints: readonly number[];
  /** A short display name generated from the seed ("Violet Pass"). */
  readonly name: string;
  /** Where the stage is in Neon-Flight's world: the world position of the local origin (the start line). */
  readonly shift: { readonly x: number; readonly z: number };
  readonly plan: Plan;
  readonly profile: Profile;
  readonly field: StageField;
  readonly stats: StageStats;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The place
// ---------------------------------------------------------------------------------------------------------------------------------

/** A place for the stage: on land, gently rolling around the start, with high ground in view. */
function findPlace(seed: number, tries: number): { x: number; z: number; heading: number } {
  const r = rng(((seed ^ 0x6a09e667) + Math.imul(tries, 0x9e3779b1)) >>> 0);
  let best = { x: 0, z: 0, heading: 0 };
  let bestCost = Infinity;
  for (let c = 0; c < 64 || !Number.isFinite(bestCost); c++) {
    const wx = uni(r, -180000, 180000);
    const wz = uni(r, -180000, 180000);
    const h0 = worldHeightAt(wx, wz);
    if (h0 < 30 || h0 > 700) continue;
    let water = 0;
    let dev = 0;
    let nDev = 0;
    let peak = -Infinity;
    let cnt = 0;
    for (const rad of [1200, 2500, 4000, 6000, 8500]) {
      for (let a = 0; a < 12; a++) {
        const ang = ((a + (rad % 7) * 0.13) / 12) * Math.PI * 2;
        const h = worldHeightAt(wx + Math.sin(ang) * rad, wz + Math.cos(ang) * rad);
        cnt++;
        if (h < 10) water++;
        if (rad <= 4000) {
          dev += Math.abs(h - h0);
          nDev++;
        }
        peak = Math.max(peak, h);
      }
    }
    // the start itself: smooth ground within 600 m (no canyon's rim under the grid)
    let near = 0;
    for (const rad of [150, 350, 600]) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        near = Math.max(near, Math.abs(worldHeightAt(wx + Math.sin(ang) * rad, wz + Math.cos(ang) * rad) - h0) / rad);
      }
    }
    const cost = (water / cnt) * 8 + dev / nDev / 220 + (peak - h0 < 350 ? 1.2 : 0) + Math.max(0, near - 0.05) * 25 + uni(r, 0, 0.4);
    if (cost < bestCost) {
      bestCost = cost;
      best = { x: wx, z: wz, heading: 0 };
    }
    if (c > 400) break;
  }
  // the start's heading: the gentlest 2 km ahead, towards the sun if the land allows
  let bh = 0;
  let bhc = Infinity;
  const off = r() * Math.PI * 2;
  for (let k = 0; k < 24; k++) {
    const hd = off + (k / 24) * Math.PI * 2;
    const sx = Math.sin(hd);
    const sz = Math.cos(hd);
    let prev = worldHeightAt(best.x, best.z);
    let cost = 0;
    for (let d = 100; d <= 2000; d += 100) {
      const h = worldHeightAt(best.x + sx * d, best.z + sz * d);
      const grade = Math.abs(h - prev) / 100;
      cost += Math.max(0, grade - 0.04) * 10 + (h < 12 ? 5 : 0);
      prev = h;
    }
    // (the sun is due north, low on the horizon: a start towards it is the poster)
    cost += 0.5 * (1 + Math.cos(hd)) + uni(r, 0, 0.6);
    if (cost < bhc) {
      bhc = cost;
      bh = hd;
    }
  }
  best.heading = wrapAngle(bh);
  return best;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The name
// ---------------------------------------------------------------------------------------------------------------------------------

const FIRST = ['Violet', 'Neon', 'Cobalt', 'Magenta', 'Midnight', 'Ultra', 'Electric', 'Chrome', 'Laser', 'Velvet', 'Static', 'Ion', 'Prism', 'Vapor', 'Nova', 'Indigo', 'Saffron', 'Cyan', 'Phantom', 'Quartz', 'Ember', 'Echo', 'Solar', 'Lunar', 'Polar', 'Turbo', 'Glass', 'Arcade', 'Pulse', 'Afterglow'];
const LAST_FLAT = ['Run', 'Sprint', 'Highway', 'Straights', 'Flats', 'Mile', 'Boulevard', 'Causeway', 'Drive', 'Express'];
const LAST_HILLY = ['Pass', 'Ridge', 'Climb', 'Summit', 'Heights', 'Col', 'Crest', 'Divide', 'Gap', 'Saddle'];
const LAST_DOWN = ['Descent', 'Drop', 'Falls', 'Valley', 'Hollow', 'Glen', 'Vale'];
const LAST_TWISTY = ['Switchbacks', 'Twist', 'Serpent', 'Loops', 'Esses', 'Ribbon', 'Snake', 'Hairpins'];

function stageName(seed: number, st: { climb: number; descent: number; tight: number; length: number; maxY: number; minY: number }): string {
  const r = rng((seed ^ 0x3c6ef372) >>> 0);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
  const first = pick(FIRST);
  let last: string;
  const relief = st.maxY - st.minY;
  if (st.tight >= 6) last = pick(LAST_TWISTY);
  else if (relief > 140 && st.climb > st.descent * 1.4) last = pick(LAST_HILLY);
  else if (relief > 140 && st.descent > st.climb * 1.4) last = pick(LAST_DOWN);
  else if (relief < 70) last = pick(LAST_FLAT);
  else last = pick([...LAST_HILLY, ...LAST_FLAT, ...LAST_TWISTY]);
  return `${first} ${last}`;
}

const COLORS = ['#22f3ff', '#ff2bd6', '#ffa230', '#9d7bff', '#4dff9a', '#ff5470'];

// ---------------------------------------------------------------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------------------------------------------------------------

/** The stage for `seed` (any integer; 5-6 digits are friendly to share). Deterministic. */
export function generateStage(seed: number): Stage {
  seed = Math.floor(Math.abs(seed)) >>> 0;
  const t0 = performance.now();
  // the place, and the road over it (on the rare land where no road fits, another place: still the same for this seed)
  let place = findPlace(seed, 0);
  let base = (x: number, z: number): number => worldHeightAt(x + place.x, z + place.z);
  const t1 = performance.now();
  let plan = generatePlan({ seed, base, heading: place.heading });
  for (let tries = 1; !plan; tries++) {
    place = findPlace(seed, tries);
    const p = place;
    base = (x: number, z: number): number => worldHeightAt(x + p.x, z + p.z);
    plan = generatePlan({ seed: seed + tries * 7919, base, heading: place.heading });
  }
  const t2 = performance.now();
  const profile = buildProfile(plan, base);
  const t3 = performance.now();

  // statistics
  let maxGrade = 0;
  let climb = 0;
  let descent = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  const i0 = Math.round(-plan.sStart / plan.spacing);
  const iF = i0 + Math.round(plan.length / plan.spacing);
  let maxCut = 0;
  let maxFill = 0;
  for (let i = i0; i <= iF; i++) {
    if (i % 5 === 0) {
      const dy = profile.y[i] - base(plan.x[i], plan.z[i]);
      maxFill = Math.max(maxFill, dy);
      maxCut = Math.max(maxCut, -dy);
    }
    maxGrade = Math.max(maxGrade, Math.abs(profile.m[i]));
    if (i > i0) {
      const dy = profile.y[i] - profile.y[i - 1];
      if (dy > 0) climb += dy;
      else descent -= dy;
    }
    minY = Math.min(minY, profile.y[i]);
    maxY = Math.max(maxY, profile.y[i]);
  }
  const inStage = plan.corners.filter((c) => c.s1 > 0 && c.s0 < plan.length);
  const tight = inStage.filter((c) => c.radius < 52).length;
  let longStraights = 0;
  {
    let run = 0;
    for (let i = i0; i <= iF; i++) {
      if (Math.abs(plan.kappa[i]) < 1e-6) run += plan.spacing;
      else {
        if (run >= 500) longStraights++;
        run = 0;
      }
    }
    if (run >= 500) longStraights++;
  }

  const name = stageName(seed, { climb, descent, tight, length: plan.length, maxY, minY });
  const info: TrackInfo = {
    id: `stage-${seed}`,
    name,
    location: 'Neon-Flight world',
    description: `${(plan.length / 1000).toFixed(1)} km, ${inStage.length} corners`,
    difficulty: clamp(Math.round(1 + tight / 2.2), 1, 5) as 1 | 2 | 3 | 4 | 5,
    defaultLaps: 1,
    lengthHint: plan.length,
    color: COLORS[seed % COLORS.length],
    floodlit: true,
  };
  let field: StageField | null = null;
  const outside = (x: number, z: number): number => {
    const h = base(x, z);
    const c = field ? field.apply(h, x, z) : h;
    return c > 0 ? c : 0;
  };
  const track = new StageTrack({ plan, profile, info, outside });
  field = buildStageField(track);
  const t4 = performance.now();

  // checkpoints: evenly spread, each moved to the straightest road within 220 m of its place
  const count = clamp(Math.round(plan.length / 1750), 5, 8);
  const checkpoints: number[] = [];
  for (let k = 1; k < count; k++) {
    const sNom = (plan.length * k) / count;
    let bestS = sNom;
    let bestK = Infinity;
    for (let s = sNom - 220; s <= sNom + 220; s += plan.spacing) {
      const i = i0 + Math.round(s / plan.spacing);
      let kk = 0;
      for (let j = i - 15; j <= i + 15; j++) kk = Math.max(kk, Math.abs(plan.kappa[clamp(j, 0, plan.n - 1)]));
      const c = kk + Math.abs(s - sNom) * 1e-6;
      if (c < bestK) {
        bestK = c;
        bestS = s;
      }
    }
    checkpoints.push(Math.round(bestS / plan.spacing) * plan.spacing);
  }
  checkpoints.push(plan.length);

  const stats: StageStats = {
    length: plan.length,
    corners: inStage.length,
    tight,
    longStraights,
    minRadius: Math.min(...inStage.map((c) => c.radius)),
    maxGrade,
    climb,
    descent,
    minY,
    maxY,
    maxCut,
    maxFill,
    ms: { total: t4 - t0, place: t1 - t0, plan: t2 - t1, profile: t3 - t2, field: t4 - t3 },
  };
  return { seed, track, checkpoints, name, shift: { x: place.x, z: place.z }, plan, profile, field, stats };
}

/** A fresh random seed: 5 or 6 digits, friendly to type and to share. */
export function newStageSeed(): number {
  return 10000 + Math.floor(Math.random() * 990000);
}

let active: Stage | null = null;

/**
 * Carves `stage` into the terrain (CPU side) and moves the world so the stage lies at the origin; null: Neon-Flight's own world,
 * unshifted and uncarved. The picture follows with TerrainView.setStage(stage) and RoadView.setStage(stage).
 */
export function setActiveStage(stage: Stage | null): void {
  active = stage;
  setTerrainShift(stage ? stage.shift.x : 0, stage ? stage.shift.z : 0);
  setActiveStageField(stage ? stage.field : null);
}

export function getActiveStage(): Stage | null {
  return active;
}

/** The terrain as rendered at (x, z), the active stage's carve included; the sea's surface where the land is below it. */
export function groundHeightAt(x: number, z: number): number {
  return groundAt(x, z);
}
