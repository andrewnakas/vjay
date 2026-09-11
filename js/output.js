// Output: fullscreen, a pop-out window for a second display, and recording.
//
// The pop-out is fed by canvas.captureStream() rather than moving the canvas -
// a WebGL context does not survive being adopted into another document.

export class Output {
  /**
   * @param canvas the PROJECTOR canvas, not the on-screen preview. The two are
   *   separate frames so that isolating a plane to comp it - which changes the
   *   preview - can never change what the room is looking at.
   */
  constructor(canvas, audioEngine) {
    this.canvas = canvas;
    this.audio = audioEngine;
    this.popup = null;
    this.recorder = null;
    this.recordStream = null;
    this.chunks = [];
    this.recording = false;
    this.recordStart = 0;
    this.onChange = () => {};
    // The pop-out reaches back through `opener` for a fresh stream. It has to
    // be a property of the window rather than a closure, because after a reload
    // the closure's realm is gone but `opener` still resolves to this window.
    window.__vjayCaptureStream = () => this.canvas.captureStream(60);
  }

  isFullscreen() { return !!document.fullscreenElement; }

  /** Is the pop-out currently fullscreen? Same origin, so this is readable. */
  popupFullscreen() {
    try { return !!(this.popup && !this.popup.closed && this.popup.document.fullscreenElement); }
    catch (_) { return false; }
  }

  get popupOpen() { return !!(this.popup && !this.popup.closed); }

  async toggleFullscreen(el) {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await (el || this.canvas).requestFullscreen({ navigationUI: 'hide' });
    this.onChange();
  }

  /**
   * The projector, if there is one: the first screen that is not the primary.
   * Needs the window-management permission; without it we simply do not know
   * where the second display is and the window opens wherever Chrome likes.
   */
  async findProjectorScreen() {
    try {
      if (!window.getScreenDetails) return null;
      const details = await window.getScreenDetails();
      const other = details.screens.find((s) => !s.isPrimary);
      if (!other) return null;
      return {
        left: other.availLeft,
        top: other.availTop,
        width: other.availWidth,
        height: other.availHeight,
        // The full device size, not the work area: fullscreen covers the whole
        // panel, and the aspect has to be computed from that or the picture is
        // matched to a taskbar-sized rectangle and letterboxed once it expands.
        deviceWidth: other.width,
        deviceHeight: other.height,
        detail: other,
      };
    } catch (_) {
      return null;   // permission refused, or a single display
    }
  }

  /**
   * Must be called from a user gesture or the popup blocker eats it.
   * @param screen optional { left, top, width, height } to place it on
   */
  openOutputWindow({ screen = null } = {}) {
    if (this.popup && !this.popup.closed) { this.popup.focus(); return this.popup; }
    const feat = screen
      ? `popup=yes,left=${screen.left},top=${screen.top},width=${screen.width},height=${screen.height}`
      : 'width=1280,height=720';
    const w = window.open('', 'vjay-output', feat);
    if (!w) throw new Error('Pop-up blocked - allow pop-ups for this site.');
    w.document.title = 'VJay Output';
    w.document.body.style.cssText = 'margin:0;padding:0;background:#000;overflow:hidden;cursor:none';
    w.document.documentElement.style.cssText = 'margin:0;padding:0;background:#000;overflow:hidden';
    const video = w.document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = 'width:100vw;height:100vh;object-fit:contain;display:block;background:#000';
    video.srcObject = this.canvas.captureStream(60);
    w.document.body.appendChild(video);
    // Fullscreen has to be asked for from INSIDE this window. Chrome rejects a
    // cross-window request from the opener outright ("Permissions check
    // failed"), so the pop-out arms its own: any click or key press here goes
    // fullscreen, and a prompt says so until it happens.
    const hint = w.document.createElement('div');
    hint.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;'
      + 'justify-content:center;background:rgba(0,0,0,0.5);cursor:pointer;z-index:9';
    const fsBtn = w.document.createElement('button');
    fsBtn.textContent = '⛶  Fullscreen';
    fsBtn.style.cssText = 'font:600 22px system-ui,sans-serif;color:#07080c;'
      + 'background:#7ef0c0;border:0;border-radius:10px;padding:18px 34px;cursor:pointer;'
      + 'box-shadow:0 6px 28px rgba(0,0,0,0.6)';
    hint.appendChild(fsBtn);
    w.document.body.appendChild(hint);

    // A small always-available control once the prompt is gone, so fullscreen
    // can be re-entered after Esc without hunting for a gesture.
    const corner = w.document.createElement('button');
    corner.textContent = '⛶';
    corner.title = 'Fullscreen';
    corner.style.cssText = 'position:fixed;right:10px;top:10px;z-index:10;'
      + 'font:600 16px system-ui,sans-serif;color:#e6eaf3;background:rgba(20,26,38,0.85);'
      + 'border:1px solid rgba(126,240,192,0.5);border-radius:8px;padding:7px 11px;cursor:pointer';
    w.document.body.appendChild(corner);

    const goFull = async () => {
      try {
        if (w.document.fullscreenElement) return;
        await w.document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      } catch (_) { /* the window manager may refuse; the hint stays up */ }
    };
    fsBtn.addEventListener('click', (e) => { e.stopPropagation(); goFull(); });
    corner.addEventListener('click', (e) => {
      e.stopPropagation();
      if (w.document.fullscreenElement) w.document.exitFullscreen();
      else goFull();
    });
    w.document.addEventListener('click', goFull);
    w.document.addEventListener('keydown', goFull);
    w.document.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (w.document.fullscreenElement) w.document.exitFullscreen();
      else goFull();
    });
    w.document.addEventListener('fullscreenchange', () => {
      const full = !!w.document.fullscreenElement;
      hint.style.display = full ? 'none' : 'flex';
      // The corner control stays reachable but gets out of the way on the wall.
      corner.style.opacity = full ? '0' : '1';
      corner.style.pointerEvents = full ? 'none' : 'auto';
      w.document.body.style.cursor = full ? 'none' : 'pointer';
    });
    // Reveal the corner control on a mouse move, so it can be clicked to leave
    // fullscreen without guessing that Esc works.
    w.document.addEventListener('mousemove', () => {
      if (!w.document.fullscreenElement) return;
      corner.style.opacity = '1';
      corner.style.pointerEvents = 'auto';
      clearTimeout(w.__vjayHideBtn);
      w.__vjayHideBtn = w.setTimeout(() => {
        corner.style.opacity = '0';
        corner.style.pointerEvents = 'none';
      }, 2000);
    });

    // A captureStream dies with the canvas that produced it, so reloading the
    // main page used to leave the projector frozen on its last frame until the
    // window was closed and reopened by hand - not something to be doing in
    // front of a room. This watchdog lives in the pop-out's own realm so it
    // survives that reload, and pulls a fresh stream as soon as one exists.
    const watchdog = w.document.createElement('script');
    watchdog.textContent = `
      (function () {
        var v = document.querySelector('video');
        if (!v) return;
        function live() {
          var s = v.srcObject;
          var t = s && s.getVideoTracks && s.getVideoTracks()[0];
          return !!t && t.readyState === 'live';
        }
        function pull() {
          try {
            if (window.opener && window.opener.__vjayCaptureStream) {
              v.srcObject = window.opener.__vjayCaptureStream();
              v.play().catch(function () {});
            }
          } catch (e) { /* opener still loading */ }
        }
        setInterval(function () { if (!live()) pull(); }, 500);
      })();
    `;
    w.document.body.appendChild(watchdog);
    video.play().catch(() => {});
    // Placing and sizing has to happen after open on some window managers.
    if (screen) {
      try {
        w.moveTo(screen.left, screen.top);
        w.resizeTo(screen.width, screen.height);
      } catch (_) { /* the WM may refuse; the user can drag it */ }
    }
    this.popup = w;
    w.addEventListener('beforeunload', () => { this.popup = null; this.onChange(); });
    this.onChange();
    return w;
  }

  closeOutputWindow() {
    if (this.popup && !this.popup.closed) this.popup.close();
    this.popup = null;
    this.onChange();
  }

  _pickMimeType() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  startRecording({ fps = 60, bitrate = 12_000_000 } = {}) {
    if (this.recording) return;
    const stream = this.canvas.captureStream(fps);
    this.recordStream = stream;
    // Mix in whatever the analyser is listening to, when it is a real stream.
    const audioTrack = this.audio?.stream?.getAudioTracks?.()[0];
    if (audioTrack) stream.addTrack(audioTrack);
    const mimeType = this._pickMimeType();
    this.chunks = [];
    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: bitrate } : undefined);
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.recorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: mimeType || 'video/webm' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `vjay-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      this.chunks = [];
      this.recording = false;
      // Stop the capture sink. Without this every REC cycle leaves another live
      // reader attached to the canvas for the rest of the session, each one
      // copying it on every draw - so recording twice made everything slower
      // than recording once, permanently.
      this._releaseRecordStream();
      this.onChange();
    };
    this.recorder.start(1000);
    this.recording = true;
    this.recordStart = performance.now();
    this.onChange();
  }

  /** Drop the recorder's own capture sink; the audio track belongs to the engine. */
  _releaseRecordStream() {
    const stream = this.recordStream;
    this.recordStream = null;
    if (!stream) return;
    for (const t of stream.getVideoTracks()) t.stop();
    for (const t of stream.getAudioTracks()) stream.removeTrack(t);
  }

  stopRecording() {
    if (!this.recording || !this.recorder) return;
    this.recorder.stop();
  }

  toggleRecording() { this.recording ? this.stopRecording() : this.startRecording(); }

  /**
   * Put the output on the projector, fullscreen, matching its shape.
   *
   * Must be called from a user gesture: both the pop-up and the fullscreen
   * request depend on it.
   */
  async sendToProjector({ setAspect = null } = {}) {
    const screen = await this.findProjectorScreen();
    const w = this.openOutputWindow({ screen });
    if (!w) return { ok: false, message: 'Pop-up blocked — allow pop-ups for this site' };
    if (!screen) {
      return {
        ok: true,
        onProjector: false,
        message: 'Output opened — drag it to the projector and double-click it for fullscreen',
      };
    }

    // Match the render to the panel, so `object-fit: contain` has nothing to
    // letterbox. A 16:10 projector fed a 16:9 frame gets black bars whatever
    // the window does.
    const aspect = screen.deviceWidth / Math.max(screen.deviceHeight, 1);
    if (setAspect) setAspect(aspect);

    // Cover the whole panel, not the work area, so going fullscreen is not a
    // jump in size - and re-place it every time, since the window may be an
    // existing one that was left somewhere else.
    try {
      w.moveTo(screen.left, screen.top);
      w.resizeTo(screen.deviceWidth, screen.deviceHeight);
    } catch (_) { /* the WM may refuse; it can be dragged */ }
    try { w.focus(); } catch (_) {}

    return {
      ok: true, onProjector: true, aspect,
      width: screen.deviceWidth, height: screen.deviceHeight,
      message: `Output on the projector (${screen.deviceWidth}×${screen.deviceHeight}, `
        + `${aspect.toFixed(2)}:1) — click that window once for fullscreen`,
    };
  }

  recordSeconds() { return this.recording ? (performance.now() - this.recordStart) / 1000 : 0; }
}
