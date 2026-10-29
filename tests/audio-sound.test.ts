/**
 * The game's side of the sound (src/audio/index.ts): where there is no Web Audio (node, here) the Sound is silent and every call is safe,
 * and the interface sounds are the ones the game asks for.
 */
import { describe, expect, it } from 'vitest';
import { getCar } from '../src/cars';
import { Sound, UI_SOUND_LIST, type UiSound } from '../src/audio';
import { Drive } from '../src/audio/lab/drive';

describe('Sound', () => {
  it('without Web Audio it is silent, not locked, and every call is safe', () => {
    const s = new Sound();
    expect(s.ctx).toBeNull();
    expect(s.locked).toBe(false);
    const d = new Drive(getCar('volta'));
    s.setVolume(0.8);
    s.setCar(getCar('volta'));
    for (let i = 0; i < 10; i++) s.update(d.step(1 / 60, { throttle: 1 }), 1 / 60, { paused: i > 5 });
    s.update(null, 1 / 60, { paused: false });
    s.setInterior(true);
    for (const u of UI_SOUND_LIST) s.ui(u);
    s.setCar(null);
    s.dispose();
  });

  it('has the interface sounds the game asks for', () => {
    const want: UiSound[] = ['move', 'select', 'back', 'countdown', 'go', 'checkpoint', 'best', 'finish'];
    expect([...UI_SOUND_LIST].sort()).toEqual([...want].sort());
  });
});
