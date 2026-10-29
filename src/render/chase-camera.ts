/**
 * The car's cameras: 'chase' (close behind and above), 'far' (further back and higher), 'hood' (on the nose, looking down the road).
 *
 * The chase views follow the car's heading through a soft spring, so a quick turn of the nose reads as motion and a slide shows
 * the car's angle, and they follow the road's slope but not the car's roll: the horizon stays level. They never go below the ground.
 * The field of view opens up with speed.
 */
import * as THREE from 'three';
import type { CameraView } from '../settings';

export interface CameraTarget {
  /** The centre of mass and orientation (VehicleState: +Z forward, +Y up). */
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
}

const VIEWS: Record<CameraView, { back: number; up: number; lookUp: number; lookAhead: number; fov: [number, number] }> = {
  chase: { back: 6.4, up: 2.1, lookUp: 0.9, lookAhead: 6, fov: [62, 76] },
  far: { back: 10.5, up: 3.6, lookUp: 1.1, lookAhead: 10, fov: [58, 70] },
  hood: { back: -1.2, up: 0.75, lookUp: 0.55, lookAhead: 30, fov: [70, 84] },
};
/** How fast the chase views turn after the car's heading (1/s), and lean with the road's slope. */
const YAW_RATE = 5.5;
const PITCH_RATE = 3;

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _look = new THREE.Vector3();

export class ChaseCamera {
  view: CameraView = 'chase';
  private yaw = 0;
  private pitch = 0;
  private initialised = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly ground: (x: number, z: number) => number,
  ) {}

  reset(): void {
    this.initialised = false;
  }

  update(t: CameraTarget, dt: number): void {
    const cam = this.camera;
    const v = VIEWS[this.view];
    _fwd.set(0, 0, 1).applyQuaternion(t.quaternion);
    const yaw = Math.atan2(_fwd.x, _fwd.z);
    const pitch = Math.asin(Math.max(-1, Math.min(1, _fwd.y)));
    if (!this.initialised || this.view === 'hood') {
      this.yaw = yaw;
      this.pitch = pitch;
      this.initialised = true;
    } else {
      let d = yaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * (1 - Math.exp(-YAW_RATE * dt));
      this.pitch += (pitch - this.pitch) * (1 - Math.exp(-PITCH_RATE * dt));
    }
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    // the camera's forward: the softened heading, tilted with the slope
    _fwd.set(sy * cp, sp, cy * cp);
    if (this.view === 'hood') {
      // on the car itself: its own up, so it pitches and rolls with the body
      _up.set(0, 1, 0).applyQuaternion(t.quaternion);
      _fwd.set(0, 0, 1).applyQuaternion(t.quaternion);
      cam.position.copy(t.position).addScaledVector(_fwd, -v.back).addScaledVector(_up, v.up);
      cam.up.copy(_up);
    } else {
      cam.position.copy(t.position).addScaledVector(_fwd, -v.back);
      cam.position.y += v.up;
      const floor = this.ground(cam.position.x, cam.position.z) + 0.8;
      if (cam.position.y < floor) cam.position.y = floor;
      cam.up.set(0, 1, 0);
    }
    _look.copy(t.position).addScaledVector(_fwd, v.lookAhead);
    _look.y += v.lookUp;
    cam.lookAt(_look);

    const speed = t.velocity.length();
    const fov = v.fov[0] + (v.fov[1] - v.fov[0]) * Math.min(1, Math.max(0, (speed - 20) / 70));
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * (1 - Math.exp(-3 * dt));
      cam.updateProjectionMatrix();
    }
  }
}
