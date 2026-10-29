/**
 * A small neon menu card (title, pause, results, settings): a title, an optional body, a list of choices. Neon-Flight's, with
 * choices that hold a value changed by left / right (the car, the settings).
 *
 * Gamepad: D-pad or left stick up / down to move, left / right to change a value, A to pick, B to go back (when the menu has a back
 * choice), X for the retry choice. Keyboard: the arrow keys, Enter, Escape / Backspace, R. Mouse: click a choice (or its arrows).
 * Driving controls are not read while a menu is open.
 */
import type { Nav } from '../input/controls';

export interface MenuChoice {
  id: string;
  label: string;
  /** Shown at the right of the row: a value, or the gamepad button that picks it directly. */
  key?: string;
  /** Left / right change this choice's value (the row shows arrows around `key`); A also steps it forward. */
  adjust?: boolean;
}

export interface MenuSpec {
  title: string;
  /** HTML under the title (times, splits and the like). */
  body?: string;
  choices: MenuChoice[];
  /** The choice B / Escape picks (none: they do nothing). */
  back?: string;
  /** The choice X / R picks directly. */
  retry?: string;
  /** 'title': the big logo layout of the title screen (default: a card). */
  style?: 'card' | 'title';
  /** Longer rows with values worth reading (a list of stages and their times): a wider list, brighter values. */
  wide?: boolean;
  /** The choice selected when the menu opens (an index). */
  selected?: number;
}

/** What the player did: picked a choice (dir 0), or moved an adjustable one's value (-1 / +1). */
export interface MenuPick {
  id: string;
  dir: -1 | 0 | 1;
}

const CSS = `
.nr-menu { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; pointer-events: none; }
.nr-menu.open { display: flex; }
.nr-menu .box { pointer-events: auto; min-width: 380px; max-width: 560px; padding: 22px 26px 18px; border: 1.5px solid rgba(34,243,255,.6);
  border-radius: 12px; background: rgba(7,2,15,.72); backdrop-filter: blur(4px); box-shadow: 0 0 30px rgba(34,243,255,.28);
  color: #bff9ff; font: 600 15px/1.35 ui-monospace, 'Cascadia Mono', Consolas, monospace; letter-spacing: .06em;
  text-shadow: 0 0 6px rgba(34,243,255,.6); }
.nr-menu h2 { margin: 0 0 12px; font-size: 24px; letter-spacing: .35em; text-transform: uppercase; color: #fff; }
.nr-menu .body { margin: 0 0 14px; font-weight: 500; letter-spacing: .03em; }
.nr-menu .body table { border-collapse: collapse; width: 100%; }
.nr-menu .body td { padding: 2px 0; } .nr-menu .body td:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; padding-left: 18px; }
.nr-menu .body .total td { padding-top: 8px; font-size: 22px; color: #ffd27a; text-shadow: 0 0 8px #ff9a40; }
.nr-menu .body .ahead { color: #6dffb0; text-shadow: 0 0 8px #18ff8c; } .nr-menu .body .behind { color: #ff8fa3; text-shadow: 0 0 8px #ff2b5e; }
.nr-menu .body .note { margin-top: 10px; font-size: 13px; opacity: .85; }
.nr-menu .body .hot { color: #fff; text-shadow: 0 0 8px #ff2bd6, 0 0 20px #ff2bd6; letter-spacing: .25em; text-transform: uppercase; }
.nr-menu ul { list-style: none; margin: 0; padding: 0; }
.nr-menu li { display: flex; justify-content: space-between; gap: 18px; padding: 8px 12px; margin: 3px 0; border-radius: 6px; cursor: pointer;
  text-transform: uppercase; letter-spacing: .14em; }
.nr-menu li .k { opacity: .6; font-size: 12px; align-self: center; white-space: nowrap; }
.nr-menu li.adj .k { opacity: .95; font-size: 14px; color: #ffd27a; text-shadow: 0 0 6px #ff9a40; }
.nr-menu li .k .arr { opacity: 0; padding: 0 6px; color: #ff6be6; } .nr-menu li.sel .k .arr { opacity: 1; }
.nr-menu li.sel { background: rgba(255,43,214,.16); color: #fff; box-shadow: inset 0 0 0 1.5px rgba(255,107,230,.8), 0 0 14px rgba(255,43,214,.35);
  text-shadow: 0 0 8px #ff2bd6; }
.nr-menu.title { align-items: flex-start; justify-content: flex-start; padding: 12vh 0 0 7vw; }
.nr-menu.title .box { background: none; border: none; box-shadow: none; backdrop-filter: none; min-width: 460px; max-width: 560px; text-align: left; }
.nr-menu.title h2 { font-size: 64px; letter-spacing: .26em; margin: 0 0 6px; color: #fff; white-space: nowrap;
  text-shadow: 0 0 8px #ff2bd6, 0 0 22px #ff2bd6, 0 0 60px #ff2bd6, 0 0 4px #22f3ff; }
.nr-menu.title .body { margin-bottom: 26px; letter-spacing: .35em; text-transform: uppercase; font-size: 13px; opacity: .8; }
.nr-menu.title ul { max-width: 460px; }
.nr-menu.title li { background: rgba(7,2,15,.45); }
.nr-menu.title li.sel { background: rgba(255,43,214,.16); }
.nr-menu.wide .box { max-width: 760px; } .nr-menu.wide ul { max-width: 680px; }
.nr-menu.wide li { white-space: nowrap; } .nr-menu.wide li .k { opacity: .9; font-size: 14px; color: #ffd27a; text-shadow: 0 0 6px #ff9a40; }
.nr-menu .body .info { text-transform: none; letter-spacing: .03em; font-size: 15px; text-align: left; opacity: 1; max-width: 560px;
  padding: 14px 20px; border-radius: 10px; background: rgba(7,2,15,.72); backdrop-filter: blur(4px); box-shadow: 0 0 24px rgba(7,2,15,.6); }
.nr-menu .body .info table { border-collapse: collapse; margin: 0 0 12px; width: auto; }
.nr-menu .body .info td { padding: 4px 10px; text-align: left; } .nr-menu .body .info td:first-child { color: #ffd27a; text-align: right; }
.nr-menu .body .info p { margin: 10px 0; line-height: 1.45; } .nr-menu .body .info b { color: #ff9bf0; font-weight: 600; }
.nr-menu .help { margin-top: 10px; font-size: 11px; opacity: .55; letter-spacing: .12em; text-transform: uppercase; }
`;

export class Menu {
  private readonly root: HTMLElement;
  private readonly box: HTMLElement;
  private spec: MenuSpec | null = null;
  private sel = 0;
  private picked: MenuPick | null = null;

  constructor(parent: HTMLElement) {
    if (!document.getElementById('nr-menu-css')) {
      const st = document.createElement('style');
      st.id = 'nr-menu-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.root = document.createElement('div');
    this.root.className = 'nr-menu';
    this.box = document.createElement('div');
    this.box.className = 'box';
    this.root.appendChild(this.box);
    parent.appendChild(this.root);
  }

  get isOpen(): boolean {
    return this.spec !== null;
  }

  get title(): string | null {
    return this.spec?.title ?? null;
  }

  /** The index of the selected choice. */
  get selected(): number {
    return this.sel;
  }

  open(spec: MenuSpec): void {
    this.spec = spec;
    this.sel = Math.max(0, Math.min(spec.choices.length - 1, spec.selected ?? 0));
    this.root.classList.toggle('title', spec.style === 'title');
    this.root.classList.toggle('wide', spec.wide === true);
    this.picked = null;
    this.render();
    this.root.classList.add('open');
  }

  /** The same menu with new contents, keeping the selection (a setting changed). */
  refresh(spec: MenuSpec): void {
    const sel = this.sel;
    this.open({ ...spec, selected: sel });
  }

  close(): void {
    this.spec = null;
    this.root.classList.remove('open');
  }

  /** Reads this frame's navigation; returns what was picked or changed this frame, if anything. */
  handle(nav: Nav): MenuPick | null {
    const spec = this.spec;
    if (!spec) return null;
    if (this.picked) {
      const p = this.picked;
      this.picked = null;
      return p;
    }
    const n = spec.choices.length;
    if (nav.up) this.select((this.sel - 1 + n) % n);
    if (nav.down) this.select((this.sel + 1) % n);
    const c = spec.choices[this.sel];
    if (c?.adjust && (nav.left || nav.right)) return { id: c.id, dir: nav.left ? -1 : 1 };
    if (nav.confirm && c) return { id: c.id, dir: c.adjust ? 1 : 0 };
    if (nav.back && spec.back) return { id: spec.back, dir: 0 };
    if (nav.retry && spec.retry) return { id: spec.retry, dir: 0 };
    return null;
  }

  private select(i: number): void {
    this.sel = i;
    this.box.querySelectorAll('li').forEach((li, k) => li.classList.toggle('sel', k === i));
  }

  private render(): void {
    const spec = this.spec;
    if (!spec) return;
    this.box.innerHTML = '';
    const h = document.createElement('h2');
    h.textContent = spec.title;
    this.box.appendChild(h);
    if (spec.body) {
      const b = document.createElement('div');
      b.className = 'body';
      b.innerHTML = spec.body;
      this.box.appendChild(b);
    }
    const ul = document.createElement('ul');
    spec.choices.forEach((c, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span></span><span class="k"></span>`;
      (li.firstChild as HTMLElement).textContent = c.label;
      const k = li.lastChild as HTMLElement;
      if (c.adjust) {
        li.classList.add('adj');
        const l = document.createElement('span');
        l.className = 'arr';
        l.textContent = '◂';
        l.addEventListener('click', (e) => {
          e.stopPropagation();
          this.picked = { id: c.id, dir: -1 };
        });
        const r = document.createElement('span');
        r.className = 'arr';
        r.textContent = '▸';
        k.append(l, document.createTextNode(c.key ?? ''), r);
      } else k.textContent = c.key ?? '';
      if (i === this.sel) li.classList.add('sel');
      li.addEventListener('mouseenter', () => this.select(i));
      li.addEventListener('click', () => (this.picked = { id: c.id, dir: c.adjust ? 1 : 0 }));
      ul.appendChild(li);
    });
    this.box.appendChild(ul);
    const help = document.createElement('div');
    help.className = 'help';
    const adjustable = spec.choices.some((c) => c.adjust);
    help.textContent = adjustable ? 'up / down to choose, left / right to change, A / enter to pick' : 'up / down to choose, A / enter to pick';
    this.box.appendChild(help);
  }
}
