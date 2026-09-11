// Preset snapshots. State comes straight off the param registry, so anything
// registered is saved without extra bookkeeping.

import { params } from './params.js';

const STORAGE_KEY = 'vjay.presets.v1';
export const SLOT_COUNT = 8;

/**
 * Namespaces that describe the RIG rather than the performance, and so must
 * never travel in a cue: the projection surfaces and the camera framing.
 */
const CAMERA_NS = /^cam\d*$/;
const RIG_NS = (ns) => ns === 'map' || ns.startsWith('map.') || CAMERA_NS.test(ns);

export class Presets {
  constructor(app) {
    this.app = app;
    this.slots = new Array(SLOT_COUNT).fill(null);
    this.morph = null;
    this.onChange = () => {};
    this.load();
  }

  /**
   * A full snapshot is ~1500 params; a show of 150 cues would not fit in
   * localStorage. `compact` keeps only what differs from the parameter's
   * default, and `applyState` puts the defaults back, so the state recalled is
   * still complete - just five times smaller on disk.
   *
   * Mapping (`map.*`) is deliberately excluded: surfaces are venue calibration,
   * and a cue that moved the picture off the wall would be unrecoverable live.
   *
   * Camera framing (`cam*.zoom` and friends) is excluded for the same reason.
   * How a camera is aimed and cropped is a fact about the rig, not about the
   * song; letting cues carry it means every cue change re-frames the camera
   * out from under you.
   */
  capture({ compact = true } = {}) {
    const all = params.snapshot();
    const out = {};
    for (const path in all) {
      if (RIG_NS(path.slice(0, path.lastIndexOf('.')))) continue;
      const def = params.def(path);
      // A value with no definition left cannot be applied to anything, so
      // storing it only makes the file bigger.
      if (!def) continue;
      if (compact && all[path] === def.def) continue;
      out[path] = all[path];
    }
    return {
      version: 2,
      savedAt: new Date().toISOString(),
      params: out,
      mods: this.app.modulation.serialize(),
      chain: [...this.app.renderer.chain],
      stack: this.app.layers.serialize(),
    };
  }

  /** Saved values plus every other registered param at its default. */
  _complete(saved) {
    const out = {};
    for (const g of params.orderedGroups()) {
      if (RIG_NS(g.ns)) continue;
      for (const d of g.params.values()) {
        out[d.path] = saved && saved[d.path] !== undefined ? saved[d.path] : d.def;
      }
    }
    return out;
  }

  store(slot) {
    this.slots[slot] = this.capture();
    this.save();
    this.onChange();
    return this.slots[slot];
  }

  clearSlot(slot) {
    this.slots[slot] = null;
    this.save();
    this.onChange();
  }

  /** morphBeats = 0 recalls instantly; otherwise numeric params glide. */
  recall(slot, morphBeats = 0) {
    const state = this.slots[slot];
    if (!state) return false;
    this.applyState(state, morphBeats);
    return true;
  }

  applyState(state, morphBeats = 0) {
    if (!state) return;
    if (state.chain) this.app.renderer.chain = [...state.chain];
    if (state.mods) this.app.modulation.restore(state.mods);
    if (state.stack) {
      // Layers must exist before params.restore, or the saved L<id>.* values
      // have no group to land in and are silently dropped.
      //
      // When the stack is unchanged - the usual case moving between cues of one
      // song - the Layer objects and their feedback/flow buffers are kept, so
      // trails carry across the change instead of snapping to black.
      const live = JSON.stringify(this.app.layers.serialize().layers);
      const want = JSON.stringify(state.stack.layers || []);
      if (live !== want) {
        for (const l of this.app.layers.layers) this.app.renderer.disposeAux(l.id);
        this.app.layers.restore(state.stack);
      } else if (state.stack.selectedId != null) {
        this.app.layers.selectedId = state.stack.selectedId;
      }
    }
    const target = this._complete(state.params);
    if (!morphBeats || morphBeats <= 0) {
      params.restore(target);
      this.morph = null;
    } else {
      const from = params.snapshot();
      const bpm = this.app.tempo.bpm || 120;
      this.morph = {
        from, to: target, t: 0,
        duration: Math.max(0.05, (morphBeats * 60) / bpm),
      };
      // Switch discrete params up front so the target look is structurally right.
      for (const path in target) {
        const def = params.def(path);
        if (def && (def.type === 'bool' || def.type === 'enum')) params.setBase(path, target[path]);
      }
    }
    this.onChange();
  }

  update(dt) {
    if (!this.morph) return;
    const m = this.morph;
    m.t += dt / m.duration;
    const k = Math.min(1, m.t);
    const eased = k * k * (3 - 2 * k);
    for (const path in m.to) {
      const def = params.def(path);
      if (!def || def.type === 'bool' || def.type === 'enum') continue;
      const a = m.from[path] ?? def.def;
      params.setBase(path, a + (m.to[path] - a) * eased, true);
    }
    if (k >= 1) { params.restore(m.to); this.morph = null; this.onChange(); }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.slots));
    } catch (e) {
      console.warn('[presets] could not save to localStorage', e);
    }
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (let i = 0; i < SLOT_COUNT; i++) this.slots[i] = parsed[i] || null;
      }
    } catch (e) {
      console.warn('[presets] could not read localStorage', e);
    }
  }

  exportFile() {
    const blob = new Blob([JSON.stringify({ vjay: 1, slots: this.slots }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vjay-presets-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async importFile(file) {
    const text = await file.text();
    const data = JSON.parse(text);
    const slots = Array.isArray(data) ? data : data.slots;
    if (!Array.isArray(slots)) throw new Error('Not a VJay preset file');
    for (let i = 0; i < SLOT_COUNT; i++) this.slots[i] = slots[i] || null;
    this.save();
    this.onChange();
  }
}
