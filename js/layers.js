// Layer stack.
//
// Replaces the old fixed A/B decks. Each layer holds one source, a free
// transform, a blend mode, and its own effect chain. Effect params are
// registered lazily per layer, so adding an effect to layer 3 creates
// `L3.fx.trails.*` in the registry and it immediately gets sliders, modulation
// targets, preset support and MIDI learn like anything else.

import { params } from './params.js';
import { EFFECT_BY_ID } from './shaders/effects.js';
import { GROUPS } from './mapping.js';

// Eight planes competing for eight layers left roughly one layer per plane,
// which is not a comp. A layer whose bus no plane is showing is skipped
// entirely by the renderer, so the ceiling costs nothing until it is used.
export const MAX_LAYERS = 14;

export const BLEND_MODES = [
  'Normal', 'Add', 'Screen', 'Multiply', 'Difference',
  'Lighten', 'Darken', 'Overlay', 'Luma key',
];

export const LAYER_PARAMS = [
  { key: 'visible', label: 'Visible', type: 'bool', def: 1 },
  { key: 'opacity', label: 'Opacity', min: 0, max: 1, def: 1 },
  { key: 'blend', label: 'Blend', type: 'enum', options: BLEND_MODES, def: 0 },
  // Which bus this layer lands in. Main gets the master FX chain and is what a
  // full-frame wall plane shows; the other buses exist so a plane (a picture
  // frame on the wall) can show its own comp. Labelled by plane in the UI.
  { key: 'group', label: 'Bus', type: 'enum', options: GROUPS, def: 0 },
  { key: 'xfade', label: 'Crossfader', type: 'enum', options: ['Ignore', 'Side A', 'Side B'], def: 0 },
  { key: 'x', label: 'Position X', min: -2, max: 2, def: 0 },
  { key: 'y', label: 'Position Y', min: -2, max: 2, def: 0 },
  { key: 'scale', label: 'Scale', min: 0.02, max: 4, def: 1 },
  { key: 'stretch', label: 'Stretch X', min: 0.2, max: 5, def: 1 },
  { key: 'rotate', label: 'Rotate', min: -3.1416, max: 3.1416, def: 0 },
  { key: 'fit', label: 'Fit', type: 'enum', options: ['Cover', 'Contain', 'Stretch'], def: 0 },
  { key: 'flipX', label: 'Flip X', type: 'bool', def: 0 },
  { key: 'flipY', label: 'Flip Y', type: 'bool', def: 0 },
  { key: 'crop', label: 'Edge crop', min: 0, max: 0.45, def: 0 },
  { key: 'feather', label: 'Edge feather', min: 0, max: 0.5, def: 0 },
  { key: 'radius', label: 'Corner radius', min: 0, max: 0.5, def: 0 },
  { key: 'keyLow', label: 'Key out below', min: 0, max: 1, def: 0 },
  { key: 'keySoft', label: 'Key softness', min: 0.001, max: 0.5, def: 0.05 },
  // Matte: a second source used as a mask. With a Kinect depth feed this is a
  // depth key - keep only what is between `near` and `far` metres.
  { key: 'matteMode', label: 'Matte', type: 'enum', options: ['Off', 'Depth window', 'Luma'], def: 0 },
  { key: 'matteNear', label: 'Matte near', min: 0, max: 1, def: 0.15 },
  { key: 'matteFar', label: 'Matte far', min: 0, max: 1, def: 0.65 },
  { key: 'matteSoft', label: 'Matte softness', min: 0.001, max: 0.3, def: 0.03 },
  { key: 'matteInvert', label: 'Invert matte', type: 'bool', def: 0 },
  { key: 'hue', label: 'Hue', min: -1, max: 1, def: 0 },
  { key: 'sat', label: 'Saturation', min: 0, max: 3, def: 1 },
  { key: 'bright', label: 'Brightness', min: 0, max: 3, def: 1 },
  { key: 'contrast', label: 'Contrast', min: 0, max: 3, def: 1 },
];

let nextId = 1;

export class Layer {
  constructor(sourceKey = null, name = null) {
    this.id = nextId++;
    this.ns = `L${this.id}`;
    this.sourceKey = sourceKey;
    this.matteKey = null;      // optional second source used as a mask
    this.name = name || `Layer ${this.id}`;
    this.chain = [];          // ordered effect ids
    this._fxDefined = new Set();
    params.define(this.ns, this.name, LAYER_PARAMS);
  }

  fxNs(effectId) { return `${this.ns}.fx.${effectId}`; }

  /** Registers this layer's own copy of an effect's params on first use. */
  ensureFx(effectId) {
    if (this._fxDefined.has(effectId)) return true;
    const def = EFFECT_BY_ID[effectId];
    if (!def) return false;
    params.define(this.fxNs(effectId), `${this.name} · ${def.name}`, [
      { key: 'enabled', label: 'On', type: 'bool', def: 1 },
      { key: 'mix', label: 'Amount', min: 0, max: 1, def: 1 },
      ...def.params,
    ]);
    this._fxDefined.add(effectId);
    return true;
  }

  addFx(effectId) {
    if (this.chain.includes(effectId)) return false;
    if (!this.ensureFx(effectId)) return false;
    this.chain.push(effectId);
    params.setBase(`${this.fxNs(effectId)}.enabled`, 1);
    return true;
  }

  removeFx(effectId) {
    this.chain = this.chain.filter((id) => id !== effectId);
  }

  moveFx(effectId, delta) {
    const i = this.chain.indexOf(effectId);
    if (i < 0) return;
    const j = Math.max(0, Math.min(this.chain.length - 1, i + delta));
    this.chain.splice(i, 1);
    this.chain.splice(j, 0, effectId);
  }

  activeFx() {
    return this.chain.filter((id) => params.get(`${this.fxNs(id)}.enabled`) > 0.5);
  }

  rename(name) {
    this.name = name;
    const g = params.groups.get(this.ns);
    if (g) g.label = name;
  }

  serialize() {
    return {
      id: this.id, name: this.name, sourceKey: this.sourceKey,
      matteKey: this.matteKey, chain: [...this.chain],
    };
  }

  /** Effective opacity including the crossfader assignment. */
  effectiveOpacity(fade) {
    if (params.get(`${this.ns}.visible`) < 0.5) return 0;
    const o = params.get(`${this.ns}.opacity`);
    const side = Math.round(params.get(`${this.ns}.xfade`));
    if (side === 1) return o * (1 - fade);
    if (side === 2) return o * fade;
    return o;
  }
}

export class LayerStack {
  constructor() {
    this.layers = [];        // index 0 = bottom
    this.selectedId = null;
    this.onChange = () => {};
  }

  get selected() { return this.layers.find((l) => l.id === this.selectedId) || null; }

  add(sourceKey, name, { atTop = true, select = true } = {}) {
    if (this.layers.length >= MAX_LAYERS) return null;
    const layer = new Layer(sourceKey, name);
    if (atTop) this.layers.push(layer);
    else this.layers.unshift(layer);
    if (select) this.selectedId = layer.id;
    this.onChange();
    return layer;
  }

  remove(id) {
    this.layers = this.layers.filter((l) => l.id !== id);
    if (this.selectedId === id) this.selectedId = this.layers.at(-1)?.id ?? null;
    this.onChange();
  }

  move(id, delta) {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    const j = Math.max(0, Math.min(this.layers.length - 1, i + delta));
    if (i === j) return;
    const [l] = this.layers.splice(i, 1);
    this.layers.splice(j, 0, l);
    this.onChange();
  }

  /** Drag-and-drop reorder: put `id` at absolute index `to`. */
  reorder(id, to) {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    const [l] = this.layers.splice(i, 1);
    this.layers.splice(Math.max(0, Math.min(this.layers.length, to)), 0, l);
    this.onChange();
  }

  select(id) {
    this.selectedId = id;
    this.onChange();
  }

  byId(id) { return this.layers.find((l) => l.id === id) || null; }

  clear() {
    // Drop the per-layer effect namespaces too, or `L3.fx.trails.*` outlives
    // the layer it belonged to and rides along in every later snapshot.
    for (const l of this.layers) {
      for (const fxId of l._fxDefined) params.dropGroup(l.fxNs(fxId));
      params.dropGroup(l.ns);
    }
    this.layers = [];
    this.selectedId = null;
    this.onChange();
  }

  /** Source keys currently in use - only these need updating each frame. */
  activeSources() {
    const s = new Set();
    for (const l of this.layers) {
      if (l.sourceKey) s.add(l.sourceKey);
      if (l.matteKey) s.add(l.matteKey);
    }
    return s;
  }

  serialize() {
    return { layers: this.layers.map((l) => l.serialize()), selectedId: this.selectedId };
  }

  /** Rebuilds the stack from a preset. Params are restored separately. */
  restore(state, { keepIds = true } = {}) {
    this.clear();
    for (const spec of state?.layers || []) {
      const layer = new Layer(spec.sourceKey, spec.name);
      layer.matteKey = spec.matteKey || null;
      if (keepIds && spec.id) {
        // Reuse the saved id so the saved `L<id>.*` params land on this layer.
        params.dropGroup(layer.ns);
        layer.id = spec.id;
        layer.ns = `L${spec.id}`;
        nextId = Math.max(nextId, spec.id + 1);
        params.define(layer.ns, layer.name, LAYER_PARAMS);
      }
      for (const fxId of spec.chain || []) {
        layer.ensureFx(fxId);
        layer.chain.push(fxId);
      }
      this.layers.push(layer);
    }
    this.selectedId = state?.selectedId ?? this.layers.at(-1)?.id ?? null;
    this.onChange();
  }
}
