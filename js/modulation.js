// Modulation matrix: any audio feature or tempo-synced LFO can drive any
// registered parameter. This is what turns the app from "a shader viewer" into
// something the music actually plays.

import { params } from './params.js';

export const MOD_SOURCES = [
  { key: 'bass', label: 'Bass' },
  { key: 'lowMid', label: 'Low mid' },
  { key: 'mid', label: 'Mid' },
  { key: 'high', label: 'High' },
  { key: 'air', label: 'Air' },
  { key: 'level', label: 'Level (RMS)' },
  { key: 'flux', label: 'Spectral flux' },
  { key: 'centroid', label: 'Brightness (centroid)' },
  { key: 'kick', label: 'Low transient (kick)' },
  { key: 'snare', label: 'Mid transient (snare)' },
  { key: 'hat', label: 'High transient (hat)' },
  { key: 'voice', label: 'Voice (vocal band)' },
  { key: 'beatPulse', label: 'Beat pulse' },
  { key: 'beatPhase', label: 'Beat ramp' },
  { key: 'barPhase', label: 'Bar ramp' },
  { key: 'phrasePhase', label: 'Phrase ramp' },
  { key: 'confidence', label: 'Beat confidence' },
  { key: 'lfo1', label: 'LFO 1' },
  { key: 'lfo2', label: 'LFO 2' },
  { key: 'lfo3', label: 'LFO 3' },
  { key: 'lfo4', label: 'LFO 4' },
];

export const CURVES = ['Linear', 'Exp', 'Log', 'S-curve'];
const CYCLE_LABELS = ['1/4 beat', '1/2 beat', '1 beat', '2 beats', '1 bar', '2 bars', '4 bars', '8 bars'];
const CYCLE_BEATS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
const SHAPES = ['Sine', 'Triangle', 'Saw up', 'Saw down', 'Square', 'Sample & hold'];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hash = (n) => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };

function shape(kind, pos) {
  switch (kind) {
    case 1: return 1 - Math.abs(((pos * 2) % 2) - 1);
    case 2: return pos;
    case 3: return 1 - pos;
    case 4: return pos < 0.5 ? 0 : 1;
    case 5: return 0.5; // handled in updateLfos, which knows the cycle index
    default: return 0.5 + 0.5 * Math.sin(pos * Math.PI * 2);
  }
}

function applyCurve(v, curve) {
  switch (curve) {
    case 1: return v * v;
    case 2: return Math.sqrt(clamp01(v));
    case 3: return v * v * (3 - 2 * v);
    default: return v;
  }
}

let rowId = 0;

export class Modulation {
  constructor() {
    this.rows = [];
    this.lfoValues = { lfo1: 0, lfo2: 0, lfo3: 0, lfo4: 0 };
    this._shSeed = { lfo1: 0, lfo2: 0, lfo3: 0, lfo4: 0 };
    this._shCycle = { lfo1: -1, lfo2: -1, lfo3: -1, lfo4: -1 };
    this._smoothed = new Map();

    for (let i = 1; i <= 4; i++) {
      params.define(`lfo${i}`, `LFO ${i}`, [
        { key: 'cycle', label: 'Cycle', type: 'enum', options: CYCLE_LABELS, def: i <= 2 ? 4 : 5 },
        { key: 'shape', label: 'Shape', type: 'enum', options: SHAPES, def: i === 4 ? 5 : 0 },
        { key: 'phase', label: 'Phase', min: 0, max: 1, def: 0 },
        { key: 'depth', label: 'Depth', min: 0, max: 1, def: 1 },
      ]);
    }
  }

  add(source = 'bass', target = null, amount = 0.5) {
    const targets = params.modTargets();
    const t = target || (targets[0] && targets[0].path);
    if (!t) return null;
    const row = {
      id: ++rowId, source, target: t, amount,
      curve: 0, bipolar: false, smooth: 0.1, enabled: true,
    };
    this.rows.push(row);
    return row;
  }

  remove(id) { this.rows = this.rows.filter((r) => r.id !== id); }
  clear() { this.rows = []; this._smoothed.clear(); }

  updateLfos(features) {
    const beats = (features.beatCount || 0) + (features.beatPhase || 0);
    for (let i = 1; i <= 4; i++) {
      const ns = `lfo${i}`;
      const cycleBeats = CYCLE_BEATS[Math.round(params.get(`${ns}.cycle`))] || 4;
      const kind = Math.round(params.get(`${ns}.shape`));
      const phase = params.get(`${ns}.phase`);
      const depth = params.get(`${ns}.depth`);
      const raw = (beats / cycleBeats + phase) % 1;
      const pos = raw < 0 ? raw + 1 : raw;
      let v;
      if (kind === 5) {
        const cycle = Math.floor(beats / cycleBeats + phase);
        if (cycle !== this._shCycle[ns]) {
          this._shCycle[ns] = cycle;
          this._shSeed[ns] = hash(cycle * 7.13 + i * 19.7);
        }
        v = this._shSeed[ns];
      } else {
        v = shape(kind, pos);
      }
      this.lfoValues[ns] = clamp01(v) * depth;
    }
  }

  value(source, features) {
    if (source.startsWith('lfo')) return this.lfoValues[source] ?? 0;
    const v = features[source];
    return typeof v === 'number' ? clamp01(v) : 0;
  }

  /** Call once per frame after params.clearMods(). */
  apply(features, dt) {
    this.updateLfos(features);
    // One macro scales the depth of every row - the fastest way to calm the
    // whole rig down without unpicking a patch.
    const reactivity = params.def('master.reactivity') ? params.get('master.reactivity') : 1;
    for (const row of this.rows) {
      if (!row.enabled) continue;
      const def = params.def(row.target);
      if (!def) continue;
      let v = applyCurve(this.value(row.source, features), row.curve);
      if (row.smooth > 0.001) {
        const prev = this._smoothed.get(row.id) ?? v;
        const k = 1 - Math.exp(-dt / (row.smooth * 0.5));
        v = prev + (v - prev) * k;
        this._smoothed.set(row.id, v);
      }
      const signal = row.bipolar ? v - 0.5 : v;
      params.addMod(row.target, signal * row.amount * reactivity * (def.max - def.min));
    }
  }

  serialize() {
    return this.rows.map(({ id, ...rest }) => rest);
  }

  restore(list) {
    this.clear();
    for (const r of list || []) {
      this.rows.push({ id: ++rowId, enabled: true, curve: 0, bipolar: false, smooth: 0.1, ...r });
    }
  }
}

export { CYCLE_LABELS, SHAPES };
