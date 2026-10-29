/**
 * QA only (`?autodrive=1`): drives the car along the road's centre line so a headless browser can tour a stage for screenshots
 * and timings. Pure pursuit on a point ahead for the steering, and a speed from the tightest curvature in the next stretch
 * (what the slicks hold, roughly) for the pedals. A tool, not a racing driver: it is slow and careful. The game also steers the car
 * down the run-out with it after the finish. (frameAt is given s past the ends: a stage covers its grid and run-out.)
 */
import { Vector3 } from 'three';
import type { TrackFrame, TrackRuntime, VehicleState } from '../core/contracts';

export interface AutoInput {
  steer: number;
  throttle: number;
  brake: number;
}

const _f: TrackFrame = {
  position: new Vector3(), tangent: new Vector3(), normal: new Vector3(), left: new Vector3(),
  widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0,
};
const _fwd = new Vector3();
const _left = new Vector3();
const _to = new Vector3();

/** Lateral grip the autodriver plans with (g): well under what these cars can do, so it stays on the road. */
const PLAN_G = 1.3;
const MAX_SPEED = 75;

export function autodrive(track: TrackRuntime, state: VehicleState, s: number, maxSteerRad: number, wheelbase: number): AutoInput {
  const v = Math.max(0, state.forwardSpeed);
  // the speed for the tightest bend within braking distance
  let target = MAX_SPEED;
  const reach = 40 + (v * v) / (2 * 0.8 * 9.81);
  for (let ds = 0; ds <= reach; ds += 10) {
    track.frameAt(s + ds, _f);
    const k = Math.abs(_f.curvature);
    if (k < 1e-5) continue;
    const vk = Math.sqrt((PLAN_G * 9.81) / k);
    // what can still be shed by then
    const allowed = Math.sqrt(vk * vk + 2 * 0.8 * 9.81 * ds);
    target = Math.min(target, allowed);
  }
  // pure pursuit on the centre line, a speed-dependent distance ahead
  const look = Math.max(8, v * 0.9);
  track.frameAt(s + look, _f);
  _fwd.set(0, 0, 1).applyQuaternion(state.quaternion);
  _left.set(1, 0, 0).applyQuaternion(state.quaternion);
  _to.subVectors(_f.position, state.position);
  const x = _to.dot(_left);
  const z = Math.max(1, _to.dot(_fwd));
  const curv = (2 * x) / (x * x + z * z);
  const angle = Math.atan(curv * wheelbase); // + = left
  const steer = Math.max(-1, Math.min(1, -angle / maxSteerRad));
  const err = target - v;
  return {
    steer,
    throttle: err > 0 ? Math.min(1, err / 6) : 0,
    brake: err < -2 ? Math.min(1, -err / 10) : 0,
  };
}
