/**
 * The driving HUD: neon readouts over the 3D view (DOM, no canvas), in Neon-Flight's style.
 *
 *   top centre      the clock, the next checkpoint, the reference time; the split delta after each checkpoint
 *   top             the stage's progress: checkpoints, you, the ghost
 *   bottom centre   speed, gear and a rev bar that turns magenta at the shift point
 *   bottom corners  each stick's share of the steering (the two sticks add up) and the steering they make together
 *   centre          the countdown, GO, wrong way, a message now and then
 *   overlays        the controls card on the first run, the gamepad name, the "click for sound" hint
 */
import { formatDelta, formatTime, type CheckpointEvent, type RunPhase } from '../game/run';

const CSS = `
.nr-hud { position: fixed; inset: 0; pointer-events: none; color: #bff9ff; font: 600 15px/1.25 ui-monospace, 'Cascadia Mono', Consolas, monospace;
  letter-spacing: 0.08em; text-transform: uppercase; text-shadow: 0 0 6px rgba(34,243,255,.75), 0 0 18px rgba(34,243,255,.35); user-select: none; }
.nr-hud.hidden { display: none; }
.nr-hud .clock { position: absolute; top: 34px; left: 50%; transform: translateX(-50%); text-align: center; }
.nr-hud .clock b { display: block; font-size: 38px; font-weight: 700; color: #fff; letter-spacing: .04em; font-variant-numeric: tabular-nums;
  text-shadow: 0 0 8px rgba(34,243,255,.9), 0 0 24px rgba(34,243,255,.45); }
.nr-hud .clock i { font-style: normal; font-size: 12px; opacity: .75; letter-spacing: .2em; font-variant-numeric: tabular-nums; }
.nr-hud .delta { position: absolute; top: 132px; left: 50%; transform: translateX(-50%); text-align: center; transition: opacity .4s; }
.nr-hud .delta b { display: block; font-size: 30px; font-variant-numeric: tabular-nums; }
.nr-hud .delta i { font-style: normal; font-size: 12px; opacity: .8; letter-spacing: .25em; }
.nr-hud .ahead { color: #6dffb0; text-shadow: 0 0 8px #18ff8c, 0 0 22px #18ff8c; }
.nr-hud .behind { color: #ff8fa3; text-shadow: 0 0 8px #ff2b5e, 0 0 22px #ff2b5e; }
.nr-hud .prog { position: absolute; top: 18px; left: 50%; width: min(46vw, 640px); height: 2px; transform: translateX(-50%);
  background: rgba(191,249,255,.28); box-shadow: 0 0 8px rgba(34,243,255,.4); }
.nr-hud .prog .cp { position: absolute; top: -5px; width: 2px; height: 12px; margin-left: -1px; background: rgba(255,210,122,.8); box-shadow: 0 0 6px #ff9a40; }
.nr-hud .prog .cp.done { background: rgba(34,243,255,.9); box-shadow: 0 0 6px #22f3ff; }
.nr-hud .prog .me, .nr-hud .prog .gh { position: absolute; top: -5px; width: 12px; height: 12px; margin-left: -6px; border-radius: 50%; }
.nr-hud .prog .me { background: #22f3ff; box-shadow: 0 0 10px #22f3ff; }
.nr-hud .prog .gh { background: rgba(255,107,230,.75); box-shadow: 0 0 10px #ff2bd6; }
.nr-hud .row { position: absolute; left: 50%; bottom: 40px; transform: translateX(-50%); display: flex; gap: 30px; align-items: flex-end; }
.nr-hud .read { text-align: center; min-width: 84px; }
.nr-hud .read b { display: block; font-size: 44px; font-weight: 700; letter-spacing: 0.02em; font-variant-numeric: tabular-nums; color: #fff; }
.nr-hud .read.gear b { color: #ffd27a; text-shadow: 0 0 8px #ff9a40, 0 0 22px #ff9a40; }
.nr-hud .read i { font-style: normal; font-size: 11px; opacity: .7; letter-spacing: .2em; }
.nr-hud .revs { position: absolute; left: 50%; bottom: 118px; transform: translateX(-50%); width: 300px; height: 8px;
  border: 1.5px solid rgba(191,249,255,.55); border-radius: 3px; box-shadow: 0 0 8px rgba(34,243,255,.3); }
.nr-hud .revs .fill { position: absolute; left: 1px; top: 1px; bottom: 1px; background: linear-gradient(90deg, #22f3ff, #ffd27a); box-shadow: 0 0 10px #22f3ff; }
.nr-hud .revs.shift .fill { background: #ff2bd6; box-shadow: 0 0 14px #ff2bd6; }
.nr-hud .stick { position: absolute; bottom: 30px; width: 150px; text-align: center; }
.nr-hud .stick.l { left: 30px; } .nr-hud .stick.r { right: 30px; }
.nr-hud .rail { position: relative; height: 2px; background: rgba(255,43,214,.45); margin: 10px 0 0; }
.nr-hud .rail::before { content: ''; position: absolute; left: 50%; top: -5px; width: 1px; height: 12px; background: rgba(255,255,255,.5); }
.nr-hud .rail .dot { position: absolute; top: -5px; width: 12px; height: 12px; margin-left: -6px; border-radius: 50%; background: #ff6be6; box-shadow: 0 0 10px #ff2bd6; }
.nr-hud .lab { font-size: 10px; opacity: .75; letter-spacing: .14em; margin-top: 8px; white-space: nowrap; }
.nr-hud .wheel { position: absolute; left: 50%; bottom: 6px; transform: translateX(-50%); width: 200px; text-align: center; }
.nr-hud .wheel .lab { margin-top: 6px; }
.nr-hud .wheel .rail { background: rgba(34,243,255,.35); }
.nr-hud .wheel .rail .dot { background: #fff; box-shadow: 0 0 10px #22f3ff; }
.nr-hud .center { position: absolute; top: 40%; left: 50%; transform: translate(-50%, -50%); text-align: center; }
.nr-hud .big { font-size: 96px; letter-spacing: .1em; color: #fff; text-shadow: 0 0 14px #ff2bd6, 0 0 40px #ff2bd6, 0 0 90px #ff2bd6; }
.nr-hud .big.go { color: #fff; text-shadow: 0 0 14px #22f3ff, 0 0 40px #22f3ff, 0 0 90px #22f3ff; }
.nr-hud .warn { font-size: 30px; color: #ff6be6; text-shadow: 0 0 10px #ff2bd6, 0 0 30px #ff2bd6; letter-spacing: .3em; animation: nrblink .5s steps(2, start) infinite; }
@keyframes nrblink { to { visibility: hidden; } }
.nr-hud .msg { position: absolute; top: 56%; left: 50%; transform: translateX(-50%); font-size: 14px; letter-spacing: .2em; opacity: 0; transition: opacity .5s; }
.nr-hud .card { position: absolute; top: 76px; left: 28px; padding: 18px 24px; border: 1.5px solid rgba(34,243,255,.55);
  border-radius: 10px; background: rgba(7,2,15,.55); backdrop-filter: blur(3px); box-shadow: 0 0 24px rgba(34,243,255,.25); max-width: 420px; font-size: 14px;
  transition: opacity .8s; text-transform: none; letter-spacing: .03em; font-weight: 500; }
.nr-hud .card h1 { margin: 0 0 12px; font-size: 20px; letter-spacing: .4em; text-transform: uppercase; color: #fff; }
.nr-hud .card table { border-collapse: collapse; }
.nr-hud .card td { padding: 3px 10px; } .nr-hud .card td:first-child { color: #ffd27a; text-align: right; text-shadow: 0 0 6px #ff9a40; white-space: nowrap; }
.nr-hud .card p { margin: 12px 0 0; font-size: 12px; opacity: .8; }
.nr-hud .hint { position: absolute; top: 34px; right: 22px; font-size: 12px; opacity: .8; letter-spacing: .12em; text-align: right; }
.nr-hud .dev { position: absolute; top: 34px; left: 22px; font-size: 12px; opacity: .7; letter-spacing: .12em; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent.appendChild(e);
  return e;
}

/** What the HUD shows, filled by the game every frame. */
export interface HudView {
  speedKmh: number;
  /** -1 = R, 0 = N, 1.. */
  gear: number;
  rpm: number;
  /** The rpm where the bar turns magenta (the shift point). */
  shiftRpm: number;
  maxRpm: number;
  stickLeft: number;
  stickRight: number;
  /** The steering the car is getting now (-1..1), after the filter. */
  steer: number;
  run: {
    phase: RunPhase;
    countdown: number;
    time: number;
    /** Checkpoints passed and in all. */
    passed: number;
    count: number;
    referenceTime: number | null;
    wrongWay: number;
  } | null;
  /** Where you are on the stage (0..1), its checkpoints, and the ghost (null: none). */
  progress: number;
  checkpoints: readonly number[];
  ghost: number | null;
  /** E.g. "Stage 048213 · Violet Pass". */
  stageLabel: string;
  padName: string | null;
  soundLocked: boolean;
}

export const CONTROLS_CARD = `<h1>Neon-Racer</h1><table>
<tr><td>left stick &larr;&rarr;</td><td>steer, half lock</td></tr>
<tr><td>right stick &larr;&rarr;</td><td>steer, half lock</td></tr>
<tr><td>both together</td><td>full lock (opposite ways: straight)</td></tr>
<tr><td>RT / LT</td><td>throttle / brake</td></tr>
<tr><td>A</td><td>handbrake</td></tr>
<tr><td>Y &middot; back</td><td>camera &middot; back on the road</td></tr>
<tr><td>START</td><td>pause</td></tr>
</table><p>One thumb for the fast bends, both for the tight ones.<br>Keyboard: A/D and &#8592;/&#8594; steer (one each), W/S or &#8593;/&#8595; throttle/brake, Space handbrake, Esc pause.</p>`;

export class Hud {
  private readonly root: HTMLElement;
  private readonly clockT: HTMLElement;
  private readonly clockSub: HTMLElement;
  private readonly delta: HTMLElement;
  private readonly prog: HTMLElement;
  private readonly progMe: HTMLElement;
  private readonly progGhost: HTMLElement;
  private progCps: HTMLElement[] = [];
  private progKey = '';
  private readonly speed: HTMLElement;
  private readonly gear: HTMLElement;
  private readonly revs: HTMLElement;
  private readonly revFill: HTMLElement;
  private readonly dotL: HTMLElement;
  private readonly dotR: HTMLElement;
  private readonly dotW: HTMLElement;
  private readonly center: HTMLElement;
  private readonly msg: HTMLElement;
  private readonly card: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly dev: HTMLElement;
  private deltaFor = 0;
  private msgFor = 0;
  private cardShown = false;
  private cardFor = 0;
  private last: Record<string, string> = {};

  constructor(parent: HTMLElement) {
    if (!document.getElementById('nr-hud-css')) {
      const st = document.createElement('style');
      st.id = 'nr-hud-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    const r = (this.root = el('div', 'nr-hud hidden', parent));
    const clock = el('div', 'clock', r);
    this.clockT = el('b', '', clock);
    this.clockSub = el('i', '', clock);
    this.delta = el('div', 'delta', r);
    this.delta.style.opacity = '0';
    this.prog = el('div', 'prog', r);
    this.progGhost = el('div', 'gh', this.prog);
    this.progMe = el('div', 'me', this.prog);
    const row = el('div', 'row', r);
    const sp = el('div', 'read', row);
    this.speed = el('b', '', sp);
    el('i', '', sp, 'km/h');
    const gr = el('div', 'read gear', row);
    this.gear = el('b', '', gr);
    el('i', '', gr, 'gear');
    this.revs = el('div', 'revs', r);
    this.revFill = el('div', 'fill', this.revs);
    const stick = (cls: string, label: string) => {
      const box = el('div', cls, r);
      const rail = el('div', 'rail', box);
      const dot = el('div', 'dot', rail);
      el('div', 'lab', box, label);
      return dot;
    };
    this.dotL = stick('stick l', 'left stick');
    this.dotR = stick('stick r', 'right stick');
    this.dotW = stick('wheel', 'steering');
    this.center = el('div', 'center', r);
    this.msg = el('div', 'msg', r);
    this.card = el('div', 'card', r, CONTROLS_CARD);
    this.card.style.opacity = '0';
    this.hint = el('div', 'hint', r);
    this.dev = el('div', 'dev', r);
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  /** The controls card, until the car has been driven a little (the first run of a visit). */
  showControlsCard(): void {
    if (this.cardShown) return;
    this.cardShown = true;
    this.cardFor = 14;
    this.card.style.opacity = '1';
  }

  /** A short message in the middle (a quality change, "back on the road", ...). */
  flash(text: string, seconds = 2.5): void {
    this.msg.textContent = text;
    this.msg.style.opacity = '1';
    this.msgFor = seconds;
  }

  /** A checkpoint was passed: its split against the reference for a few seconds. */
  checkpoint(e: CheckpointEvent, count: number): void {
    const label = e.finish ? 'finish' : `checkpoint ${e.index + 1} / ${count - 1}`;
    if (e.delta === null) this.delta.innerHTML = `<b>${formatTime(e.time, 2)}</b><i>${label}</i>`;
    else {
      const cls = e.delta <= 0 ? 'ahead' : 'behind';
      this.delta.innerHTML = `<b class="${cls}">${formatDelta(e.delta)}</b><i>${label}</i>`;
    }
    this.delta.style.opacity = '1';
    this.deltaFor = e.finish ? 1e9 : 3.5;
  }

  /** Takes the split delta off the screen (the results card shows them all). */
  clearDelta(): void {
    this.delta.style.opacity = '0';
    this.deltaFor = 0;
  }

  /** Clears what a run left behind (deltas, messages). */
  resetRun(): void {
    this.delta.style.opacity = '0';
    this.deltaFor = 0;
    this.center.innerHTML = '';
    this.last.center = '';
  }

  private set(key: string, e: HTMLElement, text: string, html = false): void {
    if (this.last[key] === text) return;
    this.last[key] = text;
    if (html) e.innerHTML = text;
    else e.textContent = text;
  }

  update(v: HudView, dt: number): void {
    // the clock and the next checkpoint
    const run = v.run;
    if (run) {
      this.set('clock', this.clockT, formatTime(run.phase === 'countdown' ? 0 : run.time, 2));
      const cpCount = Math.max(0, run.count - 1);
      const cp = run.phase === 'finished' ? 'finished' : run.passed < cpCount ? `checkpoint ${run.passed + 1} / ${cpCount}` : 'to the finish';
      this.set('sub', this.clockSub, run.referenceTime !== null ? `${cp} &middot; best ${formatTime(run.referenceTime, 2)}` : cp, true);
    } else {
      this.set('clock', this.clockT, '');
      this.set('sub', this.clockSub, '');
    }
    if (this.deltaFor > 0) {
      this.deltaFor -= dt;
      if (this.deltaFor <= 0) this.delta.style.opacity = '0';
    }

    // the progress line
    const key = v.checkpoints.map((c) => c.toFixed(4)).join(',');
    if (key !== this.progKey) {
      this.progKey = key;
      for (const e of this.progCps) e.remove();
      this.progCps = v.checkpoints.map((c) => {
        const e = el('div', 'cp', this.prog);
        e.style.left = `${(c * 100).toFixed(2)}%`;
        return e;
      });
      this.prog.append(this.progGhost, this.progMe);
    }
    const passed = run?.passed ?? 0;
    this.progCps.forEach((e, i) => e.classList.toggle('done', i < passed));
    this.prog.style.display = v.checkpoints.length ? '' : 'none';
    this.progMe.style.left = `${(Math.max(0, Math.min(1, v.progress)) * 100).toFixed(2)}%`;
    this.progGhost.style.display = v.ghost === null ? 'none' : '';
    if (v.ghost !== null) this.progGhost.style.left = `${(Math.max(0, Math.min(1, v.ghost)) * 100).toFixed(2)}%`;

    // speed, gear, revs
    this.set('speed', this.speed, String(Math.round(Math.abs(v.speedKmh))));
    this.set('gear', this.gear, v.gear < 0 ? 'R' : v.gear === 0 ? 'N' : String(v.gear));
    const rf = Math.max(0, Math.min(1, v.rpm / v.maxRpm));
    this.revFill.style.width = `calc(${(rf * 100).toFixed(1)}% - 2px)`;
    this.revs.classList.toggle('shift', v.rpm >= v.shiftRpm);

    // the sticks: each one's half, and the two together
    this.dotL.style.left = `${(50 + 50 * v.stickLeft).toFixed(1)}%`;
    this.dotR.style.left = `${(50 + 50 * v.stickRight).toFixed(1)}%`;
    this.dotW.style.left = `${(50 + 50 * v.steer).toFixed(1)}%`;

    // the countdown, GO, wrong way
    let center = '';
    if (run?.phase === 'countdown') center = `<div class="big">${Math.ceil(run.countdown)}</div>`;
    else if (run?.phase === 'running' && run.time < 0.9) center = `<div class="big go">GO</div>`;
    else if (run?.phase === 'running' && run.wrongWay > 1.2) center = `<div class="warn">wrong way</div>`;
    this.set('center', this.center, center, true);

    if (this.msgFor > 0) {
      this.msgFor -= dt;
      if (this.msgFor <= 0) this.msg.style.opacity = '0';
    }
    if (this.cardFor > 0) {
      this.cardFor -= dt;
      if (this.cardFor <= 0) this.card.style.opacity = '0';
    }

    this.set('hint', this.hint, v.soundLocked ? 'click or press a key for sound' : v.stageLabel);
    this.set('dev', this.dev, v.padName ?? 'no gamepad: keyboard');
  }
}
