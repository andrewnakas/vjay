// VJay - bootstrap and the frame loop.

import { initGL } from './gl/context.js';
import { Renderer, letterboxRect } from './renderer.js';
import { SourceManager } from './sources/sources.js';
import { AudioEngine } from './audio/engine.js';
import { FeatureExtractor } from './audio/features.js';
import { TempoTracker } from './audio/tempo.js';
import { LyricListener } from './audio/lyrics.js';
import { Modulation } from './modulation.js';
import { Autopilot } from './autopilot.js';
import { Presets } from './presets.js';
import { Mapping } from './mapping.js';
import { Setlist } from './setlist.js';
import { Calibrator } from './calibrate.js';
import { Session } from './session.js';
import { MidiControl } from './midi.js';
import { Output } from './output.js';
import { installKeyboard } from './keyboard.js';
import { AppUI } from './ui/app-ui.js';
import { Meters } from './ui/meters.js';
import { params } from './params.js';
import { LayerStack } from './layers.js';
import { CanvasEditor } from './ui/canvas-edit.js';
import { MapEditor } from './ui/map-edit.js';
import { LOOKS, applyLook } from './looks.js';

class App {
  constructor() {
    this.canvas = document.getElementById('gl');
    this.dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.resScale = 1;
    // The projector's shape, locked so a venue calibration survives a window
    // resize: corner points are in normalized output space, so if the output
    // changes aspect, every surface silently stretches off the wall.
    this.outputAspect = Number(localStorage.getItem('vjay.aspect') ?? 16 / 9) || 0;
    // The projector's native pixel size, once we have been told about it.
    // Rendering at the panel's own resolution rather than at whatever size the
    // preview happens to be means the wall gets 1:1 pixels instead of an
    // upscale of a ~900px preview.
    this.outputSize = (() => {
      try {
        const raw = JSON.parse(localStorage.getItem('vjay.output') || 'null');
        return raw && raw.w > 0 && raw.h > 0 ? { w: raw.w | 0, h: raw.h | 0 } : null;
      } catch (_) { return null; }
    })();
    // Which frame the PREVIEW shows. The projector always shows the mapped
    // output; this only changes the laptop. Never persisted - booting into an
    // isolate view would be as confusing as booting into a test pattern.
    this.view = { mode: 'output', surface: -1 };
    // Preview zoom for the output view. Below 1 the canvas shows more than the
    // projector does, so a plane corner dragged off the edge stays visible and
    // grabbable. The projector never sees this.
    this.previewView = { zoom: 1, x: 0, y: 0 };
    this.fpsCap = 0;
    this.fps = 0;
    this.morphBeats = 0;

    this._lastFrame = 0;
    this._fpsAcc = 0;
    this._fpsCount = 0;
    this.visualTime = 0;

    this.gl = initGL(this.canvas);
    this._sizeCanvas();

    this.renderer = new Renderer(this.gl, this.renderW, this.renderH);
    this.sources = new SourceManager(this.gl, this.renderW, this.renderH);
    this.sources.app = this;
    this.layers = new LayerStack();
    this.audio = new AudioEngine();
    this.audio.ensureContext();
    this.features = new FeatureExtractor(this.audio);
    this.tempo = new TempoTracker();
    // Off until asked for: it is the one thing here that sends audio off the
    // machine, so it never starts on its own.
    this.lyrics = new LyricListener();
    this.modulation = new Modulation();
    this.autopilot = new Autopilot(this);
    params.define('lyrics', 'Lyrics', [
      { key: 'size', label: 'Text size', min: 0.03, max: 0.35, def: 0.1 },
      { key: 'y', label: 'Height', min: 0, max: 1, def: 0.5 },
      { key: 'lines', label: 'Lines', type: 'int', min: 1, max: 5, def: 2 },
      { key: 'fade', label: 'Fade when quiet', type: 'bool', def: 1 },
    ]);
    this.mapping = new Mapping(this);
    this.presets = new Presets(this);
    this.setlist = new Setlist(this);
    this.calibrator = new Calibrator(this);
    this.session = new Session(this);
    this.midi = new MidiControl(this);
    // The projector frame, kept separate from the preview canvas. `#gl` is what
    // you look at; this is what the room looks at, and it is what the pop-out
    // window and the recorder read.
    this.projCanvas = document.createElement('canvas');
    this.projCanvas.width = this.canvas.width;
    this.projCanvas.height = this.canvas.height;
    // NOT desynchronized: this canvas is never in the DOM, so the low-latency
    // path buys nothing, and it is the surface `captureStream` reads for both
    // the pop-out and the recorder - which that path is known to upset.
    this.projCtx = this.projCanvas.getContext('2d', { alpha: false });
    this.output = new Output(this.projCanvas, this.audio);
    this.meters = new Meters(document.getElementById('meters'));

    this.globals = {
      uTime: 0, uRes: [1, 1], uBpm: 120,
      uBeatPhase: 0, uBarPhase: 0, uPhrasePhase: 0, uBeatPulse: 0,
      uBass: 0, uLowMid: 0, uMid: 0, uHigh: 0, uAir: 0,
      uLevel: 0, uFlux: 0, uCentroid: 0,
      uKick: 0, uSnare: 0, uHat: 0, uVoice: 0,
      uSpectrum: this.features.spectrum,
      uWave: this.features.waveform,
      uPalette: 0,
      uSeam: 0.5,
    };
    // Shaders see a reactivity-scaled copy of the spectrum; the meters and the
    // modulation matrix keep the raw one.
    this.scaledSpectrum = new Float32Array(this.features.spectrum.length);

    this.editor = new CanvasEditor(this, this.canvas, document.getElementById('editOverlay'));
    this.mapEditor = new MapEditor(this, this.canvas, document.getElementById('editOverlay'));
    this.ui = new AppUI(this);
    this.ui.init();
    installKeyboard(this);

    this.output.onChange = () => {
      document.getElementById('btnRec').classList.toggle('on', this.output.recording);
    };
    // A GLSL error in a lazily compiled effect used to take the render loop
    // with it. Now it is bypassed and named, so the fix is one click away
    // instead of a dead projector.
    this.renderer.onEffectFailed = (id) => {
      params.setBase(`fx.${id}.enabled`, 0);
      this.toast(`Effect "${id}" would not compile — switched off`);
      this.ui?.buildFxChain?.();
    };
    window.addEventListener('resize', () => this._onResize());
    this._onResize();
    this._defaultPatch();
  }

  /**
   * Boot into the calmest curated look rather than a busy one. A first
   * impression of "everything is moving at once" makes the audio reaction
   * impossible to read; you want one or two clear responses to start from.
   */
  _defaultPatch() {
    applyLook(this, LOOKS[0]);
    this.ui.activeLook = LOOKS[0].id;
    this.ui.lookBtns?.get(LOOKS[0].id)?.classList.add('active');
  }

  _sizeCanvas() {
    const wrap = this.canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    let cssW = Math.max(2, rect.width);
    let cssH = Math.max(2, rect.height);
    if (this.outputAspect > 0) {
      // Largest box of the projector's aspect that fits the stage area.
      if (cssW / cssH > this.outputAspect) cssW = cssH * this.outputAspect;
      else cssH = cssW / this.outputAspect;
    }
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    // The GL canvas is centred by the stage grid, but the edit overlay is
    // absolutely positioned and would stay pinned to the top-left. Any gap
    // between them offsets every click from the handle it is aiming at, which
    // is exactly as broken as it sounds.
    const overlay = document.getElementById('editOverlay');
    if (overlay) {
      overlay.style.width = `${cssW}px`;
      overlay.style.height = `${cssH}px`;
      overlay.style.left = `${Math.max(0, (rect.width - cssW) / 2)}px`;
      overlay.style.top = `${Math.max(0, (rect.height - cssH) / 2)}px`;
    }
    // Render at the projector's native resolution when we know it; otherwise
    // at the preview's own size scaled by dpr.
    const w = this.outputSize
      ? this.outputSize.w
      : Math.max(2, Math.floor(cssW * this.dpr));
    const h = this.outputSize
      ? this.outputSize.h
      : Math.max(2, Math.floor(cssH * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.projCanvas && (this.projCanvas.width !== w || this.projCanvas.height !== h)) {
      this.projCanvas.width = w;
      this.projCanvas.height = h;
    }
    this.renderW = Math.max(2, Math.round(w * this.resScale));
    this.renderH = Math.max(2, Math.round(h * this.resScale));
  }

  _onResize() {
    this._sizeCanvas();
    this.renderer?.resize(this.renderW, this.renderH);
    this.sources?.resize(this.renderW, this.renderH);
  }

  /**
   * Lock the render to the projector's real pixel grid. Pass null to go back to
   * sizing from the preview.
   */
  setOutputSize(size) {
    this.outputSize = size && size.w > 0 && size.h > 0 ? { w: size.w | 0, h: size.h | 0 } : null;
    try {
      if (this.outputSize) localStorage.setItem('vjay.output', JSON.stringify(this.outputSize));
      else localStorage.removeItem('vjay.output');
    } catch (_) {}
    this._onResize();
  }

  /**
   * Show or hide the layer handles. Three things have to agree - the editor,
   * the CSS class that decides whether the overlay gets the pointer at all, and
   * the button - so they are set in one place rather than three.
   */
  setEditHandles(on) {
    this.editor.enabled = !!on;
    document.querySelector('.stage-wrap')?.classList.toggle('noedit', !on);
    document.getElementById('editToggle')?.classList.toggle('on', !!on);
  }

  /**
   * The isolate view's geometry, or null in the output view. Computed on demand
   * rather than cached once a frame: the pointer asks for it during a drag, and
   * a value one frame stale puts the handles somewhere the picture is not.
   */
  planeView() {
    const v = this.view;
    if (v.mode !== 'plane' || !this.mapping.enabled(v.surface)) return null;
    const crop = this.mapping.crop(v.surface);
    return {
      surface: v.surface,
      bus: this.mapping.feed(v.surface),
      crop,
      rect: letterboxRect(crop, this.renderer.width, this.renderer.height,
        this.canvas.width, this.canvas.height),
    };
  }

  /**
   * Zoom the preview out to see past the edges of the projector, or back in.
   * Clamped so it cannot be lost entirely.
   */
  setPreviewZoom(zoom, { x = this.previewView.x, y = this.previewView.y } = {}) {
    const z = Math.max(0.25, Math.min(4, zoom));
    const room = Math.max(0, (1 / z - 1) * 0.75);
    this.previewView = {
      zoom: z,
      x: Math.max(-room, Math.min(room, x)),
      y: Math.max(-room, Math.min(room, y)),
    };
    return this.previewView;
  }

  /** Isolate one plane in the preview, or go back to the mapped output. */
  setView(mode, surface = -1) {
    if (mode === 'plane' && (surface < 0 || !this.mapping.enabled(surface))) return false;
    const wasPlane = this.view.mode === 'plane';
    this.view = { mode, surface: mode === 'plane' ? surface : -1 };
    if (mode === 'plane') {
      // Corner dragging and comping want the same pointer; comping wins here.
      // The Picture tool is left alone - moving what is inside a plane is
      // exactly what you come to this view to do.
      if (this.mapEditor.tool !== 'picture') this.mapEditor.setEnabled(false);
      this.mapping.selected = surface;
      // A comp view exists to drag layers in, so the handles come on with it.
      // Without this the overlay keeps `pointer-events: none` and the view
      // looks right while ignoring every drag - which is worse than not having
      // it, because nothing says why.
      if (!wasPlane) this._editHandlesBefore = this.editor.enabled;
      this.setEditHandles(true);
    } else if (wasPlane) {
      this.setEditHandles(this._editHandlesBefore !== false);
    }
    this.mapEditor.sync();
    this.ui?.viewUI?.rebuild();
    this.ui?.mapUI?.rebuild();
    this.ui?.layersUI?.rebuild();
    return true;
  }

  setOutputAspect(aspect) {
    this.outputAspect = aspect;
    try { localStorage.setItem('vjay.aspect', String(aspect)); } catch (_) {}
    this._onResize();
    // Shape-fitted planes are sized against the output's aspect, so they have
    // to be recomputed when it changes.
    this.mapping?.applyAllFits();
    this.ui.toast(aspect > 0 ? `Output locked to ${aspect.toFixed(2)}:1` : 'Output fills the window');
  }

  setResolutionScale(scale) {
    this.resScale = scale;
    this._onResize();
    this.ui.toast(`Render at ${Math.round(scale * 100)}%`);
  }

  /** Convenience for looks and launch params: layer 1 = bottom, 2 = next up... */
  setLayerSource(index, key) {
    const layer = this.layers.layers[index];
    if (!layer || !this.sources.get(key)) return;
    layer.sourceKey = key;
    layer.rename(this.sources.get(key).label);
    this.layers.onChange();
  }

  /** Start up to `max` detected cameras, each on its own layer, side by side. */
  async startAllCameras(max = Infinity) {
    let list = await this.sources.listCameras();
    console.log('[vjay] cameras visible before permission:', list.length);
    // Labels and ids are hidden until permission has been granted once.
    if (!list.length || !list[0].deviceId) {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true });
      for (const t of probe.getTracks()) t.stop();
      list = await this.sources.listCameras();
      console.log('[vjay] cameras after permission:', list.map((d) => d.label));
    }
    // Best camera first, so the one that ends up in slot `cam` - the slot every
    // look and feel points at - is the good one rather than whichever the OS
    // happened to enumerate first.
    list = this.sources.rankedCameras(list);
    const started = [];
    for (const dev of list.slice(0, Math.min(list.length, max))) {
      try {
        started.push(await this.sources.startCamera(dev.deviceId));
      } catch (e) {
        console.warn('[vjay] camera failed', dev.label, e);
        this.ui.toast(`${dev.label}: ${e.message}`);
      }
    }
    if (!started.length) return started;

    for (const l of this.layers.layers) this.renderer.disposeAux(l.id);
    this.layers.clear();
    started.forEach((src, i) => {
      const layer = this.addLayer(src.key, { select: false });
      if (!layer) return;
      layer.rename(src.label);
      // Lay them out side by side rather than stacked on top of each other.
      const n = started.length;
      params.setBase(`${layer.ns}.x`, n === 1 ? 0 : -1 + (2 * i + 1) / n);
      params.setBase(`${layer.ns}.scale`, n === 1 ? 1 : 1 / n);
      params.setBase(`${layer.ns}.fit`, 1);
    });
    this.layers.select(this.layers.layers.at(-1)?.id ?? null);
    this.ui.refreshCameras();
    this.ui.buildSourceGrid();
    this.ui.toast(`Started ${started.length} camera${started.length > 1 ? 's' : ''}`);
    return started;
  }

  /**
   * Add a layer. While a plane is being comped, the new layer joins THAT
   * plane's bus rather than the wall - clicking a camera while looking at a
   * picture frame means "put the camera in the frame", and having it land on
   * the wall behind you instead is the sort of thing that wastes a rehearsal.
   */
  addLayer(key, opts) {
    const src = this.sources.get(key);
    if (!src) return null;
    const layer = this.layers.add(key, src.label, opts);
    if (layer && this.view.mode === 'plane') {
      const bus = this.mapping.feed(this.view.surface);
      if (bus > 0) params.setBase(`${layer.ns}.group`, bus);
      // Land it framed on the comp rather than wherever the defaults put it.
      // "Add this camera here" means filling the plane, and a live feed is
      // contained rather than cropped so none of the picture is thrown away.
      params.setBase(`${layer.ns}.x`, 0);
      params.setBase(`${layer.ns}.y`, 0);
      params.setBase(`${layer.ns}.scale`, 1);
      params.setBase(`${layer.ns}.stretch`, 1);
      params.setBase(`${layer.ns}.rotate`, 0);
      if (src.kind === 'webcam' || src.kind === 'screen') {
        params.setBase(`${layer.ns}.fit`, 1);
      }
    }
    return layer;
  }

  /**
   * Pin a feed into a bus, overriding or overlaying whatever the setlist put
   * there. Pins live outside cue state on purpose: you reach for one mid-song
   * because something is happening in the room, and the next cue must not
   * quietly undo it.
   *
   * @param mode 'replace' to override the comp, 'over' to sit on top of it.
   */
  pinFeed(bus, key, { mode = 'replace', opacity = 1, blend = 0 } = {}) {
    if (!key) return this.unpinFeed(bus);
    this.renderer.pins.set(bus, { key, mode, opacity, blend });
    this.ui?.viewUI?.rebuild();
    this.ui?.mapUI?.rebuild();
    return this.renderer.pins.get(bus);
  }

  unpinFeed(bus) {
    this.renderer.pins.delete(bus);
    this.ui?.viewUI?.rebuild();
    this.ui?.mapUI?.rebuild();
    return null;
  }

  pinOn(bus) { return this.renderer.pins.get(bus) || null; }

  /** Drop every pin at once. The way out when something is stuck. */
  clearPins() {
    const n = this.renderer.pins.size;
    this.renderer.pins.clear();
    this.ui?.viewUI?.rebuild();
    this.ui?.mapUI?.rebuild();
    return n;
  }

  /** Every live pin, for the UI. */
  pins() { return [...this.renderer.pins.entries()].map(([bus, p]) => ({ bus, ...p })); }

  /** The plane a new layer would land on, for anything that wants to say so. */
  compTarget() {
    if (this.view.mode !== 'plane') return null;
    return { surface: this.view.surface, name: this.mapping.name(this.view.surface),
      bus: this.mapping.feed(this.view.surface) };
  }

  tapTempo() {
    const bpm = this.tempo.tap(performance.now() / 1000);
    this.ui.toast(`Tap: ${bpm.toFixed(1)} BPM`);
    document.getElementById('bpmLock').classList.add('on');
  }

  toggleUI(on = null) {
    const left = document.querySelector('.left');
    const hide = on == null ? !left.classList.contains('hidden') : !on;
    for (const sel of ['.left', '.right', '.meters', '.topbar']) {
      document.querySelector(sel)?.classList.toggle('hidden', hide);
    }
    // Hiding every panel at once is a one-way door without this: there is no
    // menu left to un-hide from, and nothing on screen names the key.
    let back = document.getElementById('showUI');
    if (!back) {
      back = document.createElement('button');
      back.id = 'showUI';
      back.className = 'showui';
      back.textContent = '⇱ Show controls (H)';
      back.title = 'Bring the panels back';
      back.addEventListener('click', () => this.toggleUI(true));
      document.body.appendChild(back);
    }
    back.classList.toggle('hidden', !hide);
    this._onResize();
  }

  toast(msg) { this.ui.toast(msg); }

  start() {
    this._lastFrame = performance.now();
    const loop = (now) => {
      requestAnimationFrame(loop);
      const rawDt = (now - this._lastFrame) / 1000;
      if (this.fpsCap > 0 && rawDt < 1 / this.fpsCap - 0.0005) return;
      this._lastFrame = now;
      // Clamp: a background tab or a long GC pause must not jump the beat grid.
      const dt = Math.min(0.1, Math.max(1e-4, rawDt));
      this.frame(dt, now);
    };
    requestAnimationFrame(loop);
  }

  /**
   * One frame, guarded. Everything the room sees - the preview, the pop-out on
   * the projector and the recorder - is downstream of `projCtx.drawImage` at
   * the end of `_frame`, so a throw anywhere before it freezes all three on
   * their last picture while the UI carries on taking clicks. rAF is re-armed
   * before this runs, but a deterministic throw would still repeat forever.
   * Say it once, keep drawing what we can, and let the set continue.
   */
  frame(dt, now) {
    try {
      this._frame(dt, now);
    } catch (e) {
      this._frameErrors = (this._frameErrors || 0) + 1;
      // Kept, not just counted: a swallowed exception that repeats every frame
      // is otherwise invisible to anything but the console, and the console is
      // not where anyone is looking mid-set.
      this.lastFrameError = e;
      if (this._frameErrors === 1) {
        console.error('[vjay] render frame failed', e);
        this.toast(`Render error: ${e.message} — check the console`);
      }
      // Keep feeding the projector even on a bad frame: a still picture is far
      // better than a black one, and the copy itself is what the pop-out reads.
      if (this.projCtx) {
        try { this.projCtx.drawImage(this.canvas, 0, 0); } catch (_) { /* size race */ }
      }
    }
  }

  _frame(dt, now) {
    this._fpsAcc += dt;
    this._fpsCount++;
    if (this._fpsAcc >= 0.5) {
      this.fps = this._fpsCount / this._fpsAcc;
      this._fpsAcc = 0;
      this._fpsCount = 0;
    }

    const f = this.features.update(dt);
    this.tempo.update(f.onset, dt, now / 1000);
    this.tempo.writeTo(f);

    params.clearMods();
    this.modulation.apply(f, dt);
    this.presets.update(dt);
    this.autopilot.update(f);

    const g = this.globals;
    this.visualTime += dt * params.get('master.motion');
    g.uTime = this.visualTime;

    // Reactivity scales what the SHADERS see, not just the modulation matrix.
    // Generators react to audio internally (a plasma brightens on the beat all
    // on its own); without this, turning Reactivity down left that pulsing
    // untouched and the macro felt broken. At 0 the visuals go fully static.
    const react = params.get('master.reactivity');
    g.uBpm = f.bpm;
    g.uBeatPhase = f.beatPhase;
    g.uBarPhase = f.barPhase;
    g.uPhrasePhase = f.phrasePhase;
    g.uBeatPulse = f.beatPulse * react;
    g.uBass = f.bass * react; g.uLowMid = f.lowMid * react; g.uMid = f.mid * react;
    g.uHigh = f.high * react; g.uAir = f.air * react;
    g.uLevel = f.level * react; g.uFlux = f.flux * react;
    // Centroid is a position, not an amount - fade it toward neutral instead of
    // toward zero, or the palette mapping collapses to one end of the ramp.
    g.uCentroid = 0.5 + (f.centroid - 0.5) * react;
    g.uKick = f.kick * react; g.uSnare = f.snare * react; g.uHat = f.hat * react;
    g.uVoice = f.voice * react;
    if (react >= 0.999) {
      g.uSpectrum = f.spectrum;
    g.uWave = f.waveform;
    } else {
      for (let i = 0; i < f.spectrum.length; i++) this.scaledSpectrum[i] = f.spectrum[i] * react;
      g.uSpectrum = this.scaledSpectrum;
    }
    g.uWave = f.waveform;
    g.uPalette = params.get('master.palette');
    // Where the room's corner is, so the 3D generators can hang their geometry
    // on it. Without a corner pair this stays 0.5 and they read as centred.
    g.uSeam = this.mapping.mainSeam();

    // Keep the lyric texture in step with what has been heard. `paint` is a
    // no-op unless the words or the styling actually changed.
    const lyricSrc = this.sources.get('text:lyrics');
    if (lyricSrc) {
      const fresh = this.lyrics.freshness();
      lyricSrc.set(this.lyrics.line, {
        size: params.get('lyrics.size'),
        y: params.get('lyrics.y'),
        lines: params.get('lyrics.lines'),
        alpha: params.get('lyrics.fade') > 0.5 ? fresh : 1,
        colour: '#ffffff',
      });
      lyricSrc.paint();
    }

    this.sources.update(this.layers.activeSources(), g, dt);

    // The isolate view shows the plane's own pan and zoom only while they are
    // the thing being dragged; the rest of the time it stays flat for layers.
    this.renderer.planePreviewVaried = this.mapEditor.pictureLive;

    this.renderer.render(
      this.layers,
      (key) => this.sources.get(key),
      g,
      this.canvas.width,
      this.canvas.height,
      dt,
      this.mapping,
    );

    // The mapped output is on `#gl` right now. Copy it to the projector canvas
    // BEFORE the preview is allowed to become anything else - that copy is what
    // the pop-out window and the recorder are streaming.
    if (this.projCtx) {
      try { this.projCtx.drawImage(this.canvas, 0, 0); } catch (_) { /* size race on resize */ }
    }

    // Now the preview may diverge: isolating a plane redraws `#gl` with just
    // that plane's comp, flat and uncropped by the quad.
    this.previewRect = null;
    if (this.view.mode === 'output' && this.previewView.zoom !== 1) {
      // The projector already has the real frame; the preview can now show the
      // area around it.
      this.renderer.drawOutputZoomed(
        this.mapping, this.canvas.width, this.canvas.height, g, this.previewView,
      );
    }
    if (this.view.mode === 'plane' && this.mapping.enabled(this.view.surface)) {
      this.previewRect = this.renderer.drawPlanePreview(
        this.mapping, this.view.surface, this.canvas.width, this.canvas.height, g,
      );
    } else if (this.view.mode === 'plane') {
      this.view = { mode: 'output', surface: -1 };   // the plane was switched off
      this.ui?.viewUI?.rebuild();
    }

    // Who gets the shared overlay this frame.
    //
    // The Picture tool draws in a plane's own view as well, where the layer
    // handles would be measuring against a transformed picture and so must
    // stand down. Passive corners are the opposite case: they sit ON TOP of the
    // layer handles, because both are grabbable at once.
    const me = this.mapEditor;
    if (me.pictureLive || (me.enabled && me.cornersLive)) {
      me.draw();
    } else {
      this.editor.draw();
      if (me.cornersLive) me.draw(false);
    }
    this.meters.draw(f, this.tempo);
    this.ui.update(f, now);
  }
}

function boot() {
  let app;
  try {
    app = new App();
  } catch (e) {
    console.error('[vjay] failed to start', e);
    document.getElementById('boot').innerHTML =
      `<div class="boot-card"><h1>VJay</h1><p style="color:#ff6b6b">${e.message}</p>
       <p>WebGL2 is required. Try Chrome, and check that hardware acceleration is enabled.</p></div>`;
    return;
  }
  window.vjay = app; // handy from the console

  let pendingTest = false;

  /** Resume the context, and run whatever was waiting on it once it is live. */
  const resumeAudio = async () => {
    try { await app.audio.resume(); } catch (_) { return false; }
    if (app.audio.ctx?.state !== 'running') return false;
    if (pendingTest) {
      pendingTest = false;
      try { app.ui.toast(`Audio: ${await app.audio.useTestSignal()}`); }
      catch (e) { app.ui.toast(`Test signal failed: ${e.message}`); }
    }
    return true;
  };

  // Chrome will not resume an AudioContext until a user gesture arrives, and
  // until then `resume()` simply never settles - it does not reject. Anything
  // awaiting it is stranded, so the first click or keypress has to be what
  // unblocks it.
  const armAudioUnlock = () => {
    const unlock = async () => {
      if (!(await resumeAudio())) return;
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  };

  const startUp = async (withTest) => {
    document.getElementById('boot').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    app._onResize();
    app.start();
    pendingTest = !!withTest;
    // Deliberately NOT awaited. Awaiting it here stranded every launch param
    // behind a promise that never settles, so a URL opened without a click got
    // no show and no camera at all.
    resumeAudio();
    armAudioUnlock();
    setTimeout(() => {
      if (app.audio.ctx?.state !== 'running') app.ui.toast('Click anywhere to start audio');
    }, 900);
    app.ui.refreshAudioDevices();
  };

  document.getElementById('bootStart').addEventListener('click', () => startUp(false));
  document.getElementById('bootTest').addEventListener('click', () => startUp(true));

  // Launch params, handy for a projector or kiosk setup:
  //   ?test=1            skip the splash, run the synthetic 124 BPM loop
  //   ?look=camPip       start in a named look
  //   ?layers=cam,el:meter  build a stack, bottom first
  //   ?cam=1              start the webcam only - no change to the layer stack
  //   ?cams=all           start every detected camera, one layer each
  //   ?show=1             skip the splash and resume the saved show at its last cue
  //   ?load=shows/x.json  import a show file on boot (idempotent; never touches mapping)
  const q = new URLSearchParams(location.search);
  const applyQuery = () => {
    const lookId = q.get('look');
    if (lookId) {
      const look = LOOKS.find((l) => l.id === lookId);
      if (look) {
        applyLook(app, look);
        app.ui.activeLook = look.id;
        for (const [id, btn] of app.ui.lookBtns) btn.classList.toggle('active', id === look.id);
      } else {
        app.ui.toast(`No look called "${lookId}"`);
      }
    }
    // Bring back whatever cameras were live before the last reload. A camera
    // aimed at a wall is a physical setup; losing it to a refresh is not on.
    app.sources.restoreCameras()
      .then((started) => {
        if (!started.length) return;
        app.ui.refreshCameras();
        app.ui.buildSourceGrid();
        app.ui.mapUI?.rebuild();
        app.ui.toast(`Cameras restored: ${started.map((s) => s.label).join(', ')}`);
      })
      .catch(() => {});

    // ?cam=1 just brings the webcam up: permission granted, feed live, layer
    // stack untouched. `?cams=` rebuilds the stack into a camera grid, which is
    // the opposite of what you want when a show's cues own the layers.
    if (q.get('cam') === '1') {
      const alreadyLive = () => app.sources.activeCameras().length > 0;
      new Promise((r) => setTimeout(r, 700))
        .then(async () => {
          if (alreadyLive()) return null;
          // Ask for the best camera by name rather than letting the browser
          // hand back whatever it considers the default.
          const list = app.sources.rankedCameras(await app.sources.listCameras());
          return app.sources.startCamera(list[0]?.deviceId);
        })
        .then((src) => {
          if (!src) return;
          app.ui.refreshCameras();
          app.ui.buildSourceGrid();
          app.ui.toast(`Webcam ready: ${src.label}`);
        })
        .catch((e) => app.ui.toast(`Webcam failed: ${e.message}`));
    }

    const cams = q.get('cams');
    if (cams) {
      // getUserMedia needs permission, not a gesture, so this works on load -
      // the browser will prompt once and then both feeds come up together.
      app.startAllCameras(cams === 'all' ? Infinity : Number(cams) || 1)
        .then((started) => console.log('[vjay] cameras started:', started.map((s) => `${s.key}=${s.label}`)))
        .catch((e) => {
          console.error('[vjay] camera startup failed:', e && e.name, e && e.message);
          app.ui.toast(`Camera startup failed: ${e.message}`);
        });
    }

    // ?load=<url> boots straight into a show file served alongside the app.
    //
    // It is deliberately idempotent: if the same show is already loaded it is
    // left alone, so reloading a bookmarked URL mid-set cannot throw away cues
    // you have edited since. Mapping is never taken from it - surfaces are
    // venue calibration and must survive a reload.
    const loadUrl = q.get('load');
    const doLoad = loadUrl
      ? fetch(loadUrl)
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          })
          .then((data) => {
            const incoming = data?.show || data;
            const same = app.setlist.show.name === incoming?.name
              && app.setlist.songCount === (incoming?.songs?.length || 0);
            if (same) {
              app.ui.toast(`"${incoming.name}" already loaded — keeping your edits`);
            } else {
              const n = app.setlist.importData(data, { withMapping: false });
              app.ui.toast(`Loaded ${n} songs from ${loadUrl}`);
            }
            // Land on a cue either way. Skipping this on the "already loaded"
            // path left the transport reading "1/90 · Intro" over the default
            // patch - the readout and the screen disagreeing about the state.
            app.setlist.go(app.setlist.songIndex, app.setlist.cueIndex, { morph: 0 });
            app.ui.afterStateChange();
          })
          .catch((e) => app.ui.toast(`Could not load ${loadUrl}: ${e.message}`))
      : Promise.resolve();

    // Put the whole rig back: render settings, audio input, UI shape and the cue
    // that was live. Runs after the show has loaded so the position lands on a
    // cue that exists.
    doLoad
      .then(() => app.session.restore())
      .then((done) => {
        app.ui.afterStateChange();
        if (done && done.length) app.ui.toast(`Restored ${done.join(', ')}`);
        app.session.install();
        if (app.pendingTestSignal) pendingTest = true;
      })
      .catch(() => { app.session.ready = true; app.session.install(); });

    const stack = q.get('layers');
    if (stack) {
      for (const l of app.layers.layers) app.renderer.disposeAux(l.id);
      app.layers.clear();
      for (const key of stack.split(',').map((k) => k.trim()).filter(Boolean)) {
        if (!app.addLayer(key, { select: false })) app.ui.toast(`Unknown source "${key}"`);
      }
      app.layers.select(app.layers.layers.at(-1)?.id ?? null);
    }
  };
  const hasSession = (() => {
    try { return !!localStorage.getItem('vjay.session.v1'); } catch (_) { return false; }
  })();
  if (q.get('test') === '1' || q.has('look') || q.has('layers') || q.has('show')
      || q.has('resume') || q.has('load') || q.has('cams') || q.has('cam') || hasSession) {
    startUp(q.get('test') === '1').then(applyQuery);
  }
}

boot();
