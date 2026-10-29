import { Game } from './game';
import { devCarView, devWorld } from './dev-world';
import { Sound } from './audio';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

// (the stand-in world and car until the real ones are in)
const game = new Game(canvas, ui, devWorld(), devCarView, new Sound());
game.boot().catch((err: unknown) => {
  console.error(err);
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:24px;color:#ff2bd6;font:14px/1.5 monospace;white-space:pre-wrap;z-index:99';
  pre.textContent = `Neon-Racer failed to start:\n\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  document.body.appendChild(pre);
});
