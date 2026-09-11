// Auto-generated parameter controls. Every group in the registry gets a panel
// with the right widget per type, a live modulation readout, and a right-click
// menu for MIDI learn / modulation assignment.

import { params } from '../params.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function fmt(def, v) {
  if (def.type === 'enum') return def.options[Math.round(v)] ?? v;
  if (def.type === 'bool') return v > 0.5 ? 'on' : 'off';
  const range = def.max - def.min;
  const digits = range > 100 ? 0 : range > 10 ? 1 : range > 1 ? 2 : 3;
  return v.toFixed(digits) + (def.unit || '');
}

export class ParamPanel {
  constructor(app) {
    this.app = app;
    this.controls = [];
    this.menu = null;
    document.addEventListener('click', () => this.closeMenu());
  }

  /** @returns a <section> for one registry namespace. */
  buildGroup(ns, { collapsed = false, title = null, extraHeader = null, keys = null, exclude = null } = {}) {
    const group = params.groups.get(ns);
    const section = el('section', 'pgroup');
    if (collapsed) section.classList.add('collapsed');
    const head = el('header', 'pgroup-head');
    const twisty = el('span', 'twisty', '▾');
    head.appendChild(twisty);
    head.appendChild(el('h3', null, title || group?.label || ns));
    if (extraHeader) head.appendChild(extraHeader);
    head.addEventListener('click', (e) => {
      if (e.target.closest('.no-collapse')) return;
      section.classList.toggle('collapsed');
    });
    section.appendChild(head);
    const body = el('div', 'pgroup-body');
    section.appendChild(body);
    if (!group) return section;

    for (const def of group.params.values()) {
      if (keys && !keys.includes(def.key)) continue;
      if (exclude && exclude.includes(def.key)) continue;
      body.appendChild(this.buildControl(def));
    }
    return section;
  }

  buildControl(def) {
    const row = el('div', 'prow');
    row.dataset.path = def.path;
    const label = el('label', 'plabel', def.label);
    label.title = `${def.path}  —  right-click for MIDI / modulation`;
    row.appendChild(label);

    let input;
    let readout = null;

    if (def.type === 'bool') {
      input = el('button', 'ptoggle');
      input.type = 'button';
      input.addEventListener('click', () => {
        params.setBase(def.path, params.getBase(def.path) > 0.5 ? 0 : 1);
      });
    } else if (def.type === 'enum') {
      input = el('select', 'pselect');
      def.options.forEach((o, i) => {
        const opt = el('option', null, o);
        opt.value = String(i);
        input.appendChild(opt);
      });
      input.addEventListener('input', () => params.setBase(def.path, Number(input.value)));
    } else {
      input = el('input', 'pslider');
      input.type = 'range';
      input.min = def.min;
      input.max = def.max;
      input.step = def.step;
      input.addEventListener('input', () => params.setBase(def.path, Number(input.value)));
      input.addEventListener('dblclick', () => params.setBase(def.path, def.def));
      readout = el('span', 'pvalue');
      row.classList.add('has-slider');
    }
    row.appendChild(input);
    if (readout) row.appendChild(readout);

    const modDot = el('span', 'pmod');
    row.appendChild(modDot);

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.openMenu(e, def);
    });

    const ctl = { def, row, input, readout, modDot, last: null, lastMod: null, lastMidi: undefined };
    this.controls.push(ctl);
    this.refreshControl(ctl, true);
    return row;
  }

  openMenu(e, def) {
    this.closeMenu();
    const menu = el('div', 'ctxmenu');
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    const add = (text, fn, disabled = false) => {
      const item = el('button', 'ctxitem', text);
      if (disabled) item.disabled = true;
      item.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); this.closeMenu(); });
      menu.appendChild(item);
    };
    const midi = this.app.midi;
    const mapped = midi.mappedKeyFor(def.path);
    add(midi.enabled ? 'MIDI learn…' : 'Enable MIDI first', () => midi.startLearn(def.path), !midi.enabled);
    if (mapped) add(`Clear MIDI (${mapped})`, () => midi.unmap(def.path));
    if (def.modulatable) {
      add('Modulate with…', () => this.app.ui.addModRowFor(def.path));
    }
    add('Reset to default', () => params.setBase(def.path, def.def));
    document.body.appendChild(menu);
    this.menu = menu;
  }

  closeMenu() {
    if (this.menu) { this.menu.remove(); this.menu = null; }
  }

  refreshControl(ctl, force = false) {
    const { def } = ctl;
    const base = params.getBase(def.path);
    const eff = params.get(def.path);
    if (force || base !== ctl.last) {
      ctl.last = base;
      if (def.type === 'bool') {
        ctl.input.textContent = base > 0.5 ? 'ON' : 'OFF';
        ctl.input.classList.toggle('on', base > 0.5);
      } else if (def.type === 'enum') {
        ctl.input.value = String(Math.round(base));
      } else {
        ctl.input.value = String(base);
      }
    }
    if (ctl.readout) {
      const text = fmt(def, eff);
      if (text !== ctl.lastText) { ctl.readout.textContent = text; ctl.lastText = text; }
    }
    const mod = params.getMod(def.path);
    const modded = Math.abs(mod) > 1e-6;
    if (modded !== ctl.lastMod) {
      ctl.lastMod = modded;
      ctl.row.classList.toggle('modulated', modded);
    }
    if (modded && ctl.readout) {
      const span = Math.max(def.max - def.min, 1e-6);
      ctl.modDot.style.transform = `scaleX(${Math.min(1, Math.abs(mod) / span)})`;
    }
    const midiKey = this.app.midi.mappedKeyFor(def.path);
    const learning = this.app.midi.learning === def.path;
    const state = learning ? 'learn' : midiKey ? 'mapped' : '';
    if (state !== ctl.lastMidi) {
      ctl.lastMidi = state;
      ctl.row.classList.toggle('midi-mapped', state === 'mapped');
      ctl.row.classList.toggle('midi-learning', state === 'learn');
    }
  }

  refresh() {
    for (const ctl of this.controls) {
      if (!ctl.row.isConnected || ctl.row.closest('.collapsed')) continue;
      this.refreshControl(ctl);
    }
  }
}

export { el };
