/**
 * The game. A title screen (the chosen car parked on a stage's start line, a slow orbit, the main menu), and runs: a stage built from
 * its number (the seed), a countdown, a standing start, checkpoints, the finish, and the results. The best run on each stage is
 * kept with its ghost (src/game/records.ts), which drives along on the next run.
 *
 * Each frame: read the controls (menus first), drive the car (the steering filter, the physics at 1000 Hz), follow it along the
 * road (the run's checkpoints), record it, pose the ghost, the car and the camera, update the world, the HUD and the sound, render.
 *
 * The world (the stage generator, the terrain and the road), the car models and the sound come in from main.ts.
 *
 * Debug / QA hooks: `window.__nr` (the game), `window.__READY__` (true once the first frames are on screen); URL `?stage=<number>`
 * starts a run on that stage, `?car=<id>` picks the car, `?q=` fixes the quality level, `?autodrive=1` drives for you (a QA tool).
 */
import * as THREE from 'three';
import { CARS } from './cars';
import type { CarDefinition, ControlSettings, TrackFrame, TrackPoint, TrackRuntime, VehicleState } from './core/contracts';
import { PhysicsWorld, SteeringFilter, type Vehicle } from './physics';
import { Controls } from './input/controls';
import { ChaseCamera } from './render/chase-camera';
import { OrbitCamera } from './render/orbit-camera';
import { QUALITY, Stage as Renderer } from './render/stage';
import { QualityGovernor } from './render/quality';
import { CONTROLS_CARD, Hud, type HudView } from './ui/hud';
import { Menu, type MenuChoice, type MenuPick, type MenuSpec } from './ui/menu';
import { SeedEntry } from './ui/seed-entry';
import { StageRun, formatDelta, formatTime } from './game/run';
import { GhostPlayer, GhostRecorder, makeGhostPose, type GhostPose } from './game/ghost';
import { Records, type SaveResult } from './game/records';
import { autodrive } from './game/autodrive';
import { AIDS_LABEL, AIDS_ORDER, CAMERA_ORDER, assistsFor, loadSettings, saveSettings, type Settings } from './settings';

/** Something in the world that follows the camera (sky, terrain, road). */
export interface WorldView {
  readonly object: THREE.Object3D;
  update(camera: THREE.PerspectiveCamera, timeSeconds: number): void;
}

/** A stage as the game sees it (src/world/stage.ts makes them). */
export interface StageInfo {
  readonly seed: number;
  readonly track: TrackRuntime;
  /** Ascending distances along the road; the last is the finish line. */
  readonly checkpoints: readonly number[];
  readonly name: string;
}

export interface World {
  views: WorldView[];
  /** Unit vector toward the sun (world space), for the cars' light. */
  sunDirection: THREE.Vector3;
  /** The ground as drawn (the cameras keep above it). */
  groundHeight(x: number, z: number): number;
  generate(seed: number): StageInfo;
  newSeed(): number;
  /** Puts a stage into the world (carves the terrain, lays the road), or takes it out (null). */
  activate(stage: StageInfo | null): void;
  /** How a checkpoint's arch shows: the next one to reach, one passed, one further on. */
  setCheckpoint(index: number, state: 'ahead' | 'next' | 'passed'): void;
}

/** What the game needs of a car model (src/render/car.ts). */
export interface CarViewLike {
  readonly object: THREE.Object3D;
  update(pose: CarPoseLike, dt: number): void;
  dispose(): void;
}
export interface CarPoseLike {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  brake: number;
  aeroOpen?: number;
  wheels: ReadonlyArray<{ steerAngle: number; spin: number; compression?: number }>;
}
export type MakeCarView = (def: CarDefinition, opts?: { ghost?: boolean }) => CarViewLike;

/** What the game needs of the sound (src/audio). */
export interface SoundLike {
  readonly locked: boolean;
  setCar(def: CarDefinition | null): void;
  update(state: VehicleState | null, dt: number, opts: { paused: boolean }): void;
  setVolume(v: number): void;
  ui(name: 'move' | 'select' | 'back' | 'countdown' | 'go' | 'checkpoint' | 'best' | 'finish'): void;
}

/** The stage parked under the title screen. */
const TITLE_SEED = 1;
/** Seconds between crossing the finish line and the results card. */
const RESULTS_DELAY = 1.6;
/** Upside down or on its side this long, and the car is put back on the road by itself. */
const FLIPPED_RESET = 1.5;
/** Xeno-Racer's steering feel (its default control settings). */
const STEERING: ControlSettings = { steerDeadzone: 0.08, steerLinearity: 1.6, pedalDeadzone: 0.04, speedSensitivity: 0.6, steerSpeed: 1, vibration: false, invertLookY: false };

type Mode = 'title' | 'drive';
type Back = 'title' | 'pause' | 'results';

const _frame: TrackFrame = {
  position: new THREE.Vector3(), tangent: new THREE.Vector3(), normal: new THREE.Vector3(), left: new THREE.Vector3(),
  widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, curvature: 0, bank: 0,
};
const _tp: TrackPoint = { s: 0, d: 0, segment: 0, widthLeft: 0, widthRight: 0, wallLeft: 0, wallRight: 0, tx: 0, tz: 1, lx: 1, lz: 0, y: 0 };
const _m4 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _up = new THREE.Vector3();

function carById(id: string | null | undefined): CarDefinition {
  return CARS.find((c) => c.id === id) ?? CARS[0];
}

export function stageLabel(seed: number, name?: string): string {
  const n = String(seed).padStart(6, '0');
  return name ? `stage ${n} · ${name}` : `stage ${n}`;
}

export class Game {
  readonly renderer: Renderer;
  readonly controls = new Controls();
  readonly hud: Hud;
  readonly menu: Menu;
  readonly seedEntry: SeedEntry;
  readonly quality: QualityGovernor;
  readonly records = new Records();
  readonly settings: Settings = loadSettings();
  mode: Mode = 'title';
  stage: StageInfo | null = null;
  run: StageRun | null = null;
  physics: PhysicsWorld | null = null;
  car: Vehicle | null = null;
  carDef: CarDefinition;
  private carView: CarViewLike | null = null;
  private ghostView: CarViewLike | null = null;
  private ghostPlayer: GhostPlayer | null = null;
  private ghostDef: CarDefinition | null = null;
  private readonly ghostPose: GhostPose = makeGhostPose();
  private recorder: GhostRecorder | null = null;
  private readonly steering = new SteeringFilter();
  private chase!: ChaseCamera;
  private orbit!: OrbitCamera;
  private paused = false;
  private menuBack: Back = 'title';
  private titleSel = 0;
  private resultsIn = Infinity;
  private lastSave: SaveResult | null = null;
  private flipped = 0;
  /** The car's segment on the road, for TrackRuntime.project. */
  private hint = -1;
  private countdownShown = 0;
  private wentGo = false;
  /** Work to do on the next frame, after a "building stage" message has been drawn. */
  private pending: (() => void) | null = null;
  private time = 0;
  private last = 0;
  private frames = 0;
  private readonly qualityFromUrl: boolean;
  private readonly autodrive: boolean;
  private readonly parkedPose: CarPoseLike = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    brake: 0,
    wheels: [0, 1, 2, 3].map(() => ({ steerAngle: 0, spin: 0 })),
  };

  constructor(
    canvas: HTMLCanvasElement,
    ui: HTMLElement,
    readonly world: World,
    private readonly makeCarView: MakeCarView,
    readonly sound: SoundLike,
  ) {
    const params = new URLSearchParams(location.search);
    this.renderer = new Renderer(canvas);
    const q = params.get('q');
    if (q !== null) this.renderer.quality = /^\d$/.test(q) ? +q : QUALITY.findIndex((l) => l.name === q);
    this.qualityFromUrl = q !== null;
    this.autodrive = params.has('autodrive');
    if (params.get('car')) this.settings.car = carById(params.get('car')).id;
    this.carDef = carById(this.settings.car);
    this.hud = new Hud(ui);
    this.menu = new Menu(ui);
    this.seedEntry = new SeedEntry(ui);
    this.quality = new QualityGovernor(this.renderer, this.qualityFromUrl);
    this.quality.onChange = (name) => this.hud.flash(`graphics: ${name}, for a smooth frame rate`);
    const scene = this.renderer.scene;
    for (const v of world.views) scene.add(v.object);
    // light for the cars: a dim violet sky, the low sun
    scene.add(new THREE.HemisphereLight(0x6a3cff, 0x0a0614, 0.55));
    const sun = new THREE.DirectionalLight(0xff4fa3, 1.3);
    sun.position.copy(world.sunDirection).multiplyScalar(1000);
    scene.add(sun);
    (window as unknown as { __nr: Game }).__nr = this;
  }

  async boot(): Promise<void> {
    this.chase = new ChaseCamera(this.renderer.camera, (x, z) => this.world.groundHeight(x, z));
    this.chase.view = this.settings.camera;
    this.orbit = new OrbitCamera(this.renderer.camera, (x, z) => this.world.groundHeight(x, z));
    this.applySettings();
    const params = new URLSearchParams(location.search);
    const st = params.get('stage');
    if (st !== null) this.startStage(st === '' ? this.world.newSeed() : Number(st) >>> 0);
    else this.openTitle();
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Title
  // ───────────────────────────────────────────────────────────────────────────

  openTitle(selected = this.titleSel): void {
    this.mode = 'title';
    this.paused = false;
    this.run = null;
    this.physics = null;
    this.car = null;
    this.dropGhost();
    this.hud.setVisible(false);
    this.hud.resetRun();
    this.sound.setCar(null);
    if (this.stage?.seed !== TITLE_SEED) this.useStage(this.world.generate(TITLE_SEED));
    this.showCar();
    this.parkCar();
    this.showTitleMenu(selected);
  }

  private showTitleMenu(selected = 0): void {
    this.menuBack = 'title';
    const recent = this.records.recent(1).length > 0;
    const choices: MenuChoice[] = [
      { id: 'new', label: 'Drive a new stage' },
      { id: 'number', label: 'Stage number…' },
      ...(recent ? [{ id: 'recent', label: 'Stages driven' }] : []),
      { id: 'car', label: 'Car', key: this.carDef.name, adjust: true },
      { id: 'settings', label: 'Settings' },
      { id: 'controls', label: 'Controls' },
      { id: 'credits', label: 'Credits' },
    ];
    this.menu.open({
      title: 'Neon-Racer',
      style: 'title',
      body: `${this.carBlurb()}`,
      selected: Math.min(selected, choices.length - 1),
      choices,
    });
  }

  private carBlurb(): string {
    const c = this.carDef;
    return `${c.stats.powerHp} hp &middot; ${c.stats.massKg} kg &middot; ${c.stats.topSpeedKmh} km/h`;
  }

  private openRecent(): void {
    this.menuBack = 'title';
    const list = this.records.recent(8);
    this.menu.open({
      title: 'Stages driven',
      style: 'title',
      body: 'your best time on each, and the car',
      back: 'back',
      choices: [
        ...list.map((r) => ({ id: `stage:${r.seed}`, label: `${String(r.seed).padStart(6, '0')}`, key: `${formatTime(r.best, 2)} · ${carById(r.car).name}` })),
        { id: 'back', label: 'Back', key: 'B' },
      ],
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Runs
  // ───────────────────────────────────────────────────────────────────────────

  /** A run on stage `seed`: builds it (unless it is the one already laid), then the countdown. */
  startStage(seed: number): void {
    this.menu.close();
    this.seedEntry.close();
    if (this.stage?.seed !== seed) {
      // building a stage takes a moment: say so first, build on the next frame
      this.hud.setVisible(true);
      this.hud.resetRun();
      this.hud.flash(`building ${stageLabel(seed)}…`, 1.5);
      this.pending = () => {
        this.useStage(this.world.generate(seed));
        this.beginRun();
      };
      return;
    }
    this.beginRun();
  }

  private useStage(stage: StageInfo): void {
    this.stage = stage;
    this.world.activate(stage);
  }

  private beginRun(): void {
    const stage = this.stage!;
    this.mode = 'drive';
    this.paused = false;
    this.resultsIn = Infinity;
    this.lastSave = null;
    this.flipped = 0;
    this.wentGo = false;
    this.countdownShown = 0;
    this.menu.close();
    this.hud.setVisible(true);
    this.hud.resetRun();
    this.hud.showControlsCard();
    this.records.touch(stage.seed);
    // the car, on the start line, held until GO
    this.physics = new PhysicsWorld(stage.track);
    this.car = this.physics.addVehicle(this.carDef);
    this.car.assists = assistsFor(this.settings);
    this.car.setTemperatures(1);
    const g = stage.track.grid[0];
    this.car.placeOnGround(g.position, g.quaternion, 0);
    this.car.holdOnGrid = true;
    this.hint = -1;
    this.steering.reset();
    this.showCar();
    this.sound.setCar(this.carDef);
    this.chase.reset();
    // the best run here: its splits to beat, its ghost on the road
    const rec = this.records.get(stage.seed);
    this.dropGhost();
    if (rec && this.settings.ghost) {
      const ghost = this.records.ghost(stage.seed);
      if (ghost) {
        this.ghostDef = carById(rec.car);
        this.ghostPlayer = new GhostPlayer(ghost, this.ghostDef.visual.wheelRadiusFront, this.ghostDef.visual.wheelRadiusRear);
        this.ghostView = this.makeCarView(this.ghostDef, { ghost: true });
        this.renderer.scene.add(this.ghostView.object);
      }
    }
    this.run = new StageRun(stage.checkpoints, rec ? rec.splits : null, g.s);
    this.recorder = new GhostRecorder();
    stage.checkpoints.forEach((_, i) => this.world.setCheckpoint(i, i === 0 ? 'next' : 'ahead'));
  }

  private dropGhost(): void {
    if (this.ghostView) {
      this.renderer.scene.remove(this.ghostView.object);
      this.ghostView.dispose();
    }
    this.ghostView = null;
    this.ghostPlayer = null;
    this.ghostDef = null;
  }

  /** The car model for this.carDef (rebuilt when the car changes). */
  private showCar(): void {
    if (this.carView && (this.carView as { def?: CarDefinition }).def === this.carDef) return;
    if (this.carView) {
      this.renderer.scene.remove(this.carView.object);
      this.carView.dispose();
    }
    const view = this.makeCarView(this.carDef);
    (view as { def?: CarDefinition }).def = this.carDef;
    this.carView = view;
    this.renderer.scene.add(view.object);
  }

  /** The title's car: parked on the title stage's start line. */
  private parkCar(): void {
    const g = this.stage!.track.grid[0];
    _up.set(0, 1, 0).applyQuaternion(g.quaternion);
    this.parkedPose.position.copy(g.position).addScaledVector(_up, this.carDef.physics.chassis.cgHeight);
    this.parkedPose.quaternion.copy(g.quaternion);
  }

  /** Back on the road (the Back button, or the car upside down): on the centre line where the run had got to, at a standstill. */
  private resetCar(): void {
    const car = this.car;
    const run = this.run;
    const stage = this.stage;
    if (!car || !run || !stage || run.phase !== 'running') return;
    const tr = stage.track;
    tr.project(car.p.x, car.p.z, _tp);
    const s = tr.wrapS(Math.min(_tp.s, run.progress));
    tr.frameAt(s, _frame);
    const q = new THREE.Quaternion().setFromRotationMatrix(_m4.makeBasis(_frame.left, _frame.normal, _frame.tangent));
    tr.pointAt(s, 0, _v);
    car.placeOnGround(_v, q, 0);
    this.steering.reset();
    this.chase.reset();
    this.flipped = 0;
    this.hud.flash('back on the road');
  }

  private finishRun(): void {
    const run = this.run!;
    const stage = this.stage!;
    if (!this.recorder) return;
    this.lastSave = this.records.save({ seed: stage.seed, car: this.carDef.id, time: run.time, splits: run.splits.slice(), ghost: this.recorder.finish() });
    this.sound.ui(this.lastSave.best && this.lastSave.previous !== null ? 'best' : 'finish');
    this.recorder = null;
    this.resultsIn = RESULTS_DELAY;
  }

  private openResults(selected = 0): void {
    const run = this.run!;
    const stage = this.stage!;
    const save = this.lastSave;
    const ref = run.reference;
    this.menuBack = 'results';
    this.hud.clearDelta();
    const rows = run.splits.map((t, i) => {
      const last = i === run.splits.length - 1;
      const name = last ? 'finish' : `checkpoint ${i + 1}`;
      const d = ref?.[i] !== undefined ? t - ref[i] : null;
      const cell = d === null ? '' : `<td class="${d <= 0 ? 'ahead' : 'behind'}">${formatDelta(d)}</td>`;
      return `<tr${last ? ' class="total"' : ''}><td>${name}</td><td>${formatTime(t, 2)}</td>${cell}</tr>`;
    });
    let note = '';
    if (save?.best && save.previous !== null) note = `<span class="hot">new best</span> &middot; ${formatDelta(run.time - save.previous)} on your old best`;
    else if (save?.best) note = `<span class="hot">first time here</span> &middot; your ghost will drive with you next time`;
    else if (save) note = `best here: ${formatTime(save.record.best, 2)} in the ${carById(save.record.car).name}${save.carBest ? ` &middot; a best for the ${this.carDef.name}` : ''}`;
    this.menu.open({
      title: 'Finish',
      body: `<div class="note">${stageLabel(stage.seed, stage.name)} &middot; ${this.carDef.name}</div><table>${rows.join('')}</table><div class="note">${note}</div>`,
      choices: [
        { id: 'retry', label: 'Drive it again', key: 'X' },
        { id: 'new', label: 'Drive a new stage' },
        { id: 'car', label: 'Car', key: this.carDef.name, adjust: true },
        { id: 'title', label: 'Main menu', key: 'B' },
      ],
      back: 'title',
      retry: 'retry',
      selected,
    });
  }

  private openPause(selected = 0): void {
    this.paused = true;
    this.menuBack = 'pause';
    const stage = this.stage!;
    this.menu.open({
      title: 'Paused',
      body: `<div class="note">${stageLabel(stage.seed, stage.name)}</div>`,
      selected,
      choices: [
        { id: 'resume', label: 'Resume', key: 'start' },
        { id: 'retry', label: 'Restart this stage', key: 'X' },
        { id: 'new', label: 'Drive a new stage' },
        { id: 'car', label: 'Car (from the restart)', key: this.carDef.name, adjust: true },
        { id: 'settings', label: 'Settings' },
        { id: 'controls', label: 'Controls' },
        { id: 'title', label: 'Main menu' },
      ],
      back: 'resume',
      retry: 'retry',
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Settings and the other menus
  // ───────────────────────────────────────────────────────────────────────────

  private settingsSpec(): MenuSpec {
    const s = this.settings;
    const q = this.qualityFromUrl ? 'fixed by the url' : s.quality === 'auto' ? `auto (${QUALITY[this.renderer.quality].name})` : QUALITY[s.quality].name;
    const title = this.mode === 'title';
    return {
      title: 'Settings',
      style: title ? 'title' : 'card',
      back: 'back',
      choices: [
        { id: 'set:quality', label: 'Graphics', key: q, adjust: true },
        { id: 'set:volume', label: 'Sound', key: `${Math.round(s.volume * 100)}%`, adjust: true },
        { id: 'set:aids', label: 'Driving aids', key: AIDS_LABEL[s.aids], adjust: true },
        { id: 'set:gearbox', label: 'Gearbox', key: s.gearbox === 'auto' ? 'automatic' : 'manual (RB / LB)', adjust: true },
        { id: 'set:camera', label: 'Camera', key: s.camera, adjust: true },
        { id: 'set:ghost', label: 'Ghost', key: s.ghost ? 'on' : 'off', adjust: true },
        { id: 'back', label: 'Back', key: 'B' },
      ],
    };
  }

  private changeSetting(key: string, dir: -1 | 0 | 1): void {
    const s = this.settings;
    const step = <T>(list: readonly T[], v: T): T => list[(list.indexOf(v) + (dir < 0 ? list.length - 1 : 1)) % list.length];
    if (key === 'quality') s.quality = step<Settings['quality']>(['auto', 0, 1, 2, 3], s.quality);
    else if (key === 'volume') s.volume = Math.max(0, Math.min(1, Math.round((s.volume + (dir < 0 ? -0.1 : 0.1)) * 10) / 10));
    else if (key === 'aids') s.aids = step(AIDS_ORDER, s.aids);
    else if (key === 'gearbox') s.gearbox = s.gearbox === 'auto' ? 'manual' : 'auto';
    else if (key === 'camera') s.camera = step(CAMERA_ORDER, s.camera);
    else if (key === 'ghost') s.ghost = !s.ghost;
    saveSettings(s);
    this.applySettings();
    this.menu.refresh(this.settingsSpec());
  }

  private applySettings(): void {
    const s = this.settings;
    if (!this.qualityFromUrl) this.quality.setMode(s.quality);
    this.sound.setVolume(s.volume);
    if (this.car) this.car.assists = assistsFor(s);
    if (this.chase) this.chase.view = s.camera;
  }

  private changeCar(dir: -1 | 1): void {
    const i = CARS.indexOf(this.carDef);
    this.carDef = CARS[(i + dir + CARS.length) % CARS.length];
    this.settings.car = this.carDef.id;
    saveSettings(this.settings);
    if (this.mode === 'title') {
      this.showCar();
      this.parkCar();
      this.showTitleMenu(this.menu.selected);
    } else if (this.menuBack === 'results') {
      // the car changes from the next start; the menu shows the choice
      this.openResults(this.menu.selected);
    } else this.openPause(this.menu.selected);
  }

  private openInfo(which: 'controls' | 'credits'): void {
    const title = this.mode === 'title';
    this.menu.open({
      title: which,
      style: title ? 'title' : 'card',
      body: `<div class="info">${which === 'controls' ? CONTROLS_HTML : CREDITS_HTML}</div>`,
      back: 'back',
      choices: [{ id: 'back', label: 'Back', key: 'B' }],
    });
  }

  private pick(p: MenuPick): void {
    const id = p.id;
    if (p.dir !== 0 && id === 'car') return this.changeCar(p.dir);
    if (id.startsWith('set:')) return this.changeSetting(id.slice(4), p.dir);
    this.sound.ui(id === 'back' || id === 'resume' ? 'back' : 'select');
    if (id === 'resume') {
      this.paused = false;
      this.menu.close();
    } else if (id === 'new') this.startStage(this.world.newSeed());
    else if (id === 'retry') this.startStage(this.stage!.seed);
    else if (id === 'number') {
      this.titleSel = this.menu.selected;
      this.menu.close();
      this.seedEntry.open(this.stage && this.stage.seed !== TITLE_SEED ? this.stage.seed : 0);
    } else if (id === 'recent') {
      this.titleSel = this.menu.selected;
      this.openRecent();
    } else if (id.startsWith('stage:')) this.startStage(Number(id.slice(6)));
    else if (id === 'title') this.openTitle(0);
    else if (id === 'settings') {
      if (this.mode === 'title') this.titleSel = this.menu.selected;
      this.menu.open(this.settingsSpec());
    } else if (id === 'controls' || id === 'credits') {
      if (this.mode === 'title') this.titleSel = this.menu.selected;
      this.openInfo(id);
    } else if (id === 'back') {
      if (this.menuBack === 'pause') this.openPause();
      else if (this.menuBack === 'results') this.openResults();
      else this.showTitleMenu(this.titleSel);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The frame
  // ───────────────────────────────────────────────────────────────────────────

  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.step(dt);
    if (++this.frames === 3) (window as unknown as { __READY__: boolean }).__READY__ = true;
  };

  /** One frame of game time (public so QA scripts can drive it). */
  step(dt: number): void {
    if (this.pending) {
      // (the frame before drew the "building" message; now build)
      const p = this.pending;
      this.pending = null;
      p();
      this.last = performance.now();
      return;
    }
    const c = this.controls.poll(dt);
    this.time += dt;

    // menus first: an open menu takes the navigation (and Start closes the pause menu)
    if (this.seedEntry.isOpen) {
      const r = this.seedEntry.handle(c.nav);
      if (r === 'back') {
        this.seedEntry.close();
        this.showTitleMenu(this.titleSel);
      } else if (r) this.startStage(r.seed);
    } else if (this.menu.isOpen) {
      let p = this.menu.handle(c.nav);
      if (!p && c.pause && this.paused) p = { id: 'resume', dir: 0 };
      if (p) this.pick(p);
    } else if (c.pause && this.mode === 'drive') this.openPause();

    if (this.mode === 'title' || !this.car || !this.run || !this.physics || !this.stage) {
      this.quality.frame(dt, true);
      if (this.carView) {
        this.carView.update(this.parkedPose, dt);
        this.orbit.update(this.parkedPose.position, dt);
      }
      this.renderWorld(dt);
      this.sound.update(null, dt, { paused: true });
      return;
    }

    const car = this.car;
    const run = this.run;
    const stage = this.stage;
    const tr = stage.track;
    const driving = !this.paused && !this.menu.isOpen;
    this.quality.frame(dt, !this.paused && run.phase === 'running');

    if (!this.paused) {
      // the controls: the player's (or the QA autodriver's), the car brakes itself behind the results card
      this.hint = tr.project(car.p.x, car.p.z, _tp, this.hint);
      let steer = 0, throttle = 0, brake = 0, handbrake = 0;
      if (run.finished && this.resultsIn <= 0) {
        brake = 0.6;
      } else if (this.autodrive) {
        const a = autodrive(tr, car.state, _tp.s, this.carDef.physics.chassis.maxSteer, this.carDef.physics.chassis.wheelbase);
        steer = a.steer;
        throttle = run.phase === 'running' ? a.throttle : 0;
        brake = a.brake;
      } else if (driving) {
        steer = this.steering.update(c.steer, dt, car.state, this.carDef, STEERING);
        throttle = c.throttle;
        brake = c.brake;
        handbrake = c.handbrake;
      }
      car.controls.steer = steer;
      car.controls.throttle = throttle;
      car.controls.brake = brake;
      car.controls.handbrake = handbrake;
      car.controls.shift = driving && this.settings.gearbox === 'manual' ? (c.shiftUp ? 1 : c.shiftDown ? -1 : 0) : 0;
      if (driving && c.camera) {
        this.settings.camera = CAMERA_ORDER[(CAMERA_ORDER.indexOf(this.settings.camera) + 1) % CAMERA_ORDER.length];
        this.chase.view = this.settings.camera;
        saveSettings(this.settings);
      }
      if (driving && c.reset) this.resetCar();

      // the countdown: beeps, and GO lets the car go
      const before = run.phase;
      this.physics.step(dt);
      this.hint = tr.project(car.p.x, car.p.z, _tp, this.hint);
      _v.set(_tp.tx, 0, _tp.tz);
      const along = car.state.velocity.dot(_v);
      const ev = run.update(dt, _tp.s, along);
      if (run.phase === 'countdown') {
        const n = Math.ceil(run.countdown);
        if (n !== this.countdownShown) {
          this.countdownShown = n;
          this.sound.ui('countdown');
        }
      } else if (before === 'countdown' && !this.wentGo) {
        this.wentGo = true;
        car.holdOnGrid = false;
        this.sound.ui('go');
      }
      if (run.phase !== 'countdown' && this.recorder) this.recorder.record(run.time, car.state);
      if (ev) {
        this.hud.checkpoint(ev, stage.checkpoints.length);
        this.world.setCheckpoint(ev.index, 'passed');
        if (ev.index + 1 < stage.checkpoints.length) this.world.setCheckpoint(ev.index + 1, 'next');
        if (ev.finish) this.finishRun();
        else this.sound.ui('checkpoint');
      }
      // upside down: back on the road by itself
      _up.set(0, 1, 0).applyQuaternion(car.state.quaternion);
      this.flipped = _up.y < 0.25 && run.phase === 'running' ? this.flipped + dt : 0;
      if (this.flipped > FLIPPED_RESET) this.resetCar();
      // the results card, a moment after the finish
      if (this.resultsIn !== Infinity && this.resultsIn > 0) {
        this.resultsIn -= dt;
        if (this.resultsIn <= 0) this.openResults();
      }
    }

    // the cars and the camera
    const st = car.state;
    this.carView?.update(st, this.paused ? 0 : dt);
    if (this.ghostView && this.ghostPlayer) {
      const t = run.phase === 'countdown' ? 0 : run.time;
      this.ghostPlayer.pose(t, this.ghostPose);
      this.ghostView.object.visible = t < this.ghostPlayer.duration + 2;
      this.ghostView.update(this.ghostPose, this.paused ? 0 : dt);
    }
    this.chase.update(st, this.paused ? 0 : dt);
    this.renderWorld(dt);

    // the HUD and the sound
    const len = Math.max(1, stage.checkpoints[stage.checkpoints.length - 1]);
    let ghostProgress: number | null = null;
    if (this.ghostPlayer) {
      tr.project(this.ghostPose.position.x, this.ghostPose.position.z, _tp);
      ghostProgress = _tp.s / len;
    }
    const eng = this.carDef.physics.engine;
    const hv: HudView = {
      speedKmh: st.forwardSpeed * 3.6,
      gear: st.gear,
      rpm: st.rpm,
      shiftRpm: eng.redlineRpm * 0.97,
      maxRpm: st.limiterRpm,
      stickLeft: c.stickLeft,
      stickRight: c.stickRight,
      steer: st.steer,
      run: {
        phase: run.phase,
        countdown: run.countdown,
        time: run.time,
        passed: run.next,
        count: stage.checkpoints.length,
        referenceTime: run.referenceTime,
        wrongWay: run.wrongWay,
      },
      progress: run.progress / len,
      checkpoints: stage.checkpoints.map((s) => s / len),
      ghost: ghostProgress,
      stageLabel: stageLabel(stage.seed, stage.name),
      padName: c.padName,
      soundLocked: this.sound.locked,
    };
    this.hud.update(hv, dt);
    this.sound.update(st, dt, { paused: this.paused });
  }

  private renderWorld(_dt: number): void {
    const cam = this.renderer.camera;
    cam.updateMatrixWorld();
    for (const v of this.world.views) v.update(cam, this.time);
    this.renderer.render();
  }
}

const CONTROLS_HTML = `${CONTROLS_CARD.replace(/<h1>.*?<\/h1>/, '')}
<p>The two sticks add up: one stick pushed all the way turns the wheels half way, both pushed the same way turn them all the way,
and pushed opposite ways they cancel out. At speed, full steering is what the front tyres can take.</p>
<p>The clock starts at GO and stops at the finish. Your best run on each stage drives with you as a ghost.</p>`;

const CREDITS_HTML = `<p><b>Idea and design</b><br>Gabriel Berzescu</p>
<p><b>Built by</b><br>Claude (Opus 5.5, Anthropic), with Claude helpers for the roads, the cars and the sound</p>
<p><b>From the earlier games</b><br>Neon-Flight's look and Xeno-Racer's physics, cars and engine sound, both made by Claude for Gabriel and Silviu</p>
<p><b>Graphics</b><br>three.js (MIT)</p>
<p>Begun on 29 October 2026.</p>`;
