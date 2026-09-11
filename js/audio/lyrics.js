// Live lyric / speech transcription.
//
// This is the one feature in VJay that leaves the machine. Chrome's
// SpeechRecognition streams microphone audio to Google's servers and sends text
// back; there is no offline path for it in a browser. So it is strictly opt-in,
// it is never started automatically, and the UI says where the audio goes.
//
// It also opens its OWN microphone capture rather than reading the analyser's
// stream - the API gives no way to feed it an AudioNode. That means it hears
// the room, not the mixer feed, which for a sung vocal in a live room is
// actually the better microphone of the two.
//
// Expect it to be wrong. Sung lyrics with a band behind them are close to the
// worst case for a recogniser tuned on dictation. It is good for spoken word,
// announcements and clear vocals, and it is a texture rather than a caption.

const Recognition = typeof window !== 'undefined'
  && (window.SpeechRecognition || window.webkitSpeechRecognition);

export class LyricListener {
  constructor({ maxWords = 14, holdMs = 6000 } = {}) {
    this.supported = !!Recognition;
    this.listening = false;
    this.words = [];            // [{ text, at }]
    this.interim = '';
    this.error = null;
    this.lastAt = 0;
    this.maxWords = maxWords;
    this.holdMs = holdMs;
    this.onChange = () => {};
    this._rec = null;
    this._wantOn = false;
  }

  /** The line to show: settled words plus whatever is still being guessed. */
  get line() {
    const settled = this.words.map((w) => w.text).join(' ');
    return (settled + (this.interim ? ` ${this.interim}` : '')).trim();
  }

  /** 0..1, how recently anything was heard - for fading the overlay out. */
  freshness(now = Date.now()) {
    if (!this.lastAt) return 0;
    const age = now - this.lastAt;
    if (age >= this.holdMs) return 0;
    return 1 - age / this.holdMs;
  }

  start() {
    if (!this.supported) {
      this.error = 'This browser has no speech recognition. Chrome does.';
      this.onChange();
      return false;
    }
    this._wantOn = true;
    this._spin();
    return true;
  }

  stop() {
    this._wantOn = false;
    this.listening = false;
    if (this._rec) {
      try { this._rec.onend = null; this._rec.abort(); } catch (_) {}
      this._rec = null;
    }
    this.interim = '';
    this.onChange();
  }

  toggle() { return this.listening || this._wantOn ? (this.stop(), false) : this.start(); }

  clear() {
    this.words = [];
    this.interim = '';
    this.onChange();
  }

  _spin() {
    if (!this._wantOn || this._rec) return;
    const rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = navigator.language || 'en-US';

    rec.onstart = () => { this.listening = true; this.error = null; this.onChange(); };
    rec.onerror = (e) => {
      this.error = e.error === 'not-allowed'
        ? 'Microphone blocked for speech recognition'
        : e.error === 'network' ? 'Speech recognition needs a network connection'
        : `Speech recognition: ${e.error}`;
      // A denied permission will not fix itself by retrying.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this._wantOn = false;
      this.onChange();
    };
    // Chrome ends the session on its own after a pause, so a continuous listen
    // has to be re-armed rather than assumed.
    rec.onend = () => {
      this.listening = false;
      this._rec = null;
      if (this._wantOn) setTimeout(() => this._spin(), 350);
      this.onChange();
    };
    rec.onresult = (e) => {
      let interim = '';
      const now = Date.now();
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = (r[0]?.transcript || '').trim();
        if (!text) continue;
        if (r.isFinal) {
          for (const w of text.split(/\s+/)) this.words.push({ text: w, at: now });
        } else {
          interim = text;
        }
      }
      this.interim = interim;
      if (this.words.length > this.maxWords) {
        this.words.splice(0, this.words.length - this.maxWords);
      }
      this.lastAt = now;
      this.onChange();
    };

    try {
      this._rec = rec;
      rec.start();
    } catch (_) {
      // start() throws if one is already running; the onend loop will retry.
      this._rec = null;
    }
  }
}
