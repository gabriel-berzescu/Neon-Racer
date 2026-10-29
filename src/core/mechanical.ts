/**
 * What mechanical damage does to a car, in the units the physics works in. Neon-Racer has no damage: the physics (from Xeno-Racer) keeps
 * its hook, Vehicle.setDamage, and nothing here calls it, so every car stays sound. Only the types and helpers the physics uses remain.
 */


/** What the mechanical damage does to the driving of a car, in the units the physics and the AI work in. Neutral = a sound car. */
export interface MechEffects {
  /** multipliers on the downforce area of the front and rear axle, 1 = sound */
  aeroFront: number;
  aeroRear: number;
  /** multiplier on the engine's torque, 1 = sound */
  power: number;
  /** toe change of each wheel (rad), added to its steering angle */
  toe: [number, number, number, number];
  /** camber change of each wheel (rad); positive = the top leans out */
  camber: [number, number, number, number];
  /** multiplier on the peak grip of each tyre, from its camber error */
  camberGrip: [number, number, number, number];
  /** lateral force of each tyre per newton of its load, from its camber error (positive pushes to the left) */
  camberThrust: [number, number, number, number];
}

export function neutralEffects(): MechEffects {
  return { aeroFront: 1, aeroRear: 1, power: 1, toe: [0, 0, 0, 0], camber: [0, 0, 0, 0], camberGrip: [1, 1, 1, 1], camberThrust: [0, 0, 0, 0] };
}

export function cloneEffects(e: MechEffects): MechEffects {
  const four = (a: readonly number[]): [number, number, number, number] => [a[0], a[1], a[2], a[3]];
  return { aeroFront: e.aeroFront, aeroRear: e.aeroRear, power: e.power, toe: four(e.toe), camber: four(e.camber), camberGrip: four(e.camberGrip), camberThrust: four(e.camberThrust) };
}

/** True when the effects change nothing (a sound car). */
export function isNeutral(e: MechEffects | null | undefined): boolean {
  if (!e) return true;
  if (e.aeroFront !== 1 || e.aeroRear !== 1 || e.power !== 1) return false;
  for (let i = 0; i < 4; i++) if (e.toe[i] !== 0 || e.camber[i] !== 0 || e.camberGrip[i] !== 1 || e.camberThrust[i] !== 0) return false;
  return true;
}

