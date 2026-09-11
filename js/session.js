// Session state: everything that is neither a cue nor a venue calibration, but
// that you would be annoyed to set up twice.
//
// The show, the surfaces, the MIDI map and the camera slots each persist in
// their own key already. This covers the rest of the rig - render settings,
// which input you picked, where you were in the set, what the UI looked like -
// so that reloading mid-setup, or reopening after a crash, puts you back where
// you were rather than at a default patch on song one.
//
// Restoring is best-effort by design. A device that has been unplugged, or a
// permission that was withdrawn, must never stop the app from starting.

const KEY = 'vjay.session.v1';

export class Session {
  constructor(app) {
    this.app = app;
    this.ready = false;
    this._timer = null;
  }

  snapshot() {
    const app = this.app;
    return {
      v: 1,
      resScale: app.resScale,
      fpsCap: app.fpsCap,
      outputAspect: app.outputAspect,
      morphBeats: app.morphBeats,
      audio: {
        kind: app.audio.kind,
        deviceId: app.audio.deviceId || null,
        gain: Number(document.getElementById('audioGain')?.value ?? 1),
        monitor: document.getElementById('audioMonitor')?.classList.contains('on') || false,
      },
      tempo: { bpm: app.tempo.bpm, locked: document.getElementById('bpmLock')?.classList.contains('on') || false },
      ui: {
        tab: document.querySelector('.tab.active')?.dataset.tab || 'fx',
        // `hidden` is deliberately NOT saved. Hiding the UI is something you do
        // for a moment on stage; restoring it on boot leaves you staring at a
        // bare canvas with every control gone and nothing saying which key
        // brings them back.
        editHandles: !!app.editor?.enabled,
        selectedSurface: app.mapping?.selected ?? 0,
      },
      setlist: { song: app.setlist.songIndex, cue: app.setlist.cueIndex },
      savedAt: Date.now(),
    };
  }

  save() {
    if (!this.ready) return;          // never persist the half-built boot state
    try { localStorage.setItem(KEY, JSON.stringify(this.snapshot())); } catch (_) {}
  }

  /** Coalesce the many small changes a single interaction produces. */
  schedule() {
    if (!this.ready) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.save(), 700);
  }

  read() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; }
  }

  clear() {
    try { localStorage.removeItem(KEY); } catch (_) {}
  }

  /**
   * Put the rig back. Call after the show has loaded, so the setlist position
   * lands on cues that exist.
   */
  async restore() {
    const st = this.read();
    if (!st) { this.ready = true; return null; }
    const app = this.app;
    const done = [];

    try {
      if (typeof st.outputAspect === 'number' && st.outputAspect !== app.outputAspect) {
        app.outputAspect = st.outputAspect;
        app._onResize();
      }
      if (typeof st.resScale === 'number' && st.resScale !== 1) {
        app.resScale = st.resScale;
        app._onResize();
        const sel = document.getElementById('resScale');
        if (sel) sel.value = String(st.resScale);
      }
      if (typeof st.fpsCap === 'number') {
        app.fpsCap = st.fpsCap;
        const sel = document.getElementById('fpsCap');
        if (sel) sel.value = String(st.fpsCap);
      }
      if (typeof st.morphBeats === 'number') {
        app.morphBeats = st.morphBeats;
        const el = document.getElementById('morphBeats');
        if (el) el.value = String(st.morphBeats);
      }
      done.push('render settings');
    } catch (_) {}

    // UI shape.
    try {
      if (st.ui?.tab) app.ui.switchTab(st.ui.tab);
      if (st.ui?.editHandles === false && app.editor) app.setEditHandles(false);
      if (app.mapping && typeof st.ui?.selectedSurface === 'number') {
        app.mapping.selected = st.ui.selectedSurface;
      }
    } catch (_) {}

    // Where you were in the set. Clamped, because the show may have changed.
    try {
      if (app.setlist.songCount && st.setlist) {
        const song = Math.max(0, Math.min(st.setlist.song || 0, app.setlist.songCount - 1));
        const cues = app.setlist.songs[song]?.cues.length || 0;
        const cue = Math.max(0, Math.min(st.setlist.cue || 0, Math.max(0, cues - 1)));
        app.setlist.go(song, cue, { morph: 0 });
        done.push(`cue ${song + 1}/${app.setlist.songCount}`);
      }
    } catch (_) {}

    // The audio input, if it can be reopened without a fresh prompt.
    try {
      const a = st.audio || {};
      if (a.gain != null) {
        app.audio.setInputGain(a.gain);
        const g = document.getElementById('audioGain');
        if (g) g.value = String(a.gain);
      }
      if (a.kind === 'mic') {
        const granted = await navigator.permissions?.query({ name: 'microphone' })
          .then((r) => r.state === 'granted').catch(() => false);
        if (granted) {
          const label = await app.audio.useInputDevice(a.deviceId || undefined);
          if (a.monitor) {
            app.audio.setMonitor(1);
            document.getElementById('audioMonitor')?.classList.add('on');
          }
          await app.ui.refreshAudioDevices();
          const sel = document.getElementById('audioDevice');
          if (sel && a.deviceId) sel.value = a.deviceId;
          done.push(`audio “${label}”`);
        }
      } else if (a.kind === 'test') {
        // Needs a gesture; boot() arms one and picks this up.
        app.pendingTestSignal = true;
      }
      // 'display' and 'file' cannot be reopened without the user choosing again.
    } catch (_) {}

    try {
      if (st.tempo?.locked && st.tempo.bpm) {
        app.tempo.setBpm(st.tempo.bpm, true);
        document.getElementById('bpmLock')?.classList.add('on');
      }
    } catch (_) {}

    this.ready = true;
    return done;
  }

  /** Save on the things that actually change the rig, plus on the way out. */
  install() {
    const s = () => this.schedule();
    for (const id of ['resScale', 'fpsCap', 'morphBeats', 'audioGain', 'audioDevice', 'bpmLock', 'audioMonitor']) {
      document.getElementById(id)?.addEventListener('change', s);
      document.getElementById(id)?.addEventListener('click', s);
    }
    for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', s);
    document.getElementById('editToggle')?.addEventListener('click', s);
    window.addEventListener('keyup', s);
    window.addEventListener('pointerup', s);
    // pagehide fires where beforeunload is unreliable, and both fire on a reload.
    window.addEventListener('pagehide', () => this.save());
    window.addEventListener('beforeunload', () => this.save());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.save();
    });
  }
}
