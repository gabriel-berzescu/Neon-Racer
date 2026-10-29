/**
 * Scripted drives through the real physics (src/physics) on a flat proving ground, for the audio sandbox, the offline renders and the
 * tests: a car is driven by a programme of phases (pedals and steering held for so many seconds) and each rendered frame's VehicleState
 * is handed to a callback, as the game hands it to Sound.update.
 *
 * The proving ground: asphalt for x < 0, the run-off (grass by default) for x > 0, and barriers at |x| = `wall`. The car starts at
 * x = -6 facing +Z, so its left (+X) is towards the run-off and the barrier.
 *
 * Only the sandbox and the tests import this (it pulls in the physics); the game does not.
 */
import { Quaternion, Vector3 } from 'three';
import type { Assists, CarDefinition, SurfaceType, VehicleState } from '../../core/contracts';
import { PhysicsWorld, createFlatTrack } from '../../physics';
import type { Vehicle } from '../../physics/vehicle';

export interface Phase {
  name: string;
  seconds: number;
  throttle?: number;
  brake?: number;
  /** -1 full left .. +1 full right (left is towards the run-off). */
  steer?: number;
  handbrake?: number;
  /** End the phase early once this holds. */
  until?: (st: VehicleState) => boolean;
}

/** The scripted sweeps. */
export const PROGRAMMES: Record<string, { label: string; phases: Phase[] }> = {
  idle: { label: 'idle', phases: [{ name: 'idle', seconds: 4 }] },
  launch: {
    label: 'launch, full throttle through the gears, lift-off, braking',
    phases: [
      { name: 'idle', seconds: 1.5 },
      { name: 'full throttle', seconds: 14, throttle: 1, until: (st) => st.gear >= st.gearCount && st.rpm > 0.97 * st.limiterRpm },
      { name: 'lift-off', seconds: 2.5 },
      { name: 'braking', seconds: 3, brake: 1, until: (st) => st.speed < 1 },
    ],
  },
  gears: {
    label: 'full throttle from 2nd gear speed up through the gears',
    phases: [
      { name: 'roll', seconds: 0.6, throttle: 0.2 },
      { name: 'full throttle', seconds: 10, throttle: 1 },
    ],
  },
  lift: {
    label: 'up to speed, lift-off and coast (overrun, pops)',
    phases: [
      { name: 'full throttle', seconds: 5, throttle: 1 },
      { name: 'lift-off', seconds: 4 },
    ],
  },
  braking: {
    label: 'up to speed, then brake hard to a stop',
    phases: [
      { name: 'full throttle', seconds: 6, throttle: 1 },
      { name: 'braking', seconds: 4, brake: 1, until: (st) => st.speed < 0.5 },
      { name: 'idle', seconds: 1 },
    ],
  },
  tyres: {
    label: 'tyres: a slalom at the limit (squeal), off onto the run-off, into the barrier (impact, scrape)',
    phases: [
      { name: 'up to speed', seconds: 2.4, throttle: 1 },
      { name: 'hard left', seconds: 0.7, throttle: 0.2, steer: -0.7 },
      { name: 'hard right', seconds: 1.1, throttle: 0.2, steer: 0.7 },
      { name: 'straighten', seconds: 1, throttle: 0.5 },
      { name: 'left, over the run-off into the barrier', seconds: 2.5, throttle: 0.7, steer: -0.45 },
      { name: 'scrape along it', seconds: 1.5, throttle: 0.6, steer: -0.3 },
      { name: 'stop', seconds: 2.5, brake: 1 },
    ],
  },
};

export interface DriveOptions {
  /** Frames a second (the game's frame rate), default 60. */
  fps?: number;
  /** The run-off's surface (x > 0), default grass. */
  runoff?: SurfaceType;
  /** Where the barriers are, |x| (m), default 14. */
  wall?: number;
  /** The car's aids (default: GAMEPAD_AIDS). */
  assists?: Assists;
}

/** The aids a gamepad player drives with: stability control and some steering help keep a slide from becoming a spin. */
export const GAMEPAD_AIDS: Assists = { abs: true, tcs: 'low', esc: true, autoShift: true, steeringAssist: 0.5, autoClutch: true };

/** A proving ground and the car on it, ready to be driven frame by frame. */
export class Drive {
  readonly world: PhysicsWorld;
  readonly car: Vehicle;
  constructor(readonly def: CarDefinition, opts: DriveOptions = {}) {
    this.world = new PhysicsWorld(createFlatTrack({ leftSurface: opts.runoff ?? 'grass', wall: opts.wall ?? 14, halfWidth: opts.wall ?? 14 }));
    this.car = this.world.addVehicle(def);
    this.car.placeOnGround(new Vector3(-6, 0, 0), new Quaternion(), 0);
    this.car.setTemperatures(1);
    this.car.assists = { ...(opts.assists ?? GAMEPAD_AIDS) };
  }

  get state(): VehicleState {
    return this.car.state;
  }

  step(dt: number, c: { throttle?: number; brake?: number; steer?: number; handbrake?: number }): VehicleState {
    const k = this.car.controls;
    k.throttle = c.throttle ?? 0;
    k.brake = c.brake ?? 0;
    k.steer = c.steer ?? 0;
    k.handbrake = c.handbrake ?? 0;
    this.world.step(dt);
    return this.car.state;
  }
}

/**
 * Drive a programme: `frame(st, dt, t, phase)` is called once per frame. Returns the frames driven. Steering is eased in and out
 * (0.25 s), as a stick is, so a phase's steer is not a step.
 */
export function drive(
  def: CarDefinition,
  phases: Phase[],
  frame: (st: VehicleState, dt: number, t: number, phase: string) => void,
  opts: DriveOptions = {},
): number {
  const fps = opts.fps ?? 60;
  const dt = 1 / fps;
  const d = new Drive(def, opts);
  let f = 0;
  let steer = 0;
  for (const p of phases) {
    const n = Math.round(p.seconds * fps);
    for (let i = 0; i < n; i++) {
      steer += Math.max(-dt / 0.25, Math.min(dt / 0.25, (p.steer ?? 0) - steer));
      const st = d.step(dt, { throttle: p.throttle, brake: p.brake, steer, handbrake: p.handbrake });
      frame(st, dt, f * dt, p.name);
      f++;
      if (p.until?.(st)) break;
    }
  }
  return f;
}
