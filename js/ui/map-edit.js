// Dragging projection surfaces on the preview, and dragging what is inside them.
//
// Two tools, one shared overlay canvas. Corners move the quad; Picture moves
// what the quad SHOWS, per plane, which is the only per-plane control there is
// when eight planes share one comp.
//
// Corner handles are live whenever the Setup tab is open - no mode to arm - so
// this shares the overlay with CanvasEditor rather than replacing it: a drag
// that misses a handle falls through to the layer under it, and both sets of
// handles are drawn. `blocksPointer` is the line between them.
//
// Corner points are in the same 0..1 output space the output pass samples, so
// what you drag here is exactly what lands on the wall.

import { params } from '../params.js';
import { MAX_SURFACES } from '../mapping.js';
import { applyH, CAM_W, CAM_H } from '../calibrate.js';

const HANDLE = 11;      // half-size of a drawn corner handle, css px
const GRAB = 22;        // how close a click has to be to count as grabbing one
const CORNER_KEYS = ['1', '2', '3', '4'];

/** Same convention as rot2() in the GLSL library, so a drag matches the shader. */
function rot2(x, y, a) {
  const c = Math.cos(a); const sn = Math.sin(a);
  return [c * x + sn * y, -sn * x + c * y];
}

export class MapEditor {
  constructor(app, glCanvas, overlay) {
    this.app = app;
    this.gl = glCanvas;
    this.canvas = overlay;
    this.ctx = overlay.getContext('2d');
    this.enabled = false;
    // 'corners' drags the quad; 'picture' drags what is INSIDE the quad. They
    // want the same pointer, so only one is ever live.
    this.tool = 'corners';
    this.showCamera = false;    // rectified camera feed behind the surfaces
    this.drag = null;
    this._hoverPlane = -1;      // which plane the Picture tool would act on
    this.onChange = () => {};
    this._bind();
  }

  get mapping() { return this.app.mapping; }

  /** Setup is the tab you are on while aligning and never during a song. */
  get setupOpen() {
    return document.querySelector('.tab.active')?.dataset.tab === 'map';
  }

  /**
   * Corner handles are grabbable. Deliberately NOT gated on an armed mode: the
   * complaint was having to remember to arm one. The Setup tab being open is
   * itself the statement of intent, and plane LOCK is the hard guarantee that
   * a finished alignment cannot move.
   */
  get cornersLive() {
    return this.tool === 'corners'
      && this.app.view.mode === 'output'
      && (this.enabled || this.setupOpen);
  }

  /** Dragging the picture works in the output view and in a plane's own view. */
  get pictureLive() { return this.tool === 'picture'; }

  /**
   * Where the Picture tool is allowed to stay armed: the Setup tab, or a plane
   * comped on its own. Both mean "I am setting up". Anywhere else it disarms
   * itself, so a tool left on during alignment cannot still be waiting to move
   * a picture when someone clicks the preview three songs into the set.
   */
  get setupContext() { return this.setupOpen || this.app.view.mode === 'plane'; }

  get live() { return this.cornersLive || this.pictureLive; }

  /**
   * Does this editor want every drag, or only the ones that land on a handle?
   * Corners-live is passive: a drag that misses a handle falls through to the
   * layer editor, so layer handles keep working while corners stay grabbable.
   */
  get blocksPointer() {
    return this.pictureLive || (this.enabled && this.tool === 'corners');
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.enabled) this.tool = 'corners';
    this.sync();
  }

  /** @param tool 'corners' or 'picture'; picture also works inside a plane view. */
  setTool(tool) {
    this.tool = tool === 'picture' ? 'picture' : 'corners';
    if (this.tool === 'picture') this.enabled = false;
    this.drag = null;
    this.sync();
  }

  /**
   * Re-derive what the overlay is allowed to do. Called on a tool change, and
   * also on a tab or view change - `cornersLive` reads both, so the pointer
   * gating would otherwise be a frame (or a whole session) out of date.
   */
  sync() {
    if (this.tool === 'picture' && !this.setupContext) {
      this.tool = 'corners';
      this.drag = null;
    }
    // The test pattern marks the live corner on the wall only while corners are
    // actually being dragged - a pulsing dot in a finished mapping is noise.
    this.mapping.editing = this.enabled && this.tool === 'corners';
    // The overlay only receives pointer events when the stage is in edit mode,
    // and both of these tools need them whether or not layer handles show.
    const wrap = document.querySelector('.stage-wrap');
    if (this.live) wrap?.classList.remove('noedit');
    else if (!this.app.editor.enabled) wrap?.classList.add('noedit');
    this.onChange();
  }

  /** Measure the overlay, not the GL canvas: the overlay is what receives
   *  the pointer, so any drift between the two lands clicks off-target. */
  _rect() { return this.canvas.getBoundingClientRect(); }

  _resize() {
    const r = this._rect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
  }

  get view() { return this.app.previewView || { zoom: 1, x: 0, y: 0 }; }

  /** Canvas 0..1 (y up) -> output space, through the preview zoom. */
  _toOut(sx, sy) {
    const v = this.view;
    return { x: (sx - 0.5) / v.zoom + 0.5 + v.x, y: (sy - 0.5) / v.zoom + 0.5 + v.y };
  }

  /** Output space -> canvas 0..1, y up. */
  _toCanvas(x, y) {
    const v = this.view;
    return { x: (x - 0.5 - v.x) * v.zoom + 0.5, y: (y - 0.5 - v.y) * v.zoom + 0.5 };
  }

  /** Pointer -> output space: 0..1 with y up, matching the corner params. */
  _norm(e) {
    const r = this._rect();
    const p = this._toOut((e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height);
    return { x: p.x, y: p.y, r };
  }

  /**
   * Is this point inside surface i? Asked of the warp itself, so any quad works.
   *
   * @returns the point in the plane's own 0..1 space - which is exactly the `s`
   *   the output shader computes before it applies variation - or null.
   */
  _inside(i, x, y) {
    const m = this.mapping.homography(i);      // column-major mat3
    const w = m[2] * x + m[5] * y + m[8];
    if (Math.abs(w) < 1e-9) return null;
    const u = (m[0] * x + m[3] * y + m[6]) / w;
    const v = (m[1] * x + m[4] * y + m[7]) / w;
    if (!(w > 0 && u >= 0 && u <= 1 && v >= 0 && v <= 1)) return null;
    return { u, v };
  }

  /** Topmost plane under an output-space point; later planes draw over earlier. */
  _planeAt(x, y, { skipLocked = false } = {}) {
    const active = this.mapping.activeSurfaces();
    for (let k = active.length - 1; k >= 0; k--) {
      const i = active[k];
      if (skipLocked && this.mapping.isLocked(i)) continue;
      const s = this._inside(i, x, y);
      if (s) return { surface: i, s };
    }
    return null;
  }

  /**
   * The plane under the pointer and the point in that plane's own 0..1 space,
   * whichever view we are in.
   *
   * In a plane's own view the preview is that one plane drawn flat into a
   * letterboxed rect, so plane-local space is just that rect - no homography.
   * `app.planeView()` is the same rect the renderer used this frame, which is
   * what keeps the picture and the pointer from disagreeing.
   */
  _planeLocal(e) {
    const pv = this.app.planeView?.();
    const r = this._rect();
    const cx = (e.clientX - r.left) / r.width;
    const cy = 1 - (e.clientY - r.top) / r.height;
    if (pv) {
      const [rx, ry, rw, rh] = pv.rect;
      const u = (cx - rx) / Math.max(rw, 1e-6);
      const v = (cy - ry) / Math.max(rh, 1e-6);
      if (u < 0 || u > 1 || v < 0 || v > 1) return null;
      return { surface: pv.surface, s: { u, v } };
    }
    const p = this._toOut(cx, cy);
    return this._planeAt(p.x, p.y);
  }

  /**
   * How far the SAMPLING window must move to keep the picture under the finger.
   *
   * The shader reads `t = rot(mirror(s - 0.5)) / zoom + 0.5 + pan`, so holding
   * `t` fixed while `s` moves means `pan` moves by the negated, mirrored,
   * rotated, zoom-divided delta. Doing it here rather than in screen space is
   * what makes the drag track the pointer on a keystoned or rotated plane.
   */
  _panDelta(i, du, dv) {
    const v = this.mapping.variation(i);
    let dx = v.mirror[0] > 0.5 ? -du : du;
    let dy = v.mirror[1] > 0.5 ? -dv : dv;
    if (Math.abs(v.rot) > 1e-4) {
      const crop = this.mapping.crop(i);
      const aspect = (crop[2] * this.app.renderer.width)
        / Math.max(crop[3] * this.app.renderer.height, 1e-6);
      const r = rot2(dx * aspect, dy, v.rot);
      dx = r[0] / aspect;
      dy = r[1];
    }
    const z = Math.max(v.zoom, 0.01);
    return [-dx / z, -dy / z];
  }

  _hitTest(nx, ny, r) {
    const map = this.mapping;
    const active = map.activeSurfaces();
    const z = this.view.zoom;
    const tolX = GRAB / (r.width * z);
    const tolY = GRAB / (r.height * z);

    // Corners win over interiors, and ANY enabled surface's corners count - not
    // just the selected one. Checking only the selection meant a click near an
    // unselected plane's corner fell through to "move the whole plane", which
    // is the opposite of what a corner handle is for. The selected surface is
    // still searched first so stacked quads stay editable.
    const order = [map.selected, ...active.filter((i) => i !== map.selected)];
    let best = null;
    let bestD = Infinity;
    for (const i of order) {
      if (!active.includes(i) || map.isLocked(i)) continue;
      const pts = map.corners(i);
      for (let c = 0; c < 4; c++) {
        const dx = (nx - pts[c][0]) / tolX;
        const dy = (ny - pts[c][1]) / tolY;
        const d = Math.hypot(dx, dy);
        if (d > 1) continue;
        // A tie goes to the selected surface, which is first in `order`.
        const bias = i === map.selected ? 0 : 0.35;
        if (d + bias < bestD) { bestD = d + bias; best = { surface: i, mode: 'corner', corner: c }; }
      }
    }
    if (best) return best;

    // Then the topmost surface under the pointer - but only when the Corners
    // tool is actually armed. Sliding a whole plane is the destructive one, so
    // it keeps needing a deliberate mode; grabbing a 22px handle does not.
    if (!this.enabled) return null;
    const body = this._planeAt(nx, ny, { skipLocked: true });
    return body ? { surface: body.surface, mode: 'move' } : null;
  }

  _bind() {
    const c = this.canvas;

    c.addEventListener('pointerdown', (e) => {
      if (this.pictureLive) { this._picturePointerDown(e); return; }
      if (!this.cornersLive) return;
      const { x, y, r } = this._norm(e);
      const hit = this._hitTest(x, y, r);
      // Nothing grabbed: let it fall through to the layer handles rather than
      // swallowing the click. Corners are live all through Setup, so eating
      // every drag would make the layer editor unreachable there.
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      this.mapping.selected = hit.surface;
      if (hit.mode === 'corner') this.mapping.lastCorner = hit.corner;
      try { c.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
      const base = this.mapping.corners(hit.surface);
      // Grab OFFSET, not grab-and-teleport. `setCorner` takes an absolute
      // position, so writing the pointer straight into it jumped the corner to
      // wherever you clicked - up to 22px of unasked-for movement before the
      // drag had even started, on the one control that has to be exact.
      const grab = hit.mode === 'corner'
        ? [base[hit.corner][0] - x, base[hit.corner][1] - y]
        : [0, 0];
      this.drag = { ...hit, startX: x, startY: y, grab, base };
      this.onChange();
    }, true);

    c.addEventListener('pointermove', (e) => {
      if (this.pictureLive) { this._picturePointerMove(e); return; }
      if (!this.cornersLive) return;
      const { x, y, r } = this._norm(e);
      if (!this.drag) {
        const hit = this._hitTest(x, y, r);
        // Only claim the cursor when there is something here to grab. With
        // layer handles up, the layer editor's own pointermove runs after this
        // one and gets the last word; with them down, nothing else would put
        // the cursor back.
        if (hit) c.style.cursor = hit.mode === 'corner' ? 'crosshair' : 'move';
        else if (!this.app.editor.enabled) c.style.cursor = 'default';
        const hoverCorner = hit && hit.mode === 'corner' ? `${hit.surface}:${hit.corner}` : null;
        if (hoverCorner !== this._hoverCorner) { this._hoverCorner = hoverCorner; }
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const d = this.drag;
      if (d.mode === 'corner') {
        this.mapping.setCorner(d.surface, d.corner, x + d.grab[0], y + d.grab[1]);
      } else {
        const dx = x - d.startX;
        const dy = y - d.startY;
        for (let k = 0; k < 4; k++) {
          this.mapping.setCorner(d.surface, k, d.base[k][0] + dx, d.base[k][1] + dy);
        }
      }
    }, true);

    const end = (e) => {
      if (!this.drag) return;
      try { c.releasePointerCapture(e.pointerId); } catch (_) {}
      this.drag = null;
    };
    c.addEventListener('pointerup', end, true);
    c.addEventListener('pointercancel', end, true);

    // Pinch zooms; a plain two-finger scroll pans. Browsers report a trackpad
    // pinch as a wheel event with ctrlKey set, and an ordinary two-finger
    // scroll without it - so treating every wheel as zoom means the picture
    // rescales whenever you rest two fingers on the pad, which is not something
    // you want happening while you line a corner up.
    c.addEventListener('wheel', (e) => {
      // Picture tool: Alt+wheel zooms what is inside the plane, Alt+Shift turns
      // it. Same modifiers the layer editor uses, and for the same reason - a
      // bare wheel is two fingers resting on a trackpad and must do nothing.
      if (this.pictureLive) {
        if (!e.altKey) return;
        const hit = this._planeLocal(e);
        if (!hit) return;
        e.preventDefault();
        e.stopPropagation();
        const ns = this.mapping.ns(hit.surface);
        if (e.shiftKey) {
          params.setBase(`${ns}.vRot`, params.getBase(`${ns}.vRot`) - e.deltaY * 0.002);
        } else {
          const z = params.getBase(`${ns}.vZoom`) || 1;
          params.setBase(`${ns}.vZoom`, z * (1 - e.deltaY * 0.004));
        }
        this.mapping.onChange();
        this.onChange();
        return;
      }
      if (!this.cornersLive) return;
      const v = this.view;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = this._rect();
        const sx = (e.clientX - r.left) / r.width;
        const sy = 1 - (e.clientY - r.top) / r.height;
        const before = this._toOut(sx, sy);
        const next = this.app.setPreviewZoom(v.zoom * (1 - e.deltaY * 0.004));
        const after = this._toOut(sx, sy);
        // Keep whatever was under the pointer under the pointer.
        this.app.setPreviewZoom(next.zoom, {
          x: next.x + (after.x - before.x),
          y: next.y + (after.y - before.y),
        });
        this.onChange();
        return;
      }
      // Panning only means anything once there is something outside the frame.
      if (v.zoom === 1) return;
      e.preventDefault();
      const r = this._rect();
      this.app.setPreviewZoom(v.zoom, {
        x: v.x + e.deltaX / (r.width * v.zoom),
        y: v.y - e.deltaY / (r.height * v.zoom),
      });
      this.onChange();
    }, { passive: false });

    // Double-clicking a plane while corners are NOT being dragged is the fast
    // way into comping it: the preview becomes that plane, the projector does
    // not change.
    c.addEventListener('dblclick', (e) => {
      // In the Picture tool, a double-click puts that plane's picture back where
      // it started - the way out of a drag that went somewhere odd.
      if (this.pictureLive) {
        const hit = this._planeLocal(e);
        if (!hit) return;
        e.preventDefault();
        e.stopPropagation();
        this.resetPicture(hit.surface);
        return;
      }
      if (this.enabled) return;
      if (this.app.view.mode === 'plane') return;
      const { x, y } = this._norm(e);
      const body = this._planeAt(x, y);
      if (body) {
        e.preventDefault();
        this.app.ui.viewUI.select(body.surface);
      }
    });
  }

  /**
   * Start dragging the picture inside a plane.
   *
   * A LOCKED plane is deliberately still pannable. Lock means "this quad is
   * nailed to the wall now", and placing the image inside a frame you have just
   * finished aligning is precisely when you want it - locking the geometry must
   * not lock the picture too.
   */
  _picturePointerDown(e) {
    const hit = this._planeLocal(e);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    const ns = this.mapping.ns(hit.surface);
    this.mapping.selected = hit.surface;
    // At 1x there is no slack: the sampler mirrors at the edge of the comp, so
    // panning immediately folds the picture back on itself. Say it once rather
    // than quietly changing the zoom out from under the drag.
    if (!this._foldWarned && Math.abs(params.getBase(`${ns}.vZoom`) - 1) < 1e-3) {
      this._foldWarned = true;
      this.app.toast('Alt+wheel to zoom in first, or the edges fold back as you pan');
    }
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
    this.drag = {
      mode: 'pan',
      surface: hit.surface,
      s0: hit.s,
      base: [params.getBase(`${ns}.vPanX`), params.getBase(`${ns}.vPanY`)],
    };
    this.onChange();
  }

  _picturePointerMove(e) {
    const c = this.canvas;
    if (!this.drag) {
      const hit = this._planeLocal(e);
      this._hoverPlane = hit ? hit.surface : -1;
      c.style.cursor = hit ? 'grab' : 'default';
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    c.style.cursor = 'grabbing';
    const d = this.drag;
    // Re-measure in the plane's own space rather than tracking a screen delta:
    // under a keystone the same number of pixels is a different amount of
    // picture at the near and far edges, and the eye notices immediately.
    const hit = this._planeLocalFor(d.surface, e);
    if (!hit) return;
    const [dx, dy] = this._panDelta(d.surface, hit.s.u - d.s0.u, hit.s.v - d.s0.v);
    const ns = this.mapping.ns(d.surface);
    params.setBase(`${ns}.vPanX`, d.base[0] + dx);
    params.setBase(`${ns}.vPanY`, d.base[1] + dy);
    this.mapping.onChange();
  }

  /**
   * Plane-local coordinates for ONE plane, even once the pointer has left it -
   * a drag has to keep working past the edge of the quad it started in.
   */
  _planeLocalFor(i, e) {
    const pv = this.app.planeView?.();
    const r = this._rect();
    const cx = (e.clientX - r.left) / r.width;
    const cy = 1 - (e.clientY - r.top) / r.height;
    if (pv) {
      if (pv.surface !== i) return null;
      const [rx, ry, rw, rh] = pv.rect;
      return { surface: i, s: { u: (cx - rx) / Math.max(rw, 1e-6), v: (cy - ry) / Math.max(rh, 1e-6) } };
    }
    const p = this._toOut(cx, cy);
    const m = this.mapping.homography(i);
    const w = m[2] * p.x + m[5] * p.y + m[8];
    if (!(w > 1e-9)) return null;
    return {
      surface: i,
      s: {
        u: (m[0] * p.x + m[3] * p.y + m[6]) / w,
        v: (m[1] * p.x + m[4] * p.y + m[7]) / w,
      },
    };
  }

  /** Put one plane's picture back to un-panned, un-zoomed, un-turned. */
  resetPicture(i) {
    const ns = this.mapping.ns(i);
    for (const k of ['vPanX', 'vPanY', 'vRot']) params.setBase(`${ns}.${k}`, 0);
    params.setBase(`${ns}.vZoom`, 1);
    this.mapping.onChange();
    this.app.toast(`${this.mapping.name(i)}: picture reset`);
    this.onChange();
  }

  /** Returns true when the key was consumed. */
  handleKey(e) {
    if (this.pictureLive) return this._pictureKey(e);
    if (!this.cornersLive) return false;
    const map = this.mapping;
    const r = this._rect();
    const stepPx = e.shiftKey ? 10 : 1;
    const z = this.view.zoom;
    const dx = stepPx / Math.max(r.width * z, 1);
    const dy = stepPx / Math.max(r.height * z, 1);
    if (map.isLocked(map.selected) && /^Arrow/.test(e.key)) {
      this.app.toast(`${map.name(map.selected)} is locked — unlock it in Setup to move it`);
      return true;
    }
    const nudge = (ax, ay) => {
      if (e.altKey) {
        map.moveSurface(map.selected, ax, ay);
      } else {
        const p = map.corners(map.selected)[map.lastCorner];
        map.setCorner(map.selected, map.lastCorner, p[0] + ax, p[1] + ay);
      }
      this.onChange();
    };

    switch (e.key) {
      case 'ArrowLeft': nudge(-dx, 0); return true;
      case 'ArrowRight': nudge(dx, 0); return true;
      case 'ArrowUp': nudge(0, dy); return true;
      case 'ArrowDown': nudge(0, -dy); return true;
      case 'Tab': {
        const active = map.activeSurfaces();
        if (active.length) {
          const i = active.indexOf(map.selected);
          map.selected = active[(i + (e.shiftKey ? active.length - 1 : 1)) % active.length];
          this.app.toast(`Surface ${map.selected + 1}: ${map.name(map.selected)}`);
          this.onChange();
        }
        return true;
      }
      default: break;
    }
    if (CORNER_KEYS.includes(e.key)) {
      map.lastCorner = CORNER_KEYS.indexOf(e.key);
      this.onChange();
      return true;
    }
    return false;
  }

  /**
   * Arrows nudge the selected plane's picture while the Picture tool is up.
   * Same step as a corner nudge, so the two tools feel like one control.
   */
  _pictureKey(e) {
    const map = this.mapping;
    const i = map.selected;
    if (!map.enabled(i)) return false;
    const r = this._rect();
    const stepPx = e.shiftKey ? 10 : 1;
    const step = stepPx / Math.max(r.width * this.view.zoom, 1);
    const ns = map.ns(i);
    const nudge = (au, av) => {
      const [dx, dy] = this._panDelta(i, au, av);
      params.setBase(`${ns}.vPanX`, params.getBase(`${ns}.vPanX`) + dx);
      params.setBase(`${ns}.vPanY`, params.getBase(`${ns}.vPanY`) + dy);
      map.onChange();
      this.onChange();
    };
    switch (e.key) {
      case 'ArrowLeft': nudge(-step, 0); return true;
      case 'ArrowRight': nudge(step, 0); return true;
      case 'ArrowUp': nudge(0, step); return true;
      case 'ArrowDown': nudge(0, -step); return true;
      case 'Tab': {
        const active = map.activeSurfaces();
        if (active.length) {
          const k = active.indexOf(i);
          map.selected = active[(k + (e.shiftKey ? active.length - 1 : 1)) % active.length];
          this.app.toast(`Picture: ${map.name(map.selected)}`);
          this.onChange();
        }
        return true;
      }
      default: return false;
    }
  }

  /**
   * One textured triangle. Canvas 2D has no perspective transform, so a warp is
   * built from affine pieces - enough of them and the seams disappear.
   */
  _tri(img, s0, s1, s2, d0, d1, d2) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(d0[0], d0[1]);
    ctx.lineTo(d1[0], d1[1]);
    ctx.lineTo(d2[0], d2[1]);
    ctx.closePath();
    ctx.clip();
    const [x0, y0] = s0; const [x1, y1] = s1; const [x2, y2] = s2;
    const den = x0 * (y2 - y1) - x1 * y2 + x2 * y1 + (x1 - x2) * y0;
    if (Math.abs(den) < 1e-9) { ctx.restore(); return; }
    const m11 = -(y0 * (d2[0] - d1[0]) - y1 * d2[0] + y2 * d1[0] + (y1 - y2) * d0[0]) / den;
    const m12 = (y1 * d2[1] + y0 * (d1[1] - d2[1]) - y2 * d1[1] + (y2 - y1) * d0[1]) / den;
    const m21 = (x0 * (d2[0] - d1[0]) - x1 * d2[0] + x2 * d1[0] + (x1 - x2) * d0[0]) / den;
    const m22 = -(x1 * d2[1] + x0 * (d1[1] - d2[1]) - x2 * d1[1] + (x2 - x1) * d0[1]) / den;
    const dx = (x0 * (y2 * d1[0] - y1 * d2[0]) + y0 * (x1 * d2[0] - x2 * d1[0])
      + (x2 * y1 - x1 * y2) * d0[0]) / den;
    const dy = (x0 * (y2 * d1[1] - y1 * d2[1]) + y0 * (x1 * d2[1] - x2 * d1[1])
      + (x2 * y1 - x1 * y2) * d0[1]) / den;
    ctx.transform(m11, m12, m21, m22, dx, dy);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  /**
   * The camera's view of the wall, warped into projector space and drawn behind
   * the surfaces. That is what makes placing a surface on a real picture frame
   * possible from the laptop: in this view, where the picture appears IS where
   * the projector has to put it.
   */
  _drawCameraBackdrop() {
    const res = this.app.calibrator?.lastResult;
    const cam = this.app.calibrator?.camera;
    if (!cam || !cam.video || cam.video.videoWidth === 0) return false;
    const H = res && res.ok ? res.homography : null;
    const ctx = this.ctx;
    const W = this.canvas.width;
    const Hh = this.canvas.height;

    if (!H) {
      // No calibration yet: show it raw, as a framing aid only.
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.drawImage(cam.video, 0, 0, W, Hh);
      ctx.restore();
      return 'raw';
    }

    // Working-space camera pixels -> the video's own pixels.
    const sx = cam.video.videoWidth / CAM_W;
    const sy = cam.video.videoHeight / CAM_H;
    const N = 16, M = 10;
    ctx.save();
    ctx.globalAlpha = 0.5;
    for (let j = 0; j < M; j++) {
      for (let i = 0; i < N; i++) {
        const uv = [[i / N, j / M], [(i + 1) / N, j / M], [(i + 1) / N, (j + 1) / M], [i / N, (j + 1) / M]];
        const src = uv.map(([u, v]) => {
          const c = applyH(H, u, v);
          return c ? [c[0] * sx, c[1] * sy] : null;
        });
        if (src.some((c) => !c)) continue;
        // Projector uv -> overlay pixels. y is up in uv, down on a canvas.
        const dst = uv.map(([u, v]) => [u * W, (1 - v) * Hh]);
        this._tri(cam.video, src[0], src[1], src[2], dst[0], dst[1], dst[2]);
        this._tri(cam.video, src[0], src[2], src[3], dst[0], dst[2], dst[3]);
      }
    }
    ctx.restore();
    return 'rectified';
  }

  /**
   * @param clear false to draw ON TOP of what the layer editor has already put
   *   on the shared overlay. Corners are live all through Setup while layer
   *   handles keep working, so both sets of handles have to be visible - and
   *   whichever drew second would otherwise wipe the first.
   */
  draw(clear = true) {
    // ALWAYS measure. `_resize` is where `dpr` comes from, and every handle size
    // and font is scaled by it - skipping it here left `dpr` undefined, which
    // made those NaN, which canvas silently ignores: the quad outlines still
    // drew (they scale by canvas size) and not one handle did. It only reassigns
    // width/height when they actually changed, so it does not wipe what the
    // layer editor has already drawn.
    this._resize();
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (clear) ctx.clearRect(0, 0, W, H);
    if (!this.live) return;
    if (this.pictureLive) { this._drawPicture(W, H); return; }

    let backdrop = false;
    if (this.showCamera) backdrop = this._drawCameraBackdrop();

    const map = this.mapping;
    const s = this.dpr;
    const toPx = (p) => {
      const c = this._toCanvas(p[0], p[1]);
      return [c.x * W, (1 - c.y) * H];
    };

    // Zoomed out, the canvas shows more than the projector does. Mark where the
    // projector's own frame ends, or there is no telling which corners land on
    // the wall and which fall off it.
    if (this.view.zoom !== 1) {
      const a = this._toCanvas(0, 0);
      const b = this._toCanvas(1, 1);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,199,95,0.75)';
      ctx.setLineDash([7 * s, 5 * s]);
      ctx.lineWidth = 1.5 * s;
      ctx.strokeRect(a.x * W, (1 - b.y) * H, (b.x - a.x) * W, (b.y - a.y) * H);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,199,95,0.9)';
      ctx.font = `${11 * s}px ui-monospace, monospace`;
      ctx.fillText(`projector edge · ${(this.view.zoom * 100).toFixed(0)}%`,
        a.x * W + 6 * s, (1 - b.y) * H + 14 * s);
      ctx.restore();
    }

    if (backdrop === 'raw') {
      ctx.fillStyle = 'rgba(255,199,95,0.95)';
      ctx.font = `${12 * s}px ui-monospace, monospace`;
      ctx.fillText('camera not calibrated — run Auto-map to align this view', 10 * s, 18 * s);
    }

    for (let i = 0; i < MAX_SURFACES; i++) {
      if (params.get(`${map.ns(i)}.enabled`) < 0.5) continue;
      const sel = i === map.selected;
      const locked = map.isLocked(i);
      const pts = map.corners(i);
      ctx.lineWidth = (sel ? 2 : 1) * s;
      ctx.strokeStyle = locked ? 'rgba(150,160,180,0.45)'
        : sel ? 'rgba(94,233,181,0.95)' : 'rgba(122,162,255,0.5)';
      ctx.setLineDash(sel ? [] : [5 * s, 4 * s]);
      ctx.beginPath();
      pts.forEach((p, k) => {
        const [px, py] = toPx(p);
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      const cx = pts.reduce((a, p) => a + p[0], 0) / 4;
      const cy = pts.reduce((a, p) => a + p[1], 0) / 4;
      const [lx, ly] = toPx([cx, cy]);
      ctx.font = `${(sel ? 13 : 11) * s}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = sel ? 'rgba(94,233,181,0.95)' : 'rgba(200,210,230,0.6)';
      ctx.fillText(`${locked ? '🔒 ' : ''}${i + 1} · ${map.name(i)}`, lx, ly);
      ctx.textAlign = 'left';

      // Unselected surfaces get smaller handles rather than none: they are
      // grabbable, so they have to look grabbable. A locked one is not, so it
      // gets none - `continue`, not `return`, or every plane after it in the
      // list stops being drawn at all.
      if (locked) continue;
      const size = (sel ? HANDLE : HANDLE * 0.6) * s;
      pts.forEach((p, k) => {
        const [px, py] = toPx(p);
        const hot = sel && k === map.lastCorner;
        const linked = map.isLinked(i, k);
        ctx.beginPath();
        if (linked) {
          // A crease corner moves both planes at once. Round, so it does not
          // look like something you can pull apart.
          ctx.arc(px, py, size * 1.15, 0, Math.PI * 2);
        } else {
          ctx.rect(px - size, py - size, size * 2, size * 2);
        }
        ctx.fillStyle = hot ? 'rgba(94,233,181,0.85)'
          : linked ? 'rgba(122,162,255,0.55)' : 'rgba(10,13,20,0.9)';
        ctx.fill();
        ctx.stroke();
        if (!sel) return;
        ctx.fillStyle = hot ? '#07080c' : 'rgba(230,234,243,0.9)';
        ctx.font = `${10 * s}px ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(String(k + 1), px, py + 3.5 * s);
        ctx.textAlign = 'left';
      });
    }
  }

  /**
   * The Picture tool's overlay: which plane the drag will land on, and what its
   * picture is currently doing. Deliberately thin - the point of this view is
   * to look at the picture, not at chrome drawn over it.
   */
  _drawPicture(W, H) {
    const ctx = this.ctx;
    const map = this.mapping;
    const s = this.dpr;
    const pv = this.app.planeView?.();
    const active = map.activeSurfaces();
    const focus = this.drag ? this.drag.surface
      : this._hoverPlane >= 0 ? this._hoverPlane : map.selected;

    // On a plate behind it: this is drawn over whatever the plane is showing,
    // and a bright comp swallows unbacked text completely. Checked by looking
    // at it, not by assuming.
    const label = (i, px, py) => {
      const v = map.variation(i);
      const moved = Math.abs(v.pan[0]) > 1e-4 || Math.abs(v.pan[1]) > 1e-4
        || Math.abs(v.zoom - 1) > 1e-4 || Math.abs(v.rot) > 1e-4;
      const name = map.name(i);
      const detail = moved
        ? `pan ${v.pan[0].toFixed(2)}, ${v.pan[1].toFixed(2)} · ${v.zoom.toFixed(2)}×`
          + (Math.abs(v.rot) > 1e-4 ? ` · ${(v.rot * 180 / Math.PI).toFixed(0)}°` : '')
        : 'drag to move the picture';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `${12 * s}px ui-monospace, monospace`;
      const w1 = ctx.measureText(name).width;
      ctx.font = `${10 * s}px ui-monospace, monospace`;
      const w2 = ctx.measureText(detail).width;
      const pad = 7 * s;
      const bw = Math.max(w1, w2) + pad * 2;
      const bh = 34 * s;
      ctx.fillStyle = 'rgba(7,8,12,0.78)';
      ctx.strokeStyle = 'rgba(94,233,181,0.45)';
      ctx.lineWidth = 1 * s;
      const bx = px - bw / 2; const by = py - bh / 2;
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 5 * s); ctx.fill(); ctx.stroke(); }
      else { ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx, by, bw, bh); }
      ctx.font = `${12 * s}px ui-monospace, monospace`;
      ctx.fillStyle = 'rgba(94,233,181,0.98)';
      ctx.fillText(name, px, by + 14 * s);
      ctx.font = `${10 * s}px ui-monospace, monospace`;
      ctx.fillStyle = moved ? 'rgba(230,234,243,0.9)' : 'rgba(200,210,230,0.6)';
      ctx.fillText(detail, px, by + 27 * s);
      ctx.textAlign = 'left';
    };

    if (pv) {
      // A plane's own view: the picture is one letterboxed rectangle, so the
      // only thing worth outlining is that rectangle.
      const [rx, ry, rw, rh] = pv.rect;
      ctx.save();
      ctx.strokeStyle = 'rgba(94,233,181,0.9)';
      ctx.lineWidth = 2 * s;
      ctx.strokeRect(rx * W, (1 - ry - rh) * H, rw * W, rh * H);
      label(pv.surface, (rx + rw / 2) * W, (1 - ry - rh / 2) * H);
      ctx.restore();
      return;
    }

    const toPx = (p) => {
      const c = this._toCanvas(p[0], p[1]);
      return [c.x * W, (1 - c.y) * H];
    };
    ctx.save();
    for (const i of active) {
      const pts = map.corners(i);
      const on = i === focus;
      ctx.beginPath();
      pts.forEach((p, k) => {
        const [px, py] = toPx(p);
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.lineWidth = (on ? 2 : 1) * s;
      ctx.strokeStyle = on ? 'rgba(94,233,181,0.95)' : 'rgba(122,162,255,0.35)';
      ctx.setLineDash(on ? [] : [5 * s, 4 * s]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (!on) continue;
      // A wash, so it is obvious which picture the drag will move - and faint,
      // because this is drawn over the thing you are trying to judge.
      ctx.fillStyle = 'rgba(94,233,181,0.07)';
      ctx.fill();
      const cx = pts.reduce((a, p) => a + p[0], 0) / 4;
      const cy = pts.reduce((a, p) => a + p[1], 0) / 4;
      const [lx, ly] = toPx([cx, cy]);
      label(i, lx, ly);
    }
    ctx.restore();
  }
}
