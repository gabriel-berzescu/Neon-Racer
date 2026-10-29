#!/usr/bin/env node
/**
 * Renders the sound previews headlessly: opens sandbox/audio.html?render=... in Chrome (the real worklet and graph, offline, the
 * cars driven through the physics) and writes MP3s (ffmpeg on the PATH, or FFMPEG=path) into previews/audio/.
 *
 *   node sandbox/audio-previews.mjs [--port 5274] [--base /] [--only lmp-x:launch,ui] [--out previews/audio]
 *
 * --base /Neon-Racer/ with `vite preview --base=/Neon-Racer/` renders from the production build.
 */
import { launchChrome } from '../scripts/chrome.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const port = opt('port', '5274');
const base = opt('base', '/');
const outDir = resolve(opt('out', 'previews/audio'));
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const list = opt('only', ['lmp-x', 'volta', 'dieci'].flatMap((c) => [`${c}:launch`, `${c}:tyres`]).concat('ui').join(','));
mkdirSync(outDir, { recursive: true });

const browser = await launchChrome({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300));
});
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}${base}sandbox/audio.html?render=${list}`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 600000, polling: 500 });
const names = await page.evaluate(() => Object.keys(window.__AUDIO_WAVS__));
const rows = [];
for (const name of names) {
  const w = await page.evaluate((n) => window.__AUDIO_WAVS__[n], name);
  const wav = resolve(outDir, `${name}.wav`);
  const mp3 = resolve(outDir, `${name}.mp3`);
  writeFileSync(wav, Buffer.from(w.base64, 'base64'));
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '192k', mp3]);
  rmSync(wav);
  rows.push({ file: `${name}.mp3`, s: +w.seconds.toFixed(1), peak: +w.peakDb.toFixed(1), rms: +w.rmsDb.toFixed(1), note: w.note });
}
await browser.close();
console.table(rows.map(({ note, ...r }) => r));
for (const r of rows) console.log(`${r.file}: ${r.note}`);
console.log(`\n${rows.length} files -> ${outDir}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
