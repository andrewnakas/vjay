// Headless self-test. Compiles every shader in the app (effects are lazily
// compiled, so a GLSL error in a disabled effect is otherwise invisible until
// someone switches it on mid-set), then runs the audio chain against the
// synthetic 124 BPM loop and checks the analysis lands where it should.
//
//   node-free:  chrome --headless --dump-dom http://localhost:8080/selftest.html
//
// document.title ends in PASS or FAIL.

import { initGL } from './gl/context.js';
import { Renderer } from './renderer.js';
import { SourceManager } from './sources/sources.js';
import { LayerStack } from './layers.js';
import { ELEMENTS } from './shaders/elements.js';
import { AudioEngine, buildTestLoop, FFT_SIZE } from './audio/engine.js';
import { FeatureExtractor } from './audio/features.js';
import { TempoTracker } from './audio/tempo.js';
import { Modulation } from './modulation.js';
import { EFFECTS } from './shaders/effects.js';
import { GENERATORS } from './shaders/generators.js';
import { params } from './params.js';
import { Mapping, squareToQuad, inverse3 } from './mapping.js';
import { MapEditor } from './ui/map-edit.js';
import { VideoSource } from './sources/sources.js';
import { Presets } from './presets.js';
import { Setlist } from './setlist.js';
import { FEELS, buildFeel, buildSongCues, generateShow } from './show-templates.js';
import { quadToQuad, applyH, brightestCentroid, components, Calibrator, CAM_W, CAM_H } from './calibrate.js';

// The self-test shares an origin with the app, so a run must never be able to
// write over a real show, mapping or preset bank. Reads still work; writes to
// the app's own keys are dropped for the lifetime of the page.
const _setItem = Storage.prototype.setItem;
Storage.prototype.setItem = function (key, value) {
  if (typeof key === 'string' && key.startsWith('vjay.')) return;
  return _setItem.call(this, key, value);
};

const TEST_BPM = 124;
const lines = [];
let failures = 0;

const log = (s) => { lines.push(s); render(); };
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  render();
};
function render() {
  document.getElementById('report').textContent = lines.join('\n');
}

const GL_ERRORS = {};
function glErrorName(gl, code) {
  if (!GL_ERRORS.built) {
    for (const k of ['NO_ERROR', 'INVALID_ENUM', 'INVALID_VALUE', 'INVALID_OPERATION',
      'INVALID_FRAMEBUFFER_OPERATION', 'OUT_OF_MEMORY', 'CONTEXT_LOST_WEBGL']) GL_ERRORS[gl[k]] = k;
    GL_ERRORS.built = true;
  }
  return GL_ERRORS[code] || `0x${code.toString(16)}`;
}

async function run() {
  const canvas = document.getElementById('gl');
  let gl;
  try {
    gl = initGL(canvas);
    check('WebGL2 context', true, gl.floatTargets ? 'RGBA16F targets' : 'RGBA8 fallback');
  } catch (e) {
    check('WebGL2 context', false, e.message);
    return finish();
  }

  // --- shader compilation -------------------------------------------------
  let renderer;
  try {
    renderer = new Renderer(gl, 320, 180);
    check('core shaders (layer/composite/output/copy)', true);
  } catch (e) {
    check('core shaders (layer/composite/output/copy)', false, e.message);
    return finish();
  }

  let sources;
  try {
    sources = new SourceManager(gl, 320, 180);
    check(`generator shaders (${GENERATORS.length})`, true,
      GENERATORS.map((g) => g.id).join(', '));
    check(`element shaders (${ELEMENTS.length})`, true, ELEMENTS.map((e) => e.id).join(', '));
  } catch (e) {
    check('generator / element shaders', false, e.message);
  }

  let fxOk = 0;
  const fxBad = [];
  for (const def of EFFECTS) {
    try {
      if (renderer._effectShader(def.id)) fxOk++;
      else fxBad.push(`${def.id}: not found`);
    } catch (e) {
      fxBad.push(`${def.id}: ${e.message.split('\n')[0]}`);
    }
  }
  check(`effect shaders (${fxOk}/${EFFECTS.length})`, fxBad.length === 0, fxBad.join(' | '));

  // --- render every generator through every effect -------------------------
  const audio = new AudioEngine();
  audio.ensureContext();
  const features = new FeatureExtractor(audio);
  const tempo = new TempoTracker();
  const modulation = new Modulation();
  const globals = {
    uTime: 0, uRes: [320, 180], uBpm: 120,
    uBeatPhase: 0, uBarPhase: 0, uPhrasePhase: 0, uBeatPulse: 0,
    uBass: 0.5, uLowMid: 0.4, uMid: 0.5, uHigh: 0.4, uAir: 0.3,
    uLevel: 0.5, uFlux: 0.2, uCentroid: 0.5,
    uKick: 0, uSnare: 0, uHat: 0,
    uSpectrum: features.spectrum, uPalette: 0,
  };
  for (const def of EFFECTS) params.setBase(`fx.${def.id}.enabled`, 1);

  const stack = new LayerStack();
  const probe = stack.add('gen:plasma', 'probe');
  const resolve = (key) => sources.get(key);

  gl.getError(); // drain
  const genBad = [];
  const allSourceKeys = [...GENERATORS.map((g) => `gen:${g.id}`), ...ELEMENTS.map((e) => `el:${e.id}`)];
  for (const key of allSourceKeys) {
    try {
      probe.sourceKey = key;
      for (let i = 0; i < 3; i++) {
        globals.uTime += 1 / 60;
        sources.update(new Set([key]), globals, 1 / 60);
        renderer.render(stack, resolve, globals, 320, 180, 1 / 60);
      }
      const err = gl.getError();
      if (err) genBad.push(`${key}: ${glErrorName(gl, err)}`);
    } catch (e) {
      genBad.push(`${key}: ${e.message}`);
    }
  }
  check(`render all ${allSourceKeys.length} sources through the full FX chain`,
    genBad.length === 0, genBad.join(' | '));

  for (const def of EFFECTS) params.setBase(`fx.${def.id}.enabled`, 0);

  // --- a frozen camera or capture says so ----------------------------------
  //
  // A feed that has stopped delivering frames looks exactly like a feed showing
  // a still picture: the last texture just stays on the wall. The three causes
  // want three different responses, so the classification is what is tested -
  // driven through the real method against stub state, since a headless run has
  // no camera to unplug.
  {
    const call = (state, ms) => VideoSource.prototype.checkStall.call(state, state.now + ms);
    const base = (over) => ({
      now: 10_000,
      ready: true,
      lastFrameAt: 10_000,
      stall: null,
      video: { srcObject: {}, paused: false },
      stream: { getVideoTracks: () => [{ readyState: 'live', muted: false }] },
      ...over,
    });

    check('a feed delivering frames is not called stalled', call(base(), 400) === null);

    const paused = base({ video: { srcObject: {}, paused: true } });
    check('a suspended video element is reported as suspended',
      call(paused, 3000)?.kind === 'paused', call(paused, 3000)?.kind);

    const ended = base({ stream: { getVideoTracks: () => [{ readyState: 'ended', muted: false }] } });
    check('a capture that has stopped is reported as stopped',
      call(ended, 3000)?.kind === 'ended', call(ended, 3000)?.kind);

    const muted = base({ stream: { getVideoTracks: () => [{ readyState: 'live', muted: true }] } });
    check('a muted track is reported as the source going quiet',
      call(muted, 3000)?.kind === 'muted', call(muted, 3000)?.kind);

    // Live, unmuted, playing, and still no new frames: the captured surface has
    // stopped redrawing. Nothing the app can fix, so it has to be named rather
    // than blamed on the app.
    const surface = call(base(), 3000);
    check('a live capture with no new frames blames the captured surface',
      surface?.kind === 'surface' && /window/i.test(surface.message) && surface.for > 2.9,
      `${surface?.kind} after ${surface?.for?.toFixed(1)}s`);

    // A camera that is running but on no layer is never polled, so its clock
    // never advances. Reporting that as a freeze would cry wolf at the one
    // source that is definitely fine, so the sweep only asks what is on screen.
    {
      const idle = { stall: { kind: 'surface', since: 0 }, checkStall: () => { throw new Error('polled'); } };
      Object.setPrototypeOf(idle, VideoSource.prototype);
      const drawn = base({ lastFrameAt: 0 });
      Object.setPrototypeOf(drawn, VideoSource.prototype);
      drawn.label = 'drawn';
      const mgr = { sources: new Map([['a', idle], ['b', drawn]]), _stallCheckedAt: 0, app: null, onStallChange: null };
      let threw = null;
      try {
        SourceManager.prototype._sweepStalls.call(mgr, new Set([drawn]), 9_999_999);
      } catch (e) { threw = e.message; }
      check('a source that is not on screen is never polled for stalls',
        threw === null && idle.stall === null && drawn.stall?.kind === 'surface',
        threw ? `threw: ${threw}` : `idle=${idle.stall} drawn=${drawn.stall?.kind}`);
    }
  }

  // --- per-layer effect chains -------------------------------------------
  {
    const multi = new LayerStack();
    const bottom = multi.add('gen:voronoi', 'bottom');
    const top = multi.add('el:ring', 'top');
    params.setBase(`${top.ns}.blend`, 1);
    params.setBase(`${top.ns}.scale`, 0.5);
    params.setBase(`${top.ns}.x`, 0.4);
    let ok = true;
    let why = '';
    try {
      ok = top.addFx('kaleido') && bottom.addFx('rgbShift');
      if (!ok) why = 'addFx returned false';
      // Each layer's effect params must be independent instances.
      params.setBase(`${top.fxNs('kaleido')}.segments`, 9);
      if (params.def(`${bottom.ns}.fx.kaleido.segments`)) { ok = false; why = 'fx leaked across layers'; }
      gl.getError();
      for (let i = 0; i < 4; i++) {
        sources.update(multi.activeSources(), globals, 1 / 60);
        renderer.render(multi, resolve, globals, 320, 180, 1 / 60);
      }
      const err = gl.getError();
      if (err) { ok = false; why = glErrorName(gl, err); }
    } catch (e) {
      ok = false;
      why = e.message;
    }
    check('per-layer effect chains render independently', ok, why || '2 layers, separate chains');

    // A transparent element over a background must not paint a black box.
    check('layer params are namespaced per layer',
      params.get(`${top.fxNs('kaleido')}.segments`) === 9 &&
      params.def(`${bottom.fxNs('rgbShift')}.amount`) !== undefined,
      `${params.modTargets().length} total targets`);

    for (const l of multi.layers) renderer.disposeAux(l.id);
    multi.clear();
  }

  // --- depth / matte keying actually masks ---------------------------------
  //
  // A matte that excludes everything must produce a visibly darker composite
  // than one that includes everything. Without this the Kinect depth path could
  // silently no-op and still look plausible.
  {
    const mk = new LayerStack();
    const layer = mk.add('gen:plasma', 'keyed');
    layer.matteKey = 'el:solid';
    const fw = 64, fh = 36;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const px = new Uint8Array(fw * fh * 4);

    const meanLuma = () => {
      for (let i = 0; i < 3; i++) {
        sources.update(mk.activeSources(), globals, 1 / 60);
        renderer.render(mk, resolve, globals, 320, 180, 1 / 60);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, fw, fh);
      renderer.copyShader.use().tex('uTex', renderer.pp.read.texture).draw();
      gl.readPixels(0, 0, fw, fh, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let sum = 0;
      for (let i = 0; i < fw * fh; i++) sum += 0.21 * px[i * 4] + 0.72 * px[i * 4 + 1] + 0.07 * px[i * 4 + 2];
      return sum / (fw * fh);
    };

    params.setBase(`${layer.ns}.matteMode`, 0);
    const noMatte = meanLuma();
    params.setBase(`${layer.ns}.matteMode`, 1);
    params.setBase(`${layer.ns}.matteNear`, 0);
    params.setBase(`${layer.ns}.matteFar`, 1);
    params.setBase(`${layer.ns}.matteSoft`, 0.001);
    const wideOpen = meanLuma();
    params.setBase(`${layer.ns}.matteNear`, 0.995);
    params.setBase(`${layer.ns}.matteFar`, 1.0);
    const keyedOut = meanLuma();

    check('matte wide open passes the image through',
      Math.abs(wideOpen - noMatte) < Math.max(noMatte * 0.25, 4),
      `no matte ${noMatte.toFixed(1)} vs wide-open ${wideOpen.toFixed(1)}`);
    check('depth window keys the layer out',
      keyedOut < wideOpen * 0.5,
      `keyed ${keyedOut.toFixed(1)} vs open ${wideOpen.toFixed(1)}`);

    gl.deleteTexture(tex);
    gl.deleteFramebuffer(fbo);
    for (const l of mk.layers) renderer.disposeAux(l.id);
    mk.clear();
  }

  // --- orientation: what goes in comes out the same way up -----------------
  //
  // A 180-degree rotation of every source shipped once, hidden in a
  // mirrored-repeat expression that looked like a ping-pong but mapped t to 1-t
  // inside the first period. Symmetric generators hide it completely; a camera
  // makes it obvious, which is how it was found - by eye, on a wall, not here.
  // Corners of a known image, through every path that reaches the projector.
  {
    const CW2 = 256, CH2 = 256;
    const q = new Uint8Array(CW2 * CH2 * 4);
    const quad = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255]);
    const otex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, otex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, quad);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const readCorners = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, CW2, CH2, gl.RGBA, gl.UNSIGNED_BYTE, q);
      const at = (fx, fy) => {
        const x = Math.round(fx * (CW2 - 1));
        const y = Math.round(fy * (CH2 - 1));
        const i = (y * CW2 + x) * 4;
        const n = (v) => (v > 128 ? 1 : 0);
        const k = n(q[i]) * 4 + n(q[i + 1]) * 2 + n(q[i + 2]);
        return ({ 4: 'red', 2: 'green', 1: 'blue', 7: 'white', 0: 'black' })[k] || '?';
      };
      // readPixels row 0 is the BOTTOM of the canvas.
      return [at(0.25, 0.75), at(0.75, 0.75), at(0.25, 0.25), at(0.75, 0.25)].join('/');
    };

    const oSrc = { key: 'cam', kind: 'webcam', texture: otex, aspect: 1, ready: true };
    const oStack = new LayerStack();
    oStack.add('cam', 'orient');
    const oGlobals = { ...globals, uRes: [CW2, CH2] };
    const oRender = new Renderer(gl, CW2, CH2);
    const step = (m) => {
      for (let i = 0; i < 2; i++) oRender.render(oStack, () => oSrc, oGlobals, CW2, CH2, 1 / 60, m);
      return readCorners();
    };

    const unmapped = step(null);
    const oMap = new Mapping();
    for (let i = 0; i < 8; i++) params.resetGroup(oMap.ns(i));
    params.setBase('map.bypass', 0);
    params.setBase('map.test', 0);
    for (let i = 1; i < 8; i++) params.setBase(`${oMap.ns(i)}.enabled`, 0);
    params.setBase(`${oMap.ns(0)}.enabled`, 1);
    params.setBase(`${oMap.ns(0)}.soft`, 0);
    const mapped = step(oMap);
    oRender.render(oStack, () => oSrc, oGlobals, CW2, CH2, 1 / 60, oMap);
    oRender.drawPlanePreview(oMap, 0, CW2, CH2, oGlobals);
    const isolate = readCorners();
    for (const l of oStack.layers) params.setBase(`${l.ns}.visible`, 0);
    oRender.pins.set(0, { key: 'cam', mode: 'replace', opacity: 1, blend: 0 });
    const pinned = step(oMap);

    const want = 'red/green/blue/white';
    check('an unmapped frame keeps the source the right way up', unmapped === want,
      `top-left/top-right/bottom-left/bottom-right = ${unmapped}`);
    check('a mapped plane keeps the source the right way up', mapped === want, mapped);
    check('the isolate preview keeps the source the right way up', isolate === want, isolate);
    check('a pinned feed keeps the source the right way up', pinned === want, pinned);

    oRender.pins.clear();
    for (const l of oStack.layers) oRender.disposeAux(l.id);
    oStack.clear();
    for (let i = 0; i < 8; i++) params.resetGroup(oMap.ns(i));
    gl.deleteTexture(otex);
  }

  // --- projection mapping ---------------------------------------------------
  //
  // The corner-pin warp is the one thing between the render and the wall, so it
  // is checked as maths (does the homography hit the corners) AND as pixels
  // (does an identity surface change nothing, does a keystone stay inside its
  // quad, does a group land only where its surface is).
  {
    const quad = [[0.10, 0.20], [0.90, 0.05], [0.85, 0.95], [0.20, 0.80]];
    const H = squareToQuad(quad);
    const unit = [[0, 0], [1, 0], [1, 1], [0, 1]];
    let cornerErr = 0;
    unit.forEach((u, i) => {
      const w = H[6] * u[0] + H[7] * u[1] + H[8];
      const x = (H[0] * u[0] + H[1] * u[1] + H[2]) / w;
      const y = (H[3] * u[0] + H[4] * u[1] + H[5]) / w;
      cornerErr = Math.max(cornerErr, Math.abs(x - quad[i][0]), Math.abs(y - quad[i][1]));
    });
    check('homography maps the unit square onto the quad', cornerErr < 1e-6,
      `max corner error ${cornerErr.toExponential(2)}`);

    const inv = inverse3(H);
    let idErr = 0;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let k = 0; k < 3; k++) v += inv[r * 3 + k] * H[k * 3 + c];
        idErr = Math.max(idErr, Math.abs(v - (r === c ? 1 : 0)));
      }
    }
    check('homography inverse round-trips', idErr < 1e-6, `max |Hinv·H - I| = ${idErr.toExponential(2)}`);

    const CW = 320, CH = 180;
    const px = new Uint8Array(CW * CH * 4);
    const readCanvas = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, CW, CH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    };
    // Region mean in 0..1 canvas coords, y up (the same space surfaces live in).
    const regionLuma = (x0, y0, x1, y1) => {
      let sum = 0, n = 0;
      for (let y = Math.floor(y0 * CH); y < Math.floor(y1 * CH); y++) {
        for (let x = Math.floor(x0 * CW); x < Math.floor(x1 * CW); x++) {
          const i = (y * CW + x) * 4;
          sum += 0.21 * px[i] + 0.72 * px[i + 1] + 0.07 * px[i + 2];
          n++;
        }
      }
      return n ? sum / n : 0;
    };

    const mapping = new Mapping();
    for (let i = 0; i < 8; i++) params.resetGroup(mapping.ns(i));
    params.setBase('map.bypass', 0);
    params.setBase('map.test', 0);
    params.setBase(`${mapping.ns(0)}.soft`, 0);

    const ms = new LayerStack();
    const wall = ms.add('gen:plasma', 'wall');
    const draw = (m) => {
      for (let i = 0; i < 3; i++) {
        sources.update(ms.activeSources(), globals, 1 / 60);
        renderer.render(ms, resolve, globals, CW, CH, 1 / 60, m);
      }
      readCanvas();
    };

    draw(null);
    const unmapped = regionLuma(0, 0, 1, 1);
    // The default frame planes sit over buses that hold nothing; with the
    // fallback they would draw the main comp into their insets, which is a
    // different picture. Switch them off for the identity comparison.
    params.setBase(`${mapping.ns(1)}.enabled`, 0);
    params.setBase(`${mapping.ns(2)}.enabled`, 0);
    draw(mapping);
    const identity = regionLuma(0, 0, 1, 1);
    params.setBase(`${mapping.ns(1)}.enabled`, 1);
    params.setBase(`${mapping.ns(2)}.enabled`, 1);
    check('an identity surface changes nothing',
      Math.abs(identity - unmapped) < Math.max(unmapped * 0.02, 1),
      `unmapped ${unmapped.toFixed(1)} vs mapped ${identity.toFixed(1)}`);

    // Frame planes default to buses A / B, which hold nothing here. Set to
    // "show nothing" they must leave the wall completely alone.
    params.setBase(`${mapping.ns(1)}.empty`, 2);
    params.setBase(`${mapping.ns(2)}.empty`, 2);
    draw(mapping);
    const skipped = regionLuma(0, 0, 1, 1);
    check('planes told to show nothing stay out of the way',
      params.get(`${mapping.ns(1)}.enabled`) > 0.5 && Math.abs(skipped - unmapped) < Math.max(unmapped * 0.02, 1),
      `unmapped ${unmapped.toFixed(1)} vs with two empty planes ${skipped.toFixed(1)}`);

    // Keystone: everything outside the quad must be black.
    mapping.setRect(0, [0.05, 0.05, 0.45, 0.9]);
    params.setBase(`${mapping.ns(0)}.c1y`, 0.20);   // pull one corner in -> a trapezium
    params.setBase(`${mapping.ns(0)}.c2y`, 0.78);
    draw(mapping);
    const insideQuad = regionLuma(0.12, 0.35, 0.42, 0.6);
    const outsideQuad = regionLuma(0.6, 0.05, 1, 0.95);
    check('a keystoned surface stays inside its quad',
      outsideQuad < 1.5 && insideQuad > Math.max(outsideQuad * 5, 8),
      `inside ${insideQuad.toFixed(1)}, outside ${outsideQuad.toFixed(1)}`);

    // A layer in Group A must appear only where a Group A surface is.
    params.setBase(`${mapping.ns(0)}.enabled`, 0);
    params.setBase(`${mapping.ns(2)}.enabled`, 0);
    params.setBase(`${mapping.ns(1)}.feed`, 1);
    params.setBase(`${mapping.ns(1)}.soft`, 0);
    mapping.setRect(1, [0.5, 0, 0.5, 1]);
    params.setBase(`${wall.ns}.group`, 1);
    draw(mapping);
    const right = regionLuma(0.55, 0.1, 0.95, 0.9);
    const left = regionLuma(0.05, 0.1, 0.45, 0.9);
    check('a group only lights the surface that shows it',
      right > Math.max(left * 5, 8) && left < 1.5,
      `right half ${right.toFixed(1)}, left half ${left.toFixed(1)}`);

    // Bypass is the panic key: a plain full frame whatever the surfaces say.
    params.setBase(`${wall.ns}.group`, 0);
    params.setBase('map.bypass', 1);
    draw(mapping);
    const bypassed = regionLuma(0, 0, 1, 1);
    check('bypass falls back to an unmapped full frame',
      Math.abs(bypassed - unmapped) < Math.max(unmapped * 0.02, 1),
      `bypassed ${bypassed.toFixed(1)} vs unmapped ${unmapped.toFixed(1)}`);

    params.setBase('map.bypass', 0);

    // --- buses beyond the original four -------------------------------------
    //
    // Eight planes each wanting their own comp needs eight composites, and the
    // ones past index 3 are allocated lazily - a path nothing else exercises.
    for (let i = 0; i < 8; i++) params.resetGroup(mapping.ns(i));
    params.setBase(`${mapping.ns(0)}.enabled`, 0);
    params.setBase(`${mapping.ns(2)}.enabled`, 0);
    params.setBase(`${mapping.ns(1)}.feed`, 7);          // the last bus
    params.setBase(`${mapping.ns(1)}.soft`, 0);
    mapping.setRect(1, [0.5, 0, 0.5, 1]);
    mapping.setCrop(1, [0, 0, 1, 1]);
    params.setBase(`${wall.ns}.group`, 7);
    draw(mapping);
    const busRight = regionLuma(0.55, 0.1, 0.95, 0.9);
    const busLeft = regionLuma(0.05, 0.1, 0.45, 0.9);
    check('a layer on the last bus lights only the plane showing it',
      busRight > Math.max(busLeft * 5, 8) && busLeft < 1.5,
      `right ${busRight.toFixed(1)}, left ${busLeft.toFixed(1)}`);

    // --- what a plane does when its bus is empty ----------------------------
    //
    // There are eight planes and eight layers, so most planes will never have a
    // comp of their own. Falling back to the main comp is what makes them
    // usable at all; black is for a painting you want to keep light off.
    for (let i = 0; i < 8; i++) params.resetGroup(mapping.ns(i));
    params.setBase(`${wall.ns}.group`, 0);
    params.setBase(`${mapping.ns(0)}.soft`, 0);
    params.setBase(`${mapping.ns(2)}.enabled`, 0);
    params.setBase(`${mapping.ns(1)}.feed`, 3);          // a bus with nothing in it
    params.setBase(`${mapping.ns(1)}.soft`, 0);
    mapping.setRect(1, [0.55, 0.3, 0.35, 0.4]);

    params.setBase(`${mapping.ns(1)}.empty`, 1);         // go black
    draw(mapping);
    const holeIn = regionLuma(0.60, 0.35, 0.85, 0.65);
    const holeOut = regionLuma(0.05, 0.35, 0.45, 0.65);
    check('a plane set to go black blacks out its quad and leaves the wall alone',
      holeIn < 1.5 && holeOut > Math.max(holeIn * 5, 8),
      `inside ${holeIn.toFixed(1)}, wall outside ${holeOut.toFixed(1)}`);

    params.setBase(`${mapping.ns(1)}.empty`, 0);         // show the main comp
    draw(mapping);
    const fellBack = regionLuma(0.60, 0.35, 0.85, 0.65);
    check('a plane on an empty bus falls back to the main comp',
      fellBack > Math.max(holeIn * 5, 8),
      `region reads ${fellBack.toFixed(1)} falling back vs ${holeIn.toFixed(1)} black`);

    // --- variation: the same comp, made to look like its own thing ----------
    //
    // Eight planes showing one comp must not read as eight copies. Hue is the
    // clearest of the variations to measure: the same pixels, a different tint.
    const chanMean = (x0, y0, x1, y1) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = Math.floor(y0 * CH); y < Math.floor(y1 * CH); y++) {
        for (let x = Math.floor(x0 * CW); x < Math.floor(x1 * CW); x++) {
          const k = (y * CW + x) * 4;
          r += px[k]; g += px[k + 1]; b += px[k + 2]; n++;
        }
      }
      return n ? [r / n, g / n, b / n] : [0, 0, 0];
    };
    const before = chanMean(0.60, 0.35, 0.85, 0.65);
    params.setBase(`${mapping.ns(1)}.vHue`, 0.33);
    draw(mapping);
    const after = chanMean(0.60, 0.35, 0.85, 0.65);
    const hueMoved = Math.abs(before[0] - after[0]) + Math.abs(before[1] - after[1])
      + Math.abs(before[2] - after[2]);
    check('a hue shift changes a plane’s colour without blanking it',
      hueMoved > 12 && after.reduce((a2, b2) => a2 + b2, 0) > 20,
      `channel means ${before.map((v) => v.toFixed(0))} -> ${after.map((v) => v.toFixed(0))}`);
    params.setBase(`${mapping.ns(1)}.vHue`, 0);

    // Zoom must stay inside the comp rather than smearing a clamped edge.
    params.setBase(`${mapping.ns(1)}.vZoom`, 2);
    draw(mapping);
    const zoomed = regionLuma(0.60, 0.35, 0.85, 0.65);
    check('a zoomed plane still shows the comp',
      zoomed > Math.max(holeIn * 5, 8),
      `zoomed region reads ${zoomed.toFixed(1)}`);
    params.setBase(`${mapping.ns(1)}.vZoom`, 1);

    // varyPlanes spreads the set out and leaves the first plane alone.
    mapping.app = { canvas: { width: CW, height: CH }, layers: ms };
    params.setBase(`${mapping.ns(2)}.enabled`, 1);
    const nVaried = mapping.varyPlanes({ amount: 1 });
    check('varying the planes leaves the first as the reference',
      nVaried >= 3 && mapping.isPlain(0) && !mapping.isPlain(1) && !mapping.isPlain(2),
      `${nVaried} planes; first plain ${mapping.isPlain(0)}, second varied ${!mapping.isPlain(1)}`);
    const hues = mapping.activeSurfaces().map((i) => params.getBase(`${mapping.ns(i)}.vHue`));
    const distinct = new Set(hues.map((h) => h.toFixed(3))).size;
    check('varied planes each get their own tint', distinct === hues.length,
      `hues ${hues.map((h) => h.toFixed(3)).join(', ')}`);
    mapping.resetVariation();
    mapping.app = null;

    // --- moving the picture inside a plane -----------------------------------
    //
    // The Picture tool drags what a plane SHOWS without moving the plane. It
    // writes vPan rather than the crop, because applyFit rewrites the crop on
    // every corner move and a pan stored there would be silently undone.
    //
    // The check that matters is end-to-end and not a restatement of the shader
    // maths: read the actual pixels under a point, drag, and read the pixels
    // under the point the drag went to. If the picture followed the pointer
    // they are the same colour. Comparing two copies of the same formula would
    // agree even if both were wrong.
    {
      const savedCorners = mapping.corners(0);
      const savedMotion = params.getBase('master.motion');
      params.setBase('master.motion', 0);          // freeze the generator
      params.setBase(`${mapping.ns(1)}.enabled`, 0);
      params.setBase(`${mapping.ns(2)}.enabled`, 0);

      // A hard keystone, so a screen-space delta and a plane-space delta are
      // measurably different things.
      const keyed = [[0.06, 0.08], [0.90, 0.26], [0.90, 0.78], [0.06, 0.96]];
      for (let c = 0; c < 4; c++) mapping.setCorner(0, c, keyed[c][0], keyed[c][1]);

      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:360px;opacity:0';
      const overlay = document.createElement('canvas');
      overlay.width = CW; overlay.height = CH;
      overlay.style.cssText = 'position:absolute;left:0;top:0;width:640px;height:360px';
      host.appendChild(overlay);
      document.body.appendChild(host);
      const R = overlay.getBoundingClientRect();

      const stubApp = {
        mapping,
        renderer,
        view: { mode: 'output', surface: -1 },
        previewView: { zoom: 1, x: 0, y: 0 },
        editor: { enabled: false },
        planeView: () => null,
        toast: () => {},
        setPreviewZoom: (z) => ({ zoom: z, x: 0, y: 0 }),
        ui: { viewUI: { select: () => {} } },
      };
      // The tools are gated on being on the Setup tab, so the fixture has to be
      // on it. Faking the tab is also what proves the gate: without this the
      // Picture tool disarms itself the moment it is set.
      const tab = document.createElement('button');
      tab.className = 'tab active';
      tab.dataset.tab = 'map';
      document.body.appendChild(tab);

      const ed = new MapEditor(stubApp, overlay, overlay);
      // Output-space (y up, 0..1) -> a pointer event over the overlay.
      const at = (x, y) => ({ clientX: R.left + x * R.width, clientY: R.top + (1 - y) * R.height });

      // Mean colour of a small patch, in the same y-up space as regionLuma.
      const patch = (x, y) => {
        const half = 3;
        const cx = Math.round(x * CW); const cy = Math.round(y * CH);
        let r = 0; let g = 0; let b = 0; let n = 0;
        for (let j = cy - half; j <= cy + half; j++) {
          for (let i2 = cx - half; i2 <= cx + half; i2++) {
            if (i2 < 0 || j < 0 || i2 >= CW || j >= CH) continue;
            const k = (j * CW + i2) * 4;
            r += px[k]; g += px[k + 1]; b += px[k + 2]; n++;
          }
        }
        return n ? [r / n, g / n, b / n] : [0, 0, 0];
      };

      // Two points well inside the quad, a good way apart.
      const P0 = [0.34, 0.42];
      const P1 = [0.58, 0.60];

      check('corners are live on the Setup tab with no mode armed',
        ed.cornersLive && !ed.enabled && !ed.blocksPointer,
        `cornersLive=${ed.cornersLive} enabled=${ed.enabled} blocks=${ed.blocksPointer}`);

      ed.setTool('picture');
      check('the Picture tool arms in a setup context', ed.pictureLive && ed.blocksPointer);

      draw(mapping);
      const before = patch(P0[0], P0[1]);
      // The control: what P1 shows with no pan at all. The drag is only proved
      // by moving the picture much CLOSER to this than it started, so this is
      // measured rather than assumed - an absolute colour threshold would just
      // be a guess about how fast the plasma varies.
      const control = patch(P1[0], P1[1]);

      const s0 = ed._planeLocalFor(0, at(P0[0], P0[1]));
      const s1 = ed._planeLocalFor(0, at(P1[0], P1[1]));
      check('the picture tool finds plane-local coordinates under a keystone',
        !!s0 && !!s1 && s0.s.u > 0 && s0.s.u < 1 && Math.abs(s1.s.u - s0.s.u) > 0.05,
        s0 && s1 ? `s0 ${s0.s.u.toFixed(3)},${s0.s.v.toFixed(3)} -> s1 ${s1.s.u.toFixed(3)},${s1.s.v.toFixed(3)}` : 'no hit');

      const [dpx, dpy] = ed._panDelta(0, s1.s.u - s0.s.u, s1.s.v - s0.s.v);
      params.setBase(`${mapping.ns(0)}.vPanX`, dpx);
      params.setBase(`${mapping.ns(0)}.vPanY`, dpy);
      draw(mapping);
      const after = patch(P1[0], P1[1]);
      const dist = (a2, b2) => Math.abs(a2[0] - b2[0]) + Math.abs(a2[1] - b2[1]) + Math.abs(a2[2] - b2[2]);
      const drift = dist(before, after);
      const undragged = dist(before, control);
      const bright = before.reduce((a2, b2) => a2 + b2, 0);
      // Never exact: a fixed screen patch covers a different amount of picture
      // at each end of a keystone, so the two reads are of slightly different
      // magnifications of the same place.
      check('dragging a plane’s picture moves it with the pointer',
        bright > 20 && undragged > 40 && drift < undragged * 0.4,
        `rgb ${before.map((v) => v.toFixed(0))} -> ${after.map((v) => v.toFixed(0))}; `
        + `drift ${drift.toFixed(1)} vs ${undragged.toFixed(1)} undragged`);

      const cornersNow = mapping.corners(0);
      const moved = cornersNow.some((p, k) => Math.abs(p[0] - keyed[k][0]) > 1e-9
        || Math.abs(p[1] - keyed[k][1]) > 1e-9);
      check('moving the picture never moves the plane', !moved,
        moved ? `corners ${JSON.stringify(cornersNow)}` : 'all four corners unchanged');

      // Lock protects the geometry, not the picture: nailing a frame to the wall
      // is exactly when you want to place the image inside it.
      params.setBase(`${mapping.ns(0)}.locked`, 1);
      mapping.setCorner(0, 0, 0.5, 0.5);
      const lockedCorner = mapping.corners(0)[0];
      const panBefore = params.getBase(`${mapping.ns(0)}.vPanX`);
      const s2 = ed._planeLocalFor(0, at(P0[0], P0[1]));
      const [ldx] = ed._panDelta(0, s2.s.u - s1.s.u, s2.s.v - s1.s.v);
      params.setBase(`${mapping.ns(0)}.vPanX`, panBefore + ldx);
      check('a locked plane refuses its corners but still pans its picture',
        Math.abs(lockedCorner[0] - keyed[0][0]) < 1e-9
          && Math.abs(params.getBase(`${mapping.ns(0)}.vPanX`) - panBefore) > 1e-6,
        `corner ${lockedCorner[0].toFixed(3)}, pan ${panBefore.toFixed(3)} -> ${params.getBase(`${mapping.ns(0)}.vPanX`).toFixed(3)}`);
      params.setBase(`${mapping.ns(0)}.locked`, 0);
      params.setBase(`${mapping.ns(0)}.vPanX`, 0);
      params.setBase(`${mapping.ns(0)}.vPanY`, 0);

      // Grabbing a corner must move it BY the drag, not TO the cursor. Pressing
      // 10px off a handle and not moving has to leave the corner alone.
      ed.setTool('corners');
      ed.setEnabled(true);
      const c0 = mapping.corners(0)[0];
      const off = at(c0[0], c0[1]);
      const evt = (type, dx = 0) => new PointerEvent(type, {
        clientX: off.clientX + 10 + dx, clientY: off.clientY, pointerId: 1, bubbles: true,
      });
      overlay.dispatchEvent(evt('pointerdown'));
      const onPress = mapping.corners(0)[0];
      overlay.dispatchEvent(evt('pointermove', 20));
      const onDrag = mapping.corners(0)[0];
      overlay.dispatchEvent(evt('pointerup', 20));
      const expected = c0[0] + 20 / R.width;
      check('grabbing a corner moves it by the drag, not to the cursor',
        Math.abs(onPress[0] - c0[0]) < 1e-9 && Math.abs(onDrag[0] - expected) < 2e-3,
        `start ${c0[0].toFixed(4)} · on press ${onPress[0].toFixed(4)} · `
        + `after 20px ${onDrag[0].toFixed(4)} (want ${expected.toFixed(4)})`);

      // Leaving Setup has to put the Picture tool away by itself: a tool left on
      // during alignment must not still be waiting to move a picture when
      // someone clicks the preview three songs into the set.
      ed.setTool('picture');
      tab.dataset.tab = 'fx';
      ed.sync();
      check('the Picture tool disarms itself when you leave Setup',
        !ed.pictureLive && !ed.cornersLive && !ed.blocksPointer,
        `picture=${ed.pictureLive} corners=${ed.cornersLive}`);

      ed.setEnabled(false);
      tab.remove();
      host.remove();
      for (let c = 0; c < 4; c++) mapping.setCorner(0, c, savedCorners[c][0], savedCorners[c][1]);
      params.setBase(`${mapping.ns(1)}.enabled`, 1);
      params.setBase(`${mapping.ns(2)}.enabled`, 1);
      params.setBase('master.motion', savedMotion);
      mapping.resetVariation();
    }

    // --- the isolate view ----------------------------------------------------
    //
    // Comping a plane draws its bus flat into the preview. It has to actually
    // show the bus, and it has to letterbox to the plane's shape rather than
    // stretching - that stretch is the bug the whole view exists to avoid.
    for (let i = 0; i < 8; i++) params.resetGroup(mapping.ns(i));
    params.setBase(`${mapping.ns(1)}.feed`, 1);
    params.setBase(`${mapping.ns(1)}.soft`, 0);
    params.setBase(`${wall.ns}.group`, 1);
    // A tall, narrow plane: the preview must letterbox it left and right.
    mapping.setRect(1, [0.4, 0.1, 0.12, 0.8]);
    mapping.setCrop(1, [0.25, 0.25, 0.2, 0.5]);
    sources.update(ms.activeSources(), globals, 1 / 60);
    renderer.render(ms, resolve, globals, CW, CH, 1 / 60, mapping);
    const previewRect = renderer.drawPlanePreview(mapping, 1, CW, CH, globals);
    readCanvas();
    const midBand = regionLuma(
      previewRect[0] + 0.02, 0.3, previewRect[0] + previewRect[2] - 0.02, 0.7);
    const sideBand = regionLuma(0.01, 0.3, Math.max(previewRect[0] - 0.02, 0.02), 0.7);
    check('the isolate view fills its rect with the plane’s bus',
      midBand > Math.max(sideBand * 3, 8),
      `picture ${midBand.toFixed(1)}, surround ${sideBand.toFixed(1)}`);
    check('the isolate view letterboxes rather than stretching',
      previewRect[2] < 0.9 && previewRect[2] > 0.01,
      `rect width ${previewRect[2].toFixed(3)} for a ${(0.2 * CW / (0.5 * CH)).toFixed(2)}:1 crop`);

    // --- corner pairs --------------------------------------------------------
    //
    // The crease corners have to move together, and the crop has to re-split by
    // the two walls' real widths or the picture stretches on the narrower one.
    for (let i = 0; i < 8; i++) params.resetGroup(mapping.ns(i));
    mapping.pairs = [];
    mapping.app = { canvas: { width: CW, height: CH }, layers: ms };
    const pair = mapping.addCorner(0.5);
    check('a corner pair claims two planes', !!pair && pair.left !== pair.right,
      pair ? `planes ${pair.left + 1} and ${pair.right + 1}` : 'no pair built');
    if (pair) {
      // Drag the left half's bottom-right corner; the right half's bottom-left
      // is the same physical point and must follow.
      mapping.setCorner(pair.left, 1, 0.3, 0.05);
      const follow = mapping.corners(pair.right)[0];
      check('linked crease corners move together',
        Math.abs(follow[0] - 0.3) < 1e-6 && Math.abs(follow[1] - 0.05) < 1e-6,
        `right plane corner at ${follow[0].toFixed(3)}, ${follow[1].toFixed(3)}`);

      const cl = mapping.crop(pair.left);
      const cr = mapping.crop(pair.right);
      const aL = mapping.physicalAspect(pair.left);
      const aR = mapping.physicalAspect(pair.right);
      const want = aL / (aL + aR);
      check('the seam re-splits the picture by the walls’ real widths',
        Math.abs(cl[2] + cr[2] - 1) < 1e-4 && Math.abs(cr[0] - cl[2]) < 1e-4
          && Math.abs(cl[2] - want) < 0.02,
        `seam ${cl[2].toFixed(3)} vs expected ${want.toFixed(3)}`);
    }

    // --- venue files ---------------------------------------------------------
    const v2 = mapping.serialize();
    check('a venue file carries its corner pairs', (v2.pairs || []).length === 1,
      `${(v2.pairs || []).length} pair(s), version ${v2.version}`);
    // A v1 file predates pairs entirely; restoring one must simply mean "no
    // creases" rather than throwing or keeping stale links.
    mapping.restore({ version: 1, names: v2.names, values: v2.values });
    check('a version 1 venue file restores without creases', mapping.pairs.length === 0,
      `${mapping.pairs.length} pair(s) after restoring a v1 file`);

    mapping.app = null;
    mapping.pairs = [];
    for (let i = 0; i < 8; i++) params.resetGroup(mapping.ns(i));
    for (const l of ms.layers) renderer.disposeAux(l.id);
    ms.clear();
  }

  // --- optical flow actually tracks motion ---------------------------------
  //
  // Compiling is not evidence the flow field means anything. Freeze the
  // generator clock, translate the deck by a known amount per frame, and read
  // the flow buffer back: horizontal motion must produce horizontal vectors,
  // and a still image must produce almost none.
  {
    for (const def of EFFECTS) params.setBase(`fx.${def.id}.enabled`, 0);
    probe.addFx('flowDisplace');
    params.setBase(`${probe.fxNs('flowDisplace')}.mix`, 0);
    params.setBase('master.motion', 0);   // freezes generator animation
    params.setBase('master.reactivity', 0);

    const key = 'gen:voronoi';            // plenty of trackable corners
    probe.sourceKey = key;
    params.setBase(`${probe.ns}.x`, 0);
    const aux = renderer._aux(probe.id);
    const fw = aux.flow.read.width;
    const fh = aux.flow.read.height;

    const rtTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, rtTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fw, fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const rtFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, rtFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rtTex, 0);
    const px = new Uint8Array(fw * fh * 4);

    const readFlow = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, rtFbo);
      gl.viewport(0, 0, fw, fh);
      renderer.copyShader.use().tex('uTex', renderer._aux(probe.id).flow.read.texture).draw();
      gl.readPixels(0, 0, fw, fh, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let sx = 0, sy = 0, mag = 0;
      const n = fw * fh;
      for (let i = 0; i < n; i++) {
        const x = (px[i * 4] / 255 - 0.5) * 0.2;
        const y = (px[i * 4 + 1] / 255 - 0.5) * 0.2;
        sx += x; sy += y; mag += Math.hypot(x, y);
      }
      return { x: sx / n, y: sy / n, mag: mag / n };
    };

    const step = (dt = 1 / 60) => {
      sources.update(new Set([key]), globals, dt);
      renderer.render(stack, resolve, globals, 320, 180, dt);
    };

    for (let i = 0; i < 30; i++) step();      // settle on a still image
    const still = readFlow();

    let ox = 0;
    let moving = null;
    for (let i = 0; i < 18; i++) {
      ox += 0.02;
      params.setBase(`${probe.ns}.x`, ox);
      step();
      if (i === 17) moving = readFlow();
    }

    check('flow is ~zero on a still image', still.mag < 0.0015,
      `mean |flow| = ${still.mag.toFixed(5)}`);
    check('flow detects horizontal motion', moving.mag > Math.max(still.mag * 3, 0.002),
      `mean |flow| = ${moving.mag.toFixed(5)} vs ${still.mag.toFixed(5)} at rest`);
    check('flow direction matches the motion axis',
      Math.abs(moving.x) > Math.abs(moving.y) * 2,
      `mean flow = (${moving.x.toFixed(5)}, ${moving.y.toFixed(5)})`);

    gl.deleteTexture(rtTex);
    gl.deleteFramebuffer(rtFbo);
    params.setBase(`${probe.ns}.x`, 0);
    probe.removeFx('flowDisplace');
    params.setBase('master.motion', 0.7);
    params.setBase('master.reactivity', 0.75);
    renderer.clearFeedback();
  }

  // --- auto projection mapping ----------------------------------------------
  //
  // The camera never sees projector coordinates, so the whole feature rests on
  // solving a projector->camera homography from four blobs and inverting it.
  // These check the solve, the blob finder and the region finder against
  // synthetic scenes with known answers - a real camera cannot be a fixture.
  {
    // A projector aimed off-axis: the unit square lands as a trapezium.
    const projPts = [[0.18, 0.18], [0.82, 0.18], [0.82, 0.82], [0.18, 0.82]];
    const camPts = [[64, 130], [255, 118], [268, 41], [51, 33]];
    const H = quadToQuad(projPts, camPts);
    let fwdErr = 0;
    projPts.forEach((uv, i) => {
      const p = applyH(H, uv[0], uv[1]);
      fwdErr = Math.max(fwdErr, Math.hypot(p[0] - camPts[i][0], p[1] - camPts[i][1]));
    });
    check('projector→camera homography hits the measured blobs', fwdErr < 1e-6,
      `max residual ${fwdErr.toExponential(2)} px`);

    const Hinv = quadToQuad(camPts, projPts);
    let backErr = 0;
    for (const [u, v] of [[0.3, 0.4], [0.7, 0.25], [0.5, 0.9], [0.05, 0.6]]) {
      const cam = applyH(H, u, v);
      const back = applyH(Hinv, cam[0], cam[1]);
      backErr = Math.max(backErr, Math.hypot(back[0] - u, back[1] - v));
    }
    check('camera→projector inverse round-trips', backErr < 1e-9,
      `max drift ${backErr.toExponential(2)} uv`);

    // Blob centroid: a Gaussian spot on a noisy floor, off-centre on purpose.
    const W = 320, HH = 180;
    const spot = new Float32Array(W * HH);
    const TX = 211.0, TY = 57.0;
    for (let y = 0; y < HH; y++) {
      for (let x = 0; x < W; x++) {
        const d2 = (x - TX) ** 2 + (y - TY) ** 2;
        spot[y * W + x] = 240 * Math.exp(-d2 / 90) + ((x * 7 + y * 13) % 5);
      }
    }
    const c = brightestCentroid(spot, W, HH);
    check('blob centroid finds the projected dot',
      c && Math.hypot(c.x - TX, c.y - TY) < 1.0,
      c ? `off by ${Math.hypot(c.x - TX, c.y - TY).toFixed(2)} px` : 'not found');
    check('blob finder rejects an unlit frame',
      brightestCentroid(new Float32Array(W * HH), W, HH) === null, 'returns null on black');

    // Region finder: two "paintings" plus a sliver that must be rejected.
    const mask = new Uint8Array(W * HH);
    const rect = (x0, y0, x1, y1) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * W + x] = 1;
    };
    rect(30, 40, 90, 100);       // 60x60
    rect(200, 60, 260, 120);     // 60x60
    rect(150, 10, 154, 170);     // a sliver - a cable or a shadow edge
    const found = components(mask, W, HH, { minArea: 90 });
    const boxes = found.filter((b) => b.w / Math.max(b.h, 1) > 0.25 && b.w / Math.max(b.h, 1) < 4);
    check('region finder separates the two picture frames',
      found.length === 3 && boxes.length === 2,
      `${found.length} regions, ${boxes.length} kept after the aspect filter`);
    check('region finder measures a frame correctly',
      boxes.every((b) => b.w === 60 && b.h === 60 && b.area === 3600),
      boxes.map((b) => `${b.w}x${b.h}`).join(' '));

    // End to end: a painting seen by the camera maps back to the right place in
    // projector space. This is the number that decides whether it lands on the
    // wall or beside it.
    const corner = (x, y) => applyH(Hinv, x, y);
    const b = boxes[1];
    const proj = [[b.minX, b.maxY], [b.maxX, b.maxY], [b.maxX, b.minY], [b.minX, b.minY]]
      .map(([x, y]) => corner(x, y));
    const inRange = proj.every((p) => p[0] > -0.5 && p[0] < 1.5 && p[1] > -0.5 && p[1] < 1.5);
    const wide = Math.abs(proj[1][0] - proj[0][0]);
    check('a detected frame maps into sane projector coordinates',
      inRange && wide > 0.05 && wide < 0.9,
      `width ${wide.toFixed(3)} uv, corners ${proj.map((p) => `(${p[0].toFixed(2)},${p[1].toFixed(2)})`).join(' ')}`);
  }

  // --- auto mapping, end to end against a simulated camera ------------------
  //
  // The maths above proves the solve; this proves the FEATURE. A stand-in
  // camera renders what a real one would see - the projector's pattern warped
  // by a known off-axis homography, with two dark rectangles standing in for
  // paintings - and the calibrator has to come back with surfaces that land on
  // them. Without this, a sign error in the camera-to-projector direction looks
  // exactly like a correct implementation right up until it is on a wall.
  {
    // Track the calibrator's own working resolution rather than hardcoding one,
    // or raising it silently breaks this fixture instead of the code under test.
    const CW = CAM_W, CH = CAM_H;
    const S = CW / 320;
    // Truth: where the projector's unit square lands in the camera image.
    const TRUE_QUAD = [[38, 141], [281, 152], [270, 26], [55, 19]]
      .map(([x, y]) => [x * S, y * (CH / 180)]);   // BL BR TR TL, y-down
    const uvToCam = quadToQuad([[0, 0], [1, 0], [1, 1], [0, 1]], TRUE_QUAD);
    const camToUv = quadToQuad(TRUE_QUAD, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    // Two paintings, given in projector uv so the expected answer is known.
    const PICTURES = [
      { x0: 0.12, y0: 0.30, x1: 0.34, y1: 0.68 },
      { x0: 0.62, y0: 0.35, x1: 0.86, y1: 0.72 },
    ];
    const insidePicture = (u, v) => PICTURES.some((p) => u > p.x0 && u < p.x1 && v > p.y0 && v < p.y1);

    const stubApp = {
      sources: { activeCameras: () => [{ ready: true }] },
      renderer: { calibration: null },
      mapping: new Mapping(),
      toast() {},
    };
    for (let i = 0; i < 8; i++) params.resetGroup(stubApp.mapping.ns(i));

    const cal = new Calibrator(stubApp);
    // Stand in for the webcam: render the pattern currently on the projector as
    // that camera would see it.
    cal._grab = () => {
      const pat = stubApp.renderer.calibration;
      const out = new Float32Array(CW * CH);
      for (let y = 0; y < CH; y++) {
        for (let x = 0; x < CW; x++) {
          let lit = 0;
          const uv = applyH(camToUv, x + 0.5, y + 0.5);
          if (uv && uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1 && pat) {
            if (pat.mode === 'blob') {
              const dx = (uv[0] - pat.point[0]) * (CW / CH);
              const dy = uv[1] - pat.point[1];
              const d = Math.hypot(dx, dy);
              lit = d > pat.radius ? 0 : 1 - Math.max(0, (d - pat.radius * 0.65) / (pat.radius * 0.35));
            } else {
              lit = pat.level ?? 0;
            }
            // A painting reflects a fraction of what the wall does.
            if (insidePicture(uv[0], uv[1])) lit *= 0.22;
          }
          // Ambient light plus a little sensor noise.
          out[y * CW + x] = 26 + lit * 205 + ((x * 5 + y * 11) % 4);
        }
      }
      return out;
    };

    const res = await cal.run({ assignFrames: true });
    check('auto-map completes against a simulated camera', res.ok, res.message);

    // A camera that cannot see the projection must be refused, not fitted.
    const blind = new Calibrator(stubApp);
    blind._grab = () => {
      const out = new Float32Array(CW * CH);
      for (let i = 0; i < out.length; i++) out[i] = 30 + (i % 3);
      return out;
    };
    const blindRes = await blind.run({ assignFrames: true });
    check('auto-map refuses a camera that cannot see the projection',
      !blindRes.ok, blindRes.message.slice(0, 70));

    // A stray reflection lights a few pixels; that must not pass as a solve.
    const glint = new Calibrator(stubApp);
    glint._grab = () => {
      const pat = stubApp.renderer.calibration;
      const out = new Float32Array(CW * CH);
      for (let i = 0; i < out.length; i++) out[i] = 30;
      const on = pat && (pat.mode === 'blob' || (pat.level ?? 0) > 0.5);
      if (on) for (let y = 88; y < 96; y++) for (let x = 150; x < 158; x++) out[y * CW + x] = 240;
      return out;
    };
    const glintRes = await glint.run({ assignFrames: true });
    check('auto-map refuses a reflection that mimics a projection',
      !glintRes.ok, glintRes.message.slice(0, 70));

    if (res.ok) {
      check('auto-map recovers the projector→camera transform',
        res.residual < 2.5, `blob residual ${res.residual.toFixed(2)} px`);
      check('auto-map finds both picture frames', res.frames.length === 2,
        `${res.frames.length} found`);

      // Every recovered corner must land near the picture it came from.
      let worst = 0;
      let detail = '';
      for (const pic of PICTURES) {
        const cx = (pic.x0 + pic.x1) / 2;
        const cy = (pic.y0 + pic.y1) / 2;
        let best = Infinity;
        let bestF = null;
        for (const f of res.frames) {
          const fx = (f.corners[0][0] + f.corners[1][0] + f.corners[2][0] + f.corners[3][0]) / 4;
          const fy = (f.corners[0][1] + f.corners[1][1] + f.corners[2][1] + f.corners[3][1]) / 4;
          const d = Math.hypot(fx - cx, fy - cy);
          if (d < best) { best = d; bestF = { fx, fy }; }
        }
        if (best > worst) {
          worst = best;
          detail = bestF
            ? `wanted (${cx.toFixed(2)},${cy.toFixed(2)}) got (${bestF.fx.toFixed(2)},${bestF.fy.toFixed(2)})`
            : `wanted (${cx.toFixed(2)},${cy.toFixed(2)}) got nothing`;
        }
      }
      check('auto-mapped surfaces land on the pictures', worst < 0.05,
        `worst centre error ${worst.toFixed(3)} uv — ${detail}`);

      // And they must have been written into real surfaces, right way up.
      const s2 = stubApp.mapping.corners(1);
      const bl = s2[0], br = s2[1], tr = s2[2];
      check('auto-mapped surfaces are written the right way up',
        br[0] > bl[0] && tr[1] > br[1],
        `BL(${bl[0].toFixed(2)},${bl[1].toFixed(2)}) BR(${br[0].toFixed(2)},${br[1].toFixed(2)}) TR(${tr[0].toFixed(2)},${tr[1].toFixed(2)})`);
      check('auto-map can be undone', cal.canUndo && cal.undo(), 'snapshot restored');

      // Running it again, or running it on a blank wall, must not clear planes
      // that were positioned by hand.
      const map = stubApp.mapping;
      params.setBase(`${map.ns(5)}.enabled`, 1);
      map.rename(5, 'Hand placed');
      map.setRect(5, [0.4, 0.4, 0.2, 0.2]);
      const blank = new Calibrator(stubApp);
      blank._grab = () => {
        const pat = stubApp.renderer.calibration;
        const out = new Float32Array(CW * CH);
        for (let y = 0; y < CH; y++) {
          for (let x = 0; x < CW; x++) {
            let lit = 0;
            const uv = applyH(camToUv, x + 0.5, y + 0.5);
            if (uv && uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1 && pat) {
              if (pat.mode === 'blob') {
                const dx = (uv[0] - pat.point[0]) * (CW / CH);
                const dy = uv[1] - pat.point[1];
                const d = Math.hypot(dx, dy);
                lit = d > pat.radius ? 0 : 1;
              } else lit = pat.level ?? 0;
            }
            out[y * CW + x] = 26 + lit * 205 + ((x * 5 + y * 11) % 4);
          }
        }
        return out;                       // an even wall: nothing to find
      };
      const blankRes = await blank.run({ assignFrames: true });
      check('auto-map leaves hand-placed planes alone',
        blankRes.ok && params.get(`${map.ns(5)}.enabled`) > 0.5
          && Math.abs(params.get(`${map.ns(5)}.c0x`) - 0.4) < 1e-6,
        `${blankRes.frames.length} frames found on a blank wall; surface 6 still enabled`);
    }
    for (let i = 0; i < 8; i++) params.resetGroup(stubApp.mapping.ns(i));
  }

  // --- song feels and the show generator -----------------------------------
  //
  // Thirty songs are generated, not authored, so a template that throws or
  // names a param that does not exist would take out a third of the set with
  // no warning until the night. Every feel is built AND rendered here.
  {
    const showApp = {
      layers: new LayerStack(),
      sources,
      renderer,
      modulation: new Modulation(),
      tempo: new TempoTracker(),
      mapping: new Mapping(),
      toast() {},
      addLayer(key, opts) {
        const src = sources.get(key);
        return src ? this.layers.add(key, src.label, opts) : null;
      },
    };
    showApp.presets = new Presets(showApp);
    showApp.setlist = new Setlist(showApp);
    showApp.setlist.replaceShow({ name: 'selftest', songs: [] });

    const bad = [];
    let cueCount = 0;
    gl.getError();
    for (const feel of FEELS) {
      try {
        const cues = buildSongCues(showApp, feel.id, 0);
        if (cues.length !== 5) bad.push(`${feel.id}: ${cues.length} cues`);
        cueCount += cues.length;
        for (let i = 0; i < 3; i++) {
          sources.update(showApp.layers.activeSources(), globals, 1 / 60);
          renderer.render(showApp.layers, resolve, globals, 320, 180, 1 / 60, showApp.mapping);
        }
        const err = gl.getError();
        if (err) bad.push(`${feel.id}: ${glErrorName(gl, err)}`);
      } catch (e) {
        bad.push(`${feel.id}: ${e.message}`);
      }
    }
    check(`all ${FEELS.length} song feels build and render (${cueCount} cues)`,
      bad.length === 0, bad.join(' | '));

    // Every feel must put something in Group A, and that something has to be
    // BRIGHT: the frames are small, hung on dark paintings, and a comp that
    // wanders onto the dark end of a palette reads as a dead projector.
    const CW = 320, CH = 180;
    const px = new Uint8Array(CW * CH * 4);
    const frameMap = new Mapping();
    for (let i = 0; i < 8; i++) params.resetGroup(frameMap.ns(i));
    params.setBase(`${frameMap.ns(1)}.enabled`, 0);
    params.setBase(`${frameMap.ns(2)}.enabled`, 0);
    params.setBase(`${frameMap.ns(0)}.feed`, 1);          // surface 1 shows Group A
    params.setBase(`${frameMap.ns(0)}.soft`, 0);

    const noFrame = [];
    const dim = [];
    for (const feel of FEELS) {
      buildFeel(showApp, feel.id, 0);
      const groups = new Set(showApp.layers.layers.map((l) => Math.round(params.get(`${l.ns}.group`))));
      if (!groups.has(1)) { noFrame.push(feel.id); continue; }
      // Average over a couple of seconds: these comps drift through the palette,
      // so one frame proves nothing about the darkest moment of a song.
      let best = 0;
      for (let step = 0; step < 90; step++) {
        globals.uTime += 1 / 30;
        sources.update(showApp.layers.activeSources(), globals, 1 / 30);
        renderer.render(showApp.layers, resolve, globals, CW, CH, 1 / 30, frameMap);
        if (step % 15 !== 14) continue;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, CW, CH, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let sum = 0;
        for (let k = 0; k < CW * CH; k++) {
          sum += 0.21 * px[k * 4] + 0.72 * px[k * 4 + 1] + 0.07 * px[k * 4 + 2];
        }
        best = Math.max(best, sum / (CW * CH));
      }
      if (best < 12) dim.push(`${feel.id}=${best.toFixed(1)}`);
    }
    check('every feel fills the picture-frame group', noFrame.length === 0, noFrame.join(', '));
    check('every frame comp is bright enough to read on a painting',
      dim.length === 0, dim.length ? `too dark: ${dim.join(' ')}` : `all ${FEELS.length} above the floor`);

    // Same again for the wall, with NO camera and NO screen capture attached.
    // Those sources render transparent until they are started, so a feel that
    // leans on one goes black if the webcam does not come up at the venue -
    // which is exactly the kind of thing that only shows up on the night.
    params.setBase(`${frameMap.ns(0)}.feed`, 0);
    const darkWall = [];
    for (const feel of FEELS) {
      buildFeel(showApp, feel.id, 0);
      let best = 0;
      for (let step = 0; step < 90; step++) {
        globals.uTime += 1 / 30;
        sources.update(showApp.layers.activeSources(), globals, 1 / 30);
        renderer.render(showApp.layers, resolve, globals, CW, CH, 1 / 30, frameMap);
        if (step % 15 !== 14) continue;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, CW, CH, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let sum = 0;
        for (let k = 0; k < CW * CH; k++) {
          sum += 0.21 * px[k * 4] + 0.72 * px[k * 4 + 1] + 0.07 * px[k * 4 + 2];
        }
        best = Math.max(best, sum / (CW * CH));
      }
      if (best < 12) darkWall.push(`${feel.id}=${best.toFixed(1)}`);
    }
    check('every feel still lights the wall with no camera or screen attached',
      darkWall.length === 0,
      darkWall.length ? `too dark: ${darkWall.join(' ')}` : `all ${FEELS.length} above the floor`);
    for (let i = 0; i < 8; i++) params.resetGroup(frameMap.ns(i));

    // A compact cue must restore to exactly the state it was captured from.
    showApp.layers.clear();
    FEELS[0].build(showApp, 0);
    const before = params.snapshot();
    const cue = showApp.presets.capture();
    params.setBase('master.brightness', 0.123);
    params.setBase('master.motion', 1.9);
    showApp.presets.applyState(cue, 0);
    let drift = 0;
    let driftPath = '';
    for (const path in before) {
      if (path.startsWith('map.')) continue;
      if (!params.def(path)) continue;
      const d = Math.abs(params.getBase(path) - before[path]);
      if (d > drift) { drift = d; driftPath = path; }
    }
    check('a compact cue round-trips to the same state', drift < 1e-9,
      drift ? `${driftPath} off by ${drift}` : `${Object.keys(cue.params).length} values stored`);

    // Cues within a song share a stack, so trails survive a cue change.
    const idsBefore = showApp.layers.layers.map((l) => l.id).join(',');
    showApp.presets.applyState(cue, 0);
    check('cues within a song keep their layers (and their trails)',
      showApp.layers.layers.map((l) => l.id).join(',') === idsBefore,
      `layer ids ${idsBefore || 'none'}`);

    // The real thing: 30 songs, and it has to fit in browser storage.
    let genErr = '';
    let stats = { songs: 0, cues: 0, bytes: 0 };
    try {
      generateShow(showApp, [], { count: 30 });
      stats = showApp.setlist.stats();
    } catch (e) {
      genErr = e.message;
    }
    check('a 30-song show generates', !genErr && stats.songs === 30 && stats.cues === 150,
      genErr || `${stats.songs} songs, ${stats.cues} cues`);
    check('the show fits in browser storage', stats.bytes > 0 && stats.bytes < 4_000_000,
      `${(stats.bytes / 1024).toFixed(0)} KB serialised`);

    // Navigation must always land somewhere valid, including at the ends.
    showApp.setlist.go(0, 0);
    let steps = 0;
    while (showApp.setlist.next() && steps < 200) steps++;
    const atEnd = showApp.setlist.songIndex === 29 && showApp.setlist.cueIndex === 4;
    while (showApp.setlist.prev()) { /* wind back */ }
    const atStart = showApp.setlist.songIndex === 0 && showApp.setlist.cueIndex === 0;
    check('cue navigation walks the whole set and stops at both ends',
      steps === 149 && atEnd && atStart, `${steps + 1} cues stepped`);

    for (const l of showApp.layers.layers) renderer.disposeAux(l.id);
    showApp.layers.clear();
    showApp.modulation.clear();
  }

  // --- every param is reachable as a modulation target ---------------------
  const targets = params.modTargets();
  check('modulation targets registered', targets.length > 60, `${targets.length} targets`);
  modulation.add('bass', 'master.brightness', 0.5);
  params.clearMods();
  modulation.apply({ ...features.out, bass: 1, beatCount: 0, beatPhase: 0 }, 1 / 60);
  check('modulation reaches a param', Math.abs(params.getMod('master.brightness')) > 0.01,
    `mod = ${params.getMod('master.brightness').toFixed(3)}`);
  modulation.clear();

  // --- preset round-trip ---------------------------------------------------
  params.setBase(`${probe.ns}.scale`, 2.5);
  const snap = params.snapshot();
  params.setBase(`${probe.ns}.scale`, 1.0);
  params.restore(snap);
  check('preset snapshot round-trip', Math.abs(params.get(`${probe.ns}.scale`) - 2.5) < 1e-6);
  params.setBase(`${probe.ns}.scale`, 1.0);

  // --- audio analysis against the synthetic loop ---------------------------
  //
  // Driven offline rather than through a live AnalyserNode: deterministic,
  // fast, and it still exercises the real features.js / tempo.js code paths.
  const SR = 48000;
  const offlineCtx = new OfflineAudioContext(1, 1, SR);
  const loop = buildTestLoop(offlineCtx, TEST_BPM);
  const analyser = new OfflineAnalyser(loop.getChannelData(0), SR, FFT_SIZE);
  const offFeatures = new FeatureExtractor(analyser);
  const offTempo = new TempoTracker();

  const SECONDS = 20;
  const hop = 1 / 60;
  const bandMax = { bass: 0, lowMid: 0, mid: 0, high: 0, air: 0 };
  let kicks = 0, hats = 0, snares = 0, loudFrames = 0, specMax = 0;
  for (let t = 0; t < SECONDS; t += hop) {
    analyser.advance(hop);
    const f = offFeatures.update(hop);
    offTempo.update(f.onset, hop, t);
    offTempo.writeTo(f);
    for (const k in bandMax) bandMax[k] = Math.max(bandMax[k], f[k]);
    if (f.kickHit) kicks++;
    if (f.hatHit) hats++;
    if (f.snareHit) snares++;
    if (f.level > 0.01) loudFrames++;
    for (let i = 0; i < f.spectrum.length; i++) specMax = Math.max(specMax, f.spectrum[i]);
  }

  const beats = (SECONDS * TEST_BPM) / 60;
  // The loop puts a kick on every beat AND a bass note on every off-beat, so the
  // bass band legitimately carries two onsets per beat.
  const expectedKicks = beats * 2;
  // The mid detector is a band-transient detector, not a snare classifier: on
  // this loop it also catches the kick's broadband click, so ~1 per beat is the
  // correct expectation. What matters is that it is not just re-reporting the
  // 16th hats (which would be ~4 per beat).
  const expectedSnares = beats;

  check('analyser sees signal', loudFrames > SECONDS * 30,
    `${loudFrames} of ${Math.round(SECONDS / hop)} frames above the noise floor`);
  check('all five bands respond',
    Object.values(bandMax).every((v) => v > 0.15),
    Object.entries(bandMax).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' '));
  check('spectrum normalized into range', specMax > 0.4 && specMax <= 1.0,
    `max bin = ${specMax.toFixed(3)}`);
  check('bass onsets detected', Math.abs(kicks - expectedKicks) < expectedKicks * 0.25,
    `${kicks} detected, expected ~${expectedKicks.toFixed(0)} (kick + bass note per beat)`);
  check('mid transients detected, distinct from hats',
    Math.abs(snares - expectedSnares) < expectedSnares * 0.5,
    `${snares} detected, expected ~${expectedSnares.toFixed(0)} (kick click + snare, not the 16th hats)`);
  check('hat onsets detected', hats > beats * 3 && hats < beats * 5,
    `${hats} detected, expected ~${(beats * 4).toFixed(0)} (16ths)`);

  // Half and double tempo are both musically correct readings of this loop.
  const ratio = offTempo.bpm / TEST_BPM;
  const octaveOk = [0.5, 1, 2].some((m) => Math.abs(ratio - m) < 0.06 * m);
  check('tempo locks onto the test loop', octaveOk,
    `detected ${offTempo.bpm.toFixed(1)} BPM vs ${TEST_BPM} (conf ${offTempo.confidence.toFixed(2)})`);
  check('tempo confidence is meaningful', offTempo.confidence > 0.15,
    `conf ${offTempo.confidence.toFixed(2)}`);
  check('beat grid advancing', offTempo.beatCount > SECONDS,
    `${offTempo.beatCount} beats counted over ${SECONDS}s`);

  log('');
  log(`bands  ${Object.entries(bandMax).map(([k, v]) => `${k}=${v.toFixed(2)}`).join('  ')}`);
  log(`onsets kick=${kicks} snare=${snares} hat=${hats}`);
  log(`tempo  ${offTempo.bpm.toFixed(2)} BPM  conf ${offTempo.confidence.toFixed(2)}  beats ${offTempo.beatCount}`);

  // Emit the verdict BEFORE the optional live-audio probe. That probe awaits a
  // real AudioContext, which never resumes under headless virtual time, and a
  // hang there must not swallow a full set of passing results.
  finish();

  try {
    await Promise.race([
      (async () => {
        await audio.resume();
        await audio.useTestSignal(TEST_BPM);
        let live = 0;
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => requestAnimationFrame(r));
          if (features.update(1 / 60).level > 0.005) live++;
        }
        log(`INFO  live AudioContext state=${audio.ctx.state}, ${live}/60 frames with signal`);
      })(),
      new Promise((r) => setTimeout(r, 3000)).then(() =>
        log('INFO  live audio probe timed out (expected headless); offline path above is authoritative')),
    ]);
  } catch (e) {
    log(`INFO  live audio path unavailable here: ${e.message}`);
  }
}

/**
 * Stands in for AudioEngine + AnalyserNode over a fixed buffer. Matches the
 * Web Audio analyser: Blackman window, magnitude divided by fftSize, dB out.
 */
class OfflineAnalyser {
  constructor(samples, sampleRate, fftSize) {
    this.samples = samples;
    this.sampleRate = sampleRate;
    this.fftSize = fftSize;
    this.binCount = fftSize / 2;
    this.freq = new Float32Array(this.binCount);
    this.time = new Float32Array(fftSize);
    this.kind = 'test';
    this.pos = fftSize;
    this.re = new Float32Array(fftSize);
    this.im = new Float32Array(fftSize);
    this.win = new Float32Array(fftSize);
    for (let n = 0; n < fftSize; n++) {
      const a = (2 * Math.PI * n) / fftSize;
      this.win[n] = 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a);
    }
    this.rev = new Uint32Array(fftSize);
    const bits = Math.log2(fftSize);
    for (let i = 0; i < fftSize; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  get binHz() { return this.sampleRate / this.fftSize; }

  advance(seconds) { this.pos += Math.round(seconds * this.sampleRate); }

  poll() {
    const N = this.fftSize;
    const len = this.samples.length;
    const start = this.pos - N;
    for (let i = 0; i < N; i++) {
      const idx = ((start + i) % len + len) % len;
      const v = this.samples[idx];
      this.time[i] = v;
      this.re[this.rev[i]] = v * this.win[i];
      this.im[this.rev[i]] = 0;
    }
    // Iterative Cooley-Tukey, decimation in time.
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1;
      const step = (-2 * Math.PI) / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0; j < half; j++) {
          const ang = step * j;
          const wr = Math.cos(ang);
          const wi = Math.sin(ang);
          const a = i + j;
          const b = a + half;
          const tr = this.re[b] * wr - this.im[b] * wi;
          const ti = this.re[b] * wi + this.im[b] * wr;
          this.re[b] = this.re[a] - tr;
          this.im[b] = this.im[a] - ti;
          this.re[a] += tr;
          this.im[a] += ti;
        }
      }
    }
    for (let k = 0; k < this.binCount; k++) {
      const m = Math.hypot(this.re[k], this.im[k]) / N;
      this.freq[k] = m > 1e-10 ? 20 * Math.log10(m) : -140;
    }
    return true;
  }
}

function finish() {
  const verdict = failures === 0 ? 'PASS' : `FAIL (${failures})`;
  lines.push('', `RESULT: ${verdict}`);
  render();
  document.title = `VJay self-test — ${verdict}`;
  window.__selftest = { failures, lines };
}

run().catch((e) => {
  check('unhandled exception', false, e && e.stack ? e.stack : String(e));
  finish();
});
