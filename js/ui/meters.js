// 2D analysis display: spectrum, band levels, transient LEDs, beat grid, BPM.
// Verifying the audio chain by eye is much faster than reading numbers.

const BANDS = [
  ['bass', 'BASS', '#ff3d68'],
  ['lowMid', 'LO-M', '#ff8a3d'],
  ['mid', 'MID', '#ffd93d'],
  ['high', 'HIGH', '#3dffa5'],
  ['air', 'AIR', '#3db4ff'],
];

export class Meters {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width * this.dpr));
    const h = Math.max(1, Math.floor(r.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  draw(f, tempo) {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const s = this.dpr;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a0c11';
    ctx.fillRect(0, 0, W, H);

    const specH = H * 0.52;
    const spec = f.spectrum;
    const n = spec.length;
    const bw = W / n;
    for (let i = 0; i < n; i++) {
      const v = spec[i];
      const h = v * specH;
      const hue = 200 - (i / n) * 200;
      ctx.fillStyle = `hsl(${hue} 90% ${35 + v * 35}%)`;
      ctx.fillRect(i * bw, specH - h, Math.max(1, bw - 1 * s), h);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(0, specH + 0.5);
    ctx.lineTo(W, specH + 0.5);
    ctx.stroke();

    // Band meters
    const rowY = specH + 6 * s;
    const rowH = H * 0.18;
    const cellW = W / BANDS.length;
    ctx.font = `${9 * s}px ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    for (let i = 0; i < BANDS.length; i++) {
      const [key, label, colour] = BANDS[i];
      const v = f[key] || 0;
      const x = i * cellW + 3 * s;
      const w = cellW - 6 * s;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(x, rowY, w, rowH);
      ctx.fillStyle = colour;
      ctx.fillRect(x, rowY + rowH * (1 - v), w, rowH * v);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(label, x + 2 * s, rowY + rowH + 2 * s);
    }

    // Transient LEDs
    const ledY = rowY + rowH + 14 * s;
    // V is the vocal-band detector: formant-range energy that is harmonic
    // rather than noisy and wobbling at syllable rate. Watching it against a
    // real vocal is the only way to know whether to trust it on a given song.
    const leds = [['K', f.kick, '#ff3d68'], ['S', f.snare, '#ffd93d'],
      ['H', f.hat, '#3db4ff'], ['V', f.voice, '#c9a0ff']];
    leds.forEach(([label, v, colour], i) => {
      const x = 8 * s + i * 26 * s;
      ctx.beginPath();
      ctx.arc(x, ledY + 5 * s, 5 * s, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${0.08 + v * 0.1})`;
      ctx.fill();
      ctx.fillStyle = colour;
      ctx.globalAlpha = 0.15 + v * 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(label, x + 8 * s, ledY);
    });

    // Beat grid: four dots, current beat lit, downbeat larger.
    const beat = (tempo.beatCount % 4 + 4) % 4;
    for (let i = 0; i < 4; i++) {
      const x = W - (4 - i) * 18 * s - 6 * s;
      const active = i === beat;
      const r = (i === 0 ? 6 : 4.5) * s;
      ctx.beginPath();
      ctx.arc(x, ledY + 5 * s, r * (active ? 1 + tempo.pulse * 0.5 : 1), 0, Math.PI * 2);
      ctx.fillStyle = active
        ? `rgba(120,255,180,${0.45 + tempo.pulse * 0.55})`
        : 'rgba(255,255,255,0.14)';
      ctx.fill();
    }

    // BPM + confidence
    const infoY = ledY + 16 * s;
    ctx.font = `600 ${13 * s}px ui-monospace, monospace`;
    ctx.fillStyle = tempo.locked ? '#ffd93d' : '#e8ecf5';
    ctx.fillText(`${tempo.bpm.toFixed(1)} BPM${tempo.locked ? ' (lock)' : ''}`, 8 * s, infoY);
    const cw = 60 * s;
    const cx = W - cw - 8 * s;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(cx, infoY + 3 * s, cw, 6 * s);
    ctx.fillStyle = tempo.confidence > 0.4 ? '#3dffa5' : tempo.confidence > 0.18 ? '#ffd93d' : '#ff6b6b';
    ctx.fillRect(cx, infoY + 3 * s, cw * Math.min(1, tempo.confidence), 6 * s);
    ctx.font = `${9 * s}px ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText('conf', cx - 26 * s, infoY + 2 * s);
  }
}
