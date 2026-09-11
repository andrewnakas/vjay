// Post-processing effects. Each gets uTex (chain input), uFeedback (last frame's
// final output), uTexel (1/resolution), and a u_mix wet/dry the chain adds for
// free. OUTPUT() does the wet/dry blend so every effect is safe at mix 0.

export const EFFECTS = [
  {
    id: 'trails',
    name: 'Trails / Feedback',
    params: [
      { key: 'decay', label: 'Persistence', min: 0, max: 0.99, def: 0.82 },
      { key: 'zoom', label: 'Zoom', min: 0.95, max: 1.05, def: 1.005 },
      { key: 'rotate', label: 'Rotate', min: -0.05, max: 0.05, def: 0.0012 },
      { key: 'drift', label: 'Drift', min: -0.05, max: 0.05, def: 0.0 },
      { key: 'tint', label: 'Tint shift', min: 0, max: 1, def: 0.12 },
    ],
    frag: `
void main(){
  vec3 src = texture(uTex, vUv).rgb;
  vec2 c = vUv - 0.5;
  c *= rot2(u_rotate);
  c /= max(u_zoom, 0.001);
  c += vec2(u_drift, u_drift * 0.6);
  vec3 fb = texture(uFeedback, c + 0.5).rgb * u_decay;
  // Rotate the feedback hue slightly each pass so trails smear through colour.
  vec3 hsv = rgb2hsv(fb);
  hsv.x = fract(hsv.x + u_tint * 0.03 * (0.4 + uCentroid));
  fb = hsv2rgb(hsv);
  vec3 col = max(src, fb * 0.998) + src * 0.15;
  OUTPUT(col);
}`,
  },

  {
    id: 'colorize',
    name: 'Colour',
    params: [
      { key: 'hue', label: 'Hue shift', min: -1, max: 1, def: 0 },
      { key: 'cycle', label: 'Hue cycle', min: 0, max: 2, def: 0 },
      { key: 'sat', label: 'Saturation', min: 0, max: 3, def: 1 },
      { key: 'bright', label: 'Brightness', min: 0, max: 3, def: 1 },
      { key: 'contrast', label: 'Contrast', min: 0, max: 3, def: 1 },
      { key: 'gamma', label: 'Gamma', min: 0.3, max: 3, def: 1 },
    ],
    frag: `
void main(){
  vec3 col = texture(uTex, vUv).rgb;
  vec3 hsv = rgb2hsv(max(col, 0.0));
  hsv.x = fract(hsv.x + u_hue + uTime * u_cycle * 0.08 + uBeatPhase * u_cycle * 0.05);
  hsv.y = clamp(hsv.y * u_sat, 0.0, 1.0);
  col = hsv2rgb(hsv);
  col = (col - 0.5) * u_contrast + 0.5;
  col = pow(max(col, 0.0), vec3(1.0 / max(u_gamma, 0.05))) * u_bright;
  OUTPUT(col);
}`,
  },

  {
    id: 'paletteMap',
    name: 'Palette Map',
    params: [
      { key: 'offset', label: 'Offset', min: 0, max: 1, def: 0 },
      { key: 'spread', label: 'Spread', min: 0.1, max: 4, def: 1 },
      { key: 'preserve', label: 'Keep detail', min: 0, max: 1, def: 0.25 },
      { key: 'drive', label: 'Audio drive', min: 0, max: 1, def: 0.3 },
    ],
    frag: `
void main(){
  vec3 src = texture(uTex, vUv).rgb;
  float l = luma(src);
  float t = l * u_spread + u_offset + uCentroid * u_drive + uBeatPhase * u_drive * 0.2;
  vec3 col = palette(t, uPalette) * (0.25 + l * 1.2);
  col = mix(col, col * (0.5 + src * 1.5), u_preserve);
  OUTPUT(col);
}`,
  },

  {
    id: 'rgbShift',
    name: 'RGB Shift',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 0.12, def: 0.006 },
      { key: 'angle', label: 'Angle', min: 0, max: 6.283, def: 0 },
      { key: 'spin', label: 'Spin', min: 0, max: 1.5, def: 0 },
      { key: 'radial', label: 'Radial', min: 0, max: 1, def: 0.5 },
    ],
    frag: `
void main(){
  vec2 dir = vec2(cos(u_angle + uTime * u_spin), sin(u_angle + uTime * u_spin));
  vec2 rad = normalize(vUv - 0.5 + 1e-5) * length(vUv - 0.5) * 2.0;
  vec2 d = mix(dir, rad, u_radial) * u_amount;
  vec3 col;
  col.r = texture(uTex, vUv + d).r;
  col.g = texture(uTex, vUv).g;
  col.b = texture(uTex, vUv - d).b;
  OUTPUT(col);
}`,
  },

  {
    id: 'kaleido',
    name: 'Kaleidoscope',
    params: [
      { key: 'segments', label: 'Segments', min: 1, max: 24, def: 6 },
      { key: 'spin', label: 'Spin', min: -1, max: 1, def: 0.025 },
      { key: 'zoom', label: 'Zoom', min: 0.2, max: 3, def: 1 },
      { key: 'offset', label: 'Centre', min: -0.5, max: 0.5, def: 0 },
    ],
    frag: `
void main(){
  vec2 p = (vUv - 0.5 - vec2(u_offset, 0.0));
  p.x *= uRes.x / uRes.y;
  float a = atan(p.y, p.x) + uTime * u_spin;
  float r = length(p) / max(u_zoom, 0.05);
  float seg = TAU / max(u_segments, 1.0);
  a = abs(mod(a, seg) - seg * 0.5);
  vec2 q = vec2(cos(a), sin(a)) * r;
  q.x /= uRes.x / uRes.y;
  vec3 col = texture(uTex, clamp(q + 0.5, 0.001, 0.999)).rgb;
  OUTPUT(col);
}`,
  },

  {
    id: 'mirror',
    name: 'Mirror / Tile',
    params: [
      { key: 'tiles', label: 'Tiles', min: 1, max: 8, def: 2 },
      { key: 'mode', label: 'Axis', type: 'enum', options: ['X', 'Y', 'Both', 'Quad'], def: 2 },
      { key: 'scroll', label: 'Scroll', min: -1, max: 1, def: 0 },
    ],
    frag: `
void main(){
  vec2 uv = vUv;
  uv += vec2(uTime * u_scroll * 0.1, 0.0);
  float n = max(u_tiles, 1.0);
  vec2 t = fract(uv * n);
  vec2 m = abs(t * 2.0 - 1.0);
  int mode = int(u_mode + 0.5);
  vec2 q = uv;
  if (mode == 0) q = vec2(m.x, fract(uv.y * n));
  else if (mode == 1) q = vec2(fract(uv.x * n), m.y);
  else if (mode == 2) q = m;
  else q = vec2(abs(uv.x * 2.0 - 1.0), abs(uv.y * 2.0 - 1.0));
  vec3 col = texture(uTex, clamp(q, 0.001, 0.999)).rgb;
  OUTPUT(col);
}`,
  },

  {
    id: 'displace',
    name: 'Warp',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 0.3, def: 0.02 },
      { key: 'scale', label: 'Scale', min: 0.5, max: 20, def: 4 },
      { key: 'speed', label: 'Speed', min: 0, max: 3, def: 0.5 },
      { key: 'selfWarp', label: 'Self warp', min: 0, max: 1, def: 0 },
    ],
    frag: `
void main(){
  vec2 p = vUv * u_scale;
  float t = uTime * u_speed;
  vec2 n = vec2(fbm(p + t, 4), fbm(p + vec2(13.7, 5.1) - t, 4)) - 0.5;
  vec3 s = texture(uTex, vUv).rgb;
  vec2 self = (vec2(luma(s), s.r - s.b)) * u_selfWarp;
  vec2 d = (n + self) * u_amount * (0.4 + uLevel * 1.6 + uBeatPulse * 0.5);
  vec3 col = texture(uTex, clamp(vUv + d, 0.0, 1.0)).rgb;
  OUTPUT(col);
}`,
  },

  {
    id: 'glitch',
    name: 'Slice Glitch',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 1, def: 0.3 },
      { key: 'slices', label: 'Slices', min: 2, max: 80, def: 22 },
      { key: 'rate', label: 'Rate', min: 0.5, max: 20, def: 6 },
      { key: 'blocks', label: 'Block size', min: 0, max: 1, def: 0.3 },
      { key: 'trigger', label: 'On transients', min: 0, max: 1, def: 0.7 },
    ],
    frag: `
void main(){
  float gate = mix(1.0, clamp(uSnare + uKick * 0.6 + uFlux * 0.5, 0.0, 1.0), u_trigger);
  float amt = u_amount * gate;
  float t = floor(uTime * u_rate);
  vec2 uv = vUv;
  float row = floor(vUv.y * max(u_slices, 2.0));
  float r = hash12(vec2(row, t));
  if (r > 1.0 - amt * 0.6) uv.x = fract(uv.x + (hash12(vec2(row, t + 7.0)) - 0.5) * amt);
  if (u_blocks > 0.0) {
    vec2 bs = vec2(max(u_blocks * 0.12, 0.002));
    vec2 blk = floor(vUv / bs);
    float br = hash12(blk + t * 3.1);
    if (br > 1.0 - amt * 0.35) uv += (hash22(blk + t) - 0.5) * amt * 0.15;
  }
  vec3 col = texture(uTex, clamp(uv, 0.0, 1.0)).rgb;
  // Channel tear on the hardest hits.
  if (hash12(vec2(row, t + 3.0)) > 1.0 - amt * 0.3) {
    col.r = texture(uTex, clamp(uv + vec2(0.02 * amt, 0.0), 0.0, 1.0)).r;
    col.b = texture(uTex, clamp(uv - vec2(0.02 * amt, 0.0), 0.0, 1.0)).b;
  }
  OUTPUT(col);
}`,
  },


  {
    id: 'motionEcho',
    name: 'Motion Echo',
    needsBackground: true,
    params: [
      { key: 'adapt', label: 'Background adapt', min: 0.05, max: 6, def: 1.2, unit: 's' },
      { key: 'threshold', label: 'Threshold', min: 0.01, max: 0.6, def: 0.09 },
      { key: 'gain', label: 'Gain', min: 0.2, max: 6, def: 2.2 },
      { key: 'keep', label: 'Keep source', min: 0, max: 1, def: 0.22 },
      { key: 'colour', label: 'Colourize', min: 0, max: 1, def: 0.85 },
    ],
    frag: `
// Differences the live image against a slowly-adapting background, so only what
// MOVES lights up. On a webcam this paints you in light and drops the room away.
void main(){
  vec3 src = texture(uTex, vUv).rgb;
  vec3 bg  = texture(uBackground, vUv).rgb;
  float d = length(src - bg);
  float m = clamp(smoothstep(u_threshold, u_threshold + 0.22, d) * u_gain, 0.0, 3.0);
  vec3 glow = mix(vec3(m), palette(m * 0.5 + uTime * 0.04 + uCentroid * 0.35, uPalette) * m, u_colour);
  vec3 col = src * u_keep + glow * (0.75 + uLevel * 0.6 + uBeatPulse * 0.4);
  OUTPUT(col);
}`,
  },

  {
    id: 'timeSmear',
    name: 'Time Smear',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 1, def: 0.7 },
      { key: 'bands', label: 'Strips', min: 2, max: 120, def: 26 },
      { key: 'axis', label: 'Axis', type: 'enum', options: ['Rows', 'Columns', 'Radial'], def: 0 },
      { key: 'scatter', label: 'Scatter', min: 0, max: 1, def: 0.7 },
      { key: 'warp', label: 'Luma warp', min: -0.6, max: 0.6, def: 0 },
    ],
    frag: `
// Slit-scan: every strip holds onto the previous frame for a different length of
// time, so the image smears through time instead of space.
void main(){
  vec3 src = texture(uTex, vUv).rgb;
  vec3 fb  = texture(uFeedback, vUv).rgb;
  int axis = int(u_axis + 0.5);
  float t = axis == 0 ? vUv.y : axis == 1 ? vUv.x : length(vUv - 0.5) * 1.6;
  float n = max(u_bands, 2.0);
  float strip = floor(t * n);
  float jitter = mix(strip / n, hash11(strip * 1.37), u_scatter);
  float hold = u_amount * (0.25 + 0.74 * jitter);
  hold = clamp(hold + (luma(src) - 0.5) * u_warp, 0.0, 0.985);
  vec3 col = mix(src, fb, hold);
  OUTPUT(col);
}`,
  },

  {
    id: 'mirrorBloom',
    name: 'Camera Halo',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 3, def: 1.1 },
      { key: 'threshold', label: 'Threshold', min: 0, max: 1, def: 0.35 },
      { key: 'spread', label: 'Spread', min: 1, max: 24, def: 8 },
      { key: 'chroma', label: 'Chroma split', min: 0, max: 1, def: 0.5 },
    ],
    frag: `
// A wide, soft, colour-split halo. Reads as a glow around a person rather than
// the tight highlight bloom you want on generated content.
void main(){
  vec3 src = texture(uTex, vUv).rgb;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 24; i++) {
    float fi = float(i);
    float a = fi * 2.39996;
    float r = sqrt(fi / 24.0) * u_spread;
    vec2 o = vec2(cos(a), sin(a)) * r * uTexel * 6.0;
    vec3 s = max(texture(uTex, clamp(vUv + o * (1.0 + u_chroma * 0.35), 0.0, 1.0)).rgb - u_threshold, 0.0);
    vec3 s2 = max(texture(uTex, clamp(vUv + o * (1.0 - u_chroma * 0.35), 0.0, 1.0)).rgb - u_threshold, 0.0);
    sum += vec3(s.r, mix(s.g, s2.g, 0.5), s2.b) * (1.0 - sqrt(fi / 24.0) * 0.8);
  }
  vec3 col = src + sum / 24.0 * u_amount * (0.7 + uLevel * 0.8);
  OUTPUT(col);
}`,
  },


  {
    id: 'specWarp',
    name: 'Spectrum Warp',
    params: [
      { key: 'amount', label: 'Displace', min: 0, max: 0.4, def: 0.07 },
      { key: 'axis', label: 'Axis', type: 'enum', options: ['Rows', 'Columns', 'Radial'], def: 0 },
      { key: 'mirror', label: 'Mirror', type: 'bool', def: 1 },
      { key: 'range', label: 'Freq range', min: 0.15, max: 1, def: 0.7 },
      { key: 'offset', label: 'Freq offset', min: 0, max: 0.8, def: 0 },
      { key: 'sharpen', label: 'Sharpen', min: 0.4, max: 4, def: 1.4 },
      { key: 'glow', label: 'Band tint', min: 0, max: 2, def: 0.45 },
      { key: 'lines', label: 'Line emphasis', min: 0, max: 1, def: 0.35 },
      { key: 'lineCount', label: 'Line count', min: 8, max: 400, def: 90 },
    ],
    frag: `
// Maps the frequency spectrum across the frame and lets each band push the
// image around and tint it. On a webcam every horizontal line of you moves with
// its own frequency band, so bass shoves the middle while hats shimmer the edges.
void main(){
  int axis = int(u_axis + 0.5);
  float t = axis == 0 ? vUv.y : axis == 1 ? vUv.x : clamp(length(vUv - 0.5) * 1.6, 0.0, 1.0);

  // Mirrored puts bass at the centre and treble at both edges, which reads far
  // better on a centred subject than a single low-to-high sweep.
  float ft = u_mirror > 0.5 ? abs(t * 2.0 - 1.0) : t;
  ft = clamp(ft * u_range + u_offset, 0.0, 1.0);

  float amp = pow(clamp(spectrum(ft), 0.0, 1.0), u_sharpen);

  vec2 dir = axis == 0 ? vec2(1.0, 0.0)
           : axis == 1 ? vec2(0.0, 1.0)
                       : normalize(vUv - 0.5 + 1e-5);
  // Centre the push so quiet bands sit still instead of drifting off to one side.
  vec2 uv = vUv + dir * (amp - 0.35) * u_amount;
  vec3 col = texture(uTex, clamp(uv, 0.0, 1.0)).rgb;

  vec3 bandCol = palette(ft * 0.85 + uTime * 0.03, uPalette);
  col += bandCol * amp * u_glow;

  // Thin bright rules along the axis, brightness set by that band's energy.
  float line = pow(abs(sin(t * max(u_lineCount, 1.0) * PI)), 24.0);
  col += bandCol * line * amp * u_lines * 2.0;

  OUTPUT(col);
}`,
  },


  {
    id: 'flowSmear',
    name: 'Flow Smear',
    needsFlow: true,
    params: [
      { key: 'length', label: 'Smear length', min: 0, max: 14, def: 4 },
      { key: 'taps', label: 'Quality', type: 'int', min: 4, max: 16, def: 10 },
      { key: 'tail', label: 'Tail falloff', min: 0, max: 1, def: 0.55 },
      { key: 'chroma', label: 'Chroma trail', min: 0, max: 1, def: 0.3 },
      { key: 'gate', label: 'Motion gate', min: 0, max: 0.06, def: 0.004 },
    ],
    frag: `
// True directional motion blur: each pixel is smeared back along the direction
// that part of the IMAGE is actually moving, so still areas stay sharp. This is
// the difference between a filter and an overlay.
void main(){
  vec2 f = flowAt(vUv);
  float mag = length(f);
  if (mag < u_gate) { OUTPUT(texture(uTex, vUv).rgb); return; }

  vec2 step = f * u_length;
  int n = int(u_taps);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= n) break;
    float t = float(i) / float(n - 1);
    // Trailing chroma: colour channels lag by different amounts along the path.
    vec2 uvT = clamp(vUv - step * t, 0.0, 1.0);
    vec3 s;
    if (u_chroma > 0.001) {
      s.r = texture(uTex, clamp(vUv - step * t * (1.0 + u_chroma * 0.4), 0.0, 1.0)).r;
      s.g = texture(uTex, uvT).g;
      s.b = texture(uTex, clamp(vUv - step * t * (1.0 - u_chroma * 0.4), 0.0, 1.0)).b;
    } else {
      s = texture(uTex, uvT).rgb;
    }
    float w = 1.0 - t * u_tail;
    acc += s * w;
    wsum += w;
  }
  OUTPUT(acc / max(wsum, 1e-4));
}`,
  },

  {
    id: 'flowTrails',
    name: 'Flow Trails',
    needsFlow: true,
    params: [
      { key: 'decay', label: 'Persistence', min: 0.5, max: 0.995, def: 0.9 },
      { key: 'advect', label: 'Advection', min: -8, max: 8, def: 3 },
      { key: 'spread', label: 'Spread', min: 0, max: 3, def: 0.6 },
      { key: 'tint', label: 'Direction tint', min: 0, max: 1, def: 0.3 },
      { key: 'gate', label: 'Motion gate', min: 0, max: 0.06, def: 0.003 },
    ],
    frag: `
// Feedback that is dragged along by the motion in the image instead of by a
// fixed zoom. Trails stick to the moving subject and stretch the way it moves.
void main(){
  vec3 src = texture(uTex, vUv).rgb;
  vec2 f = flowAt(vUv);
  vec2 back = vUv - f * u_advect;
  vec3 fb = texture(uFeedback, clamp(back, 0.0, 1.0)).rgb;

  if (u_spread > 0.001) {
    vec2 perp = vec2(-f.y, f.x) * u_spread;
    fb += texture(uFeedback, clamp(back + perp, 0.0, 1.0)).rgb * 0.35;
    fb += texture(uFeedback, clamp(back - perp, 0.0, 1.0)).rgb * 0.35;
    fb /= 1.7;
  }
  fb *= u_decay;

  if (u_tint > 0.001 && length(f) > u_gate) {
    fb = mix(fb, palette(flowAngle(vUv) + uTime * 0.02, uPalette) * luma(fb) * 1.6, u_tint);
  }
  OUTPUT(max(src, fb));
}`,
  },

  {
    id: 'flowPaint',
    name: 'Flow Ink',
    needsFlow: true,
    params: [
      { key: 'inject', label: 'Ink', min: 0, max: 2, def: 0.7 },
      { key: 'threshold', label: 'Threshold', min: 0, max: 0.05, def: 0.004 },
      { key: 'advect', label: 'Advection', min: 0, max: 10, def: 4 },
      { key: 'decay', label: 'Persistence', min: 0.5, max: 0.995, def: 0.955 },
      { key: 'keep', label: 'Keep source', min: 0, max: 1, def: 0.12 },
      { key: 'hueByDir', label: 'Hue = direction', min: 0, max: 1, def: 0.85 },
    ],
    frag: `
// Ink dropped wherever the image moves, then carried along by the flow field.
// Colour comes from the direction of travel, so a gesture paints a stroke.
void main(){
  vec3 src = texture(uTex, vUv).rgb;
  vec2 f = flowAt(vUv);
  float mag = length(f);

  vec3 prev = texture(uFeedback, clamp(vUv - f * u_advect, 0.0, 1.0)).rgb * u_decay;

  float amount = smoothstep(u_threshold, u_threshold * 3.0 + 0.006, mag);
  vec3 dirCol = palette(flowAngle(vUv) + uTime * 0.02, uPalette);
  vec3 lumaCol = palette(luma(src) + uCentroid * 0.3, uPalette);
  vec3 ink = mix(lumaCol, dirCol, u_hueByDir) * amount * u_inject * (0.6 + uLevel * 0.8);

  OUTPUT(prev + ink + src * u_keep);
}`,
  },

  {
    id: 'flowDisplace',
    name: 'Flow Displace',
    needsFlow: true,
    params: [
      { key: 'amount', label: 'Amount', min: -20, max: 20, def: 6 },
      { key: 'chroma', label: 'Chroma split', min: 0, max: 1, def: 0.35 },
      { key: 'swirl', label: 'Swirl', min: -2, max: 2, def: 0 },
      { key: 'view', label: 'Show flow field', min: 0, max: 1, def: 0 },
    ],
    frag: `
// Exaggerates or reverses the motion already in the image. Negative amounts
// push against the movement, which reads as the picture resisting you.
// "Show flow field" paints direction as hue and speed as brightness - use it to
// check the flow is tracking before dialling in the other flow effects.
void main(){
  vec2 f = flowAt(vUv);
  vec2 swirled = mix(f, vec2(-f.y, f.x), clamp(u_swirl * 0.5 + 0.5, 0.0, 1.0) * abs(u_swirl));
  vec2 d = swirled * u_amount;
  vec3 col;
  col.r = texture(uTex, clamp(vUv + d * (1.0 + u_chroma * 0.35), 0.0, 1.0)).r;
  col.g = texture(uTex, clamp(vUv + d, 0.0, 1.0)).g;
  col.b = texture(uTex, clamp(vUv + d * (1.0 - u_chroma * 0.35), 0.0, 1.0)).b;

  if (u_view > 0.001) {
    vec3 viz = hsv2rgb(vec3(flowAngle(vUv), 0.9, clamp(length(f) * 60.0, 0.0, 1.0)));
    col = mix(col, viz, u_view);
  }
  OUTPUT(col);
}`,
  },


  {
    id: 'depthWarp',
    name: 'Depth Warp',
    params: [
      { key: 'amount', label: 'Displace', min: -0.5, max: 0.5, def: 0.1 },
      { key: 'mode', label: 'Direction', type: 'enum', options: ['Radial', 'Horizontal', 'Vertical', 'Gradient'], def: 0 },
      { key: 'near', label: 'Near', min: 0, max: 1, def: 0 },
      { key: 'far', label: 'Far', min: 0, max: 1, def: 1 },
      { key: 'audio', label: 'Audio drive', min: 0, max: 2, def: 0.5 },
      { key: 'fog', label: 'Depth fog', min: 0, max: 1, def: 0 },
    ],
    frag: `
// Pushes pixels around by the layer's matte. Fed a Kinect depth stream this
// bends the image by real distance - your hand reaching forward drags the
// picture with it. Falls through untouched when no matte is assigned.
void main(){
  if (uHasMatte < 0.5) { OUTPUT(texture(uTex, vUv).rgb); return; }
  float d = luma(texture(uMatte, vUv).rgb);
  // Remap the useful slice of the range to 0..1 before doing anything with it.
  float t = clamp((d - u_near) / max(u_far - u_near, 0.001), 0.0, 1.0);
  float amp = u_amount * (1.0 + (uLevel + uBeatPulse) * u_audio);

  vec2 dir;
  int mode = int(u_mode + 0.5);
  if (mode == 0)      dir = normalize(vUv - 0.5 + 1e-5) * length(vUv - 0.5) * 2.0;
  else if (mode == 1) dir = vec2(1.0, 0.0);
  else if (mode == 2) dir = vec2(0.0, 1.0);
  else {
    // Gradient of the depth field - displaces along surface slope.
    float dx = luma(texture(uMatte, vUv + vec2(uTexel.x, 0.0)).rgb)
             - luma(texture(uMatte, vUv - vec2(uTexel.x, 0.0)).rgb);
    float dy = luma(texture(uMatte, vUv + vec2(0.0, uTexel.y)).rgb)
             - luma(texture(uMatte, vUv - vec2(0.0, uTexel.y)).rgb);
    dir = vec2(dx, dy) * 40.0;
  }

  vec3 col = texture(uTex, clamp(vUv + dir * (t - 0.5) * amp, 0.0, 1.0)).rgb;
  if (u_fog > 0.0) col = mix(col, palette(t + uTime * 0.02, uPalette) * (1.0 - t), u_fog * t);
  OUTPUT(col);
}`,
  },

  {
    id: 'depthSlice',
    name: 'Depth Slice',
    params: [
      { key: 'slices', label: 'Slices', type: 'int', min: 2, max: 24, def: 7 },
      { key: 'near', label: 'Near', min: 0, max: 1, def: 0 },
      { key: 'far', label: 'Far', min: 0, max: 1, def: 1 },
      { key: 'offset', label: 'Slice offset', min: -0.3, max: 0.3, def: 0.04 },
      { key: 'tint', label: 'Colour by depth', min: 0, max: 1, def: 0.7 },
      { key: 'edges', label: 'Edge lines', min: 0, max: 1, def: 0.4 },
    ],
    frag: `
// Quantises the matte into discrete depth planes and offsets each one, so a
// person separates into stacked cut-out layers.
void main(){
  if (uHasMatte < 0.5) { OUTPUT(texture(uTex, vUv).rgb); return; }
  float d = luma(texture(uMatte, vUv).rgb);
  float t = clamp((d - u_near) / max(u_far - u_near, 0.001), 0.0, 1.0);
  float n = max(u_slices, 2.0);
  float slice = floor(t * n);
  float sliceT = slice / n;

  vec2 uv = vUv + vec2(u_offset * (sliceT - 0.5), 0.0);
  vec3 col = texture(uTex, clamp(uv, 0.0, 1.0)).rgb;
  col = mix(col, col * palette(sliceT + uTime * 0.02, uPalette) * 2.0, u_tint);

  if (u_edges > 0.0) {
    float dx = abs(floor(clamp((luma(texture(uMatte, vUv + vec2(uTexel.x, 0.0)).rgb) - u_near)
             / max(u_far - u_near, 0.001), 0.0, 1.0) * n) - slice);
    float dy = abs(floor(clamp((luma(texture(uMatte, vUv + vec2(0.0, uTexel.y)).rgb) - u_near)
             / max(u_far - u_near, 0.001), 0.0, 1.0) * n) - slice);
    col += palette(sliceT + 0.4, uPalette) * clamp(dx + dy, 0.0, 1.0) * u_edges;
  }
  OUTPUT(col);
}`,
  },

  {
    id: 'pixelate',
    name: 'Pixelate',
    params: [
      { key: 'size', label: 'Size', min: 1, max: 200, def: 60 },
      { key: 'aspect', label: 'Aspect', min: 0.2, max: 5, def: 1 },
      { key: 'round', label: 'Dots', min: 0, max: 1, def: 0 },
    ],
    frag: `
void main(){
  vec2 n = vec2(max(u_size, 1.0), max(u_size / max(u_aspect, 0.01), 1.0));
  vec2 cell = floor(vUv * n) + 0.5;
  vec3 col = texture(uTex, cell / n).rgb;
  if (u_round > 0.0) {
    float d = length(fract(vUv * n) - 0.5) * 2.0;
    col *= mix(1.0, smoothstep(1.0, 0.6, d), u_round);
  }
  OUTPUT(col);
}`,
  },

  {
    id: 'posterize',
    name: 'Posterize',
    params: [
      { key: 'levels', label: 'Levels', min: 2, max: 32, def: 6 },
      { key: 'dither', label: 'Dither', min: 0, max: 1, def: 0.2 },
    ],
    frag: `
void main(){
  vec3 col = texture(uTex, vUv).rgb;
  float n = max(u_levels, 2.0);
  float d = (hash12(vUv * uRes) - 0.5) * u_dither / n;
  col = floor((col + d) * n + 0.5) / n;
  OUTPUT(col);
}`,
  },

  {
    id: 'bloom',
    name: 'Bloom',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 3, def: 0.8 },
      { key: 'threshold', label: 'Threshold', min: 0, max: 1, def: 0.55 },
      { key: 'radius', label: 'Radius', min: 0.5, max: 12, def: 3 },
    ],
    frag: `
void main(){
  vec3 src = texture(uTex, vUv).rgb;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  // 16-tap golden-angle spiral: cheap and isotropic enough at this scale.
  for (int i = 0; i < 16; i++) {
    float fi = float(i);
    float a = fi * 2.39996;
    float r = sqrt(fi / 16.0) * u_radius;
    vec2 o = vec2(cos(a), sin(a)) * r * uTexel * 4.0;
    vec3 s = texture(uTex, clamp(vUv + o, 0.0, 1.0)).rgb;
    float w = 1.0 - sqrt(fi / 16.0) * 0.7;
    sum += max(s - u_threshold, 0.0) * w;
    wsum += w;
  }
  vec3 col = src + sum / max(wsum, 0.001) * u_amount;
  OUTPUT(col);
}`,
  },

  {
    id: 'edge',
    name: 'Edge Detect',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 4, def: 1.5 },
      { key: 'width', label: 'Width', min: 0.5, max: 6, def: 1 },
      { key: 'keep', label: 'Keep source', min: 0, max: 1, def: 0.15 },
      { key: 'colour', label: 'Colourize', min: 0, max: 1, def: 0.6 },
    ],
    frag: `
float lum(vec2 uv){ return luma(texture(uTex, clamp(uv, 0.0, 1.0)).rgb); }
void main(){
  vec2 t = uTexel * u_width;
  float gx = lum(vUv + vec2(-t.x, -t.y)) * -1.0 + lum(vUv + vec2(t.x, -t.y)) * 1.0
           + lum(vUv + vec2(-t.x, 0.0)) * -2.0 + lum(vUv + vec2(t.x, 0.0)) * 2.0
           + lum(vUv + vec2(-t.x,  t.y)) * -1.0 + lum(vUv + vec2(t.x,  t.y)) * 1.0;
  float gy = lum(vUv + vec2(-t.x, -t.y)) * -1.0 + lum(vUv + vec2(-t.x, t.y)) * 1.0
           + lum(vUv + vec2(0.0, -t.y)) * -2.0 + lum(vUv + vec2(0.0, t.y)) * 2.0
           + lum(vUv + vec2( t.x, -t.y)) * -1.0 + lum(vUv + vec2( t.x, t.y)) * 1.0;
  float e = clamp(length(vec2(gx, gy)) * u_amount, 0.0, 4.0);
  vec3 src = texture(uTex, vUv).rgb;
  vec3 ec = mix(vec3(e), palette(e * 0.5 + uTime * 0.05, uPalette) * e, u_colour);
  vec3 col = ec + src * u_keep;
  OUTPUT(col);
}`,
  },

  {
    id: 'crt',
    name: 'CRT / Scanlines',
    params: [
      { key: 'lines', label: 'Line count', min: 50, max: 1200, def: 500 },
      { key: 'depth', label: 'Depth', min: 0, max: 1, def: 0.35 },
      { key: 'curve', label: 'Curvature', min: 0, max: 0.5, def: 0.08 },
      { key: 'vignette', label: 'Vignette', min: 0, max: 1, def: 0.4 },
      { key: 'noise', label: 'Noise', min: 0, max: 0.5, def: 0.05 },
    ],
    frag: `
void main(){
  vec2 p = vUv * 2.0 - 1.0;
  p *= 1.0 + dot(p, p) * u_curve;
  vec2 uv = p * 0.5 + 0.5;
  vec3 col = texture(uTex, clamp(uv, 0.0, 1.0)).rgb;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) col = vec3(0.0);
  float sl = 0.5 + 0.5 * sin(uv.y * u_lines * PI);
  col *= 1.0 - u_depth * sl;
  col *= 1.0 - u_vignette * dot(p, p) * 0.5;
  col += (hash12(vUv * uRes + uTime * 60.0) - 0.5) * u_noise;
  OUTPUT(col);
}`,
  },

  {
    id: 'strobe',
    name: 'Strobe / Invert',
    params: [
      { key: 'strobe', label: 'Strobe', min: 0, max: 1, def: 0 },
      { key: 'div', label: 'Division', type: 'enum', options: ['1/4', '1/2', '1', '2', '4'], def: 2 },
      { key: 'invert', label: 'Invert', min: 0, max: 1, def: 0 },
      { key: 'beatInvert', label: 'Invert on beat', min: 0, max: 1, def: 0 },
      { key: 'flashBlack', label: 'Flash to black', min: 0, max: 1, def: 1 },
    ],
    frag: `
void main(){
  vec3 col = texture(uTex, vUv).rgb;
  float divs[5] = float[5](0.25, 0.5, 1.0, 2.0, 4.0);
  float d = divs[int(clamp(u_div, 0.0, 4.0))];
  float ph = fract(uBeatPhase * d);
  float gate = step(0.5, ph);
  col = mix(col, mix(col, vec3(0.0), gate * u_flashBlack) + gate * (1.0 - u_flashBlack) * 0.6, u_strobe);
  float inv = clamp(u_invert + step(0.5, 1.0 - ph) * u_beatInvert, 0.0, 1.0);
  col = mix(col, 1.0 - col, inv);
  OUTPUT(col);
}`,
  },

  {
    id: 'polar',
    name: 'Polar Warp',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 1, def: 1 },
      { key: 'twist', label: 'Twist', min: -4, max: 4, def: 0 },
      { key: 'zoom', label: 'Zoom', min: 0.2, max: 3, def: 1 },
      { key: 'spin', label: 'Spin', min: -1, max: 1, def: 0 },
    ],
    frag: `
void main(){
  vec2 p = vUv - 0.5;
  p.x *= uRes.x / uRes.y;
  float r = length(p) / max(u_zoom, 0.05);
  float a = atan(p.y, p.x) + uTime * u_spin + r * u_twist;
  vec2 polar = vec2(fract(a / TAU + 0.5), clamp(r, 0.0, 1.0));
  vec2 uv = mix(vUv, polar, u_amount);
  vec3 col = texture(uTex, clamp(uv, 0.0, 1.0)).rgb;
  OUTPUT(col);
}`,
  },
];

export const EFFECT_BY_ID = Object.fromEntries(EFFECTS.map((e) => [e.id, e]));

/** Sensible signal-flow order for a fresh session. */
export const DEFAULT_CHAIN = [
  'motionEcho', 'displace', 'kaleido', 'mirror', 'polar',
  'flowDisplace', 'trails', 'flowTrails', 'flowPaint', 'flowSmear',
  'timeSmear', 'rgbShift', 'glitch', 'edge',
  'depthWarp', 'depthSlice', 'specWarp', 'paletteMap', 'colorize', 'bloom', 'mirrorBloom',
  'pixelate', 'posterize', 'crt', 'strobe',
];
