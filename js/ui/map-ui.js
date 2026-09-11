// The Setup tab: getting the picture onto the wall, in the order you do it.
//
// 1 Projector - put the output on the second display at its native size.
// 2 Planes    - make the shapes: a wall, a corner pair, picture frames.
// 3 Align     - drag the corners onto the real thing.
// 4 Look      - trim the colour against the paint.
// 5 Venue     - save it, or fall back to an unmapped frame in a hurry.
//
// Corner points are dragged on the preview rather than typed, so they are
// deliberately not sliders in this panel.

import { params } from '../params.js';
import { el } from './panel.js';
import { MAX_SURFACES, GROUPS, COLOUR_KEYS, VARY_KEYS } from '../mapping.js';

const $ = (id) => document.getElementById(id);

/** A titled block. Sections are the steps; they collapse like param groups. */
function step(n, title, { collapsed = false } = {}) {
  const sec = el('section', 'pgroup step');
  if (collapsed) sec.classList.add('collapsed');
  const head = el('header', 'pgroup-head');
  head.appendChild(el('span', 'twisty', '▾'));
  head.appendChild(el('span', 'stepnum', String(n)));
  head.appendChild(el('h3', null, title));
  head.addEventListener('click', (e) => {
    if (e.target.closest('.no-collapse')) return;
    sec.classList.toggle('collapsed');
  });
  sec.appendChild(head);
  const body = el('div', 'pgroup-body');
  sec.appendChild(body);
  return { sec, body, head };
}

export class MapUI {
  constructor(app, panel) {
    this.app = app;
    this.panel = panel;
  }

  get mapping() { return this.app.mapping; }

  init() {
    this.host = $('mapPanel');
    this.app.mapping.onChange = () => {
      this.rebuild();
      this.app.ui.viewUI?.rebuild();
    };
    this.app.mapEditor.onChange = () => this.rebuild();
    this.rebuild();
  }

  toggleEdit(on = null) {
    const ed = this.app.mapEditor;
    const next = on == null ? !(ed.enabled && ed.tool === 'corners') : on;
    if (next && this.app.view.mode === 'plane') this.app.setView('output');
    if (next) ed.setTool('corners');
    ed.setEnabled(next);
    this.app.toast(next
      ? 'Move planes: drag inside one to slide the whole quad. Tab next plane, 1-4 pick a corner, arrows nudge.'
      : 'Corners stay draggable while the Setup tab is open');
  }

  /**
   * The Picture tool. Corners move the frame; this moves what is inside it, per
   * plane, so a frame sharing the main comp still gets its own view of it.
   */
  togglePicture(on = null) {
    const ed = this.app.mapEditor;
    const next = on == null ? !ed.pictureLive : on;
    // The tool only stays armed where you are setting up, so arming it from
    // somewhere else means going there - not silently failing to arm.
    if (next && !ed.setupContext) this.app.ui.switchTab('map');
    ed.setTool(next ? 'picture' : 'corners');
    this.app.toast(next
      ? 'Picture: drag inside a plane to move what it shows. Alt+wheel zooms, '
        + 'Alt+Shift turns, double-click resets. Locked planes still pan.'
      : 'Picture tool off');
  }

  rebuild() {
    if (!this.host) return;
    this.host.textContent = '';
    this.panel.controls = this.panel.controls.filter((c) => c.row.isConnected);
    this.host.appendChild(this._stepProjector());
    this.host.appendChild(this._stepPlanes());
    this.host.appendChild(this._stepAlign());
    this.host.appendChild(this._stepLook());
    this.host.appendChild(this._stepVenue());
  }

  /* ---------------- 1 · projector ---------------- */

  _stepProjector() {
    const app = this.app;
    const { sec, body } = step(1, 'Projector');

    const bar = el('div', 'srcbar');
    const send = el('button', 'primary', '▸ Send to projector');
    send.title = 'Open the output window on the second display, at its own resolution';
    send.addEventListener('click', async () => {
      try {
        const r = await app.output.sendToProjector({
          setAspect: (a) => { if (Math.abs(a - app.outputAspect) > 0.001) app.setOutputAspect(a); },
        });
        // Render at the panel's own pixels rather than upscaling the preview.
        if (r.width && r.height) app.setOutputSize({ w: r.width, h: r.height });
        this.app.toast(r.message);
        this.rebuild();
      } catch (e) { this.app.toast(e.message); }
    });
    bar.appendChild(send);
    if (app.output.popupOpen) {
      const close = el('button', null, 'Close');
      close.addEventListener('click', () => { app.output.closeOutputWindow(); this.rebuild(); });
      bar.appendChild(close);
    }
    body.appendChild(bar);

    const size = app.outputSize;
    const parts = [
      size ? `${size.w}×${size.h}` : 'preview-sized',
      app.outputAspect > 0 ? `${app.outputAspect.toFixed(2)}:1` : 'fills the window',
      app.output.popupOpen ? 'window open ✓' : 'window closed ✗',
      app.output.popupOpen ? (app.output.popupFullscreen() ? 'fullscreen ✓' : 'not fullscreen — click it once') : null,
    ].filter(Boolean);
    const status = el('p', 'hint', parts.join(' · '));
    if (!app.output.popupOpen) status.classList.add('warn');
    body.appendChild(status);

    // Only worth showing when the automatic route did not find a second screen.
    if (!size) {
      const row = el('div', 'prow');
      row.appendChild(el('label', 'plabel', 'Aspect'));
      const sel = el('select', 'pselect');
      for (const [v, label] of [[0, 'Fill the window'], [16 / 9, '16:9'], [1.6, '16:10'], [4 / 3, '4:3'], [2.3704, '2.37:1']]) {
        const o = el('option', null, label);
        o.value = String(v);
        sel.appendChild(o);
      }
      sel.value = String(app.outputAspect);
      sel.addEventListener('input', () => app.setOutputAspect(Number(sel.value)));
      row.appendChild(sel);
      body.appendChild(row);
      body.appendChild(el('p', 'hint',
        'Corner points are normalized, so set this BEFORE aligning — changing it later '
        + 'stretches every plane off the wall.'));
    }
    return sec;
  }

  /* ---------------- 2 · planes ---------------- */

  _stepPlanes() {
    const app = this.app;
    const map = this.mapping;
    const { sec, body } = step(2, 'Planes');

    const bar = el('div', 'srcbar');
    const mk = (label, title, fn) => {
      const b = el('button', null, label);
      b.title = title;
      b.addEventListener('click', fn);
      bar.appendChild(b);
      return b;
    };
    mk('+ Wall', 'A full-frame plane on the Main bus', () => {
      const i = map.addWall();
      if (i < 0) { app.toast(`All ${MAX_SURFACES} planes are in use`); return; }
      this.toggleEdit(true);
      app.toast(`${map.name(i)} added — drag its corners onto the wall`);
    });
    mk('+ Corner', 'Two walls meeting at a crease, corners linked and the picture split across it', () => {
      const pair = map.addCorner(0.5);
      if (!pair) { app.toast('Not enough free planes for a corner pair'); return; }
      this.toggleEdit(true);
      app.toast('Corner added — drag the two middle corners onto the crease; the picture re-splits itself');
    });
    mk('+ Frame', 'A picture frame: shows the main comp, varied, until you give it one of its own', () => {
      const bus = map.freeBus();
      const i = map.addFrame(bus > 0 ? bus : 1);
      if (i < 0) { app.toast(`All ${MAX_SURFACES} planes are in use`); return; }
      this.toggleEdit(true);
      app.toast(`${map.name(i)} added on bus ${GROUPS[map.feed(i)]} — drag it onto the painting`);
    });
    const clearAll = el('button', null, '✕ Clear all');
    clearAll.title = 'Delete every plane and start the venue again';
    clearAll.addEventListener('click', () => {
      if (!confirm(`Delete all ${map.activeSurfaces().length} planes and start again?`)) return;
      app.setView('output');
      map.clearPlanes();
      app.toast('All planes cleared');
    });
    bar.appendChild(clearAll);
    body.appendChild(bar);

    // Auto-map: camera picker, run, undo, and the corner hint it may return.
    const auto = el('div', 'srcbar');
    const cams = app.calibrator.cameras();
    if (cams.length) {
      const camSel = el('select', 'sel');
      for (const c of cams) {
        const o = el('option', null, c.label);
        o.value = c.key;
        camSel.appendChild(o);
      }
      camSel.value = app.calibrator.cameraKey || cams[0].key;
      app.calibrator.cameraKey = camSel.value;
      camSel.addEventListener('input', () => {
        app.calibrator.cameraKey = camSel.value;
        app.toast(`Calibrating with ${camSel.selectedOptions[0].textContent}`);
      });
      auto.appendChild(camSel);
    }
    const autoBtn = el('button', null, '◎ Scan for frames');
    autoBtn.title = 'Project a pattern, watch it with a camera, and put a plane on each painting';
    autoBtn.addEventListener('click', () => this.runAuto(autoBtn));
    auto.appendChild(autoBtn);
    if (app.calibrator.canUndo) {
      const undo = el('button', null, '↶ Undo');
      undo.title = 'Put the planes back as they were before the last scan';
      undo.addEventListener('click', () => {
        app.calibrator.undo();
        app.toast('Planes restored');
        this.rebuild();
      });
      auto.appendChild(undo);
    }
    body.appendChild(auto);

    // A scan reports a brightness step where two walls meet. Offer to use it.
    const corner = app.calibrator.lastResult?.ok ? app.calibrator.lastResult.corner : null;
    if (corner) {
      const split = el('button', 'ptoggle', `Split the wall at ${(corner.u * 100).toFixed(0)}%`);
      split.title = 'The scan saw a brightness step there — the room corner';
      split.addEventListener('click', () => {
        const pair = map.addCorner(corner.u);
        app.toast(pair ? 'Wall split at the detected crease — drag the middle corners onto it'
          : 'Not enough free planes for a corner pair');
        this.toggleEdit(true);
      });
      body.appendChild(split);
    }

    const active = map.activeSurfaces();
    const list = el('div', 'surflist');
    for (const i of active) {
      list.appendChild(this._planeRow(i));
    }
    if (!active.length) {
      list.appendChild(el('p', 'hint', 'No planes. Add a wall to get the picture onto something.'));
    }
    body.appendChild(list);

    // Off planes, out of the way but reachable.
    const off = [];
    for (let i = 0; i < MAX_SURFACES; i++) if (!map.enabled(i)) off.push(i);
    if (off.length) {
      const more = el('details', 'offplanes');
      const sum = el('summary', null, `${off.length} plane${off.length === 1 ? '' : 's'} switched off`);
      more.appendChild(sum);
      for (const i of off) {
        const row = el('div', 'surfrow');
        const eye = el('button', 'lbtn eye', '○');
        eye.title = 'Bring this plane back';
        eye.addEventListener('click', () => map.mutePlane(i, true));
        const b = el('div', 'lbody');
        b.appendChild(el('span', 'lname', `${i + 1} · ${map.name(i)}`));
        const lock = el('button', 'lbtn', map.isLocked(i) ? '🔒' : '🔓');
    lock.title = map.isLocked(i)
      ? 'Locked — corners cannot be dragged or nudged. Click to unlock.'
      : 'Lock this plane so it cannot be moved by accident';
    lock.classList.toggle('on', map.isLocked(i));
    lock.addEventListener('click', (e) => {
      e.stopPropagation();
      map.setLocked(i, !map.isLocked(i));
    });

    const del = el('button', 'lbtn del', '✕');
        del.title = 'Clear this plane back to stock';
        del.addEventListener('click', (e) => { e.stopPropagation(); map.deletePlane(i); });
        row.append(eye, b, del);
        more.appendChild(row);
      }
      body.appendChild(more);
    }

    // Buses with layers that nothing shows: content rendering into the void.
    const shown = new Set(active.map((i) => map.feed(i)));
    for (const b of map.groupsInUse()) {
      if (b === 0 || shown.has(b)) continue;
      body.appendChild(el('p', 'hint warn',
        `Bus ${GROUPS[b]} has layers but no plane shows it — set a plane above to ${GROUPS[b]}.`));
    }
    return sec;
  }

  _planeRow(i) {
    const app = this.app;
    const map = this.mapping;
    const ns = map.ns(i);
    const row = el('div', 'surfrow live');
    if (i === map.selected) row.classList.add('sel');
    if (app.view.mode === 'plane' && app.view.surface === i) row.classList.add('isolated');

    const eye = el('button', 'lbtn eye', '◉');
    eye.title = 'Mute this plane — keeps its shape so you can bring it back';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      map.mutePlane(i, false);
    });

    const body = el('div', 'lbody');
    const name = el('span', 'lname', `${i + 1} · ${map.name(i)}`);
    body.appendChild(name);
    const pair = map.pairFor(i);
    const meta = el('span', 'lmeta');
    const feed = map.feed(i);
    const others = map.planesOnBus(feed).filter((k) => k !== i);
    meta.textContent = `${GROUPS[feed]}${others.length ? ` · shared with ${others.map((k) => map.name(k)).join(', ')}` : ''}`
      + (pair ? ` · corner pair, seam ${(map.seam(i) * 100).toFixed(0)}%` : '');
    if (feed !== 0 && !map.groupsInUse().has(feed)) {
      // Not a warning any more: showing the main comp is the normal case.
      meta.textContent += ['  · main comp', ' · black', ' · nothing'][map.emptyMode(i)] || '';
    }
    if (!map.isPlain(i)) meta.textContent += ' · varied';
    body.appendChild(meta);
    body.addEventListener('dblclick', () => {
      const n = prompt('Plane name', map.name(i));
      if (n) map.rename(i, n);
    });

    const sel = el('select', 'pselect');
    GROUPS.forEach((g, k) => {
      const o = el('option', null, k === 0 ? 'Main' : map.busLabel(k));
      o.value = String(k);
      sel.appendChild(o);
    });
    sel.value = String(feed);
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('input', () => {
      const next = Number(sel.value);
      params.setBase(`${ns}.feed`, next);
      // Switching what a plane shows changes what it should do with it: the
      // wall is a window onto one big picture, a plane with its own comp shows
      // that comp whole. Manual is left alone - it was chosen deliberately.
      const fit = map.fitMode(i);
      if (fit !== 3) {
        const want = next === 0 ? 0 : 2;
        if (fit !== want) {
          params.setBase(`${ns}.fit`, want);
          map.applyFit(i);
          app.toast(next === 0
            ? `${map.name(i)} follows the window again`
            : `${map.name(i)} now shows all of ${GROUPS[next]}`);
        }
      }
      map.onChange();
    });

    const pinned = app.pinOn(feed);
    if (pinned) {
      const tag = el('button', 'lbtn pintag', '📌✕');
      tag.title = `${app.sources.get(pinned.key)?.label || pinned.key} pinned here`
        + ` (${pinned.mode === 'over' ? 'over the comp' : 'overriding the comp'}) — click to unpin`;
      tag.addEventListener('click', (e) => {
        e.stopPropagation();
        app.unpinFeed(feed);
        app.toast('Unpinned');
      });
      row.appendChild(tag);
    }

    const solo = el('button', 'lbtn', '◱');
    solo.title = 'Comp this plane on its own — the projector keeps showing the full output';
    solo.addEventListener('click', (e) => {
      e.stopPropagation();
      app.ui.viewUI.select(i);
    });

    const lock = el('button', 'lbtn', map.isLocked(i) ? '🔒' : '🔓');
    lock.title = map.isLocked(i)
      ? 'Locked — corners cannot be dragged or nudged. Click to unlock.'
      : 'Lock this plane so it cannot be moved by accident';
    lock.classList.toggle('on', map.isLocked(i));
    lock.addEventListener('click', (e) => {
      e.stopPropagation();
      map.setLocked(i, !map.isLocked(i));
    });

    const del = el('button', 'lbtn del', '✕');
    del.title = `Delete ${map.name(i)} — clears its shape, crop and colour and frees the slot`;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = map.name(i);
      if (app.view.mode === 'plane' && app.view.surface === i) app.setView('output');
      map.deletePlane(i);
      app.toast(`Deleted ${name}`);
    });

    row.append(eye, body, sel, solo, lock, del);
    row.addEventListener('click', () => {
      map.selected = i;
      this.rebuild();
    });
    return row;
  }

  /* ---------------- 3 · align ---------------- */

  _stepAlign() {
    const app = this.app;
    const map = this.mapping;
    const i = map.selected;
    const ns = map.ns(i);
    const { sec, body } = step(3, `Align · ${map.name(i)}`);

    const bar = el('div', 'srcbar');
    const editBtn = el('button', 'ptoggle', '✥ Move planes');
    editBtn.title = 'M — drag a whole plane by its middle. Corners are already '
      + 'draggable while this tab is open; this adds sliding the quad itself.';
    editBtn.classList.toggle('on', app.mapEditor.enabled && app.mapEditor.tool === 'corners');
    editBtn.addEventListener('click', () => this.toggleEdit());
    const picBtn = el('button', 'ptoggle', '✥ Picture');
    picBtn.title = 'D — drag what is INSIDE a plane. Alt+wheel zooms, Alt+Shift turns, '
      + 'double-click resets. Works in a plane’s own view too, and on locked planes.';
    picBtn.classList.toggle('on', app.mapEditor.pictureLive);
    picBtn.addEventListener('click', () => this.togglePicture());
    const gridBtn = el('button', 'ptoggle', '▦ Grid');
    gridBtn.title = 'Warped grid on every plane — shows keystone and stretch';
    gridBtn.classList.toggle('on', map.testMode === 1);
    gridBtn.addEventListener('click', () => params.setBase('map.test', map.testMode === 1 ? 0 : 1));
    const whiteBtn = el('button', 'ptoggle', '⬜ White');
    whiteBtn.title = 'Flat white panels — the one to align real picture frames against, '
      + 'and the brightest thing a dim projector can put on a wall';
    whiteBtn.classList.toggle('on', map.testMode === 2);
    whiteBtn.addEventListener('click', () => params.setBase('map.test', map.testMode === 2 ? 0 : 2));
    const camBtn = el('button', 'ptoggle', '◉ Camera');
    camBtn.title = 'K — the camera’s view of the wall, warped into projector space, behind the planes';
    camBtn.classList.toggle('on', app.mapEditor.showCamera);
    camBtn.addEventListener('click', () => {
      app.mapEditor.showCamera = !app.mapEditor.showCamera;
      if (app.mapEditor.showCamera) this.toggleEdit(true);
      this.rebuild();
    });
    bar.append(editBtn, picBtn, gridBtn, whiteBtn, camBtn);
    body.appendChild(bar);

    // Corners are allowed to sit outside the projector's frame - aiming into a
    // room corner regularly wants that - so the preview has to be able to show
    // the area they sit in.
    const lockBar = el('div', 'srcbar');
    const lockAll = el('button', map.allLocked ? 'primary' : 'ptoggle',
      map.allLocked ? '🔒 All planes locked' : '🔒 Lock all planes');
    lockAll.title = map.allLocked
      ? 'Every plane is fixed. Click to unlock them all for another pass.'
      : 'Fix every plane where it is, so nothing moves during the set';
    lockAll.addEventListener('click', () => {
      const on = !map.allLocked;
      const n = map.lockAll(on);
      app.toast(on ? `${n} planes locked — nothing will move now` : `${n} planes unlocked`);
    });
    lockBar.appendChild(lockAll);
    if (map.isLocked(i)) {
      lockBar.appendChild(el('span', 'vnote warn', `${map.name(i)} is locked`));
    }
    body.appendChild(lockBar);

    const zoomBar = el('div', 'srcbar');
    zoomBar.appendChild(el('span', 'mini', 'preview'));
    for (const [label, z] of [['−', null], ['fit', 0.6], ['100%', 1], ['+', null]]) {
      const b = el('button', 'ptoggle', label);
      b.title = z === 1 ? 'Show exactly what the projector shows'
        : z ? 'Zoom out to see corners past the projector edge'
        : label === '−' ? 'Zoom out' : 'Zoom in';
      b.addEventListener('click', () => {
        const cur = app.previewView.zoom;
        app.setPreviewZoom(z ?? (label === '−' ? cur / 1.25 : cur * 1.25));
        if ((z ?? 0) === 1) app.setPreviewZoom(1, { x: 0, y: 0 });
        this.rebuild();
      });
      if (z && Math.abs(app.previewView.zoom - z) < 0.01) b.classList.add('on');
      zoomBar.appendChild(b);
    }
    const zPct = el('span', 'vnote', `${(app.previewView.zoom * 100).toFixed(0)}%`);
    zoomBar.appendChild(zPct);
    body.appendChild(zoomBar);
    if (app.previewView.zoom !== 1) {
      body.appendChild(el('p', 'hint',
        'The dashed rectangle is the projector\u2019s edge. Anything outside it is '
        + 'not being projected \u2014 useful for grabbing a corner, not for placing one. '
        + 'Pinch (or Ctrl+wheel) over the preview zooms; two fingers pan.'));
    }

    const shape = el('div', 'srcbar');
    // These set the window; the fit mode below decides what the comp does about
    // it, so none of them touch the crop directly any more.
    const full = el('button', null, 'Full frame');
    full.addEventListener('click', () => map.setRect(i, [0, 0, 1, 1]));
    const half = el('button', null, 'Left half');
    half.title = 'Left half of the projector';
    half.addEventListener('click', () => map.setRect(i, [0, 0, 0.5, 1]));
    const half2 = el('button', null, 'Right half');
    half2.addEventListener('click', () => map.setRect(i, [0.5, 0, 0.5, 1]));
    const rst = el('button', null, 'Reset');
    rst.addEventListener('click', () => map.resetSurface(i));
    shape.append(full, half, half2, rst);
    body.appendChild(shape);

    // If the picture inside a plane is upside down or mirrored, the quad is
    // right and the corner assignment is wrong. These re-label which corner is
    // which without moving the quad on the wall.
    const orient = el('div', 'srcbar');
    orient.appendChild(el('span', 'mini', 'picture'));
    for (const [label, how, tip] of [
      ['⇅', 'flipV', 'Flip the picture upside down in this plane'],
      ['⇄', 'flipH', 'Mirror the picture left-to-right in this plane'],
      ['⟳', 'rot180', 'Turn the picture 180° in this plane'],
      ['↺', 'rotCCW', 'Turn the picture a quarter turn'],
    ]) {
      const b = el('button', 'ptoggle', label);
      b.title = tip;
      b.addEventListener('click', () => {
        if (!map.reorientPlane(i, how)) { app.toast(`${map.name(i)} is locked`); return; }
        app.toast(`${map.name(i)} picture reoriented`);
      });
      orient.appendChild(b);
    }
    body.appendChild(orient);
    body.appendChild(el('p', 'hint',
      'Upside down or mirrored inside a plane means its corners were dragged into a '
      + 'flipped order — easy to do, since a blank panel looks the same either way up. '
      + 'The alignment patterns now mark the TOP edge, and these buttons fix it without '
      + 'moving the quad.'));

    // The single most important setting on a plane: what the comp does when you
    // move the plane.
    const fitRow = this.panel.buildControl(params.def(`${ns}.fit`));
    body.appendChild(fitRow);
    body.appendChild(el('p', 'hint',
      map.fitMode(i) === 0
        ? 'The comp sits still on the wall and this plane is a hole in front of it. '
          + 'Move the plane and it reveals a different part of the picture, so several '
          + 'planes read as one image rather than as copies.'
        : map.fitMode(i) === 1
          ? 'This plane shows the middle of the comp at its own aspect — never squashed, '
            + 'but every plane shows the same part of the picture.'
          : map.fitMode(i) === 2
            ? 'The whole comp is squeezed into this plane, whatever shape it is.'
            : 'The crop below is yours; nothing recomputes it.'));

    // One row, not a whole section: it is a single decision about this plane.
    body.appendChild(this.panel.buildControl(params.def(`${ns}.empty`)));

    const pair = map.pairFor(i);
    if (pair) {
      body.appendChild(el('p', 'hint',
        `Corner pair with ${map.name(pair.left === i ? pair.right : pair.left)}. `
        + `The two corners on the crease move together, and the picture re-splits itself `
        + `at ${(map.seam(i) * 100).toFixed(0)}% so neither wall stretches.`));
    }

    body.appendChild(this.panel.buildGroup(ns, {
      title: 'Crop and edge', collapsed: true,
      keys: ['cropX', 'cropY', 'cropW', 'cropH', 'soft'],
    }));

    body.appendChild(el('p', 'hint',
      'Drag corners on the preview. Tab next plane · 1–4 pick a corner · arrows nudge '
      + '(Shift = 10 px) · Alt+arrows move the whole plane.'));
    return sec;
  }

  /* ---------------- 4 · look ---------------- */

  _stepLook() {
    const app = this.app;
    const map = this.mapping;
    const i = map.selected;
    const { sec, body } = step(4, `Look · ${map.name(i)}`, { collapsed: true });

    // Variation first: it is the thing that makes eight planes worth having.
    body.appendChild(el('p', 'hint',
      'There are eight planes and eight layers, so most planes show the main comp '
      + 'rather than one of their own. Variation is what stops that being eight '
      + 'copies of the same picture: same comp, different framing, tint and drift.'));
    const vary = el('div', 'srcbar');
    const varyBtn = el('button', 'primary', '✳ Vary all planes');
    varyBtn.title = 'Spread hue, framing and drift across every plane. The first plane is left as the reference.';
    varyBtn.addEventListener('click', () => {
      const n = map.varyPlanes({ amount: 1 });
      app.toast(`Varied ${n} plane${n === 1 ? '' : 's'} around ${map.name(map.activeSurfaces()[0] ?? 0)}`);
    });
    const subtle = el('button', null, 'Subtle');
    subtle.title = 'The same spread, half as far';
    subtle.addEventListener('click', () => {
      map.varyPlanes({ amount: 0.5 });
      app.toast('Planes varied gently');
    });
    const plain = el('button', null, 'Reset');
    plain.title = 'Every plane shows the comp exactly as it is';
    plain.addEventListener('click', () => {
      map.resetVariation();
      app.toast('Variation cleared');
    });
    vary.append(varyBtn, subtle, plain);
    body.appendChild(vary);

    body.appendChild(this.panel.buildGroup(map.ns(i), {
      title: `Variation on ${map.name(i)}${map.isPlain(i) ? ' — none' : ''}`,
      collapsed: true, keys: VARY_KEYS,
    }));

    body.appendChild(this.panel.buildGroup(map.ns(i), {
      title: 'Colour on this plane', keys: COLOUR_KEYS,
    }));
    const dim = el('div', 'srcbar');
    const brighten = el('button', 'ptoggle', '☀ Dim projector');
    brighten.title = 'Lift the blacks and push brightness on this plane — buys light a dim lamp cannot';
    brighten.addEventListener('click', () => {
      params.setBase(`${map.ns(i)}.lift`, 0.16);
      params.setBase(`${map.ns(i)}.bright`, 1.25);
      params.setBase(`${map.ns(i)}.gamma`, 0.8);
      this.app.toast(`${map.name(i)} lifted for a dim projector`);
      this.rebuild();
    });
    const flip = el('button', 'ptoggle', '◐ Invert');
    flip.title = 'Flip this plane. A mostly-dark comp puts almost no light on the wall; inverted it puts almost all of it there.';
    flip.classList.toggle('on', params.getBase(`${map.ns(i)}.invert`) > 0.5);
    flip.addEventListener('click', () => {
      const on = params.getBase(`${map.ns(i)}.invert`) > 0.5;
      params.setBase(`${map.ns(i)}.invert`, on ? 0 : 1);
      this.rebuild();
    });
    const plainC = el('button', null, 'Neutral');
    plainC.title = 'Back to no colour treatment on this plane';
    plainC.addEventListener('click', () => {
      for (const k of COLOUR_KEYS) params.setBase(`${map.ns(i)}.${k}`, params.def(`${map.ns(i)}.${k}`).def);
      this.rebuild();
    });
    dim.append(brighten, flip, plainC);
    body.appendChild(dim);

    const copy = el('button', 'ptoggle', 'Copy to all planes');
    copy.addEventListener('click', () => {
      map.copyColour(i);
      this.app.toast('Colour trim copied to every plane');
    });
    body.appendChild(copy);
    body.appendChild(el('p', 'hint',
      'A tinted wall eats one channel: yellow paint absorbs blue, so blue content '
      + 'goes dim and muddy. Lean on bright warm tones and luminance contrast, and '
      + 'trim these against the test pattern once you are in the room.'));
    return sec;
  }

  /* ---------------- 5 · venue ---------------- */

  _stepVenue() {
    const map = this.mapping;
    const { sec, body } = step(5, 'Venue', { collapsed: true });
    const io = el('div', 'srcbar');
    const exp = el('button', null, '⤓ Save venue');
    exp.title = 'Write this calibration to a file';
    exp.addEventListener('click', () => { map.exportFile(); this.app.toast('Venue saved'); });
    const imp = el('button', null, '⤒ Load venue');
    const file = el('input');
    file.type = 'file';
    file.accept = 'application/json';
    file.hidden = true;
    imp.addEventListener('click', () => file.click());
    file.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try { await map.importFile(f); this.app.toast('Venue loaded'); }
      catch (err) { this.app.toast(`Load failed: ${err.message}`); }
      e.target.value = '';
    });
    io.append(exp, imp, file);
    body.appendChild(io);

    const bypassBtn = el('button', 'ptoggle', '⨯ Bypass mapping');
    bypassBtn.title = 'Shift+M — a plain unmapped full frame. The panic fallback.';
    bypassBtn.classList.toggle('on', map.bypassed);
    bypassBtn.addEventListener('click', () => {
      params.setBase('map.bypass', map.bypassed ? 0 : 1);
      this.rebuild();
    });
    body.appendChild(bypassBtn);
    body.appendChild(el('p', 'hint',
      'Planes are venue calibration, not performance state: they are kept out of cues, '
      + 'so recalling a cue mid-set can never move the picture off the wall.'));
    return sec;
  }

  async runAuto(btn) {
    const cal = this.app.calibrator;
    if (cal.running) return;
    const label = btn.textContent;
    btn.disabled = true;
    const res = await cal.run({
      onProgress: (i, n, msg) => { btn.textContent = `${i}/${n} ${msg}`; },
    });
    btn.disabled = false;
    btn.textContent = label;
    this.app.toast(res.message);
    if (res.ok) {
      console.log('[vjay] auto-map:', {
        frames: res.frames.length,
        coverage: `${(res.coverage * 100).toFixed(0)}% of the camera view is lit`,
        residual: `${res.residual.toFixed(2)} px`,
      });
    }
    this.rebuild();
  }

  /** Cheap per-frame refresh of just the status pill. */
  refreshStatus(pill) {
    if (!pill) return;
    const map = this.mapping;
    const app = this.app;
    const text = map.bypassed ? 'map bypassed'
      : map.testPattern ? 'test pattern'
      : app.mapEditor.pictureLive ? `picture ${map.name(map.selected)}`
      : app.view.mode === 'plane' ? `comping ${map.name(app.view.surface)}`
      : app.mapEditor.enabled ? `move P${map.selected + 1}`
      : app.mapEditor.cornersLive ? `corners live · ${map.activeSurfaces().length} planes`
      : `${map.activeSurfaces().length} planes`;
    if (pill.textContent !== text) pill.textContent = text;
    pill.classList.toggle('warn', map.bypassed || map.testPattern || app.view.mode === 'plane');
  }
}
