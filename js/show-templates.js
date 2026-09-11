// Song feels, and the generator that turns a list of song titles into a show.
//
// Thirty songs each wanting its own look is more state than anyone can dial in
// by hand the night before, so a feel is a template: it builds a whole patch,
// and five cues are derived from it by pushing the same handful of macros
// around (Intro quiet, Chorus open, Bridge twisted, Outro fading).
//
// Written for an acoustic Americana set on a projected corner, which drives
// every choice here:
//   - Calm. Two or three moving parts. Rotation stays near zero: it drifts the
//     whole frame and hides the reaction you actually wanted to see.
//   - Driven by `level`, `mid` and `centroid` rather than `kick`. Brushed
//     drums and a stand-up bass do not give a transient detector much to work
//     with; the ones that lean on kick are the deliberately loud feels.
//   - Every feel fills Group A with a calmer, brighter, lower-detail comp for
//     the picture-frame surfaces. Fine detail is lost on a painting, and a
//     frame that goes black reads as a fault rather than a choice.

import { params } from './params.js';
import { reset, L, set, masterFx } from './looks.js';

/** Layer group ids, matching the `group` param's options. */
const MAIN = 0;
const FRAME = 1;    // Group A - the picture frames
const LIVE = 2;     // Group B - camera / screen, its own surface
const PICTURE = 3;  // Group C - both cameras, matched, sized for a picture frame

const wrap8 = (n) => ((n % 8) + 8) % 8;

/** Per-variant colour and motion drift, so a repeated feel is not a repeat. */
function variantOf(v) {
  return {
    palette: (base) => wrap8(base + [0, 3, 5, 6][v % 4]),
    hue: [0, 0.12, -0.15, 0.22][v % 4],
    motion: [1, 0.85, 1.15, 0.95][v % 4],
    flip: v % 2,
  };
}

/**
 * The lit base under a comp, on the wall or in a frame.
 *
 * A frame showing only an element - a ring, a meter, a scope - is thin bright
 * lines on black, and on a dark painting in a dim room that reads as a dead
 * projector rather than a picture. The same is true of the wall: a mostly-black
 * image leaves the yellow paint unlit, which looks like nothing is happening.
 *
 * It is a narrow radial ramp rather than a flat fill on purpose. Flat reads as
 * a coloured card stuck to the wall; a vignette gives the mapped area shape.
 * `spread` stays low because the default of 1 sweeps the entire palette across
 * the radius and drags part of it onto the dark end of the ramp.
 *
 * `el:solid` is ONE shared source, so a feel using it on both the wall and in a
 * frame gets the same pixels in both - only the layer opacity differs. Where a
 * feel needs something else in the frame it passes a generator it already pays
 * for.
 */
function washSource(tint) {
  set('el.solid.mode', 3);
  set('el.solid.spread', 0.3);
  set('el.solid.alpha', 0.6);
  set('el.solid.react', 0.15);
  set('el.solid.tint', tint);
}

/** Call FIRST in a build - layers stack in creation order, bottom first. */
function wallWash(app, tint = 0.1, opacity = 0.4) {
  washSource(tint);
  // Screen rather than Normal: the wash is there to lift the wall, and an
  // opaque one would cover the photo backdrop underneath it. Screening keeps
  // the lift and lets the picture through.
  return L(app, 'el:solid', { opacity, blend: 2 });
}

function frameWash(app, source = 'el:solid', props = {}, tint = 0.1) {
  if (source === 'el:solid') washSource(tint);
  return L(app, source, { group: FRAME, opacity: 0.85, ...props });
}

/**
 * A camera treatment for the LIVE bus, so every song has a camera comp ready
 * whether or not the feel itself asked for one.
 *
 * Any plane set to bus B becomes the camera view for the whole set, and the
 * pin control can push it into any other comp on the night. It is safe to add
 * unconditionally: a camera that has not been started renders nothing and its
 * bus falls back to the main comp rather than going black.
 */
const CAM_TREATMENTS = [
  // These are the camera looks from the Looks grid, as effect chains rather
  // than as whole patches: a look calls reset() and replaces the layer stack,
  // which is exactly what a song feel must not do. Lifting the chains lets the
  // show carry the same camera treatments without throwing the feel away.
  { name: 'Trails', fx: [
    ['trails', { mix: 1, decay: 0.9, zoom: 1.012, rotate: 0.0008, tint: 0.3 }],
    ['bloom', { mix: 0.4, amount: 0.5, threshold: 0.55 }]] },
  { name: 'Neon', fx: [
    ['edge', { mix: 1, amount: 2.2, width: 1.4, keep: 0.06, colour: 0.9 }],
    ['mirrorBloom', { mix: 0.8, amount: 1.3, threshold: 0.2, spread: 9, chroma: 0.6 }],
    ['trails', { mix: 0.55, decay: 0.72, zoom: 1.002, rotate: 0 }]] },
  { name: 'Motion', fx: [
    ['motionEcho', { mix: 1, adapt: 1.4, threshold: 0.08, gain: 2.4, keep: 0.14, colour: 0.9 }],
    ['trails', { mix: 0.6, decay: 0.8, zoom: 1.004, rotate: 0.002 }]] },
  { name: 'Smear', fx: [
    ['timeSmear', { mix: 1, amount: 0.82, bands: 34, axis: 0, scatter: 0.8, warp: 0.15 }],
    ['colorize', { mix: 1, cycle: 0.25, sat: 1.3 }]] },
  { name: 'Kaleido', fx: [
    ['kaleido', { mix: 1, segments: 6, spin: 0.02, zoom: 0.9 }],
    ['bloom', { mix: 0.4, amount: 0.55 }]] },
  { name: 'Spectrum', fx: [
    ['edge', { mix: 0.85, amount: 1.9, width: 1.2, keep: 0.25, colour: 0.7 }],
    ['specWarp', { mix: 1, amount: 0.075, axis: 0, mirror: 1, range: 0.7, sharpen: 1.5, glow: 0.5, lines: 0.4 }]] },
  { name: 'Flow', fx: [
    ['flowSmear', { mix: 1, length: 5.5, taps: 12, tail: 0.6, chroma: 0.35 }],
    ['flowTrails', { mix: 0.5, decay: 0.86, advect: 3.5, spread: 0.7, tint: 0.35 }]] },
  { name: 'Ink', fx: [
    ['flowPaint', { mix: 1, inject: 0.85, threshold: 0.004, advect: 4.5, decay: 0.96, keep: 0.1, hueByDir: 0.9 }]] },
  { name: 'Liquid', fx: [
    ['flowDisplace', { mix: 1, amount: -9, chroma: 0.45, swirl: 0.4 }],
    ['flowTrails', { mix: 0.45, decay: 0.88, advect: -2.5, spread: 1.0, tint: 0.25 }]] },
  { name: 'Soft bloom', fx: [
    ['trails', { mix: 0.5, decay: 0.85, zoom: 1.002 }],
    ['bloom', { mix: 0.5, amount: 0.7, threshold: 0.45 }]] },
];

/**
 * Both cameras in one comp, treated identically, soft-edged so it reads as a
 * framed picture rather than as a video feed pasted on a wall.
 *
 * Matching the effect chain across the two is the point: the pair should look
 * like two views of the same room, not like two different pieces of software.
 * The C922 is the base and the second camera sits over it, so if only one
 * camera is up the comp still works.
 */
function dualCameraPicture(app, index = 0) {
  for (const l of app.layers.layers) {
    if (Math.round(params.get(`${l.ns}.group`)) === PICTURE) return null;
  }
  const t = CAM_TREATMENTS[index % CAM_TREATMENTS.length];
  // Soft edges and rounded corners instead of a border element: an element
  // would always draw, so with no camera running the comp would be an empty
  // frame on the wall instead of falling back to the main comp.
  // Contain, so the whole camera frame is there. Cover crops to fill, which on
  // a frame that is not the camera's shape throws away most of the picture and
  // reads as a heavy zoom.
  const shape = { group: PICTURE, fit: 1, feather: 0.16, radius: 0.06 };
  const a = L(app, 'cam', { ...shape, opacity: 1 }, t.fx);
  if (a) a.rename('Picture · cam 1');
  const b = L(app, 'cam2', { ...shape, opacity: 0.6, blend: 2 }, t.fx);
  if (b) b.rename('Picture · cam 2');
  return a || b;
}

/**
 * How photos are used, and how often.
 *
 * The album is two different kinds of material and they want opposite
 * treatments. Most of it is full-body figures already lifted onto black -
 * those are meant to be composited, so they go INTO the picture, keyed, whole,
 * and framed by whatever the feel is doing around them. The rest are scene
 * photographs, which are places rather than subjects, so they go behind
 * everything and get pushed around hard by the audio.
 *
 * And not every song gets one. A photograph that turns up in every single song
 * stops being a photograph and becomes wallpaper; used on a third of them it
 * still lands as a choice. One in three carries a figure, one in three a scene,
 * one in three is pure generative.
 */
function photoPlan(songNo) {
  const k = ((songNo % 3) + 3) % 3;
  return k === 0 ? 'figure' : k === 1 ? 'scene' : 'none';
}

/**
 * A cut-out figure standing in the composition.
 *
 * `keyLow` drops the black it was lifted onto, `Contain` keeps the WHOLE body
 * in frame - a person cropped at the shins looks like a mistake, not a crop -
 * and the scale leaves real room around them so the feel's own content reads as
 * the space they are standing in rather than as clutter behind them. Sat a
 * little low, because a standing figure floating in the middle of a wall looks
 * like it is falling.
 */
function figureLayer(app, songNo, { opacity = 0.92 } = {}) {
  const src = app.sources?.get?.('photo');
  const n = src?.list?.length || 0;
  if (!n) return null;
  set('photo.index', songNo % n);
  const l = L(app, 'photo', {
    opacity,
    fit: 1,                    // contain: the whole body, never cropped
    scale: 0.72,               // composed inside the frame, not filling it
    y: -0.06,                  // grounded rather than floating
    keyLow: 0.10,              // drop the black it was cut out onto
    keySoft: 0.09,
    bright: 1.1,
    contrast: 1.08,
  }, [
    // Enough to sit them in the picture rather than look pasted on: a lit edge
    // that answers the beat, and a lift so they read on a dim projector.
    ['bloom', { mix: 0.5, amount: 0.7, threshold: 0.45, radius: 3 }],
  ]);
  if (!l) return null;
  l.rename('Figure');
  // The figure breathes with the music instead of standing perfectly still.
  app.modulation.add('beatPulse', `${l.ns}.scale`, 0.03);
  app.modulation.add('level', `${l.ns}.bright`, 0.12);
  return l;
}

/**
 * A scene photograph as the ground, pushed around by the audio.
 *
 * This is the one place in the set where the picture is allowed to be
 * unrecognisable. It is behind everything, so it can take heavy treatment
 * without fighting the feel: each frequency band displaces its own rows, the
 * colour splits on transients, and the whole thing sits well back in
 * brightness so it reads as a place rather than as a slide.
 */
// Four ways to wreck a photograph, so a set of thirty songs does not apply the
// same one ten times. Each is built round a different axis: frequency bands,
// mirrored geometry, optical flow, and hard slicing.
const SCENE_TREATMENTS = [
  { name: 'bands', fx: [
      ['specWarp', { mix: 1, amount: 0.26, axis: 0, mirror: 1, range: 0.85,
        sharpen: 1.8, glow: 0.5, lines: 0.25 }],
      ['rgbShift', { mix: 0.8, amount: 0.02, radial: 0.8, spin: 0.2 }]],
    mod: [['level', 'specWarp.amount', 0.16], ['kick', 'rgbShift.amount', 0.03]] },
  { name: 'kaleido', fx: [
      ['kaleido', { mix: 0.9, segments: 6, spin: 0.05, zoom: 1.2 }],
      ['specWarp', { mix: 0.7, amount: 0.14, axis: 2, mirror: 1, glow: 0.4 }]],
    mod: [['bass', 'kaleido.zoom', 0.3], ['level', 'specWarp.amount', 0.12]] },
  { name: 'liquid', fx: [
      ['flowDisplace', { mix: 1, amount: -7, chroma: 0.5, swirl: 0.5 }],
      ['colorize', { mix: 0.6, cycle: 0.3, sat: 1.2 }]],
    mod: [['bass', 'flowDisplace.amount', -0.3], ['centroid', 'colorize.cycle', 0.25]] },
  { name: 'sliced', fx: [
      ['glitch', { mix: 0.9, amount: 0.5, slices: 30, rate: 8, blocks: 0.4, trigger: 0.9 }],
      ['specWarp', { mix: 0.8, amount: 0.18, axis: 1, mirror: 1, glow: 0.45 }]],
    mod: [['flux', 'glitch.amount', 0.3], ['level', 'specWarp.amount', 0.14]] },
];

function sceneBackdrop(app, songNo, { opacity = 0.55 } = {}) {
  const src = app.sources?.get?.('photo2');
  const n = src?.list?.length || 0;
  if (!n) return null;
  set('photo2.index', songNo % n);
  const t = SCENE_TREATMENTS[Math.floor(songNo / 3) % SCENE_TREATMENTS.length];
  const l = L(app, 'photo2', {
    opacity,
    fit: 0,                    // cover: a backdrop must fill the wall
    // Held well down. Half this album was shot on snow, which comes back near
    // white - at anything like full brightness it does not sit behind the feel,
    // it erases it.
    bright: 0.6,
    contrast: 1.25,
    sat: 0.8,
  }, t.fx);
  if (!l) return null;
  l.rename(`Scene · ${t.name}`);
  for (const [srcKey, target, amt] of t.mod) {
    const dot = target.indexOf('.');
    app.modulation.add(srcKey, `${l.fxNs(target.slice(0, dot))}.${target.slice(dot + 1)}`, amt);
  }
  app.modulation.add('centroid', `${l.ns}.hue`, 0.2);
  return l;
}

function liveCamera(app, index = 0) {
  // Already got one? Some feels build their own camera comp deliberately.
  for (const l of app.layers.layers) {
    if (Math.round(params.get(`${l.ns}.group`)) === LIVE) return null;
  }
  const t = CAM_TREATMENTS[index % CAM_TREATMENTS.length];
  const cam = L(app, 'cam', { group: LIVE, opacity: 1, fit: 1 }, t.fx);
  if (cam) cam.rename('Camera');
  return cam;
}

/** Bridge moves, one structural change rather than a pile of small ones. */
function twistPalette(step = 3) {
  return (app) => {
    set('master.palette', wrap8(params.getBase('master.palette') + step));
  };
}
function twistFx(id, values) {
  return (app) => {
    set('master.palette', wrap8(params.getBase('master.palette') + 2));
    masterFx(id, values);
  };
}

export const FEELS = [
  {
    id: 'campfire', name: 'Campfire',
    hint: 'Slow ember plasma with sparks on the low end. The resting state of the set.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(4));
      set('master.motion', 0.28 * V.motion);
      set('master.reactivity', 0.55);
      set('gen.plasma.scale', 2.0);
      set('gen.plasma.speed', 0.15);
      set('gen.plasma.warp', 0.8);
      set('gen.plasma.bands', 2);
      set('gen.plasma.reactive', 0.8);
      const bg = L(app, 'gen:plasma', { blend: 2, hue: V.hue });
      const accent = L(app, 'el:sparks', { blend: 1, opacity: 0.55 });
      set('el.sparks.count', 14);
      set('el.sparks.spread', 0.6);
      set('el.sparks.speed', 0.8);
      frameWash(app);
      set('el.solid.tint', 0.08);
      L(app, 'el:blob', { group: FRAME, blend: 1 });
      set('el.blob.size', 0.55);
      set('el.blob.pulse', 0.7);
      set('el.blob.band', 5);
      set('el.blob.tint', 0.1);
      masterFx('bloom', { mix: 0.45, amount: 0.6, threshold: 0.5 });
      app.modulation.add('centroid', 'gen.plasma.warp', 0.2);
      app.modulation.add('level', `${bg.ns}.bright`, 0.15);
      return { accent, twist: twistPalette(3) };
    },
  },
  {
    id: 'porch', name: 'Front Porch',
    hint: 'The waveform itself, smeared into a slow trail. Very literal, very calm.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(1));
      set('master.motion', 0.3 * V.motion);
      set('master.reactivity', 0.7);
      set('gen.flow.speed', 0.2);
      set('gen.flow.inject', 0.2);
      wallWash(app, 0.15, 0.38);
      L(app, 'gen:flow', { blend: 1, opacity: 0.9, hue: V.hue });
      set('el.scope.gain', 1.6);
      set('el.scope.thickness', 0.02);
      set('el.scope.glow', 0.8);
      set('el.scope.mode', 0);
      const line = L(app, 'el:scope', { blend: 1 }, [
        ['trails', { mix: 0.7, decay: 0.85, zoom: 1.003, rotate: 0 }],
      ]);
      frameWash(app, 'gen:flow', { opacity: 0.75 });
      L(app, 'el:scope', { group: FRAME, blend: 1, scale: 0.9 });
      masterFx('bloom', { mix: 0.5, amount: 0.7, threshold: 0.45 });
      app.modulation.add('level', 'el.scope.gain', 0.3);
      return { accent: line, twist: twistFx('mirror', { mix: 0.35, tiles: 2, mode: 1 }) };
    },
  },
  {
    id: 'dust', name: 'Dust',
    hint: 'Drifting starfield. Nothing pulses hard; the whole field just breathes.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(1));
      set('master.motion', 0.25 * V.motion);
      set('master.reactivity', 0.6);
      set('gen.starfield.speed', 0.15);
      set('gen.starfield.layers', 4);
      set('gen.starfield.density', 10);
      set('gen.starfield.streak', 0.25);
      wallWash(app, 0.75, 0.45);
      const bg = L(app, 'gen:starfield', { blend: 1, hue: V.hue });
      set('el.dots.cols', 8);
      set('el.dots.rows', 5);
      set('el.dots.size', 0.2);
      set('el.dots.react', 0.9);
      set('el.dots.soft', 0.4);
      frameWash(app, 'el:solid', {}, 0.75);
      L(app, 'el:dots', { group: FRAME, blend: 1 });
      masterFx('bloom', { mix: 0.4, amount: 0.6 });
      app.modulation.add('level', 'gen.starfield.density', 0.2);
      app.modulation.add('centroid', `${bg.ns}.hue`, 0.15);
      return { accent: null, twist: twistPalette(4) };
    },
  },
  {
    id: 'ripple', name: 'Ripple',
    hint: 'Concentric rings widening on the mids. One clear reaction, nothing else.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(6));
      set('master.motion', 0.3 * V.motion);
      set('master.reactivity', 0.75);
      set('gen.rings.count', 5);
      set('gen.rings.speed', 0.2);
      set('gen.rings.width', 0.05);
      set('gen.rings.wobble', 0.15);
      L(app, 'gen:rings', { blend: 2, hue: V.hue });
      set('el.ring.radius', 0.35);
      set('el.ring.thickness', 0.02);
      set('el.ring.band', 2);
      set('el.ring.pulse', 0.4);
      set('el.ring.spin', 0.02);
      const accent = L(app, 'el:ring', { blend: 1, opacity: 0.8 });
      frameWash(app);
      set('el.solid.tint', 0.35);
      L(app, 'el:ring', { group: FRAME, blend: 1, scale: 0.85 });
      masterFx('bloom', { mix: 0.5, amount: 0.7 });
      app.modulation.add('mid', 'gen.rings.width', 0.25);
      return { accent, twist: twistFx('polar', { mix: 0.4, amount: 1, twist: 0.6 }) };
    },
  },
  {
    id: 'quilt', name: 'Quilt',
    hint: 'Voronoi cells in flat colour, like a patchwork seen from across a room.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(2));
      set('master.motion', 0.25 * V.motion);
      set('master.reactivity', 0.6);
      set('gen.voronoi.scale', 5);
      set('gen.voronoi.speed', 0.15);
      set('gen.voronoi.edge', 0.5);
      set('gen.voronoi.pulse', 0.6);
      L(app, 'gen:voronoi', { blend: 2, hue: V.hue }, [
        ['paletteMap', { mix: 0.8, spread: 1.4, preserve: 0.3, drive: 0.25 }],
      ]);
      set('el.dots.cols', 6);
      set('el.dots.rows', 4);
      set('el.dots.size', 0.24);
      set('el.dots.tint', 0.4);
      frameWash(app, 'gen:voronoi', { opacity: 0.9 });
      L(app, 'el:dots', { group: FRAME, blend: 1 });
      app.modulation.add('level', 'gen.voronoi.edge', 0.2);
      return { accent: null, twist: twistFx('posterize', { mix: 0.5, levels: 5, dither: 0.15 }) };
    },
  },
  {
    id: 'river', name: 'River',
    hint: 'A slow fluid field. Colour walks with the brightness of the mix.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(6));
      set('master.motion', 0.32 * V.motion);
      set('master.reactivity', 0.65);
      set('gen.flow.scale', 2.2);
      set('gen.flow.speed', 0.3);
      set('gen.flow.decay', 0.94);
      set('gen.flow.inject', 0.35);
      wallWash(app, 0.5, 0.4);
      const bg = L(app, 'gen:flow', { blend: 1, hue: V.hue }, [
        ['colorize', { mix: 0.7, cycle: 0.15, sat: 1.2 }],
      ]);
      L(app, 'gen:flow', { group: FRAME, bright: 1.2 });
      masterFx('bloom', { mix: 0.45, amount: 0.6 });
      app.modulation.add('centroid', `${bg.ns}.hue`, 0.2);
      return { accent: null, twist: twistPalette(5) };
    },
  },
  {
    id: 'glass', name: 'Stained Glass',
    hint: 'Folded kaleidoscopic panes. Church windows rather than a rave.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(5));
      set('master.motion', 0.24 * V.motion);
      set('master.reactivity', 0.6);
      set('gen.kaleido.folds', 4);
      set('gen.kaleido.iter', 7);
      set('gen.kaleido.zoom', 1.1);
      set('gen.kaleido.spin', 0.004);
      set('gen.kaleido.reactive', 0.8);
      L(app, 'gen:kaleido', { blend: 2, hue: V.hue });
      set('gen.plasma.bands', 1);
      set('gen.plasma.scale', 1.4);
      set('gen.plasma.speed', 0.12);
      set('gen.plasma.warp', 0.5);
      L(app, 'gen:plasma', { group: FRAME });
      masterFx('bloom', { mix: 0.45, amount: 0.6 });
      app.modulation.add('bass', 'gen.kaleido.zoom', 0.12);
      return { accent: null, twist: twistFx('kaleido', { mix: 0.4, segments: 3, spin: 0.01 }) };
    },
  },
  {
    id: 'lantern', name: 'Lantern',
    hint: 'One glow breathing on the level, over a dim wash. Almost nothing moves.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(4));
      set('master.motion', 0.2 * V.motion);
      set('master.reactivity', 0.8);
      set('el.solid.mode', 3);
      set('el.solid.alpha', 0.55);
      set('el.solid.react', 0.3);
      set('el.solid.tint', 0.1);
      L(app, 'el:solid', { blend: 2, hue: V.hue });
      set('el.blob.size', 0.5);
      set('el.blob.falloff', 2.4);
      set('el.blob.pulse', 0.9);
      set('el.blob.wobble', 0.15);
      set('el.blob.band', 5);
      const accent = L(app, 'el:blob', { blend: 1 });
      L(app, 'el:solid', { group: FRAME, opacity: 0.85 });
      L(app, 'el:blob', { group: FRAME, blend: 1, scale: 0.9 });
      masterFx('bloom', { mix: 0.6, amount: 1.0, threshold: 0.4 });
      app.modulation.add('level', 'el.blob.size', 0.2);
      return { accent, twist: twistFx('rgbShift', { mix: 0.35, amount: 0.02, radial: 0.8 }) };
    },
  },
  {
    id: 'moss', name: 'Moss',
    hint: 'Reaction-diffusion growing over the song. Organic, extremely slow.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(1));
      set('master.motion', 0.3 * V.motion);
      set('master.reactivity', 0.55);
      set('gen.reaction.steps', 2);
      set('gen.reaction.seed', 0.3);
      wallWash(app, 0.45, 0.32);
      L(app, 'gen:reaction', { blend: 1, bright: 1.2, hue: V.hue }, [
        ['paletteMap', { mix: 0.85, spread: 1.6, preserve: 0.15, drive: 0.3 }],
      ]);
      frameWash(app);
      set('el.solid.tint', 0.45);
      L(app, 'gen:reaction', { group: FRAME, bright: 1.2, blend: 2 });
      app.modulation.add('mid', 'gen.reaction.seed', 0.2);
      return { accent: null, twist: twistPalette(6) };
    },
  },
  {
    id: 'road', name: 'Tunnel Road',
    hint: 'A tunnel pulled slowly toward you. Reads as depth without any rotation.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(4));
      set('master.motion', 0.28 * V.motion);
      set('master.reactivity', 0.7);
      set('gen.tunnel.speed', 0.15);
      set('gen.tunnel.twist', 0.1);
      set('gen.tunnel.rings', 6);
      set('gen.tunnel.spokes', 0);
      set('gen.tunnel.reactive', 0.8);
      L(app, 'gen:tunnel', { blend: 2, hue: V.hue });
      set('gen.rings.count', 4);
      set('gen.rings.speed', 0.15);
      set('gen.rings.width', 0.06);
      L(app, 'gen:rings', { group: FRAME });
      masterFx('bloom', { mix: 0.45, amount: 0.65 });
      app.modulation.add('level', 'gen.tunnel.speed', 0.2);
      return { accent: null, twist: twistFx('mirror', { mix: 0.4, tiles: 2, mode: 0 }) };
    },
  },
  {
    id: 'sunset', name: 'Sunset',
    hint: 'A gradient wash with a bar-synced sweep crossing it. Good under a ballad.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(2));
      set('master.motion', 0.22 * V.motion);
      set('master.reactivity', 0.6);
      set('el.solid.mode', 1);
      set('el.solid.spread', 1.2);
      set('el.solid.alpha', 0.85);
      set('el.solid.react', 0.25);
      set('el.solid.tint', 0.15);
      const wash = L(app, 'el:solid', { blend: 2, hue: V.hue }, [
        ['trails', { mix: 0.45, decay: 0.8, zoom: 1.002, rotate: 0 }],
      ]);
      set('el.sweep.axis', 0);
      set('el.sweep.div', 2);
      set('el.sweep.width', 0.06);
      set('el.sweep.trail', 0.6);
      const accent = L(app, 'el:sweep', { blend: 1, opacity: 0.5 });
      L(app, 'el:solid', { group: FRAME, opacity: 0.8 });
      L(app, 'el:ring', { group: FRAME, blend: 1, scale: 0.8 });
      masterFx('bloom', { mix: 0.45, amount: 0.6 });
      app.modulation.add('centroid', `${wash.ns}.hue`, 0.12);
      return { accent, twist: twistPalette(4) };
    },
  },
  {
    id: 'stomp', name: 'Stomp',
    hint: 'The loud one: radial spectrum bars and sparks on the kick. Use it sparingly.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(0));
      set('master.motion', 0.45 * V.motion);
      set('master.reactivity', 1.0);
      set('gen.bars.mode', 2);
      set('gen.bars.thickness', 0.6);
      set('gen.bars.gain', 1.4);
      set('gen.bars.glow', 0.8);
      set('gen.bars.radius', 0.35);
      wallWash(app, 0.02, 0.42);
      L(app, 'gen:bars', { blend: 1, hue: V.hue });
      set('el.sparks.count', 20);
      set('el.sparks.speed', 1.2);
      set('el.sparks.trigger', 0);
      const accent = L(app, 'el:sparks', { blend: 1, opacity: 0.7 });
      set('el.meter.count', 16);
      set('el.meter.mirror', 1);
      set('el.meter.gain', 1.3);
      set('el.meter.anchor', 1);
      set('el.meter.round', 0.5);
      frameWash(app);
      set('el.solid.tint', 0.02);
      L(app, 'el:meter', { group: FRAME, blend: 1 });
      masterFx('bloom', { mix: 0.6, amount: 1.0, threshold: 0.4 });
      app.modulation.add('kick', 'gen.bars.radius', 0.12);
      app.modulation.add('level', 'gen.bars.gain', 0.2);
      return { accent, twist: twistFx('strobe', { mix: 0.5, strobe: 0.25, div: 2 }) };
    },
  },
  {
    id: 'portrait', name: 'Neon Portrait', cam: true,
    hint: 'Camera as a neon outline on the wall, with a softer trail in a frame.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(3));
      set('master.motion', 0.3 * V.motion);
      set('master.reactivity', 0.75);
      set('gen.flow.speed', 0.2);
      // The camera may simply not come up at the venue, so the backdrop has to
      // carry the wall on its own. gen:flow is sparse and dark by nature.
      wallWash(app, 0.72, 0.32);
      L(app, 'gen:flow', { blend: 1, opacity: 0.9, hue: V.hue });
      const cam = L(app, 'cam', { keyLow: 0.08, keySoft: 0.12 }, [
        ['edge', { mix: 1, amount: 1.8, width: 1.2, keep: 0.08, colour: 0.8 }],
        ['mirrorBloom', { mix: 0.75, amount: 1.0, threshold: 0.25, spread: 8, chroma: 0.5 }],
      ]);
      L(app, 'cam', { group: LIVE, fit: 1 }, [
        ['trails', { mix: 0.6, decay: 0.88, zoom: 1.004, rotate: 0 }],
      ]);
      frameWash(app);
      set('el.solid.tint', 0.7);
      L(app, 'el:blob', { group: FRAME, blend: 1 });
      app.modulation.add('mid', `${cam.fxNs('edge')}.amount`, 0.25);
      return { accent: cam, twist: twistFx('posterize', { mix: 0.4, levels: 6 }) };
    },
  },
  {
    id: 'window', name: 'Window', screen: true,
    hint: 'Screen capture recoloured and framed, over a calm plasma wall.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(5));
      set('master.motion', 0.24 * V.motion);
      set('master.reactivity', 0.6);
      set('gen.plasma.scale', 2.2);
      set('gen.plasma.speed', 0.12);
      set('gen.plasma.bands', 2);
      set('gen.plasma.warp', 0.6);
      L(app, 'gen:plasma', { hue: V.hue });
      const scr = L(app, 'screen', { group: LIVE, fit: 1 }, [
        ['paletteMap', { mix: 0.6, spread: 1.2, preserve: 0.6, drive: 0.2 }],
        ['bloom', { mix: 0.5, amount: 0.7, threshold: 0.5 }],
      ]);
      set('el.frame.inset', 0.02);
      set('el.frame.thickness', 0.008);
      set('el.frame.react', 0.25);
      L(app, 'el:frame', { group: LIVE, blend: 1, opacity: 0.7 });
      frameWash(app, 'gen:plasma', { opacity: 0.85 });
      L(app, 'el:dots', { group: FRAME, blend: 1 });
      app.modulation.add('level', `${scr.ns}.bright`, 0.15);
      return { accent: scr, twist: twistPalette(3) };
    },
  },
  {
    id: 'mirrorHall', name: 'Mirror Hall', cam: true,
    hint: 'Camera folded into petals inside a frame, slow rings behind it.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(6));
      set('master.motion', 0.26 * V.motion);
      set('master.reactivity', 0.7);
      set('gen.rings.count', 3);
      set('gen.rings.speed', 0.12);
      set('gen.rings.width', 0.08);
      wallWash(app, 0.6, 0.42);
      L(app, 'gen:rings', { blend: 1, hue: V.hue });
      const cam = L(app, 'cam', { group: LIVE, fit: 0 }, [
        ['kaleido', { mix: 1, segments: 6, spin: 0.01, zoom: 0.9 }],
        ['colorize', { mix: 0.6, cycle: 0.1, sat: 1.2 }],
      ]);
      frameWash(app);
      set('el.solid.tint', 0.6);
      L(app, 'el:ring', { group: FRAME, blend: 1 });
      masterFx('bloom', { mix: 0.4, amount: 0.6 });
      app.modulation.add('bass', `${cam.fxNs('kaleido')}.zoom`, 0.12);
      return { accent: cam, twist: twistPalette(2) };
    },
  },
  // ---- corner feels ---------------------------------------------------------
  //
  // These are the ones built for the room rather than for a screen. Each hangs
  // its vanishing structure on the crease between the two wall planes, so the
  // corner stops being an awkward fold in the picture and becomes the subject.
  // They stay on MAIN, because the corner IS the wall.

  {
    id: 'hallway', name: 'Hallway',
    hint: 'A corridor receding into the corner. The crease becomes the far end of a room.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(4));
      set('master.motion', 0.3 * V.motion);
      set('master.reactivity', 0.55);
      set('gen.corridor.focal', 1.15);
      set('gen.corridor.speed', 0.22);
      set('gen.corridor.rings', 8);
      set('gen.corridor.bars', 3);
      set('gen.corridor.fog', 1.4);
      set('gen.corridor.glow', 0.8);
      set('gen.corridor.reactive', 0.9);
      const bg = L(app, 'gen:corridor', { blend: 2, hue: V.hue });
      // A frame is a small flat rectangle; perspective is wasted in one, so the
      // frames get a calm wash rather than a second copy of the corridor.
      frameWash(app);
      set('el.solid.tint', 0.1);
      L(app, 'el:ring', { group: FRAME, blend: 1, scale: 0.8 });
      set('el.ring.thickness', 0.06);
      set('el.ring.pulse', 0.6);
      set('el.ring.band', 3);
      masterFx('bloom', { mix: 0.45, amount: 0.65, threshold: 0.5 });
      app.modulation.add('level', 'gen.corridor.speed', 0.18);
      app.modulation.add('centroid', `${bg.ns}.hue`, 0.12);
      return { accent: null, twist: twistPalette(3) };
    },
  },

  {
    id: 'cornerGlow', name: 'Corner Glow',
    hint: 'Warm light pouring out of the crease itself. The calmest thing in the set.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(4));
      set('master.motion', 0.22 * V.motion);
      set('master.reactivity', 0.6);
      set('gen.crease.width', 0.05);
      set('gen.crease.spread', 2.4);
      set('gen.crease.taper', 0.4);
      set('gen.crease.hot', 0.9);
      set('gen.crease.drift', 0.4);
      set('gen.crease.reactive', 1.0);
      const bg = L(app, 'gen:crease', { blend: 2, hue: V.hue });
      const accent = L(app, 'el:sparks', { blend: 1, opacity: 0.4 });
      set('el.sparks.count', 10);
      set('el.sparks.spread', 0.5);
      set('el.sparks.speed', 0.5);
      frameWash(app);
      set('el.solid.tint', 0.06);
      masterFx('bloom', { mix: 0.55, amount: 0.8, threshold: 0.4 });
      app.modulation.add('bass', 'gen.crease.width', 0.03);
      app.modulation.add('level', `${bg.ns}.bright`, 0.18);
      return { accent, twist: twistPalette(2) };
    },
  },

  {
    id: 'standingStones', name: 'Standing Stones',
    hint: 'Lit slabs turning slowly in front of the corner. Solid objects, not a picture.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(5));
      set('master.motion', 0.28 * V.motion);
      set('master.reactivity', 0.65);
      set('gen.monolith.count', 2 + (v % 2));
      set('gen.monolith.size', 0.95);
      set('gen.monolith.spread', 1.15);
      set('gen.monolith.spin', 0.35);
      set('gen.monolith.sway', 0.2);
      set('gen.monolith.focal', 1.2);
      set('gen.monolith.reactive', 0.9);
      // A lit ground under them. Without it the slabs float on bare yellow
      // paint, stop reading as solid, and leave the wall looking switched off.
      wallWash(app, 0.08, 0.5);
      set('el.solid.alpha', 0.8);
      set('el.solid.spread', 0.45);
      const bg = L(app, 'gen:monolith', { blend: 1, hue: V.hue, bright: 1.3 });
      frameWash(app);
      set('el.solid.tint', 0.12);
      L(app, 'el:meter', { group: FRAME, blend: 1, opacity: 0.7 });
      masterFx('bloom', { mix: 0.4, amount: 0.6, threshold: 0.55 });
      app.modulation.add('level', 'gen.monolith.sway', 0.12);
      app.modulation.add('centroid', `${bg.ns}.hue`, 0.1);
      return { accent: null, twist: twistFx('rgbShift', { mix: 0.3, amount: 0.4 }) };
    },
  },

  {
    id: 'deepRoom', name: 'Deep Room',
    hint: 'Slabs standing in a receding corridor. The busiest corner feel — save it for a peak.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(6));
      set('master.motion', 0.32 * V.motion);
      set('master.reactivity', 0.8);
      set('gen.corridor.focal', 1.3);
      set('gen.corridor.speed', 0.3);
      set('gen.corridor.rings', 12);
      set('gen.corridor.bars', 5);
      set('gen.corridor.fog', 1.0);
      set('gen.corridor.glow', 0.9);
      wallWash(app, 0.12, 0.34);
      L(app, 'gen:corridor', { blend: 1, hue: V.hue, bright: 1.15 });
      set('gen.monolith.count', 1);
      set('gen.monolith.size', 0.9);
      set('gen.monolith.spin', 0.4);
      set('gen.monolith.sway', 0.25);
      const accent = L(app, 'gen:monolith', { blend: 1, opacity: 0.9 });
      frameWash(app);
      set('el.solid.tint', 0.14);
      L(app, 'el:dots', { group: FRAME, blend: 1 });
      set('el.dots.cols', 5);
      set('el.dots.rows', 3);
      masterFx('bloom', { mix: 0.5, amount: 0.75, threshold: 0.45 });
      app.modulation.add('level', 'gen.corridor.speed', 0.22);
      return { accent, twist: twistPalette(4) };
    },
  },

  {
    id: 'doorway', name: 'Doorway',
    hint: 'Light at the crease with a faint corridor behind it. Reads as a door left ajar.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(3));
      set('master.motion', 0.26 * V.motion);
      set('master.reactivity', 0.6);
      set('gen.corridor.focal', 0.9);
      set('gen.corridor.speed', 0.15);
      set('gen.corridor.rings', 6);
      set('gen.corridor.bars', 2);
      set('gen.corridor.fog', 2.2);
      set('gen.corridor.glow', 0.3);
      L(app, 'gen:corridor', { blend: 2, opacity: 0.7, hue: V.hue });
      set('gen.crease.width', 0.03);
      set('gen.crease.spread', 1.6);
      set('gen.crease.taper', 0.5);
      set('gen.crease.hot', 1.1);
      set('gen.crease.drift', 0.3);
      const accent = L(app, 'gen:crease', { blend: 1, opacity: 0.9 });
      frameWash(app);
      set('el.solid.tint', 0.09);
      L(app, 'el:blob', { group: FRAME, blend: 1 });
      set('el.blob.size', 0.5);
      set('el.blob.pulse', 0.6);
      masterFx('bloom', { mix: 0.5, amount: 0.7, threshold: 0.45 });
      app.modulation.add('bass', 'gen.crease.width', 0.025);
      return { accent, twist: twistPalette(5) };
    },
  },
  {
    id: 'longRoom', name: 'Long Room',
    hint: 'A room that keeps going past the corner. Floor and ceiling in real perspective.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(6));
      set('master.motion', 0.3 * V.motion);
      set('master.reactivity', 0.6);
      set('gen.hall.focal', 1.1);
      set('gen.hall.height', 0.9);
      set('gen.hall.depth', 9);
      set('gen.hall.grid', 5);
      set('gen.hall.speed', 0.22);
      set('gen.hall.fog', 0.55);
      set('gen.hall.reactive', 0.9);
      // A lit ground under the room. Wire-frame perspective on black is almost
      // no light at all, which on a dim projector reads as a dead wall.
      wallWash(app, 0.14, 0.34);
      const bg = L(app, 'gen:hall', { blend: 1, hue: V.hue, bright: 1.35 });
      frameWash(app);
      set('el.solid.tint', 0.12);
      masterFx('bloom', { mix: 0.4, amount: 0.6, threshold: 0.5 });
      app.modulation.add('level', 'gen.hall.speed', 0.15);
      app.modulation.add('centroid', `${bg.ns}.hue`, 0.12);
      return { accent: null, twist: twistPalette(3) };
    },
  },

  {
    id: 'alcove', name: 'Alcove',
    hint: 'A lit recess cut into the corner. Reads as a hole in the wall, not a picture on it.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(4));
      set('master.motion', 0.24 * V.motion);
      set('master.reactivity', 0.65);
      set('gen.vault.focal', 1.1);
      // A wide opening: the recess is the only lit thing here, so it has to be
      // most of the frame or the wall gets almost nothing.
      set('gen.vault.width', 0.78);
      set('gen.vault.tall', 0.82);
      set('gen.vault.depth', 2.4);
      set('gen.vault.rings', 5);
      set('gen.vault.glow', 1.6);
      // The wall around the opening is black, so a wash under it would fill in
      // the very thing that makes the recess read as a hole. Deliberately none.
      const bg = L(app, 'gen:vault', { blend: 2, hue: V.hue, bright: 1.5 });
      frameWash(app);
      set('el.solid.tint', 0.1);
      L(app, 'el:ring', { group: FRAME, blend: 1, scale: 0.8 });
      set('el.ring.pulse', 0.5);
      masterFx('bloom', { mix: 0.5, amount: 0.75, threshold: 0.42 });
      app.modulation.add('bass', 'gen.vault.depth', 0.35);
      app.modulation.add('centroid', `${bg.ns}.hue`, 0.1);
      return { accent: null, twist: twistPalette(5) };
    },
  },

  {
    id: 'ribbon', name: 'Ribbon',
    hint: 'A helix winding into the corner. The strands pass in front of each other — real occlusion.',
    build(app, v) {
      const V = variantOf(v);
      set('master.palette', V.palette(2));
      set('master.motion', 0.3 * V.motion);
      set('master.reactivity', 0.7);
      set('gen.helix.focal', 1.2);
      set('gen.helix.radius', 0.5);
      set('gen.helix.turns', 2.5);
      set('gen.helix.thickness', 0.06);
      set('gen.helix.spin', 0.35);
      set('gen.helix.reach', 3.5);
      // A dark ground so the ribbon has something to be in front of.
      wallWash(app, 0.1, 0.3);
      const bg = L(app, 'gen:helix', { blend: 1, hue: V.hue, bright: 1.2 });
      frameWash(app);
      set('el.solid.tint', 0.16);
      L(app, 'el:scope', { group: FRAME, blend: 1, scale: 0.85 });
      masterFx('bloom', { mix: 0.5, amount: 0.7, threshold: 0.45 });
      app.modulation.add('level', 'gen.helix.spin', 0.2);
      app.modulation.add('bass', 'gen.helix.radius', 0.08);
      return { accent: null, twist: twistFx('rgbShift', { mix: 0.3, amount: 0.4 }) };
    },
  },
];

export const FEEL_BY_ID = Object.fromEntries(FEELS.map((f) => [f.id, f]));

// Running order for a generated set: alternates texture, colour and energy, and
// spaces out both Stomp and the feels that want hardware.
const FEEL_ORDER = [
  'campfire', 'porch', 'cornerGlow', 'dust', 'longRoom',
  'ripple', 'hallway', 'portrait', 'alcove', 'lantern',
  'standingStones', 'quilt', 'road', 'ribbon', 'doorway',
  'stomp', 'river', 'glass', 'deepRoom', 'window',
  'sunset', 'moss', 'mirrorHall',
];

export const CUE_PLAN = [
  { name: 'Intro', morphBeats: 0 },
  { name: 'Verse', morphBeats: 4 },
  { name: 'Chorus', morphBeats: 4 },
  { name: 'Bridge', morphBeats: 8 },
  { name: 'Outro', morphBeats: 8 },
];

const scaleParam = (path, k) => {
  const d = params.def(path);
  if (!d) return;
  params.setBase(path, Math.max(d.min, Math.min(d.max, params.getBase(path) * k)));
};

/**
 * Five cues for one song. The feel builds the patch once; each cue is that
 * patch with a few macros moved, captured, and then wound back - so all five
 * share a layer stack and cue changes inside a song keep their trails.
 */
export function buildFeel(app, feelId, variant = 0) {
  const feel = FEEL_BY_ID[feelId] || FEELS[0];
  // Clear first, always. A feel that inherited the previous one's layers would
  // silently run into the eight-layer cap and drop whatever it asked for last.
  reset(app);
  const songNo = app.setlist?.songCount ?? 0;
  const plan = photoPlan(songNo);
  // A scene goes UNDER the feel, so it has to be created before it - layers
  // composite in creation order and a backdrop added afterwards would be on top
  // of the very thing it is supposed to sit behind.
  if (plan === 'scene') sceneBackdrop(app, songNo);
  const built = feel.build(app, variant) || {};
  // Every song gets a camera comp on the LIVE bus, treated differently per
  // feel so the camera plane changes with the song rather than sitting there
  // looking the same for ninety songs.
  const camIdx = FEELS.indexOf(feel) + variant;
  // A figure goes IN FRONT of the feel's content, standing in it.
  if (plan === 'figure') figureLayer(app, songNo);
  liveCamera(app, camIdx);
  // Bus C is the two-camera picture, matched across both cameras and shaped for
  // a picture frame. Set any frame plane to C and it is there all set long.
  dualCameraPicture(app, camIdx + 2);
  // A picture frame is a small, off-white, already-painted surface, and it eats
  // contrast. Lift everything destined for a frame here rather than hand-tuning
  // fifteen feels, and leave the wall content alone.
  for (const l of app.layers.layers) {
    // Layers are named after their source at build time, so a cue built before
    // the webcam was started would carry "Webcam (not started)" into the set.
    if (l.sourceKey === 'screen') l.rename('Screen');
    else if (/^cam\d*$/.test(l.sourceKey || '')) l.rename('Camera');
    if (Math.round(params.get(`${l.ns}.group`)) === 0) continue;
    params.setBase(`${l.ns}.bright`, params.getBase(`${l.ns}.bright`) * 1.4);
    params.setBase(`${l.ns}.contrast`, params.getBase(`${l.ns}.contrast`) * 1.15);
    params.setBase(`${l.ns}.sat`, params.getBase(`${l.ns}.sat`) * 1.15);
  }
  app.setlist?.markDirty();
  return { feel, built };
}

export function buildSongCues(app, feelId, variant = 0) {
  const { built } = buildFeel(app, feelId, variant);
  const accent = built.accent || null;
  const baseline = params.snapshot();
  const cues = [];

  const capture = (plan) => {
    cues.push({ name: plan.name, morphBeats: plan.morphBeats, state: app.presets.capture() });
    params.restore(baseline);
  };

  // Intro - held back, so the first chorus has somewhere to go.
  set('master.reactivity', 0.35);
  scaleParam('master.motion', 0.6);
  scaleParam('master.brightness', 0.75);
  if (accent) set(`${accent.ns}.opacity`, 0);
  capture(CUE_PLAN[0]);

  // Verse - the feel as built.
  capture(CUE_PLAN[1]);

  // Chorus - open it up, bring the accent in.
  scaleParam('master.reactivity', 1.35);
  scaleParam('master.motion', 1.3);
  scaleParam('master.brightness', 1.1);
  if (params.getBase('fx.bloom.enabled') > 0.5) scaleParam('fx.bloom.amount', 1.3);
  if (accent) set(`${accent.ns}.opacity`, 1);
  capture(CUE_PLAN[2]);

  // Bridge - one structural change, not a pile of small ones.
  built.twist?.(app);
  capture(CUE_PLAN[3]);

  // Outro - fade toward the next song's intro.
  scaleParam('master.brightness', 0.55);
  scaleParam('master.motion', 0.4);
  scaleParam('master.reactivity', 0.6);
  if (accent) set(`${accent.ns}.opacity`, 0);
  capture(CUE_PLAN[4]);

  params.restore(baseline);
  return cues;
}

/**
 * Build a whole show. Layer/source change callbacks are muted while this runs -
 * thirty patches would otherwise rebuild the panels a couple of hundred times.
 */
export function generateShow(app, names = [], { count = 30 } = {}) {
  // An entry is a title, `{ name, feel }`, or "Title | feelId" - the last form
  // so a pasted list can carry its own feels without a second pass through the
  // UI. Anything without a feel falls back to the rotation, which is what keeps
  // neighbouring songs from looking alike.
  const titles = (names && names.length ? names : Array.from({ length: count }, (_, i) => `Song ${i + 1}`))
    .map((n) => {
      if (n && typeof n === 'object') {
        return { name: String(n.name || '').trim(), feel: n.feel || null, variant: n.variant };
      }
      const raw = String(n).trim();
      const bar = raw.lastIndexOf('|');
      if (bar < 0) return { name: raw, feel: null };
      const feel = raw.slice(bar + 1).trim();
      return FEEL_BY_ID[feel]
        ? { name: raw.slice(0, bar).trim(), feel }
        : { name: raw, feel: null };
    })
    .filter((t) => t.name);

  const layersCb = app.layers.onChange;
  const sourcesCb = app.sources.onChange;
  app.layers.onChange = () => {};
  app.sources.onChange = () => {};
  try {
    app.setlist.replaceShow({ name: app.setlist.show.name, songs: [] });
    titles.forEach((entry, i) => {
      const feelId = entry.feel || FEEL_ORDER[i % FEEL_ORDER.length];
      const variant = entry.variant != null ? entry.variant : Math.floor(i / FEEL_ORDER.length);
      const song = app.setlist.addSong(entry.name, { feel: feelId });
      song.variant = variant;
      song.cues = buildSongCues(app, feelId, variant).map((c, k) => ({
        id: `${song.id}-c${k}`, ...c,
      }));
    });
  } finally {
    app.layers.onChange = layersCb;
    app.sources.onChange = sourcesCb;
  }
  app.setlist.save();
  return app.setlist.songCount;
}

/**
 * Rebuild every song's cues from the current templates, keeping the running
 * order and the song names.
 *
 * Cues are snapshots of a whole layer stack, so a show generated before a
 * template changed keeps the old stack for ever - which is why a set built
 * last night has no camera comps in it however many the templates now add.
 * This is the way to pull a whole show forward without retyping the set list.
 *
 * @param reassign also spread the feels again across the rotation, which is how
 *   songs pick up feels that did not exist when the show was built.
 */
export function regenerateAll(app, { reassign = false } = {}) {
  const layersCb = app.layers.onChange;
  const sourcesCb = app.sources.onChange;
  app.layers.onChange = () => {};
  app.sources.onChange = () => {};
  let n = 0;
  try {
    app.setlist.songs.forEach((song, i) => {
      if (reassign || !song.feel) {
        song.feel = FEEL_ORDER[i % FEEL_ORDER.length];
        song.variant = Math.floor(i / FEEL_ORDER.length);
      }
      song.cues = buildSongCues(app, song.feel, song.variant || 0).map((c, k) => ({
        id: `${song.id}-c${k}`, ...c,
      }));
      n++;
    });
  } finally {
    app.layers.onChange = layersCb;
    app.sources.onChange = sourcesCb;
  }
  app.setlist.save();
  return n;
}

/** Rebuild one song's cues from its feel, keeping its name and position. */
export function regenerateSong(app, songIndex, feelId = null, variant = null) {
  const song = app.setlist.songs[songIndex];
  if (!song) return false;
  const layersCb = app.layers.onChange;
  app.layers.onChange = () => {};
  try {
    song.feel = feelId || song.feel || FEEL_ORDER[songIndex % FEEL_ORDER.length];
    if (variant != null) song.variant = variant;
    song.cues = buildSongCues(app, song.feel, song.variant || 0).map((c, k) => ({
      id: `${song.id}-c${k}`, ...c,
    }));
  } finally {
    app.layers.onChange = layersCb;
  }
  app.setlist.save();
  return true;
}
