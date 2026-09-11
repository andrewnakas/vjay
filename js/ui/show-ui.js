// The Show tab: songs, cues, and the generator that fills them in.
//
// The list is built to be usable at a gig - big next/previous, the live cue
// obvious, and "Update cue" one click away, because most editing during a
// rehearsal is "make it look right, then overwrite the cue you are standing on".

import { el } from './panel.js';
import { FEELS, generateShow, regenerateSong, regenerateAll, buildFeel } from '../show-templates.js';
import { DEFAULT_CUE_NAMES } from '../setlist.js';

const $ = (id) => document.getElementById(id);

export class ShowUI {
  constructor(app) {
    this.app = app;
  }

  get setlist() { return this.app.setlist; }

  init() {
    this.host = $('showPanel');
    this.setlist.onChange = () => {
      this.rebuild();
      this.app.ui.refreshCueBar();
    };
    this.rebuild();
  }

  rebuild() {
    if (!this.host) return;
    const sl = this.setlist;
    this.host.textContent = '';

    const bar = el('div', 'srcbar');
    const gen = el('button', 'primary', '✨ Generate show');
    gen.title = 'Build a full set from the song feels';
    gen.addEventListener('click', () => this.openGenerator());
    const add = el('button', null, '+ Song');
    add.addEventListener('click', () => {
      const name = prompt('Song name', `Song ${sl.songCount + 1}`);
      if (name === null) return;
      const song = sl.addSong(name);
      sl.selectSong(sl.songs.indexOf(song));
    });
    bar.append(gen, add);
    this.host.appendChild(bar);

    // A cue is a snapshot of a whole layer stack, so template changes do not
    // reach a show that already exists. This is how they get there.
    if (sl.songCount) {
      const refresh = el('div', 'srcbar');
      const recue = el('button', null, '⟳ Re-cue all songs');
      recue.title = 'Rebuild every song’s cues from the current templates, keeping the '
        + 'running order, the names and each song’s feel. Picks up new camera comps.';
      recue.addEventListener('click', () => {
        if (!confirm(`Rebuild the cues for all ${sl.songCount} songs?\n\n`
          + 'Names, order and feels are kept. Any hand edits to cues are lost — '
          + 'export the show first if you want them back.')) return;
        const n = regenerateAll(this.app);
        this.app.toast(`Re-cued ${n} songs from the current templates`);
        sl.go(sl.songIndex, sl.cueIndex, { morph: 0 });
        this.app.ui.afterStateChange();
      });
      const reshuffle = el('button', null, '⤨ Reshuffle feels');
      reshuffle.title = 'Spread the feels across the set again, including ones added since '
        + 'the show was built, then rebuild every cue.';
      reshuffle.addEventListener('click', () => {
        if (!confirm(`Reassign feels across all ${sl.songCount} songs and rebuild every cue?\n\n`
          + 'Song names and order are kept; the look of every song changes.')) return;
        const n = regenerateAll(this.app, { reassign: true });
        this.app.toast(`Reshuffled and re-cued ${n} songs`);
        sl.go(sl.songIndex, sl.cueIndex, { morph: 0 });
        this.app.ui.afterStateChange();
      });
      refresh.append(recue, reshuffle);
      this.host.appendChild(refresh);
    }

    const io = el('div', 'srcbar');
    const exp = el('button', null, '⤓ Export show');
    exp.title = 'Set and venue calibration in one file — the real backup';
    exp.addEventListener('click', () => { sl.exportFile(); this.app.toast('Show exported'); });
    const imp = el('button', null, '⤒ Import');
    const file = el('input');
    file.type = 'file';
    file.accept = 'application/json';
    file.hidden = true;
    imp.addEventListener('click', () => file.click());
    file.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        // A show file can carry a venue calibration. Importing one after you
        // have lined the surfaces up on the actual wall would silently undo
        // that, so it is always asked for rather than assumed.
        let withMapping = false;
        try {
          const peek = JSON.parse(await f.text());
          if (peek && peek.mapping) {
            withMapping = confirm(
              'This file also contains a projection calibration.\n\n'
              + 'OK — replace your current surface setup with it.\n'
              + 'Cancel — keep the surfaces you have and import only the songs.');
          }
        } catch (_) { /* let importFile report a malformed file */ }
        const n = await sl.importFile(f, { withMapping });
        this.app.toast(`Imported ${n} songs${withMapping ? ' + mapping' : ''}`);
        sl.go(0, 0);
        this.app.ui.afterStateChange();
      } catch (err) { this.app.toast(`Import failed: ${err.message}`); }
      e.target.value = '';
    });
    io.append(exp, imp, file);
    this.host.appendChild(io);

    // Footswitch: hands stay on the instrument, feet walk the set.
    const foot = el('div', 'srcbar');
    foot.appendChild(el('span', 'mini', 'Footswitch'));
    for (const [action, label] of [['prevCue', '◀ cue'], ['nextCue', 'cue ▶'], ['nextSong', 'song ⏭']]) {
      const b = el('button', 'ptoggle', label);
      const mapped = this.app.midi.mappedKeyForAction(action);
      b.classList.toggle('on', !!mapped);
      b.title = mapped ? `Mapped to ${mapped} — click to clear` : 'Click, then press the pedal';
      b.addEventListener('click', () => {
        if (mapped) { this.app.midi.unmapAction(action); this.app.toast('Footswitch cleared'); return; }
        if (!this.app.midi.enabled) { this.app.toast('Enable MIDI first (System tab)'); return; }
        this.app.midi.startLearnAction(action);
        this.app.toast(`Press the pedal to bind "${label}"`);
      });
      foot.appendChild(b);
    }
    this.host.appendChild(foot);

    const stats = sl.stats();
    const info = el('p', 'hint',
      `${stats.songs} songs · ${stats.cues} cues · `
      + `${stats.stale ? '~' : ''}${(stats.bytes / 1024).toFixed(0)} KB`
      + (sl.saveError ? ' — NOT saved to the browser, export it' : ''));
    if (sl.saveError) info.classList.add('warn');
    this.host.appendChild(info);

    if (!sl.songCount) {
      this.host.appendChild(el('p', 'hint',
        'No songs yet. "Generate show" builds thirty of them, five cues each, from '
        + 'the built-in feels — then rename and tweak whatever you want.'));
      return;
    }

    /* ---- songs ---- */
    const songSec = el('section', 'pgroup');
    const sh = el('header', 'pgroup-head');
    sh.appendChild(el('span', 'twisty', '▾'));
    sh.appendChild(el('h3', null, `Songs (${sl.songCount})`));
    sh.addEventListener('click', () => songSec.classList.toggle('collapsed'));
    songSec.appendChild(sh);
    const sbody = el('div', 'pgroup-body cuelist');
    songSec.appendChild(sbody);

    sl.songs.forEach((song, i) => {
      const row = el('div', 'cuerow');
      if (i === sl.songIndex) row.classList.add('sel');
      const num = el('span', 'cuenum', String(i + 1));
      const body = el('div', 'lbody');
      body.appendChild(el('span', 'lname', song.name));
      const feel = FEELS.find((f) => f.id === song.feel);
      body.appendChild(el('span', 'lmeta', `${song.cues.length} cues${feel ? ` · ${feel.name}` : ''}`));
      body.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const name = prompt('Song name', song.name);
        if (name) sl.renameSong(i, name);
      });
      const up = el('button', 'lbtn', '▲');
      up.addEventListener('click', (e) => { e.stopPropagation(); sl.moveSong(i, -1); });
      const down = el('button', 'lbtn', '▼');
      down.addEventListener('click', (e) => { e.stopPropagation(); sl.moveSong(i, 1); });
      const del = el('button', 'lbtn', '✕');
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${song.name}" and its ${song.cues.length} cues?`)) sl.removeSong(i);
      });
      row.append(num, body, up, down, del);
      row.addEventListener('click', () => { sl.selectSong(i); sl.go(i, 0); });
      sbody.appendChild(row);
    });
    this.host.appendChild(songSec);

    /* ---- cues of the selected song ---- */
    const song = sl.song;
    if (!song) return;
    const cueSec = el('section', 'pgroup');
    const ch = el('header', 'pgroup-head');
    ch.appendChild(el('span', 'twisty', '▾'));
    ch.appendChild(el('h3', null, `Cues · ${song.name}`));
    ch.addEventListener('click', (e) => {
      if (e.target.closest('.no-collapse')) return;
      cueSec.classList.toggle('collapsed');
    });
    cueSec.appendChild(ch);
    const cbody = el('div', 'pgroup-body cuelist');
    cueSec.appendChild(cbody);

    const cbar = el('div', 'srcbar');
    const addCue = el('button', null, '+ Cue from screen');
    addCue.addEventListener('click', () => {
      const n = song.cues.length;
      sl.addCueFromLive(DEFAULT_CUE_NAMES[n] || `Cue ${n + 1}`);
      this.app.toast('Cue added from what is on screen');
    });
    const update = el('button', 'primary', '⟳ Update cue');
    update.title = 'Overwrite the selected cue with what is on screen';
    update.addEventListener('click', () => {
      this.app.toast(sl.updateCue() ? `Updated "${sl.cue?.name}"` : 'No cue selected');
    });
    cbar.append(addCue, update);
    cbody.appendChild(cbar);

    const feelBar = el('div', 'srcbar');
    const feelSel = el('select', 'sel');
    for (const f of FEELS) {
      const o = el('option', null, f.name);
      o.value = f.id;
      o.title = f.hint;
      feelSel.appendChild(o);
    }
    feelSel.value = song.feel || FEELS[0].id;
    const rebuildBtn = el('button', null, '↻ Rebuild cues');
    rebuildBtn.title = 'Replace this song’s cues with a fresh set from that feel';
    rebuildBtn.addEventListener('click', () => {
      if (song.cues.length && !confirm(`Replace the ${song.cues.length} cues of "${song.name}"?`)) return;
      regenerateSong(this.app, sl.songs.indexOf(song), feelSel.value);
      sl.go(sl.songs.indexOf(song), 0);
      this.app.toast(`Rebuilt "${song.name}"`);
    });
    const tryBtn = el('button', null, '▶ Try');
    tryBtn.title = 'Load this feel on screen without touching the saved cues';
    tryBtn.addEventListener('click', () => {
      buildFeel(this.app, feelSel.value, song.variant || 0);
      this.app.ui.afterStateChange();
      this.app.toast(FEELS.find((f) => f.id === feelSel.value)?.hint || 'Feel loaded');
    });
    feelBar.append(feelSel, tryBtn, rebuildBtn);
    cbody.appendChild(feelBar);

    song.cues.forEach((cue, i) => {
      const row = el('div', 'cuerow');
      if (i === sl.cueIndex) row.classList.add('sel');
      const num = el('span', 'cuenum', String(i + 1));
      const body = el('div', 'lbody');
      body.appendChild(el('span', 'lname', cue.name));
      body.appendChild(el('span', 'lmeta', cue.morphBeats ? `glide ${cue.morphBeats} beats` : 'cut'));
      body.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const name = prompt('Cue name', cue.name);
        if (name) sl.renameCue(i, name);
      });
      const morph = el('input', 'num');
      morph.type = 'number';
      morph.min = 0; morph.max = 64; morph.step = 1;
      morph.value = String(cue.morphBeats);
      morph.title = 'Beats to glide over when this cue is recalled';
      morph.addEventListener('click', (e) => e.stopPropagation());
      morph.addEventListener('input', () => sl.setMorph(i, morph.value));
      const up = el('button', 'lbtn', '▲');
      up.addEventListener('click', (e) => { e.stopPropagation(); sl.moveCue(i, -1); });
      const down = el('button', 'lbtn', '▼');
      down.addEventListener('click', (e) => { e.stopPropagation(); sl.moveCue(i, 1); });
      const del = el('button', 'lbtn', '✕');
      del.addEventListener('click', (e) => { e.stopPropagation(); sl.removeCue(i); });
      row.append(num, body, morph, up, down, del);
      row.addEventListener('click', () => sl.go(sl.songIndex, i));
      cbody.appendChild(row);
    });
    this.host.appendChild(cueSec);
  }

  openGenerator() {
    const sl = this.setlist;
    const back = el('div', 'help');
    const card = el('div', 'help-card');
    card.appendChild(el('h2', null, 'Generate a show'));
    card.appendChild(el('p', 'hint',
      'One song title per line. Each song gets five cues — Intro, Verse, Chorus, '
      + 'Bridge, Outro — built from a feel, and the feels are dealt out so '
      + 'neighbouring songs do not look alike. Leave it empty for thirty numbered songs. '
      + 'Add "| feelId" after a title to pick its feel: '
      + FEELS.map((f) => f.id).join(', ') + '.'));
    const ta = el('textarea', 'gentext');
    ta.rows = 14;
    ta.placeholder = 'Wildwood Flower\nAngel from Montgomery\n…';
    ta.value = sl.songs.map((s) => s.name).join('\n');
    card.appendChild(ta);

    const row = el('div', 'srcbar');
    const go = el('button', 'big primary', 'Generate');
    go.addEventListener('click', () => {
      const names = ta.value.split('\n').map((n) => n.trim()).filter(Boolean);
      if (sl.songCount && !confirm(`Replace the current ${sl.songCount}-song show?`)) return;
      back.remove();
      this.app.toast('Building the show…');
      // Let the toast paint before a second of synchronous work.
      setTimeout(() => {
        const t0 = performance.now();
        const n = generateShow(this.app, names, { count: 30 });
        sl.go(0, 0);
        this.app.ui.afterStateChange();
        this.app.toast(`Built ${n} songs in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      }, 30);
    });
    const cancel = el('button', 'big', 'Cancel');
    cancel.addEventListener('click', () => back.remove());
    row.append(go, cancel);
    card.appendChild(row);
    back.appendChild(card);
    back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
    ta.focus();
  }
}
