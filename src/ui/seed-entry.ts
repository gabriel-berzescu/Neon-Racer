/**
 * Typing in a stage number (to drive a stage someone else has: Gabriel and Silviu trade them).
 *
 * Gamepad: left / right picks a digit, up / down changes it, A drives that stage, B goes back. Keyboard: type the digits (Backspace
 * rubs one out), Enter drives, Escape goes back; the arrows work as on the pad.
 */
import type { Nav } from '../input/controls';

export const SEED_DIGITS = 6;

const CSS = `
.nr-seed { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; pointer-events: none; }
.nr-seed.open { display: flex; }
.nr-seed .box { pointer-events: auto; padding: 26px 34px 20px; border: 1.5px solid rgba(34,243,255,.6); border-radius: 12px;
  background: rgba(7,2,15,.78); backdrop-filter: blur(4px); box-shadow: 0 0 30px rgba(34,243,255,.28); text-align: center;
  color: #bff9ff; font: 600 15px/1.35 ui-monospace, 'Cascadia Mono', Consolas, monospace; letter-spacing: .06em; text-shadow: 0 0 6px rgba(34,243,255,.6); }
.nr-seed h2 { margin: 0 0 18px; font-size: 22px; letter-spacing: .35em; text-transform: uppercase; color: #fff; }
.nr-seed .digits { display: flex; gap: 10px; justify-content: center; }
.nr-seed .d { width: 46px; height: 64px; display: flex; align-items: center; justify-content: center; font-size: 40px; color: #fff;
  border: 1.5px solid rgba(34,243,255,.45); border-radius: 8px; font-variant-numeric: tabular-nums; }
.nr-seed .d.sel { border-color: #ff6be6; box-shadow: 0 0 16px rgba(255,43,214,.55), inset 0 0 10px rgba(255,43,214,.3); text-shadow: 0 0 10px #ff2bd6; }
.nr-seed .help { margin-top: 16px; font-size: 11px; opacity: .6; letter-spacing: .12em; text-transform: uppercase; }
`;

export class SeedEntry {
  private readonly root: HTMLElement;
  private readonly digitsEl: HTMLElement;
  private digits: number[] = new Array(SEED_DIGITS).fill(0);
  private cursor = SEED_DIGITS - 1;
  private result: { seed: number } | 'back' | null = null;
  private openNow = false;
  /** Backspace rubbed out a digit this frame: it is also the controls' "back", which must not close the entry then. */
  private rubbed = false;

  constructor(parent: HTMLElement) {
    if (!document.getElementById('nr-seed-css')) {
      const st = document.createElement('style');
      st.id = 'nr-seed-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.root = document.createElement('div');
    this.root.className = 'nr-seed';
    this.root.innerHTML = `<div class="box"><h2>Stage number</h2><div class="digits"></div>
      <div class="help">type it, or: left / right to pick a digit, up / down to change it &middot; A / enter: drive &middot; B / esc: back</div></div>`;
    this.digitsEl = this.root.querySelector('.digits') as HTMLElement;
    parent.appendChild(this.root);
    window.addEventListener('keydown', (e) => {
      if (!this.openNow) return;
      if (/^Digit\d$|^Numpad\d$/.test(e.code)) {
        // type from the right, like a calculator
        this.digits = [...this.digits.slice(1), Number(e.code.slice(-1))];
        this.cursor = SEED_DIGITS - 1;
        this.render();
      } else if (e.code === 'Backspace') {
        this.digits = [0, ...this.digits.slice(0, -1)];
        this.rubbed = true;
        this.render();
      }
    });
  }

  get isOpen(): boolean {
    return this.openNow;
  }

  open(seed: number): void {
    const s = String(Math.max(0, Math.floor(seed)) % 10 ** SEED_DIGITS).padStart(SEED_DIGITS, '0');
    this.digits = [...s].map(Number);
    this.cursor = SEED_DIGITS - 1;
    this.result = null;
    this.openNow = true;
    this.root.classList.add('open');
    this.render();
  }

  close(): void {
    this.openNow = false;
    this.root.classList.remove('open');
  }

  /** This frame's navigation; returns the stage to drive, 'back', or null while still typing. */
  handle(nav: Nav): { seed: number } | 'back' | null {
    if (!this.openNow) return null;
    if (nav.left) this.cursor = (this.cursor + SEED_DIGITS - 1) % SEED_DIGITS;
    if (nav.right) this.cursor = (this.cursor + 1) % SEED_DIGITS;
    if (nav.up) this.digits[this.cursor] = (this.digits[this.cursor] + 1) % 10;
    if (nav.down) this.digits[this.cursor] = (this.digits[this.cursor] + 9) % 10;
    if (nav.left || nav.right || nav.up || nav.down) this.render();
    if (nav.confirm) this.result = { seed: Number(this.digits.join('')) };
    else if (nav.back && !this.rubbed) this.result = 'back';
    this.rubbed = false;
    const r = this.result;
    this.result = null;
    return r;
  }

  private render(): void {
    this.digitsEl.innerHTML = this.digits.map((d, i) => `<div class="d${i === this.cursor ? ' sel' : ''}">${d}</div>`).join('');
  }
}
