// Hotkeys. Designed for one hand on the keyboard and one on a controller.

import { params } from './params.js';
import { EFFECTS } from './shaders/effects.js';

const FX_KEYS = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'];

export const SHORTCUTS = [
  ['→ / ←', 'Next / previous cue — the two keys you can find in the dark'],
  ['Ctrl+→ / ←', 'Next / previous song'],
  ['PageDown / .', 'Next cue (footswitch, presenter remote)'],
  ['PageUp / ,', 'Previous cue'],
  ['Ctrl+PageDown / Up', 'Next / previous song'],
  ['Ctrl+U', 'Overwrite the current cue with what is on screen'],
  ['S', 'Preview the next plane on its own (comp it); cycles back to Output'],
  ['Shift+P', 'Drop every pinned feed — the way out if a plane is stuck on one'],
  ['Shift+S', 'Back to the full mapped output'],
  ['Corners', 'Draggable whenever the Setup tab is open — no key to press first. A locked plane never moves'],
  ['M', 'Move planes: drag a whole quad by its middle, plus Alt+arrows'],
  ['D', 'Picture: drag what is INSIDE a plane. Alt+wheel zooms, Alt+Shift turns, double-click resets'],
  ['− / =', 'Zoom the preview out / in (0 resets) — see corners past the projector edge'],
  ['G', 'Alignment: off → grid → white panels (the selected corner pulses)'],
  ['K', 'Camera view behind the planes (corner edit)'],
  ['Shift+M', 'Bypass mapping — plain full frame (panic)'],
  ['In corner edit', 'Tab next plane · 1–4 pick a corner · arrows nudge · Alt+arrows move'],
  ['In Picture', 'Tab next plane · arrows nudge the picture · Shift+arrows by ten'],
  ['1 – 8', 'Select layer (1 = bottom of the stack)'],
  ['A / B / N', 'Assign the selected layer to crossfader side A / B / neither'],
  ['Alt + ← / →', 'Nudge the crossfader'],
  ['Shift + arrows', 'Nudge the selected layer'],
  ['[ / ]', 'Move the selected layer down / up the stack'],
  ['Delete', 'Delete the selected layer'],
  ['E', 'Toggle the on-preview edit handles'],
  ['Alt + wheel', 'Scale the layer under the pointer (Alt+Shift rotates). A bare wheel does nothing.'],
  ['Space', 'Tap tempo'],
  ['Enter', 'Reset the downbeat'],
  ['Q…P', 'Toggle the first ten effects'],
  ['Shift+1 – 8', 'Recall preset slot'],
  ['Ctrl+1 – 8', 'Store preset slot'],
  ['C', 'Cycle palette'],
  ['V', 'Cycle blend mode'],
  ['F', 'Fullscreen'],
  ['O', 'Send the output to the projector'],
  ['R', 'Toggle recording'],
  ['X', 'Clear feedback buffer'],
  ['`', 'Blackout (hold)'],
  ['H', 'Show / hide the UI'],
  ['Esc', 'Panic: all effects off'],
];

export function installKeyboard(app) {
  const onDown = (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
    const k = e.key;
    const lower = typeof k === 'string' ? k.toLowerCase() : '';

    // Setlist transport comes first: it has to work whatever else is going on.
    if (k === 'PageDown' || (k === '.' && !e.ctrlKey && !e.metaKey)) {
      if (e.ctrlKey || e.metaKey) app.setlist.nextSong(); else app.setlist.next();
      e.preventDefault();
      return;
    }
    if (k === 'PageUp' || (k === ',' && !e.ctrlKey && !e.metaKey)) {
      if (e.ctrlKey || e.metaKey) app.setlist.prevSong(); else app.setlist.prev();
      e.preventDefault();
      return;
    }
    if (lower === 'u' && (e.ctrlKey || e.metaKey)) {
      app.toast(app.setlist.updateCue() ? `Updated "${app.setlist.cue?.name}"` : 'No cue to update');
      e.preventDefault();
      return;
    }

    // Mapping. Bypass is a panic key and must never be shadowed.
    if (lower === 'm' && !e.ctrlKey && !e.metaKey) {
      if (e.shiftKey) {
        const next = params.get('map.bypass') > 0.5 ? 0 : 1;
        params.setBase('map.bypass', next);
        app.toast(next ? 'Mapping BYPASSED — plain full frame' : 'Mapping on');
      } else {
        app.ui.mapUI.toggleEdit();
      }
      e.preventDefault();
      return;
    }
    // Pins override the setlist until they are taken off, so there is a single
    // key that takes all of them off.
    if (lower === 'p' && e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const n = app.clearPins();
      app.toast(n ? `Dropped ${n} pin${n === 1 ? '' : 's'}` : 'No pins to drop');
      e.preventDefault();
      return;
    }
    // Which frame the PREVIEW shows. Never touches the projector.
    if (lower === 's' && !e.ctrlKey && !e.metaKey) {
      if (e.shiftKey) app.ui.viewUI.select(-1);
      else app.ui.viewUI.cycle(1);
      e.preventDefault();
      return;
    }
    // Preview zoom. Output-view only; the projector is never affected.
    if ((k === '-' || k === '_' || k === '=' || k === '+') && !e.ctrlKey && !e.metaKey) {
      const z = app.previewView.zoom;
      app.setPreviewZoom(k === '-' || k === '_' ? z / 1.25 : z * 1.25);
      app.ui.mapUI.rebuild();
      app.toast(`Preview ${(app.previewView.zoom * 100).toFixed(0)}%`);
      e.preventDefault();
      return;
    }
    if (lower === 'd' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      app.ui.mapUI.togglePicture();
      e.preventDefault();
      return;
    }
    if (lower === 'k' && !e.ctrlKey && !e.metaKey) {
      app.mapEditor.showCamera = !app.mapEditor.showCamera;
      if (app.mapEditor.showCamera) app.ui.mapUI.toggleEdit(true);
      app.ui.mapUI.rebuild();
      app.toast(`Camera view ${app.mapEditor.showCamera ? 'on' : 'off'}`);
      e.preventDefault();
      return;
    }
    if (lower === 'g' && !e.ctrlKey && !e.metaKey) {
      // Off -> grid -> flat white -> off. White is the one you align against a
      // real picture frame; the grid is for seeing keystone and stretch.
      const next = (app.mapping.testMode + 1) % 3;
      params.setBase('map.test', next);
      app.toast(['Alignment off', 'Grid — shows keystone and stretch',
        'White panels — line these up with the real frames'][next]);
      e.preventDefault();
      return;
    }
    // While either mapping tool is live, arrows and 1-4 belong to the map editor.
    if (app.mapEditor?.live && app.mapEditor.handleKey(e)) {
      e.preventDefault();
      return;
    }

    // Digits: preset store/recall with modifiers, generator load without.
    if (/^[0-9]$/.test(k) || (e.shiftKey && /^[!@#$%^&*()]$/.test(k))) {
      const digitMap = { '!': 1, '@': 2, '#': 3, $: 4, '%': 5, '^': 6, '&': 7, '*': 8, '(': 9, ')': 0 };
      const digit = /^[0-9]$/.test(k) ? Number(k) : digitMap[k];
      if (e.ctrlKey || e.metaKey) {
        if (digit >= 1 && digit <= 8) { app.presets.store(digit - 1); app.toast(`Stored preset ${digit}`); }
      } else if (e.shiftKey) {
        if (digit >= 1 && digit <= 8) {
          const ok = app.presets.recall(digit - 1, app.morphBeats);
          app.toast(ok ? `Recalled preset ${digit}` : `Preset ${digit} is empty`);
        }
      } else {
        const layer = app.layers.layers[digit - 1];
        if (layer) {
          app.layers.select(layer.id);
          app.toast(`Layer ${digit}: ${layer.name}`);
        }
      }
      e.preventDefault();
      return;
    }

    if (FX_KEYS.includes(lower) && !e.ctrlKey && !e.metaKey) {
      const def = EFFECTS[FX_KEYS.indexOf(lower)];
      if (def) {
        const path = `fx.${def.id}.enabled`;
        const next = params.get(path) > 0.5 ? 0 : 1;
        params.setBase(path, next);
        app.toast(`${def.name} ${next ? 'on' : 'off'}`);
        e.preventDefault();
      }
      return;
    }

    const sel = app.layers.selected;
    const nudge = (dx, dy) => {
      if (!sel) return false;
      params.setBase(`${sel.ns}.x`, params.getBase(`${sel.ns}.x`) + dx);
      params.setBase(`${sel.ns}.y`, params.getBase(`${sel.ns}.y`) + dy);
      return true;
    };

    switch (lower) {
      case 'a':
      case 'b':
      case 'n':
        if (sel) {
          const side = lower === 'a' ? 1 : lower === 'b' ? 2 : 0;
          params.setBase(`${sel.ns}.xfade`, side);
          app.toast(`${sel.name} → crossfader ${side === 0 ? 'ignore' : side === 1 ? 'A' : 'B'}`);
        }
        e.preventDefault();
        break;
      case 'e':
        app.setEditHandles(!app.editor.enabled);
        app.toast(`Edit handles ${app.editor.enabled ? 'on' : 'off'}`);
        break;
      case '[': if (sel) app.layers.move(sel.id, -1); break;
      case ']': if (sel) app.layers.move(sel.id, 1); break;
      case 'delete':
      case 'backspace':
        if (sel) { app.renderer.disposeAux(sel.id); app.layers.remove(sel.id); app.toast('Layer deleted'); }
        e.preventDefault();
        break;
      case ' ': app.tapTempo(); e.preventDefault(); break;
      case 'enter': app.tempo.resetDownbeat(); app.toast('Downbeat reset'); e.preventDefault(); break;
      // Left and right walk the set. They are the two keys you can find without
      // looking, which is the whole requirement for something you press between
      // songs in the dark. PageUp/PageDown still do the same thing for a
      // footswitch or a presenter remote.
      //
      // Corner editing takes the arrows before this - it returns early above -
      // so aligning a plane still nudges rather than jumping the show.
      case 'arrowleft':
        if (e.shiftKey) nudge(-0.02, 0);
        else if (e.altKey) params.setBase('mix.fade', params.getBase('mix.fade') - 0.05);
        else if (e.ctrlKey || e.metaKey) app.setlist.prevSong();
        else app.setlist.prev();
        e.preventDefault(); break;
      case 'arrowright':
        if (e.shiftKey) nudge(0.02, 0);
        else if (e.altKey) params.setBase('mix.fade', params.getBase('mix.fade') + 0.05);
        else if (e.ctrlKey || e.metaKey) app.setlist.nextSong();
        else app.setlist.next();
        e.preventDefault(); break;
      case 'arrowup': if (nudge(0, 0.02)) e.preventDefault(); break;
      case 'arrowdown': if (nudge(0, -0.02)) e.preventDefault(); break;
      case 'c': {
        const def = params.def('master.palette');
        params.setBase('master.palette', (params.get('master.palette') + 1) % (def.max + 1));
        app.toast(`Palette: ${def.options[params.get('master.palette')]}`);
        break;
      }
      case 'v': {
        if (!sel) break;
        const def = params.def(`${sel.ns}.blend`);
        const next = (params.get(`${sel.ns}.blend`) + 1) % (def.max + 1);
        params.setBase(`${sel.ns}.blend`, next);
        app.toast(`${sel.name} blend: ${def.options[next]}`);
        break;
      }
      case 'f': app.output.toggleFullscreen(app.canvas).catch(() => {}); break;
      case 'o':
        app.output.sendToProjector({
          setAspect: (a) => { if (Math.abs(a - app.outputAspect) > 0.001) app.setOutputAspect(a); },
        }).then((r) => {
          if (r.width && r.height) app.setOutputSize({ w: r.width, h: r.height });
          app.ui.mapUI.rebuild();
          app.toast(r.message);
        }).catch((err) => app.toast(err.message));
        break;
      case 'r': app.output.toggleRecording(); app.toast(app.output.recording ? 'Recording…' : 'Saving recording'); break;
      case 'x': app.renderer.clearFeedback(); app.toast('Feedback cleared'); break;
      case 'h': app.toggleUI(); break;
      case '`': params.setBase('master.blackout', 1); e.preventDefault(); break;
      case 'escape':
        for (const def of EFFECTS) params.setBase(`fx.${def.id}.enabled`, 0);
        app.toast('Panic: all FX off');
        break;
      default: break;
    }
  };

  const onUp = (e) => {
    if (e.key === '`') params.setBase('master.blackout', 0);
  };

  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);
  return () => {
    window.removeEventListener('keydown', onDown);
    window.removeEventListener('keyup', onUp);
  };
}
