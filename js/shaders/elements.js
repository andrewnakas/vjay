// Simple audio-reactive elements.
//
// Unlike the full-frame generators these write meaningful ALPHA, so they
// composite as overlays on top of a webcam or screen capture rather than
// replacing it. Each one does a single legible thing.

const BAND_OPTIONS = ['Bass', 'Low mid', 'Mid', 'High', 'Air', 'Level', 'Beat pulse', 'Voice'];

/** GLSL that resolves a band selector param to a feature value. */
const BAND_PICK = `
float pickBand(float sel){
  int i = int(sel + 0.5);
  if (i == 0) return uBass;
  if (i == 1) return uLowMid;
  if (i == 2) return uMid;
  if (i == 3) return uHigh;
  if (i == 4) return uAir;
  if (i == 5) return uLevel;
  if (i == 6) return uBeatPulse;
  return uVoice;
}
`;

export const ELEMENTS = [
  {
    id: 'ring',
    name: 'Ring',
    element: true,
    params: [
      { key: 'radius', label: 'Radius', min: 0.02, max: 0.9, def: 0.3 },
      { key: 'thickness', label: 'Thickness', min: 0.002, max: 0.3, def: 0.02 },
      { key: 'soft', label: 'Softness', min: 0.001, max: 0.2, def: 0.01 },
      { key: 'band', label: 'Driven by', type: 'enum', options: BAND_OPTIONS, def: 0 },
      { key: 'pulse', label: 'Pulse depth', min: 0, max: 1, def: 0.35 },
      { key: 'segments', label: 'Dashes', type: 'int', min: 0, max: 64, def: 0 },
      { key: 'spin', label: 'Spin', min: -2, max: 2, def: 0.1 },
      { key: 'tint', label: 'Colour', min: 0, max: 1, def: 0 },
    ],
    frag: BAND_PICK + `
void main(){
  vec2 p = centred(vUv, uRes);
  float r = length(p);
  float amp = pickBand(u_band);
  float radius = u_radius * (1.0 + amp * u_pulse);
  float band = smoothstep(u_thickness + u_soft, u_thickness, abs(r - radius));

  if (u_segments > 0.5) {
    float a = atan(p.y, p.x) / TAU + 0.5 + uTime * u_spin * 0.1;
    band *= smoothstep(0.5, 0.62, abs(fract(a * u_segments) - 0.5) * 2.0);
  }
  vec3 col = palette(u_tint + uTime * 0.03 + amp * 0.2, uPalette);
  fragColor = vec4(col * (0.7 + amp * 0.8), band);
}`,
  },

  {
    id: 'meter',
    name: 'Bar Meter',
    element: true,
    params: [
      { key: 'count', label: 'Bars', type: 'int', min: 3, max: 64, def: 24 },
      { key: 'width', label: 'Bar width', min: 0.1, max: 1, def: 0.62 },
      { key: 'height', label: 'Height', min: 0.05, max: 1.5, def: 0.55 },
      { key: 'mirror', label: 'Mirror', type: 'bool', def: 0 },
      { key: 'gain', label: 'Gain', min: 0.2, max: 4, def: 1.3 },
      { key: 'anchor', label: 'Anchor', type: 'enum', options: ['Bottom', 'Centre', 'Top'], def: 0 },
      { key: 'round', label: 'Rounded', min: 0, max: 1, def: 0.4 },
      { key: 'tint', label: 'Colour', min: 0, max: 1, def: 0 },
    ],
    frag: `
void main(){
  float n = max(u_count, 1.0);
  float t = u_mirror > 0.5 ? abs(vUv.x * 2.0 - 1.0) : vUv.x;
  float idx = floor(t * n);
  float cellT = fract(t * n);

  float h = clamp(spectrum((idx + 0.5) / n) * u_gain, 0.0, 1.5) * u_height;
  int anchor = int(u_anchor + 0.5);
  float y = vUv.y;
  float d = anchor == 0 ? y : anchor == 2 ? 1.0 - y : abs(y - 0.5) * 2.0;

  float inBar = step(d, h);
  // Round the cap by shrinking the bar width near its tip.
  float wShrink = mix(1.0, 1.0 - smoothstep(h - 0.03 * u_round, h, d), u_round);
  float inCell = step(abs(cellT - 0.5) * 2.0, u_width * wShrink);

  float a = inBar * inCell;
  vec3 col = palette(u_tint + (idx / n) * 0.7 + uTime * 0.03, uPalette);
  fragColor = vec4(col * (0.6 + h), a);
}`,
  },

  {
    id: 'scope',
    name: 'Scope',
    element: true,
    params: [
      { key: 'gain', label: 'Gain', min: 0.1, max: 6, def: 1.4 },
      { key: 'thickness', label: 'Thickness', min: 0.002, max: 0.12, def: 0.012 },
      { key: 'mode', label: 'Shape', type: 'enum', options: ['Line', 'Mirror', 'Circle'], def: 0 },
      { key: 'radius', label: 'Circle radius', min: 0.05, max: 0.8, def: 0.3 },
      { key: 'glow', label: 'Glow', min: 0, max: 2, def: 0.5 },
      { key: 'tint', label: 'Colour', min: 0, max: 1, def: 0.2 },
    ],
    frag: `
void main(){
  int mode = int(u_mode + 0.5);
  float d;
  float t;
  if (mode == 2) {
    vec2 p = centred(vUv, uRes);
    float a = atan(p.y, p.x) / TAU + 0.5;
    t = a;
    float target = u_radius + wave(a) * 0.12 * u_gain;
    d = abs(length(p) - target);
  } else {
    t = vUv.x;
    float w = wave(mode == 1 ? abs(t * 2.0 - 1.0) : t) * 0.4 * u_gain;
    d = abs((vUv.y - 0.5) - w);
  }
  float line = smoothstep(u_thickness, u_thickness * 0.35, d);
  float glow = exp(-d * 40.0 / max(u_glow, 0.01)) * u_glow * 0.5;
  vec3 col = palette(u_tint + t * 0.4 + uTime * 0.02, uPalette);
  fragColor = vec4(col, clamp(line + glow, 0.0, 1.0));
}`,
  },

  {
    id: 'dots',
    name: 'Dot Grid',
    element: true,
    params: [
      { key: 'cols', label: 'Columns', type: 'int', min: 2, max: 48, def: 14 },
      { key: 'rows', label: 'Rows', type: 'int', min: 1, max: 32, def: 8 },
      { key: 'size', label: 'Dot size', min: 0.02, max: 0.5, def: 0.16 },
      { key: 'react', label: 'Reaction', min: 0, max: 2, def: 1 },
      { key: 'soft', label: 'Softness', min: 0.01, max: 1, def: 0.3 },
      { key: 'tint', label: 'Colour', min: 0, max: 1, def: 0.5 },
    ],
    frag: `
void main(){
  vec2 n = vec2(max(u_cols, 1.0), max(u_rows, 1.0));
  vec2 cell = floor(vUv * n);
  vec2 f = fract(vUv * n) - 0.5;
  float amp = spectrum((cell.x + 0.5) / n.x);
  float lit = smoothstep((cell.y) / n.y, (cell.y + 1.0) / n.y, amp * u_react);
  float r = u_size * (0.5 + amp * u_react);
  float dot = smoothstep(r, r * (1.0 - u_soft), length(f));
  float a = dot * (0.12 + lit * 0.88);
  vec3 col = palette(u_tint + (cell.y / n.y) * 0.4 + uTime * 0.03, uPalette);
  fragColor = vec4(col * (0.5 + lit), a);
}`,
  },

  {
    id: 'sweep',
    name: 'Sweep',
    element: true,
    params: [
      { key: 'axis', label: 'Axis', type: 'enum', options: ['Horizontal', 'Vertical', 'Radial'], def: 0 },
      { key: 'div', label: 'Sync', type: 'enum', options: ['1/2 beat', '1 beat', '1 bar', '2 bars', 'Phrase'], def: 2 },
      { key: 'width', label: 'Width', min: 0.005, max: 0.5, def: 0.05 },
      { key: 'trail', label: 'Trail', min: 0, max: 1, def: 0.5 },
      { key: 'tint', label: 'Colour', min: 0, max: 1, def: 0.1 },
    ],
    frag: `
void main(){
  float phases[5] = float[5](fract(uBeatPhase * 2.0), uBeatPhase, uBarPhase,
                             fract(uPhrasePhase * 2.0), uPhrasePhase);
  float ph = phases[int(clamp(u_div, 0.0, 4.0))];
  int axis = int(u_axis + 0.5);
  float t = axis == 0 ? vUv.x : axis == 1 ? vUv.y : clamp(length(centred(vUv, uRes)) * 0.7, 0.0, 1.0);
  float d = t - ph;
  // Trail lags behind the head, so the sweep reads as travelling.
  float head = smoothstep(u_width, 0.0, abs(d));
  float tail = u_trail > 0.0 ? smoothstep(u_width * 12.0 * u_trail, 0.0, -d) * step(d, 0.0) * u_trail : 0.0;
  float a = clamp(head + tail * 0.55, 0.0, 1.0);
  vec3 col = palette(u_tint + ph * 0.3, uPalette);
  fragColor = vec4(col * (0.7 + uBeatPulse * 0.5), a);
}`,
  },

  {
    id: 'blob',
    name: 'Glow Blob',
    element: true,
    params: [
      { key: 'size', label: 'Size', min: 0.02, max: 1.2, def: 0.28 },
      { key: 'falloff', label: 'Falloff', min: 0.5, max: 6, def: 2.2 },
      { key: 'band', label: 'Driven by', type: 'enum', options: BAND_OPTIONS, def: 0 },
      { key: 'pulse', label: 'Pulse depth', min: 0, max: 2, def: 0.8 },
      { key: 'wobble', label: 'Wobble', min: 0, max: 1, def: 0.2 },
      { key: 'tint', label: 'Colour', min: 0, max: 1, def: 0.6 },
    ],
    frag: BAND_PICK + `
void main(){
  vec2 p = centred(vUv, uRes);
  float amp = pickBand(u_band);
  float a0 = atan(p.y, p.x);
  float r = length(p) * (1.0 + u_wobble * sin(a0 * 5.0 + uTime * 1.3) * 0.35);
  float size = u_size * (1.0 + amp * u_pulse);
  float g = pow(clamp(1.0 - r / max(size, 0.001), 0.0, 1.0), u_falloff);
  vec3 col = palette(u_tint + amp * 0.3 + uTime * 0.02, uPalette);
  fragColor = vec4(col, g * (0.35 + amp * 0.75));
}`,
  },

  {
    id: 'frame',
    name: 'Frame',
    element: true,
    params: [
      { key: 'inset', label: 'Inset', min: 0, max: 0.45, def: 0.06 },
      { key: 'thickness', label: 'Thickness', min: 0.001, max: 0.08, def: 0.006 },
      { key: 'corners', label: 'Corner marks', min: 0, max: 0.5, def: 0 },
      { key: 'react', label: 'Beat kick', min: 0, max: 1, def: 0.3 },
      { key: 'tint', label: 'Colour', min: 0, max: 1, def: 0 },
    ],
    frag: `
void main(){
  float inset = u_inset - uBeatPulse * u_react * 0.03;
  vec2 d = min(vUv - inset, 1.0 - inset - vUv);
  float edge = min(d.x, d.y);
  float line = smoothstep(u_thickness, 0.0, abs(edge));
  if (u_corners > 0.001) {
    // Keep only the corner runs: near one edge AND close to the other axis end.
    vec2 q = min(vUv - inset, 1.0 - inset - vUv);
    float along = max(q.x, q.y);
    line *= step(along, u_corners);
  }
  vec3 col = palette(u_tint + uTime * 0.02, uPalette);
  fragColor = vec4(col * (0.8 + uBeatPulse * 0.6), line * step(0.0, edge + u_thickness));
}`,
  },

  {
    id: 'sparks',
    name: 'Sparks',
    element: true,
    params: [
      { key: 'count', label: 'Count', min: 4, max: 60, def: 22 },
      { key: 'size', label: 'Size', min: 0.002, max: 0.12, def: 0.016 },
      { key: 'spread', label: 'Spread', min: 0.05, max: 1.2, def: 0.5 },
      { key: 'speed', label: 'Speed', min: 0, max: 3, def: 1 },
      { key: 'trigger', label: 'Trigger', type: 'enum', options: ['Kick', 'Snare', 'Hat', 'Beat'], def: 0 },
      { key: 'tint', label: 'Colour', min: 0, max: 1, def: 0.15 },
    ],
    frag: `
void main(){
  vec2 p = centred(vUv, uRes);
  float trig = int(u_trigger + 0.5) == 0 ? uKick
             : int(u_trigger + 0.5) == 1 ? uSnare
             : int(u_trigger + 0.5) == 2 ? uHat : uBeatPulse;
  // Bursts are indexed by beat, so every hit throws a fresh, stable pattern.
  float burst = floor(uTime * 2.0 + uBeatPhase);
  float acc = 0.0;
  vec3 col = vec3(0.0);
  for (int i = 0; i < 60; i++) {
    if (float(i) >= u_count) break;
    vec2 rnd = hash22(vec2(float(i), burst));
    float ang = rnd.x * TAU;
    float life = fract(uTime * u_speed * 0.7 + rnd.y);
    vec2 pos = vec2(cos(ang), sin(ang)) * life * u_spread;
    float d = length(p - pos);
    float g = u_size * (1.0 - life) / max(d, 0.001);
    float s = pow(clamp(g, 0.0, 1.0), 2.0) * trig;
    acc += s;
    col += palette(u_tint + rnd.y * 0.4, uPalette) * s;
  }
  fragColor = vec4(col / max(acc, 0.001), clamp(acc, 0.0, 1.0));
}`,
  },

  {
    id: 'solid',
    name: 'Solid / Gradient',
    element: true,
    params: [
      { key: 'mode', label: 'Mode', type: 'enum', options: ['Solid', 'Vertical', 'Horizontal', 'Radial'], def: 1 },
      { key: 'tint', label: 'Colour', min: 0, max: 1, def: 0 },
      { key: 'spread', label: 'Spread', min: 0.1, max: 3, def: 1 },
      { key: 'alpha', label: 'Alpha', min: 0, max: 1, def: 0.6 },
      { key: 'react', label: 'Audio drive', min: 0, max: 1, def: 0.3 },
    ],
    frag: `
void main(){
  int mode = int(u_mode + 0.5);
  float t = mode == 0 ? 0.0
          : mode == 1 ? vUv.y
          : mode == 2 ? vUv.x
          : clamp(length(centred(vUv, uRes)), 0.0, 1.0);
  float drive = uCentroid * u_react + uLevel * u_react * 0.4;
  vec3 col = palette(u_tint + t * u_spread + drive + uTime * 0.02, uPalette);
  float a = u_alpha * (mode == 0 ? 1.0 : mix(1.0, 1.0 - t, 0.35));
  fragColor = vec4(col, a * (0.7 + uLevel * u_react));
}`,
  },

  {
    // Frequency overlays are meant to be PINNED over a comp rather than built
    // into one, so both of these write real alpha and leave the picture
    // underneath alone everywhere they are not drawing.
    id: 'ribbon',
    name: 'Spectrum Ribbon',
    element: true,
    params: [
      { key: 'height', label: 'Height', min: 0.02, max: 0.8, def: 0.22 },
      { key: 'y', label: 'Position', min: 0, max: 1, def: 0.5 },
      { key: 'mirror', label: 'Mirror', type: 'bool', def: 1 },
      { key: 'gain', label: 'Gain', min: 0.2, max: 4, def: 1.4 },
      { key: 'thickness', label: 'Line', min: 0.002, max: 0.12, def: 0.014 },
      { key: 'fill', label: 'Fill', min: 0, max: 1, def: 0.3 },
      { key: 'glow', label: 'Glow', min: 0, max: 1.5, def: 0.55 },
      { key: 'drift', label: 'Drift', min: 0, max: 2, def: 0.25 },
      { key: 'tint', label: 'Colour', min: 0, max: 1, def: 0 },
    ],
    frag: `
void main(){
  float t = u_mirror > 0.5 ? abs(vUv.x * 2.0 - 1.0) : vUv.x;
  // Sample either side of the point too, so the ribbon is a smooth curve
  // rather than a comb of 64 steps.
  float e = 0.012;
  float a0 = spectrum(clamp(t - e, 0.0, 1.0));
  float a1 = spectrum(clamp(t, 0.0, 1.0));
  float a2 = spectrum(clamp(t + e, 0.0, 1.0));
  float amp = clamp((a0 + a1 * 2.0 + a2) * 0.25 * u_gain, 0.0, 1.5);

  float centre = u_y + sin(vUv.x * 6.0 + uTime * u_drift) * 0.012;
  float h = amp * u_height;
  float d = abs(vUv.y - centre);

  float line = 1.0 - smoothstep(u_thickness * 0.5, u_thickness * 0.5 + 0.004, abs(d - h));
  float body = (1.0 - smoothstep(h, h + 0.004, d)) * u_fill;
  float glow = exp(-abs(d - h) / max(u_height * 0.35, 0.02)) * u_glow * amp;

  float alpha = clamp(line + body + glow * 0.6, 0.0, 1.0);
  vec3 col = palette(u_tint + t * 0.6 + uTime * 0.02, uPalette);
  fragColor = vec4(col * (0.7 + amp * 0.8 + line * 0.6), alpha);
}`,
  },

  {
    id: 'voice',
    name: 'Voice Bloom',
    element: true,
    params: [
      { key: 'size', label: 'Size', min: 0.05, max: 0.9, def: 0.32 },
      { key: 'rings', label: 'Formant rings', type: 'int', min: 0, max: 8, def: 3 },
      { key: 'softness', label: 'Softness', min: 0.02, max: 1, def: 0.45 },
      { key: 'gain', label: 'Sensitivity', min: 0.2, max: 4, def: 1.6 },
      { key: 'floorLevel', label: 'Resting glow', min: 0, max: 0.5, def: 0.06 },
      { key: 'spin', label: 'Spin', min: -2, max: 2, def: 0.15 },
      { key: 'tint', label: 'Colour', min: 0, max: 1, def: 0.1 },
    ],
    frag: `
// Swells with vocal-band presence: energy in the formant range that is
// harmonic rather than noisy and wobbles at syllable rate. A sung line moves it
// hard, a cymbal wash barely at all.
void main(){
  vec2 p = centred(vUv, uRes);
  float v = clamp(uVoice * u_gain, 0.0, 1.5);
  float amt = max(v, u_floorLevel);

  float r = length(p);
  float a = atan(p.y, p.x) + uTime * u_spin;
  float rad = u_size * (0.75 + amt * 0.6);

  float core = 1.0 - smoothstep(rad * (1.0 - u_softness), rad, r);
  float halo = exp(-max(r - rad, 0.0) / max(rad * u_softness, 0.02)) * 0.6;

  // Rings at the harmonic spacing a voice actually has, brightened by the bands
  // that are carrying it.
  float rings = 0.0;
  float n = max(u_rings, 0.0);
  for (int i = 1; i <= 8; i++) {
    if (float(i) > n) break;
    float fi = float(i);
    float rr = rad * (0.45 + fi * 0.22);
    float band = spectrum(clamp(0.12 + fi * 0.1, 0.0, 1.0));
    rings += (1.0 - smoothstep(0.0, 0.012, abs(r - rr))) * band * (1.0 / fi);
  }
  rings *= amt;

  // A gentle lobe so it is not a perfect circle sitting on the wall.
  float lobe = 0.88 + 0.12 * cos(a * 3.0);
  float alpha = clamp((core * 0.75 + halo + rings) * lobe * (0.35 + amt), 0.0, 1.0);
  vec3 col = palette(u_tint + amt * 0.25 + uCentroid * 0.15, uPalette);
  fragColor = vec4(col * (0.6 + amt * 0.9 + rings), alpha);
}`,
  },
];

export const ELEMENT_BY_ID = Object.fromEntries(ELEMENTS.map((e) => [e.id, e]));
