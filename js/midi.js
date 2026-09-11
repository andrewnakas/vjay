// WebMIDI with learn mode. Click a slider, twist a knob, done.
// Mappings persist in localStorage and survive preset changes.

import { params } from './params.js';

const STORAGE_KEY = 'vjay.midi.v1';

export class MidiControl {
  constructor(app) {
    this.app = app;
    this.access = null;
    this.mappings = {};      // "ch:type:num" -> { path, invert }
    this.learning = null;    // path awaiting a control message
    this.enabled = false;
    this.lastMessage = '';
    this.onChange = () => {};
    this.load();
  }

  async enable() {
    if (!navigator.requestMIDIAccess) throw new Error('WebMIDI is not available in this browser.');
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this._bind();
    this.access.onstatechange = () => this._bind();
    this.enabled = true;
    this.onChange();
    return [...this.access.inputs.values()].map((i) => i.name);
  }

  _bind() {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) input.onmidimessage = (e) => this._onMessage(e);
  }

  _key(status, num) {
    const ch = status & 0x0f;
    const type = status & 0xf0;
    return `${ch}:${type}:${num}`;
  }

  startLearn(path) { this.learning = path; this.onChange(); }

  /**
   * Learn a footswitch. A cue change is a button press, not a value, so these
   * map to an action rather than a parameter - which is what lets a cheap
   * sustain pedal walk the setlist while both hands are on an instrument.
   */
  startLearnAction(action) { this.learning = { action }; this.onChange(); }
  cancelLearn() { this.learning = null; this.onChange(); }

  mappedKeyForAction(action) {
    for (const k in this.mappings) if (this.mappings[k].action === action) return k;
    return null;
  }

  unmapAction(action) {
    for (const k in this.mappings) if (this.mappings[k].action === action) delete this.mappings[k];
    this.save();
    this.onChange();
  }

  _runAction(action) {
    const app = this.app;
    switch (action) {
      case 'nextCue': app.setlist.next(); break;
      case 'prevCue': app.setlist.prev(); break;
      case 'nextSong': app.setlist.nextSong(); break;
      case 'prevSong': app.setlist.prevSong(); break;
      case 'updateCue': app.toast(app.setlist.updateCue() ? 'Cue updated' : 'No cue to update'); break;
      case 'blackout': params.setBase('master.blackout', params.get('master.blackout') > 0.5 ? 0 : 1); break;
      case 'bypassMap': params.setBase('map.bypass', params.get('map.bypass') > 0.5 ? 0 : 1); break;
      default: break;
    }
  }

  unmap(path) {
    for (const k in this.mappings) if (this.mappings[k].path === path) delete this.mappings[k];
    this.save();
    this.onChange();
  }

  mappedKeyFor(path) {
    for (const k in this.mappings) if (this.mappings[k].path === path) return k;
    return null;
  }

  _onMessage(e) {
    const [status, num, val] = e.data;
    const type = status & 0xf0;
    if (type !== 0xb0 && type !== 0x90 && type !== 0x80) return; // CC / note on / note off
    const key = this._key(status, num);
    this.lastMessage = `ch${(status & 0x0f) + 1} ${type === 0xb0 ? 'CC' : 'note'} ${num} = ${val}`;

    if (this.learning) {
      this.mappings[key] = typeof this.learning === 'string'
        ? { path: this.learning, invert: false }
        : { action: this.learning.action };
      this.learning = null;
      this.save();
      this.onChange();
      return;
    }

    const map = this.mappings[key];
    if (!map) { this.onChange(); return; }
    if (map.action) {
      // Fire on press only: a footswitch sends note-off (or CC 0) on release,
      // which would otherwise advance the set twice per stomp.
      if ((type === 0x90 && val > 0) || (type === 0xb0 && val > 63)) this._runAction(map.action);
      this.onChange();
      return;
    }
    const def = params.def(map.path);
    if (!def) return;

    if (type === 0xb0) {
      let t = val / 127;
      if (map.invert) t = 1 - t;
      params.setBase(map.path, def.min + t * (def.max - def.min));
    } else if (def.type === 'bool') {
      // Notes latch bools: note-on toggles, note-off is ignored.
      if (type === 0x90 && val > 0) params.setBase(map.path, params.get(map.path) > 0.5 ? 0 : 1);
    } else {
      if (type === 0x90 && val > 0) params.setBase(map.path, def.max);
      else params.setBase(map.path, def.min);
    }
  }

  save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.mappings)); } catch (_) {}
  }
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.mappings = JSON.parse(raw) || {};
    } catch (_) { this.mappings = {}; }
  }
  clearAll() { this.mappings = {}; this.save(); this.onChange(); }
}
