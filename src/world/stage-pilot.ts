/**
 * A simple autopilot for a stage: pure-pursuit steering on the centreline and a speed held under a fraction of the road's design
 * speed, braking in time for what is ahead. For the tests (a car driven along a stage) and the road sandbox (chase-camera views);
 * not a racing driver.
 */
import { Vector3 } from 'three';
import type { CarControls, TrackPoint, VehicleState } from '../core/contracts';
import type { Stage } from './stage';

const _tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };

export class StagePilot {
  private hint = -1;
  private readonly tmp = new Vector3();
  /** The car's s on the road at the last drive() call. */
  s = 0;
  d = 0;

  /**
   * pace: the fraction of the design speed to hold (it is an upper bound for the quickest car: 0.5-0.6 is brisk and safe);
   * wheelbase and maxSteer from the car's spec; lane: lateral offset to follow (m, + = left).
   */
  constructor(
    private readonly stage: Stage,
    private readonly wheelbase: number,
    private readonly maxSteer: number,
    public pace = 0.55,
    public lane = 0,
    public maxSpeed = Infinity,
  ) {}

  drive(st: VehicleState, c: CarControls): void {
    const tr = this.stage.track;
    this.hint = tr.project(st.position.x, st.position.z, _tp, this.hint);
    this.s = _tp.s;
    this.d = _tp.d;
    const v = Math.max(0, st.forwardSpeed);
    // steering: the point on the lane L metres ahead, in the car's frame (x left, z forward)
    const L = 9 + 0.55 * v;
    const target = tr.pointAt(_tp.s + L, this.lane, this.tmp);
    const dx = target.x - st.position.x;
    const dz = target.z - st.position.z;
    const q = st.quaternion;
    // the car's forward (+Z) and left (+X) in the world
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const lx = 1 - 2 * (q.y * q.y + q.z * q.z);
    const lz = 2 * (q.x * q.z - q.w * q.y);
    const xl = dx * lx + dz * lz;
    const zl = dx * fx + dz * fz;
    const dist2 = xl * xl + zl * zl;
    const kappa = (2 * xl) / Math.max(dist2, 1);
    const angle = Math.atan(this.wheelbase * kappa);
    c.steer = Math.max(-1, Math.min(1, -angle / this.maxSteer));
    // speed: the design speed ahead, scaled, with room to brake for it
    const sp = this.stage.profile.speed;
    const sStart = tr.sStart;
    const h = tr.spacing;
    let vt = this.maxSpeed;
    const aBrake = 14;
    for (let ds = 0; ds <= 220; ds += 4) {
      const i = Math.max(0, Math.min(tr.nAll - 1, Math.round((_tp.s + ds - sStart) / h)));
      const vd = sp[i] * this.pace;
      vt = Math.min(vt, Math.sqrt(vd * vd + 2 * aBrake * ds));
    }
    const err = vt - v;
    c.throttle = err > 0 ? Math.min(1, err * 0.25) : 0;
    c.brake = err < -1.5 ? Math.min(1, -err * 0.12) : 0;
    c.handbrake = 0;
    c.clutch = 0;
    c.shift = 0;
  }

}
