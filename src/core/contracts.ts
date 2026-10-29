/**
 * Neon-Racer — shared contracts: the road, the car and its physics.
 *
 * These come from Xeno-Racer (gabriel-berzescu/Xeno-Racer), whose vehicle physics Neon-Racer drives on; they are kept as they are there
 * so the physics can be brought over again when it improves. A stage (src/world/) is a TrackRuntime that is open: it starts and finishes.
 *
 * CONVENTIONS:
 *  - Units are SI: meters, seconds, kilograms, newtons, radians, m/s. RPM only in fields named *rpm*.
 *  - World frame: right-handed, +Y up (three.js). Gravity is (0, -9.81, 0).
 *  - Car local frame: +Z forward, +Y up, +X LEFT. The car's right is -X.
 *    Car models are built facing +Z (same as glTF and Object3D.lookAt for non-camera objects).
 *  - Track frame: s = distance along the centerline from the start line, in [0, length].
 *    d = lateral offset from the centerline, positive = LEFT of the driving direction.
 *  - Steering INPUT: -1 = full left, +1 = full right (stick convention).
 *    Wheel steerAngle in telemetry is a rotation about the chassis +Y axis, so a wheel turned to the
 *    LEFT has a POSITIVE steerAngle. (Right stick input -> negative steerAngle.)
 *  - Wheel order everywhere: 0 = front-left, 1 = front-right, 2 = rear-left, 3 = rear-right.
 *  - Wheel spin: rotation about the chassis +X axis; it increases when the car rolls forward.
 *    Visual wheel orientation = chassisQuat * rotY(steerAngle) * rotX(spin).
 *  - Physics runs at a fixed rate (1000 Hz by default); everything else runs per rendered frame.
 */
import type { Quaternion, Vector3 } from 'three';
import type { VehicleSpec } from '../physics/spec';

// ─────────────────────────────────────────────────────────────────────────────
// Surfaces
// ─────────────────────────────────────────────────────────────────────────────

export type SurfaceType =
  | 'asphalt' // racing surface
  | 'curb' // painted rumble strips (raised, ridged — the ridges are in the height)
  | 'concrete' // painted runoff / pit concrete
  | 'grass'
  | 'gravel' // gravel trap: low grip, huge rolling drag
  | 'sand'
  | 'dirt'
  | 'snow' // packed snow (the winter road): about half the grip of dry asphalt
  | 'ice' // studded ice (a frozen lake)
  | 'deepsnow'; // loose snow off the road and the foot of a snowbank: soft, draggy, bogs a car down

// ─────────────────────────────────────────────────────────────────────────────
// Track (owner: track)
// ─────────────────────────────────────────────────────────────────────────────

/** Filled in place by TrackRuntime.groundAt. */
export interface GroundSample {
  /** World Y of the drivable surface at (x, z). Includes curb ridges, bumps, terrain. */
  height: number;
  /** Unit surface normal (written in place). */
  normal: Vector3;
  surface: SurfaceType;
}

/** Filled in place by TrackRuntime.project. */
export interface TrackPoint {
  /** Distance along centerline, [0, length). */
  s: number;
  /** Signed lateral offset from the centerline, + = left. */
  d: number;
  /** Index of the nearest centerline sample — pass back as `hint` next call. */
  segment: number;
  /** Asphalt half-widths at s (m, positive). */
  widthLeft: number;
  widthRight: number;
  /** Distance from centerline to the barrier faces at s (m, positive). The car must stay within. */
  wallLeft: number;
  wallRight: number;
  /** How soft the barrier on each side is at s: 0 = a hard wall (concrete, steel, tyres), 1 = a snowbank that takes a car in and slows it. Absent = 0. */
  softLeft?: number;
  softRight?: number;
  /** Unit horizontal tangent (direction of travel) at s. */
  tx: number;
  tz: number;
  /** Unit horizontal left vector at s: (tz, -tx). */
  lx: number;
  lz: number;
  /** Centerline surface height at s. */
  y: number;
}

export interface TrackFrame {
  position: Vector3; // centerline point on the road surface
  tangent: Vector3; // unit, direction of travel (3D, follows slope)
  normal: Vector3; // unit road normal (includes banking)
  left: Vector3; // unit, across the road surface toward the left edge (normal x tangent)
  widthLeft: number;
  widthRight: number;
  wallLeft: number;
  wallRight: number;
  curvature: number; // signed horizontal curvature 1/m, + = turning left
  bank: number; // rad, + = left edge higher
}

export interface GridSlot {
  /** Position of the car's center of mass when resting on the grid (on the surface + cg height is added by game). */
  position: Vector3; // point on the road surface
  /** Car orientation: +Z along the direction of travel, +Y along the road normal. */
  quaternion: Quaternion;
  s: number;
  d: number;
}

export interface TrackInfo {
  id: string;
  name: string;
  location: string; // fictional place
  description: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  defaultLaps: number;
  /** Approximate length in meters (exact value is TrackRuntime.length). */
  lengthHint: number;
  /** Accent color for menus. */
  color: string;
  /** Lit for racing after dark (the menus only pick a night attract race on these). */
  floodlit?: boolean;
  /**
   * A winter circuit: snow and ice under studded winter tyres, snowbanks for barriers, cold air. Precipitation is snow there (the
   * 'rain' and 'storm' weathers are snowfall and a blizzard), and the "water" on the track is fresh snow.
   */
  winter?: boolean;
}

/**
 * Headless-safe description of a built track (no DOM, no WebGL). Physics, AI, HUD, game and
 * effects use this. Centerline arrays are sampled every `spacing` meters; sample i is at
 * s = i * spacing and the loop is closed (sample `count` == sample 0).
 */
export interface TrackRuntime {
  readonly info: TrackInfo;
  readonly length: number;
  readonly spacing: number;
  readonly count: number;
  readonly px: Float32Array; readonly py: Float32Array; readonly pz: Float32Array;
  readonly tx: Float32Array; readonly ty: Float32Array; readonly tz: Float32Array;
  readonly nx: Float32Array; readonly ny: Float32Array; readonly nz: Float32Array;
  readonly lx: Float32Array; readonly ly: Float32Array; readonly lz: Float32Array;
  readonly widthLeft: Float32Array; readonly widthRight: Float32Array;
  readonly wallLeft: Float32Array; readonly wallRight: Float32Array;
  readonly curvature: Float32Array;
  readonly bank: Float32Array;
  /** s of the sector 1→2 and 2→3 boundaries. */
  readonly sectors: readonly [number, number];
  /** Starting grid, index 0 = pole. At least 12 slots, behind the start line, staggered two-wide. */
  readonly grid: readonly GridSlot[];
  /** Axis-aligned XZ bounds of everything drivable (for minimap / shadows). */
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number };

  /** Ground under (x, z). Fast (called ~16k times/s). Returns the segment hint to pass next time. */
  groundAt(x: number, z: number, out: GroundSample, hint?: number): number;
  /** Project a world XZ position onto the track. Returns the segment hint. */
  project(x: number, z: number, out: TrackPoint, hint?: number): number;
  /** World position on the road surface at (s, d). */
  pointAt(s: number, d: number, out: Vector3): Vector3;
  /** Interpolated centerline frame at s. */
  frameAt(s: number, out: TrackFrame): TrackFrame;
  /** Wrap any s into [0, length). */
  wrapS(s: number): number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vehicle (owner: physics)
// ─────────────────────────────────────────────────────────────────────────────

/** What a driver (human or AI) feeds the car each frame. */
export interface CarControls {
  /** -1 full left .. +1 full right (fraction of the car's max steering lock, already filtered). */
  steer: number;
  throttle: number; // 0..1
  brake: number; // 0..1
  handbrake: number; // 0..1
  clutch: number; // 0 = engaged, 1 = fully disengaged (pedal pressed)
  /** One-shot gear request for this frame: +1 up, -1 down, 0 none. Ignored with autoShift. */
  shift: -1 | 0 | 1;
}

export interface Assists {
  abs: boolean;
  tcs: 'off' | 'low' | 'high';
  /** Electronic stability control (yaw control by braking individual wheels). */
  esc: boolean;
  autoShift: boolean;
  /** 0..1 — helps catch slides with automatic counter-steer and limits steering to the grip limit. */
  steeringAssist: number;
  /** Automatic clutch (true for nearly everyone using a gamepad). */
  autoClutch: boolean;
}

/**
 * The driving line a human can have drawn on the road (src/core/aids.ts, src/render/drivingLine.ts): never, only where the
 * line says to lift or brake, or all along.
 */
export type LineMode = 'off' | 'braking' | 'full';

/**
 * Everything one human driver can switch on: the aids the car has (`Assists`, which the physics reads) and the two that live above
 * the physics, the driving line and the braking assist (src/core/aids.ts). Each human has a set of their own (`Settings.assists`,
 * `Settings.assists2`); the opponents drive with fixed aids.
 */
export interface PlayerAssists extends Assists {
  line: LineMode;
  /** The car brakes itself for a corner it arrives at too fast for the driving line's speed; the player still steers and accelerates, and can brake harder. */
  brakeAssist: boolean;
}

export interface WheelState {
  hub: Vector3; // world position of wheel center
  contactPoint: Vector3; // world position of the contact patch
  contactNormal: Vector3;
  steerAngle: number; // rad about chassis +Y (+ = pointing left)
  spin: number; // accumulated rotation about chassis +X (rad), grows when rolling forward
  omega: number; // rad/s, + = rolling forward
  radius: number;
  width: number;
  compression: number; // 0 = fully extended .. 1 = bump stop
  suspensionVelocity: number; // m/s, + = compressing
  contact: boolean;
  surface: SurfaceType;
  load: number; // vertical load N
  slipRatio: number;
  slipAngle: number; // rad
  forceLong: number; // N, tire frame (+ = forward)
  forceLat: number; // N, tire frame (+ = left)
  /** 0..1 — how hard the tire is sliding (squeal, smoke, skidmarks). */
  skid: number;
  tempC: number; // tread surface temperature
  brakeTempC: number; // disc temperature (glows above ~450 °C)
}

export type ImpactKind = 'wall' | 'car' | 'ground' | 'snow';

export interface VehicleState {
  id: number;
  position: Vector3; // center of mass, world
  quaternion: Quaternion; // car frame -> world
  velocity: Vector3; // world, m/s
  angularVelocity: Vector3; // world, rad/s
  speed: number; // |velocity|
  forwardSpeed: number; // velocity along car +Z
  /** Acceleration in the car frame (x left, y up, z forward), m/s^2, lightly smoothed. */
  localAccel: Vector3;
  steer: number; // applied steering input -1..1 (after assists)
  throttle: number; // applied 0..1 (after TCS / limiter)
  /**
   * The driver's throttle pedal 0..1 (or the AI's), through the engine's throttle map where it has one (EngineSpec.throttleGamma). The
   * throttle body follows it: the ignition cut of a flat upshift and the traction control cut `throttle`, not this, so they do not blow a
   * turbo's blow-off valve, and a voice that hears a cut as missed firings (EngineSoundProfile.ignitionCut) does not hear the map as one.
   */
  throttlePedal: number;
  brake: number; // applied 0..1 (after ABS)
  handbrake: number;
  clutch: number; // 0 engaged .. 1 open
  rpm: number;
  idleRpm: number;
  redlineRpm: number;
  limiterRpm: number;
  gear: number; // -1 = R, 0 = N, 1..gearCount
  gearCount: number;
  /** 0..1 fraction of available engine torque being produced (audio load). Negative-ish 0 on overrun. */
  engineLoad: number;
  /** Turbo boost 0..1 of max (0 for NA engines). */
  boost: number;
  revLimiter: boolean; // limiter cutting this frame
  absActive: boolean;
  tcsActive: boolean;
  escActive: boolean;
  /** Increments every completed gear change. */
  shiftCount: number;
  /** Increments on every overrun backfire pop (audio pop + exhaust flame). */
  backfireCount: number;
  /**
   * Where the active aero stands (AeroSpec.straightMode), 0 corner mode .. 1 straight mode: the body opens its wing flaps by it.
   * Absent or 0 for a car with fixed wings.
   */
  aeroOpen?: number;
  /** Increments on every distinct impact; read lastImpact when it changes. */
  impactCount: number;
  lastImpact: { strength: number; point: Vector3; normal: Vector3; kind: ImpactKind };
  /** 0..1 continuous scraping against a wall or the ground (sparks + grinding). */
  scrape: number;
  scrapePoint: Vector3;
  wheels: [WheelState, WheelState, WheelState, WheelState];
  /** All four wheels touching nothing? */
  airborne: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cars (owner: game/physics — data lives in src/cars)
// ─────────────────────────────────────────────────────────────────────────────

/** The body a car is drawn with ('formula': an open-wheeled single-seater, the Volta and the Dieci; CarVisualSpec.formulaEra says of which era). */
export type BodyStyle = 'gt' | 'hatch' | 'coupe' | 'prototype' | 'suv' | 'formula';

/** Everything the car-visual builder needs. Body geometry origin: on the ground, centered
 *  between the axles and between the wheels, +z forward. The center of mass sits at
 *  (0, cgHeight, bodyCgZ(spec)) relative to that origin. */
export interface CarVisualSpec {
  style: BodyStyle;
  length: number;
  width: number; // body width without mirrors
  height: number; // roof height above ground at rest
  wheelbase: number;
  trackFront: number; // distance between front tire centers
  trackRear: number;
  frontOverhang: number; // front axle -> front bumper
  wheelRadiusFront: number;
  wheelRadiusRear: number;
  tireWidthFront: number;
  tireWidthRear: number;
  rimRadiusFront: number;
  rimRadiusRear: number;
  rideHeight: number; // underbody above ground at rest
  cgHeight: number;
  cgToFrontAxle: number;
  /** Rear wing size 0 (none) .. 1 (big race wing). */
  wing: number;
  /** Engine position (affects intakes, vents, cockpit placement). */
  engine: 'front' | 'mid' | 'rear';
  /** The tailpipes and where they come out ('periscope': two pipes pointing up and back out of the top of the sidepods, a 2004 single-seater's). */
  exhaust: { count: 1 | 2 | 4; side: 'center' | 'split' | 'side' | 'periscope' };
  /** Seat position relative to body origin, for cockpit camera / driver (x > 0: on the left, a left-hand drive; 0: on the centre line, a single-seater). */
  seat: { x: number; y: number; z: number };
  /**
   * An open cockpit (absent: a closed cabin): no windscreen, no wiper and no roof, so no drops on the glass and no wiper sound, and
   * the driver hears the car through a helmet instead of a cabin.
   */
  openCockpit?: boolean;
  /** The era of a single-seater (style 'formula'; absent: 2026, the Volta's): 2004, a car of the V10 years. */
  formulaEra?: 2004;
}

/**
 * Where the center of mass sits along the body, from the body origin (the middle of the wheelbase), +z forward. `cgToFrontAxle` is
 * measured back from the front axle, so a car heavier at the front has its center of mass ahead of the middle. Every conversion between
 * the physics frame (centred on the center of mass, the wheels at +cgToFrontAxle and -(wheelbase - cgToFrontAxle)) and the body frame
 * goes through this.
 */
export function bodyCgZ(v: { wheelbase: number; cgToFrontAxle: number }): number {
  return v.wheelbase / 2 - v.cgToFrontAxle;
}

export interface Livery {
  primary: string; // hex '#rrggbb'
  secondary: string;
  accent: string;
  pattern: 'solid' | 'stripes' | 'split' | 'arrow' | 'hoops' | 'shards';
  number: number;
  driver: string; // name shown in standings
  /** 0 = gloss, 0.5 = satin, 1 = matte */
  finish: number;
  metallic: boolean;
}

export type CylinderLayout = 'inline' | 'v' | 'flat';

export interface EngineSoundProfile {
  cylinders: 4 | 6 | 8 | 10 | 12;
  layout: CylinderLayout;
  /** Crossplane V8s burble (uneven exhaust pulses); flat-plane V8s scream. */
  crankType: 'flat' | 'crossplane' | 'boxer';
  displacement: number; // liters
  turbo: boolean;
  /** 0..1: muffled road car .. open race exhaust. */
  exhaustOpenness: number;
  /** 0..1: deep .. bright/raspy. */
  brightness: number;
  /** 0..1 gearbox whine (straight-cut gears ~0.8). */
  gearWhine: number;
  /** 0..1 likelihood/intensity of overrun pops & crackles. */
  crackle: number;
  /**
   * A belt-driven positive-displacement supercharger (absent: none): a Roots or twin-screw blower, no lag and no blow-off valve (that
   * is a turbo's). Its rotors turn `ratio` times for every crank turn (the pulley ratio: about 2.4 for the 2.4 L blowers of a Hellcat or
   * a TRX) and each lobe sends one pulse of air out of the discharge, so `lobes` is the pulses per rotor turn (the male lobes of a
   * twin-screw: 4; a Roots pair of 4-lobe rotors: 8). The whine is the tone of those pulses, rpm/60 x ratio x lobes Hz with its
   * harmonics: it climbs with the engine (1.03 kHz at 6200 rpm for 2.5 x 4, 108 Hz at a 650 rpm idle, where it is only a whirr),
   * is loud on the throttle and drops when the bypass valve opens off it. `level` 0..1 scales it (default 1). Keep 2 x ratio x lobes
   * a whole number (2.5 x 4 = 20) and the tone and its sidebands stay on the engine-order grid (rpm/120) where the aliasing test
   * looks for folded-back partials. `lobes` is rounded to a whole number. Heard in full quality only, as the turbo's whistle is.
   */
  supercharger?: { ratio: number; lobes: number; level?: number };
  /**
   * 'dual': a true dual exhaust, each bank of a V engine in its own pipe to its own tailpipe with no crossover (side exits, one per
   * side, on the Mammoth). The listener is nearer one tailpipe than the other and the two pipes are never quite twins (a muffler that damps
   * a little more, a pipe a hair longer), so the sum of the banks is no longer the even train of pulses it would be through identical pipes
   * heard from one point: a cross-plane V8's banks, which fire 90 / 180 / 270 / 180 degrees apart, come out as the burble (energy at the half
   * orders of the crank, rpm/120), strongest below 3000 rpm and fading as the pulses crowd into the roar. Absent or 'merged': the banks meet
   * in an X-pipe and one pipe goes on, which throws that difference away, so the same engine is smoother. The pipes are run in full quality;
   * a lite voice has the same lope as per-pulse strengths. 'short': each collector straight out through a short open pipe with no muffler
   * (the periscopes of a 2004 single-seater; the two pipes of an even-firing engine, heard from one point, are the merged one): the pipes
   * 0.65 of a merged exhaust's length and their ends reflecting little, so that the pipe resonances which ripple a long exhaust's note
   * through the top of a 19,000 rpm engine's revs are damped and the note rises to the limiter.
   */
  exhaustSystem?: 'merged' | 'dual' | 'short';
  /**
   * 0..1 how loud the whine of an electric motor geared to the crankshaft is (absent: none), the Volta's MGU-K: locked to the engine
   * speed, faint while it harvests under braking or on a lift. In Xeno-Racer it also deployed, strongly, while a nitro shot burned;
   * Neon-Racer has no nitro, so here it never deploys.
   */
  electric?: number;
  /**
   * The engine's own rev limiter, rpm (absent: none given): its loudness is measured as it is driven, flat out over 35 to 100 % of it and a
   * turbo on boost. Without it every engine is measured over a nominal 2800..8000 rpm (a big V8 over its own lower range) and off boost,
   * which is right for a road car but leaves one that revs far beyond 8000 louder than its target where its pipes ring brightest (the
   * Volta's 12,500 rpm V6 by 2.3 dB), and a turbo on boost 1.8 dB louder still. Keep it the physics' `limiterRpm`.
   */
  limiterRpm?: number;
  /**
   * How far above the idle the voice's lift of the idle reaches, as a multiple of the idle rpm (absent: 2.2). The level near the idle is
   * lifted so that the wait on the grid has some character (a real idle is far quieter than full throttle); above a road car's 900 rpm
   * idle the lift is gone by 2000 rpm, but above a racing engine's 3000 it would reach 6600, a third of the revs, and make it louder flat
   * out at 4000 rpm than at 9000.
   */
  idleLiftTo?: number;
  /**
   * A turbo engine's blow-off valve (absent: it has one): the 'pssh' and the flutter of the boost vented when the driver lifts. false for a
   * racing turbo that vents nothing on a lift, its boost held by the wastegate (the Volta's).
   */
  blowOff?: boolean;
  /**
   * How long an upshift cuts the engine's torque for, as heard, seconds (absent: 0.07, a road car's gearbox). A seamless-shift racing
   * gearbox has the next gear in before the last one is out: about 0.02 s, a flick in the note instead of a gap. A profile that gives it
   * is heard as that dip alone: the physics' gearbox shuts the throttle for the whole of a shift and a control frame shows that for all of
   * its 17 ms (two frames at times), and the voice bridges it, 40 ms at most; without it the frames are played as they come.
   */
  shiftDip?: number;
  /**
   * Whatever holds the throttle under the pedal while the pedal is down (the traction control, the stability control, the launch control, and
   * a downshift's blip with the pedal flat) is cut from the engine by cutting the spark of whole firing events, the throttle left open (absent:
   * it is heard as a lighter load): the share of the cylinders that miss is the share of the torque taken, the rest burn at the pedal's load,
   * and now and then a cut charge lights in the pipe. The stuttering rasp of a 2004 single-seater's traction control on a slow exit, and of its
   * launch control holding the revs on the grid.
   */
  ignitionCut?: boolean;
  /**
   * 0..1 how much of the exhaust a turbo's wastegate lets past the turbine when it is wide open (absent: none). A racing turbo's wastegate
   * opens on full boost at full load and high revs, and the pulses that go round the turbine keep their edge where the turbine alone rounds
   * them off above 3.4 kHz: the hard, high rasp of a Formula 1 car flat out, its firing harmonics heard up to 10 kHz.
   */
  wastegate?: number;
}

export interface CarDefinition {
  id: string;
  name: string;
  maker: string; // fictional
  description: string;
  class: 'Road' | 'Sport' | 'GT' | 'Prototype' | 'SUV' | 'Formula';
  drivetrain: 'FWD' | 'RWD' | 'AWD';
  /** Menu stats (computed/estimated). */
  stats: { powerHp: number; torqueNm: number; massKg: number; topSpeedKmh: number; zeroTo100: number };
  physics: VehicleSpec;
  visual: CarVisualSpec;
  sound: EngineSoundProfile;
  defaultLivery: Livery;
}

// ─────────────────────────────────────────────────────────────────────────────
// Steering feel (the physics' SteeringFilter reads it)
// ─────────────────────────────────────────────────────────────────────────────

export interface ControlSettings {
  /** Stick deadzone (radial-ish, applied to steer axis) 0..0.3 */
  steerDeadzone: number;
  /** 1 = linear, >1 = more precision near center. */
  steerLinearity: number;
  /** Triggers deadzone 0..0.2 */
  pedalDeadzone: number;
  /** Max steering at high speed is reduced by this much (0 = never, 1 = strong). */
  speedSensitivity: number;
  /** How fast the virtual steering wheel can turn (lock-to-lock per second multiplier 0.5..2). */
  steerSpeed: number;
  vibration: boolean;
  invertLookY: boolean;
}
