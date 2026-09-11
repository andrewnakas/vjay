// Beat-synced autopilot. On beat / bar / phrase boundaries it rolls dice
// (scaled by one "chaos" knob) and makes a move: load a new generator on the
// idle deck, crossfade to it, cycle the palette, toggle an effect, or nudge a
// parameter. Useful for warm-up sets and for testing the whole rig hands-off.

import { params } from './params.js';
import { EFFECTS } from './shaders/effects.js';

const AUTO_PARAMS = [
  { key: 'enabled', label: 'Autopilot', type: 'bool', def: 0 },
  { key: 'chaos', label: 'Chaos', min: 0, max: 1, def: 0.35 },
  { key: 'swap', label: 'Source swap', min: 0, max: 1, def: 0.5 },
  { key: 'fadeBeats', label: 'Fade length (beats)', type: 'int', min: 1, max: 32, def: 8 },
  { key: 'palette', label: 'Palette change', min: 0, max: 1, def: 0.35 },
  { key: 'fxToggle', label: 'FX toggle', min: 0, max: 1, def: 0.3 },
  { key: 'jitter', label: 'Param drift', min: 0, max: 1, def: 0.4 },
  { key: 'maxFx', label: 'Max FX on', type: 'int', min: 0, max: 8, def: 4 },
];

export class Autopilot {
  constructor(app) {
    this.app = app;
    params.define('auto', 'Autopilot', AUTO_PARAMS);
    this.fadeTarget = null;
    this.fadeFrom = 0;
    this.fadeBeatsLeft = 0;
    this.fadeBeatsTotal = 0;
    this.log = [];
  }

  _note(msg) {
    this.log.unshift(msg);
    if (this.log.length > 6) this.log.pop();
    this.app.onAutopilotEvent?.(msg);
  }

  _roll(p) { return Math.random() < p * (0.35 + params.get('auto.chaos') * 1.3); }

  /** The least visible layer is the safe one to change under the audience. */
  _idleLayer() {
    const fade = params.get('mix.fade');
    const layers = this.app.layers.layers;
    if (!layers.length) return null;
    let best = layers[0];
    let bestOpacity = Infinity;
    for (const l of layers) {
      const o = l.effectiveOpacity(fade);
      if (o < bestOpacity) { bestOpacity = o; best = l; }
    }
    return best;
  }

  _randomGenerator() {
    const keys = this.app.sources.generatorKeys();
    const inUse = this.app.layers.activeSources();
    const pool = keys.filter((k) => !inUse.has(k));
    return pool[Math.floor(Math.random() * pool.length)] || keys[0];
  }

  _startFade(toSide) {
    this.fadeFrom = params.get('mix.fade');
    this.fadeTarget = toSide === 2 ? 1 : 0;
    this.fadeBeatsTotal = Math.max(1, Math.round(params.get('auto.fadeBeats')));
    this.fadeBeatsLeft = this.fadeBeatsTotal;
  }

  _toggleFx() {
    const on = EFFECTS.filter((e) => params.get(`fx.${e.id}.enabled`) > 0.5);
    const off = EFFECTS.filter((e) => params.get(`fx.${e.id}.enabled`) < 0.5);
    const maxOn = params.get('auto.maxFx');
    if (on.length >= maxOn && on.length) {
      const victim = on[Math.floor(Math.random() * on.length)];
      params.setBase(`fx.${victim.id}.enabled`, 0);
      this._note(`FX off: ${victim.name}`);
      return;
    }
    if (!off.length) return;
    const pick = off[Math.floor(Math.random() * off.length)];
    params.setBase(`fx.${pick.id}.enabled`, 1);
    // Come in at a partial wet mix so it does not slam.
    params.setBase(`fx.${pick.id}.mix`, 0.35 + Math.random() * 0.5);
    this._note(`FX on: ${pick.name}`);
  }

  _jitter() {
    const candidates = [];
    for (const e of EFFECTS) {
      if (params.get(`fx.${e.id}.enabled`) < 0.5) continue;
      for (const p of e.params) {
        if (p.type === 'bool' || p.type === 'enum') continue;
        candidates.push(`fx.${e.id}.${p.key}`);
      }
    }
    const idle = this._idleLayer();
    if (idle) candidates.push(`${idle.ns}.scale`, `${idle.ns}.rotate`, `${idle.ns}.hue`);
    if (!candidates.length) return;
    const path = candidates[Math.floor(Math.random() * candidates.length)];
    const def = params.def(path);
    if (!def) return;
    const range = def.max - def.min;
    const spread = 0.15 + params.get('auto.chaos') * 0.35;
    const next = params.getBase(path) + (Math.random() - 0.5) * range * spread;
    params.setBase(path, next);
  }

  onBeat(features) {
    if (this.fadeBeatsLeft > 0) {
      this.fadeBeatsLeft--;
      const t = 1 - this.fadeBeatsLeft / this.fadeBeatsTotal;
      const eased = t * t * (3 - 2 * t);
      params.setBase('mix.fade', this.fadeFrom + (this.fadeTarget - this.fadeFrom) * eased);
      if (this.fadeBeatsLeft === 0) this.fadeTarget = null;
    }
  }

  onBar() {
    if (this._roll(params.get('auto.fxToggle') * 0.5)) this._toggleFx();
    if (this._roll(params.get('auto.jitter') * 0.6)) this._jitter();
  }

  onPhrase() {
    if (this._roll(params.get('auto.swap'))) {
      const idle = this._idleLayer();
      if (idle) {
        const key = this._randomGenerator();
        idle.sourceKey = key;
        idle.rename(this.app.sources.get(key)?.label || key);
        this.app.layers.onChange();
        const side = Math.round(params.get(`${idle.ns}.xfade`));
        if (side) this._startFade(side);
        this._note(`${idle.name} → ${this.app.sources.get(key)?.label || key}`);
      }
    }
    if (this._roll(params.get('auto.palette'))) {
      const def = params.def('master.palette');
      const next = Math.floor(Math.random() * (def.max + 1));
      params.setBase('master.palette', next);
      this._note(`Palette → ${def.options[next]}`);
    }
    if (this._roll(params.get('auto.fxToggle'))) this._toggleFx();
  }

  update(features) {
    if (params.get('auto.enabled') < 0.5) return;
    if (features.beatHit) this.onBeat(features);
    if (features.barHit) this.onBar();
    if (features.phraseHit) this.onPhrase();
  }
}
