// Central parameter registry.
//
// Every deck, effect and generator declares its params here. The UI panels,
// the modulation matrix, preset save/load and MIDI learn are all generated from
// these declarations, so adding an effect is a one-file change.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class ParamRegistry {
  constructor() {
    this.groups = new Map();   // ns -> { ns, label, order, params: Map<key, def> }
    this.baseValues = new Map(); // path -> number
    this.modValues = new Map();  // path -> additive offset in value units (per-frame)
    this.listeners = new Set();
    this._order = 0;
  }

  /**
   * @param ns     namespace, e.g. 'fx.rgbShift'
   * @param label  human label for the panel header
   * @param defs   [{ key, label, min, max, def, step, type, options, unit, modulatable }]
   */
  define(ns, label, defs) {
    let g = this.groups.get(ns);
    if (!g) {
      g = { ns, label, order: this._order++, params: new Map() };
      this.groups.set(ns, g);
    }
    g.label = label;
    for (const raw of defs) {
      const d = {
        key: raw.key,
        path: `${ns}.${raw.key}`,
        label: raw.label ?? raw.key,
        type: raw.type ?? 'float',
        min: raw.min ?? 0,
        max: raw.max ?? 1,
        step: raw.step ?? (raw.type === 'int' || raw.type === 'enum' ? 1 : 0.001),
        def: raw.def ?? raw.min ?? 0,
        unit: raw.unit ?? '',
        options: raw.options ?? null,
        modulatable: raw.modulatable !== false && raw.type !== 'bool' && raw.type !== 'enum',
        uniform: raw.uniform ?? `u_${raw.key}`,
      };
      if (d.type === 'bool') { d.min = 0; d.max = 1; d.step = 1; }
      if (d.type === 'enum' && d.options) { d.min = 0; d.max = d.options.length - 1; d.step = 1; }
      g.params.set(d.key, d);
      if (!this.baseValues.has(d.path)) this.baseValues.set(d.path, d.def);
    }
    return this;
  }

  def(path) {
    const i = path.lastIndexOf('.');
    const g = this.groups.get(path.slice(0, i));
    return g ? g.params.get(path.slice(i + 1)) : undefined;
  }

  /** The value the user dialled in, ignoring modulation. */
  getBase(path) {
    const v = this.baseValues.get(path);
    return v === undefined ? 0 : v;
  }

  setBase(path, value, silent = false) {
    const d = this.def(path);
    if (!d) return;
    let v = Number(value);
    if (!Number.isFinite(v)) return;
    if (d.type === 'int' || d.type === 'enum' || d.type === 'bool') v = Math.round(v);
    v = clamp(v, d.min, d.max);
    if (this.baseValues.get(path) === v) return;
    this.baseValues.set(path, v);
    if (!silent) this._emit(path, v);
  }

  /** Base + this frame's modulation, clamped to range. This is what shaders see. */
  get(path) {
    const d = this.def(path);
    const base = this.getBase(path);
    const mod = this.modValues.get(path) || 0;
    if (!d) return base + mod;
    let v = base + mod;
    if (d.type === 'int' || d.type === 'enum') v = Math.round(v);
    return clamp(v, d.min, d.max);
  }

  /** Modulation is accumulated per frame in value units, then cleared. */
  addMod(path, delta) {
    this.modValues.set(path, (this.modValues.get(path) || 0) + delta);
  }
  getMod(path) { return this.modValues.get(path) || 0; }
  clearMods() { this.modValues.clear(); }

  /** All effective values of a group as `{ u_key: value }`, ready for Shader.setAll. */
  uniforms(ns) {
    const g = this.groups.get(ns);
    const out = {};
    if (!g) return out;
    for (const d of g.params.values()) out[d.uniform] = this.get(d.path);
    return out;
  }

  /** Plain object of a group's effective values keyed by param key. */
  values(ns) {
    const g = this.groups.get(ns);
    const out = {};
    if (!g) return out;
    for (const d of g.params.values()) out[d.key] = this.get(d.path);
    return out;
  }

  /** Every param that can be a modulation destination. */
  modTargets() {
    const out = [];
    for (const g of [...this.groups.values()].sort((a, b) => a.order - b.order)) {
      for (const d of g.params.values()) {
        if (d.modulatable) out.push({ path: d.path, label: `${g.label} › ${d.label}` });
      }
    }
    return out;
  }

  orderedGroups() {
    return [...this.groups.values()].sort((a, b) => a.order - b.order);
  }

  snapshot() {
    const out = {};
    for (const [path, v] of this.baseValues) out[path] = v;
    return out;
  }

  restore(obj, silent = false) {
    for (const path in obj) this.setBase(path, obj[path], silent);
    if (silent) this._emit('*', null);
  }

  /**
   * Forget a namespace entirely - the definitions AND the stored values.
   *
   * Deleting only the group leaves its values behind in `baseValues`, where
   * they are invisible in the UI but still turn up in every snapshot. Over a
   * set that builds a new layer stack per song that is thousands of dead
   * entries in every saved cue.
   */
  dropGroup(ns) {
    this.groups.delete(ns);
    const prefix = `${ns}.`;
    for (const path of [...this.baseValues.keys()]) {
      if (path.startsWith(prefix)) this.baseValues.delete(path);
    }
    for (const path of [...this.modValues.keys()]) {
      if (path.startsWith(prefix)) this.modValues.delete(path);
    }
  }

  resetGroup(ns) {
    const g = this.groups.get(ns);
    if (!g) return;
    for (const d of g.params.values()) this.setBase(d.path, d.def);
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(path, value) { for (const fn of this.listeners) fn(path, value); }
}

export const params = new ParamRegistry();
