/**
 * The player's settings, kept in the browser (localStorage, per site: the Pages site and play.bat keep their own).
 *
 *   quality   'auto' (src/render/quality.ts adapts to the GPU) or a fixed level, an index into QUALITY
 *   volume    master sound volume, 0..1
 *   car       the car last chosen (a CARS id)
 *   aids      Xeno-Racer's three sets of driving aids: 'off' (its pro: nothing), 'standard' (ABS, low traction control, stability
 *             control, a little counter-steer help) and 'full' (its beginner: everything on, more help)
 *   gearbox   'auto' or 'manual' (RB / LB)
 *   camera    the view the next run starts in (Y cycles them while driving)
 *   ghost     the best run's ghost on the road
 */
import type { Assists } from './core/contracts';

export type AidsLevel = 'off' | 'standard' | 'full';
export type CameraView = 'chase' | 'far' | 'hood';

export interface Settings {
  quality: 'auto' | number;
  volume: number;
  car: string;
  aids: AidsLevel;
  gearbox: 'auto' | 'manual';
  camera: CameraView;
  ghost: boolean;
}

export const DEFAULT_SETTINGS: Settings = { quality: 'auto', volume: 0.8, car: 'lmp-x', aids: 'standard', gearbox: 'auto', camera: 'chase', ghost: true };

export const AIDS: Record<AidsLevel, Omit<Assists, 'autoShift'>> = {
  off: { abs: false, tcs: 'off', esc: false, steeringAssist: 0, autoClutch: true },
  standard: { abs: true, tcs: 'low', esc: true, steeringAssist: 0.35, autoClutch: true },
  full: { abs: true, tcs: 'high', esc: true, steeringAssist: 0.65, autoClutch: true },
};
export const AIDS_LABEL: Record<AidsLevel, string> = { off: 'off', standard: 'standard', full: 'full help' };
export const AIDS_ORDER: AidsLevel[] = ['off', 'standard', 'full'];
export const CAMERA_ORDER: CameraView[] = ['chase', 'far', 'hood'];

/** The aids the physics reads (Vehicle.assists) for these settings. */
export function assistsFor(s: Settings): Assists {
  return { ...AIDS[s.aids], autoShift: s.gearbox === 'auto' };
}

const KEY = 'neon-racer.settings';

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Settings> | null;
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_SETTINGS };
    const s = { ...DEFAULT_SETTINGS, ...saved };
    if (s.quality !== 'auto' && !(typeof s.quality === 'number' && s.quality >= 0 && s.quality <= 3)) s.quality = 'auto';
    s.volume = typeof s.volume === 'number' ? Math.max(0, Math.min(1, s.volume)) : DEFAULT_SETTINGS.volume;
    if (typeof s.car !== 'string') s.car = DEFAULT_SETTINGS.car;
    if (!AIDS_ORDER.includes(s.aids)) s.aids = DEFAULT_SETTINGS.aids;
    if (s.gearbox !== 'manual') s.gearbox = 'auto';
    if (!CAMERA_ORDER.includes(s.camera)) s.camera = DEFAULT_SETTINGS.camera;
    s.ghost = s.ghost !== false;
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // not kept: they apply for this visit
  }
}
