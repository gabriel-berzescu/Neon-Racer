/**
 * Ghosts: a run recorded as the car's pose 20 times a second, kept with the best time on a stage, and played back on the next run.
 *
 * A sample is the centre of mass (3 float32, in metres: stages lie near the world origin, so float32 keeps millimetres), the
 * orientation (a unit quaternion, 4 int16), the front wheels' steering angle (int8) and the brake (uint8): 22 bytes, 20 a second, so
 * a three-minute run is about 80 kB (110 kB as base64 text in localStorage). Samples are taken at exact times (k / RATE seconds
 * after GO), interpolated between the two rendered frames around each, so the playback has no frame-timing jitter.
 *
 * Playback interpolates the position along a Catmull-Rom spline through the samples and the orientation by normalised lerp. The
 * wheels' spin is not stored: the player rolls them by the distance covered.
 */
import { Quaternion, Vector3 } from 'three';

export const GHOST_RATE = 20;
const BYTES = 22;
const VERSION = 1;
/** Steering is stored in 1/100 rad (a road wheel turns at most about 0.5 rad, well inside int8). */
const STEER_SCALE = 100;

export interface Ghost {
  rate: number;
  count: number;
  /** count * BYTES bytes, little-endian. */
  bytes: Uint8Array;
}

/** What the recorder reads each frame: VehicleState has all of it. */
export interface GhostSource {
  position: Vector3;
  quaternion: Quaternion;
  brake: number;
  wheels: ReadonlyArray<{ steerAngle: number }>;
}

/** What playback writes: the shape the car view takes (src/render/car.ts CarPose). */
export interface GhostPose {
  position: Vector3;
  quaternion: Quaternion;
  brake: number;
  wheels: Array<{ steerAngle: number; spin: number; compression?: number }>;
}

export function makeGhostPose(): GhostPose {
  return {
    position: new Vector3(),
    quaternion: new Quaternion(),
    brake: 0,
    wheels: [0, 1, 2, 3].map(() => ({ steerAngle: 0, spin: 0 })),
  };
}

export class GhostRecorder {
  private buf = new Uint8Array(BYTES * GHOST_RATE * 240);
  private view = new DataView(this.buf.buffer);
  private count = 0;
  private readonly prevPos = new Vector3();
  private readonly prevQuat = new Quaternion();
  private prevSteer = 0;
  private prevBrake = 0;
  private prevT = -1;
  private readonly p = new Vector3();
  private readonly q = new Quaternion();

  /** Call every frame from GO on, with the run's clock (seconds since GO) and the car's state at that time. */
  record(t: number, src: GhostSource): void {
    const steer = 0.5 * (src.wheels[0].steerAngle + src.wheels[1].steerAngle);
    if (this.prevT < 0) {
      // the first frame after GO: sample 0 is the car at GO
      this.prevPos.copy(src.position);
      this.prevQuat.copy(src.quaternion);
      this.prevSteer = steer;
      this.prevBrake = src.brake;
      this.prevT = 0;
      this.push(this.prevPos, this.prevQuat, steer, src.brake);
    }
    for (;;) {
      const ts = this.count / GHOST_RATE;
      if (ts > t) break;
      const a = t > this.prevT ? (ts - this.prevT) / (t - this.prevT) : 1;
      this.p.lerpVectors(this.prevPos, src.position, a);
      this.q.slerpQuaternions(this.prevQuat, src.quaternion, a);
      this.push(this.p, this.q, this.prevSteer + (steer - this.prevSteer) * a, this.prevBrake + (src.brake - this.prevBrake) * a);
    }
    this.prevPos.copy(src.position);
    this.prevQuat.copy(src.quaternion);
    this.prevSteer = steer;
    this.prevBrake = src.brake;
    this.prevT = t;
  }

  /** The recording so far (a copy). */
  finish(): Ghost {
    return { rate: GHOST_RATE, count: this.count, bytes: this.buf.slice(0, this.count * BYTES) };
  }

  private push(p: Vector3, q: Quaternion, steer: number, brake: number): void {
    if ((this.count + 1) * BYTES > this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
      this.view = new DataView(bigger.buffer);
    }
    const v = this.view;
    const o = this.count * BYTES;
    v.setFloat32(o, p.x, true);
    v.setFloat32(o + 4, p.y, true);
    v.setFloat32(o + 8, p.z, true);
    const s = q.w < 0 ? -1 : 1; // (one hemisphere, so neighbours interpolate the short way)
    v.setInt16(o + 12, Math.round(q.x * s * 32767), true);
    v.setInt16(o + 14, Math.round(q.y * s * 32767), true);
    v.setInt16(o + 16, Math.round(q.z * s * 32767), true);
    v.setInt16(o + 18, Math.round(q.w * s * 32767), true);
    v.setInt8(o + 20, Math.max(-127, Math.min(127, Math.round(steer * STEER_SCALE))));
    v.setUint8(o + 21, Math.max(0, Math.min(255, Math.round(brake * 255))));
    this.count++;
  }
}

export class GhostPlayer {
  readonly duration: number;
  private readonly view: DataView;
  /** Distance covered up to each sample (m), for the wheels' spin. */
  private readonly dist: Float64Array;
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly d = new Vector3();
  private readonly qa = new Quaternion();
  private readonly qb = new Quaternion();

  constructor(
    readonly ghost: Ghost,
    private readonly radiusFront: number,
    private readonly radiusRear: number,
  ) {
    this.view = new DataView(ghost.bytes.buffer, ghost.bytes.byteOffset, ghost.bytes.byteLength);
    this.duration = Math.max(0, (ghost.count - 1) / ghost.rate);
    this.dist = new Float64Array(Math.max(1, ghost.count));
    for (let i = 1; i < ghost.count; i++) {
      this.posAt(i - 1, this.a);
      this.posAt(i, this.b);
      this.dist[i] = this.dist[i - 1] + this.a.distanceTo(this.b);
    }
  }

  /** The pose `t` seconds after GO (held at the first and last samples outside the recording). */
  pose(t: number, out: GhostPose): GhostPose {
    const n = this.ghost.count;
    if (n === 0) return out;
    const x = Math.max(0, Math.min(n - 1, t * this.ghost.rate));
    const i = Math.min(n - 2, Math.floor(x));
    if (i < 0) {
      this.posAt(0, out.position);
      this.quatAt(0, out.quaternion);
      return out;
    }
    const f = x - i;
    // position: uniform Catmull-Rom through samples i-1, i, i+1, i+2
    this.posAt(Math.max(0, i - 1), this.a);
    this.posAt(i, this.b);
    this.posAt(i + 1, this.c);
    this.posAt(Math.min(n - 1, i + 2), this.d);
    const f2 = f * f;
    const f3 = f2 * f;
    const wa = -0.5 * f3 + f2 - 0.5 * f;
    const wb = 1.5 * f3 - 2.5 * f2 + 1;
    const wc = -1.5 * f3 + 2 * f2 + 0.5 * f;
    const wd = 0.5 * f3 - 0.5 * f2;
    out.position.set(
      wa * this.a.x + wb * this.b.x + wc * this.c.x + wd * this.d.x,
      wa * this.a.y + wb * this.b.y + wc * this.c.y + wd * this.d.y,
      wa * this.a.z + wb * this.b.z + wc * this.c.z + wd * this.d.z,
    );
    // orientation: normalised lerp (20 samples a second: the short arcs make it indistinguishable from slerp)
    this.quatAt(i, this.qa);
    this.quatAt(i + 1, this.qb);
    if (this.qa.dot(this.qb) < 0) this.qb.set(-this.qb.x, -this.qb.y, -this.qb.z, -this.qb.w);
    out.quaternion
      .set(
        this.qa.x + (this.qb.x - this.qa.x) * f,
        this.qa.y + (this.qb.y - this.qa.y) * f,
        this.qa.z + (this.qb.z - this.qa.z) * f,
        this.qa.w + (this.qb.w - this.qa.w) * f,
      )
      .normalize();
    const v = this.view;
    const o0 = i * BYTES;
    const o1 = o0 + BYTES;
    const steer = (v.getInt8(o0 + 20) + (v.getInt8(o1 + 20) - v.getInt8(o0 + 20)) * f) / STEER_SCALE;
    out.brake = (v.getUint8(o0 + 21) + (v.getUint8(o1 + 21) - v.getUint8(o0 + 21)) * f) / 255;
    const dist = this.dist[i] + (this.dist[i + 1] - this.dist[i]) * f;
    for (let w = 0; w < 4; w++) {
      out.wheels[w].steerAngle = w < 2 ? steer : 0;
      out.wheels[w].spin = dist / (w < 2 ? this.radiusFront : this.radiusRear);
    }
    return out;
  }

  private posAt(i: number, out: Vector3): Vector3 {
    const o = i * BYTES;
    const v = this.view;
    return out.set(v.getFloat32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true));
  }

  private quatAt(i: number, out: Quaternion): Quaternion {
    const o = i * BYTES + 12;
    const v = this.view;
    return out.set(v.getInt16(o, true) / 32767, v.getInt16(o + 2, true) / 32767, v.getInt16(o + 4, true) / 32767, v.getInt16(o + 6, true) / 32767).normalize();
  }
}

/** The ghost as text for localStorage: "<version>.<rate>.<count>.<base64>". */
export function encodeGhost(g: Ghost): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < g.bytes.length; i += CHUNK) bin += String.fromCharCode(...g.bytes.subarray(i, i + CHUNK));
  return `${VERSION}.${g.rate}.${g.count}.${btoa(bin)}`;
}

/** Reads encodeGhost's text; null if it is not a ghost this version can play. */
export function decodeGhost(text: string | null | undefined): Ghost | null {
  if (!text) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)\.([A-Za-z0-9+/=]*)$/.exec(text);
  if (!m || Number(m[1]) !== VERSION) return null;
  const rate = Number(m[2]);
  const count = Number(m[3]);
  let bin: string;
  try {
    bin = atob(m[4]);
  } catch {
    return null;
  }
  if (rate <= 0 || bin.length !== count * BYTES) return null;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { rate, count, bytes };
}
