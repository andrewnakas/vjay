// Direct manipulation of layers on the preview.
//
// Handles are drawn on a transparent 2D canvas sitting above the WebGL canvas,
// never into the render itself - the projector output must stay clean.

import { params } from '../params.js';

const HANDLE = 7;          // half-size of a corner handle, css px
const ROTATE_OFFSET = 26;  // distance of the rotate grip above the top edge

export class CanvasEditor {
  constructor(app, glCanvas, overlay) {
    this.app = app;
    this.gl = glCanvas;
    this.canvas = overlay;
    this.ctx = overlay.getContext('2d');
    this.enabled = true;
    this.drag = null;
    this.hover = null;
    this._bind();
  }

  /**
   * The plane being comped, or null in the output view:
   * { rect: [x,y,w,h] on screen, crop: [x,y,w,h] into the bus, bus }.
   * Asked of the app every time rather than stored, so a drag can never be
   * measured against last frame's geometry.
   */
  get view() { return this.app.planeView ? this.app.planeView() : null; }

  /** The bus being edited: the isolated plane's, or Main. */
  get bus() { return this.view ? this.view.bus : 0; }

  /**
   * Screen 0..1 (y up, over the overlay) -> bus 0..1. In the isolate view the
   * preview shows only the plane's crop, letterboxed, so a drag has to be
   * measured against that box rather than the whole canvas - otherwise the
   * handles and the picture disagree, which is the whole reason for this view.
   */
  _toBus(x, y) {
    const v = this.view;
    if (!v) {
      // Output view: the only transform is the preview zoom, if any.
      const z = this.app.previewView || { zoom: 1, x: 0, y: 0 };
      if (z.zoom === 1) return { x, y };
      return { x: (x - 0.5) / z.zoom + 0.5 + z.x, y: (y - 0.5) / z.zoom + 0.5 + z.y };
    }
    const [rx, ry, rw, rh] = v.rect;
    const [cx, cy, cw, ch] = v.crop;
    return {
      x: cx + ((x - rx) / Math.max(rw, 1e-6)) * cw,
      y: cy + ((y - ry) / Math.max(rh, 1e-6)) * ch,
    };
  }

  /** Bus 0..1 -> screen 0..1, y up. */
  _toScreen(x, y) {
    const v = this.view;
    if (!v) {
      const z = this.app.previewView || { zoom: 1, x: 0, y: 0 };
      if (z.zoom === 1) return { x, y };
      return { x: (x - 0.5 - z.x) * z.zoom + 0.5, y: (y - 0.5 - z.y) * z.zoom + 0.5 };
    }
    const [rx, ry, rw, rh] = v.rect;
    const [cx, cy, cw, ch] = v.crop;
    return {
      x: rx + ((x - cx) / Math.max(cw, 1e-6)) * rw,
      y: ry + ((y - cy) / Math.max(ch, 1e-6)) * rh,
    };
  }

  /** Bus units per screen pixel, for handle tolerances and the rotate grip. */
  _busPerPx(r) {
    const v = this.view;
    const z = v ? 1 : (this.app.previewView?.zoom || 1);
    const sx = (v ? v.crop[2] / Math.max(v.rect[2], 1e-6) : 1) / z;
    const sy = (v ? v.crop[3] / Math.max(v.rect[3], 1e-6) : 1) / z;
    return { x: sx / Math.max(r.width, 1), y: sy / Math.max(r.height, 1) };
  }

  /**
   * Aspect of the bus, which is what the layer shader works in. Taken from the
   * renderer rather than the overlay: with the render locked to the projector's
   * native size those two are the same shape, but only one of them is
   * guaranteed to be.
   */
  _busAspect() {
    const rw = this.app.renderer?.width || this.app.renderW || 16;
    const rh = this.app.renderer?.height || this.app.renderH || 9;
    return rw / Math.max(rh, 1);
  }

  /** Layers that belong to the frame being edited. */
  _layersHere() {
    return this.app.layers.layers.filter(
      (l) => Math.round(params.get(`${l.ns}.group`)) === this.bus,
    );
  }

  /** Preview rect in css pixels; the GL canvas fills its wrapper. */
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

  /** Pointer position in BUS space: x,y in 0..1, y up, plus the screen rect. */
  _norm(e) {
    const r = this._rect();
    const s = { x: (e.clientX - r.left) / r.width, y: 1 - (e.clientY - r.top) / r.height };
    const b = this._toBus(s.x, s.y);
    return { x: b.x, y: b.y, r };
  }

  /**
   * Layer geometry in normalized space. The layer shader treats position as
   * half-frame units and works in aspect-corrected local coords, so this must
   * mirror it exactly or the handles will not sit on the image.
   */
  _geom(layer, aspect) {
    const p = (k) => params.get(`${layer.ns}.${k}`);
    return {
      cx: 0.5 + p('x') * 0.5,
      cy: 0.5 + p('y') * 0.5,
      halfW: 0.5 * p('scale') * p('stretch'),
      halfH: 0.5 * p('scale'),
      rot: p('rotate'),
      aspect,
    };
  }

  /** Normalized point -> layer-local units where the box is halfW x halfH. */
  _toLocal(g, x, y) {
    let dx = (x - g.cx) * g.aspect;
    let dy = y - g.cy;
    const c = Math.cos(-g.rot);
    const s = Math.sin(-g.rot);
    const rx = dx * c - dy * s;
    const ry = dx * s + dy * c;
    return { x: rx / g.aspect, y: ry };
  }

  _corners(g) {
    const out = [];
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      let dx = sx * g.halfW * g.aspect;
      let dy = sy * g.halfH;
      const c = Math.cos(g.rot);
      const s = Math.sin(g.rot);
      const rx = dx * c - dy * s;
      const ry = dx * s + dy * c;
      out.push({ x: g.cx + rx / g.aspect, y: g.cy + ry, sx, sy });
    }
    return out;
  }

  _rotateGrip(g, r) {
    const offY = ROTATE_OFFSET * this._busPerPx(r).y;
    let dx = 0;
    let dy = g.halfH + offY;
    const c = Math.cos(g.rot);
    const s = Math.sin(g.rot);
    return { x: g.cx + (dx * c - dy * s) / g.aspect, y: g.cy + (dx * s + dy * c) };
  }

  _hitTest(nx, ny, r) {
    const stack = this.app.layers;
    const aspect = this._busAspect();
    const here = this._layersHere();
    const sel = here.includes(stack.selected) ? stack.selected : null;
    const per = this._busPerPx(r);

    // Handles of the selected layer win over everything underneath.
    if (sel && params.get(`${sel.ns}.visible`) > 0.5) {
      const g = this._geom(sel, aspect);
      const tolX = HANDLE * per.x;
      const tolY = HANDLE * per.y;
      const grip = this._rotateGrip(g, r);
      if (Math.abs(nx - grip.x) < tolX * 1.6 && Math.abs(ny - grip.y) < tolY * 1.6) {
        return { layer: sel, mode: 'rotate' };
      }
      for (const c of this._corners(g)) {
        if (Math.abs(nx - c.x) < tolX && Math.abs(ny - c.y) < tolY) {
          return { layer: sel, mode: 'scale', corner: c };
        }
      }
    }

    // Otherwise pick the topmost layer whose box contains the point. Only
    // layers on the frame being edited - in an isolate view the others are not
    // on screen, and grabbing one you cannot see is worse than grabbing none.
    for (let i = here.length - 1; i >= 0; i--) {
      const l = here[i];
      if (params.get(`${l.ns}.visible`) < 0.5) continue;
      if (l.effectiveOpacity(params.get('mix.fade')) <= 0.001) continue;
      const g = this._geom(l, aspect);
      const p = this._toLocal(g, nx, ny);
      if (Math.abs(p.x) <= g.halfW && Math.abs(p.y) <= g.halfH) {
        return { layer: l, mode: 'move' };
      }
    }
    return null;
  }

  _bind() {
    const c = this.canvas;
    // The map editor shares this overlay and listens in the capture phase, so it
    // has already had its say by the time these run. It only stops propagation
    // when it actually grabbed something, which is what lets corner handles stay
    // live all through Setup without swallowing every layer drag.
    c.addEventListener('pointerdown', (e) => {
      if (!this.enabled || this.app.mapEditor?.blocksPointer) return;
      const { x, y, r } = this._norm(e);
      const hit = this._hitTest(x, y, r);
      if (!hit) { this.app.layers.select(null); return; }
      this.app.layers.select(hit.layer.id);
      c.setPointerCapture(e.pointerId);
      const ns = hit.layer.ns;
      this.drag = {
        ...hit,
        startX: x,
        startY: y,
        aspect: this._busAspect(),
        base: {
          x: params.getBase(`${ns}.x`), y: params.getBase(`${ns}.y`),
          scale: params.getBase(`${ns}.scale`), stretch: params.getBase(`${ns}.stretch`),
          rotate: params.getBase(`${ns}.rotate`),
        },
      };
      e.preventDefault();
    });

    c.addEventListener('pointermove', (e) => {
      if (!this.enabled || this.app.mapEditor?.blocksPointer) return;
      const { x, y, r } = this._norm(e);
      if (!this.drag) {
        const hit = this._hitTest(x, y, r);
        this.hover = hit;
        c.style.cursor = !hit ? 'default'
          : hit.mode === 'rotate' ? 'grab'
          : hit.mode === 'scale' ? 'nwse-resize' : 'move';
        return;
      }
      const d = this.drag;
      const ns = d.layer.ns;
      if (d.mode === 'move') {
        // Position is in half-frame units, so a full-width drag is 2.0.
        params.setBase(`${ns}.x`, d.base.x + (x - d.startX) * 2);
        params.setBase(`${ns}.y`, d.base.y + (y - d.startY) * 2);
      } else if (d.mode === 'scale') {
        const g = this._geom(d.layer, d.aspect);
        const p = this._toLocal({ ...g, halfW: 1, halfH: 1 }, x, y);
        const refX = Math.max(Math.abs(p.x) * 2, 0.02);
        const refY = Math.max(Math.abs(p.y) * 2, 0.02);
        if (e.shiftKey) {
          // Shift stretches one axis independently.
          params.setBase(`${ns}.scale`, refY);
          params.setBase(`${ns}.stretch`, refX / Math.max(refY, 0.001));
        } else {
          params.setBase(`${ns}.scale`, Math.max(refX / Math.max(d.base.stretch, 0.001), refY));
        }
      } else if (d.mode === 'rotate') {
        const ang = Math.atan2(y - (0.5 + d.base.y * 0.5), (x - (0.5 + d.base.x * 0.5)) * d.aspect);
        let next = ang - Math.PI / 2;
        while (next > Math.PI) next -= Math.PI * 2;
        while (next < -Math.PI) next += Math.PI * 2;
        if (e.shiftKey) next = Math.round(next / (Math.PI / 12)) * (Math.PI / 12); // 15 deg snap
        params.setBase(`${ns}.rotate`, next);
      }
      e.preventDefault();
    });

    const end = (e) => {
      if (this.drag) {
        try { c.releasePointerCapture(e.pointerId); } catch (_) {}
        this.drag = null;
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    // ALT + wheel scales a layer; Alt+Shift rotates it.
    //
    // A bare wheel used to do this, which on a trackpad means two fingers
    // resting on the pad silently shrink whatever is under the pointer - and
    // since the camera comp is usually the thing under the pointer, that is how
    // a camera ends up tiny in its frame with no obvious cause. Scaling now
    // takes a deliberate modifier; the corner handles and the Scale slider are
    // unchanged.
    c.addEventListener('wheel', (e) => {
      if (!this.enabled || this.app.mapEditor?.blocksPointer) return;
      if (!e.altKey) return;                 // includes pinch, which sets ctrlKey
      const { x, y, r } = this._norm(e);
      const hit = this._hitTest(x, y, r);
      if (!hit) return;
      e.preventDefault();
      const ns = hit.layer.ns;
      if (e.shiftKey) {
        params.setBase(`${ns}.rotate`, params.getBase(`${ns}.rotate`) - e.deltaY * 0.002);
      } else {
        params.setBase(`${ns}.scale`, params.getBase(`${ns}.scale`) * (1 - e.deltaY * 0.0012));
      }
    }, { passive: false });

    // Dropping a source card onto the preview makes a layer where you dropped it.
    c.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    c.addEventListener('drop', (e) => {
      const key = e.dataTransfer.getData('text/vjay-source');
      if (!key) return;
      e.preventDefault();
      const { x, y } = this._norm(e);
      const src = this.app.sources.get(key);
      const layer = this.app.layers.add(key, src?.label);
      if (!layer) { this.app.toast(`Layer limit reached`); return; }
      // A source dropped while a plane is isolated belongs to that plane.
      params.setBase(`${layer.ns}.group`, this.bus);
      params.setBase(`${layer.ns}.x`, (x - 0.5) * 2);
      params.setBase(`${layer.ns}.y`, (y - 0.5) * 2);
      // A dropped source is placed where it was dropped, so it keeps a size you
      // can see rather than being fitted to the whole comp.
      params.setBase(`${layer.ns}.scale`, this.view ? Math.min(this.view.crop[3], 0.9) : 0.45);
      this.app.toast(this.view
        ? `Added ${src?.label || key} to ${this.app.mapping.name(this.app.view.surface)}`
        : `Added ${src?.label || key} as a layer`);
    });
  }

  draw() {
    this._resize();
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!this.enabled) return;

    const s0 = this.dpr;
    // In an isolate view, outline the picture area so the edge of the plane is
    // visible even where the comp is dark.
    if (this.view) {
      const [rx, ry, rw, rh] = this.view.rect;
      ctx.strokeStyle = 'rgba(94,233,181,0.35)';
      ctx.lineWidth = 1 * s0;
      ctx.setLineDash([4 * s0, 4 * s0]);
      ctx.strokeRect(rx * W, (1 - ry - rh) * H, rw * W, rh * H);
      ctx.setLineDash([]);
    }

    const sel = this.app.layers.selected;
    if (!sel || params.get(`${sel.ns}.visible`) < 0.5) return;
    if (!this._layersHere().includes(sel)) return;

    const r = this._rect();
    const g = this._geom(sel, this._busAspect());
    const toPx = (p) => {
      const q = this._toScreen(p.x, p.y);
      return [q.x * W, (1 - q.y) * H];
    };
    const corners = this._corners(g);
    const s = this.dpr;

    ctx.lineWidth = 1.5 * s;
    ctx.strokeStyle = this.drag ? 'rgba(94,233,181,0.95)' : 'rgba(122,162,255,0.85)';
    ctx.setLineDash([6 * s, 4 * s]);
    ctx.beginPath();
    corners.forEach((c, i) => {
      const [px, py] = toPx(c);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    // Rotate grip
    const grip = this._rotateGrip(g, r);
    const [gx, gy] = toPx(grip);
    const [tx, ty] = toPx({
      x: (corners[3].x + corners[2].x) / 2,
      y: (corners[3].y + corners[2].y) / 2,
    });
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(gx, gy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(gx, gy, HANDLE * s * 0.8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,13,20,0.9)';
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = 'rgba(10,13,20,0.9)';
    for (const c of corners) {
      const [px, py] = toPx(c);
      ctx.beginPath();
      ctx.rect(px - HANDLE * s, py - HANDLE * s, HANDLE * 2 * s, HANDLE * 2 * s);
      ctx.fill();
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.font = `${11 * s}px ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(230,234,243,0.9)';
    const [lx, ly] = toPx(corners[0]);
    ctx.fillText(sel.name, lx, ly - 8 * s);
  }
}
