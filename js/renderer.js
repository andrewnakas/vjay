// The render graph.
//
//   source -> deck pass (transform + colour)  ┐
//                                             ├─ mix (crossfader + blend) -> FX chain -> feedback -> screen
//   source -> deck pass (transform + colour)  ┘

import { Shader, FBO, PingPong, bindScreen } from './gl/context.js';
import { header, SPECTRUM_BINS } from './shaders/common.js';
import { EFFECTS, EFFECT_BY_ID, DEFAULT_CHAIN } from './shaders/effects.js';
import { params } from './params.js';
import { LAYER_PARAMS } from './layers.js';
import { IDENTITY_M3, GROUPS, EMPTY_BLACK, EMPTY_SKIP } from './mapping.js';

const LAYER_FRAG = `
uniform sampler2D uSrc;
uniform float uSrcAspect;
// Framing applied at the SOURCE, so every layer and every pinned copy of a
// camera shows the same crop. Zoom 1 is the whole sensor - as wide as the lens
// goes - and there is nothing wider, so the slider only ever crops in.
uniform float uSrcZoom, uSrcMirror, uSrcFlip;
uniform vec2 uSrcPan;
uniform float uHasSource;
uniform float u_opacity, u_x, u_y, u_scale, u_stretch, u_rotate, u_fit;
uniform float u_flipX, u_flipY, u_crop, u_feather, u_radius;
uniform float u_keyLow, u_keySoft;
uniform float u_matteMode, u_matteNear, u_matteFar, u_matteSoft, u_matteInvert;
uniform float u_hue, u_sat, u_bright, u_contrast;
uniform sampler2D uMatte;
uniform float uHasMatte;

/** Signed distance to a rounded rectangle centred on the origin. */
float roundRect(vec2 p, vec2 b, float r){
  r = min(r, min(b.x, b.y));
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

void main(){
  if (uHasSource < 0.5) { fragColor = vec4(0.0); return; }
  float outAspect = uRes.x / max(uRes.y, 1.0);

  // Screen point -> layer-local space. Position is in half-frame units so that
  // x = 1 moves the layer exactly one half-width, which is what the on-canvas
  // drag handles assume.
  vec2 p = vUv - 0.5 - vec2(u_x, u_y) * 0.5;
  p.x *= outAspect;
  p = rot2(-u_rotate) * p;
  p /= max(u_scale, 0.001) * vec2(max(u_stretch, 0.001), 1.0);

  // Layer box is half a frame tall in local units, aspect-corrected.
  vec2 halfBox = vec2(outAspect * 0.5, 0.5);
  float sd = roundRect(p, halfBox, u_radius * 0.5);
  float aa = 1.5 / uRes.y / max(u_scale, 0.001);
  float boxMask = smoothstep(aa, -aa, sd);
  if (u_feather > 0.0001) boxMask = smoothstep(u_feather, 0.0, sd);
  if (boxMask <= 0.0) { fragColor = vec4(0.0); return; }

  vec2 uv = vec2(p.x / outAspect, p.y) + 0.5;

  int fit = int(u_fit + 0.5);
  vec2 q = uv - 0.5;
  if (fit == 0) {                                   // cover
    if (uSrcAspect > outAspect) q.x *= outAspect / uSrcAspect;
    else q.y *= uSrcAspect / outAspect;
  } else if (fit == 1) {                            // contain
    if (uSrcAspect > outAspect) q.y *= uSrcAspect / outAspect;
    else q.x *= outAspect / uSrcAspect;
  }
  if (u_crop > 0.0) q *= (1.0 - u_crop * 2.0);
  if (u_flipX > 0.5) q.x = -q.x;
  if (u_flipY > 0.5) q.y = -q.y;
  if (uSrcMirror > 0.5) q.x = -q.x;
  if (uSrcFlip > 0.5) q.y = -q.y;
  q = q / max(uSrcZoom, 0.05) + uSrcPan * 0.5;
  vec2 suv = q + 0.5;

  float inside = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
  vec4 texel = texture(uSrc, clamp(suv, 0.0, 1.0));
  vec3 col = texel.rgb;
  float a = texel.a * inside * boxMask * u_opacity;

  // Luma key: drop the darkest part of the image, which is how you get a
  // camera or a generator to sit over a background without a black rectangle.
  if (u_keyLow > 0.0001) {
    a *= smoothstep(u_keyLow, u_keyLow + max(u_keySoft, 0.001), luma(col));
  }
  // Matte from a second source, sampled with the SAME transform so a depth
  // feed stays registered with the colour feed it is masking.
  int matteMode = int(u_matteMode + 0.5);
  if (uHasMatte > 0.5 && matteMode > 0) {
    float m = luma(texture(uMatte, clamp(suv, 0.0, 1.0)).rgb);
    float k;
    if (matteMode == 1) {
      // Depth window: keep what lies between near and far.
      float soft = max(u_matteSoft, 0.001);
      k = smoothstep(u_matteNear - soft, u_matteNear + soft, m)
        * (1.0 - smoothstep(u_matteFar - soft, u_matteFar + soft, m));
    } else {
      k = smoothstep(u_matteNear, u_matteNear + max(u_matteSoft, 0.001), m);
    }
    if (u_matteInvert > 0.5) k = 1.0 - k;
    a *= clamp(k, 0.0, 1.0);
  }
  if (a <= 0.0) { fragColor = vec4(0.0); return; }

  vec3 hsv = rgb2hsv(max(col, 0.0));
  hsv.x = fract(hsv.x + u_hue);
  hsv.y = clamp(hsv.y * u_sat, 0.0, 1.0);
  col = hsv2rgb(hsv);
  col = ((col - 0.5) * u_contrast + 0.5) * u_bright;

  fragColor = vec4(max(col, 0.0), clamp(a, 0.0, 1.0));
}`;

// Composites one layer onto the accumulator. Alpha decides coverage; the blend
// mode decides what the covered pixels become.
const COMPOSITE_FRAG = `
uniform sampler2D uDst;
uniform sampler2D uSrc;
uniform float uBlend, uKeyThresh, uKeySoft;

vec3 blendPair(vec3 d, vec3 s, int m){
  if (m == 1) return d + s;
  if (m == 2) return 1.0 - (1.0 - clamp(d, 0.0, 1.0)) * (1.0 - clamp(s, 0.0, 1.0));
  if (m == 3) return d * s;
  if (m == 4) return abs(d - s);
  if (m == 5) return max(d, s);
  if (m == 6) return min(d, s);
  if (m == 7) {
    vec3 lo = 2.0 * d * s;
    vec3 hi = 1.0 - 2.0 * (1.0 - d) * (1.0 - s);
    return mix(lo, hi, step(vec3(0.5), d));
  }
  return s;
}

void main(){
  vec4 dst = texture(uDst, vUv);
  vec4 src = texture(uSrc, vUv);
  int m = int(uBlend + 0.5);
  float a = src.a;
  if (m == 8) a *= smoothstep(uKeyThresh, uKeyThresh + max(uKeySoft, 0.001), luma(src.rgb));
  vec3 blended = blendPair(dst.rgb, src.rgb, m);
  fragColor = vec4(mix(dst.rgb, blended, a), max(dst.a, a));
}`;

const MIX_PARAMS = [
  { key: 'fade', label: 'Crossfader', min: 0, max: 1, def: 0.5 },
  { key: 'keyThresh', label: 'Luma key threshold', min: 0, max: 1, def: 0.25 },
  { key: 'keySoft', label: 'Luma key softness', min: 0.001, max: 0.5, def: 0.08 },
];

const MASTER_PARAMS = [
  { key: 'palette', label: 'Palette', type: 'enum', def: 0,
    options: ['Rainbow', 'Amber/Teal', 'Sunset', 'Acid', 'Ember', 'Ultraviolet', 'Cyan Ice', 'Mono'] },
  { key: 'brightness', label: 'Brightness', min: 0, max: 2, def: 1 },
  { key: 'gamma', label: 'Gamma', min: 0.3, max: 2.5, def: 1 },
  { key: 'saturation', label: 'Saturation', min: 0, max: 2, def: 1 },
  // For a dim projector. A mostly-dark image puts almost no light on the wall;
  // inverting it puts almost all of the lamp on the wall instead, and the lift
  // raises the black floor so nothing on screen is genuinely off. Both are
  // cheap ways to buy brightness that no amount of gain can.
  { key: 'invert', label: 'Invert', min: 0, max: 1, def: 0 },
  { key: 'lift', label: 'Black lift', min: 0, max: 0.6, def: 0 },
  { key: 'blackout', label: 'Blackout', type: 'bool', def: 0 },
  // Two macros for taming the whole rig at once.
  { key: 'reactivity', label: 'Reactivity', min: 0, max: 2, def: 0.75, modulatable: false },
  { key: 'motion', label: 'Motion speed', min: 0, max: 2, def: 0.7, modulatable: false },
];

// The output pass, run once per projection surface.
//
// `uHinv` takes a point on the projector back into the source frame, so the
// quad the user dragged onto a wall is filled by an inverse-warped read. That
// is what makes a keystone correction possible at all: a forward affine
// transform cannot turn a rectangle into a trapezium, and a wall seen at an
// angle is always a trapezium.
const OUT_FRAG = `
uniform sampler2D uTex;
uniform mat3 uHinv;
uniform vec4 uCrop;
uniform float uSoft, uBright, uGamma, uSat, uTest, uIndex;
uniform float uBlank, uSelected, uHot;
uniform vec3 uGain;
// Per-plane variation: the same comp, sampled and tinted so this plane reads as
// its own view of it rather than a copy.
uniform float uVHue, uVZoom, uVRot, uVAspect;
uniform vec2 uVPan, uVDrift, uVMirror;
// Preview only: zoom and pan the whole output so corners dragged off the
// projector are still visible and grabbable. (zoom, panX, panY); 1,0,0 is the
// real output, which is what the projector always gets.
uniform vec3 uView;
uniform float u_brightness, u_gamma, u_saturation, u_blackout;
uniform float u_invert, u_lift;
uniform float uInvert, uLift;

/** Alignment target: warps with the surface, so a bent grid means a bent quad. */
vec3 testPattern(vec2 s, float idx, float sel, float hot){
  vec3 tint = palette(idx * 0.137 + 0.08, 0.0) * (1.0 + 0.5 * sel);
  vec2 g = abs(fract(s * 10.0) - 0.5);
  float grid   = 1.0 - smoothstep(0.0, 0.015, min(g.x, g.y));
  float border = 1.0 - smoothstep(0.0, 0.010 + 0.014 * sel, min(min(s.x, 1.0 - s.x), min(s.y, 1.0 - s.y)));
  float diag   = 1.0 - smoothstep(0.0, 0.006, min(abs(s.x - s.y), abs(s.x + s.y - 1.0)));
  float ring   = 1.0 - smoothstep(0.0, 0.006, abs(length((s - 0.5) * vec2(1.0, 1.0)) - 0.25));
  // A bar of (index + 1) cells along the bottom edge names the surface.
  float row  = step(0.03, s.y) * step(s.y, 0.09);
  float blip = row * step(floor(s.x * 16.0), idx);
  vec3 col = tint * grid * 0.6;
  // Same orientation cue as the white panel: a bar along the top edge only.
  col = max(col, vec3(0.95, 0.8, 0.15) * step(0.94, s.y));
  col = max(col, vec3(0.95) * border);
  col = max(col, tint * diag * 0.9);
  col = max(col, tint * ring);
  col = max(col, tint * blip);
  // The corner being nudged pulses on the wall, so whoever is at the laptop
  // can see which one the arrow keys are moving without looking back.
  if (hot > -0.5) {
    vec2 hc = vec2(step(0.5, hot) * step(hot, 2.5), step(1.5, hot));
    float r = 0.07 + 0.02 * sin(uTime * 7.0);
    float disc = 1.0 - smoothstep(r * 0.7, r, length(s - hc));
    col = mix(col, vec3(1.0, 0.85, 0.25), disc);
  }
  return col;
}

/**
 * A flat white panel: the alignment target that actually works across a room.
 * Maximum light, one hard edge, and nothing inside it to mistake for the edge.
 */
vec3 whitePanel(vec2 s, float idx, float sel, float hot){
  float border = 1.0 - smoothstep(0.0, 0.006, min(min(s.x, 1.0 - s.x), min(s.y, 1.0 - s.y)));
  // Unselected panels sit a little back so the one being dragged is obvious,
  // but stay bright enough to align against.
  vec3 col = vec3(sel > 0.5 ? 1.0 : 0.82);
  // A dark rule just inside the edge sharpens where the panel actually stops.
  col *= 1.0 - border * 0.55;
  // Which way is UP. Without this a flat panel is perfectly symmetric, so a quad
  // whose corners were dragged into a flipped winding looks correct while
  // everything projected into it comes out upside down.
  float topBand = step(0.90, s.y);
  col = mix(col, vec3(0.05), topBand * 0.85);
  // A wedge that points up, drawn inside that band.
  float wx = abs(s.x - 0.5);
  float wedge = topBand * step(wx, (s.y - 0.90) * 1.6);
  col = mix(col, vec3(1.0, 0.85, 0.2), wedge);
  float row = step(0.02, s.y) * step(s.y, 0.06);
  col = mix(col, vec3(0.05), row * step(floor(s.x * 20.0), idx));
  if (hot > -0.5) {
    vec2 hc = vec2(step(0.5, hot) * step(hot, 2.5), step(1.5, hot));
    float r = 0.06 + 0.015 * sin(uTime * 7.0);
    col = mix(col, vec3(1.0, 0.3, 0.15), 1.0 - smoothstep(r * 0.7, r, length(s - hc)));
  }
  return col;
}

void main(){
  if (u_blackout > 0.5) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 view = (vUv - 0.5) / max(uView.x, 0.01) + 0.5 + uView.yz;
  vec3 q = uHinv * vec3(view, 1.0);
  // Normalized so w is positive inside the quad; behind the projective horizon
  // it goes negative and must be dropped, or a keystone grows a mirrored ghost.
  if (q.z <= 0.0) discard;
  vec2 s = q.xy / q.z;
  if (s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0) discard;
  // A cut-out: the plane's bus is empty and it wants the wall kept off it.
  if (uBlank > 0.5) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // Variation, in the plane's own 0..1 space and about its centre.
  vec2 t = s - 0.5;
  if (uVMirror.x > 0.5) t.x = -t.x;
  if (uVMirror.y > 0.5) t.y = -t.y;
  if (abs(uVRot) > 0.0001) {
    // Rotate in a square space, or a wide plane shears instead of turning.
    t.x *= uVAspect;
    t = rot2(uVRot) * t;
    t.x /= uVAspect;
  }
  t = t / max(uVZoom, 0.01) + 0.5 + uVPan + uVDrift * uTime;
  // Mirrored repeat: pushing past the edge of the comp folds back instead of
  // showing a hard seam or a clamped smear.
  //
  // This MUST be the identity on 0..1. The obvious-looking ping-pong,
  // abs(fract(t * 0.5) * 2.0 - 1.0), is NOT: it maps t to 1-t inside the first
  // period, so it silently inverted both axes and every source came out rotated
  // 180 degrees - invisible on a symmetric generator, glaring on a camera.
  t = 1.0 - abs(1.0 - mod(t, 2.0));

  vec3 col = texture(uTex, uCrop.xy + t * uCrop.zw).rgb;
  if (abs(uVHue) > 0.0001) {
    vec3 hsv = rgb2hsv(col);
    hsv.x = fract(hsv.x + uVHue);
    col = hsv2rgb(hsv);
  }
  if (uTest > 1.5) col = whitePanel(s, uIndex, uSelected, uHot);
  else if (uTest > 0.5) col = testPattern(s, uIndex, uSelected, uHot);

  // Invert before the tone controls so gamma and brightness shape the picture
  // that will actually be projected, not the one being thrown away.
  col = mix(col, vec3(1.0) - col, clamp(u_invert, 0.0, 1.0));
  col = mix(vec3(luma(col)), col, u_saturation);
  col = pow(max(col, 0.0), vec3(1.0 / max(u_gamma, 0.05))) * u_brightness;
  col = mix(col, vec3(1.0) - col, clamp(uInvert, 0.0, 1.0));
  col = mix(vec3(luma(col)), col, uSat);
  col = pow(max(col, 0.0), vec3(1.0 / max(uGamma, 0.05))) * uBright * uGain;
  // Lift last, and as a blend toward white rather than an add, so raising the
  // floor never clips the highlights that are already there.
  float lift = clamp(u_lift + uLift, 0.0, 1.0);
  col = col + lift * (vec3(1.0) - clamp(col, 0.0, 1.0));

  float edge = 1.0;
  if (uSoft > 0.0001) {
    edge = smoothstep(0.0, uSoft, min(min(s.x, 1.0 - s.x), min(s.y, 1.0 - s.y)));
  }
  fragColor = vec4(clamp(col, 0.0, 1.0) * edge, 1.0);
}`;

// Calibration patterns. These bypass the whole mapping stage and paint the raw
// output, because their entire purpose is to put a KNOWN image in projector
// space and find out where the camera sees it land.
// Prefixed because the shared header already declares the audio globals, and
// `uLevel` is one of them.
const CALIB_FRAG = `
uniform float uCalMode;    // 0 = flat fill, 1 = blob
uniform float uCalLevel;   // fill brightness
uniform vec2  uCalPoint;   // blob centre, projector uv
uniform float uCalRadius;
void main(){
  if (uCalMode < 0.5) { fragColor = vec4(vec3(uCalLevel), 1.0); return; }
  vec2 d = vUv - uCalPoint;
  d.x *= uRes.x / max(uRes.y, 1.0);
  float g = 1.0 - smoothstep(uCalRadius * 0.65, uCalRadius, length(d));
  fragColor = vec4(vec3(g), 1.0);
}`;

/**
 * Where a plane's picture sits inside the preview canvas: the largest box of
 * the crop's own pixel aspect, centred. Returns [x, y, w, h] in 0..1, y up.
 *
 * Exported because the pointer and the renderer must agree exactly - a preview
 * that letterboxes one way while the handles assume another is the bug this
 * whole view exists to remove.
 */
export function letterboxRect(crop, renderW, renderH, canvasW, canvasH) {
  const pxAspect = (crop[2] * renderW) / Math.max(crop[3] * renderH, 1e-6);
  const canvasAspect = canvasW / Math.max(canvasH, 1);
  let w = 1, h = 1;
  if (pxAspect > canvasAspect) h = canvasAspect / pxAspect; else w = pxAspect / canvasAspect;
  return [(1 - w) / 2, (1 - h) / 2, w, h];
}

const FLOW_RANGE = 0.2;   // max encodable displacement, uv per 1/60 s

const FLOW_PARAMS = [
  { key: 'aperture', label: 'Aperture', min: 1, max: 6, def: 2.5 },
  { key: 'smooth', label: 'Smoothing', min: 0, max: 0.95, def: 0.55 },
  { key: 'decay', label: 'Decay', min: 0.5, max: 1, def: 0.9 },
  { key: 'lambda', label: 'Stability', min: 0.0002, max: 0.05, def: 0.006 },
  { key: 'gain', label: 'Gain', min: 0.2, max: 4, def: 1 },
];

// Lucas-Kanade optical flow, one incremental step per frame.
//
// The previous frame is warped by the previous flow estimate before the
// temporal gradient is taken, so each frame refines the last rather than
// starting cold. That is what lets a single small window track motion larger
// than the window itself, without the cost of a real image pyramid.
//
// Flow is stored encoded into 0..1 so it survives an RGBA8 fallback, and is
// normalized to displacement-per-60th-of-a-second so effect amounts behave the
// same at 30 or 144 fps.
const FLOW_FRAG = `
uniform sampler2D uCur;
uniform sampler2D uPrevFrame;
uniform sampler2D uPrevFlow;
uniform vec2 uFlowTexel;
uniform float uAperture, uSmoothing, uDecay, uLambda;

float lum(sampler2D t, vec2 uv){ return luma(texture(t, clamp(uv, 0.0, 1.0)).rgb); }

void main(){
  vec2 uv = vUv;
  vec2 f0 = (texture(uPrevFlow, uv).xy - 0.5) * 0.2 * uDecay;

  float A11 = 0.0, A12 = 0.0, A22 = 0.0, b1 = 0.0, b2 = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 p = uv + vec2(float(i), float(j)) * uFlowTexel * uAperture;
      float ix = (lum(uCur, p + vec2(uFlowTexel.x, 0.0)) - lum(uCur, p - vec2(uFlowTexel.x, 0.0))) * 0.5;
      float iy = (lum(uCur, p + vec2(0.0, uFlowTexel.y)) - lum(uCur, p - vec2(0.0, uFlowTexel.y))) * 0.5;
      float it = lum(uCur, p) - lum(uPrevFrame, p - f0);
      A11 += ix * ix; A12 += ix * iy; A22 += iy * iy;
      b1  -= ix * it; b2  -= iy * it;
    }
  }
  float det = A11 * A22 - A12 * A12 + uLambda;
  vec2 delta = vec2(A22 * b1 - A12 * b2, A11 * b2 - A12 * b1) / det;
  // The gradients above are central differences over ONE TEXEL, so the solve
  // comes back in texels. Flow is stored in uv. Without this conversion every
  // correction overshoots by the texture width and the estimator oscillates
  // straight to its clamp, whatever the image is doing.
  delta *= uFlowTexel;
  vec2 flow = f0 + clamp(delta, -0.02, 0.02);
  flow = mix(flow, f0, uSmoothing);
  flow = clamp(flow, -0.2 * 0.5, 0.2 * 0.5);
  fragColor = vec4(flow / 0.2 + 0.5, 0.0, 1.0);
}`;

// 4x4 box downsample. A plain bilinear copy only averages 2x2 of the source,
// which aliases at a 4x reduction and makes the flow estimate noisy.
const DOWNSAMPLE_FRAG = `
uniform sampler2D uTex;
uniform vec2 uSrcTexel;
void main(){
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      vec2 o = (vec2(float(i), float(j)) - 1.5) * uSrcTexel;
      acc += texture(uTex, clamp(vUv + o, 0.0, 1.0)).rgb;
    }
  }
  fragColor = vec4(acc / 16.0, 1.0);
}`;

const COPY_FRAG = `
uniform sampler2D uTex;
void main(){ fragColor = vec4(texture(uTex, vUv).rgb, 1.0); }`;

// Exponential background estimate of the pre-FX image. Motion Echo differences
// against this, which is what makes only moving things light up.
const BG_FRAG = `
uniform sampler2D uTex;
uniform sampler2D uPrev;
uniform float uRate;
void main(){
  vec3 s = texture(uTex, vUv).rgb;
  vec3 p = texture(uPrev, vUv).rgb;
  fragColor = vec4(mix(p, s, clamp(uRate, 0.0, 1.0)), 1.0);
}`;

/** Wet/dry helper injected into every effect. */
const EFFECT_PRELUDE = `
uniform sampler2D uTex;
uniform sampler2D uFeedback;
uniform sampler2D uBackground;
uniform sampler2D uFlow;
uniform sampler2D uMatte;
uniform float uHasMatte;
uniform vec2 uTexel;
uniform float u_mix;

/** Per-pixel motion in uv units per 1/60 s, decoded from the flow buffer. */
uniform float uFlowGain;
vec2 flowAt(vec2 uv){ return (texture(uFlow, clamp(uv, 0.0, 1.0)).xy - 0.5) * 0.2 * uFlowGain; }
float flowMag(vec2 uv){ return length(flowAt(uv)); }
/** Direction as 0..1 hue, stable when the vector is near zero. */
float flowAngle(vec2 uv){ vec2 f = flowAt(uv); return atan(f.y, f.x) / TAU + 0.5; }

// Preserves the incoming alpha - layers composite by alpha, so an effect that
// stamped 1.0 here would turn every overlay into an opaque rectangle.
#define OUTPUT(c) { vec4 _src = texture(uTex, vUv); fragColor = vec4(mix(_src.rgb, (c), clamp(u_mix, 0.0, 1.0)), _src.a); }
`;

export class Renderer {
  constructor(gl, width, height) {
    this.gl = gl;
    this.width = width;
    this.height = height;

    params.define('mix', 'Mixer', MIX_PARAMS);
    params.define('master', 'Master', MASTER_PARAMS);
    params.define('flow', 'Optical flow', FLOW_PARAMS);

    this.layerShader = new Shader(gl, header('') + LAYER_FRAG, 'layer');
    this.compositeShader = new Shader(gl, header('') + COMPOSITE_FRAG, 'composite');
    this.outShader = new Shader(gl, header('') + OUT_FRAG, 'output');
    this.copyShader = new Shader(gl, header('') + COPY_FRAG, 'copy');
    this.bgShader = new Shader(gl, header('') + BG_FRAG, 'background');
    this.flowShader = new Shader(gl, header('') + FLOW_FRAG, 'flow');
    this.calibShader = new Shader(gl, header('') + CALIB_FRAG, 'calibration');
    this.calibration = null;   // set by the calibrator, cleared when it finishes
    this.downsampleShader = new Shader(gl, header('') + DOWNSAMPLE_FRAG, 'downsample');

    // One shared ping-pong for whichever layer is being processed, plus the
    // accumulator the layers composite into. Layers run sequentially, so they
    // can all reuse the same scratch buffers.
    this.layerPP = new PingPong(gl, width, height);
    this.comp = new PingPong(gl, width, height);
    this.pp = new PingPong(gl, width, height);
    // One composite per output group. Group 0 is the main one that the master
    // chain runs on; the rest are allocated the first time a surface asks for
    // one, so a set that never uses them costs no VRAM.
    this.groupComp = new Array(GROUPS.length).fill(null);
    this.groupComp[0] = this.comp;
    // Pinned feeds: bus -> { key, mode }. A pin is NOT performance state - it
    // is a thing you do live, on top of whatever the setlist is doing, and it
    // has to survive every cue change until you take it off again.
    this.pins = new Map();
    // Told when an effect's program will not build, so the UI can say which one
    // rather than leaving a silently dead slot in the chain.
    this.onEffectFailed = null;
    // Set while the Picture tool is up: the isolate view then shows the plane's
    // own pan/zoom/rotation rather than the flat comp behind it.
    this.planePreviewVaried = false;
    this.layerAux = new Map();   // layer id -> lazily allocated feedback/flow/bg

    this.masterAux = this._aux('master');

    // Effect programs compile on first enable - startup stays fast.
    this.effectShaders = new Map();
    this.chain = DEFAULT_CHAIN.filter((id) => EFFECT_BY_ID[id]);
    for (const def of EFFECTS) {
      params.define(`fx.${def.id}`, def.name, [
        { key: 'enabled', label: 'On', type: 'bool', def: 0 },
        { key: 'mix', label: 'Amount', min: 0, max: 1, def: 1 },
        ...def.params,
      ]);
    }
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.layerPP.resize(width, height);
    this.pp.resize(width, height);
    for (const c of this.groupComp) c?.resize(width, height);
    for (const aux of this.layerAux.values()) this._resizeAux(aux, width, height);
  }

  /** Per-source framing, for cameras. Everything else is left alone. */
  _setSourceFraming(s, source) {
    const g = source && source.kind === 'webcam' ? params.groups.get(source.key) : null;
    if (!g) {
      s.set('uSrcZoom', 1); s.set('uSrcPan', [0, 0]);
      s.set('uSrcMirror', 0); s.set('uSrcFlip', 0);
      return;
    }
    s.set('uSrcZoom', params.get(`${source.key}.zoom`));
    s.set('uSrcPan', [params.get(`${source.key}.panX`), params.get(`${source.key}.panY`)]);
    s.set('uSrcMirror', params.get(`${source.key}.mirror`) > 0.5 ? 1 : 0);
    s.set('uSrcFlip', params.get(`${source.key}.flip`) > 0.5 ? 1 : 0);
  }

  /** Layer uniforms for a pinned feed: defaults, full opacity, cover fit. */
  _pinUniforms() {
    if (!this._pinU) {
      this._pinU = {};
      for (const d of LAYER_PARAMS) this._pinU[`u_${d.key}`] = d.def ?? 0;
      this._pinU.u_opacity = 1;
      this._pinU.u_visible = 1;
      this._pinU.u_fit = 0;          // cover
      this._pinU.u_scale = 1;
    }
    return this._pinU;
  }

  /** Draw a pinned source into the layer buffer. Returns its texture, or null. */
  _renderPin(source, globals, opacity = 1) {
    if (!source || !source.texture || !source.ready) return null;
    const gl = this.gl;
    this.layerPP.write.bind();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const s = this.layerShader.use();
    s.setAll(globals);
    s.set('uRes', [this.width, this.height]);
    s.setAll(this._pinUniforms());
    s.set('u_opacity', opacity);
    s.set('uHasSource', 1);
    s.set('uSrcAspect', source.aspect || 1);
    this._setSourceFraming(s, source);
    s.set('uHasMatte', 0);
    s.tex('uSrc', source.texture);
    s.draw();
    this.layerPP.swap();
    return this.layerPP.read.texture;
  }

  /** The composite for an output group, allocated on first use. */
  _group(i) {
    let c = this.groupComp[i];
    if (!c) {
      c = new PingPong(this.gl, this.width, this.height);
      this.groupComp[i] = c;
    }
    return c;
  }

  /**
   * Aux buffers (feedback / background / optical flow) are per chain, and each
   * layer has its own chain. Allocating all of them up front for eight layers
   * would be a lot of VRAM for buffers most sets never touch, so they are
   * created the first time a layer actually enables an effect that needs one.
   */
  _aux(layerId) {
    let aux = this.layerAux.get(layerId);
    if (aux) return aux;
    const gl = this.gl;
    const fw = Math.max(2, Math.round(this.width / 4));
    const fh = Math.max(2, Math.round(this.height / 4));
    aux = {
      feedback: new FBO(gl, this.width, this.height),
      background: new PingPong(gl, this.width, this.height),
      flowFrames: new PingPong(gl, fw, fh),
      flow: new PingPong(gl, fw, fh),
      primed: false,
    };
    aux.feedback.clear(0, 0, 0, 0);
    aux.background.a.clear(0, 0, 0, 0);
    aux.background.b.clear(0, 0, 0, 0);
    aux.flowFrames.a.clear(0, 0, 0, 1);
    aux.flowFrames.b.clear(0, 0, 0, 1);
    aux.flow.a.clear(0.5, 0.5, 0, 1);
    aux.flow.b.clear(0.5, 0.5, 0, 1);
    this.layerAux.set(layerId, aux);
    return aux;
  }

  _resizeAux(aux, width, height) {
    aux.feedback.resize(width, height);
    aux.background.resize(width, height);
    const fw = Math.max(2, Math.round(width / 4));
    const fh = Math.max(2, Math.round(height / 4));
    aux.flowFrames.resize(fw, fh);
    aux.flow.resize(fw, fh);
    aux.primed = false;
  }

  disposeAux(layerId) {
    const aux = this.layerAux.get(layerId);
    if (!aux) return;
    aux.feedback.dispose();
    aux.background.dispose();
    aux.flowFrames.dispose();
    aux.flow.dispose();
    this.layerAux.delete(layerId);
  }

  /**
   * Effect programs compile on first enable, so startup stays fast - but a GLSL
   * error then surfaces mid-set, inside the render loop. Cache the FAILURE as
   * well as the success: without it `new Shader` throws again every single
   * frame, and since nothing downstream of the throw runs, the projector and
   * the recorder freeze on their last frame for good while the UI carries on
   * taking clicks. A broken effect must degrade to a bypassed effect.
   *
   * @returns the program, or null if it cannot be built.
   */
  _effectShader(id) {
    const s = this.effectShaders.get(id);
    if (s !== undefined) return s;      // null is a remembered failure
    const def = EFFECT_BY_ID[id];
    if (!def) return null;
    const decls = def.params.map((p) => `uniform float u_${p.key};`).join('\n');
    let built = null;
    try {
      built = new Shader(this.gl, header(EFFECT_PRELUDE + decls) + def.frag, `fx:${id}`);
    } catch (e) {
      console.error(`[vjay] effect "${id}" failed to compile; bypassing it`, e);
      this.onEffectFailed?.(id, e);
    }
    this.effectShaders.set(id, built);
    return built;
  }

  activeEffects() {
    return this.chain.filter((id) => params.get(`fx.${id}.enabled`) > 0.5);
  }

  moveEffect(id, delta) {
    const i = this.chain.indexOf(id);
    if (i < 0) return;
    const j = Math.max(0, Math.min(this.chain.length - 1, i + delta));
    this.chain.splice(i, 1);
    this.chain.splice(j, 0, id);
  }

  /**
   * Runs an ordered effect chain over `pp`, reading from pp.read and leaving the
   * result in pp.read. Shared by every layer chain and the master chain; `nsFor`
   * maps an effect id to its parameter namespace, which is the only thing that
   * differs between them.
   */
  _runChain(chain, nsFor, pp, aux, globals, dt, width, height, matte = null) {
    const gl = this.gl;
    const texel = [1 / width, 1 / height];

    const enabled = chain.filter((id) => params.get(`${nsFor(id)}.enabled`) > 0.5);
    if (!enabled.length) return;

    // Background estimate, for Motion Echo.
    if (enabled.some((id) => EFFECT_BY_ID[id]?.needsBackground)) {
      const echoNs = nsFor('motionEcho');
      const tau = Math.max(0.02, params.def(`${echoNs}.adapt`) ? params.get(`${echoNs}.adapt`) : 1.2);
      aux.background.write.bind();
      const bg = this.bgShader.use();
      bg.set('uRate', 1 - Math.exp(-dt / tau));
      bg.tex('uTex', pp.read.texture);
      bg.tex('uPrev', aux.background.read.texture);
      bg.draw();
      aux.background.swap();
    }

    // Optical flow.
    if (enabled.some((id) => EFFECT_BY_ID[id]?.needsFlow)) {
      const fw = aux.flow.read.width;
      const fh = aux.flow.read.height;
      const downsampleInto = (target) => {
        target.bind();
        const dn = this.downsampleShader.use();
        dn.set('uSrcTexel', [1 / width, 1 / height]);
        dn.tex('uTex', pp.read.texture);
        dn.draw();
      };
      downsampleInto(aux.flowFrames.write);
      if (!aux.primed) {
        aux.primed = true;
        downsampleInto(aux.flowFrames.read);
        aux.flow.a.clear(0.5, 0.5, 0, 1);
        aux.flow.b.clear(0.5, 0.5, 0, 1);
      }
      aux.flow.write.bind();
      const fl = this.flowShader.use();
      fl.set('uFlowTexel', [1 / fw, 1 / fh]);
      fl.set('uAperture', params.get('flow.aperture'));
      fl.set('uSmoothing', params.get('flow.smooth'));
      fl.set('uDecay', params.get('flow.decay'));
      fl.set('uLambda', params.get('flow.lambda'));
      fl.tex('uCur', aux.flowFrames.write.texture);
      fl.tex('uPrevFrame', aux.flowFrames.read.texture);
      fl.tex('uPrevFlow', aux.flow.read.texture);
      fl.draw();
      aux.flow.swap();
      aux.flowFrames.swap();
    } else {
      aux.primed = false;
    }

    for (const id of enabled) {
      const shader = this._effectShader(id);
      if (!shader) continue;
      pp.write.bind();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const sh = shader.use();
      sh.setAll(globals);
      sh.set('uRes', [width, height]);
      sh.set('uTexel', texel);
      sh.set('uFlowGain', params.get('flow.gain'));
      sh.setAll(params.uniforms(nsFor(id)));
      sh.tex('uTex', pp.read.texture);
      sh.tex('uFeedback', aux.feedback.texture);
      sh.tex('uBackground', aux.background.read.texture);
      sh.tex('uFlow', aux.flow.read.texture);
      sh.set('uHasMatte', matte && matte.texture && matte.ready ? 1 : 0);
      if (matte && matte.texture) sh.tex('uMatte', matte.texture);
      sh.draw();
      pp.swap();
    }

    // Stash this chain's result for its own feedback effects next frame.
    aux.feedback.bind();
    this.copyShader.use().tex('uTex', pp.read.texture).draw();
  }

  /** Renders one layer (transform + its own effect chain) into layerPP.read. */
  _renderLayer(layer, source, globals, dt, fade, matte) {
    const gl = this.gl;
    const opacity = layer.effectiveOpacity(fade);
    if (opacity <= 0.001) return null;
    // A camera or screen capture that has not been started renders transparent.
    // Letting it through marks its bus as "has content", so a plane showing that
    // bus paints a black rectangle instead of falling back to the main comp.
    if (source && !source.ready && (source.kind === 'webcam' || source.kind === 'screen')) return null;

    this.layerPP.write.bind();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const s = this.layerShader.use();
    s.setAll(globals);
    s.set('uRes', [this.width, this.height]);
    s.setAll(params.uniforms(layer.ns));
    s.set('u_opacity', opacity);
    s.set('uHasSource', source && source.texture && source.ready ? 1 : 0);
    s.set('uSrcAspect', source ? source.aspect : 1);
    this._setSourceFraming(s, source);
    s.set('uHasMatte', matte && matte.texture && matte.ready ? 1 : 0);
    if (source && source.texture) s.tex('uSrc', source.texture);
    if (matte && matte.texture) s.tex('uMatte', matte.texture);
    s.draw();
    this.layerPP.swap();

    if (layer.chain.length) {
      this._runChain(layer.chain, (id) => layer.fxNs(id), this.layerPP,
        this._aux(layer.id), globals, dt, this.width, this.height, matte);
    }
    return this.layerPP.read.texture;
  }

  /**
   * @param stack   LayerStack, bottom first
   * @param resolve (sourceKey) => source object
   * @param mapping Mapping, or null for a plain unmapped full frame
   */
  render(stack, resolve, globals, canvasW, canvasH, dt = 1 / 60, mapping = null) {
    const gl = this.gl;
    const fade = params.get('mix.fade');
    const needed = mapping ? mapping.neededGroups() : new Set([0]);

    for (const gi of needed) {
      const c = this._group(gi);
      c.write.bind();
      // Group 0 is the backdrop and is opaque; the others are overlays whose
      // uncovered area must stay empty rather than paint a black rectangle.
      gl.clearColor(0, 0, 0, gi === 0 ? 1 : 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      c.swap();
    }

    const drawn = new Set();
    for (const layer of stack.layers) {
      const gi = Math.round(params.get(`${layer.ns}.group`));
      // A layer whose group nothing is showing is not rendered at all - that is
      // what keeps a mapped set affordable when only some groups are on screen.
      if (!needed.has(gi)) continue;
      const tex = this._renderLayer(layer, resolve(layer.sourceKey), globals, dt, fade,
        layer.matteKey ? resolve(layer.matteKey) : null);
      if (!tex) continue;
      drawn.add(gi);
      const comp = this.groupComp[gi];
      comp.write.bind();
      const c = this.compositeShader.use();
      c.setAll(globals);
      c.set('uRes', [this.width, this.height]);
      c.set('uBlend', params.get(`${layer.ns}.blend`));
      c.set('uKeyThresh', params.get('mix.keyThresh'));
      c.set('uKeySoft', params.get('mix.keySoft'));
      c.tex('uDst', comp.read.texture);
      c.tex('uSrc', tex);
      c.draw();
      comp.swap();
    }

    // Pinned feeds land after the cue's layers, so a pin always wins.
    for (const [gi, pin] of this.pins) {
      if (!needed.has(gi) || !pin || !pin.key) continue;
      const src = resolve(pin.key);
      const tex = this._renderPin(src, globals, pin.opacity ?? 1);
      if (!tex) continue;
      const comp = this._group(gi);
      if (pin.mode === 'replace') {
        // Override the feed: nothing the setlist put here survives.
        comp.write.bind();
        gl.clearColor(0, 0, 0, gi === 0 ? 1 : 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        comp.swap();
      }
      comp.write.bind();
      const c = this.compositeShader.use();
      c.setAll(globals);
      c.set('uRes', [this.width, this.height]);
      c.set('uBlend', pin.blend ?? 0);
      c.set('uKeyThresh', params.get('mix.keyThresh'));
      c.set('uKeySoft', params.get('mix.keySoft'));
      c.tex('uDst', comp.read.texture);
      c.tex('uSrc', tex);
      c.draw();
      comp.swap();
      drawn.add(gi);
    }

    // Master chain runs on the main group only.
    this.pp.write.bind();
    this.copyShader.use().tex('uTex', this.comp.read.texture).draw();
    this.pp.swap();
    this._runChain(this.chain, (id) => `fx.${id}`, this.pp, this.masterAux,
      globals, dt, this.width, this.height);

    this._lastDrawn = drawn;
    this._drawOutput(mapping, canvasW, canvasH, globals, drawn);
    return this.pp.read.texture;
  }

  /** Source texture a surface reads: the master result for group 0, raw otherwise. */
  _groupTexture(gi) {
    if (gi === 0) return this.pp.read.texture;
    return (this.groupComp[gi] || this.comp).read.texture;
  }

  /**
   * One draw per surface, in index order, so a frame surface listed later sits
   * over the wall surface beneath it. Blending stays off: each surface discards
   * outside its own quad, which leaves whatever was drawn before intact.
   */
  _drawOutput(mapping, canvasW, canvasH, globals, drawn = null, view = null) {
    const gl = this.gl;
    bindScreen(gl, canvasW, canvasH);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Calibration owns the output while it runs - no mapping, no master colour,
    // or the pattern the camera sees is not the pattern we think we sent.
    const cal = this.calibration;
    if (cal) {
      const c = this.calibShader.use();
      c.set('uRes', [canvasW, canvasH]);
      c.set('uCalMode', cal.mode === 'blob' ? 1 : 0);
      c.set('uCalLevel', cal.level ?? 0);
      c.set('uCalPoint', cal.point || [0.5, 0.5]);
      c.set('uCalRadius', cal.radius ?? 0.09);
      c.draw();
      return;
    }

    const master = params.uniforms('master');
    const o = this.outShader.use();
    o.setAll(globals);
    o.set('uRes', [canvasW, canvasH]);
    o.setAll(master);
    o.set('uView', view ? [view.zoom, view.x, view.y] : [1, 0, 0]);

    const surfaces = mapping && !mapping.bypassed ? mapping.activeSurfaces() : [];
    if (!surfaces.length) {
      // Bypass, or nothing configured: a plain full frame. This is the panic
      // fallback, so it must not depend on any surface being sane.
      o.set('uHinv', IDENTITY_M3);
      o.set('uCrop', [0, 0, 1, 1]);
      o.set('uSoft', 0);
      o.set('uInvert', 0); o.set('uLift', 0);
      o.set('uBright', 1); o.set('uGamma', 1); o.set('uSat', 1);
      o.set('uGain', [1, 1, 1]);
      o.set('uTest', mapping ? mapping.testMode : 0);
      o.set('uIndex', 0);
      o.set('uBlank', 0); o.set('uSelected', 0); o.set('uHot', -1);
      this._setVariation(o, null);
      o.tex('uTex', this.pp.read.texture);
      o.draw();
      return;
    }

    const testMode = mapping.testMode;         // 0 off, 1 grid, 2 flat white
    const test = testMode > 0 ? 1 : 0;
    for (const i of surfaces) {
      const feed = mapping.feed(i);
      // A frame plane whose bus holds nothing would otherwise stamp a black
      // rectangle over the wall behind it. Empty means invisible - unless the
      // plane asked to be cut out (a painting the wall comp must stay off), and
      // except under the test pattern, where every plane has to be alignable
      // while empty.
      const empty = feed !== 0 && drawn && !drawn.has(feed);
      const mode = mapping.emptyMode(i);
      // An empty bus is the normal case, not a fault: there are eight planes
      // and eight layers, so most planes show the main comp, varied per plane.
      if (!test && empty && mode === EMPTY_SKIP) continue;
      const showMain = !test && empty && mode !== EMPTY_BLACK;
      const ns = mapping.ns(i);
      const sel = test && i === mapping.selected ? 1 : 0;
      o.set('uBlank', !test && empty && mode === EMPTY_BLACK ? 1 : 0);
      o.set('uSelected', sel);
      o.set('uHot', sel && mapping.editing ? mapping.lastCorner : -1);
      o.set('uHinv', mapping.homography(i));
      o.set('uCrop', [
        params.get(`${ns}.cropX`), params.get(`${ns}.cropY`),
        params.get(`${ns}.cropW`), params.get(`${ns}.cropH`),
      ]);
      o.set('uSoft', params.get(`${ns}.soft`));
      o.set('uInvert', params.get(`${ns}.invert`));
      o.set('uLift', params.get(`${ns}.lift`));
      o.set('uBright', params.get(`${ns}.bright`));
      o.set('uGamma', params.get(`${ns}.gamma`));
      o.set('uSat', params.get(`${ns}.sat`));
      o.set('uGain', [
        params.get(`${ns}.gainR`), params.get(`${ns}.gainG`), params.get(`${ns}.gainB`),
      ]);
      o.set('uTest', testMode);
      o.set('uIndex', i);
      this._setVariation(o, mapping, i);
      o.tex('uTex', this._groupTexture(showMain ? 0 : feed));
      o.draw();
    }
  }

  /**
   * Redraw the mapped output for the PREVIEW with a zoom applied, after the
   * projector has already been handed the real frame. Zooming out shows the
   * area beyond the projector, where a plane's corners can legitimately sit.
   */
  drawOutputZoomed(mapping, canvasW, canvasH, globals, view) {
    this._drawOutput(mapping, canvasW, canvasH, globals, this._lastDrawn, view);
  }

  /** Variation uniforms for one plane, or the identity when there is none. */
  _setVariation(o, mapping, i = 0) {
    if (!mapping) {
      o.set('uVHue', 0); o.set('uVZoom', 1); o.set('uVRot', 0); o.set('uVAspect', 1);
      o.set('uVPan', [0, 0]); o.set('uVDrift', [0, 0]); o.set('uVMirror', [0, 0]);
      return;
    }
    const v = mapping.variation(i);
    const crop = mapping.crop(i);
    o.set('uVHue', v.hue);
    o.set('uVZoom', v.zoom);
    o.set('uVRot', v.rot);
    o.set('uVAspect', (crop[2] * this.width) / Math.max(crop[3] * this.height, 1e-6));
    o.set('uVPan', v.pan);
    o.set('uVDrift', v.drift);
    o.set('uVMirror', v.mirror);
  }

  /**
   * The isolate view: one plane's bus, cropped as the plane crops it, drawn
   * flat and letterboxed into the canvas with the plane's own colour trim. This
   * is what "comp out a plane" looks at - the picture as it will sit on the
   * wall, not as it leaves the projector.
   *
   * @returns the rect the picture occupies, [x, y, w, h] in 0..1, y up.
   */
  drawPlanePreview(mapping, i, canvasW, canvasH, globals) {
    const gl = this.gl;
    bindScreen(gl, canvasW, canvasH);
    const bg = this.calibShader.use();
    bg.set('uRes', [canvasW, canvasH]);
    bg.set('uCalMode', 0);
    bg.set('uCalLevel', 0.09);
    bg.draw();

    const ns = mapping.ns(i);
    const crop = mapping.crop(i);
    const rect = letterboxRect(crop, this.width, this.height, canvasW, canvasH);
    const w = rect[2], h = rect[3];
    // Inverse of an axis-aligned rect is affine: canvas -> 0..1 inside the rect.
    const hinv = new Float32Array([
      1 / w, 0, 0,
      0, 1 / h, 0,
      -rect[0] / w, -rect[1] / h, 1,
    ]);

    const o = this.outShader.use();
    o.setAll(globals);
    o.set('uRes', [canvasW, canvasH]);
    o.setAll(params.uniforms('master'));
    o.set('uHinv', hinv);
    o.set('uCrop', crop);
    o.set('uSoft', params.get(`${ns}.soft`));
    o.set('uInvert', params.get(`${ns}.invert`));
    o.set('uLift', params.get(`${ns}.lift`));
    o.set('uBright', params.get(`${ns}.bright`));
    o.set('uGamma', params.get(`${ns}.gamma`));
    o.set('uSat', params.get(`${ns}.sat`));
    o.set('uGain', [params.get(`${ns}.gainR`), params.get(`${ns}.gainG`), params.get(`${ns}.gainB`)]);
    o.set('uTest', 0);
    o.set('uIndex', i);
    o.set('uBlank', 0); o.set('uSelected', 0); o.set('uHot', -1);
    o.set('uView', [1, 0, 0]);
    // Unvaried by default: this view is for dragging layers, and handles that do
    // not sit on the picture are the bug the view exists to remove. But when the
    // Picture tool is up there are no layer handles - the drag IS the variation
    // - so show what the wall will actually show.
    this._setVariation(o, this.planePreviewVaried ? mapping : null, i);
    // An empty bus falls back to the main comp here too, so comping a plane
    // that has no layers of its own shows what it will actually project.
    const feed = mapping.feed(i);
    const busEmpty = feed !== 0 && !this.groupComp[feed];
    o.tex('uTex', this._groupTexture(busEmpty ? 0 : feed));
    o.draw();
    return rect;
  }

  clearFeedback() {
    for (const aux of this.layerAux.values()) {
      aux.feedback.clear(0, 0, 0, 0);
      aux.background.a.clear(0, 0, 0, 0);
      aux.background.b.clear(0, 0, 0, 0);
      aux.flow.a.clear(0.5, 0.5, 0, 1);
      aux.flow.b.clear(0.5, 0.5, 0, 1);
      aux.primed = false;
    }
  }
}

export { SPECTRUM_BINS };
