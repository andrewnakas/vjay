// The view bar: which frame the PREVIEW is showing.
//
// Output is the mapped picture, exactly as it leaves the projector. Clicking a
// plane isolates it: the preview becomes that plane's comp, flat and at the
// plane's own shape, and the layer handles move into that space so dragging
// something puts it where you dragged it. The projector is unaffected either
// way - that separation is the point, because comping mid-set otherwise means
// showing the room your workings.

import { params } from '../params.js';
import { el } from './panel.js';
import { GROUPS } from '../mapping.js';

const $ = (id) => document.getElementById(id);

export class ViewUI {
  constructor(app) {
    this.app = app;
  }

  init() {
    this.host = $('viewbar');
    this.rebuild();
  }

  /** Output, then every enabled plane, in plane order. */
  tabs() {
    const map = this.app.mapping;
    return [{ surface: -1, label: 'Output' },
      ...map.activeSurfaces().map((i) => ({ surface: i, label: map.name(i) }))];
  }

  /** Cycle Output -> plane 1 -> plane 2 -> ... -> Output. */
  cycle(dir = 1) {
    const tabs = this.tabs();
    const cur = this.app.view.mode === 'plane' ? this.app.view.surface : -1;
    const at = Math.max(0, tabs.findIndex((t) => t.surface === cur));
    const next = tabs[(at + dir + tabs.length) % tabs.length];
    this.select(next.surface);
  }

  select(surface) {
    const app = this.app;
    if (surface < 0) {
      app.setView('output');
      app.toast('Preview: full mapped output');
      return;
    }
    if (!app.setView('plane', surface)) return;
    const bus = app.mapping.feed(surface);
    const others = app.mapping.planesOnBus(bus).filter((i) => i !== surface);
    app.toast(others.length
      ? `Comping ${app.mapping.name(surface)} — bus ${GROUPS[bus]}, shared with ${others.map((i) => app.mapping.name(i)).join(', ')}`
      : `Comping ${app.mapping.name(surface)} — bus ${GROUPS[bus]}`);
  }

  rebuild() {
    if (!this.host) return;
    const app = this.app;
    const map = app.mapping;
    this.host.textContent = '';

    const cur = app.view.mode === 'plane' ? app.view.surface : -1;
    const tabRow = el('div', 'viewtabs');
    for (const t of this.tabs()) {
      const b = el('button', 'viewtab', t.label);
      if (t.surface === cur) b.classList.add('on');
      if (t.surface >= 0) {
        const bus = map.feed(t.surface);
        b.title = `Comp ${t.label} on its own — bus ${GROUPS[bus]}. The projector keeps showing the full output.`;
        if (bus > 0) b.appendChild(el('span', 'buschip', GROUPS[bus]));
      } else {
        b.title = 'The mapped picture as it leaves the projector';
      }
      b.addEventListener('click', () => this.select(t.surface));
      tabRow.appendChild(b);
    }
    this.host.appendChild(tabRow);

    // Live pins, visible whatever view you are in: a pin overrides the setlist
    // until it is taken off, so it must never be something you can forget about.
    const pins = app.pins();
    if (pins.length) {
      const bar = el('div', 'pinbar');
      bar.appendChild(el('span', 'mini', 'pinned — click to remove'));
      for (const p of pins) {
        const chip = el('button', 'pinchip');
        const src = app.sources.get(p.key);
        const planes = map.planesOnBus(p.bus).map((i) => map.name(i));
        chip.textContent = `✕ ${src?.label || p.key} → ${planes.length ? planes.join(', ') : GROUPS[p.bus]}`
          + (p.mode === 'over' ? ' (over)' : '');
        chip.title = `Click to unpin ${src?.label || p.key}`;
        chip.addEventListener('click', () => {
          app.unpinFeed(p.bus);
          app.toast(`Unpinned ${src?.label || p.key}`);
        });
        bar.appendChild(chip);
      }
      if (pins.length > 1) {
        const all = el('button', 'pinchip', '✕ all pins');
        all.title = 'Drop every pin (Shift+P)';
        all.addEventListener('click', () => {
          const n = app.clearPins();
          app.toast(`Dropped ${n} pins`);
        });
        bar.appendChild(all);
      }
      this.host.appendChild(bar);
    }

    if (cur < 0) return;

    // Isolated: say what is being edited and offer the two things you want next.
    const bus = map.feed(cur);
    const shared = map.planesOnBus(bus).filter((i) => i !== cur);
    const info = el('div', 'viewinfo');
    const note = el('span', 'vnote');
    note.textContent = shared.length
      ? `bus ${GROUPS[bus]} — also on ${shared.map((i) => map.name(i)).join(', ')}`
      : `bus ${GROUPS[bus]}`;
    if (shared.length) note.classList.add('warn');
    info.appendChild(note);

    if (shared.length) {
      const own = el('button', 'ptoggle', 'Own comp');
      own.title = 'Move this plane onto a free bus so its layers are its own';
      own.addEventListener('click', () => {
        const b = map.ownComp(cur);
        app.toast(b < 0 ? 'No free bus — take one back from another plane first'
          : `${map.name(cur)} now has its own comp (bus ${GROUPS[b]})`);
        this.rebuild();
      });
      info.appendChild(own);
    }

    const fit = el('button', 'ptoggle', 'Fit layers');
    fit.title = 'Scale every layer on this bus to fill the plane';
    fit.addEventListener('click', () => {
      const crop = map.crop(cur);
      let n = 0;
      for (const l of app.layers.layers) {
        if (Math.round(params.get(`${l.ns}.group`)) !== bus) continue;
        params.setBase(`${l.ns}.x`, 0);
        params.setBase(`${l.ns}.y`, 0);
        params.setBase(`${l.ns}.scale`, crop[3]);
        params.setBase(`${l.ns}.stretch`, crop[2] / Math.max(crop[3], 1e-6));
        params.setBase(`${l.ns}.rotate`, 0);
        n++;
      }
      app.toast(n ? `Fitted ${n} layer${n === 1 ? '' : 's'} to ${map.name(cur)}` : 'No layers on this bus yet');
    });
    info.appendChild(fit);

    // Move what this plane shows, right here, without going back to the mapped
    // output first. This is the view you are already looking at when you decide
    // the picture is sitting wrong in the frame.
    const pic = el('button', 'ptoggle', '✥ Picture');
    pic.title = 'D — drag the picture inside this plane. Alt+wheel zooms, '
      + 'Alt+Shift turns, double-click resets.';
    pic.classList.toggle('on', app.mapEditor.pictureLive);
    pic.addEventListener('click', () => app.ui.mapUI.togglePicture());
    info.appendChild(pic);

    // Corners have no position in this flat view, so offer the trip back rather
    // than a warped editor that would have to invent one.
    const corners = el('button', 'ptoggle', '✥ Corners');
    corners.title = 'Back to the mapped output with this plane selected, corners live';
    corners.addEventListener('click', () => {
      map.selected = cur;
      this.select(-1);
      app.ui.switchTab('map');
      app.toast(`${map.name(cur)} selected — drag its corners`);
    });
    info.appendChild(corners);

    const back = el('button', 'ptoggle', '◀ Output');
    back.addEventListener('click', () => this.select(-1));
    info.appendChild(back);

    // Fullscreen on THIS window shows the preview, so with no output window
    // open an isolate view would be what goes to the wall. Say so once.
    if (!app.output.popupOpen) {
      info.appendChild(el('span', 'vnote warn', 'no output window — F would show this view'));
    }
    this.host.appendChild(info);

    // Adding content to the plane you are looking at, without going hunting in
    // the left column for a source list that will not tell you where the layer
    // is about to land.
    const add = el('div', 'viewadd');
    add.appendChild(el('span', 'mini', 'add here'));

    const live = app.sources.activeCameras();
    if (live.length) {
      for (const cam of live) {
        const b = el('button', 'ptoggle', `◉ ${cam.key.toUpperCase()}`);
        b.title = `Overlay ${cam.label} on ${map.name(cur)}`;
        b.addEventListener('click', () => {
          const l = app.addLayer(cam.key);
          app.toast(l ? `${cam.label} → ${map.name(cur)}` : 'Layer limit reached');
        });
        add.appendChild(b);
      }
    } else {
      const b = el('button', 'ptoggle', '◉ Camera');
      b.title = 'Start a camera and put it on this plane';
      b.addEventListener('click', async () => {
        try {
          const list = app.sources.rankedCameras(await app.sources.listCameras());
          const src = await app.sources.startCamera(list[0]?.deviceId);
          app.addLayer(src.key);
          app.ui.refreshCameras();
          app.ui.buildSourceGrid();
          app.toast(`${src.label} → ${map.name(cur)}`);
        } catch (e) { app.toast(`Camera failed: ${e.message}`); }
      });
      add.appendChild(b);
    }

    const scr = el('button', 'ptoggle', '▤ Screen');
    scr.title = `Capture a screen or window onto ${map.name(cur)}`;
    scr.addEventListener('click', async () => {
      try {
        await app.sources.startScreen();
        app.addLayer('screen');
        app.ui.buildSourceGrid();
        app.toast(`Screen → ${map.name(cur)}`);
      } catch (e) { app.toast(`Screen capture failed: ${e.message}`); }
    });
    add.appendChild(scr);

    // Everything else, so a generator or element can go straight on the plane.
    const pick = el('select', 'sel');
    const ph = el('option', null, '+ source…');
    ph.value = '';
    pick.appendChild(ph);
    for (const [label, test] of [
      ['Generators', (x) => x.kind === 'generator'],
      ['Elements', (x) => x.kind === 'element'],
      ['Media', (x) => x.kind === 'image' || x.kind === 'video'],
    ]) {
      const list = app.sources.list().filter(test);
      if (!list.length) continue;
      const og = el('optgroup');
      og.label = label;
      for (const x of list) {
        const o = el('option', null, x.label);
        o.value = x.key;
        og.appendChild(o);
      }
      pick.appendChild(og);
    }
    pick.addEventListener('input', () => {
      if (!pick.value) return;
      const l = app.addLayer(pick.value);
      app.toast(l ? `${app.sources.get(pick.value)?.label} → ${map.name(cur)}` : 'Layer limit reached');
      pick.value = '';
    });
    add.appendChild(pick);

    // Pinning: force a feed into this plane's comp regardless of the cue.
    const pinned = app.pinOn(bus);
    const pinSel = el('select', 'sel');
    const none = el('option', null, pinned ? '📌 unpin' : '📌 pin a feed…');
    none.value = '';
    pinSel.appendChild(none);
    for (const [label, test] of [
      ['Live', (x) => x.kind === 'webcam' || x.kind === 'screen'],
      ['Media', (x) => x.kind === 'image' || x.kind === 'video'],
      ['Generators', (x) => x.kind === 'generator'],
      ['Elements', (x) => x.kind === 'element'],
    ]) {
      const list = app.sources.list().filter(test);
      if (!list.length) continue;
      const og = el('optgroup');
      og.label = label;
      for (const x of list) {
        const o = el('option', null, x.label);
        o.value = x.key;
        og.appendChild(o);
      }
      pinSel.appendChild(og);
    }
    pinSel.value = pinned ? pinned.key : '';
    pinSel.title = `Force a feed into ${map.name(cur)}, overriding whatever the setlist puts there`;
    pinSel.addEventListener('input', () => {
      if (!pinSel.value) {
        app.unpinFeed(bus);
        app.toast(`${map.name(cur)} back on the setlist`);
        return;
      }
      const mode = pinned ? pinned.mode : 'replace';
      app.pinFeed(bus, pinSel.value, { mode });
      app.toast(`${app.sources.get(pinSel.value)?.label} pinned to ${map.name(cur)}`);
    });
    add.appendChild(pinSel);

    if (pinned) {
      const off = el('button', 'ptoggle', '✕ Unpin');
      off.title = `Take ${app.sources.get(pinned.key)?.label || pinned.key} back off this plane`;
      off.addEventListener('click', () => {
        app.unpinFeed(bus);
        app.toast(`${map.name(cur)} back on the setlist`);
      });
      add.appendChild(off);
      const mode = el('button', 'ptoggle', pinned.mode === 'over' ? 'over' : 'override');
      mode.title = 'Override replaces the comp; over lays the feed on top of it';
      mode.classList.toggle('on', pinned.mode === 'over');
      mode.addEventListener('click', () => {
        app.pinFeed(bus, pinned.key, { mode: pinned.mode === 'over' ? 'replace' : 'over' });
      });
      add.appendChild(mode);
    }

    const colour = el('button', 'ptoggle', '🎨 Colour');
    colour.title = 'Jump to this plane’s colour and variation controls';
    colour.addEventListener('click', () => {
      app.ui.switchTab('map');
      map.selected = cur;
      app.ui.mapUI.rebuild();
      // The Look step is collapsed by default; open it on the way in.
      const steps = document.querySelectorAll('#mapPanel .pgroup.step');
      steps[3]?.classList.remove('collapsed');
      steps[3]?.scrollIntoView({ block: 'center' });
    });
    add.appendChild(colour);

    this.host.appendChild(add);
  }
}
