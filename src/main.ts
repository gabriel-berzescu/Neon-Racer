import { Game, type World } from './game';
import { Sound } from './audio';
import { CarView } from './render/car';
import { RoadView } from './render/road';
import { SkyView, SUN_DIRECTION } from './render/sky';
import { TerrainView } from './render/terrain';
import { generateStage, groundHeightAt, newStageSeed, setActiveStage, type Stage } from './world/stage';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

const terrain = new TerrainView();
const road = new RoadView();
const world: World = {
  views: [new SkyView(), terrain, road],
  sunDirection: SUN_DIRECTION,
  groundHeight: groundHeightAt,
  generate: generateStage,
  newSeed: newStageSeed,
  // a stage is carved into the physics' ground and the rendered terrain, and its road laid
  activate: (s) => {
    const stage = s as Stage | null;
    setActiveStage(stage);
    terrain.setStage(stage);
    road.setStage(stage);
  },
  setCheckpoint: (i, state) => road.setCheckpoint(i, state),
};

const game = new Game(canvas, ui, world, (def, opts) => new CarView(def, opts), new Sound());
game.boot().catch((err: unknown) => {
  console.error(err);
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:24px;color:#ff2bd6;font:14px/1.5 monospace;white-space:pre-wrap;z-index:99';
  pre.textContent = `Neon-Racer failed to start:\n\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  document.body.appendChild(pre);
});
