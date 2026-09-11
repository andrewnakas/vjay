// Audio input: mic / line-in, system audio (PulseAudio monitor device or tab
// audio via getDisplayMedia), a dropped audio file, or a synthetic test loop.
// All four end up as a MediaStreamAudioSourceNode feeding one analyser.

export const FFT_SIZE = 2048;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.inputGain = null;
    this.monitorGain = null;
    this.node = null;          // whatever is currently connected
    this.stream = null;        // for MediaRecorder to grab an audio track
    this.freq = null;          // Float32Array of dB values
    this.time = null;          // Float32Array waveform
    this.sourceLabel = 'none';
    this.kind = 'none';        // mic | display | file | test | none
    this._fileEl = null;
    this._testNodes = [];
    this.onStateChange = () => {};
  }

  ensureContext() {
    if (this.ctx) return this.ctx;
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.inputGain = ctx.createGain();
    this.inputGain.gain.value = 1;

    // Smoothing is 0 on purpose: onset detection needs the raw frame-to-frame
    // spectral change. All smoothing happens downstream in features.js.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0;
    this.analyser.minDecibels = -100;
    this.analyser.maxDecibels = -10;

    // Monitoring is off by default - a mic routed to speakers is a feedback loop.
    this.monitorGain = ctx.createGain();
    this.monitorGain.gain.value = 0;

    this.inputGain.connect(this.analyser);
    this.inputGain.connect(this.monitorGain);
    this.monitorGain.connect(ctx.destination);

    this.freq = new Float32Array(this.analyser.frequencyBinCount);
    this.time = new Float32Array(this.analyser.fftSize);
    return ctx;
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }
  get binCount() { return this.analyser ? this.analyser.frequencyBinCount : FFT_SIZE / 2; }
  get binHz() { return this.sampleRate / FFT_SIZE; }

  async resume() {
    this.ensureContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  setInputGain(v) { if (this.inputGain) this.inputGain.gain.value = v; }
  setMonitor(v) { if (this.monitorGain) this.monitorGain.gain.value = v; }

  /** Device labels only populate after permission has been granted once. */
  async listInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label || `Input ${d.deviceId.slice(0, 6)}`,
        // On Linux, PulseAudio/PipeWire exposes loopback as "Monitor of ...".
        isMonitor: /monitor|loopback|stereo mix|what u hear/i.test(d.label),
      }));
  }

  _disconnect() {
    if (this.node) { try { this.node.disconnect(); } catch (_) {} this.node = null; }
    for (const n of this._testNodes) { try { n.stop?.(); n.disconnect?.(); } catch (_) {} }
    this._testNodes = [];
    if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); this.stream = null; }
    if (this._fileEl) { this._fileEl.pause(); this._fileEl = null; }
  }

  _attachStream(stream, label, kind) {
    this._disconnect();
    this.stream = stream;
    this.node = this.ctx.createMediaStreamSource(stream);
    this.node.connect(this.inputGain);
    this.sourceLabel = label;
    this.kind = kind;
    this.onStateChange(this);
  }

  /** Mic, line-in, or a PulseAudio monitor device - all the same API. */
  /** Set alongside `kind`, so a session can reopen the same input. */
  async useInputDevice(deviceId) {
    this.deviceId = deviceId || null;
    await this.resume();
    const constraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        // Every one of these mangles music. Off, always.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
      video: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const label = stream.getAudioTracks()[0]?.label || 'Audio input';
    this._attachStream(stream, label, 'mic');
    return label;
  }

  /** System / tab audio. Chrome only offers audio for tab and whole-screen shares. */
  async useDisplayAudio() {
    await this.resume();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (stream.getAudioTracks().length === 0) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error('No audio track - re-share and tick "Share tab audio" / "Share system audio".');
    }
    // We only wanted the audio; drop the video track to save encoding work.
    for (const t of stream.getVideoTracks()) { t.stop(); stream.removeTrack(t); }
    this._attachStream(stream, 'System audio', 'display');
    return 'System audio';
  }

  /** Play a dropped audio file through the analyser (and to the speakers). */
  async useFile(file) {
    await this.resume();
    this._disconnect();
    const el = new Audio();
    el.src = URL.createObjectURL(file);
    el.loop = true;
    el.crossOrigin = 'anonymous';
    this._fileEl = el;
    this.node = this.ctx.createMediaElementSource(el);
    this.node.connect(this.inputGain);
    this.setMonitor(1); // a file you loaded, you want to hear
    await el.play();
    this.sourceLabel = file.name;
    this.kind = 'file';
    this.onStateChange(this);
    return file.name;
  }

  async useTestSignal(bpm = 124) {
    await this.resume();
    this._disconnect();
    const ctx = this.ctx;
    const buf = buildTestLoop(ctx, bpm);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.inputGain);
    src.start();
    this._testNodes.push(src);
    this.sourceLabel = `Test signal ${bpm} BPM`;
    this.kind = 'test';
    this.onStateChange(this);
    return this.sourceLabel;
  }

  stop() {
    this._disconnect();
    this.sourceLabel = 'none';
    this.kind = 'none';
    this.onStateChange(this);
  }

  /** Pull one frame of spectrum + waveform. Returns false when there is no input. */
  poll() {
    if (!this.analyser) return false;
    this.analyser.getFloatFrequencyData(this.freq);
    this.analyser.getFloatTimeDomainData(this.time);
    return this.kind !== 'none';
  }
}

/**
 * Synthetic loop: kick on every beat, snare on 2 & 4, 16th hats, and a moving
 * bass note. Ground truth for verifying the whole analysis chain without a mic.
 * Shared by the ?test=1 signal and the offline self-test.
 */
export function buildTestLoop(ctx, bpm = 124) {
  const sr = ctx.sampleRate;
  const beat = 60 / bpm;
  const bars = 2;
  const dur = beat * 4 * bars;
  const buf = ctx.createBuffer(1, Math.ceil(dur * sr), sr);
  const d = buf.getChannelData(0);
  const addKick = (t0) => {
    const len = Math.floor(0.35 * sr);
    const i0 = Math.floor(t0 * sr);
    let ph = 0;
    for (let i = 0; i < len && i0 + i < d.length; i++) {
      const x = i / len;
      const f = 120 * Math.exp(-x * 6) + 42;
      ph += (2 * Math.PI * f) / sr;
      d[i0 + i] += Math.sin(ph) * Math.exp(-x * 5) * 0.9;
    }
  };
  const addSnare = (t0) => {
    const len = Math.floor(0.18 * sr);
    const i0 = Math.floor(t0 * sr);
    let lp = 0;
    for (let i = 0; i < len && i0 + i < d.length; i++) {
      const x = i / len;
      const n = Math.random() * 2 - 1;
      lp += (n - lp) * 0.5; // band-ish noise
      d[i0 + i] += (n - lp * 0.6) * Math.exp(-x * 12) * 0.45;
    }
  };
  const addHat = (t0, amp) => {
    const len = Math.floor(0.05 * sr);
    const i0 = Math.floor(t0 * sr);
    let prev = 0;
    for (let i = 0; i < len && i0 + i < d.length; i++) {
      const x = i / len;
      const n = Math.random() * 2 - 1;
      const hp = n - prev; // crude high-pass
      prev = n;
      d[i0 + i] += hp * Math.exp(-x * 25) * amp;
    }
  };
  const addBass = (t0, len, f) => {
    const i0 = Math.floor(t0 * sr);
    const n = Math.floor(len * sr);
    for (let i = 0; i < n && i0 + i < d.length; i++) {
      const x = i / n;
      const env = Math.min(1, x * 20) * Math.exp(-x * 2.2);
      d[i0 + i] += Math.sin((2 * Math.PI * f * i) / sr) * env * 0.35;
    }
  };
  const notes = [55, 55, 73.42, 65.41, 55, 55, 82.41, 65.41];
  for (let b = 0; b < 4 * bars; b++) {
    const t = b * beat;
    addKick(t);
    if (b % 4 === 1 || b % 4 === 3) addSnare(t);
    for (let s = 0; s < 4; s++) addHat(t + (s * beat) / 4, s % 2 ? 0.10 : 0.20);
    addBass(t + beat * 0.5, beat * 0.45, notes[b % notes.length]);
  }
  for (let i = 0; i < d.length; i++) d[i] = Math.tanh(d[i] * 1.2) * 0.85;
  return buf;
}
