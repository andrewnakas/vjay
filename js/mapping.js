// Projection mapping.
//
// The render graph ends in up to eight composites ("buses"; `group` in the
// layer params). A *plane* (surface, `map.sN` in the registry) is a quad on the
// projector that shows one of them: four draggable corners, a crop into the
// bus, a soft edge and its own colour correction. Because the corners are free,
// a plane can be keystone-corrected onto a wall that the projector is not
// square to - which a layer transform cannot do, being affine.
//
// Planes are VENUE CALIBRATION, not performance state: they live in their own
// localStorage key and are deliberately excluded from cues, so recalling a cue
// mid-set can never move the picture off the wall.

import { params } from './params.js';

export const MAX_SURFACES = 8;
/** Bus names. Index 0 is the one the master chain runs on. */
export const GROUPS = ['Main', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];

const STORAGE_KEY = 'vjay.mapping.v1';

/** Corner order, counter-clockwise from bottom-left in 0..1 output space, y up. */
export const CORNER_NAMES = ['bottom-left', 'bottom-right', 'top-right', 'top-left'];
const IDENTITY_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

const DEFAULT_NAMES = ['Wall', 'Frame 1', 'Frame 2', 'Frame 3', 'Frame 4', 'Frame 5', 'Frame 6', 'Frame 7'];

// Ships with one full-frame wall plane plus two small frame insets, so a patch
// that puts its calm comp on bus A is visible before anyone has calibrated
// anything. All of it gets dragged onto the real wall at the venue.
const DEFAULTS = [
  { enabled: 1, feed: 0, rect: [0, 0, 1, 1] },
  { enabled: 1, feed: 1, rect: [0.07, 0.55, 0.26, 0.33] },
  { enabled: 1, feed: 2, rect: [0.67, 0.55, 0.26, 0.33] },
  { enabled: 0, feed: 1, rect: [0.40, 0.10, 0.20, 0.26] },
  { enabled: 0, feed: 1, rect: [0.10, 0.12, 0.18, 0.24] },
  { enabled: 0, feed: 2, rect: [0.72, 0.12, 0.18, 0.24] },
  { enabled: 0, feed: 3, rect: [0.40, 0.62, 0.20, 0.26] },
  { enabled: 0, feed: 3, rect: [0.30, 0.35, 0.40, 0.30] },
];

function surfaceParams(i) {
  const d = DEFAULTS[i];
  const [rx, ry, rw, rh] = d.rect;
  const corners = [[rx, ry], [rx + rw, ry], [rx + rw, ry + rh], [rx, ry + rh]];
  const out = [
    { key: 'enabled', label: 'On', type: 'bool', def: d.enabled },
    { key: 'feed', label: 'Shows bus', type: 'enum', options: GROUPS, def: d.feed },
    // What a plane does when its own bus is empty. Falling back to the main
    // comp is the useful default: with eight layers to go round, most planes
    // will never have a comp of their own, and a plane showing nothing is a
    // plane you cannot use. Black is for a painting you want to keep light off.
    { key: 'empty', label: 'When its bus is empty', type: 'enum',
      options: ['Show the main comp', 'Go black', 'Show nothing'], def: 0 },
    // How the comp is cropped into this plane, and what happens to that crop
    // when the plane is dragged.
    //
    // "Follow the window" is the default and the reason the planes work as a
    // set: the comp behaves like one big picture hanging behind the wall, and
    // each plane is a hole cut in front of it. Drag a plane and the piece of
    // the picture it shows changes to match, so the image stays put on the wall
    // instead of sliding about inside every shape. Several planes then read as
    // one installation rather than as several copies of the same comp.
    // Default depends on what the plane shows. A wall plane on the main bus is
    // a window onto one big picture, so it follows the window. A frame with a
    // comp of its own gets the WHOLE comp: both of the cropping modes show a
    // slice of it, which on a camera feed reads as a heavy zoom into one corner
    // of the room rather than as a picture of it.
    // Once a plane is on the wall, the only thing that should move it is a
    // deliberate unlock. A nudged trackpad during a set is otherwise
    // unrecoverable without re-aligning in front of the room.
    { key: 'locked', label: 'Locked', type: 'bool', def: 0 },
    { key: 'fit', label: 'Comp follows', type: 'enum',
      options: ['The window', 'The shape', 'Whole comp', 'Manual crop'],
      def: d.feed === 0 ? 0 : 2 },
  ];
  for (let c = 0; c < 4; c++) {
    // Corners can leave the frame: aiming a projector at a corner of a room
    // regularly wants a quad that runs off the edge of the output.
    out.push({ key: `c${c}x`, label: `${CORNER_NAMES[c]} X`, min: -0.5, max: 1.5, def: corners[c][0] });
    out.push({ key: `c${c}y`, label: `${CORNER_NAMES[c]} Y`, min: -0.5, max: 1.5, def: corners[c][1] });
  }
  out.push(
    // Variation: the same comp, made to look like its own thing on this plane.
    // Eight planes cannot each have a comp - there are only eight layers - so
    // this is what makes eight planes showing one comp read as eight views
    // rather than eight copies. All of it is a change of SAMPLING and colour in
    // the output pass, so it costs nothing per plane.
    { key: 'vHue', label: 'Hue shift', min: -0.5, max: 0.5, def: 0 },
    { key: 'vZoom', label: 'Zoom', min: 0.25, max: 4, def: 1 },
    { key: 'vPanX', label: 'Pan X', min: -1, max: 1, def: 0 },
    { key: 'vPanY', label: 'Pan Y', min: -1, max: 1, def: 0 },
    { key: 'vRot', label: 'Rotate', min: -3.1416, max: 3.1416, def: 0 },
    { key: 'vDriftX', label: 'Drift X', min: -0.1, max: 0.1, def: 0 },
    { key: 'vDriftY', label: 'Drift Y', min: -0.1, max: 0.1, def: 0 },
    { key: 'vMirrorX', label: 'Mirror X', type: 'bool', def: 0 },
    { key: 'vMirrorY', label: 'Mirror Y', type: 'bool', def: 0 },
    { key: 'cropX', label: 'Crop X', min: 0, max: 1, def: 0 },
    { key: 'cropY', label: 'Crop Y', min: 0, max: 1, def: 0 },
    { key: 'cropW', label: 'Crop width', min: 0.02, max: 1, def: 1 },
    { key: 'cropH', label: 'Crop height', min: 0.02, max: 1, def: 1 },
    { key: 'soft', label: 'Soft edge', min: 0, max: 0.25, def: 0.01 },
    // Per plane, because a painting and bare yellow plaster want different
    // answers: inverting is often right on the dark painting and wrong on the
    // wall next to it.
    { key: 'invert', label: 'Invert', min: 0, max: 1, def: 0 },
    { key: 'lift', label: 'Black lift', min: 0, max: 0.6, def: 0 },
    { key: 'bright', label: 'Brightness', min: 0, max: 2, def: 1 },
    { key: 'gamma', label: 'Gamma', min: 0.3, max: 2.5, def: 1 },
    { key: 'sat', label: 'Saturation', min: 0, max: 2, def: 1 },
    // A tinted wall eats one channel. These are the compensation.
    { key: 'gainR', label: 'Red gain', min: 0, max: 2, def: 1 },
    { key: 'gainG', label: 'Green gain', min: 0, max: 2, def: 1 },
    { key: 'gainB', label: 'Blue gain', min: 0, max: 2, def: 1 },
  );
  // None of this is modulatable: an LFO wandering into a corner point would
  // walk the picture off the wall mid-song.
  return out.map((p) => ({ ...p, modulatable: false }));
}

export const COLOUR_KEYS = ['invert', 'lift', 'bright', 'gamma', 'sat', 'gainR', 'gainG', 'gainB'];
export const VARY_KEYS = ['vHue', 'vZoom', 'vPanX', 'vPanY', 'vRot', 'vDriftX', 'vDriftY', 'vMirrorX', 'vMirrorY'];
/** `empty` values, by name. */
export const EMPTY_MAIN = 0, EMPTY_BLACK = 1, EMPTY_SKIP = 2;
/** `fit` values, by name. */
export const FIT_WINDOW = 0, FIT_SHAPE = 1, FIT_WHOLE = 2, FIT_MANUAL = 3;

/** Row-major 3x3 inverse. Returns null when the matrix is singular. */
function inverse3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const s = 1 / det;
  return [
    A * s, (c * h - b * i) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, (c * d - a * f) * s,
    C * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
}

/**
 * Heckbert's unit-square -> quad projective map, row-major.
 * Corners are given counter-clockwise from the origin corner.
 */
export function squareToQuad(p) {
  const [x0, y0] = p[0];
  const [x1, y1] = p[1];
  const [x2, y2] = p[2];
  const [x3, y3] = p[3];
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    // Affine special case - a parallelogram has no vanishing point to solve for.
    return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1];
  }
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const den = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(den) < 1e-12) return null;
  const g = (sx * dy2 - sy * dx2) / den;
  const h = (dx1 * sy - dy1 * sx) / den;
  return [
    x1 - x0 + g * x1, x3 - x0 + h * x3, x0,
    y1 - y0 + g * y1, y3 - y0 + h * y3, y0,
    g, h, 1,
  ];
}

/** Row-major 3x3 -> the column-major Float32Array WebGL wants for a mat3. */
function toColumnMajor(m, out = new Float32Array(9)) {
  out[0] = m[0]; out[1] = m[3]; out[2] = m[6];
  out[3] = m[1]; out[4] = m[4]; out[5] = m[7];
  out[6] = m[2]; out[7] = m[5]; out[8] = m[8];
  return out;
}

const IDENTITY_M3 = toColumnMajor([1, 0, 0, 0, 1, 0, 0, 0, 1]);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Mapping {
  constructor(app = null) {
    this.app = app;
    this.names = [...DEFAULT_NAMES];
    this.selected = 0;
    this.lastCorner = 0;
    // Set by the corner editor while it is live; the test pattern marks the
    // active corner on the wall only then.
    this.editing = false;
    // Corner pairs: two planes that meet at a crease, inner corners linked and
    // the crop split so one image runs round the corner without stretching.
    this.pairs = [];   // [{ left, right, autoSeam }]
    this.onChange = () => {};

    params.define('map', 'Mapping', [
      { key: 'bypass', label: 'Bypass mapping', type: 'bool', def: 0, modulatable: false },
      // White is the one you actually align with: a flat panel of maximum light
      // has a hard edge you can line up against a real picture frame from
      // across the room, which a grid of thin lines does not.
      { key: 'test', label: 'Alignment', type: 'enum',
        options: ['Off', 'Grid', 'White'], def: 0, modulatable: false },
    ]);
    for (let i = 0; i < MAX_SURFACES; i++) {
      params.define(this.ns(i), `Plane ${i + 1} · ${DEFAULT_NAMES[i]}`, surfaceParams(i));
    }

    this._cache = new Array(MAX_SURFACES).fill(null);
    this._saveTimer = null;
    this._propagating = false;
    this._batch = false;
    params.onChange((path) => {
      if (path !== '*' && !path.startsWith('map.')) return;
      this._cache.fill(null);
      this._scheduleSave();
    });
    this.load();
    // Nothing was restored: the shipped default planes still need their crops
    // matched to their windows.
    for (let i = 0; i < MAX_SURFACES; i++) if (this.enabled(i)) this.applyFit(i);
  }

  ns(i) { return `map.s${i + 1}`; }
  name(i) { return this.names[i] || `Plane ${i + 1}`; }

  rename(i, name) {
    this.names[i] = name || DEFAULT_NAMES[i];
    const g = params.groups.get(this.ns(i));
    if (g) g.label = `Plane ${i + 1} · ${this.names[i]}`;
    this._scheduleSave();
    this.onChange();
  }

  get bypassed() { return params.get('map.bypass') > 0.5; }
  /** 0 off, 1 grid, 2 flat white. */
  get testMode() { return Math.round(params.get('map.test')); }
  get testPattern() { return this.testMode > 0; }

  corners(i) {
    const ns = this.ns(i);
    return [0, 1, 2, 3].map((c) => [params.get(`${ns}.c${c}x`), params.get(`${ns}.c${c}y`)]);
  }

  /**
   * Move one corner. Linked corners (the crease of a corner pair) follow, and
   * the pair's seam is re-split so the picture stays unstretched.
   */
  setCorner(i, c, x, y) {
    if (this.isLocked(i) && !this._propagating) return;
    const ns = this.ns(i);
    params.setBase(`${ns}.c${c}x`, x);
    params.setBase(`${ns}.c${c}y`, y);
    if (this._propagating) return;
    this._propagating = true;
    try {
      const touched = new Set([i]);
      for (const [s2, k] of this.linkedCorners(i, c)) {
        params.setBase(`${this.ns(s2)}.c${k}x`, x);
        params.setBase(`${this.ns(s2)}.c${k}y`, y);
        touched.add(s2);
      }
      const pair = this.pairFor(i);
      if (pair && pair.autoSeam) this.recomputeSeam(pair);
      // The crop has to move with the window, or dragging a plane slides the
      // picture around inside it instead of revealing a different part of it.
      if (!this._batch) for (const k of touched) this.applyFit(k);
    } finally {
      this._propagating = false;
    }
  }

  fitMode(i) { return Math.round(params.get(`${this.ns(i)}.fit`)); }

  isLocked(i) { return params.get(`${this.ns(i)}.locked`) > 0.5; }

  setLocked(i, on) {
    params.setBase(`${this.ns(i)}.locked`, on ? 1 : 0);
    this.onChange();
  }

  /** Every enabled plane locked? */
  get allLocked() {
    const a = this.activeSurfaces();
    return a.length > 0 && a.every((i) => this.isLocked(i));
  }

  lockAll(on = true) {
    for (const i of this.activeSurfaces()) params.setBase(`${this.ns(i)}.locked`, on ? 1 : 0);
    this.onChange();
    return this.activeSurfaces().length;
  }

  /**
   * The part of the comp that lies where this plane is: the quad's bounding box
   * in output space. With this crop the comp is effectively one big picture
   * behind the wall and the plane is a hole in front of it, so planes never
   * disagree about where anything is.
   */
  windowCrop(i) {
    const p = this.corners(i);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of p) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    // A plane may hang off the edge of the output; the comp does not extend
    // there, so clamp and keep a usable minimum.
    x0 = clamp(x0, 0, 1); y0 = clamp(y0, 0, 1);
    x1 = clamp(x1, 0, 1); y1 = clamp(y1, 0, 1);
    return [x0, y0, Math.max(x1 - x0, 0.02), Math.max(y1 - y0, 0.02)];
  }

  /** Recompute this plane's crop from its `fit` mode. */
  applyFit(i) {
    // A plane on a crease has its crop split by the seam instead; two rules
    // fighting over one crop would just flicker between them.
    const pair = this.pairFor(i);
    if (pair && pair.autoSeam) return;
    switch (this.fitMode(i)) {
      case FIT_WINDOW: this.setCrop(i, this.windowCrop(i)); break;
      case FIT_SHAPE: this._fitShape(i); break;
      case FIT_WHOLE: this.setCrop(i, [0, 0, 1, 1]); break;
      default: break;                       // manual: leave it alone
    }
  }

  /** Re-run every plane's fit, e.g. after the output aspect changes. */
  applyAllFits() {
    for (let i = 0; i < MAX_SURFACES; i++) if (this.enabled(i)) this.applyFit(i);
    this.onChange();
  }

  /** Inverse homography for surface i, as a column-major mat3. Cached. */
  homography(i) {
    let m = this._cache[i];
    if (m) return m;
    const pts = this.corners(i);
    const H = squareToQuad(pts);
    const inv = H ? inverse3(H) : null;
    if (inv) {
      // Homographies are scale-invariant, so normalize the sign such that w is
      // positive inside the quad. The output pass then drops everything past
      // the projective horizon with a single `w <= 0` test.
      const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
      const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
      const w = inv[6] * cx + inv[7] * cy + inv[8];
      if (w < 0) for (let k = 0; k < 9; k++) inv[k] = -inv[k];
    }
    // A degenerate quad (three corners dragged onto each other) must not black
    // out the projector - fall back to the full frame.
    m = inv ? toColumnMajor(inv) : IDENTITY_M3;
    this._cache[i] = m;
    return m;
  }

  enabled(i) { return params.get(`${this.ns(i)}.enabled`) > 0.5; }

  activeSurfaces() {
    const out = [];
    for (let i = 0; i < MAX_SURFACES; i++) if (this.enabled(i)) out.push(i);
    return out;
  }

  feed(i) { return Math.round(params.get(`${this.ns(i)}.feed`)); }
  /** What this plane does when its bus has nothing in it. */
  emptyMode(i) { return Math.round(params.get(`${this.ns(i)}.empty`)); }

  /** Sampling variation for the output pass. */
  variation(i) {
    const ns = this.ns(i);
    return {
      hue: params.get(`${ns}.vHue`),
      zoom: params.get(`${ns}.vZoom`),
      pan: [params.get(`${ns}.vPanX`), params.get(`${ns}.vPanY`)],
      rot: params.get(`${ns}.vRot`),
      drift: [params.get(`${ns}.vDriftX`), params.get(`${ns}.vDriftY`)],
      mirror: [params.get(`${ns}.vMirrorX`), params.get(`${ns}.vMirrorY`)],
    };
  }

  /** True when this plane is showing the comp exactly as the layers made it. */
  isPlain(i) {
    const v = this.variation(i);
    return Math.abs(v.hue) < 1e-6 && Math.abs(v.zoom - 1) < 1e-6 && Math.abs(v.rot) < 1e-6
      && Math.abs(v.pan[0]) < 1e-6 && Math.abs(v.pan[1]) < 1e-6
      && Math.abs(v.drift[0]) < 1e-6 && Math.abs(v.drift[1]) < 1e-6
      && v.mirror[0] < 0.5 && v.mirror[1] < 0.5;
  }

  crop(i) {
    const ns = this.ns(i);
    return [
      params.get(`${ns}.cropX`), params.get(`${ns}.cropY`),
      params.get(`${ns}.cropW`), params.get(`${ns}.cropH`),
    ];
  }

  setCrop(i, [x, y, w, h]) {
    const ns = this.ns(i);
    params.setBase(`${ns}.cropX`, x);
    params.setBase(`${ns}.cropY`, y);
    params.setBase(`${ns}.cropW`, w);
    params.setBase(`${ns}.cropH`, h);
  }

  /**
   * Which composites the renderer has to build this frame. Bus 0 is always in
   * the set: the master chain runs on it and the recorder reads it.
   */
  neededGroups() {
    const set = new Set([0]);
    if (this.bypassed) return set;
    for (const i of this.activeSurfaces()) set.add(this.feed(i));
    // The isolated plane's bus has to exist even when no plane shows it yet.
    const v = this.app?.view;
    if (v && v.mode === 'plane' && v.surface >= 0) set.add(this.feed(v.surface));
    return set;
  }

  /** Buses that layers are actually using, for the "nothing shows this" warning. */
  groupsInUse() {
    const set = new Set();
    for (const l of this.app?.layers?.layers || []) set.add(Math.round(params.get(`${l.ns}.group`)));
    return set;
  }

  /** Enabled planes showing bus b, in draw order. */
  planesOnBus(b) { return this.activeSurfaces().filter((i) => this.feed(i) === b); }

  /** "A · Frame 1, Frame 2" - how a bus reads everywhere a layer picks one. */
  busLabel(b) {
    const planes = this.planesOnBus(b).map((i) => this.name(i));
    return `${GROUPS[b]} · ${planes.length ? planes.join(', ') : 'no plane'}`;
  }

  /** First bus nothing shows and nothing draws into, or -1. */
  freeBus() {
    const used = this.groupsInUse();
    for (let b = 1; b < GROUPS.length; b++) {
      if (!this.planesOnBus(b).length && !used.has(b)) return b;
    }
    return -1;
  }

  /** Give plane i a bus of its own. Returns the bus, or -1 when none is free. */
  ownComp(i) {
    const b = this.freeBus();
    if (b < 0) return -1;
    params.setBase(`${this.ns(i)}.feed`, b);
    this.onChange();
    return b;
  }

  /** First surface that is switched off, or -1 when they are all in use. */
  firstFreeSurface() {
    for (let i = 0; i < MAX_SURFACES; i++) if (!this.enabled(i)) return i;
    return -1;
  }

  /**
   * "Frame 3" when two frames already exist. Numbered from the highest one in
   * use rather than from the count, so deleting Frame 2 and adding another does
   * not produce a second Frame 3.
   */
  _uniqueName(base, { numberFirst = false } = {}) {
    const taken = new Set(this.activeSurfaces().map((i) => this.name(i)));
    if (!numberFirst && !taken.has(base)) return base;
    let highest = 0;
    const re = new RegExp(`^${base}\\s+(\\d+)$`);
    for (const t of taken) {
      const m = re.exec(t);
      if (m) highest = Math.max(highest, Number(m[1]));
    }
    for (let n = Math.max(highest + 1, numberFirst ? 1 : 2); n < 99; n++) {
      if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
    }
    return base;
  }

  /** Pixel size of the projector frame, for anything that needs real aspect. */
  _pixels() {
    const c = this.app?.canvas;
    const W = c && c.width > 2 ? c.width : 1600;
    const H = c && c.height > 2 ? c.height : 900;
    return [W, H];
  }

  _edgePx(a, b) {
    const [W, H] = this._pixels();
    return Math.hypot((a[0] - b[0]) * W, (a[1] - b[1]) * H);
  }

  /** Width / height of the quad as it leaves the projector, in pixel terms. */
  physicalAspect(i) {
    const p = this.corners(i);
    const w = (this._edgePx(p[0], p[1]) + this._edgePx(p[3], p[2])) / 2;
    const h = (this._edgePx(p[0], p[3]) + this._edgePx(p[1], p[2])) / 2;
    return h > 1e-6 ? w / h : 1;
  }

  /**
   * A centred rect of the plane's own aspect, so a comp built for a landscape
   * frame is not squashed into a portrait one. Unlike the window fit this
   * ignores WHERE the plane is - every plane shows the middle of the comp.
   */
  _fitShape(i) {
    const [W, H] = this._pixels();
    const busAspect = W / H;
    const a = this.physicalAspect(i);
    let w = 1, h = 1;
    if (a >= busAspect) h = busAspect / a; else w = a / busAspect;
    w = clamp(w, 0.02, 1); h = clamp(h, 0.02, 1);
    this.setCrop(i, [(1 - w) / 2, (1 - h) / 2, w, h]);
  }

  /** Button entry point: switch this plane to the shape fit and apply it. */
  fitCrop(i) {
    params.setBase(`${this.ns(i)}.fit`, FIT_SHAPE);
    this._fitShape(i);
    this.onChange();
  }

  _claim(i, { name, feed, rect, empty = 0, fit = FIT_WINDOW }) {
    const ns = this.ns(i);
    params.setBase(`${ns}.enabled`, 1);
    params.setBase(`${ns}.feed`, feed);
    params.setBase(`${ns}.empty`, empty);
    params.setBase(`${ns}.fit`, fit);
    this.setRect(i, rect);
    this.names[i] = name;
    const g = params.groups.get(ns);
    if (g) g.label = `Plane ${i + 1} · ${name}`;
    this.selected = i;
  }

  /** A full-frame plane on Main. */
  addWall() {
    const i = this.firstFreeSurface();
    if (i < 0) return -1;
    const n = this.activeSurfaces().length;
    this._claim(i, {
      name: this._uniqueName('Wall'), feed: 0,
      // A second wall would sit exactly under the first; inset it so it is grabbable.
      rect: n ? [0.1, 0.1, 0.8, 0.8] : [0, 0, 1, 1],
    });
    this.onChange();
    return i;
  }

  /**
   * A picture frame: small, on the frames bus, black when that bus is empty so
   * the wall comp never lands on the painting. Crop fitted to its shape.
   */
  addFrame(feed = 1) {
    const i = this.firstFreeSurface();
    if (i < 0) return -1;
    const k = this.activeSurfaces().filter((s) => /^Frame/.test(this.name(s))).length;
    const w = 0.22, h = 0.30;
    const x = clamp(0.39 + (k % 3) * 0.08 - Math.floor(k / 3) * 0.2, 0, 1 - w);
    const y = clamp(0.35 + (k % 2) * 0.06, 0, 1 - h);
    // A new frame shows the main comp until it is given one of its own, so it
    // is never a dead rectangle on the wall.
    // Its own comp, shown whole: a frame is a picture, not a peephole.
    this._claim(i, {
      name: this._uniqueName('Frame', { numberFirst: true }),
      feed, rect: [x, y, w, h], fit: FIT_WHOLE,
    });
    this.onChange();
    return i;
  }

  /** Is plane i a full-frame Main wall (the default) that a corner can split? */
  _isFullWall(i) {
    if (!this.enabled(i) || this.feed(i) !== 0) return false;
    const p = this.corners(i);
    return IDENTITY_CORNERS.every((c, k) => Math.abs(p[k][0] - c[0]) < 0.02 && Math.abs(p[k][1] - c[1]) < 0.02);
  }

  /**
   * Two walls meeting at a crease at `seamU` across the projector. The inner
   * corners are linked and the crop is split at the seam. An existing
   * full-frame wall becomes the left half rather than a third plane.
   */
  addCorner(seamU = 0.5) {
    seamU = clamp(seamU, 0.1, 0.9);
    let left = this.activeSurfaces().find((i) => this._isFullWall(i));
    if (left === undefined) left = this.firstFreeSurface();
    if (left < 0) return null;
    // Claim left first so the right half lands on the next free slot.
    this._claim(left, { name: 'Wall L', feed: 0, rect: [0, 0, seamU, 1], fit: FIT_MANUAL });
    const right = this.firstFreeSurface();
    if (right < 0) { this.onChange(); return null; }
    this._claim(right, { name: 'Wall R', feed: 0, rect: [seamU, 0, 1 - seamU, 1], fit: FIT_MANUAL });
    this.pairs = this.pairs.filter((p) => p.left !== left && p.right !== left && p.left !== right && p.right !== right);
    const pair = { left, right, autoSeam: true };
    this.pairs.push(pair);
    this.recomputeSeam(pair);
    this.selected = left;
    this._scheduleSave();
    this.onChange();
    return pair;
  }

  pairFor(i) { return this.pairs.find((p) => p.left === i || p.right === i) || null; }

  /** Corners that move with (i, c): the other side of a crease. */
  linkedCorners(i, c) {
    const out = [];
    for (const p of this.pairs) {
      // left.c1 (bottom-right) <-> right.c0 (bottom-left); left.c2 <-> right.c3.
      if (p.left === i && c === 1) out.push([p.right, 0]);
      if (p.left === i && c === 2) out.push([p.right, 3]);
      if (p.right === i && c === 0) out.push([p.left, 1]);
      if (p.right === i && c === 3) out.push([p.left, 2]);
    }
    return out;
  }

  isLinked(i, c) { return this.linkedCorners(i, c).length > 0; }

  /**
   * Split the crop between the two halves by their real widths, so the
   * picture crosses the crease without a stretch on the narrower wall.
   */
  recomputeSeam(pair) {
    const wL = this.physicalAspect(pair.left) || 1;
    const wR = this.physicalAspect(pair.right) || 1;
    // Same height along the crease, so aspect ratios compare as widths.
    const s = clamp(wL / (wL + wR), 0.05, 0.95);
    const cl = this.crop(pair.left);
    const cr = this.crop(pair.right);
    this.setCrop(pair.left, [0, cl[1], s, cl[3]]);
    this.setCrop(pair.right, [s, cr[1], 1 - s, cr[3]]);
    return s;
  }

  /**
   * Where the room's corner falls in the main comp, 0..1 across, for the
   * generators that build their geometry around it. 0.5 when no corner pair is
   * showing the main bus - which reads as "assume the middle".
   */
  mainSeam() {
    for (const p of this.pairs) {
      if (this.enabled(p.left) && this.feed(p.left) === 0) return this.crop(p.left)[2];
    }
    return 0.5;
  }

  /** Where the seam sits in the picture, 0..1, or null when i is not paired. */
  seam(i) {
    const p = this.pairFor(i);
    return p ? this.crop(p.left)[2] : null;
  }

  /** Switch a plane off but keep its shape, so it can be brought back. */
  mutePlane(i, on = false) {
    params.setBase(`${this.ns(i)}.enabled`, on ? 1 : 0);
    if (on) this.applyFit(i);
    this._scheduleSave();
    this.onChange();
  }

  /**
   * Delete a plane properly: shape, crop, colour, name and any crease it was
   * part of, all back to stock so the slot is genuinely free to reuse. Muting
   * leaves a plane you have to remember about; this does not.
   */
  deletePlane(i) {
    this.pairs = this.pairs.filter((p) => p.left !== i && p.right !== i);
    params.resetGroup(this.ns(i));
    params.setBase(`${this.ns(i)}.enabled`, 0);
    this.names[i] = DEFAULT_NAMES[i];
    const g = params.groups.get(this.ns(i));
    if (g) g.label = `Plane ${i + 1} · ${this.names[i]}`;
    if (this.selected === i) {
      this.selected = this.activeSurfaces()[0] ?? 0;
    }
    this._scheduleSave();
    this.onChange();
  }

  /** Switch every plane off and start the venue again. */
  clearPlanes() {
    for (let i = 0; i < MAX_SURFACES; i++) this.deletePlane(i);
  }

  /** Back-compat: the old name for muting. */
  removePlane(i) { this.mutePlane(i, false); }

  /** Legacy: a mid-frame plane on `feed`, ready to drag. */
  addPlane(feed = 0) {
    const i = this.firstFreeSurface();
    if (i < 0) return -1;
    const step = (i % 4) * 0.05;
    this._claim(i, { name: this._uniqueName('Plane'), feed, rect: [0.22 + step, 0.25 + step, 0.4, 0.4] });
    this.onChange();
    return i;
  }

  resetSurface(i) {
    params.resetGroup(this.ns(i));
    this.pairs = this.pairs.filter((p) => p.left !== i && p.right !== i);
    this.onChange();
  }

  /** Put a surface on an axis-aligned rect: [x, y, w, h] in 0..1, y up. */
  setRect(i, [x, y, w, h]) {
    const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    this._batch = true;
    try {
      for (let c = 0; c < 4; c++) this.setCorner(i, c, pts[c][0], pts[c][1]);
    } finally {
      this._batch = false;
    }
    this.applyFit(i);
    this.onChange();
  }

  /**
   * Flip or rotate which corner is which, leaving the quad exactly where it is
   * on the wall.
   *
   * This is the fix for the commonest alignment mistake: dragging the corner
   * labelled "bottom-left" onto the TOP-left of a real picture frame. The quad
   * then covers the right area but everything inside it is upside down or
   * mirrored. A plasma wash hides it; a camera makes it obvious, which is why it
   * gets reported as "the cameras are upside down".
   *
   * Permuting the corner assignment is the honest fix - the geometry stays
   * true, only the mapping into it changes.
   */
  reorientPlane(i, how = 'flipV') {
    if (this.isLocked(i)) return false;
    const p = this.corners(i);
    // Corner order is [bottom-left, bottom-right, top-right, top-left].
    const order = how === 'flipV' ? [3, 2, 1, 0]
      : how === 'flipH' ? [1, 0, 3, 2]
      : how === 'rot180' ? [2, 3, 0, 1]
      : how === 'rotCW' ? [3, 0, 1, 2]
      : [1, 2, 3, 0];                       // rotCCW
    this._batch = true;
    try {
      for (let c = 0; c < 4; c++) this.setCorner(i, c, p[order[c]][0], p[order[c]][1]);
    } finally {
      this._batch = false;
    }
    this.applyFit(i);
    this.onChange();
    return true;
  }

  /** Nudge every corner of a surface at once. Linked corners come along. */
  moveSurface(i, dx, dy) {
    const base = this.corners(i);
    this._batch = true;
    try {
      for (let c = 0; c < 4; c++) this.setCorner(i, c, base[c][0] + dx, base[c][1] + dy);
    } finally {
      this._batch = false;
    }
    this.applyFit(i);
    for (const p of this.pairs) {
      if (p.left === i) this.applyFit(p.right);
      else if (p.right === i) this.applyFit(p.left);
    }
  }

  /**
   * Make every plane a variation on the same comp.
   *
   * The first plane is left exactly as it is - it is the reference, usually the
   * wall - and the rest are spread around it. Hue steps by the golden angle so
   * no two neighbours share a tint however many planes there are; zoom, pan and
   * rotation are kept inside what the zoom actually affords, so no plane ever
   * samples past the edge of the comp and wraps.
   *
   * @param amount 0..1, how far from the reference the set is allowed to get.
   */
  varyPlanes({ amount = 1, motion = true } = {}) {
    const list = this.activeSurfaces();
    const GOLD = 0.381966;                 // 1 - 1/phi: a well-spread sequence
    list.forEach((i, k) => {
      const ns = this.ns(i);
      if (k === 0) {                       // the reference plane stays plain
        for (const key of VARY_KEYS) params.setBase(`${ns}.${key}`, params.def(`${ns}.${key}`).def);
        return;
      }
      const g = (k * GOLD) % 1;
      const hue = g < 0.5 ? g * 2 : (g - 1) * 2;          // 0-centred, well spread
      params.setBase(`${ns}.vHue`, amount * 0.2 * hue);

      const zoom = 1 + amount * 0.22 * (k % 3);
      params.setBase(`${ns}.vZoom`, zoom);
      // How far the picture can be pushed before it runs off its own edge.
      const room = Math.max(0, (1 - 1 / zoom) / 2);
      params.setBase(`${ns}.vPanX`, room * Math.cos(k * 2.399));
      params.setBase(`${ns}.vPanY`, room * Math.sin(k * 2.399));
      params.setBase(`${ns}.vRot`, (k % 2 ? -1 : 1) * amount * 0.07 * (k % 3));
      // Mirroring every third plane breaks up a repeated shape without
      // changing the palette or the motion.
      params.setBase(`${ns}.vMirrorX`, k % 3 === 2 ? 1 : 0);
      params.setBase(`${ns}.vMirrorY`, 0);
      // A slow drift, only where there is room for it to move into.
      const d = motion ? amount * Math.min(room, 0.02) : 0;
      params.setBase(`${ns}.vDriftX`, d * Math.cos(k * 1.7));
      params.setBase(`${ns}.vDriftY`, d * Math.sin(k * 1.7));
    });
    this.onChange();
    return list.length;
  }

  /** Put every plane back to showing the comp exactly as it is. */
  resetVariation() {
    for (let i = 0; i < MAX_SURFACES; i++) {
      const ns = this.ns(i);
      for (const key of VARY_KEYS) params.setBase(`${ns}.${key}`, params.def(`${ns}.${key}`).def);
    }
    this.onChange();
  }

  /** Copy the colour trim of plane `from` to every other enabled plane. */
  copyColour(from) {
    for (const i of this.activeSurfaces()) {
      if (i === from) continue;
      for (const k of COLOUR_KEYS) params.setBase(`${this.ns(i)}.${k}`, params.getBase(`${this.ns(from)}.${k}`));
    }
  }

  /**
   * Calibration only. `map.test` and `map.bypass` are transient states you flip
   * while lining things up - persisting them means a reload mid-set can put an
   * alignment grid, or an unmapped full frame, on the wall in front of an
   * audience with no obvious cause.
   */
  serialize() {
    const values = {};
    for (const g of params.orderedGroups()) {
      if (g.ns !== 'map' && !g.ns.startsWith('map.')) continue;
      for (const d of g.params.values()) {
        if (d.path === 'map.test' || d.path === 'map.bypass') continue;
        values[d.path] = params.getBase(d.path);
      }
    }
    return {
      version: 2,
      names: [...this.names],
      pairs: this.pairs.map((p) => ({ left: p.left, right: p.right, autoSeam: !!p.autoSeam })),
      values,
    };
  }

  restore(data) {
    if (!data) return;
    if (Array.isArray(data.names)) {
      data.names.forEach((n, i) => { if (i < MAX_SURFACES && n) this.names[i] = n; });
      for (let i = 0; i < MAX_SURFACES; i++) {
        const g = params.groups.get(this.ns(i));
        if (g) g.label = `Plane ${i + 1} · ${this.names[i]}`;
      }
    }
    for (const path in data.values || {}) {
      if (path === 'map.test' || path === 'map.bypass') continue;
      if (path.startsWith('map.')) params.setBase(path, data.values[path]);
    }
    // Version 1 files have no pairs; that is simply "no creases".
    const ok = (i) => Number.isInteger(i) && i >= 0 && i < MAX_SURFACES;
    this.pairs = (Array.isArray(data.pairs) ? data.pairs : [])
      .filter((p) => p && ok(p.left) && ok(p.right) && p.left !== p.right)
      .map((p) => ({ left: p.left, right: p.right, autoSeam: p.autoSeam !== false }));
    this._cache.fill(null);
    // A venue file written before the crop followed the window, or one whose
    // planes were dragged elsewhere, is brought into line here rather than
    // waiting for the next corner drag.
    for (let i = 0; i < MAX_SURFACES; i++) if (this.enabled(i)) this.applyFit(i);
    this.onChange();
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), 400);
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.serialize()));
    } catch (e) {
      console.warn('[mapping] could not save', e);
    }
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.restore(JSON.parse(raw));
    } catch (e) {
      console.warn('[mapping] could not read localStorage', e);
    }
  }

  exportFile() {
    const blob = new Blob([JSON.stringify(this.serialize(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vjay-venue-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async importFile(file) {
    const data = JSON.parse(await file.text());
    if (!data || !data.values) throw new Error('Not a VJay venue file');
    this.restore(data);
    this.save();
  }
}

export { IDENTITY_M3, IDENTITY_CORNERS, inverse3, toColumnMajor };
