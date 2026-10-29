/**
 * The physics came over from Xeno-Racer with nitro and damage taken out: the three cars still accelerate, stop and turn as they did there
 * (its figures, measured on a flat plane, are quoted in src/cars/index.ts; these are loose bounds around them).
 */
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { CARS } from '../src/cars';
import { PhysicsWorld, createFlatTrack } from '../src/physics';

function launch(id: string) {
  const track = createFlatTrack();
  const world = new PhysicsWorld(track);
  const car = world.addVehicle(CARS.find((c) => c.id === id)!);
  car.placeOnGround(new Vector3(0, 0, 50), new Quaternion(), 0);
  return { world, car };
}

/** Seconds from a standstill to `kmh` on a full throttle (Infinity if not reached in `limit` s). */
function timeTo(id: string, kmh: number, limit = 20): number {
  const { world, car } = launch(id);
  car.controls.throttle = 1;
  const dt = 1 / 120;
  for (let t = 0; t < limit; t += dt) {
    world.step(dt);
    if (car.state.forwardSpeed * 3.6 >= kmh) return t;
  }
  return Infinity;
}

describe('the three cars on a flat plane', () => {
  it('has exactly the LMP-X, the Volta and the Dieci', () => {
    expect(CARS.map((c) => c.id)).toEqual(['lmp-x', 'volta', 'dieci']);
  });

  it.each([
    ['lmp-x', 2.3, 3.2],
    ['volta', 2.2, 2.9],
    ['dieci', 2.3, 3.1],
  ])('%s reaches 100 km/h in about its quoted time', (id, lo, hi) => {
    const t = timeTo(id, 100);
    expect(t).toBeGreaterThan(lo);
    expect(t).toBeLessThan(hi);
  });

  it('brakes from 100 km/h to a stop in under 25 m', () => {
    const { world, car } = launch('lmp-x');
    car.controls.throttle = 1;
    const dt = 1 / 120;
    while (car.state.forwardSpeed * 3.6 < 100) world.step(dt);
    car.controls.throttle = 0;
    car.controls.brake = 1;
    const z0 = car.state.position.z;
    for (let i = 0; i < 1200 && car.state.forwardSpeed > 0.3; i++) world.step(dt);
    expect(car.state.position.z - z0).toBeLessThan(25);
  });

  it('turns left on a steer to the left', () => {
    const { world, car } = launch('dieci');
    car.controls.throttle = 0.5;
    const dt = 1 / 120;
    for (let i = 0; i < 240; i++) world.step(dt);
    car.controls.steer = -0.3;
    for (let i = 0; i < 240; i++) world.step(dt);
    // left of the direction of travel (+Z) is +X
    expect(car.state.position.x).toBeGreaterThan(1);
  });
});
