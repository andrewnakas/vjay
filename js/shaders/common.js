// Shared GLSL: the fragment header every pass gets, plus a small library of
// noise / colour / uv helpers. Everything downstream just prepends HEADER.

export const SPECTRUM_BINS = 64;
export const WAVE_SAMPLES = 64;

/** Uniforms fed from the audio feature bus every frame. */
export const FEATURE_UNIFORMS = `
uniform vec2  uRes;
uniform float uTime;
uniform float uBpm;
uniform float uBeatPhase;    // 0..1 sawtooth, one cycle per beat
uniform float uBarPhase;     // 0..1 over 4 beats
uniform float uPhrasePhase;  // 0..1 over 16 beats
uniform float uBeatPulse;    // decaying spike on each beat
uniform float uBass;
uniform float uLowMid;
uniform float uMid;
uniform float uHigh;
uniform float uAir;
uniform float uLevel;
uniform float uFlux;
uniform float uCentroid;
uniform float uKick;
uniform float uSnare;
uniform float uHat;
uniform float uVoice;        // vocal-band presence, 0..1 (not a speech classifier)
uniform float uSpectrum[${SPECTRUM_BINS}];
uniform float uWave[${WAVE_SAMPLES}];   // -1..1 time domain, downsampled
uniform float uPalette;      // active palette index
// Where the room's corner falls in the picture, 0..1 across. Set from the
// corner pair's seam, so a generator can put its vanishing edge exactly on the
// real crease instead of assuming the middle. 0.5 when there is no corner.
uniform float uSeam;
`;

export const LIB = `
#define PI  3.14159265359
#define TAU 6.28318530718

float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i + vec2(0,0)), hash12(i + vec2(1,0)), u.x),
             mix(hash12(i + vec2(0,1)), hash12(i + vec2(1,1)), u.x), u.y);
}

float fbm(vec2 p, int octaves){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    v += a * noise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}

mat2 rot2(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

// Inigo Quilez cosine palettes. Eight curated ramps, selected by index.
vec3 cosPalette(float t, vec3 a, vec3 b, vec3 c, vec3 d){
  return a + b * cos(TAU * (c * t + d));
}
vec3 palette(float t, float idx){
  int i = int(mod(floor(idx + 0.5), 8.0));
  if (i == 0) return cosPalette(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.00, 0.33, 0.67)); // rainbow
  if (i == 1) return cosPalette(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.00, 0.10, 0.20)); // amber-teal
  if (i == 2) return cosPalette(t, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.30, 0.20, 0.20)); // sunset
  if (i == 3) return cosPalette(t, vec3(0.5), vec3(0.5), vec3(1.0, 1.0, 0.5), vec3(0.80, 0.90, 0.30)); // acid
  if (i == 4) return cosPalette(t, vec3(0.5), vec3(0.5), vec3(1.0, 0.7, 0.4), vec3(0.00, 0.15, 0.20)); // ember
  if (i == 5) return cosPalette(t, vec3(0.2, 0.1, 0.4), vec3(0.6, 0.4, 0.6), vec3(1.0, 1.0, 1.0), vec3(0.00, 0.25, 0.25)); // ultraviolet
  if (i == 6) return cosPalette(t, vec3(0.0, 0.5, 0.5), vec3(0.0, 0.5, 0.5), vec3(0.0, 0.5, 0.3), vec3(0.00, 0.20, 0.50)); // cyan ice
  return vec3(smoothstep(0.0, 1.0, fract(t))); // mono
}

/** Aspect-corrected centred coords: y in -1..1, x scaled by aspect. */
vec2 centred(vec2 uv, vec2 res){
  vec2 p = uv * 2.0 - 1.0;
  p.x *= res.x / max(res.y, 1.0);
  return p;
}

/** Read the waveform with linear interpolation. t in 0..1, returns -1..1. */
float wave(float t){
  t = clamp(t, 0.0, 1.0) * float(${WAVE_SAMPLES} - 1);
  int i0 = int(floor(t));
  int i1 = min(i0 + 1, ${WAVE_SAMPLES} - 1);
  return mix(uWave[i0], uWave[i1], fract(t));
}

/**
 * Screen point with x measured from the room's corner rather than from the
 * middle of the picture, aspect-corrected. The crease is at x = 0.
 *
 * A 90-degree corner is the one piece of real 3D geometry in the room, and it
 * only reads as depth if the vanishing structure sits exactly on it. The seam
 * is rarely at the centre - it is wherever the two wall planes were split, by
 * their real widths - so anything perspective has to be built around this
 * rather than around the frame.
 */
vec2 cornerP(vec2 uv, vec2 res){
  float asp = res.x / max(res.y, 1.0);
  vec2 p = uv - 0.5;
  p.x = (p.x - (uSeam - 0.5)) * asp;
  return p;
}

/** Read the log-spaced spectrum with linear interpolation. t in 0..1. */
float spectrum(float t){
  t = clamp(t, 0.0, 1.0) * float(${SPECTRUM_BINS} - 1);
  int i0 = int(floor(t));
  int i1 = min(i0 + 1, ${SPECTRUM_BINS} - 1);
  return mix(uSpectrum[i0], uSpectrum[i1], fract(t));
}
`;

/**
 * Prepend to any fragment source. `extra` carries per-pass uniforms and helpers.
 *
 * LIB comes BEFORE extra so that helper functions declared in `extra` can use
 * the library (TAU, luma, palette, ...). The reverse order compiles fine until
 * the first helper that reaches for a constant, then breaks every shader at once.
 */
export function header(extra = '') {
  return `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 fragColor;
${FEATURE_UNIFORMS}
${LIB}
${extra}
`;
}
