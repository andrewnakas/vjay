// Curated one-click looks, expressed as layer stacks.
//
// Each look stays deliberately sparse: two or three layers, a couple of effects
// and a couple of modulation rows. A patch with everything on reads as noise and
// you stop being able to see the kick land.

import { params } from './params.js';
import { EFFECTS } from './shaders/effects.js';

export function reset(app) {
  for (const e of EFFECTS) {
    params.resetGroup(`fx.${e.id}`);
    params.setBase(`fx.${e.id}.enabled`, 0);
  }
  params.resetGroup('mix');
  params.resetGroup('master');
  // Generator and element settings persist otherwise, so a look would inherit
  // whatever the last one dialled in and stop being reproducible.
  for (const g of params.orderedGroups()) {
    if (g.ns.startsWith('gen.') || g.ns.startsWith('el.')) params.resetGroup(g.ns);
  }
  app.modulation.clear();
  for (const l of app.layers.layers) app.renderer.disposeAux(l.id);
  app.layers.clear();
}

/**
 * Add a layer.
 * @param props layer params (x, y, scale, blend, opacity, keyLow, ...)
 * @param fx    [[effectId, {param: value}], ...] applied to THIS layer only
 */
export function L(app, sourceKey, props = {}, fx = []) {
  const layer = app.addLayer(sourceKey, { select: false });
  if (!layer) return null;
  for (const k in props) params.setBase(`${layer.ns}.${k}`, props[k]);
  for (const [id, vals] of fx) {
    layer.addFx(id);
    for (const k in vals || {}) params.setBase(`${layer.fxNs(id)}.${k}`, vals[k]);
  }
  return layer;
}

export const set = (path, v) => params.setBase(path, v);
export const masterFx = (id, values = {}) => {
  params.setBase(`fx.${id}.enabled`, 1);
  for (const k in values) params.setBase(`fx.${id}.${k}`, values[k]);
};

export const LOOKS = [
  {
    id: 'calm', name: 'Calm',
    hint: 'Slow plasma, gentle colour drift. A good resting state.',
    apply(app) {
      reset(app);
      set('master.motion', 0.3);
      set('master.reactivity', 0.4);
      set('master.palette', 1);
      set('gen.plasma.speed', 0.2);
      set('gen.plasma.bands', 2);
      set('gen.plasma.reactive', 0.5);
      L(app, 'gen:plasma');
      masterFx('bloom', { mix: 0.45, amount: 0.5 });
      app.modulation.add('centroid', 'gen.plasma.warp', 0.2);
    },
  },
  {
    id: 'pulse', name: 'Pulse',
    hint: 'One clear reaction: a ring that breathes on the kick.',
    apply(app) {
      reset(app);
      set('master.motion', 0.5);
      set('master.reactivity', 1.0);
      const bg = L(app, 'gen:tunnel', { opacity: 0.85 });
      const ring = L(app, 'el:ring', { blend: 1, scale: 1 });
      masterFx('bloom', { mix: 0.7, amount: 1.0 });
      app.modulation.add('kick', `${ring.ns}.scale`, 0.2);
      app.modulation.add('beatPulse', `${bg.ns}.bright`, 0.2);
    },
  },
  {
    id: 'elements', name: 'Elements',
    hint: 'Meter, scope and sweep stacked over a slow background.',
    apply(app) {
      reset(app);
      set('master.motion', 0.35);
      set('master.reactivity', 0.85);
      set('master.palette', 6);
      L(app, 'gen:flow', { opacity: 0.7 });
      L(app, 'el:meter', { blend: 1, y: -0.62, scale: 0.42, opacity: 0.9 });
      L(app, 'el:scope', { blend: 1, scale: 0.7, opacity: 0.8 });
      L(app, 'el:sweep', { blend: 1, opacity: 0.5 });
      masterFx('bloom', { mix: 0.55, amount: 0.7 });
    },
  },
  {
    id: 'camTrails', name: 'Cam · Trails', cam: true,
    hint: 'Classic video feedback - you smear into an endless tunnel of yourself.',
    apply(app) {
      reset(app);
      set('master.motion', 0.6);
      set('master.reactivity', 0.8);
      const cam = L(app, 'cam', { sat: 1.25 }, [
        ['trails', { mix: 1, decay: 0.9, zoom: 1.012, rotate: 0.0008, tint: 0.3 }],
      ]);
      masterFx('bloom', { mix: 0.6, amount: 0.9, threshold: 0.5 });
      app.modulation.add('bass', `${cam.fxNs('trails')}.zoom`, 0.3);
      app.modulation.add('centroid', `${cam.fxNs('trails')}.tint`, 0.4);
    },
  },
  {
    id: 'camNeon', name: 'Cam · Neon', cam: true,
    hint: 'Your outline in neon over black. Reads brilliantly on a projector.',
    apply(app) {
      reset(app);
      set('master.motion', 0.5);
      set('master.reactivity', 0.9);
      set('master.palette', 3);
      const cam = L(app, 'cam', {}, [
        ['edge', { mix: 1, amount: 2.2, width: 1.4, keep: 0.06, colour: 0.9 }],
        ['mirrorBloom', { mix: 0.8, amount: 1.3, threshold: 0.2, spread: 9, chroma: 0.6 }],
        ['trails', { mix: 0.55, decay: 0.72, zoom: 1.002, rotate: 0 }],
      ]);
      app.modulation.add('mid', `${cam.fxNs('edge')}.amount`, 0.3);
      app.modulation.add('beatPulse', `${cam.fxNs('mirrorBloom')}.amount`, 0.3);
    },
  },
  {
    id: 'camMotion', name: 'Cam · Motion', cam: true,
    hint: 'Only movement is lit - hold still and you vanish into black.',
    apply(app) {
      reset(app);
      set('master.motion', 0.5);
      set('master.reactivity', 0.85);
      set('master.palette', 5);
      const cam = L(app, 'cam', {}, [
        ['motionEcho', { mix: 1, adapt: 1.4, threshold: 0.08, gain: 2.4, keep: 0.14, colour: 0.9 }],
        ['trails', { mix: 0.6, decay: 0.8, zoom: 1.004, rotate: 0.002 }],
      ]);
      masterFx('bloom', { mix: 0.7, amount: 1.1, threshold: 0.35 });
      app.modulation.add('level', `${cam.fxNs('motionEcho')}.gain`, 0.35);
    },
  },
  {
    id: 'camSmear', name: 'Cam · Smear', cam: true,
    hint: 'Slit-scan: each strip of the image lags in time. Move slowly.',
    apply(app) {
      reset(app);
      set('master.motion', 0.45);
      set('master.reactivity', 0.7);
      const cam = L(app, 'cam', {}, [
        ['timeSmear', { mix: 1, amount: 0.82, bands: 34, axis: 0, scatter: 0.8, warp: 0.15 }],
        ['colorize', { mix: 1, cycle: 0.25, sat: 1.3 }],
      ]);
      app.modulation.add('bass', `${cam.fxNs('timeSmear')}.amount`, 0.15);
    },
  },
  {
    id: 'camKaleido', name: 'Cam · Kaleido', cam: true,
    hint: 'Mirrored petals of the camera feed.',
    apply(app) {
      reset(app);
      set('master.motion', 0.5);
      set('master.reactivity', 0.8);
      const cam = L(app, 'cam', { scale: 1.3 }, [
        ['kaleido', { mix: 1, segments: 6, spin: 0.02, zoom: 0.9 }],
      ]);
      masterFx('bloom', { mix: 0.6, amount: 0.8 });
      app.modulation.add('bass', `${cam.fxNs('kaleido')}.zoom`, 0.2);
      app.modulation.add('centroid', `${cam.ns}.hue`, 0.3);
    },
  },
  {
    id: 'camSpectrum', name: 'Cam · Spectrum', cam: true,
    hint: 'Every line of your outline is pushed and lit by its own frequency band.',
    apply(app) {
      reset(app);
      set('master.motion', 0.4);
      set('master.reactivity', 0.9);
      const cam = L(app, 'cam', { sat: 1.2 }, [
        ['edge', { mix: 0.85, amount: 1.9, width: 1.2, keep: 0.25, colour: 0.7 }],
        ['specWarp', { mix: 1, amount: 0.075, axis: 0, mirror: 1, range: 0.7, sharpen: 1.5, glow: 0.5, lines: 0.4 }],
      ]);
      masterFx('bloom', { mix: 0.6, amount: 0.8, threshold: 0.4 });
      app.modulation.add('level', `${cam.fxNs('specWarp')}.amount`, 0.25);
    },
  },
  {
    id: 'camFlow', name: 'Cam · Flow', cam: true,
    hint: 'Optical-flow motion blur - moving parts smear, still parts stay sharp.',
    apply(app) {
      reset(app);
      set('master.motion', 0.4);
      set('master.reactivity', 0.7);
      const cam = L(app, 'cam', { sat: 1.15 }, [
        ['flowSmear', { mix: 1, length: 5.5, taps: 12, tail: 0.6, chroma: 0.35 }],
        ['flowTrails', { mix: 0.5, decay: 0.86, advect: 3.5, spread: 0.7, tint: 0.35 }],
      ]);
      masterFx('bloom', { mix: 0.5, amount: 0.7, threshold: 0.45 });
      app.modulation.add('level', `${cam.fxNs('flowSmear')}.length`, 0.3);
    },
  },
  {
    id: 'camInk', name: 'Cam · Ink', cam: true,
    hint: 'Move and you paint - ink follows the flow, hue set by direction.',
    apply(app) {
      reset(app);
      set('master.motion', 0.35);
      set('master.reactivity', 0.8);
      const cam = L(app, 'cam', {}, [
        ['flowPaint', { mix: 1, inject: 0.85, threshold: 0.004, advect: 4.5, decay: 0.96, keep: 0.1, hueByDir: 0.9 }],
      ]);
      masterFx('bloom', { mix: 0.6, amount: 0.9, threshold: 0.35 });
      app.modulation.add('level', `${cam.fxNs('flowPaint')}.inject`, 0.35);
    },
  },
  {
    id: 'camLiquid', name: 'Cam · Liquid', cam: true,
    hint: 'The image pushes against its own motion - everything goes elastic.',
    apply(app) {
      reset(app);
      set('master.motion', 0.4);
      set('master.reactivity', 0.85);
      set('flow.smooth', 0.7);
      const cam = L(app, 'cam', {}, [
        ['flowDisplace', { mix: 1, amount: -9, chroma: 0.45, swirl: 0.4 }],
        ['flowTrails', { mix: 0.45, decay: 0.88, advect: -2.5, spread: 1.0, tint: 0.25 }],
      ]);
      masterFx('bloom', { mix: 0.5, amount: 0.7 });
      app.modulation.add('bass', `${cam.fxNs('flowDisplace')}.amount`, -0.25);
    },
  },
  {
    id: 'camPip', name: 'Cam · PiP', cam: true,
    hint: 'Webcam framed in a corner over the visuals. Drag it on the preview.',
    apply(app) {
      reset(app);
      set('master.motion', 0.4);
      set('master.reactivity', 0.7);
      set('master.palette', 5);
      L(app, 'gen:flow');
      const cam = L(app, 'cam', {
        x: 0.72, y: 0.5, scale: 0.4, fit: 1, radius: 0.12, feather: 0.004,
      });
      L(app, 'el:frame', {
        x: 0.72, y: 0.5, scale: 0.4, blend: 1, opacity: 0.8,
      });
      masterFx('bloom', { mix: 0.5, amount: 0.7 });
      app.modulation.add('bass', `${cam.ns}.scale`, 0.06);
    },
  },
  {
    id: 'camOverlay', name: 'Cam · Overlay', cam: true,
    hint: 'Camera full frame with a meter, ring and sweep laid over it.',
    apply(app) {
      reset(app);
      set('master.motion', 0.4);
      set('master.reactivity', 0.85);
      set('master.palette', 0);
      L(app, 'cam', { sat: 0.85, bright: 0.85 });
      L(app, 'el:meter', { blend: 1, y: -0.66, scale: 0.34, opacity: 0.85 });
      const ring = L(app, 'el:ring', { blend: 1, scale: 0.8, opacity: 0.7 });
      L(app, 'el:sweep', { blend: 1, opacity: 0.35 });
      masterFx('bloom', { mix: 0.5, amount: 0.7 });
      app.modulation.add('bass', `${ring.ns}.scale`, 0.12);
    },
  },
  {
    id: 'dualCam', name: 'Dual Cam', cam: true,
    hint: 'Two cameras side by side. Start both in Sources; IR reads as greyscale so it gets a palette.',
    apply(app) {
      reset(app);
      set('master.motion', 0.35);
      set('master.reactivity', 0.75);
      set('master.palette', 5);
      L(app, 'gen:flow', { opacity: 0.55 });
      L(app, 'cam', { x: -0.5, scale: 0.52, fit: 1, radius: 0.05 });
      // An IR sensor is greyscale, so map its luminance onto the palette
      // instead of trying to correct colour that was never there.
      L(app, 'cam2', { x: 0.5, scale: 0.52, fit: 1, radius: 0.05 }, [
        ['paletteMap', { mix: 0.85, spread: 1.5, preserve: 0.2, drive: 0.3 }],
      ]);
      masterFx('bloom', { mix: 0.5, amount: 0.7 });
    },
  },
  {
    id: 'kinectDepth', name: 'Kinect · Depth Key', cam: true,
    hint: 'Depth-keyed cut-out over generated visuals. Set the layer matte to the Kinect Depth camera.',
    apply(app) {
      reset(app);
      set('master.motion', 0.35);
      set('master.reactivity', 0.8);
      set('master.palette', 6);
      L(app, 'gen:flow');
      // Colour on cam, depth on cam2 - the order ./tools/kinect.sh starts them in.
      const person = L(app, 'cam', {
        matteMode: 1, matteNear: 0.02, matteFar: 0.35, matteSoft: 0.03, sat: 1.1,
      }, [
        ['depthWarp', { mix: 0.5, amount: 0.06, mode: 0, audio: 0.8 }],
      ]);
      person.matteKey = 'cam2';
      masterFx('bloom', { mix: 0.55, amount: 0.8 });
      app.modulation.add('bass', `${person.fxNs('depthWarp')}.amount`, 0.25);
      app.modulation.add('centroid', `${person.ns}.hue`, 0.2);
    },
  },
  {
    id: 'camGrid', name: 'Cam · Grid', cam: true,
    hint: 'Four camera tiles over the visuals - drag any of them to rearrange.',
    apply(app) {
      reset(app);
      set('master.motion', 0.35);
      set('master.reactivity', 0.75);
      set('master.palette', 2);
      L(app, 'gen:plasma', { opacity: 0.8 });
      const spots = [[-0.5, 0.5], [0.5, 0.5], [-0.5, -0.5], [0.5, -0.5]];
      spots.forEach(([x, y], i) => {
        L(app, 'cam', { x, y, scale: 0.48, radius: 0.06, hue: i * 0.08, blend: i % 2 ? 2 : 0 });
      });
      masterFx('bloom', { mix: 0.5, amount: 0.6 });
    },
  },
];

export function applyLook(app, look) {
  look.apply(app);
  // A look replaces the whole patch, so the cue the transport names is no
  // longer what is on screen. Say so rather than let the readout lie.
  app.setlist?.markDirty();
  if (app.layers.layers.length) app.layers.select(app.layers.layers.at(-1).id);
  app.ui.rebuildModRows();
  app.ui.refreshGeneratorPanels();
  return look;
}
