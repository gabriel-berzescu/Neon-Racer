/**
 * The sound bench (sandbox/audio.html): the car's sound as the game plays it, through the real `Sound` (src/audio), a car driven by the
 * physics on a flat proving ground (asphalt on the right of the start line, the run-off on the left, barriers either side).
 *
 *   drive        keyboard (W / up: throttle, S / down: brake, A D / left right: steer, space: handbrake, C: cockpit, R: back to the
 *                start, P: pause) or an F310 pad (left stick, RT throttle, LT brake, B handbrake, Y cockpit, Start back to the start)
 *   sweeps       the scripted drives of src/audio/lab/drive.ts (idle, launch through the gears, lift-off, braking, tyres): driven live
 *                through Sound, or rendered offline through the same graph (OfflineAudioContext) with figures per phase and a WAV
 *   interface    every ui() sound
 *
 * For scripts: window.__SOUND__ is the Sound; ?render=lmp-x:launch,volta:launch,ui renders those offline into window.__AUDIO_WAVS__
 * (base64 WAVs and their levels; sandbox/audio-previews.mjs makes MP3s of them); window.__READY__ is set when the page is ready.
 */
import { CARS, getCar } from '../src/cars';
import { Sound, UI_SOUND_LIST, type UiSound } from '../src/audio';
import { peakAbs, rms } from '../src/audio/analysis';
import { Drive, PROGRAMMES, type Phase } from '../src/audio/lab/drive';
import { type RenderResult, renderDrive, renderUi } from '../src/audio/lab/render';
import { encodeWav16 } from '../src/audio/wav';
import type { CarDefinition, VehicleState } from '../src/core/contracts';

declare global {
  interface Window {
    __READY__?: boolean;
    __SOUND__?: Sound;
    __AUDIO_WAVS__?: Record<string, PreviewWav>;
    __BENCH__?: { state: () => VehicleState; play: (programme: string) => void; level: () => { peakDb: number; rmsDb: number } };
  }
}

interface PreviewWav {
  base64: string;
  seconds: number;
  peakDb: number;
  rmsDb: number;
  note: string;
}

const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const k of kids) e.append(k);
  return e;
};

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The UI sounds as the game uses them, one after the other. */
const UI_SEQUENCE: { t: number; sound: UiSound }[] = [
  { t: 0, sound: 'move' },
  { t: 0.25, sound: 'move' },
  { t: 0.5, sound: 'move' },
  { t: 0.9, sound: 'select' },
  { t: 1.7, sound: 'back' },
  { t: 2.6, sound: 'countdown' },
  { t: 3.6, sound: 'countdown' },
  { t: 4.6, sound: 'countdown' },
  { t: 5.6, sound: 'go' },
  { t: 7.0, sound: 'checkpoint' },
  { t: 8.4, sound: 'best' },
  { t: 10.4, sound: 'finish' },
];

/** ?render=...: offline renders for scripts, no interface. */
async function renderForScripts(list: string[]): Promise<void> {
  const out: Record<string, PreviewWav> = {};
  const main = document.getElementById('app')!;
  for (const item of list) {
    main.textContent = `rendering ${item}…`;
    let r: RenderResult;
    let note: string;
    if (item === 'ui') {
      r = await renderUi(UI_SEQUENCE, 13);
      note = UI_SEQUENCE.map((e) => `${e.t.toFixed(1)} s ${e.sound}`).join(', ');
    } else {
      const [id, prog] = item.split(':');
      const def = getCar(id);
      r = await renderDrive(def, PROGRAMMES[prog].phases);
      note = `${def.name}, ${PROGRAMMES[prog].label}: heard from the chase camera, the whole graph at the default mix`;
    }
    const a = Math.floor(0.2 * r.sr);
    out[item.replace(':', '-')] = {
      base64: toBase64(encodeWav16([r.left, r.right], r.sr)),
      seconds: r.left.length / r.sr,
      peakDb: db(Math.max(peakAbs(r.left), peakAbs(r.right))),
      rmsDb: db(Math.max(rms(r.left, a), rms(r.right, a))),
      note,
    };
  }
  window.__AUDIO_WAVS__ = out;
  main.textContent = `rendered: ${Object.keys(out).join(', ')}`;
  window.__READY__ = true;
}

function bench(): void {
  const sound = new Sound();
  window.__SOUND__ = sound;
  const meter = sound.meter();
  const meterBuf = new Float32Array(4096);
  let def: CarDefinition = CARS[0];
  let drive = new Drive(def);
  let interior = false;
  let paused = false;
  let volume = 0.85;
  sound.setVolume(volume);
  sound.setCar(def);

  // ── the page ─────────────────────────────────────────────────────────────
  const main = document.getElementById('app')!;
  main.textContent = '';
  const carSel = el('select');
  for (const c of CARS) carSel.append(el('option', { value: c.id, textContent: `${c.name} (${c.sound.cylinders}-cyl ${c.sound.turbo ? 'turbo' : 'NA'})` }));
  const start = el('button', { className: 'go', textContent: 'Start sound' });
  const vol = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(volume) });
  const status = el('span', { className: 'status' });
  main.append(el('header', {}, el('h1', { textContent: 'NEON-RACER · sound bench' }), carSel, start, el('label', {}, 'volume', vol), status));

  const view = el('canvas', { width: 360, height: 300 });
  const readout = el('pre');
  const levels = el('pre', { className: 'dim' });
  const driveBtns = el('div', { className: 'btns' });
  const cockpit = el('button', { textContent: 'Cockpit view (C)' });
  const pause = el('button', { textContent: 'Pause (P)' });
  const reset = el('button', { textContent: 'Back to the start (R)' });
  driveBtns.append(cockpit, pause, reset);
  main.append(
    el(
      'div',
      { className: 'grid' },
      el(
        'section',
        { className: 'panel' },
        el('h2', { textContent: 'Drive' }),
        view,
        driveBtns,
        el('p', { className: 'hint', textContent: 'W / ↑ throttle · S / ↓ brake · A D / ← → steer · space handbrake. F310: left stick, RT, LT, B handbrake, Y cockpit, Start reset. Left of the line is the run-off, then the barrier.' }),
      ),
      el('section', { className: 'panel' }, el('h2', { textContent: 'Car' }), readout, el('h2', { textContent: 'Output (after the limiter)', className: 'mt' }), levels),
    ),
  );

  const sweepSel = el('select');
  for (const [k, p] of Object.entries(PROGRAMMES)) sweepSel.append(el('option', { value: k, textContent: p.label }));
  const live = el('button', { textContent: 'Drive it live' });
  const offline = el('button', { textContent: 'Render offline' });
  const sweepOut = el('div');
  const uiBtns = el('div', { className: 'btns' });
  for (const s of UI_SOUND_LIST) {
    const b = el('button', { textContent: s });
    b.onclick = () => sound.ui(s);
    uiBtns.append(b);
  }
  const uiSeq = el('button', { textContent: 'the whole sequence' });
  uiBtns.append(uiSeq);
  main.append(
    el(
      'div',
      { className: 'grid mt' },
      el('section', { className: 'panel' }, el('h2', { textContent: 'Scripted sweeps' }), el('div', { className: 'btns' }, sweepSel, live, offline), sweepOut),
      el('section', { className: 'panel' }, el('h2', { textContent: 'Interface sounds' }), uiBtns, el('p', { className: 'hint', textContent: 'move, select and back are Xeno-Racer’s; countdown, go and finish too; checkpoint is its lap chime and best its best-lap arpeggio.' })),
    ),
  );

  // ── input ────────────────────────────────────────────────────────────────
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLSelectElement) return;
    keys.add(e.code);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    if (e.code === 'KeyC') toggleCockpit();
    if (e.code === 'KeyP') togglePause();
    if (e.code === 'KeyR') restart();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  const padPrev: boolean[] = [];

  function toggleCockpit(): void {
    interior = !interior;
    sound.setInterior(interior);
    cockpit.classList.toggle('on', interior);
  }
  function togglePause(): void {
    paused = !paused;
    pause.classList.toggle('on', paused);
  }
  function restart(): void {
    drive = new Drive(def);
    script = null;
  }
  cockpit.onclick = toggleCockpit;
  pause.onclick = togglePause;
  reset.onclick = restart;
  start.onclick = () => {
    void sound.unlock();
    sound.ui('select');
  };
  vol.oninput = () => {
    volume = +vol.value;
    sound.setVolume(volume);
  };
  carSel.onchange = () => {
    def = getCar(carSel.value);
    sound.setCar(def);
    restart();
    carSel.blur();
  };

  // ── a scripted drive, live ──────────────────────────────────────────────
  let script: { phases: Phase[]; i: number; t: number; steer: number } | null = null;
  function playLive(k: string): void {
    restart();
    script = { phases: PROGRAMMES[k].phases, i: 0, t: 0, steer: 0 };
  }
  live.onclick = () => playLive(sweepSel.value);

  offline.onclick = async () => {
    offline.disabled = true;
    sweepOut.textContent = 'rendering…';
    try {
      const r = await renderDrive(def, PROGRAMMES[sweepSel.value].phases);
      showRender(r, `${def.id}-${sweepSel.value}`);
    } catch (e) {
      sweepOut.textContent = String(e);
    }
    offline.disabled = false;
  };
  uiSeq.onclick = async () => {
    const r = await renderUi(UI_SEQUENCE, 13);
    showRender(r, 'ui');
  };

  function showRender(r: RenderResult, name: string): void {
    sweepOut.textContent = '';
    const sr = r.sr;
    const tbl = el('table');
    tbl.append(el('tr', {}, el('th', { textContent: 'phase' }), el('th', { textContent: 's' }), el('th', { textContent: 'rms dBFS' }), el('th', { textContent: 'peak dBFS' }), el('th', { textContent: 'km/h' })));
    const phases: { name: string; a: number; b: number; kmh: number }[] = [];
    for (const f of r.frames) {
      const last = phases[phases.length - 1];
      if (!last || last.name !== f.phase) phases.push({ name: f.phase, a: f.t, b: f.t, kmh: f.kmh });
      else {
        last.b = f.t;
        last.kmh = f.kmh;
      }
    }
    if (phases.length === 0) phases.push({ name: 'all', a: 0, b: r.left.length / sr, kmh: 0 });
    for (const p of phases) {
      const a = Math.floor(p.a * sr);
      const b = Math.max(a + 1, Math.floor(p.b * sr));
      tbl.append(
        el(
          'tr',
          {},
          el('td', { textContent: p.name }),
          el('td', { textContent: (p.b - p.a).toFixed(1) }),
          el('td', { textContent: db(Math.max(rms(r.left, a, b), rms(r.right, a, b))).toFixed(1) }),
          el('td', { textContent: db(Math.max(peakAbs(r.left, a, b), peakAbs(r.right, a, b))).toFixed(1) }),
          el('td', { textContent: p.kmh.toFixed(0) }),
        ),
      );
    }
    const url = URL.createObjectURL(new Blob([encodeWav16([r.left, r.right], sr) as BlobPart], { type: 'audio/wav' }));
    const play = el('button', { textContent: '▶ play' });
    play.onclick = () => {
      const ctx = sound.ctx;
      if (!ctx || !(ctx instanceof AudioContext)) return;
      void sound.unlock();
      const buf = ctx.createBuffer(2, r.left.length, sr);
      buf.copyToChannel(r.left as Float32Array<ArrayBuffer>, 0);
      buf.copyToChannel(r.right as Float32Array<ArrayBuffer>, 1);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
    };
    sweepOut.append(
      el('div', { className: 'btns' }, play, el('a', { href: url, download: `${name}.wav`, textContent: 'download WAV', className: 'dl' })),
      el('pre', { className: 'dim', textContent: `${(r.left.length / sr).toFixed(1)} s rendered in ${r.renderMs.toFixed(0)} ms (the whole graph, default mix)` }),
      tbl,
    );
  }

  // ── the frame ────────────────────────────────────────────────────────────
  const g = view.getContext('2d')!;
  let last = performance.now();
  let readoutAt = 0;
  let peakHold = -120;
  function controls(dt: number): { throttle: number; brake: number; steer: number; handbrake: number } {
    if (script) {
      const p = script.phases[script.i];
      script.t += dt;
      script.steer += Math.max(-dt / 0.25, Math.min(dt / 0.25, (p.steer ?? 0) - script.steer));
      const c = { throttle: p.throttle ?? 0, brake: p.brake ?? 0, steer: script.steer, handbrake: p.handbrake ?? 0 };
      if (script.t >= p.seconds || p.until?.(drive.state)) {
        script.i++;
        script.t = 0;
        if (script.i >= script.phases.length) script = null;
      }
      return c;
    }
    let throttle = keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0;
    let brake = keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0;
    let steer = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    let handbrake = keys.has('Space') ? 1 : 0;
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad || pad.mapping !== 'standard') continue;
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > 0.08) steer = Math.sign(ax) * ((Math.abs(ax) - 0.08) / 0.92);
      throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0);
      brake = Math.max(brake, pad.buttons[6]?.value ?? 0);
      if (pad.buttons[1]?.pressed) handbrake = 1;
      const y = !!pad.buttons[3]?.pressed;
      const st = !!pad.buttons[9]?.pressed;
      if (y && !padPrev[3]) toggleCockpit();
      if (st && !padPrev[9]) restart();
      padPrev[3] = y;
      padPrev[9] = st;
    }
    return { throttle, brake, steer, handbrake };
  }

  function frame(now: number): void {
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
    last = now;
    const c = controls(dt);
    const st = paused ? drive.state : drive.step(dt, c);
    sound.update(st, dt, { paused });
    // the meter
    let pk = 0;
    let sum = 0;
    if (meter) {
      meter.getFloatTimeDomainData(meterBuf);
      for (let i = 0; i < meterBuf.length; i++) {
        const x = meterBuf[i];
        pk = Math.max(pk, Math.abs(x));
        sum += x * x;
      }
    }
    const rmsDb = db(Math.sqrt(sum / meterBuf.length));
    peakHold = Math.max(peakHold - dt * 20, db(pk));
    lastLevel = { peakDb: db(pk), rmsDb };
    draw(st);
    if (now - readoutAt > 100) {
      readoutAt = now;
      const w = st.wheels;
      readout.textContent = [
        `${def.name}  ${script ? `▶ ${script.phases[script.i]?.name ?? ''}` : 'keys / pad'}${interior ? '  · cockpit' : ''}${paused ? '  · PAUSED' : ''}`,
        `${(st.speed * 3.6).toFixed(0).padStart(4)} km/h   gear ${st.gear === -1 ? 'R' : st.gear === 0 ? 'N' : st.gear}/${st.gearCount}   ${st.rpm.toFixed(0).padStart(6)} rpm${st.revLimiter ? '  LIMITER' : ''}`,
        `throttle ${st.throttle.toFixed(2)}  pedal ${st.throttlePedal.toFixed(2)}  brake ${st.brake.toFixed(2)}  boost ${st.boost.toFixed(2)}${st.tcsActive ? '  TCS' : ''}${st.absActive ? '  ABS' : ''}`,
        `wheels  ${w.map((x) => `${x.surface.padEnd(7)} skid ${x.skid.toFixed(2)}`).join('\n        ')}`,
        `shifts ${st.shiftCount}  backfires ${st.backfireCount}  impacts ${st.impactCount}  scrape ${st.scrape.toFixed(2)}`,
      ].join('\n');
      levels.textContent = `rms ${rmsDb.toFixed(1)} dBFS   peak ${db(pk).toFixed(1)} (hold ${peakHold.toFixed(1)}) dBFS`;
      const ctx = sound.ctx;
      status.innerHTML = sound.locked
        ? '<span class="warn">click or press a key for sound</span>'
        : `<b>sound on</b> · ${ctx?.sampleRate ?? 0} Hz · ${ctx?.state}`;
    }
    requestAnimationFrame(frame);
  }
  let lastLevel = { peakDb: -180, rmsDb: -180 };

  function draw(st: VehicleState): void {
    const W = view.width;
    const H = view.height;
    const k = W / 32; // px per m, x from -16 to 16 (left of the screen is +X, the car's left)
    const px = (x: number): number => W / 2 - x * k;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    // the asphalt (x < 0, the right of the screen) and the run-off (x > 0)
    g.fillStyle = '#16121f';
    g.fillRect(px(0), 0, W - px(0), H);
    g.fillStyle = '#0c2116';
    g.fillRect(0, 0, px(0), H);
    // lane marks scrolling with the car
    g.strokeStyle = 'rgba(241,236,255,0.25)';
    g.setLineDash([10, 14]);
    g.lineDashOffset = -(st.position.z * k) % 24;
    g.beginPath();
    g.moveTo(px(-7), 0);
    g.lineTo(px(-7), H);
    g.stroke();
    g.setLineDash([]);
    // the barriers
    g.strokeStyle = '#ff2e9a';
    g.shadowColor = '#ff2e9a';
    g.shadowBlur = 8;
    g.lineWidth = 3;
    for (const x of [14, -14]) {
      g.beginPath();
      g.moveTo(px(x), 0);
      g.lineTo(px(x), H);
      g.stroke();
    }
    g.shadowBlur = 0;
    // the car, from above: its heading from the quaternion
    const q = st.quaternion;
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const yaw = Math.atan2(fx, fz);
    g.save();
    g.translate(px(st.position.x), H * 0.62);
    g.rotate(-yaw);
    g.fillStyle = '#16e0bd';
    g.shadowColor = '#16e0bd';
    g.shadowBlur = 10;
    g.fillRect(-0.95 * k, -2.3 * k, 1.9 * k, 4.6 * k);
    g.fillStyle = '#ff2e9a';
    g.fillRect(-0.95 * k, -2.3 * k, 1.9 * k, 0.6 * k);
    g.restore();
    g.shadowBlur = 0;
  }

  window.__BENCH__ = { state: () => drive.state, play: playLive, level: () => lastLevel };
  requestAnimationFrame(frame);
  window.__READY__ = true;
}

const params = new URLSearchParams(location.search);
const toRender = params.get('render');
if (toRender) void renderForScripts(toRender.split(','));
else bench();
