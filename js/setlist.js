// Setlist and cues.
//
// A set is ~30 songs with four or five views each: 150 states, recalled in
// order, live. The eight preset slots cannot hold that and are not organised by
// song, so this sits on top of the same Presets machinery - a cue is one
// compacted preset snapshot plus how long to glide into it.
//
// Everything here is judged by "does it survive a live set": the position is
// remembered across a reload, saving is best-effort and never blocks a recall,
// and next/prev always land somewhere valid.

const STORAGE_KEY = 'vjay.show.v1';
const POS_KEY = 'vjay.show.pos';

let uid = 1;
const nextId = () => `${Date.now().toString(36)}-${uid++}`;

export const DEFAULT_CUE_NAMES = ['Intro', 'Verse', 'Chorus', 'Bridge', 'Outro'];

export class Setlist {
  constructor(app) {
    this.app = app;
    this.show = { vjay: 2, name: 'Untitled set', songs: [] };
    this.songIndex = 0;
    this.cueIndex = 0;
    this.dirty = false;
    this.onChange = () => {};
    this._saveTimer = null;
    this._bytes = 0;              // size of the last saved show; see stats()
    this.load();
  }

  get songs() { return this.show.songs; }
  get song() { return this.show.songs[this.songIndex] || null; }
  get cue() { return this.song?.cues[this.cueIndex] || null; }
  get songCount() { return this.show.songs.length; }
  get cueCount() { return this.song?.cues.length || 0; }

  /**
   * "12/30 · Wildwood Flower · 3/5 Chorus", for the transport readout.
   *
   * A trailing dot means what is on screen is no longer the cue named here -
   * a Look was clicked, or a feel was tried. Without it the transport quietly
   * lies about the state of the rig, which is the last thing you want when you
   * are deciding what to press next.
   */
  label() {
    if (!this.songCount) return 'No show loaded';
    const song = this.song;
    if (!song) return 'No show loaded';
    const cue = this.cue;
    return `${this.songIndex + 1}/${this.songCount} · ${song.name}`
      + (song.cues.length ? ` · ${this.cueIndex + 1}/${song.cues.length} ${cue ? cue.name : ''}` : ' · no cues')
      + (this.patchDirty ? ' •' : '');
  }

  /** Something replaced the patch out from under the current cue. */
  markDirty() {
    if (this.patchDirty) return;
    this.patchDirty = true;
    this.onChange();
  }

  /* ---------------- songs ---------------- */

  addSong(name = null, { feel = null, at = null } = {}) {
    const song = {
      id: nextId(),
      name: name || `Song ${this.songCount + 1}`,
      feel: feel || null,
      variant: 0,
      cues: [],
    };
    const i = at == null ? this.songs.length : Math.max(0, Math.min(this.songs.length, at));
    this.songs.splice(i, 0, song);
    this._changed();
    return song;
  }

  renameSong(i, name) {
    const s = this.songs[i];
    if (!s || !name) return;
    s.name = name;
    this._changed();
  }

  removeSong(i) {
    if (!this.songs[i]) return;
    this.songs.splice(i, 1);
    this.songIndex = Math.max(0, Math.min(this.songIndex, this.songs.length - 1));
    this.cueIndex = 0;
    this._changed();
  }

  moveSong(i, delta) {
    const j = i + delta;
    if (!this.songs[i] || j < 0 || j >= this.songs.length) return;
    const [s] = this.songs.splice(i, 1);
    this.songs.splice(j, 0, s);
    if (this.songIndex === i) this.songIndex = j;
    else if (this.songIndex === j) this.songIndex = i;
    this._changed();
  }

  selectSong(i) {
    if (!this.songs[i]) return;
    this.songIndex = i;
    this.cueIndex = 0;
    this._changed();
  }

  /* ---------------- cues ---------------- */

  addCueFromLive(name = null, { morphBeats = 4, at = null } = {}) {
    const song = this.song;
    if (!song) return null;
    const cue = {
      id: nextId(),
      name: name || `Cue ${song.cues.length + 1}`,
      morphBeats,
      state: this.app.presets.capture(),
    };
    const i = at == null ? song.cues.length : Math.max(0, Math.min(song.cues.length, at));
    song.cues.splice(i, 0, cue);
    this.cueIndex = i;
    this._changed();
    return cue;
  }

  /** Overwrite the selected cue with what is on screen right now. */
  updateCue() {
    const cue = this.cue;
    if (!cue) return false;
    cue.state = this.app.presets.capture();
    this.patchDirty = false;
    this._changed();
    return true;
  }

  renameCue(i, name) {
    const cue = this.song?.cues[i];
    if (!cue || !name) return;
    cue.name = name;
    this._changed();
  }

  setMorph(i, beats) {
    const cue = this.song?.cues[i];
    if (!cue) return;
    cue.morphBeats = Math.max(0, Number(beats) || 0);
    this._changed();
  }

  removeCue(i) {
    const song = this.song;
    if (!song?.cues[i]) return;
    song.cues.splice(i, 1);
    this.cueIndex = Math.max(0, Math.min(this.cueIndex, song.cues.length - 1));
    this._changed();
  }

  moveCue(i, delta) {
    const song = this.song;
    const j = i + delta;
    if (!song?.cues[i] || j < 0 || j >= song.cues.length) return;
    const [c] = song.cues.splice(i, 1);
    song.cues.splice(j, 0, c);
    if (this.cueIndex === i) this.cueIndex = j;
    else if (this.cueIndex === j) this.cueIndex = i;
    this._changed();
  }

  /* ---------------- navigation ---------------- */

  go(songIndex, cueIndex, { morph = null } = {}) {
    const song = this.songs[songIndex];
    if (!song) return false;
    this.songIndex = songIndex;
    this.cueIndex = Math.max(0, Math.min(cueIndex, Math.max(0, song.cues.length - 1)));
    const cue = song.cues[this.cueIndex];
    this.patchDirty = false;
    if (cue) {
      this.app.presets.applyState(cue.state, morph == null ? cue.morphBeats : morph);
      this.app.ui?.afterStateChange?.();
    }
    this._savePosition();
    this.onChange();
    return !!cue;
  }

  /** Advance one cue, rolling into the next song at the end of this one. */
  next() {
    if (!this.songCount) return false;
    if (this.cueIndex + 1 < this.cueCount) return this.go(this.songIndex, this.cueIndex + 1);
    if (this.songIndex + 1 < this.songCount) {
      const ok = this.go(this.songIndex + 1, 0);
      this.app.toast?.(`▶ ${this.song?.name || ''}`);
      return ok;
    }
    this.app.toast?.('End of the set');
    return false;
  }

  prev() {
    if (!this.songCount) return false;
    if (this.cueIndex > 0) return this.go(this.songIndex, this.cueIndex - 1);
    if (this.songIndex > 0) {
      const target = this.songIndex - 1;
      return this.go(target, Math.max(0, (this.songs[target].cues.length || 1) - 1));
    }
    return false;
  }

  nextSong() {
    if (this.songIndex + 1 >= this.songCount) { this.app.toast?.('End of the set'); return false; }
    const ok = this.go(this.songIndex + 1, 0);
    this.app.toast?.(`▶ ${this.song?.name || ''}`);
    return ok;
  }

  prevSong() {
    if (this.songIndex <= 0) return false;
    const ok = this.go(this.songIndex - 1, 0);
    this.app.toast?.(`◀ ${this.song?.name || ''}`);
    return ok;
  }

  /** Restore the last position after a reload, mid-set crash included. */
  resumePosition() {
    if (!this.songCount) return false;
    let pos = null;
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (raw) pos = JSON.parse(raw);
    } catch (_) { pos = null; }
    const s = Math.max(0, Math.min(pos?.song ?? 0, this.songCount - 1));
    const c = Math.max(0, pos?.cue ?? 0);
    return this.go(s, c, { morph: 0 });
  }

  _savePosition() {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ song: this.songIndex, cue: this.cueIndex }));
    } catch (_) { /* a full quota must never break a cue change */ }
    this.app.session?.schedule();
  }

  /* ---------------- persistence ---------------- */

  replaceShow(show, { name = null } = {}) {
    this.show = {
      vjay: 2,
      name: name || show?.name || 'Untitled set',
      songs: Array.isArray(show?.songs) ? show.songs : [],
    };
    this.songIndex = 0;
    this.cueIndex = 0;
    this._changed();
  }

  _changed() {
    this.dirty = true;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.save(), 300);
    this.onChange();
  }

  save() {
    try {
      const json = JSON.stringify(this.show);
      // Remember the size here rather than measuring it on demand. `stats()` is
      // read by the Show panel, which rebuilds on every cue, song and look
      // click - and stringifying a 90-song set is most of a second of blocked
      // main thread each time, which stalls the render loop, the projector and
      // every video source with it.
      this._bytes = json.length;
      localStorage.setItem(STORAGE_KEY, json);
      this.dirty = false;
      this.saveError = null;
    } catch (e) {
      // 150 cues can outgrow the quota. Say so once, loudly, and keep playing -
      // the export file is the real backup.
      this.saveError = e.message;
      if (!this._warned) {
        this._warned = true;
        this.app.toast?.('Show too big for browser storage — export it to a file');
      }
      console.warn('[setlist] could not save', e);
    }
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.songs)) {
        this.show = { vjay: 2, name: data.name || 'Untitled set', songs: data.songs };
        this._bytes = raw.length;
      }
    } catch (e) {
      console.warn('[setlist] could not read localStorage', e);
    }
  }

  /** One file holds the set AND the venue calibration - that is the show. */
  exportFile() {
    const payload = { vjay: 2, show: this.show, mapping: this.app.mapping.serialize() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const safe = (this.show.name || 'set').replace(/[^\w-]+/g, '-').toLowerCase();
    a.download = `vjay-show-${safe}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async importFile(file, opts = {}) {
    return this.importData(JSON.parse(await file.text()), opts);
  }

  /** Shared by the file picker and the `?load=` launch param. */
  importData(data, { withMapping = true } = {}) {
    const show = data?.show || (Array.isArray(data?.songs) ? data : null);
    if (!show || !Array.isArray(show.songs)) throw new Error('Not a VJay show file');
    this.replaceShow(show);
    if (withMapping && data.mapping) this.app.mapping.restore(data.mapping);
    this.save();
    return show.songs.length;
  }

  /**
   * Song / cue / byte counts for the Show panel. The byte count is whatever the
   * last save measured: it is a hint printed under the panel, not something
   * worth stalling every click for. `save()` runs 300 ms after any edit, so it
   * is never more than one edit stale.
   */
  stats() {
    const cues = this.songs.reduce((n, s) => n + s.cues.length, 0);
    return { songs: this.songCount, cues, bytes: this._bytes || 0, stale: this.dirty };
  }
}

