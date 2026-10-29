/**
 * The driving controls, from a gamepad (Logitech F310 in X mode = the `standard` mapping) or the keyboard.
 *
 *   left stick  X  -> steering, half lock      both sticks add up: one stick all the way = half lock, both the same way = full lock,
 *   right stick X  -> steering, half lock      opposite ways = straight ahead (Gabriel's design)
 *   right trigger  -> throttle (analog)
 *   left trigger   -> brake (analog)
 *   A              -> handbrake (held)
 *   RB / LB        -> shift up / down (manual gearbox only)
 *   Y              -> camera
 *   Back           -> put the car back on the road
 *   Start          -> pause
 * The sticks' Y axes do nothing while driving. In menus: the D-pad or the left stick moves, A confirms, B goes back, X retries.
 *
 * Keyboard (mirrors the pad): A / D = the left stick, Left / Right = the right stick (so one key is half lock, as one stick is),
 * W or Up = throttle, S or Down = brake, Space = handbrake, Shift / Q = shift up / down, C = camera, R = reset, Esc or P = pause.
 * Keyboard steering ramps in and recentres like a thumb would.
 *
 * Each stick gets Xeno-Racer's processing: a radial dead zone over the whole stick (a diagonal still steers fully) and a power curve for
 * fine control near the centre. The physics' SteeringFilter then turns the command into a road-wheel angle (rate-limited, and at
 * speed scaled to what the front tyres can use).
 */
import { RepeatEdge, hysteresis, pedal, prettyPadName, radialDeadzone, responseCurve } from './processing';

export interface DriveControls {
  /** Each stick's steering after its dead zone and curve, -1 (left) .. 1 (right). */
  stickLeft: number;
  stickRight: number;
  /** The steering command: half of each stick, -1 .. 1. */
  steer: number;
  throttle: number;
  brake: number;
  handbrake: number;
}

export interface Nav {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  confirm: boolean;
  back: boolean;
  /** X (pad) or R (keyboard): retry, in the menus that offer it. */
  retry: boolean;
}

export interface ControlFrame extends DriveControls {
  /** One-shot edges, true for exactly one poll. */
  shiftUp: boolean;
  shiftDown: boolean;
  camera: boolean;
  reset: boolean;
  pause: boolean;
  /** Menu navigation edges (with auto-repeat while a direction is held). */
  nav: Nav;
  /** Any control moved this frame (to hide the help card, ...). */
  active: boolean;
  device: 'gamepad' | 'keyboard' | 'none';
  padName: string | null;
}

/** The part of a Gamepad this module reads (tests fake it). */
export interface PadLike {
  readonly id: string;
  readonly connected: boolean;
  readonly mapping: string;
  readonly axes: ArrayLike<number>;
  readonly buttons: ArrayLike<{ readonly pressed: boolean; readonly value: number }>;
}

/** Xeno-Racer's defaults (its src/core/settings.ts). */
export const STICK_DEADZONE = 0.08;
export const STICK_LINEARITY = 1.6;
export const PEDAL_DEADZONE = 0.04;

/** The steering command from the two sticks: each adds half lock. */
export function combineSticks(left: number, right: number): number {
  return Math.max(-1, Math.min(1, 0.5 * (left + right)));
}

const _dz = [0, 0];
/** One stick's steering: X after a radial dead zone over (x, y), then the response curve. */
export function shapeStick(x: number, y: number): number {
  radialDeadzone(x, y, STICK_DEADZONE, _dz);
  return responseCurve(_dz[0], STICK_LINEARITY);
}

/** Standard-mapping indices (W3C Gamepad API). */
const AX = { lx: 0, ly: 1, rx: 2, ry: 3 } as const;
const BTN = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, back: 8, start: 9, up: 12, down: 13, left: 14, right: 15 } as const;

const KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyQ',
  'KeyC', 'KeyR', 'KeyP', 'Escape', 'Enter', 'NumpadEnter', 'Backspace',
]);
/** Keyboard steering: how fast a held key moves its virtual stick in, and how fast it returns (per second). */
const KEY_STEER_RATE = 3.0;
const KEY_STEER_RETURN = 5.0;
/** Keyboard pedals: a held key presses its pedal in this fast (per second), and lets go at once. */
const KEY_PEDAL_RATE = 6.0;

function approach(v: number, target: number, up: number, down: number, dt: number): number {
  const rate = Math.abs(target) > Math.abs(v) || Math.sign(target) !== Math.sign(v) ? up : down;
  const d = target - v;
  const s = rate * dt;
  return Math.abs(d) <= s ? target : v + Math.sign(d) * s;
}

type Edge = 'shiftUp' | 'shiftDown' | 'camera' | 'reset' | 'pause' | 'confirm' | 'back' | 'retry' | 'up' | 'down' | 'left' | 'right';

export class Controls {
  readonly frame: ControlFrame = {
    stickLeft: 0, stickRight: 0, steer: 0, throttle: 0, brake: 0, handbrake: 0,
    shiftUp: false, shiftDown: false, camera: false, reset: false, pause: false,
    nav: { up: false, down: false, left: false, right: false, confirm: false, back: false, retry: false },
    active: false, device: 'none', padName: null,
  };
  private readonly held = new Set<string>();
  /** Key presses since the last poll (edges). */
  private readonly keyEdges = new Set<Edge>();
  private readonly padWasDown = new Map<number, boolean>();
  private readonly repeat = { up: new RepeatEdge(), down: new RepeatEdge(), left: new RepeatEdge(), right: new RepeatEdge() };
  private stickNav = { x: 0, y: 0 };
  private kb = { l: 0, r: 0, throttle: 0, brake: 0 };
  private lastPadActivity = -Infinity;
  private lastKeyActivity = -Infinity;
  private time = 0;

  constructor(
    private readonly getPads: () => ArrayLike<PadLike | null> = () => (typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []),
    target: EventTarget | null = typeof window !== 'undefined' ? window : null,
  ) {
    if (target) {
      target.addEventListener('keydown', (e) => this.onKey(e as KeyboardEvent, true));
      target.addEventListener('keyup', (e) => this.onKey(e as KeyboardEvent, false));
      target.addEventListener('blur', () => this.held.clear());
    }
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (!KEYS.has(e.code)) return;
    e.preventDefault();
    if (down && !e.repeat) {
      const k = this.keyEdges;
      switch (e.code) {
        case 'ShiftLeft': case 'ShiftRight': k.add('shiftUp'); break;
        case 'KeyQ': k.add('shiftDown'); break;
        case 'KeyC': k.add('camera'); break;
        case 'KeyR': k.add('reset'); k.add('retry'); break;
        case 'KeyP': k.add('pause'); break;
        case 'Escape': k.add('pause'); k.add('back'); break;
        case 'Enter': case 'NumpadEnter': k.add('confirm'); break;
        case 'Backspace': k.add('back'); break;
      }
    }
    if (down) this.held.add(e.code);
    else this.held.delete(e.code);
    this.lastKeyActivity = this.time;
  }

  /** The pad to read: the first connected one in standard mapping (else the first connected one). */
  private pad(): PadLike | null {
    let any: PadLike | null = null;
    let pads: ArrayLike<PadLike | null>;
    try {
      pads = this.getPads();
    } catch {
      return null;
    }
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || !p.connected) continue;
      if (p.mapping === 'standard') return p;
      any ??= p;
    }
    return any;
  }

  poll(dt: number): ControlFrame {
    this.time += dt;
    const f = this.frame;
    const prev = { l: f.stickLeft, r: f.stickRight, t: f.throttle, b: f.brake, h: f.handbrake };

    // keyboard state (always tracked, so switching devices is seamless)
    const h = this.held;
    const kb = this.kb;
    const kl = (h.has('KeyD') ? 1 : 0) - (h.has('KeyA') ? 1 : 0);
    const kr = (h.has('ArrowRight') ? 1 : 0) - (h.has('ArrowLeft') ? 1 : 0);
    kb.l = approach(kb.l, kl, KEY_STEER_RATE, KEY_STEER_RETURN, dt);
    kb.r = approach(kb.r, kr, KEY_STEER_RATE, KEY_STEER_RETURN, dt);
    kb.throttle = h.has('KeyW') || h.has('ArrowUp') ? Math.min(1, kb.throttle + KEY_PEDAL_RATE * dt) : 0;
    kb.brake = h.has('KeyS') || h.has('ArrowDown') ? Math.min(1, kb.brake + KEY_PEDAL_RATE * dt) : 0;
    const khand = h.has('Space') ? 1 : 0;

    const pad = this.pad();
    const btn = (i: number) => !!pad?.buttons[i]?.pressed;
    const edge = (i: number) => {
      const down = btn(i);
      const was = this.padWasDown.get(i) ?? false;
      this.padWasDown.set(i, down);
      return down && !was;
    };
    let pl = 0, pr = 0, pt = 0, pb = 0, ph = 0;
    let lx = 0, ly = 0;
    if (pad) {
      lx = pad.axes[AX.lx] ?? 0;
      ly = pad.axes[AX.ly] ?? 0;
      pl = shapeStick(lx, ly);
      pr = shapeStick(pad.axes[AX.rx] ?? 0, pad.axes[AX.ry] ?? 0);
      pt = pedal(pad.buttons[BTN.rt]?.value ?? 0, PEDAL_DEADZONE);
      pb = pedal(pad.buttons[BTN.lt]?.value ?? 0, PEDAL_DEADZONE);
      ph = btn(BTN.a) ? 1 : 0;
      let any = pl !== 0 || pr !== 0 || pt > 0.05 || pb > 0.05 || Math.abs(ly) > 0.5;
      for (let i = 0; i < 16 && !any; i++) any = btn(i);
      if (any) this.lastPadActivity = this.time;
    }
    const usePad = pad !== null && this.lastPadActivity >= this.lastKeyActivity;
    if (usePad) {
      f.stickLeft = pl; f.stickRight = pr; f.throttle = pt; f.brake = pb; f.handbrake = ph;
      f.device = 'gamepad';
    } else {
      f.stickLeft = kb.l; f.stickRight = kb.r; f.throttle = kb.throttle; f.brake = kb.brake; f.handbrake = khand;
      f.device = pad || this.lastKeyActivity > -Infinity ? 'keyboard' : 'none';
    }
    f.steer = combineSticks(f.stickLeft, f.stickRight);
    f.padName = pad ? prettyPadName(pad.id) : null;

    // one-shot edges: the pad's buttons and the keys pressed since the last poll
    const k = this.keyEdges;
    f.shiftUp = edge(BTN.rb) || k.has('shiftUp');
    f.shiftDown = edge(BTN.lb) || k.has('shiftDown');
    f.camera = edge(BTN.y) || k.has('camera');
    f.reset = edge(BTN.back) || k.has('reset');
    f.pause = edge(BTN.start) || k.has('pause');
    const n = f.nav;
    n.confirm = edge(BTN.a) || k.has('confirm');
    n.back = edge(BTN.b) || k.has('back');
    n.retry = edge(BTN.x) || k.has('retry');
    // menu directions: the D-pad, the left stick (with hysteresis) and the arrow keys, repeating while held
    this.stickNav.x = hysteresis(lx, this.stickNav.x);
    this.stickNav.y = hysteresis(ly, this.stickNav.y);
    n.up = this.repeat.up.update(btn(BTN.up) || this.stickNav.y < 0 || h.has('ArrowUp'), dt);
    n.down = this.repeat.down.update(btn(BTN.down) || this.stickNav.y > 0 || h.has('ArrowDown'), dt);
    n.left = this.repeat.left.update(btn(BTN.left) || this.stickNav.x < 0 || h.has('ArrowLeft'), dt);
    n.right = this.repeat.right.update(btn(BTN.right) || this.stickNav.x > 0 || h.has('ArrowRight'), dt);
    k.clear();

    f.active =
      f.pause || f.camera || f.reset || n.confirm || n.back ||
      Math.abs(f.stickLeft - prev.l) > 1e-3 || Math.abs(f.stickRight - prev.r) > 1e-3 ||
      Math.abs(f.throttle - prev.t) > 1e-3 || Math.abs(f.brake - prev.b) > 1e-3 || f.handbrake !== prev.h;
    return f;
  }
}
