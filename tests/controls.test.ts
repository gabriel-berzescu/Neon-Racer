/**
 * The two-stick steering (Gabriel's design): both sticks' X axes add up, half lock each; opposite ways cancel.
 */
import { describe, expect, it } from 'vitest';
import { Controls, combineSticks, shapeStick, type PadLike } from '../src/input/controls';

function fakePad(axes: number[], pressed: number[] = [], values: Record<number, number> = {}): PadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), value: values[i] ?? (pressed.includes(i) ? 1 : 0) }));
  return { id: 'Logitech Gamepad F310 (STANDARD GAMEPAD Vendor: 046d Product: c21d)', connected: true, mapping: 'standard', axes, buttons };
}

function frameWith(pad: PadLike) {
  const c = new Controls(() => [pad], null);
  return c.poll(1 / 60);
}

describe('two-stick steering', () => {
  it('one stick all the way is half lock', () => {
    expect(frameWith(fakePad([1, 0, 0, 0])).steer).toBeCloseTo(0.5, 5);
    expect(frameWith(fakePad([0, 0, -1, 0])).steer).toBeCloseTo(-0.5, 5);
  });

  it('both sticks the same way are full lock', () => {
    expect(frameWith(fakePad([1, 0, 1, 0])).steer).toBeCloseTo(1, 5);
    expect(frameWith(fakePad([-1, 0, -1, 0])).steer).toBeCloseTo(-1, 5);
  });

  it('opposite ways do nothing', () => {
    expect(frameWith(fakePad([1, 0, -1, 0])).steer).toBeCloseTo(0, 5);
    expect(frameWith(fakePad([-0.6, 0, 0.6, 0])).steer).toBeCloseTo(0, 5);
  });

  it('adds partial deflections', () => {
    const f = frameWith(fakePad([0.5, 0, 0.8, 0]));
    expect(f.steer).toBeCloseTo(combineSticks(shapeStick(0.5, 0), shapeStick(0.8, 0)), 6);
    expect(f.steer).toBeGreaterThan(f.stickLeft / 2);
  });

  it('a stick in the corner of a square gate still steers fully, and the Y axes alone do nothing', () => {
    expect(shapeStick(1, -1)).toBeCloseTo(1, 5);
    expect(frameWith(fakePad([0, 1, 0, -1])).steer).toBe(0);
  });

  it('ignores a resting stick inside the dead zone', () => {
    expect(frameWith(fakePad([0.05, 0.03, -0.06, 0])).steer).toBe(0);
  });

  it('reads the triggers as throttle and brake, A as the handbrake', () => {
    const f = frameWith(fakePad([0, 0, 0, 0], [0], { 6: 0.5, 7: 1 }));
    expect(f.throttle).toBe(1);
    expect(f.brake).toBeGreaterThan(0.45);
    expect(f.brake).toBeLessThan(0.5);
    expect(f.handbrake).toBe(1);
  });
});

describe('keyboard', () => {
  it('mirrors the pad: one key is half lock, A and Right together are full lock', () => {
    const target = new EventTarget();
    const c = new Controls(() => [], target);
    const press = (code: string) => {
      const e = new Event('keydown') as Event & { code: string; repeat: boolean };
      Object.assign(e, { code, repeat: false });
      target.dispatchEvent(e);
    };
    press('KeyD');
    let f = c.poll(1 / 60);
    for (let i = 0; i < 60; i++) f = c.poll(1 / 60);
    expect(f.steer).toBeCloseTo(0.5, 5);
    press('ArrowRight');
    for (let i = 0; i < 60; i++) f = c.poll(1 / 60);
    expect(f.steer).toBeCloseTo(1, 5);
    expect(f.device).toBe('keyboard');
  });
});
