// Turns one analyser frame into the normalized feature bus that drives everything.
//
// The important trick here is adaptive normalization: each signal tracks its own
// rolling min/max over a few seconds, so a quiet passage still moves the visuals
// and a loud drop does not peg every parameter at 1.0.

import { SPECTRUM_BINS, WAVE_SAMPLES } from '../shaders/common.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Rolling min/max normalizer. */
class Adaptive {
  constructor({ decay = 0.35, floor = 0.05 } = {}) {
    this.max = 0.001;
    this.min = 1;
    this.decay = decay; // per second, how fast max falls / min rises toward the signal
    this.floor = floor; // minimum range, stops silence from amplifying noise
  }
  process(v, dt) {
    const k = Math.min(1, this.decay * dt);
    if (v > this.max) this.max = v; else this.max += (v - this.max) * k;
    if (v < this.min) this.min = v; else this.min += (v - this.min) * k;
    const range = Math.max(this.max - this.min, this.floor);
    return clamp01((v - this.min) / range);
  }
}

/** Attack/release envelope follower, time constants in seconds. */
class Env {
  constructor(attack = 0.005, release = 0.15) {
    this.attack = attack;
    this.release = release;
    this.v = 0;
  }
  process(x, dt) {
    const tau = x > this.v ? this.attack : this.release;
    this.v += (x - this.v) * (1 - Math.exp(-dt / Math.max(tau, 1e-4)));
    return this.v;
  }
}

/**
 * Onset detector for one band. Fires when the band's positive flux exceeds a
 * local median threshold - median rather than mean so a single loud hit does
 * not raise the bar for the next one.
 *
 * These are band-transient detectors, not instrument classifiers. `kick`,
 * `snare` and `hat` name the thing each one usually tracks, but on dense
 * material the mid detector will also catch a kick's click and the low one will
 * catch a bassline. That is fine for driving visuals and is worth knowing
 * before you patch one to something that must only move on the actual snare.
 */
class Transient {
  constructor({ historyLen = 43, mult = 1.6, bias = 0.1, minGap = 0.09, decay = 0.12 } = {}) {
    this.hist = new Float32Array(historyLen);
    this.idx = 0;
    this.mult = mult;
    this.bias = bias;
    this.minGap = minGap;
    this.decay = decay;
    this.value = 0;
    this.sinceLast = 10;
    this.fired = false;
    this.armed = true;
    this._sorted = new Float32Array(historyLen);
  }
  process(flux, dt, veto = false) {
    this.sinceLast += dt;
    this._sorted.set(this.hist);
    this._sorted.sort();
    const median = this._sorted[this._sorted.length >> 1];
    const threshold = median * this.mult + this.bias;
    this.fired = false;
    // Re-arm only once the flux has fallen well back below threshold. A kick's
    // pitch sweep crosses the threshold twice on a single hit; without this it
    // reports double the real tempo.
    if (!this.armed && flux < threshold * 0.6) this.armed = true;
    if (this.armed && !veto && flux > threshold && this.sinceLast > this.minGap) {
      this.fired = true;
      this.armed = false;
      this.sinceLast = 0;
      this.value = 1;
    } else {
      this.value = Math.max(0, this.value - dt / this.decay);
    }
    this.hist[this.idx] = flux;
    this.idx = (this.idx + 1) % this.hist.length;
    return this.value;
  }
}

const BAND_DEFS = [
  { key: 'bass', lo: 20, hi: 90 },
  { key: 'lowMid', lo: 90, hi: 260 },
  { key: 'mid', lo: 260, hi: 1200 },
  { key: 'high', lo: 1200, hi: 5000 },
  { key: 'air', lo: 5000, hi: 16000 },
];

export class FeatureExtractor {
  constructor(engine) {
    this.engine = engine;
    this.binCount = engine.binCount;
    this.mag = new Float32Array(this.binCount);
    this.prevMag = new Float32Array(this.binCount);
    this.spectrum = new Float32Array(SPECTRUM_BINS);   // normalized, for shaders
    this.specRaw = new Float32Array(SPECTRUM_BINS);    // smoothed raw magnitudes
    this.specPeak = 1e-6;                              // decaying peak hold
    this.waveform = new Float32Array(WAVE_SAMPLES);

    this.bandRanges = null;
    this.logBins = null;

    this.bandNorm = {};
    this.bandEnv = {};
    this.bandPrev = {};
    this.bandMean = {};
    for (const b of BAND_DEFS) {
      this.bandNorm[b.key] = new Adaptive({ decay: 0.3 });
      this.bandEnv[b.key] = new Env(0.008, 0.14);
      this.bandPrev[b.key] = 0;
      this.bandMean[b.key] = 1e-6;
    }

    this.levelNorm = new Adaptive({ decay: 0.25, floor: 0.02 });
    this.fluxNorm = new Adaptive({ decay: 0.6, floor: 0.02 });
    this.levelEnv = new Env(0.01, 0.2);
    this.centroidSmooth = new Env(0.08, 0.25);

    // Vocal-band presence. Deliberately NOT called speech detection: it does
    // not identify a speaker or separate a voice from a mix. It measures three
    // things a voice usually has together - energy in the formant range, a
    // harmonic rather than noisy spectrum there, and a syllable-rate wobble -
    // and reports how strongly they coincide. A sung note, a spoken word and a
    // solo horn all move it. That is honest and useful for driving visuals; a
    // threshold on it is not a vocal detector.
    this.voiceNorm = new Adaptive({ decay: 0.25, floor: 0.03 });
    this.voiceEnv = new Env(0.04, 0.3);
    this.voiceHist = new Float32Array(24);
    this.voiceIdx = 0;

    this.kickDet = new Transient({ mult: 1.8, bias: 0.18, minGap: 0.12, decay: 0.13 });
    this.snareDet = new Transient({ mult: 2.1, bias: 0.20, minGap: 0.16, decay: 0.10 });
    this.hatDet = new Transient({ mult: 1.9, bias: 0.10, minGap: 0.05, decay: 0.06 });

    // The public feature bus. Reused every frame - never reallocated.
    this.out = {
      bass: 0, lowMid: 0, mid: 0, high: 0, air: 0,
      level: 0, flux: 0, centroid: 0,
      kick: 0, snare: 0, hat: 0,
      voice: 0,
      kickHit: false, snareHit: false, hatHit: false,
      onset: 0,
      bpm: 0, beatPhase: 0, barPhase: 0, phrasePhase: 0, beatPulse: 0,
      beatHit: false, barHit: false, phraseHit: false, confidence: 0,
      spectrum: this.spectrum,
      waveform: this.waveform,
      silent: true,
    };
    this._buildBins();
  }

  _buildBins() {
    const binHz = this.engine.binHz;
    this.bandRanges = BAND_DEFS.map((b) => ({
      key: b.key,
      i0: Math.max(1, Math.floor(b.lo / binHz)),
      i1: Math.min(this.binCount - 1, Math.ceil(b.hi / binHz)),
    }));
    // The vocal formant range. Wide on purpose - a bass voice and a soprano do
    // not share a fundamental, but they share this band.
    this.vocalRange = {
      i0: Math.max(1, Math.floor(180 / binHz)),
      i1: Math.min(this.binCount - 1, Math.ceil(3500 / binHz)),
    };

    // Log-spaced bins for the shader spectrum uniform: 30 Hz .. 16 kHz.
    const lo = 30, hi = 16000;
    this.logBins = new Array(SPECTRUM_BINS);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const f0 = lo * Math.pow(hi / lo, i / SPECTRUM_BINS);
      const f1 = lo * Math.pow(hi / lo, (i + 1) / SPECTRUM_BINS);
      const i0 = Math.max(1, Math.floor(f0 / binHz));
      const i1 = Math.max(i0 + 1, Math.min(this.binCount - 1, Math.ceil(f1 / binHz)));
      this.logBins[i] = [i0, i1];
    }
  }

  update(dt) {
    const eng = this.engine;
    const active = eng.poll();
    const out = this.out;
    out.silent = !active;
    if (!active) {
      // Decay everything toward rest rather than snapping - avoids a visual jolt
      // when the input is switched.
      const k = Math.min(1, dt * 3);
      for (const key of ['bass', 'lowMid', 'mid', 'high', 'air', 'level', 'flux', 'kick', 'snare', 'hat', 'voice']) {
        out[key] += (0 - out[key]) * k;
      }
      out.kickHit = out.snareHit = out.hatHit = false;
      for (let i = 0; i < SPECTRUM_BINS; i++) { this.spectrum[i] *= 1 - k; this.specRaw[i] *= 1 - k; }
      for (let i = 0; i < WAVE_SAMPLES; i++) this.waveform[i] *= 1 - k;
      return out;
    }
    if (this.binCount !== eng.binCount) { this.binCount = eng.binCount; this._buildBins(); }

    const db = eng.freq;
    const mag = this.mag;
    const prev = this.prevMag;
    const n = this.binCount;

    // dB -> linear amplitude. Anything at the analyser floor becomes ~0.
    for (let i = 0; i < n; i++) {
      const v = db[i];
      mag[i] = v <= -99 ? 0 : Math.pow(10, v / 20);
    }

    // Whole-spectrum positive flux -> the onset envelope the tempo tracker eats.
    let flux = 0;
    let centroidNum = 0;
    let centroidDen = 0;
    const binHz = eng.binHz;
    for (let i = 1; i < n; i++) {
      const d = mag[i] - prev[i];
      if (d > 0) flux += d;
      centroidNum += mag[i] * i * binHz;
      centroidDen += mag[i];
    }
    flux /= n;

    // RMS from the time-domain buffer: a truer loudness than summing bins.
    const td = eng.time;
    let sum = 0;
    for (let i = 0; i < td.length; i++) sum += td[i] * td[i];
    const rms = Math.sqrt(sum / td.length);

    // --- vocal-band presence -------------------------------------------------
    const vr = this.vocalRange;
    let vSum = 0, vLogSum = 0, vCnt = 0;
    for (let i = vr.i0; i <= vr.i1; i++) {
      const m = mag[i] + 1e-9;
      vSum += m;
      vLogSum += Math.log(m);
      vCnt++;
    }
    let totalMag = 0;
    for (let i = 1; i < n; i++) totalMag += mag[i];
    const vShare = totalMag > 1e-9 ? vSum / totalMag : 0;
    // Spectral flatness over the band: near 1 for noise (cymbals, breath), near
    // 0 for a harmonic stack, which is what a voice or a horn looks like.
    const aMean = vSum / Math.max(vCnt, 1);
    const gMean = Math.exp(vLogSum / Math.max(vCnt, 1));
    const tonality = clamp01(1 - (aMean > 1e-9 ? gMean / aMean : 1));
    // Syllable-rate wobble. A pad holds still in this band; speech and singing
    // do not, and that is most of what separates them from a sustained synth.
    this.voiceHist[this.voiceIdx] = vSum;
    this.voiceIdx = (this.voiceIdx + 1) % this.voiceHist.length;
    let vMean = 0;
    for (let i = 0; i < this.voiceHist.length; i++) vMean += this.voiceHist[i];
    vMean /= this.voiceHist.length;
    let vDev = 0;
    for (let i = 0; i < this.voiceHist.length; i++) vDev += Math.abs(this.voiceHist[i] - vMean);
    vDev /= this.voiceHist.length;
    const wobble = vMean > 1e-9 ? clamp01((vDev / vMean) * 3) : 0;
    const voiceRaw = vShare * tonality * (0.45 + 0.55 * wobble);
    out.voice = this.voiceEnv.process(this.voiceNorm.process(voiceRaw, dt), dt);

    // Per-band energy, averaged in dB (perceptual) then adaptively normalized.
    const bandFlux = {};
    for (const r of this.bandRanges) {
      let acc = 0, cnt = 0, accMag = 0;
      for (let i = r.i0; i <= r.i1; i++) {
        acc += db[i] < -99 ? -99 : db[i];
        accMag += mag[i];
        cnt++;
      }
      const avgDb = cnt ? acc / cnt : -99;
      const raw = clamp01((avgDb + 92) / 82);
      const norm = this.bandNorm[r.key].process(raw, dt);
      out[r.key] = this.bandEnv[r.key].process(norm, dt);
      const mAvg = cnt ? accMag / cnt : 0;
      const a = Math.min(1, dt / 0.5);
      this.bandMean[r.key] += (mAvg - this.bandMean[r.key]) * a;
      // Relative jump, not absolute: dimensionless and comparable across bands.
      bandFlux[r.key] = Math.max(0, (mAvg - this.bandPrev[r.key]) / (this.bandMean[r.key] + 1e-9));
      this.bandPrev[r.key] = mAvg;
    }

    out.level = this.levelEnv.process(this.levelNorm.process(rms, dt), dt);
    const rawFlux = this.fluxNorm.process(flux, dt);
    out.flux = rawFlux;
    out.onset = rawFlux;

    const centroidHz = centroidDen > 1e-9 ? centroidNum / centroidDen : 200;
    const cNorm = clamp01(Math.log2(Math.max(centroidHz, 60) / 60) / Math.log2(10000 / 60));
    out.centroid = this.centroidSmooth.process(cNorm, dt);

    out.kick = this.kickDet.process(bandFlux.bass, dt);
    out.kickHit = this.kickDet.fired;
    // Snare/clap: a mid-band transient that the kick is not driving from below
    // and the hats are not driving from above. Vetoing (rather than scaling the
    // input) matters, because the detector's adaptive median absorbs any
    // uniform gain change but cannot absorb a suppressed trigger.
    const snareVeto = bandFlux.bass > bandFlux.mid * 0.9 || bandFlux.air > bandFlux.mid;
    out.snare = this.snareDet.process(bandFlux.mid, dt, snareVeto);
    out.snareHit = this.snareDet.fired;
    out.hat = this.hatDet.process(bandFlux.air, dt);
    out.hatHit = this.hatDet.fired;

    // Log-spaced spectrum for shaders. Smoothing happens on the raw magnitudes;
    // normalization is a separate pass against a decaying peak hold, so the two
    // never feed back into each other.
    let peak = 1e-6;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const [i0, i1] = this.logBins[i];
      let acc = 0;
      for (let j = i0; j < i1; j++) acc += mag[j];
      const v = acc / (i1 - i0);
      this.specRaw[i] = this.specRaw[i] * 0.55 + v * 0.45;
      if (this.specRaw[i] > peak) peak = this.specRaw[i];
    }
    this.specPeak = peak > this.specPeak
      ? peak
      : Math.max(peak, this.specPeak * Math.exp(-dt * 0.8));
    const scale = 1 / Math.max(this.specPeak, 1e-7);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      this.spectrum[i] = clamp01(Math.pow(this.specRaw[i] * scale, 0.6));
    }

    // Downsampled waveform for scope-style elements. Peak-picking rather than
    // averaging, so a fast waveform does not average itself flat.
    const hop = td.length / WAVE_SAMPLES;
    for (let i = 0; i < WAVE_SAMPLES; i++) {
      const a0 = Math.floor(i * hop);
      const a1 = Math.min(td.length, Math.floor((i + 1) * hop));
      let peak = 0;
      for (let j = a0; j < a1; j++) if (Math.abs(td[j]) > Math.abs(peak)) peak = td[j];
      this.waveform[i] = this.waveform[i] * 0.35 + peak * 0.65;
    }

    prev.set(mag);
    return out;
  }
}

export { BAND_DEFS };
