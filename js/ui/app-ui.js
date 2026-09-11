// All DOM wiring. Panels for registered params come from ParamPanel; this file
// builds the bits that are structural rather than parameter-shaped.

import { params } from '../params.js';
import { ParamPanel, el } from './panel.js';
import { EFFECTS } from '../shaders/effects.js';
import { MOD_SOURCES, CURVES } from '../modulation.js';
import { SHORTCUTS } from '../keyboard.js';
import { SLOT_COUNT } from '../presets.js';
import { LOOKS, applyLook } from '../looks.js';
import { LayersUI } from './layers-ui.js';
import { MapUI } from './map-ui.js';
import { ShowUI } from './show-ui.js';
import { ViewUI } from './view-ui.js';

const $ = (id) => document.getElementById(id);

// Which panels the user has folded away. Its own key, not part of the session
// snapshot: a layout preference should survive a session reset.
const COLLAPSE_KEY = 'vjay.panels.v1';

export class AppUI {
  constructor(app) {
    this.app = app;
    this.panel = new ParamPanel(app);
    this.layersUI = new LayersUI(app, this.panel);
    this.mapUI = new MapUI(app, this.panel);
    this.showUI = new ShowUI(app);
    this.viewUI = new ViewUI(app);
    this.modRowEls = new Map();
    this._toastTimer = null;
    this._lastDiag = 0;
  }

  init() {
    this.buildLookGrid();
    this.buildSourceGrid();
    this.buildBasePanels();
    this.layersUI.init();
    this.buildFxChain();
    this.buildLfoPanels();
    this.buildAutoPanel();
    this.buildPresetSlots();
    this.mapUI.init();
    this.showUI.init();
    this.viewUI.init();
    this.wireCueBar();
    this.buildHelp();
    this.wireTopbar();
    this.wireTransport();
    this.wireTabs();
    this.wireMod();
    this.wireSystem();
    this.wireDropzone();
    this.wireStaticCollapse();
    this.app.sources.onChange = () => {
      this.refreshInputStatus(true);
      this.buildSourceGrid();
      // The album arrives asynchronously, so the panel has to be built when it
      // lands rather than only at startup.
      this.buildPhotoPanel();
    };
    this.app.presets.onChange = () => this.refreshPresetSlots();
    this.app.midi.onChange = () => this.refreshMidi();
  }

  /**
   * Collapse for the sections written into index.html. Only JS-built panels
   * ever had a handler, so their twisty and their pointer cursor were lying -
   * and with Inputs pinned at the top of the column, a section that cannot be
   * folded away pushes everything else down for the rest of the set.
   *
   * Delegated, so it covers sections added to the markup later for free.
   */
  wireStaticCollapse() {
    for (const col of document.querySelectorAll('aside.left, .tabpanes')) {
      col.addEventListener('click', (e) => {
        const head = e.target.closest('.pgroup-head');
        if (!head || !col.contains(head)) return;
        const sec = head.parentElement;
        // Only the sections written into the markup. Generated panels sit inside
        // a host div and carry their own handler, so matching on "direct child
        // of the column" is exactly the line between the two - toggling both
        // would cancel out and nothing would move.
        if (!sec.matches('aside.left > .pgroup, .tabpane > .pgroup')) return;
        if (e.target.closest('.no-collapse') || e.target.closest('button, input, select')) return;
        sec.classList.toggle('collapsed');
        this.saveCollapsed();
      });
    }
    this.restoreCollapsed();
  }

  /** Which static sections are folded away, by their heading text. */
  collapsedSections() {
    const out = [];
    for (const sec of document.querySelectorAll('aside.left > .pgroup, .tabpane > .pgroup')) {
      const name = sec.querySelector('.pgroup-head h3')?.textContent;
      if (name && sec.classList.contains('collapsed')) out.push(name);
    }
    return out;
  }

  saveCollapsed() {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(this.collapsedSections())); } catch (_) {}
  }

  restoreCollapsed() {
    let names = [];
    try { names = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'); } catch (_) { return; }
    if (!Array.isArray(names) || !names.length) return;
    for (const sec of document.querySelectorAll('aside.left > .pgroup, .tabpane > .pgroup')) {
      const name = sec.querySelector('.pgroup-head h3')?.textContent;
      if (name && names.includes(name)) sec.classList.add('collapsed');
    }
  }

  /* ---------------- looks ---------------- */

  buildLookGrid() {
    const host = $('lookGrid');
    host.textContent = '';
    this.lookBtns = new Map();
    for (const look of LOOKS) {
      const b = el('button', 'lookbtn', look.name);
      if (look.cam) b.classList.add('cam');
      b.title = look.hint;
      b.addEventListener('click', () => {
        applyLook(this.app, look);
        this.activeLook = look.id;
        for (const [id, btn] of this.lookBtns) btn.classList.toggle('active', id === look.id);
        if (look.cam && !this.app.sources.webcam.ready) {
          this.toast(`${look.name} loaded — start the webcam to see it`);
        } else {
          this.toast(look.hint);
        }
      });
      host.appendChild(b);
      this.lookBtns.set(look.id, b);
    }
  }

  /* ---------------- sources ---------------- */

  buildSourceGrid() {
    const grid = $('sourceGrid');
    grid.textContent = '';
    for (const src of this.app.sources.list()) {
      const card = el('div', 'srccard');
      const kind = src.kind === 'generator' ? 'GEN'
        : src.kind === 'webcam' ? 'CAM'
        : src.kind === 'screen' ? 'SCREEN'
        : src.kind === 'element' ? 'ELEMENT'
        : src.kind === 'image' ? 'IMAGE' : 'VIDEO';
      const body = el('div', 'srcbody');
      body.appendChild(el('span', 'k', kind));
      body.appendChild(el('span', 'n', src.label));
      if (!src.ready) card.classList.add('dead');
      const inUse = this.app.layers.activeSources().has(src.key);
      card.classList.toggle('onA', inUse);
      card.draggable = true;
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/vjay-source', src.key);
        e.dataTransfer.effectAllowed = 'copy';
      });

      body.title = 'Click to add as a new layer, or drag onto the preview to place it';
      body.addEventListener('click', () => {
        const layer = this.app.addLayer(src.key);
        if (layer) this.toast(`Added layer: ${src.label}`);
        else this.toast('Layer limit reached');
      });

      card.append(body);
      card.addEventListener('contextmenu', (e) => {
        if (!src.key.startsWith('media:')) return;
        e.preventDefault();
        this.app.sources.removeFile(src.key);
      });
      grid.appendChild(card);
    }
    this.refreshGeneratorPanels();
  }

  /* ---------------- mixer / master / generators ---------------- */

  buildBasePanels() {
    this.genHost = el('div');
    document.getElementById('layerInspector').after(this.genHost);
    $('mixPanel').appendChild(this.panel.buildGroup('mix', { collapsed: true }));
    $('masterPanel').appendChild(this.panel.buildGroup('master'));
  }

  /** Show generator/element params only for sources the stack is actually using. */
  refreshGeneratorPanels() {
    if (!this.genHost) return;
    const wanted = [...this.app.layers.activeSources()]
      .filter((k) => k && (k.startsWith('gen:') || k.startsWith('el:')))
      .map((k) => (k.startsWith('gen:') ? `gen.${k.slice(4)}` : `el.${k.slice(3)}`));
    const unique = [...new Set(wanted)];
    if (this._genShown && this._genShown.join() === unique.join()) return;
    this._genShown = unique;
    this.genHost.textContent = '';
    this.panel.controls = this.panel.controls.filter((c) => c.row.isConnected);
    for (const ns of unique) {
      const g = params.groups.get(ns);
      if (!g) continue;
      this.genHost.appendChild(this.panel.buildGroup(ns, {
        title: `Source · ${g.label}`, collapsed: unique.length > 2,
      }));
    }
  }

  /* ---------------- effects ---------------- */

  buildFxChain() {
    const host = $('fxChain');
    host.textContent = '';
    this.fxSections = new Map();
    for (const id of this.app.renderer.chain) {
      const def = EFFECTS.find((e) => e.id === id);
      if (!def) continue;
      const controls = el('div', 'fxdrag no-collapse');
      const badge = el('span', 'badge', 'off');
      controls.appendChild(badge);

      const onBtn = el('button', null, '⏻');
      onBtn.title = 'Enable / bypass';
      onBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        params.setBase(`fx.${id}.enabled`, params.get(`fx.${id}.enabled`) > 0.5 ? 0 : 1);
      });
      const up = el('button', null, '▲');
      up.title = 'Earlier in the chain';
      up.addEventListener('click', (e) => { e.stopPropagation(); this.app.renderer.moveEffect(id, -1); this.buildFxChain(); });
      const down = el('button', null, '▼');
      down.title = 'Later in the chain';
      down.addEventListener('click', (e) => { e.stopPropagation(); this.app.renderer.moveEffect(id, 1); this.buildFxChain(); });
      controls.append(onBtn, up, down);

      const section = this.panel.buildGroup(`fx.${id}`, { collapsed: true, extraHeader: controls });
      section.classList.add('fxitem');
      host.appendChild(section);
      this.fxSections.set(id, { section, badge });
    }
    this.panel.controls = this.panel.controls.filter((c) => c.row.isConnected);
  }

  refreshFxBadges() {
    if (!this.fxSections) return;
    for (const [id, { badge }] of this.fxSections) {
      const on = params.get(`fx.${id}.enabled`) > 0.5;
      const text = on ? `${Math.round(params.get(`fx.${id}.mix`) * 100)}%` : 'off';
      if (badge.textContent !== text) badge.textContent = text;
      badge.classList.toggle('on', on);
    }
  }

  /* ---------------- modulation ---------------- */

  buildLfoPanels() {
    const host = $('lfoPanels');
    host.textContent = '';
    for (let i = 1; i <= 4; i++) host.appendChild(this.panel.buildGroup(`lfo${i}`, { collapsed: i > 2 }));
  }

  wireMod() {
    $('modAdd').addEventListener('click', () => {
      this.app.modulation.add();
      this.rebuildModRows();
    });
    $('modClear').addEventListener('click', () => {
      this.app.modulation.clear();
      this.rebuildModRows();
    });
    this.rebuildModRows();
  }

  addModRowFor(targetPath) {
    this.app.modulation.add('bass', targetPath, 0.5);
    this.rebuildModRows();
    this.switchTab('mod');
    this.toast(`Modulating ${params.def(targetPath)?.label || targetPath}`);
  }

  rebuildModRows() {
    const host = $('modRows');
    host.textContent = '';
    this.modRowEls.clear();
    const targets = params.modTargets();
    for (const row of this.app.modulation.rows) {
      const box = el('div', 'modrow');

      const l1 = el('div', 'line');
      const srcSel = el('select');
      for (const s of MOD_SOURCES) {
        const o = el('option', null, s.label);
        o.value = s.key;
        srcSel.appendChild(o);
      }
      srcSel.value = row.source;
      srcSel.addEventListener('input', () => { row.source = srcSel.value; });
      const arrow = el('span', 'mini', '→');
      const tgtSel = el('select');
      for (const t of targets) {
        const o = el('option', null, t.label);
        o.value = t.path;
        tgtSel.appendChild(o);
      }
      tgtSel.value = row.target;
      tgtSel.addEventListener('input', () => { row.target = tgtSel.value; });
      const del = el('button', 'x', '✕');
      del.addEventListener('click', () => { this.app.modulation.remove(row.id); this.rebuildModRows(); });
      l1.append(srcSel, arrow, tgtSel, del);

      const l2 = el('div', 'line');
      const amt = el('input', 'amt');
      amt.type = 'range';
      amt.min = -1; amt.max = 1; amt.step = 0.01; amt.value = row.amount;
      const amtVal = el('span', 'pvalue', row.amount.toFixed(2));
      amt.addEventListener('input', () => { row.amount = Number(amt.value); amtVal.textContent = row.amount.toFixed(2); });
      const curve = el('select');
      CURVES.forEach((c, i) => { const o = el('option', null, c); o.value = i; curve.appendChild(o); });
      curve.value = row.curve;
      curve.addEventListener('input', () => { row.curve = Number(curve.value); });
      const bip = el('button', 'ptoggle', '±');
      bip.title = 'Bipolar: centre the signal around zero';
      bip.classList.toggle('on', row.bipolar);
      bip.addEventListener('click', () => { row.bipolar = !row.bipolar; bip.classList.toggle('on', row.bipolar); });
      l2.append(amt, amtVal, curve, bip);

      const l3 = el('div', 'line');
      l3.appendChild(el('span', 'mini', 'smooth'));
      const sm = el('input', 'amt');
      sm.type = 'range'; sm.min = 0; sm.max = 1; sm.step = 0.01; sm.value = row.smooth;
      sm.addEventListener('input', () => { row.smooth = Number(sm.value); });
      l3.appendChild(sm);

      const meter = el('div', 'meter');
      const fill = el('i');
      meter.appendChild(fill);

      box.append(l1, l2, l3, meter);
      host.appendChild(box);
      this.modRowEls.set(row.id, { fill });
    }
  }

  refreshModMeters(features) {
    for (const row of this.app.modulation.rows) {
      const ref = this.modRowEls.get(row.id);
      if (!ref) continue;
      const v = this.app.modulation.value(row.source, features);
      ref.fill.style.width = `${Math.round(v * 100)}%`;
    }
  }

  /* ---------------- autopilot ---------------- */

  buildAutoPanel() {
    $('autoPanel').appendChild(this.panel.buildGroup('auto'));
  }

  /* ---------------- presets ---------------- */

  buildPresetSlots() {
    const host = $('presetSlots');
    host.textContent = '';
    this.presetBtns = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const b = el('button', 'pslot', String(i + 1));
      b.title = 'Click to recall · Shift+click to store · Alt+click to clear';
      b.addEventListener('click', (e) => {
        if (e.altKey) { this.app.presets.clearSlot(i); this.toast(`Cleared preset ${i + 1}`); return; }
        if (e.shiftKey) { this.app.presets.store(i); this.toast(`Stored preset ${i + 1}`); return; }
        const ok = this.app.presets.recall(i, this.app.morphBeats);
        this.toast(ok ? `Recalled preset ${i + 1}` : `Preset ${i + 1} is empty`);
      });
      host.appendChild(b);
      this.presetBtns.push(b);
    }
    this.refreshPresetSlots();
  }

  refreshPresetSlots() {
    if (!this.presetBtns) return;
    this.presetBtns.forEach((b, i) => b.classList.toggle('filled', !!this.app.presets.slots[i]));
  }

  /* ---------------- setlist ---------------- */

  wireCueBar() {
    const sl = this.app.setlist;
    $('cuePrev').addEventListener('click', () => sl.prev());
    $('cueNext').addEventListener('click', () => sl.next());
    $('cuePrevSong').addEventListener('click', () => sl.prevSong());
    $('cueNextSong').addEventListener('click', () => sl.nextSong());
    $('cueUpdate').addEventListener('click', () => {
      this.toast(sl.updateCue() ? `Updated "${sl.cue?.name}"` : 'No cue to update');
    });
    this.refreshCueBar();
  }

  refreshCueBar() {
    const readout = $('cueReadout');
    if (!readout) return;
    const text = this.app.setlist.label();
    if (readout.textContent !== text) readout.textContent = text;
    readout.classList.toggle('dirty', !!this.app.setlist.patchDirty);
  }

  /**
   * Called after anything replaces the whole state - a cue recall, a generated
   * show, a feel preview. The panels are built from the layer stack and the
   * modulation matrix, so both have to be rebuilt or they describe the old patch.
   */
  afterStateChange() {
    this.layersUI.rebuild();
    this.rebuildModRows();
    this.refreshGeneratorPanels();
    this.buildFxChain();
    this.refreshCueBar();
  }

  /* ---------------- topbar / transport ---------------- */

  wireTopbar() {
    const app = this.app;
    $('audioStart').addEventListener('click', async () => {
      try {
        const label = await app.audio.useInputDevice($('audioDevice').value || undefined);
        this.toast(`Audio: ${label}`);
        await this.refreshAudioDevices();
      } catch (e) { this.toast(`Audio failed: ${e.message}`); }
    });
    $('audioDisplay').addEventListener('click', async () => {
      try { this.toast(`Audio: ${await app.audio.useDisplayAudio()}`); }
      catch (e) { this.toast(`System audio failed: ${e.message}`); }
    });
    $('audioTest').addEventListener('click', async () => {
      try { this.toast(`Audio: ${await app.audio.useTestSignal()}`); }
      catch (e) { this.toast(`Test signal failed: ${e.message}`); }
    });
    $('audioGain').addEventListener('input', (e) => app.audio.setInputGain(Number(e.target.value)));
    $('audioMonitor').addEventListener('click', (e) => {
      const on = !e.target.classList.contains('on');
      e.target.classList.toggle('on', on);
      app.audio.setMonitor(on ? 1 : 0);
    });

    $('tapBtn').addEventListener('click', () => app.tapTempo());
    $('bpmInput').addEventListener('change', (e) => {
      app.tempo.setBpm(Number(e.target.value), true);
      $('bpmLock').classList.add('on');
    });
    $('bpmLock').addEventListener('click', (e) => {
      const on = !e.target.classList.contains('on');
      e.target.classList.toggle('on', on);
      if (on) app.tempo.setBpm(app.tempo.bpm, true); else app.tempo.unlock();
    });
    $('downbeat').addEventListener('click', () => { app.tempo.resetDownbeat(); this.toast('Downbeat reset'); });

    $('btnCamScan').addEventListener('click', async () => {
      try {
        // Labels and deviceIds only populate after permission has been granted
        // once, so a first scan needs a real getUserMedia call behind it.
        const list = await app.sources.listCameras();
        if (!list.length || !list[0].label || list[0].label.startsWith('Camera ')) {
          const probe = await navigator.mediaDevices.getUserMedia({ video: true });
          for (const t of probe.getTracks()) t.stop();
        }
        await this.refreshCameras();
        this.toast('Camera list refreshed');
      } catch (e) { this.toast(`Camera scan failed: ${e.message}`); }
    });
    $('btnScreen').addEventListener('click', async () => {
      try {
        await app.sources.startScreen();
        const target = app.compTarget();
        // While comping a plane, put it on THAT plane even if a wall layer is
        // already showing the screen - "overlay the screen here" is the ask.
        if (target || !app.layers.activeSources().has('screen')) app.addLayer('screen');
        this.buildSourceGrid();
        this.refreshInputStatus(true);
        this.toast(target
          ? `Screen capture on ${target.name} — drag it on the preview to position it`
          : 'Screen capture started — drag it on the preview to position it');
      } catch (e) { this.toast(`Screen capture failed: ${e.message}`); }
    });
    // Re-picking the surface is the way back from a capture that has frozen or
    // that is pointed at the wrong window. It keeps the layer and its position -
    // only the feed behind it changes.
    $('btnScreenRestart').addEventListener('click', async () => {
      try {
        await app.sources.startScreen();
        this.buildSourceGrid();
        this.refreshInputStatus(true);
        this.toast('Screen capture restarted');
      } catch (e) { this.toast(`Screen capture failed: ${e.message}`); }
    });
    $('btnScreenStop').addEventListener('click', () => {
      app.sources.stopScreen();
      this.buildSourceGrid();
      this.refreshInputStatus(true);
      this.toast('Screen capture stopped');
    });

    $('btnPopout').addEventListener('click', async () => {
      try {
        const r = await app.output.sendToProjector({
          // Lock the render to the projector's shape so nothing is letterboxed.
          setAspect: (a) => { if (Math.abs(a - app.outputAspect) > 0.001) app.setOutputAspect(a); },
        });
        // And to its actual pixel grid, so the wall gets native pixels rather
        // than an upscale of whatever size the preview happens to be.
        if (r.width && r.height) app.setOutputSize({ w: r.width, h: r.height });
        this.mapUI.rebuild();
        this.toast(r.message);
      } catch (e) { this.toast(e.message); }
    });
    $('btnFull').addEventListener('click', () => app.output.toggleFullscreen(app.canvas).catch(() => {}));
    $('btnRec').addEventListener('click', () => {
      app.output.toggleRecording();
      $('btnRec').classList.toggle('on', app.output.recording);
      this.toast(app.output.recording ? 'Recording…' : 'Saved recording');
    });
    $('btnHelp').addEventListener('click', () => $('help').classList.toggle('hidden'));
    $('helpClose').addEventListener('click', () => $('help').classList.add('hidden'));

    this.refreshAudioDevices();
    this.refreshCameras();
    // Hot-plugging a camera re-enumerates, so a device that appears mid-set
    // shows up in the list without a manual rescan.
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      this.refreshAudioDevices();
      this.refreshCameras();
      this.toast('Video/audio devices changed');
    });
  }

  /**
   * The Inputs panel's health line. A capture that has stopped producing frames
   * looks exactly like one showing a still picture, so say which feed is frozen,
   * for how long, and - the part that decides what you do next - why.
   *
   * Cheap enough to call every frame: it only rewrites when the text changes.
   */
  refreshInputStatus(force = false) {
    const host = $('inputStatus');
    if (!host) return;
    const app = this.app;
    const screen = app.sources.get('screen');
    const screenLive = !!(screen && screen.ready);
    $('btnScreen').hidden = screenLive;
    $('btnScreenStop').hidden = !screenLive;
    $('btnScreenRestart').hidden = !screenLive;

    const stalled = app.sources.stalledSources();
    // A signature, so an unchanged panel is not rebuilt 60 times a second.
    const sig = stalled.map((s) => `${s.key}:${s.stall.kind}:${
      ((performance.now() - s.stall.since) / 1000).toFixed(0)}`).join('|');
    if (!force && sig === this._inputSig) return;
    this._inputSig = sig;

    host.textContent = '';
    for (const src of stalled) {
      const info = src.checkStall();
      if (!info) continue;
      const row = el('div', 'instat');
      row.appendChild(el('span', 'inname', `${src.label} · frozen ${info.for.toFixed(0)}s`));
      row.appendChild(el('span', 'inwhy', info.message));
      host.appendChild(row);
    }
  }

  async refreshAudioDevices() {
    const sel = $('audioDevice');
    const prev = sel.value;
    const list = await this.app.audio.listInputs();
    sel.textContent = '';
    if (!list.length) {
      const o = el('option', null, 'Grant permission to list devices');
      o.value = '';
      sel.appendChild(o);
      return;
    }
    // Monitor devices first - that is the system-audio path on Linux.
    list.sort((a, b) => Number(b.isMonitor) - Number(a.isMonitor));
    for (const d of list) {
      const o = el('option', null, (d.isMonitor ? '🔁 ' : '') + d.label);
      o.value = d.deviceId;
      sel.appendChild(o);
    }
    if (prev) sel.value = prev;
  }

  /** One row per detected camera, each independently startable into its own slot. */
  async refreshCameras() {
    const host = $('cameraList');
    if (!host) return;
    const list = await this.app.sources.listCameras();
    host.textContent = '';

    if (!list.length) {
      host.appendChild(el('p', 'hint', 'No cameras detected. Press ⟳ Cameras to grant access and re-scan.'));
      return;
    }

    for (const dev of list) {
      const row = el('div', 'camrow');
      const slotKey = this.app.sources.cameraAssignments.get(dev.deviceId);
      const src = slotKey ? this.app.sources.get(slotKey) : null;
      const live = !!(src && src.ready);
      row.classList.toggle('live', live);

      const name = el('span', 'cname', dev.label);
      name.title = dev.label;
      row.appendChild(name);
      if (dev.isInfrared) {
        const ir = el('span', 'cir', 'IR');
        ir.title = 'Looks like an infrared / depth sensor';
        row.appendChild(ir);
      }
      if (live) {
        const tag = el('span', 'cslot', slotKey.toUpperCase());
        row.appendChild(tag);
      }

      // The song feels all point at slot `cam`, so which physical camera lands
      // in that slot decides what the visuals actually see. Everything else is
      // a second angle, or the one aimed at the wall for calibration.
      if (live && slotKey !== 'cam') {
        const star = el('button', null, '★');
        star.title = 'Use this camera for the visuals — every camera look and song feel '
          + 'reads slot CAM, so this is what decides which camera they show';
        star.addEventListener('click', async () => {
          try {
            await this.app.sources.useForVisuals(dev.deviceId);
            await this.refreshCameras();
            this.buildSourceGrid();
            this.mapUI.rebuild();
            this.toast(`${dev.label} now drives the visuals`);
          } catch (e) { this.toast(`Could not switch: ${e.message}`); }
        });
        row.appendChild(star);
      }

      const btn = el('button', null, live ? 'Stop' : 'Start');
      btn.addEventListener('click', async () => {
        try {
          if (live) {
            this.app.sources.stopCamera(slotKey);
            this.toast(`Stopped ${dev.label}`);
          } else {
            const started = await this.app.sources.startCamera(dev.deviceId);
            const target = this.app.compTarget();
            if (target || !this.app.layers.activeSources().has(started.key)) {
              this.app.addLayer(started.key);
            }
            this.toast(target ? `${dev.label} → ${target.name}` : `${dev.label} → ${started.key}`);
          }
          await this.refreshCameras();
          this.buildSourceGrid();
        } catch (e) { this.toast(`Camera failed: ${e.message}`); }
      });
      row.appendChild(btn);
      host.appendChild(row);
    }
    this.buildCameraControls();
    this.buildPhotoPanel();
  }

  /**
   * The album, as two decks. Two rather than one because a deck's photo is a
   * single parameter, so two frames showing different pictures needs two.
   */
  buildPhotoPanel() {
    const host = $('photoPanel');
    if (!host) return;
    host.textContent = '';
    this.panel.controls = this.panel.controls.filter((c) => c.row.isConnected);
    const n = this.app.sources.photoCount;
    if (!n) return;

    const sec = el('section', 'pgroup');
    const head = el('header', 'pgroup-head');
    head.appendChild(el('span', 'twisty', '▾'));
    head.appendChild(el('h3', null, `Photos (${n})`));
    head.addEventListener('click', (e) => {
      if (e.target.closest('.no-collapse')) return;
      sec.classList.toggle('collapsed');
    });
    sec.appendChild(head);
    const body = el('div', 'pgroup-body');
    sec.appendChild(body);

    for (const key of ['photo', 'photo2']) {
      const src = this.app.sources.get(key);
      if (!src) continue;
      const bar = el('div', 'srcbar no-collapse');
      bar.appendChild(el('span', 'mini', key === 'photo' ? 'deck 1' : 'deck 2'));
      const step = (d) => {
        const cur = params.getBase(`${key}.index`);
        params.setBase(`${key}.index`, ((Math.round(cur) + d) % n + n) % n);
      };
      const prev = el('button', 'ptoggle', '◀');
      prev.addEventListener('click', () => step(-1));
      const next = el('button', 'ptoggle', '▶');
      next.addEventListener('click', () => step(1));
      const rnd = el('button', 'ptoggle', '🎲');
      rnd.title = 'A random picture';
      rnd.addEventListener('click', () => {
        params.setBase(`${key}.index`, Math.floor(Math.random() * n));
      });
      const add = el('button', 'ptoggle', '+ layer');
      add.title = 'Add this deck as a layer — on the plane you are comping, if you are';
      add.addEventListener('click', () => {
        const l = this.app.addLayer(key);
        this.toast(l ? `${src.label} added` : 'Layer limit reached');
      });
      bar.append(prev, next, rnd, add);
      body.appendChild(bar);
      const row = this.panel.buildControl(params.def(`${key}.index`));
      body.appendChild(row);
    }
    body.appendChild(el('p', 'hint',
      'The generated show puts a photo in the frames of every song, one per song. '
      + 'Pin a deck onto any plane to hold a picture there regardless of the cue.'));
    host.appendChild(sec);
  }

  /**
   * Zoom, pan and mirror per camera. These live on the SOURCE, so a camera
   * framed here looks the same in every comp that uses it and in every pin -
   * rather than needing the same crop dialled into each layer separately.
   */
  buildCameraControls() {
    const host = $('cameraControls');
    if (!host) return;
    host.textContent = '';
    this.panel.controls = this.panel.controls.filter((c) => c.row.isConnected);
    const live = this.app.sources.activeCameras();
    if (!live.length) return;
    for (const src of live) {
      const sec = this.panel.buildGroup(src.key, {
        title: `${src.label} framing`, collapsed: live.length > 1,
      });
      const body = sec.querySelector('.pgroup-body');
      const bar = el('div', 'srcbar no-collapse');
      const wide = el('button', 'ptoggle', '⤢ Widest');
      wide.title = 'Back to the whole sensor — as wide as this lens goes';
      wide.addEventListener('click', () => {
        params.setBase(`${src.key}.zoom`, 1);
        params.setBase(`${src.key}.panX`, 0);
        params.setBase(`${src.key}.panY`, 0);
        this.toast(`${src.label} at its widest`);
      });
      bar.appendChild(wide);
      const turn = el('button', 'ptoggle', '⟳ 180°');
      turn.title = 'Turn this camera the right way up — for one mounted upside down '
        + 'on top of a projector. Fixes it in every comp and pin at once.';
      const upsideDown = params.getBase(`${src.key}.flip`) > 0.5
        && params.getBase(`${src.key}.mirror`) > 0.5;
      turn.classList.toggle('on', upsideDown);
      turn.addEventListener('click', () => {
        const on = !upsideDown;
        params.setBase(`${src.key}.flip`, on ? 1 : 0);
        params.setBase(`${src.key}.mirror`, on ? 1 : 0);
        this.toast(`${src.label} ${on ? 'rotated 180°' : 'back the normal way up'}`);
        this.buildCameraControls();
      });
      bar.appendChild(turn);
      body?.prepend(bar);
      host.appendChild(sec);
    }
  }

  wireTransport() {
    const app = this.app;
    $('editToggle').addEventListener('click', () => app.setEditHandles(!app.editor.enabled));
    this.crossfader = $('crossfader');
    this.crossfader.addEventListener('input', (e) => params.setBase('mix.fade', Number(e.target.value)));
    $('morphBeats').addEventListener('input', (e) => { app.morphBeats = Number(e.target.value) || 0; });
    $('presetExport').addEventListener('click', () => app.presets.exportFile());
    $('presetImport').addEventListener('click', () => $('presetFile').click());
    $('presetFile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try { await app.presets.importFile(f); this.toast('Presets imported'); }
      catch (err) { this.toast(`Import failed: ${err.message}`); }
      e.target.value = '';
    });
  }

  wireTabs() {
    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    }
  }

  switchTab(name) {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
    for (const p of document.querySelectorAll('.tabpane')) p.classList.toggle('active', p.dataset.tab === name);
    // Corner handles go live with the Setup tab, so the overlay's pointer gating
    // has to be recomputed here rather than only when a tool button is pressed.
    this.app.mapEditor?.sync();
  }

  wireSystem() {
    const app = this.app;
    $('flowPanel').appendChild(this.panel.buildGroup('flow', { collapsed: true }));
    $('resScale').addEventListener('input', (e) => app.setResolutionScale(Number(e.target.value)));
    const aspect = $('outAspect');
    aspect.value = String(app.outputAspect);
    aspect.addEventListener('input', (e) => app.setOutputAspect(Number(e.target.value)));
    $('fpsCap').addEventListener('input', (e) => { app.fpsCap = Number(e.target.value); });
    $('clearFeedback').addEventListener('click', () => { app.renderer.clearFeedback(); this.toast('Feedback cleared'); });
    $('midiEnable').addEventListener('click', async () => {
      try {
        const names = await app.midi.enable();
        $('midiEnable').classList.add('on');
        $('midiEnable').textContent = 'Enabled';
        this.toast(names.length ? `MIDI: ${names.join(', ')}` : 'MIDI enabled (no devices)');
      } catch (e) { this.toast(`MIDI failed: ${e.message}`); }
    });
    $('midiClear').addEventListener('click', () => { app.midi.clearAll(); this.toast('MIDI mappings cleared'); });

    $('lyricParams').appendChild(this.panel.buildGroup('lyrics', { title: 'Text' }));
    const lyricBtn = $('lyricToggle');
    lyricBtn.addEventListener('click', () => {
      const on = app.lyrics.listening || app.lyrics._wantOn;
      if (on) { app.lyrics.stop(); this.toast('Lyrics off'); }
      else if (app.lyrics.start()) {
        this.toast('Listening — add "Lyrics (live)" as a layer, or pin it over a comp');
      } else {
        this.toast(app.lyrics.error || 'Speech recognition is not available here');
      }
      this.refreshLyrics();
    });
    $('lyricClear').addEventListener('click', () => { app.lyrics.clear(); this.refreshLyrics(); });
    app.lyrics.onChange = () => this.refreshLyrics();
    this.refreshLyrics();
  }

  refreshLyrics() {
    const app = this.app;
    const btn = $('lyricToggle');
    const st = $('lyricStatus');
    const line = $('lyricLine');
    if (!btn || !st) return;
    const on = app.lyrics.listening || app.lyrics._wantOn;
    btn.classList.toggle('on', on);
    btn.textContent = on ? '● Listening' : '● Listen';
    st.textContent = app.lyrics.error ? app.lyrics.error
      : !app.lyrics.supported ? 'Not available in this browser — Chrome has it.'
      : on ? (app.lyrics.listening ? 'Listening.' : 'Reconnecting…')
      : 'Off.';
    st.classList.toggle('warn', !!app.lyrics.error);
    if (line) line.textContent = app.lyrics.line || '—';
  }

  refreshMidi() {
    const status = $('midiStatus');
    const midi = this.app.midi;
    status.textContent = midi.learning
      ? `Learning: move a control to map ${midi.learning}`
      : midi.enabled
        ? `Last message: ${midi.lastMessage || '—'}`
        : 'Right-click any control to learn a knob once MIDI is enabled.';
    const list = $('midiList');
    list.textContent = '';
    for (const k in midi.mappings) {
      const d = el('div');
      d.appendChild(el('span', null, k));
      d.appendChild(el('span', null, midi.mappings[k].path || `⚑ ${midi.mappings[k].action}`));
      list.appendChild(d);
    }
  }

  buildHelp() {
    const table = $('helpTable');
    table.textContent = '';
    for (const [k, v] of SHORTCUTS) {
      const tr = el('tr');
      tr.appendChild(el('td', null, k));
      tr.appendChild(el('td', null, v));
      table.appendChild(tr);
    }
  }

  wireDropzone() {
    const zone = $('dropzone');
    let depth = 0;
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; zone.classList.remove('hidden'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.add('hidden'); } });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      zone.classList.add('hidden');
      for (const file of e.dataTransfer.files) {
        if (file.type.startsWith('audio/')) {
          try { this.toast(`Audio: ${await this.app.audio.useFile(file)}`); }
          catch (err) { this.toast(`Audio file failed: ${err.message}`); }
          continue;
        }
        const src = await this.app.sources.addFile(file);
        if (src) {
          this.app.addLayer(src.key);
          this.toast(`Loaded ${src.label} as a layer`);
        } else {
          this.toast(`Unsupported file: ${file.name}`);
        }
      }
      this.buildSourceGrid();
    });
  }

  toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
  }

  /* ---------------- per-frame refresh ---------------- */

  update(features, now) {
    this.panel.refresh();
    this.refreshFxBadges();
    this.refreshModMeters(features);
    if (this.crossfader && document.activeElement !== this.crossfader) {
      const v = String(params.getBase('mix.fade'));
      if (this.crossfader.value !== v) this.crossfader.value = v;
    }
    const bpmInput = $('bpmInput');
    if (document.activeElement !== bpmInput) {
      const v = this.app.tempo.bpm.toFixed(1);
      if (bpmInput.value !== v) bpmInput.value = v;
    }

    this.mapUI.refreshStatus($('mapStatus'));
    this.refreshCueBar();

    const st = $('statusAudio');
    const label = this.app.audio.kind === 'none' ? 'no audio' : this.app.audio.sourceLabel;
    if (st.textContent !== label) st.textContent = label;
    st.classList.toggle('live', this.app.audio.kind !== 'none');

    if (this.app.output.recording) {
      $('btnRec').textContent = `● ${this.app.output.recordSeconds().toFixed(0)}s`;
    } else if ($('btnRec').textContent !== '● REC') {
      $('btnRec').textContent = '● REC';
      $('btnRec').classList.remove('on');
    }

    if (now - this._lastDiag > 500) {
      this._lastDiag = now;
      $('fps').textContent = `${this.app.fps.toFixed(0)} fps`;
      this.refreshInputStatus();
      const d = $('diag');
      if (d && d.offsetParent) {
        d.textContent = [
          `render      ${this.app.renderer.width}×${this.app.renderer.height}`,
          `canvas      ${this.app.canvas.width}×${this.app.canvas.height}`
            + (this.app.outputSize ? ' (projector native)' : ''),
          `preview     ${this.app.view.mode === 'plane'
            ? `plane ${this.app.view.surface + 1}` : 'output'}`,
          `planes      ${this.app.mapping.activeSurfaces().length}`,
          `layers      ${this.app.layers.layers.length}`,
          `master fx   ${this.app.renderer.activeEffects().length}/${this.app.renderer.chain.length}`,
          `mod rows    ${this.app.modulation.rows.length}`,
          `audio       ${this.app.audio.kind} @ ${this.app.audio.sampleRate} Hz`,
          `bpm         ${this.app.tempo.bpm.toFixed(2)} conf ${this.app.tempo.confidence.toFixed(2)}`,
          `beat        ${this.app.tempo.beatCount} phase ${this.app.tempo.phase.toFixed(2)}`,
          `float FBOs  ${this.app.gl.floatTargets ? 'RGBA16F' : 'RGBA8'}`,
        ].join('\n');
      }
    }

    if (this.app.autopilot.log.length && this._lastLog !== this.app.autopilot.log[0]) {
      this._lastLog = this.app.autopilot.log[0];
      $('autoLog').textContent = this.app.autopilot.log.join('\n');
    }
  }
}
