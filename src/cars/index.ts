/**
 * The car roster: three of Xeno-Racer's cars (gabriel-berzescu/Xeno-Racer), its prototype and its two single-seaters, with their physics
 * unchanged. The figures quoted in the comments were measured there, by its tests and probes, on its circuits and with its AI drivers.
 * All makes and models are fictional.
 */
import { bodyCgZ, type CarDefinition, type CarVisualSpec, type EngineSoundProfile } from '../core/contracts';
import type { TireSpec, VehicleSpec } from '../physics/spec';

const DEG = Math.PI / 180;

/** Tire radius from an ISO size like 265/35R20. */
function tireRadius(widthMm: number, aspect: number, rimIn: number): number {
  return (rimIn * 25.4) / 2000 + (widthMm * aspect) / 100000;
}

function roadTire(widthMm: number, aspect: number, rimIn: number, mu: number, extra: Partial<TireSpec> = {}): TireSpec {
  return {
    radius: tireRadius(widthMm, aspect, rimIn),
    width: widthMm / 1000,
    inertia: 1.5,
    mu,
    loadSensitivity: 0.16,
    nominalLoad: 4000,
    peakSlipAngle: 7.5 * DEG,
    peakSlipRatio: 0.11,
    slideRatio: 0.78,
    relaxationLength: 0.45,
    rollingResistance: 0.012,
    optimalTemp: 85,
    tempWindow: 45,
    coldGrip: 0.88,
    ...extra,
  };
}

/** Collision hull derived from the body dimensions so physics and visuals agree. */
function hullFromVisual(v: CarVisualSpec, cgToFrontAxle: number): Pick<VehicleSpec['chassis'], 'hullHalf' | 'hullOffset'> {
  const rearOverhang = v.length - v.wheelbase - v.frontOverhang;
  const front = v.wheelbase / 2 + v.frontOverhang;
  const rear = -(v.wheelbase / 2 + rearOverhang);
  const cgZ = bodyCgZ({ wheelbase: v.wheelbase, cgToFrontAxle }); // the CG along the body, from the body origin
  const bottom = v.rideHeight;
  const top = v.height * 0.92; // the roof is narrower than the box; shave it a bit
  return {
    hullHalf: { x: v.width / 2, y: (top - bottom) / 2, z: (front - rear) / 2 },
    hullOffset: { x: 0, y: (top + bottom) / 2 - v.cgHeight, z: (front + rear) / 2 - cgZ },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Xeno LMP-X — naturally aspirated V10 prototype. Downforce, slicks, no mercy.
// ─────────────────────────────────────────────────────────────────────────────
const lmpVisual: CarVisualSpec = {
  style: 'prototype',
  length: 4.75,
  width: 1.9,
  height: 1.05,
  wheelbase: 2.95,
  trackFront: 1.62,
  trackRear: 1.58,
  frontOverhang: 1.0,
  wheelRadiusFront: 0.345,
  wheelRadiusRear: 0.355,
  tireWidthFront: 0.31,
  tireWidthRear: 0.34,
  rimRadiusFront: 0.2286,
  rimRadiusRear: 0.2286,
  rideHeight: 0.06,
  cgHeight: 0.3,
  cgToFrontAxle: 1.593,
  wing: 1,
  engine: 'mid',
  exhaust: { count: 2, side: 'center' },
  seat: { x: 0.3, y: 0.3, z: 0.1 },
};

const lmp: CarDefinition = {
  id: 'lmp-x',
  name: 'LMP-X',
  maker: 'Xeno Racing',
  description:
    'A 950 kg prototype with a screaming 4.5 L V10 and more downforce than weight at 250 km/h. Slicks need heat and hate grass and gravel. Respect it.',
  class: 'Prototype',
  drivetrain: 'RWD',
  stats: { powerHp: 690, torqueNm: 590, massKg: 950, topSpeedKmh: 318, zeroTo100: 2.6 },
  visual: lmpVisual,
  sound: { cylinders: 10, layout: 'v', crankType: 'flat', displacement: 4.5, turbo: false, exhaustOpenness: 1, brightness: 0.88, gearWhine: 0.8, crackle: 0.6 },
  defaultLivery: { primary: '#0e0f13', secondary: '#16e0bd', accent: '#ff2e63', pattern: 'shards', number: 1, driver: 'You', finish: 0.5, metallic: false },
  physics: {
    chassis: {
      mass: 950,
      inertia: { x: 1750, y: 1650, z: 300 },
      cgHeight: 0.3,
      wheelbase: 2.95,
      cgToFrontAxle: 1.593,
      trackFront: 1.62,
      trackRear: 1.58,
      maxSteer: 24 * DEG,
      ackermann: 0.2,
      ...hullFromVisual(lmpVisual, 1.593),
    },
    engine: {
      idleRpm: 1600,
      redlineRpm: 9300,
      limiterRpm: 9500,
      torqueCurve: [
        [0, 250], [2000, 360], [3000, 420], [4000, 480], [5000, 530], [6000, 560], [7000, 582],
        [8000, 590], [8500, 572], [9000, 532], [9500, 470], [10000, 400],
      ],
      engineBraking: 140,
      inertia: 0.09,
      turbo: null,
    },
    drivetrain: {
      layout: 'RWD',
      gears: [2.92, 2.18, 1.76, 1.47, 1.26, 1.1],
      reverse: 2.8,
      finalDrive: 3.25,
      efficiency: 0.93,
      shiftTime: 0.04,
      upshiftRpm: 9100,
      downshiftRpm: 5500,
      diff: { type: 'lsd', preload: 120, powerLock: 0.45, coastLock: 0.3 },
      frontSplit: 0,
    },
    brakes: { frontTorque: 4400, rearTorque: 2300, handbrakeTorque: 1500, discHeatCapacity: 2600 },
    aero: { dragArea: 1.05, liftAreaFront: 1.55, liftAreaRear: 2.05 },
    tireFront: {
      ...roadTire(310, 30, 18, 1.62),
      radius: 0.345,
      width: 0.31,
      inertia: 1.3,
      loadSensitivity: 0.2,
      nominalLoad: 4500,
      peakSlipAngle: 5.2 * DEG,
      peakSlipRatio: 0.085,
      slideRatio: 0.72,
      relaxationLength: 0.3,
      optimalTemp: 95,
      tempWindow: 35,
      coldGrip: 0.74,
      // (wet-weather compound fitted when it rains: slicks would keep barely half)
      wetGrip: 0.6,
      // (a racing tyre, dry slick or wet: the king of the asphalt, and on grass, dirt and gravel a good deal worse than a road tyre, wet
      // or dry — a racing wet's shallow grooves clear water from asphalt, not mud from turf; src/physics/surfaces.ts)
      slick: 1,
    },
    tireRear: {
      ...roadTire(340, 30, 18, 1.62),
      radius: 0.355,
      width: 0.34,
      inertia: 1.4,
      loadSensitivity: 0.2,
      nominalLoad: 4500,
      peakSlipAngle: 5.2 * DEG,
      peakSlipRatio: 0.085,
      slideRatio: 0.72,
      relaxationLength: 0.3,
      optimalTemp: 95,
      tempWindow: 35,
      coldGrip: 0.74,
      // (wet-weather compound fitted when it rains: slicks would keep barely half)
      wetGrip: 0.6,
      slick: 1,
    },
    suspFront: { travel: 0.07, spring: 110000, bump: 4200, rebound: 7000, antiRoll: 60000, camber: -2.8 * DEG },
    suspRear: { travel: 0.07, spring: 125000, bump: 4600, rebound: 7600, antiRoll: 42000, camber: -1.8 * DEG },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Volta — a 2026-rules turbo single-seater. Wings that open on the straights.
// ─────────────────────────────────────────────────────────────────────────────
// What it does on a flat plane (MAMMOTH=all CAR=volta npx vitest run tests/probes/mammoth-probe.test.ts prints the table; tests/volta.test.ts
// holds the bounds and measures the grip at speed): 0-100 km/h in 2.42 s with the traction control on, the slicks' limit,
// 200 in 5.6 s and 330 km/h flat out in eighth with the wings open (303 with them shut). It stops from 100 in 18.8 m
// with ABS (2.1 g) and from 200 in 58 m, at up to 4.4 g from 300 km/h, and holds 2.39 g on the skidpad, 2.5 g at 150 km/h, 3.1 at 200 and 3.7 at
// 240 (where the drag of the wings and of the loaded tyres takes all the engine has). In the wet it keeps 64 % of that (54 % in standing water)
// and stops from 100 in 26 m (30). On a lap the AI drivers are 3.9-5.7 % quicker in it than in the LMP-X dry and 5.1-6.3 % in a storm
// (tests/ai.test.ts), and on the studded tyres of Isvik level with it: the engine alone has the LMP-X's power for its weight.

// The Volta's body: 5.3 m long, 1.9 m wide over the tyres, 0.95 m to the top of the airbox, an open cockpit with the driver on the centre line.
const voltaVisual: CarVisualSpec = {
  style: 'formula',
  length: 5.3,
  width: 1.9,
  height: 0.95,
  wheelbase: 3.4,
  trackFront: 1.56,
  trackRear: 1.5,
  frontOverhang: 1.05,
  wheelRadiusFront: 0.352,
  wheelRadiusRear: 0.356,
  tireWidthFront: 0.28,
  tireWidthRear: 0.375,
  rimRadiusFront: 0.2286,
  rimRadiusRear: 0.2286,
  rideHeight: 0.05,
  cgHeight: 0.28,
  cgToFrontAxle: 1.87,
  wing: 1,
  engine: 'mid',
  exhaust: { count: 1, side: 'center' },
  // (the driver lies back: the seat reference is at the hips, 37 cm ahead of the eye, which sits 1.45 m behind the front axle)
  seat: { x: 0, y: 0.22, z: 0.62 },
  openCockpit: true,
};

// The Volta's voice: a 1.6 L 90-degree V6 with a flat crank (even firing, three pulses a turn), one turbo, one central tailpipe, and the MGU-K's whine.
const voltaSound: EngineSoundProfile = {
  cylinders: 6, layout: 'v', crankType: 'flat', displacement: 1.6, turbo: true, exhaustOpenness: 1, brightness: 0.95, gearWhine: 0.7, crackle: 0.15,
  exhaustSystem: 'merged',
  // no muffler, and a wastegate that opens wide flat out: the firing harmonics go up to 10 kHz past the turbine, a hard, high rasp
  wastegate: 1,
  // its loudness measured as it is driven (its own revs, on boost), and the lift of its 3000 rpm idle gone by 4500 rpm (not 6600)
  limiterRpm: 12500,
  idleLiftTo: 1.5,
  // no blow-off valve (the wastegate holds the boost on a lift: no 'pssh'), and a seamless-shift gearbox: an upshift is a 20 ms flick in
  // the note, as the physics' shiftTime, not a road car's 70 ms gap. Driven flat out through the physics, at 60 and 144 frames a second,
  // it is under -3 dB for 8 to 16 ms and 5 to 7 dB deep (held as the frames come, 40 to 64 ms and 8 to 10 dB; tests/audio-volta.test.ts)
  blowOff: false,
  shiftDip: 0.02,
  // the MGU-K's whine on the 14th order of the crank (2.6 kHz at 11,000 rpm), harvesting on a lift and under braking; it never deploys
  // here (no nitro), so on the throttle it only murmurs (tests/audio-engines.test.ts)
  electric: 1,
};

// The Volta itself: 800 kg with the driver and an average fuel load, 45 % of it on the front axle, on slicks.
const volta: CarDefinition = {
  id: 'volta',
  name: 'Volta',
  maker: 'Xeno Racing',
  description:
    'A 2026-rules single-seater: 800 kg, a 1.6 L turbo V6 and wings that open on the straights.',
  class: 'Formula',
  drivetrain: 'RWD',
  // (measured: 0-100 in 2.42 s with the traction control on, 330.0 km/h flat out with the wings open; the curve gives 564.5 hp at 12,000 rpm and
  // 380 Nm from 8000 to 10,500)
  stats: { powerHp: 565, torqueNm: 380, massKg: 800, topSpeedKmh: 330, zeroTo100: 2.4 },
  visual: voltaVisual,
  sound: voltaSound,
  defaultLivery: { primary: '#e9edf2', secondary: '#1f6bff', accent: '#d7ff1e', pattern: 'stripes', number: 26, driver: 'You', finish: 0.5, metallic: false },
  physics: {
    chassis: {
      mass: 800,
      inertia: { x: 1700, y: 1600, z: 240 },
      cgHeight: 0.28,
      wheelbase: 3.4,
      cgToFrontAxle: 1.87,
      trackFront: 1.56,
      trackRear: 1.5,
      maxSteer: 24 * DEG,
      ackermann: 0.15,
      ...hullFromVisual(voltaVisual, 1.87),
    },
    engine: {
      idleRpm: 3000,
      redlineRpm: 12000,
      limiterRpm: 12500,
      // the 2026 engine alone, 421 kW: about 380 Nm from 7000 to 10,500 rpm (300 at 4000), then the same power on to 12,000 (the fuel flow is capped)
      torqueCurve: [
        [0, 150], [2000, 215], [3000, 255], [4000, 300], [5000, 335], [6000, 362], [7000, 377], [8000, 380], [10500, 380],
        [11000, 363], [11500, 348], [12000, 335], [12500, 312], [13000, 270],
      ],
      engineBraking: 150,
      inertia: 0.07,
      // (no MGU-H in 2026 to spin the turbo up: a light one with a hint of lag)
      turbo: { baseFraction: 0.9, spoolTime: 0.1, spoolRpm: 4000 },
    },
    drivetrain: {
      layout: 'RWD',
      // (12,000 rpm is 99 / 132 / 160 / 189 / 223 / 253 / 289 / 334 km/h)
      gears: [4.51, 3.38, 2.79, 2.37, 2.01, 1.77, 1.55, 1.34],
      reverse: 3.0,
      finalDrive: 3.6,
      efficiency: 0.94,
      // (seamless shifts)
      shiftTime: 0.02,
      upshiftRpm: 11800,
      downshiftRpm: 7000,
      diff: { type: 'lsd', preload: 120, powerLock: 0.45, coastLock: 0.3 },
      frontSplit: 0,
    },
    // (a full pedal asks for 4.0 g, 61 % of it at the front: below about 210 km/h the tyres take less than that and ABS has the last word, above it
    // the brakes are the limit, so a stop from 300 km/h peaks at 4.4 g over a tenth of a second, drag included, where with 4400 / 2900 Nm it reached
    // 5.0; 2026's cars brake at 3.3-3.8 g, and the AI drivers lap no slower for it)
    brakes: { frontTorque: 3350, rearTorque: 2200, handbrakeTorque: 1500, discHeatCapacity: 2600 },
    // corner mode: 3.8 m^2 of downforce area, 43 % of it at the front, and a CdA of 1.0 (the car pulls 3.7 g at 240 km/h); straight mode, the wing
    // flaps open: 22 % less drag and 28 % less downforce (330.0 km/h flat out where corner mode gives 303)
    aero: {
      dragArea: 1.0,
      liftAreaFront: 1.64,
      liftAreaRear: 2.16,
      straightMode: { dragArea: 0.78, liftAreaFront: 1.18, liftAreaRear: 1.56 },
    },
    tireFront: {
      ...roadTire(280, 45, 18, 1.75),
      radius: voltaVisual.wheelRadiusFront,
      inertia: 1.2,
      // (a racing slick's friction falls less with its load than a road tyre's: 1.07 times mu on the 2 kN a wheel carries at rest, 0.93 on the
      // 7 kN of a fast corner, where at 0.2 it was 1.11 and 0.89, so the car keeps more of the downforce it is given. Under about 0.1 the launch
      // control's clutch, sized to 1.15 times mu, takes more than the slicks hold at rest, and the traction control cuts in bursts off the line.
      // Still more than the studded winter tyre's 0.06: tests/winter-handling.test.ts)
      loadSensitivity: 0.12,
      nominalLoad: 4500,
      peakSlipAngle: 5.2 * DEG,
      peakSlipRatio: 0.085,
      slideRatio: 0.72,
      relaxationLength: 0.3,
      optimalTemp: 90,
      tempWindow: 45,
      coldGrip: 0.74,
      // (a soft racing compound turns more of its work into heat than a road tyre of its size, the narrow front the more: a dry AI lap runs the
      // fronts at 76-98 C and the rears at 81-92, about the optimum, where at 1.15 and 1.5 they ran at 60-78 and 67-78 and gave up a tenth of their
      // grip to the cold)
      heatScale: 0.75,
      // (wet-weather compound fitted when it rains)
      wetGrip: 0.6,
      slick: 1,
    },
    tireRear: {
      ...roadTire(375, 35, 18, 1.75),
      radius: voltaVisual.wheelRadiusRear,
      inertia: 1.35,
      loadSensitivity: 0.12,
      nominalLoad: 4500,
      peakSlipAngle: 5.2 * DEG,
      peakSlipRatio: 0.085,
      slideRatio: 0.72,
      relaxationLength: 0.3,
      optimalTemp: 90,
      tempWindow: 45,
      coldGrip: 0.74,
      heatScale: 1.0,
      wetGrip: 0.6,
      slick: 1,
    },
    // (6 cm of travel at 5 cm off the ground: with 5 cm at 4 cm the floor struck the road in Brennwald's compression at 308 km/h.) Bars of 60 and
    // 70 kN/m put 48 % of the roll stiffness at the front, on 45 % of the weight: with 54 % (90 and 50 kN/m) the fronts gave up first and the car
    // held 2.31 g on the skidpad, now 2.40
    suspFront: { travel: 0.06, spring: 250000, bump: 5000, rebound: 8500, antiRoll: 60000, camber: -3 * DEG },
    suspRear: { travel: 0.06, spring: 300000, bump: 5500, rebound: 9500, antiRoll: 70000, camber: -1.8 * DEG },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Dieci — a 2004-style single-seater. A 3.0 L V10 screaming to 19,300 rpm, fixed wings, grooved tyres, and nothing electric.
// ─────────────────────────────────────────────────────────────────────────────
// What it does on a flat plane (tests/physics.test.ts, .cache/physics-metrics.txt; tests/dieci.test.ts holds the bounds and measures the grip
// at speed): 0-100 km/h in 2.63 s with the traction control on, 200 in 4.67 s, 300 in 9.4 s and 332 km/h flat out in seventh; from a grid start,
// the engine already held at 10,000 rpm against the clutch, 2.48 and 4.50 s. It stops from 100 in 18.3 m with ABS and from 200 in 55 m, at 4.7 g from 300 km/h, and holds 2.64 g on
// the skidpad, 2.7 g at 150 km/h, 3.4 at 200 and 4.3 at 250. In the wet it keeps 66 % of that (56 % in standing water) and stops from 100 in
// 24 m (27). On a lap the AI drivers are 5.8 % quicker in it than in the Volta on the four road circuits, dry, and 5.6 % in a storm (7-8 % on
// the fast Aurelia and Brennwald, 3.5-4 % on the tight Kuroyama), and 1-3 % on the studded tyres of Isvik (tests/ai.test.ts).
// It leaves the line at 10,000 rpm, its launchRpm: 0.17 s slower to 100 on the flat than at the 4900 a road car is held at (car-metrics'
// dragRun), since the engine first revs past 8700 before the clutch bites and the clutch then slips up to 54 km/h, not 26, at what the tyres
// take at rest.

// The Dieci's body: 4.55 m long, 1.8 m wide over the tyres, 0.95 m to the top of the airbox, an open cockpit with the driver on the centre
// line. formulaEra 2004 draws it with a body of its own (src/carvis/bodies/formula04.ts: the high nose, the periscopes, the beam wing) on
// 13-inch grooved wheels, and its flames come out of the periscopes (src/render/effects.ts).
const dieciVisual: CarVisualSpec = {
  style: 'formula',
  formulaEra: 2004,
  length: 4.55,
  width: 1.8,
  height: 0.95,
  wheelbase: 3.1,
  trackFront: 1.46,
  trackRear: 1.41,
  frontOverhang: 0.97,
  // (13-inch rims in 660 mm tyres)
  wheelRadiusFront: 0.33,
  wheelRadiusRear: 0.33,
  tireWidthFront: 0.325,
  tireWidthRear: 0.375,
  rimRadiusFront: 0.1651,
  rimRadiusRear: 0.1651,
  rideHeight: 0.05,
  cgHeight: 0.275,
  cgToFrontAxle: 1.674,
  wing: 1,
  engine: 'mid',
  exhaust: { count: 2, side: 'periscope' },
  // (the hips 1.05 m behind the front axle: the eye 1.42 m behind it and 73 cm up, as the build sheet has it, formulaCockpit)
  seat: { x: 0, y: 0.22, z: 0.5 },
  openCockpit: true,
};

// The Dieci's voice: a 3.0 L V10 with a flat crank (even firing, five pulses a turn) to 19,300 rpm, no turbo, and two short open
// periscopes whose ends reflect little, so that its scream rises to the limiter in every gear (tests/audio-dieci.test.ts).
const dieciSound: EngineSoundProfile = {
  cylinders: 10, layout: 'v', crankType: 'flat', displacement: 3.0, turbo: false, exhaustOpenness: 1, brightness: 0.95, gearWhine: 0.75, crackle: 0.35,
  exhaustSystem: 'short',
  // its loudness measured over its own revs, and the lift of its 4000 rpm idle gone by 5600 rpm (not 8800)
  limiterRpm: 19300,
  idleLiftTo: 1.4,
  // an upshift that cuts the ignition: through the physics' 30 ms shift the note is 3 dB and more down for 28 to 32 ms, 9 to 12 dB at its
  // deepest (not seamless: the Volta's is a flick of 8 to 16 ms; a road car's gearbox leaves a gap of 70 ms). The 1-2 is longer wherever the
  // traction control is working, from the grid or flat out in 1st: it clamps the throttle to about a tenth of the pedal for some 50 ms just
  // after the shift and holds it under half for 150, so from rest the note is 3 dB down for 84 ms of the shift's first 150 at 60 frames a
  // second (tests/audio-dieci.test.ts, ARCHITECTURE.md)
  shiftDip: 0.04,
  // its traction control, its stability control and its launch control cut the spark, not the throttle: in 1st gear flat out from rest it
  // stutters 3 dB and more louder than the same torque heard as a lighter load (tests/audio-dieci.test.ts)
  ignitionCut: true,
};

// The Dieci itself: 640 kg with the driver and an average fuel load (the 600 kg rule and 40 kg of fuel), 46 % of it on the front axle.
const dieci: CarDefinition = {
  id: 'dieci',
  name: 'Dieci',
  maker: 'Xeno Racing',
  description:
    'A 2004-style single-seater: 640 kg, a 3.0 L V10 screaming to 19,300 rpm, grooved tyres on 13-inch rims, and nothing electric. The quickest car here round a lap, and an octave above the rest.',
  class: 'Formula',
  drivetrain: 'RWD',
  // (measured: 0-100 in 2.63 s with the traction control on, 332.4 km/h flat out; the curve gives 911.9 hp at 18,500 rpm and 375 Nm at 16,500)
  stats: { powerHp: 912, torqueNm: 375, massKg: 640, topSpeedKmh: 332, zeroTo100: 2.6 },
  visual: dieciVisual,
  sound: dieciSound,
  // (the big blocks of colour of the time's liveries, without their sponsors: shards of charcoal and white over burnt orange on the nose,
  // the sidepods, the engine cover and the endplates; the opponents' orange car is split in black, so a field of Diecis tells them apart)
  defaultLivery: { primary: '#e2541b', secondary: '#23262b', accent: '#f4f4f2', pattern: 'shards', number: 19, driver: 'You', finish: 0, metallic: false },
  physics: {
    chassis: {
      mass: 640,
      inertia: { x: 1100, y: 1050, z: 170 },
      cgHeight: 0.275,
      wheelbase: 3.1,
      cgToFrontAxle: 1.674,
      trackFront: 1.46,
      trackRear: 1.41,
      maxSteer: 24 * DEG,
      ackermann: 0.15,
      ...hullFromVisual(dieciVisual, 1.674),
    },
    engine: {
      idleRpm: 4000,
      redlineRpm: 19000,
      limiterRpm: 19300,
      // the 2004 V10: 375 Nm at 16,500 rpm and 680 kW at 18,500, a flat top (674 kW at 17,500, 672.5 at 19,000)
      torqueCurve: [
        [0, 50], [4000, 110], [6000, 175], [8000, 235], [10000, 288], [12000, 325], [14000, 355], [15500, 370], [16500, 375],
        [17500, 368], [18500, 351], [19000, 338], [19300, 330], [20000, 295],
      ],
      // (52 Nm at 18,000 rpm with the throttle shut, about half what a bare V10 drags, 95, as the engine-braking maps of the period left it.
      // With 110, a bare V10's, the engine held the rears locked in a stop on a wet road with the wheel turned once ABS had let their brakes
      // go, and in standing water the car spun in two of eight such stops from 250 and 180 km/h with the AI's aids; with 50 in none)
      engineBraking: 50,
      // (a throttle map: in this model a part throttle also loses what the engine drags, and with 50 Nm and no map 35 % of the pedal gave 26 %
      // of the torque at 17,000 rpm, which in first gear on snow spun the rears at once: the power slide of tests/winter-handling.test.ts went
      // from 10 to 30 degrees of body slip in 0.17 s. With the map it gives 16 %, and the slide takes 0.37 s)
      throttleGamma: 1.3,
      inertia: 0.05,
      turbo: null,
      // the launch control holds it at 10,000 rpm off the line (on a winter circuit at 4900, as a road car)
      launchRpm: 10000,
    },
    drivetrain: {
      layout: 'RWD',
      // (19,000 rpm is 116 / 153 / 182 / 216 / 253 / 295 / 344 km/h: a long second, so that a car on the limit of a 60 m bend at 145 km/h holds
      // its gear; with a second to 148 the shift jolted it there, which the skidpad read as 0.09 g more grip than the car holds)
      gears: [5.09, 3.85, 3.25, 2.73, 2.34, 2.0, 1.72],
      reverse: 3.0,
      finalDrive: 4.0,
      efficiency: 0.94,
      // (an ignition cut, not a seamless shift)
      shiftTime: 0.03,
      upshiftRpm: 19000,
      downshiftRpm: 12500,
      diff: { type: 'lsd', preload: 120, powerLock: 0.45, coastLock: 0.3 },
      frontSplit: 0,
    },
    // (a full pedal asks for 4.2 g, 60 % of it at the front: above about 195 km/h the brakes are the limit, below it the tyres and ABS, so a
    // stop from 300 km/h peaks at 4.7 g over a tenth of a second, drag included, as the period's carbon brakes did (4.57 with 2500 / 1700 Nm:
    // tests/dieci.test.ts's stopFrom, after a second flat out in 7th), and passes 200 at 4.2 g)
    brakes: { frontTorque: 2600, rearTorque: 1750, handbrakeTorque: 1500, discHeatCapacity: 2400 },
    // fixed wings of medium downforce: 3.95 m^2 of downforce area, 44 % of it at the front, and a CdA of 1.25. (The period's estimates, 4.1 and
    // 1.30, were worked out in air of 1.18 kg/m^3; in this air, 1.225, these give the same forces.)
    aero: { dragArea: 1.25, liftAreaFront: 1.738, liftAreaRear: 2.212 },
    // grooved dry tyres: four grooves cost the contact patch some grip, and the more the harder it is pressed (1.87 on the 1.4 kN a front wheel
    // carries at rest, as the Volta's slick on its 1.8 kN, but 1.47 on the 7 kN of a fast corner, nine tenths of the slick's 1.63), and leave no
    // tread for grass, dirt or gravel, so they take the slick's table of surfaces
    tireFront: {
      ...roadTire(325, 51, 13, 1.65),
      radius: dieciVisual.wheelRadiusFront,
      inertia: 1.0,
      loadSensitivity: 0.2,
      nominalLoad: 4500,
      peakSlipAngle: 6.5 * DEG,
      peakSlipRatio: 0.09,
      slideRatio: 0.74,
      relaxationLength: 0.4,
      optimalTemp: 90,
      tempWindow: 45,
      coldGrip: 0.74,
      heatScale: 0.9,
      // (wet-weather compound fitted when it rains)
      wetGrip: 0.64,
      slick: 1,
    },
    tireRear: {
      ...roadTire(375, 44, 13, 1.65),
      radius: dieciVisual.wheelRadiusRear,
      inertia: 1.15,
      loadSensitivity: 0.2,
      nominalLoad: 4500,
      peakSlipAngle: 6.5 * DEG,
      peakSlipRatio: 0.09,
      slideRatio: 0.74,
      relaxationLength: 0.4,
      optimalTemp: 90,
      tempWindow: 45,
      coldGrip: 0.74,
      heatScale: 1.3,
      wetGrip: 0.64,
      slick: 1,
    },
    suspFront: { travel: 0.06, spring: 250000, bump: 4500, rebound: 7500, antiRoll: 60000, camber: -3 * DEG },
    suspRear: { travel: 0.06, spring: 300000, bump: 5000, rebound: 8700, antiRoll: 70000, camber: -1.8 * DEG },
  },
};

// (the newest cars last, the Mammoth, the Volta and then the Dieci: tests take CARS[3] for the LMP-X)
export const CARS: CarDefinition[] = [lmp, volta, dieci];

export function getCar(id: string): CarDefinition {
  const c = CARS.find((c) => c.id === id);
  if (!c) throw new Error(`Unknown car '${id}'`);
  return c;
}
