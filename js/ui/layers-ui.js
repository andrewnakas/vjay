// Layer list and the selected layer's inspector (transform, blend, FX chain).

import { params } from '../params.js';
import { EFFECTS } from '../shaders/effects.js';
import { MAX_LAYERS } from '../layers.js';
import { GROUPS } from '../mapping.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const $ = (id) => document.getElementById(id);

export class LayersUI {
  constructor(app, panel) {
    this.app = app;
    this.panel = panel;       // ParamPanel, for generated controls
    this.dragId = null;
  }

  init() {
    $('layerAdd').addEventListener('click', () => this.addLayerMenu());
    $('layerDup').addEventListener('click', () => this.duplicateSelected());
    $('layerDel').addEventListener('click', () => {
      const sel = this.app.layers.selected;
      if (!sel) return;
      this.app.renderer.disposeAux(sel.id);
      this.app.layers.remove(sel.id);
    });
    this.app.layers.onChange = () => this.rebuild();
    this.rebuild();
  }

  /** Source picker for a new layer. */
  addLayerMenu() {
    if (this.app.layers.layers.length >= MAX_LAYERS) {
      this.app.toast(`Layer limit is ${MAX_LAYERS}`);
      return;
    }
    const sel = $('layerAddSource');
    const key = sel.value;
    const src = this.app.sources.get(key);
    const layer = this.app.layers.add(key, src?.label);
    if (layer) this.app.toast(`Added layer: ${src?.label || key}`);
  }

  duplicateSelected() {
    const sel = this.app.layers.selected;
    if (!sel) return;
    const copy = this.app.layers.add(sel.sourceKey, `${sel.name} copy`);
    if (!copy) { this.app.toast(`Layer limit is ${MAX_LAYERS}`); return; }
    // Carry over transform, blend and the whole effect chain with its values.
    for (const d of params.groups.get(sel.ns).params.values()) {
      params.setBase(`${copy.ns}.${d.key}`, params.getBase(`${sel.ns}.${d.key}`));
    }
    for (const fxId of sel.chain) {
      copy.addFx(fxId);
      const g = params.groups.get(sel.fxNs(fxId));
      if (!g) continue;
      for (const d of g.params.values()) {
        params.setBase(`${copy.fxNs(fxId)}.${d.key}`, params.getBase(`${sel.fxNs(fxId)}.${d.key}`));
      }
    }
  }

  refreshSourceOptions() {
    const sel = $('layerAddSource');
    const prev = sel.value;
    sel.textContent = '';
    const groups = [
      ['Live', (s) => s.kind === 'webcam' || s.kind === 'screen'],
      ['Elements', (s) => s.kind === 'element'],
      ['Generators', (s) => s.kind === 'generator'],
      ['Media', (s) => s.kind === 'image' || s.kind === 'video'],
    ];
    for (const [label, test] of groups) {
      const list = this.app.sources.list().filter(test);
      if (!list.length) continue;
      const og = el('optgroup');
      og.label = label;
      for (const s of list) {
        const o = el('option', null, s.label);
        o.value = s.key;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    if (prev) sel.value = prev;
  }

  rebuild() {
    this.refreshSourceOptions();
    this.buildList();
    this.buildInspector();
  }

  buildList() {
    const host = $('layerList');
    host.textContent = '';
    const stack = this.app.layers;
    if (!stack.layers.length) {
      host.appendChild(el('p', 'hint', 'No layers. Add one below, or drag a source card onto the preview.'));
      return;
    }
    // Top of the stack renders last, so show it first - that is what people expect.
    for (let i = stack.layers.length - 1; i >= 0; i--) {
      const layer = stack.layers[i];
      const row = el('div', 'layerrow');
      row.draggable = true;
      if (layer.id === stack.selectedId) row.classList.add('sel');

      const eye = el('button', 'lbtn eye', params.get(`${layer.ns}.visible`) > 0.5 ? '◉' : '○');
      eye.title = 'Show / hide';
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        params.setBase(`${layer.ns}.visible`, params.get(`${layer.ns}.visible`) > 0.5 ? 0 : 1);
        this.buildList();
      });

      const body = el('div', 'lbody');
      const src = this.app.sources.get(layer.sourceKey);
      body.appendChild(el('span', 'lname', layer.name));
      const meta = el('span', 'lmeta');
      meta.textContent = `${src ? src.label : 'no source'}${layer.chain.length ? ` · ${layer.chain.length} fx` : ''}`;
      body.appendChild(meta);

      // Which plane this layer lands on. Main is the wall and needs no badge;
      // anything else is easy to lose track of, so it gets one.
      const bus = Math.round(params.get(`${layer.ns}.group`));
      if (bus > 0) {
        const chip = el('span', 'buschip', GROUPS[bus]);
        chip.title = this.app.mapping.busLabel(bus);
        body.appendChild(chip);
      }

      const xf = Math.round(params.get(`${layer.ns}.xfade`));
      if (xf > 0) {
        const tag = el('span', `xtag x${xf === 1 ? 'a' : 'b'}`, xf === 1 ? 'A' : 'B');
        body.appendChild(tag);
      }

      const up = el('button', 'lbtn', '▲');
      up.title = 'Move up';
      up.addEventListener('click', (e) => { e.stopPropagation(); stack.move(layer.id, 1); });
      const down = el('button', 'lbtn', '▼');
      down.title = 'Move down';
      down.addEventListener('click', (e) => { e.stopPropagation(); stack.move(layer.id, -1); });

      row.append(eye, body, up, down);
      row.addEventListener('click', () => stack.select(layer.id));
      row.addEventListener('dblclick', () => {
        const name = prompt('Layer name', layer.name);
        if (name) { layer.rename(name); this.rebuild(); }
      });

      row.addEventListener('dragstart', (e) => {
        this.dragId = layer.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(layer.id));
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => { this.dragId = null; this.buildList(); });
      row.addEventListener('dragover', (e) => {
        if (this.dragId == null) return;
        e.preventDefault();
        row.classList.add('dropto');
      });
      row.addEventListener('dragleave', () => row.classList.remove('dropto'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('dropto');
        if (this.dragId == null || this.dragId === layer.id) return;
        // The list is displayed top-first, so the display index is inverted.
        const targetIndex = stack.layers.findIndex((l) => l.id === layer.id);
        stack.reorder(this.dragId, targetIndex);
        this.dragId = null;
      });

      host.appendChild(row);
    }
  }

  buildInspector() {
    const host = $('layerInspector');
    host.textContent = '';
    this.panel.controls = this.panel.controls.filter((c) => c.row.isConnected);
    const layer = this.app.layers.selected;
    if (!layer) {
      host.appendChild(el('p', 'hint', 'Select a layer to edit it. Drag it on the preview to move, corner handles to scale, the grip above to rotate. Alt+wheel scales; a bare wheel is ignored so a trackpad cannot resize things by accident.'));
      return;
    }

    // Source swap for this layer.
    const srcRow = el('div', 'prow');
    srcRow.appendChild(el('label', 'plabel', 'Source'));
    const srcSel = el('select', 'pselect');
    for (const s of this.app.sources.list()) {
      const o = el('option', null, s.label);
      o.value = s.key;
      srcSel.appendChild(o);
    }
    srcSel.value = layer.sourceKey || '';
    srcSel.addEventListener('input', () => {
      layer.sourceKey = srcSel.value;
      this.buildList();
      this.app.ui.refreshGeneratorPanels();
    });
    srcRow.appendChild(srcSel);
    host.appendChild(srcRow);

    // Matte source: a second feed used as a mask. With a Kinect depth stream,
    // set this to the depth camera and Matte = "Depth window" to key by distance.
    const matteRow = el('div', 'prow');
    const matteLabel = el('label', 'plabel', 'Matte source');
    matteLabel.title = 'A second source used as a mask (e.g. a Kinect depth feed)';
    matteRow.appendChild(matteLabel);
    const matteSel = el('select', 'pselect');
    const none = el('option', null, '— none —');
    none.value = '';
    matteSel.appendChild(none);
    for (const s of this.app.sources.list()) {
      if (s.key === layer.sourceKey) continue;
      const o = el('option', null, s.label);
      o.value = s.key;
      matteSel.appendChild(o);
    }
    matteSel.value = layer.matteKey || '';
    matteSel.addEventListener('input', () => {
      layer.matteKey = matteSel.value || null;
      this.buildList();
    });
    matteRow.appendChild(matteSel);
    host.appendChild(matteRow);

    // Where this layer lands, named by the planes that show it rather than by
    // the bus letter - "A · Frame 1, Frame 2" is the question people actually
    // have. Isolating a plane and adding a layer sets this for you.
    const busRow = el('div', 'prow');
    const busLabel = el('label', 'plabel', 'Goes to');
    busLabel.title = 'Which output bus this layer draws into. Planes show buses.';
    busRow.appendChild(busLabel);
    const busSel = el('select', 'pselect');
    GROUPS.forEach((_, b) => {
      const o = el('option', null, b === 0 ? `Main · wall` : this.app.mapping.busLabel(b));
      o.value = String(b);
      busSel.appendChild(o);
    });
    busSel.value = String(Math.round(params.get(`${layer.ns}.group`)));
    busSel.addEventListener('input', () => {
      params.setBase(`${layer.ns}.group`, Number(busSel.value));
      this.buildList();
      this.app.ui.viewUI?.rebuild();
    });
    busRow.appendChild(busSel);
    host.appendChild(busRow);

    const tform = this.panel.buildGroup(layer.ns, {
      title: `${layer.name} · transform`, exclude: ['group'],
    });
    const reset = el('div', 'srcbar no-collapse');
    const fill = el('button', 'ptoggle', '⤢ Fill the comp');
    fill.title = 'Centre this layer and scale it back to full frame';
    fill.addEventListener('click', () => {
      for (const [k, v] of [['x', 0], ['y', 0], ['scale', 1], ['stretch', 1], ['rotate', 0]]) {
        params.setBase(`${layer.ns}.${k}`, v);
      }
      this.app.toast(`${layer.name} back to full frame`);
    });
    reset.appendChild(fill);
    tform.querySelector('.pgroup-body')?.prepend(reset);
    host.appendChild(tform);

    // Per-layer effect chain.
    const fxSection = el('section', 'pgroup');
    const head = el('header', 'pgroup-head');
    head.appendChild(el('span', 'twisty', '▾'));
    head.appendChild(el('h3', null, 'Layer effects'));
    head.addEventListener('click', (e) => {
      if (e.target.closest('.no-collapse')) return;
      fxSection.classList.toggle('collapsed');
    });
    fxSection.appendChild(head);
    const body = el('div', 'pgroup-body');
    fxSection.appendChild(body);

    const addRow = el('div', 'srcbar no-collapse');
    const addSel = el('select', 'sel');
    for (const def of EFFECTS) {
      if (layer.chain.includes(def.id)) continue;
      const o = el('option', null, def.name);
      o.value = def.id;
      addSel.appendChild(o);
    }
    const addBtn = el('button', null, '+ Add');
    addBtn.addEventListener('click', () => {
      if (!addSel.value) return;
      layer.addFx(addSel.value);
      this.buildInspector();
      this.buildList();
    });
    addRow.append(addSel, addBtn);
    body.appendChild(addRow);

    if (!layer.chain.length) {
      body.appendChild(el('p', 'hint', 'No effects on this layer yet. These apply to this layer only, before it is composited.'));
    }

    for (const fxId of layer.chain) {
      const def = EFFECTS.find((e) => e.id === fxId);
      if (!def) continue;
      const controls = el('div', 'fxdrag no-collapse');
      const on = el('button', null, '⏻');
      on.title = 'Enable / bypass';
      on.addEventListener('click', (e) => {
        e.stopPropagation();
        const path = `${layer.fxNs(fxId)}.enabled`;
        params.setBase(path, params.get(path) > 0.5 ? 0 : 1);
      });
      const up = el('button', null, '▲');
      up.addEventListener('click', (e) => { e.stopPropagation(); layer.moveFx(fxId, -1); this.buildInspector(); });
      const down = el('button', null, '▼');
      down.addEventListener('click', (e) => { e.stopPropagation(); layer.moveFx(fxId, 1); this.buildInspector(); });
      const del = el('button', null, '✕');
      del.title = 'Remove from this layer';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        layer.removeFx(fxId);
        this.buildInspector();
        this.buildList();
      });
      controls.append(on, up, down, del);
      const sec = this.panel.buildGroup(layer.fxNs(fxId), {
        collapsed: true, title: def.name, extraHeader: controls,
      });
      sec.classList.add('fxitem');
      body.appendChild(sec);
    }

    host.appendChild(fxSection);
  }
}
