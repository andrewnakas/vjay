// Tempo tracking: onset envelope -> autocorrelation BPM -> phase-locked beat grid.
//
// The grid free-runs at the last confident tempo when detection gets shaky, so
// visuals keep a steady pulse instead of stuttering. Tap tempo and a manual BPM
// lock always win over detection.

const RATE = 100;              // onset envelope resample rate, Hz
const WINDOW = 8 * RATE;       // 8 s of history
const MIN_BPM = 60;
const MAX_BPM = 200;
const MIN_LAG = Math.floor((60 * RATE) / MAX_BPM);
const MAX_LAG = Math.ceil((60 * RATE) / MIN_BPM);

export class TempoTracker {
  constructor() {
    this.buf = new Float32Array(WINDOW);
    this.head = 0;
    this.filled = 0;
    this._acc = 0;
    this._pending = 0;
    this._pendingCount = 0;

    this.bpm = 120;
    this.period = 60 / 120;    // seconds per beat
    this.phase = 0;            // 0..1 within the current beat
    this.confidence = 0;
    this.locked = false;       // manual BPM overrides detection
    this.beatCount = 0;

    this.beatHit = false;
    this.barHit = false;
    this.phraseHit = false;
    this.pulse = 0;

    this._sinceAnalysis = 0;
    this._taps = [];
    this._scores = new Float32Array(MAX_LAG + 1);
  }

  get barPhase() { return ((this.beatCount % 4) + this.phase) / 4; }
  get phrasePhase() { return ((this.beatCount % 16) + this.phase) / 16; }

  setBpm(bpm, lock = true) {
    if (!(bpm > 20 && bpm < 400)) return;
    this.bpm = bpm;
    this.period = 60 / bpm;
    this.locked = lock;
  }
  unlock() { this.locked = false; }

  /** Call on every tap of the tap-tempo key. Also re-aligns the downbeat. */
  tap(now) {
    this._taps.push(now);
    if (this._taps.length > 8) this._taps.shift();
    // Drop the history if the user paused between taps.
    if (this._taps.length > 1 && now - this._taps[this._taps.length - 2] > 2.5) {
      this._taps = [now];
    }
    if (this._taps.length >= 3) {
      const iv = [];
      for (let i = 1; i < this._taps.length; i++) iv.push(this._taps[i] - this._taps[i - 1]);
      iv.sort((a, b) => a - b);
      const median = iv[iv.length >> 1];
      if (median > 0.2 && median < 2.0) this.setBpm(60 / median, true);
    }
    this.phase = 0;
    this.beatCount = 0;
    this.pulse = 1;
    return this.bpm;
  }

  resetDownbeat() { this.beatCount = 0; this.phase = 0; }

  /** Push one onset-envelope sample per frame; resampled onto the fixed grid. */
  _push(onset, dt) {
    this._pending += onset;
    this._pendingCount++;
    this._acc += dt;
    const step = 1 / RATE;
    while (this._acc >= step) {
      this._acc -= step;
      const v = this._pendingCount ? this._pending / this._pendingCount : 0;
      this._pending = 0;
      this._pendingCount = 0;
      this.buf[this.head] = v;
      this.head = (this.head + 1) % WINDOW;
      if (this.filled < WINDOW) this.filled++;
    }
  }

  _at(agoSamples) {
    // agoSamples = 0 is the most recently written sample.
    const i = (this.head - 1 - agoSamples + WINDOW * 2) % WINDOW;
    return this.buf[i];
  }

  _analyse() {
    if (this.filled < RATE * 3) return;
    const n = Math.min(this.filled, WINDOW);

    let mean = 0;
    for (let i = 0; i < n; i++) mean += this.buf[i];
    mean /= n;

    // Autocorrelation of the mean-removed onset envelope.
    let best = 0;
    let bestLag = 0;
    let scoreSum = 0;
    let scoreCount = 0;
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
      const count = n - lag;
      if (count < RATE) { this._scores[lag] = 0; continue; }
      let acc = 0;
      for (let i = 0; i < count; i++) {
        acc += (this._at(i) - mean) * (this._at(i + lag) - mean);
      }
      acc /= count;
      // Prior favouring 90-160 BPM, where octave errors mostly resolve.
      const bpm = (60 * RATE) / lag;
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 0.55, 2));
      const s = acc * w;
      this._scores[lag] = s;
      scoreSum += Math.abs(s);
      scoreCount++;
      if (s > best) { best = s; bestLag = lag; }
    }
    if (!bestLag || best <= 0) { this.confidence *= 0.9; return; }

    // Octave correction: prefer half/double tempo if it scores comparably and
    // sits closer to the middle of the usable range.
    for (const alt of [bestLag * 2, Math.round(bestLag / 2)]) {
      if (alt < MIN_LAG || alt > MAX_LAG) continue;
      if (this._scores[alt] > best * 0.82) { bestLag = alt; best = this._scores[alt]; }
    }

    const meanScore = scoreCount ? scoreSum / scoreCount : 1e-6;
    this.confidence = Math.max(0, Math.min(1, (best / Math.max(meanScore, 1e-9) - 1) / 4));

    const detectedBpm = (60 * RATE) / bestLag;
    if (!this.locked && this.confidence > 0.15) {
      // Ease toward the detection rather than jumping - stops BPM flicker.
      const k = 0.25 * Math.min(1, this.confidence * 2);
      this.bpm += (detectedBpm - this.bpm) * k;
      this.period = 60 / this.bpm;
    }

    // Beat phase: find the offset within one period where onsets stack up.
    const lag = Math.max(1, Math.round(this.period * RATE));
    let bestOff = 0;
    let bestOffScore = -Infinity;
    const reps = Math.min(8, Math.floor(n / lag));
    if (reps >= 2) {
      for (let off = 0; off < lag; off++) {
        let acc = 0;
        for (let k = 0; k < reps; k++) acc += this._at(off + k * lag);
        if (acc > bestOffScore) { bestOffScore = acc; bestOff = off; }
      }
      // bestOff samples ago was a beat -> measured phase since that beat.
      const measured = ((bestOff / lag) % 1 + 1) % 1;
      let diff = measured - this.phase;
      diff -= Math.round(diff); // wrap to -0.5..0.5
      const gain = 0.12 * Math.min(1, this.confidence * 3 + 0.15);
      this.phase = ((this.phase + diff * gain) % 1 + 1) % 1;
    }
  }

  update(onset, dt, now) {
    this._push(onset, dt);
    this._sinceAnalysis += dt;
    if (this._sinceAnalysis >= 0.25) {
      this._sinceAnalysis = 0;
      if (!this.locked || this.confidence === 0) this._analyse();
      else this._analyse(); // still track phase when BPM is locked
    }

    const prevPhase = this.phase;
    this.phase += dt / Math.max(this.period, 1e-3);
    this.beatHit = false;
    this.barHit = false;
    this.phraseHit = false;
    while (this.phase >= 1) {
      this.phase -= 1;
      this.beatCount++;
      this.beatHit = true;
      this.pulse = 1;
      if (this.beatCount % 4 === 0) this.barHit = true;
      if (this.beatCount % 16 === 0) this.phraseHit = true;
    }
    this.pulse = Math.max(0, this.pulse - dt * 6);
    return this;
  }

  /** Copy the beat state onto the shared feature bus. */
  writeTo(features) {
    features.bpm = this.bpm;
    features.beatPhase = this.phase;
    features.barPhase = this.barPhase;
    features.phrasePhase = this.phrasePhase;
    features.beatPulse = this.pulse;
    features.beatHit = this.beatHit;
    features.barHit = this.barHit;
    features.phraseHit = this.phraseHit;
    features.confidence = this.confidence;
    features.beatCount = this.beatCount;
  }
}
