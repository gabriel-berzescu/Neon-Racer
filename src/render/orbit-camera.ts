/**
 * The title screen's camera: a slow orbit round the chosen car, parked on a stage's start line, with the car framed right of
 * centre so the menu on the left leaves it in view.
 */
import * as THREE from 'three';

const RADIUS = 7.2;
const HEIGHT = 1.9;
/** Radians per second. */
const SPEED = 0.16;
/** How far the look point sits to the camera's left of the car (m): the car shows right of centre. */
const SHIFT = 2.4;

const _right = new THREE.Vector3();
const _look = new THREE.Vector3();

export class OrbitCamera {
  private angle = 2.3;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly ground: (x: number, z: number) => number,
  ) {}

  update(target: THREE.Vector3, dt: number): void {
    const cam = this.camera;
    this.angle += SPEED * dt;
    cam.position.set(target.x + Math.sin(this.angle) * RADIUS, target.y + HEIGHT, target.z + Math.cos(this.angle) * RADIUS);
    cam.position.y = Math.max(cam.position.y, this.ground(cam.position.x, cam.position.z) + 0.6);
    cam.up.set(0, 1, 0);
    // the camera's right, level: across the line of sight
    _right.set(Math.cos(this.angle), 0, -Math.sin(this.angle));
    _look.copy(target).addScaledVector(_right, -SHIFT);
    _look.y += 0.2;
    cam.lookAt(_look);
    if (Math.abs(cam.fov - 50) > 0.01) {
      cam.fov = 50;
      cam.updateProjectionMatrix();
    }
  }
}
