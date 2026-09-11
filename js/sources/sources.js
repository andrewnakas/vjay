// Visual sources: webcam, screen/window capture, dropped images & video, and
// GLSL generators. They all expose the same shape - { texture, aspect, ready } -
// so the decks do not care where pixels come from.

import { Shader, FBO, PingPong, createTexture } from '../gl/context.js';
import { header } from '../shaders/common.js';
import { GENERATORS, GENERATOR_BY_ID } from '../shaders/generators.js';
import { ELEMENTS } from '../shaders/elements.js';
import { params } from '../params.js';

let uid = 0;

export const MAX_CAMERAS = 4;

const CAMERA_KEY = 'vjay.cameras.v1';

class BaseSource {
  constructor(key, label, kind) {
    this.key = key;
    this.label = label;
    this.kind = kind;
    this.texture = null;
    this.aspect = 16 / 9;
    this.ready = false;
    this.error = null;
  }
  update() {}
  dispose() {}
}

/**
 * Where the hidden <video> elements live. They have to be IN the document:
 * Chrome treats a detached media element as fair game for suspension, and a
 * suspended capture element never comes back on its own - it just keeps
 * handing back its last frame, which reads as the app freezing.
 */
function videoHost() {
  let host = document.getElementById('vjayVideoHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'vjayVideoHost';
    host.style.cssText = 'position:fixed;left:-4px;top:-4px;width:1px;height:1px;'
      + 'overflow:hidden;opacity:0;pointer-events:none;z-index:-1';
    document.body.appendChild(host);
  }
  return host;
}

/** How long without a new frame before a live-looking feed is called stalled. */
const STALL_AFTER_MS = 1500;

/** Anything backed by an HTMLVideoElement: webcam, display capture, video file. */
export class VideoSource extends BaseSource {
  constructor(gl, key, label, kind) {
    super(key, label, kind);
    this.gl = gl;
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    videoHost().appendChild(this.video);
    this.stream = null;
    this.texture = createTexture(gl);
    this._lastTime = -1;
    this.lastFrameAt = 0;       // when a NEW frame last arrived
    this.stall = null;          // { kind, since } once it has been frameless a while
    this.recoveries = 0;        // times the element was found paused and restarted
    // A media element that gets suspended stays suspended: nothing re-plays it.
    // Autoplay does not fire again for a srcObject that is already attached.
    this.video.addEventListener('pause', () => {
      if (!this.ready) return;
      this.recoveries++;
      this.video.play().catch(() => {});
    });
  }

  async attachStream(stream) {
    this.detach();
    this.stream = stream;
    this.video.srcObject = stream;
    const track = stream.getVideoTracks()[0];
    if (track) {
      this.label = track.label || this.label;
      track.addEventListener('ended', () => { this.ready = false; this.detach(); });
    }
    await this.video.play();
    this.ready = true;
    this.lastFrameAt = performance.now();
    this.stall = null;
  }

  async attachFile(file) {
    this.detach();
    this.video.srcObject = null;
    this.video.src = URL.createObjectURL(file);
    this.video.loop = true;
    await this.video.play();
    this.ready = true;
    this.lastFrameAt = performance.now();
    this.stall = null;
  }

  detach() {
    if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); this.stream = null; }
    this.video.srcObject = null;
    if (this.video.src) { URL.revokeObjectURL(this.video.src); this.video.removeAttribute('src'); }
    this.video.load?.();
    this.ready = false;
    this.stall = null;
    this._lastTime = -1;
  }

  update() {
    const v = this.video;
    if (!this.ready || v.readyState < 2 || v.videoWidth === 0) return;
    if (v.currentTime === this._lastTime) return; // no new frame, skip the upload
    this._lastTime = v.currentTime;
    this.lastFrameAt = performance.now();
    this.stall = null;
    const gl = this.gl;
    this.aspect = v.videoWidth / v.videoHeight;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /**
   * Why this feed has stopped moving. A frozen picture looks identical whoever
   * caused it, and the three causes want three different responses - so name
   * which one it is rather than leaving the user to guess.
   *
   * @returns null while frames are arriving, else { kind, for, message }.
   */
  checkStall(now = performance.now()) {
    if (!this.ready || !this.video.srcObject) { this.stall = null; return null; }
    const idle = now - this.lastFrameAt;
    if (idle < STALL_AFTER_MS) { this.stall = null; return null; }

    const track = this.stream?.getVideoTracks?.()[0] || null;
    let kind; let message;
    if (this.video.paused) {
      // The `pause` listener has already asked it to resume; say so if it has
      // not taken yet.
      kind = 'paused';
      message = 'the video element was suspended — restarting it';
    } else if (!track || track.readyState !== 'live') {
      kind = 'ended';
      message = 'the capture has stopped — start it again';
    } else if (track.muted) {
      kind = 'muted';
      message = 'the source stopped sending frames';
    } else {
      // Live, unmuted, playing - and still no new frames. The surface being
      // captured is simply not repainting, which is what a window that has gone
      // behind another one does. Nothing this app can fix from in here.
      kind = 'surface';
      message = 'the captured window has stopped redrawing — capture a tab or '
        + 'the whole screen instead of a single window';
    }
    if (!this.stall || this.stall.kind !== kind) this.stall = { kind, since: this.lastFrameAt };
    return { kind, for: idle / 1000, message };
  }

  dispose() {
    this.detach();
    this.video.remove();
    this.gl.deleteTexture(this.texture);
  }
}

class ImageSource extends BaseSource {
  constructor(gl, key, label, img) {
    super(key, label, 'image');
    this.gl = gl;
    this.texture = createTexture(gl);
    this.aspect = img.naturalWidth / img.naturalHeight;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.ready = true;
  }
  dispose() { this.gl.deleteTexture(this.texture); }
}

/** A generator renders its own fragment shader into an FBO once per frame. */
/**
 * Text drawn on a 2D canvas and uploaded as a texture, so words can be layered
 * and pinned like any other source. Only redraws when the text or the look
 * changes - a texture upload every frame for a line that has not moved is a
 * waste of the budget the rest of the chain needs.
 */
class TextSource extends BaseSource {
  constructor(gl, key, label, width, height) {
    super(key, label, 'text');
    this.gl = gl;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.max(2, width);
    this.canvas.height = Math.max(2, height);
    this.ctx = this.canvas.getContext('2d');
    this.texture = createTexture(gl);
    this.aspect = this.canvas.width / this.canvas.height;
    this.ready = true;
    this.text = '';
    this.style = {};
    this._sig = null;
    this.paint();
  }

  resize(width, height) {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = Math.max(2, width);
    this.canvas.height = Math.max(2, height);
    this.aspect = this.canvas.width / this.canvas.height;
    this._sig = null;
    this.paint();
  }

  set(text, style = {}) {
    this.text = text || '';
    this.style = style;
  }

  paint() {
    const st = this.style;
    const sig = `${this.text}|${JSON.stringify(st)}|${this.canvas.width}x${this.canvas.height}`;
    if (sig === this._sig) return;
    this._sig = sig;

    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const text = this.text.trim();
    if (text) {
      const size = Math.max(10, (st.size ?? 0.1) * H);
      const weight = st.weight ?? 700;
      ctx.font = `${weight} ${size}px ${st.font || 'ui-sans-serif, system-ui, sans-serif'}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Wrap to the frame rather than running off the side of the wall.
      const maxW = W * (st.width ?? 0.86);
      const words = text.split(/\s+/);
      const lines = [];
      let line = '';
      for (const w of words) {
        const next = line ? `${line} ${w}` : w;
        if (ctx.measureText(next).width > maxW && line) { lines.push(line); line = w; }
        else line = next;
      }
      if (line) lines.push(line);
      const maxLines = Math.max(1, Math.round(st.lines ?? 3));
      const shown = lines.slice(-maxLines);

      const lh = size * 1.18;
      const cx = W * (st.x ?? 0.5);
      const cy = H * (st.y ?? 0.5);
      const top = cy - ((shown.length - 1) * lh) / 2;
      const alpha = st.alpha ?? 1;

      shown.forEach((l, i) => {
        const y = top + i * lh;
        // A dark halo, because a bright word on a lit wall needs its own edge
        // to stay readable rather than dissolving into whatever is behind it.
        if ((st.outline ?? 1) > 0) {
          ctx.lineWidth = size * 0.16;
          ctx.strokeStyle = `rgba(0,0,0,${0.7 * alpha})`;
          ctx.lineJoin = 'round';
          ctx.strokeText(l, cx, y);
        }
        ctx.fillStyle = st.colour || `rgba(255,255,255,${alpha})`;
        ctx.globalAlpha = alpha;
        ctx.fillText(l, cx, y);
        ctx.globalAlpha = 1;
      });
    }

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  dispose() { this.gl.deleteTexture(this.texture); }
}

/**
 * One photo from the album, chosen by a parameter.
 *
 * Deliberately ONE source with an index rather than 34 sources: a cue stores
 * the whole layer stack, so 34 photo sources would mean the source picker and
 * every snapshot carrying them all. An index is a number in a cue, which is
 * also what makes "a different photo per song" a thing the show generator can
 * simply set.
 *
 * Images are fetched on demand and kept, so flipping through a set does not
 * re-download anything, and a photo that has not arrived yet renders as nothing
 * rather than as a black rectangle.
 */
class PhotoSource extends BaseSource {
  constructor(gl, key, label) {
    super(key, label, 'photo');
    this.gl = gl;
    this.texture = createTexture(gl);
    this.aspect = 1;
    this.ready = false;
    this.list = [];
    this.index = -1;
    this._cache = new Map();     // index -> HTMLImageElement
    this._pending = new Set();
  }

  /** @param kind 'cutout', 'scene', or null for everything usable. */
  setList(list, kind = null) {
    const all = (list || []).filter((p) => p.kind !== 'skip');
    this.kind = kind;
    this.list = kind ? all.filter((p) => p.kind === kind) : all;
    if (!this.list.length) this.list = all;      // never leave a deck empty
    this.preload();
  }

  /** Fetch every photo in this deck's pool, so switching one is instant. */
  preload() {
    this.list.forEach((p, i) => {
      if (this._cache.has(i) || this._pending.has(i)) return;
      this._pending.add(i);
      const el = new Image();
      el.decoding = 'async';
      el.onload = () => { this._pending.delete(i); this._cache.set(i, el); };
      el.onerror = () => { this._pending.delete(i); };
      el.src = `media/photos/${p.file}`;
    });
  }

  get count() { return this.list.length; }

  /** Load and upload photo `i`, wrapping so any index is valid. */
  select(i) {
    if (!this.list.length) return;
    const n = ((Math.round(i) % this.list.length) + this.list.length) % this.list.length;
    if (n === this.index && this.ready) return;
    const img = this._cache.get(n);
    if (img) {
      this.index = n;
      this._upload(img);
      return;
    }
    if (this._pending.has(n)) return;
    this._pending.add(n);
    const el = new Image();
    el.decoding = 'async';
    el.onload = () => {
      this._pending.delete(n);
      this._cache.set(n, el);
      // Only show it if it is still the one being asked for.
      if (Math.round(params.get(`${this.key}.index`)) % this.list.length === n) {
        this.index = n;
        this._upload(el);
      }
    };
    el.onerror = () => { this._pending.delete(n); };
    el.src = `media/photos/${this.list[n].file}`;
  }

  _upload(img) {
    const gl = this.gl;
    this.aspect = img.naturalWidth / Math.max(img.naturalHeight, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.ready = true;
  }

  update() {
    if (!this.list.length) return;
    this.select(params.get(`${this.key}.index`));
  }

  dispose() { this.gl.deleteTexture(this.texture); }
}

class GeneratorSource extends BaseSource {
  constructor(gl, def, width, height) {
    super(def.element ? `el:${def.id}` : `gen:${def.id}`, def.name,
      def.element ? 'element' : 'generator');
    this.gl = gl;
    this.def = def;
    this.ns = def.element ? `el.${def.id}` : `gen.${def.id}`;
    this.resScale = def.id === 'reaction' ? 0.5 : 1;

    const uniformDecl = def.params.map((p) => `uniform float u_${p.key};`).join('\n');
    const extra = `${uniformDecl}\nuniform sampler2D uPrev;\nuniform vec2 uTexel;\n`;
    this.shader = new Shader(gl, header(extra) + def.frag, `gen:${def.id}`);
    this.display = def.display ? new Shader(gl, header(extra) + def.display, `gen:${def.id}:display`) : null;

    const w = Math.max(2, Math.round(width * this.resScale));
    const h = Math.max(2, Math.round(height * this.resScale));
    this.clearAlpha = def.element ? 0 : 1;
    if (def.stateful) {
      this.pp = new PingPong(gl, w, h);
      this.pp.a.clear(0, 0, 0, this.clearAlpha);
      this.pp.b.clear(0, 0, 0, this.clearAlpha);
      this.out = this.display ? new FBO(gl, w, h) : null;
    } else {
      this.fbo = new FBO(gl, w, h);
    }
    params.define(this.ns, def.name, def.params);
    this.ready = true;
    this._localTime = 0;
  }

  resize(width, height) {
    const w = Math.max(2, Math.round(width * this.resScale));
    const h = Math.max(2, Math.round(height * this.resScale));
    if (this.pp) { this.pp.resize(w, h); this.out?.resize(w, h); }
    else this.fbo.resize(w, h);
  }

  /** Restart stateful sims (reaction-diffusion needs a reseed). */
  reset() {
    this._localTime = 0;
    if (this.pp) { this.pp.a.clear(0, 0, 0, this.clearAlpha); this.pp.b.clear(0, 0, 0, this.clearAlpha); }
  }

  update(globals, dt) {
    const gl = this.gl;
    const motion = params.def('master.motion') ? params.get('master.motion') : 1;
    this._localTime += dt * motion;
    const target = this.pp ? this.pp.write : this.fbo;
    target.bind();
    // Elements draw over transparency so they can sit on top of a camera.
    gl.clearColor(0, 0, 0, this.clearAlpha);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const s = this.shader.use();
    s.setAll(globals);
    s.set('uTime', this._localTime);
    s.set('uRes', [target.width, target.height]);
    s.set('uTexel', [1 / target.width, 1 / target.height]);
    s.setAll(params.uniforms(this.ns));
    if (this.pp) s.tex('uPrev', this.pp.read.texture);
    s.draw();

    if (this.pp) {
      this.pp.swap();
      if (this.display) {
        this.out.bind();
        const d = this.display.use();
        d.setAll(globals);
        d.set('uTime', this._localTime);
        d.set('uRes', [this.out.width, this.out.height]);
        d.set('uTexel', [1 / this.out.width, 1 / this.out.height]);
        d.setAll(params.uniforms(this.ns));
        d.tex('uPrev', this.pp.read.texture);
        d.draw();
        this.texture = this.out.texture;
      } else {
        this.texture = this.pp.read.texture;
      }
    } else {
      this.texture = this.fbo.texture;
    }
    this.aspect = target.width / target.height;
  }

  dispose() {
    this.shader.dispose();
    this.display?.dispose();
    this.pp?.dispose();
    this.out?.dispose();
    this.fbo?.dispose();
  }
}

export class SourceManager {
  constructor(gl, width, height) {
    this.gl = gl;
    this.width = width;
    this.height = height;
    this.sources = new Map();
    this.onChange = () => {};
    // Set by the app so a stalled feed can be named in a toast and a chip.
    this.app = null;
    this.onStallChange = null;

    for (const def of GENERATORS) {
      this.sources.set(`gen:${def.id}`, new GeneratorSource(gl, def, width, height));
    }
    for (const def of ELEMENTS) {
      this.sources.set(`el:${def.id}`, new GeneratorSource(gl, def, width, height));
    }
    // The photo album. Two decks so two frames can show different pictures at
    // once - one source cannot, since its index is a single parameter.
    this.photos = [];
    for (const key of ['photo', 'photo2']) {
      params.define(key, key === 'photo' ? 'Figure' : 'Scene', [
        { key: 'index', label: 'Which photo', type: 'int', min: 0, max: 199, def: 0 },
      ]);
      const src = new PhotoSource(gl, key,
        key === 'photo' ? 'Figure (cut-out)' : 'Scene photo');
      this.sources.set(key, src);
    }
    this.loadPhotos();

    // Live lyrics, as a source: layer it, or pin it over any comp.
    this.lyrics = new TextSource(gl, 'text:lyrics', 'Lyrics (live)', width, height);
    this.sources.set('text:lyrics', this.lyrics);

    this.webcam = new VideoSource(gl, 'cam', 'Webcam (not started)', 'webcam');
    this._defineCameraParams('cam', 'Camera 1');
    this.screen = new VideoSource(gl, 'screen', 'Screen (not started)', 'screen');
    this.sources.set('cam', this.webcam);
    this.sources.set('screen', this.screen);
    this.cameraSlots = Array.from({ length: MAX_CAMERAS }, (_, i) => (i === 0 ? 'cam' : `cam${i + 1}`));
    this.cameraAssignments = new Map();   // deviceId -> slot key
  }

  /**
   * Which camera was in which slot, so a reload does not lose them. Losing a
   * camera you had aimed at a wall - and having to re-aim it - is not something
   * to do mid-set because the browser refreshed.
   */
  _saveCameraSlots() {
    try {
      const out = {};
      for (const [dev, key] of this.cameraAssignments) out[key] = dev;
      localStorage.setItem(CAMERA_KEY, JSON.stringify(out));
    } catch (_) { /* private mode, or a full quota */ }
  }

  /**
   * Re-open the cameras that were live before the reload. Only does anything
   * once permission has been granted, since device ids are hidden until then.
   */
  async restoreCameras() {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(CAMERA_KEY) || '{}');
    } catch (_) { return []; }
    const keys = Object.keys(saved);
    if (!keys.length) return [];
    const list = await this.listCameras();
    const known = new Map(list.filter((d) => d.deviceId).map((d) => [d.deviceId, d]));
    const started = [];

    // Slot `cam` is the one every look and song feel points at, so the better
    // camera belongs in it. A saved layout from before that rule - or from a
    // session where the built-in webcam happened to start first - would
    // otherwise keep pinning the laptop camera to the visuals for good.
    const restoring = keys
      .map((key) => ({ key, deviceId: saved[key] }))
      .filter((e) => e.deviceId && known.has(e.deviceId));
    const best = [...restoring].sort((a, b) =>
      SourceManager.cameraRank(known.get(a.deviceId).label)
      - SourceManager.cameraRank(known.get(b.deviceId).label))[0];
    if (best && best.key !== this.cameraSlotKey(0)) {
      const primary = restoring.find((e) => e.key === this.cameraSlotKey(0));
      best.key = this.cameraSlotKey(0);
      if (primary) primary.key = keys.find((k) => saved[k] === best.deviceId) || primary.key;
    }

    for (const { key, deviceId } of restoring) {
      const index = this.cameraSlots.indexOf(key);
      if (index < 0) continue;
      try {
        started.push(await this.startCamera(deviceId, index));
      } catch (e) {
        console.warn('[vjay] could not restore camera', key, e.name);
      }
    }
    return started;
  }

  /**
   * Put a specific camera in slot `cam`, swapping out whatever is there. This
   * is the slot every camera look and song feel reads, so it decides what the
   * visuals actually see.
   */
  async useForVisuals(deviceId) {
    const current = this.get('cam');
    const displaced = current && current.ready ? current.deviceId : null;
    if (displaced === deviceId) return current;
    const wasKey = this.cameraAssignments.get(deviceId);
    if (wasKey) this.stopCamera(wasKey);
    this.stopCamera('cam');
    const src = await this.startCamera(deviceId, 0);
    if (displaced) {
      const idx = wasKey ? this.cameraSlots.indexOf(wasKey) : 1;
      try { await this.startCamera(displaced, Math.max(idx, 1)); } catch (_) {}
    }
    return src;
  }

  /** Read the album manifest and hand it to both photo decks. */
  async loadPhotos() {
    try {
      const r = await fetch('media/photos.json', { cache: 'no-store' });
      if (!r.ok) return [];
      const data = await r.json();
      this.photos = data.photos || [];
      for (const [key, kind, name] of [
        ['photo', 'cutout', 'Figure (cut-out)'],
        ['photo2', 'scene', 'Scene photo'],
      ]) {
        const src = this.sources.get(key);
        if (!src) continue;
        src.setList(this.photos, kind);
        src.label = `${name} · ${src.list.length}`;
        // Tighten the slider to the pool that actually exists, so dragging it
        // does not spend most of its travel on photos that are not there.
        const d = params.def(`${key}.index`);
        if (d) d.max = Math.max(0, src.list.length - 1);
        src.select(0);
      }
      this.onChange();
      return this.photos;
    } catch (_) {
      return [];                 // no album is a fine state; nothing depends on it
    }
  }

  get photoCount() { return this.photos.length; }

  get(key) { return this.sources.get(key); }
  list() { return [...this.sources.values()]; }
  generatorKeys() { return GENERATORS.map((g) => `gen:${g.id}`); }
  elementKeys() { return ELEMENTS.map((e) => `el:${e.id}`); }

  resize(width, height) {
    this.width = width;
    this.height = height;
    for (const s of this.sources.values()) s.resize?.(width, height);
  }

  async listCameras() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const d = await navigator.mediaDevices.enumerateDevices();
    return d.filter((x) => x.kind === 'videoinput')
      .map((x) => ({
        deviceId: x.deviceId,
        label: x.label || `Camera ${x.deviceId.slice(0, 6)}`,
        // IR / depth sensors usually say so in the label. Worth flagging because
        // they need very different colour treatment than an RGB feed.
        isInfrared: /\b(ir|infra|infrared|depth|tof|thermal)\b/i.test(x.label),
      }));
  }

  /**
   * Camera slots. `cam` is the primary (every built-in look refers to it) and
   * `cam2`, `cam3`... are created on demand, so two physical cameras - say an
   * RGB webcam and an IR camera - can run as separate layers at once.
   */
  cameraSlotKey(index) { return index === 0 ? 'cam' : `cam${index + 1}`; }

  /** Framing controls for one camera slot, shared by every use of that feed. */
  _defineCameraParams(key, label) {
    params.define(key, `${label} framing`, [
      // 1 is the whole sensor. A lens cannot go wider than it is, so this only
      // crops in - which is why the default is the fully zoomed-out end.
      { key: 'zoom', label: 'Zoom', min: 1, max: 4, def: 1 },
      { key: 'panX', label: 'Pan X', min: -1, max: 1, def: 0 },
      { key: 'panY', label: 'Pan Y', min: -1, max: 1, def: 0 },
      { key: 'mirror', label: 'Mirror', type: 'bool', def: 0 },
      // A camera mounted on top of a projector is usually upside down. Fixing
      // it here rather than per layer means every comp, pin and look that uses
      // this camera is the right way up without being told separately.
      { key: 'flip', label: 'Flip vertically', type: 'bool', def: 0 },
    ]);
  }

  ensureCameraSlot(index) {
    const key = this.cameraSlotKey(index);
    let src = this.sources.get(key);
    if (!src) {
      src = new VideoSource(this.gl, key, `Camera ${index + 1} (not started)`, 'webcam');
      this.sources.set(key, src);
      this.onChange();
    }
    return src;
  }

  /**
   * Rank cameras for the primary slot. The Logitech C922 is the better sensor
   * of the two on this rig - wider, cleaner, and 60fps - so it takes slot `cam`
   * (which every camera look and song feel points at) ahead of a built-in
   * laptop webcam, unless the user moves something else there with the star.
   */
  static cameraRank(label = '') {
    const l = String(label).toLowerCase();
    if (/c9\d\d|logitech|brio|streamcam/.test(l)) return 0;
    if (/\b(ir|infra|infrared|depth|tof|thermal)\b/.test(l)) return 3;
    if (/built.?in|integrated|hp |wide vision|facetime/.test(l)) return 2;
    return 1;
  }

  /** Cameras best-first for the primary slot. */
  rankedCameras(list) {
    return [...list].sort((a, b) =>
      SourceManager.cameraRank(a.label) - SourceManager.cameraRank(b.label));
  }

  /** Which slot a device is already using, or the first free one. */
  slotForDevice(deviceId) {
    for (const [dev, key] of this.cameraAssignments) {
      if (dev === deviceId) return this.cameraSlots.indexOf(key);
    }
    for (let i = 0; i < MAX_CAMERAS; i++) {
      const key = this.cameraSlotKey(i);
      const src = this.sources.get(key);
      if (!src || !src.ready) return i;
    }
    return -1;
  }

  async startCamera(deviceId, index = null) {
    const slot = index == null ? this.slotForDevice(deviceId) : index;
    if (slot < 0) throw new Error(`All ${MAX_CAMERAS} camera slots are in use`);
    const src = this.ensureCameraSlot(slot);
    const key = this.cameraSlotKey(slot);

    // `exact` so a specific camera is honoured rather than silently substituted;
    // without it Chrome will happily hand back the default camera twice.
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60 },
      },
      audio: false,
    });
    await src.attachStream(stream);
    const label = stream.getVideoTracks()[0]?.label || `Camera ${slot + 1}`;
    src.label = label;
    src.deviceId = deviceId || stream.getVideoTracks()[0]?.getSettings?.().deviceId || null;
    if (src.deviceId) this.cameraAssignments.set(src.deviceId, key);
    this._saveCameraSlots();
    this.onChange();
    return src;
  }

  stopCamera(key) {
    const src = this.sources.get(key);
    if (!src) return;
    src.detach();
    for (const [dev, k] of this.cameraAssignments) if (k === key) this.cameraAssignments.delete(dev);
    this._saveCameraSlots();
    const i = this.cameraSlots.indexOf(key);
    src.label = i === 0 ? 'Webcam (not started)' : `Camera ${i + 1} (not started)`;
    this.onChange();
  }

  activeCameras() {
    return this.cameraSlots
      .map((k) => this.sources.get(k))
      .filter((s) => s && s.ready);
  }

  /** Back-compat for callers that just want "a camera". */
  async startWebcam(deviceId) { return this.startCamera(deviceId, 0); }

  async startScreen() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60 } },
      audio: false,
    });
    await this.screen.attachStream(stream);
    this.screen.label = `Screen · ${stream.getVideoTracks()[0]?.label || 'capture'}`;
    this.onChange();
    return this.screen;
  }

  stopWebcam() { this.stopCamera('cam'); }
  stopScreen() { this.screen.detach(); this.screen.label = 'Screen (not started)'; this.onChange(); }

  /** Drag-and-drop images and video files become new source slots. */
  async addFile(file) {
    const key = `media:${uid++}`;
    if (file.type.startsWith('image/')) {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = URL.createObjectURL(file);
      });
      const src = new ImageSource(this.gl, key, file.name, img);
      this.sources.set(key, src);
      this.onChange();
      return src;
    }
    if (file.type.startsWith('video/')) {
      const src = new VideoSource(this.gl, key, file.name, 'video');
      await src.attachFile(file);
      this.sources.set(key, src);
      this.onChange();
      return src;
    }
    return null;
  }

  removeFile(key) {
    const s = this.sources.get(key);
    if (!s || !key.startsWith('media:')) return;
    s.dispose();
    this.sources.delete(key);
    this.onChange();
  }

  /** Only sources actually in use are updated - idle generators cost nothing. */
  update(activeKeys, globals, dt) {
    const live = new Set();
    for (const key of activeKeys) {
      const s = this.sources.get(key);
      if (!s) continue;
      if (s instanceof GeneratorSource) s.update(globals, dt);
      else { s.update(); live.add(s); }
    }
    this._sweepStalls(live);
  }

  /**
   * Twice a second, ask every camera and capture that is ON SCREEN why it has
   * stopped moving. A frozen feed is otherwise completely silent - the last
   * frame just stays on the wall - and the first thing anyone does is blame the
   * app.
   *
   * Only feeds being drawn are asked. A camera that is running but on no layer
   * is not polled at all, so its clock never advances - reporting that as a
   * freeze would be crying wolf at exactly the source that is fine.
   */
  _sweepStalls(live, now = performance.now()) {
    if (now - (this._stallCheckedAt || 0) < 500) return;
    this._stallCheckedAt = now;
    for (const src of this.sources.values()) {
      if (!(src instanceof VideoSource)) continue;
      const before = src.stall?.kind || null;
      const stall = live.has(src) ? src.checkStall(now) : (src.stall = null);
      const after = stall?.kind || null;
      if (after === before) continue;
      this.onStallChange?.(src, stall);
      // Only the transition is worth saying out loud, and only once.
      if (after && after !== 'paused') {
        this.app?.toast?.(`${src.label}: ${stall.message}`);
      }
    }
  }

  /** Live feeds that are not producing frames, for the Inputs panel. */
  stalledSources() {
    const out = [];
    for (const src of this.sources.values()) {
      if (src instanceof VideoSource && src.stall) out.push(src);
    }
    return out;
  }
}

export { GENERATOR_BY_ID };
