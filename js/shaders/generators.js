// Generative visual sources. Each declares its own params (which become
// uniforms named u_<key>) and a fragment body. `stateful` generators get the
// previous frame in uPrev, which is what makes trails and reaction-diffusion work.

export const GENERATORS = [
  {
    id: 'plasma',
    name: 'Plasma',
    params: [
      { key: 'scale', label: 'Scale', min: 0.5, max: 8, def: 2.4 },
      { key: 'speed', label: 'Speed', min: 0, max: 3, def: 0.3 },
      { key: 'warp', label: 'Warp', min: 0, max: 3, def: 1.1 },
      { key: 'bands', label: 'Bands', min: 1, max: 12, def: 3 },
      { key: 'reactive', label: 'Reactive', min: 0, max: 2, def: 1.0 },
    ],
    frag: `
void main(){
  vec2 p = centred(vUv, uRes) * u_scale;
  float t = uTime * u_speed;
  float react = u_reactive;
  // Audio warps the field WHERE IT IS rather than translating it. A global
  // offset driven by bass slides the entire picture on every kick, which on a
  // mapped wall reads as the projector shaking rather than as the image
  // responding. This varies with position, so it churns in place instead.
  p += 0.16 * react * vec2(
    sin(p.y * 1.7 + uBass * 3.0 + t),
    cos(p.x * 1.6 + uMid * 3.0 - t));
  vec2 q = vec2(fbm(p + t * 0.2, 5), fbm(p + vec2(5.2, 1.3) - t * 0.15, 5));
  vec2 r = vec2(fbm(p + u_warp * q + vec2(1.7, 9.2) + t * 0.11, 5),
                fbm(p + u_warp * q + vec2(8.3, 2.8) - t * 0.09, 5));
  float f = fbm(p + u_warp * r, 5);
  float v = fract(f * u_bands + t * 0.1 + uCentroid * react * 0.5);
  vec3 col = palette(v, uPalette);
  col *= 0.55 + 0.75 * f + uBeatPulse * react * 0.35;
  fragColor = vec4(col, 1.0);
}`,
  },

  {
    id: 'tunnel',
    name: 'Tunnel',
    params: [
      { key: 'speed', label: 'Speed', min: 0, max: 4, def: 0.45 },
      { key: 'twist', label: 'Twist', min: -3, max: 3, def: 0.35 },
      { key: 'rings', label: 'Rings', min: 1, max: 32, def: 8 },
      { key: 'spokes', label: 'Spokes', min: 0, max: 24, def: 6 },
      { key: 'reactive', label: 'Reactive', min: 0, max: 2, def: 1.0 },
    ],
    frag: `
void main(){
  vec2 p = centred(vUv, uRes);
  float r = length(p);
  float a = atan(p.y, p.x);
  float react = u_reactive;
  float z = uTime * u_speed + uPhrasePhase * react * 2.0;
  float d = 1.0 / max(r, 0.02);
  a += u_twist * d * 0.25 + z * 0.15;
  float u = fract(d * u_rings * 0.15 + z);
  float v = fract(a / TAU * max(u_spokes, 0.001) + z * 0.1);
  float grid = smoothstep(0.48, 0.5, abs(u - 0.5)) + smoothstep(0.46, 0.5, abs(v - 0.5));
  float glow = pow(clamp(1.0 - r, 0.0, 1.0), 2.5);
  vec3 col = palette(d * 0.12 + z * 0.05 + uCentroid * react * 0.3, uPalette);
  col *= 0.25 + grid * (0.8 + uHigh * react);
  col += glow * (0.35 + uBass * react * 1.2) * palette(z * 0.2, uPalette);
  col *= smoothstep(2.2, 0.1, r);
  fragColor = vec4(col, 1.0);
}`,
  },

  {
    id: 'kaleido',
    name: 'Kaleido Fractal',
    params: [
      { key: 'folds', label: 'Folds', min: 1, max: 12, def: 5 },
      { key: 'iter', label: 'Iterations', type: 'int', min: 2, max: 14, def: 8 },
      { key: 'zoom', label: 'Zoom', min: 0.2, max: 4, def: 1.2 },
      { key: 'spin', label: 'Spin', min: -2, max: 2, def: 0.04 },
      { key: 'reactive', label: 'Reactive', min: 0, max: 2, def: 1.0 },
    ],
    frag: `
void main(){
  vec2 p = centred(vUv, uRes) * u_zoom;
  float react = u_reactive;
  p *= rot2(uTime * u_spin + uBarPhase * react * 0.5);
  float acc = 0.0;
  float scale = 1.0;
  int iters = int(u_iter);
  for (int i = 0; i < 14; i++) {
    if (i >= iters) break;
    p = abs(p) / dot(p, p) - vec2(0.65 + 0.25 * sin(uTime * 0.2 + uLowMid * react),
                                  0.55 + 0.2 * cos(uTime * 0.17));
    p *= rot2(TAU / max(u_folds, 1.0));
    acc += exp(-abs(p.x * p.y) * 3.0) * scale;
    scale *= 0.85;
  }
  float v = acc * 0.35 + uTime * 0.03 + uCentroid * react * 0.4;
  vec3 col = palette(v, uPalette) * (0.35 + acc * (0.7 + uMid * react));
  col += uBeatPulse * react * 0.25 * palette(v + 0.3, uPalette);
  fragColor = vec4(col, 1.0);
}`,
  },

  {
    id: 'particles',
    name: 'Particles',
    params: [
      { key: 'density', label: 'Density', min: 2, max: 40, def: 14 },
      { key: 'speed', label: 'Speed', min: 0, max: 3, def: 0.35 },
      { key: 'size', label: 'Size', min: 0.01, max: 0.5, def: 0.11 },
      { key: 'spread', label: 'Spread', min: 0, max: 2, def: 0.5 },
      { key: 'reactive', label: 'Reactive', min: 0, max: 2, def: 1.0 },
    ],
    frag: `
void main(){
  vec2 uv = centred(vUv, uRes);
  float react = u_reactive;
  float n = max(u_density, 1.0);
  vec2 g = uv * n;
  vec2 cell = floor(g);
  vec3 col = vec3(0.0);
  float sz = u_size * (1.0 + uBass * react * 1.5);
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      vec2 c = cell + vec2(float(ox), float(oy));
      vec2 rnd = hash22(c);
      float t = uTime * u_speed * (0.5 + rnd.x);
      vec2 off = vec2(sin(t + rnd.x * TAU), cos(t * 1.3 + rnd.y * TAU)) * (0.35 + u_spread * rnd.y);
      vec2 pos = c + 0.5 + off;
      float d = length(g - pos);
      float amp = spectrum(fract(rnd.x * 3.7));
      float glow = sz * (0.4 + amp * react * 1.6) / max(d, 0.02);
      col += palette(rnd.y + uTime * 0.05, uPalette) * pow(glow, 1.8);
    }
  }
  fragColor = vec4(col, 1.0);
}`,
  },

  {
    id: 'bars',
    name: 'Spectrum',
    params: [
      { key: 'mode', label: 'Layout', type: 'enum', options: ['Linear', 'Mirror', 'Radial'], def: 2 },
      { key: 'thickness', label: 'Thickness', min: 0.05, max: 1, def: 0.7 },
      { key: 'gain', label: 'Gain', min: 0.2, max: 4, def: 1.3 },
      { key: 'glow', label: 'Glow', min: 0, max: 2, def: 0.7 },
      { key: 'radius', label: 'Radius', min: 0.05, max: 1.2, def: 0.4 },
    ],
    frag: `
void main(){
  vec2 p = centred(vUv, uRes);
  int mode = int(u_mode + 0.5);
  float t, h, along;
  if (mode == 2) {
    float a = atan(p.y, p.x) / TAU + 0.5;
    t = abs(fract(a * 2.0) * 2.0 - 1.0);
    along = length(p) - u_radius;
  } else if (mode == 1) {
    t = abs(vUv.x * 2.0 - 1.0);
    along = vUv.y - 0.15;
  } else {
    t = vUv.x;
    along = vUv.y;
  }
  h = spectrum(t) * u_gain;
  float bar = smoothstep(h, h - 0.02, along) * step(0.0, along);
  float edge = exp(-abs(along - h) * (60.0 / max(u_glow, 0.05))) * u_glow;
  float band = smoothstep(0.5 - u_thickness * 0.5, 0.5, 1.0 - abs(fract(t * 64.0) - 0.5) * 2.0);
  vec3 col = palette(t * 0.8 + uTime * 0.05, uPalette) * (bar * band + edge);
  col += vec3(uBeatPulse * 0.12);
  fragColor = vec4(col, 1.0);
}`,
  },

  {
    id: 'voronoi',
    name: 'Cells',
    params: [
      { key: 'scale', label: 'Scale', min: 1, max: 24, def: 6 },
      { key: 'speed', label: 'Speed', min: 0, max: 3, def: 0.3 },
      { key: 'edge', label: 'Edge', min: 0, max: 1, def: 0.45 },
      { key: 'pulse', label: 'Pulse', min: 0, max: 2, def: 0.8 },
    ],
    frag: `
void main(){
  vec2 p = centred(vUv, uRes) * u_scale;
  vec2 cell = floor(p);
  float d1 = 8.0, d2 = 8.0;
  vec2 id = vec2(0.0);
  for (int oy = -1; oy <= 1; oy++) {
    for (int ox = -1; ox <= 1; ox++) {
      vec2 c = cell + vec2(float(ox), float(oy));
      vec2 rnd = hash22(c);
      vec2 pt = c + 0.5 + 0.45 * vec2(sin(uTime * u_speed + rnd.x * TAU),
                                      cos(uTime * u_speed * 1.1 + rnd.y * TAU));
      float d = length(p - pt);
      if (d < d1) { d2 = d1; d1 = d; id = rnd; }
      else if (d < d2) { d2 = d; }
    }
  }
  float border = smoothstep(0.0, u_edge + 0.001, d2 - d1);
  float amp = spectrum(fract(id.x * 5.3));
  vec3 col = palette(id.y + uTime * 0.04 + amp * 0.3, uPalette);
  col *= 0.25 + (1.0 - border) * 1.4 + amp * u_pulse;
  col *= 0.6 + 0.6 * uLevel + uBeatPulse * u_pulse * 0.3;
  fragColor = vec4(col, 1.0);
}`,
  },

  {
    id: 'rings',
    name: 'Beat Rings',
    params: [
      { key: 'count', label: 'Count', min: 1, max: 16, def: 6 },
      { key: 'speed', label: 'Speed', min: 0, max: 3, def: 0.5 },
      { key: 'width', label: 'Width', min: 0.005, max: 0.3, def: 0.04 },
      { key: 'wobble', label: 'Wobble', min: 0, max: 1, def: 0.25 },
    ],
    frag: `
void main(){
  vec2 p = centred(vUv, uRes);
  float a = atan(p.y, p.x);
  float r = length(p) * (1.0 + u_wobble * sin(a * 6.0 + uTime) * (0.3 + uMid));
  vec3 col = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (float(i) >= u_count) break;
    float fi = float(i);
    float phase = fract(uTime * u_speed * 0.25 + fi / max(u_count, 1.0) + uBeatPhase * 0.25);
    float rad = phase * 1.6;
    float band = exp(-pow((r - rad) / max(u_width, 0.001), 2.0));
    col += palette(fi / max(u_count, 1.0) + uTime * 0.05, uPalette) * band * (1.0 - phase) * (0.6 + uBass * 1.4);
  }
  col += palette(uCentroid, uPalette) * exp(-r * 6.0) * uBeatPulse * 0.8;
  fragColor = vec4(col, 1.0);
}`,
  },

  {
    id: 'flow',
    name: 'Flow Field',
    stateful: true,
    params: [
      { key: 'scale', label: 'Scale', min: 0.5, max: 8, def: 2.5 },
      { key: 'speed', label: 'Speed', min: 0, max: 3, def: 0.5 },
      { key: 'decay', label: 'Persistence', min: 0.5, max: 0.995, def: 0.93 },
      { key: 'inject', label: 'Inject', min: 0, max: 1, def: 0.35 },
    ],
    frag: `
void main(){
  vec2 uv = vUv;
  vec2 p = centred(uv, uRes) * u_scale;
  // Curl of an fbm field -> divergence-free advection, which reads as smoke.
  float e = 0.02;
  float n1 = fbm(p + vec2(0.0, e) + uTime * 0.08, 4);
  float n2 = fbm(p - vec2(0.0, e) + uTime * 0.08, 4);
  float n3 = fbm(p + vec2(e, 0.0) + uTime * 0.08, 4);
  float n4 = fbm(p - vec2(e, 0.0) + uTime * 0.08, 4);
  vec2 curl = vec2(n1 - n2, n4 - n3) / (2.0 * e);
  vec2 vel = curl * 0.004 * u_speed * (0.5 + uLevel * 1.5);
  vec3 prev = texture(uPrev, uv - vel).rgb * u_decay;
  float src = smoothstep(0.62, 1.0, fbm(p * 1.7 - uTime * 0.25, 4)) * u_inject;
  src *= 0.35 + uBass * 2.0 + uBeatPulse * 1.2;
  vec3 col = prev + palette(fbm(p * 0.5 + uTime * 0.05, 3) + uCentroid * 0.4, uPalette) * src;
  fragColor = vec4(clamp(col, 0.0, 4.0), 1.0);
}`,
  },

  {
    id: 'reaction',
    name: 'Reaction',
    stateful: true,
    params: [
      { key: 'feed', label: 'Feed', min: 0.01, max: 0.09, def: 0.037 },
      { key: 'kill', label: 'Kill', min: 0.04, max: 0.075, def: 0.061 },
      { key: 'steps', label: 'Steps', type: 'int', min: 1, max: 6, def: 3 },
      { key: 'seed', label: 'Seeding', min: 0, max: 1, def: 0.35 },
    ],
    frag: `
// Gray-Scott stored as (A, B) in the red/green channels.
vec2 lap(vec2 uv, vec2 texel){
  vec2 s = vec2(0.0);
  s += texture(uPrev, uv + vec2(-texel.x, 0.0)).rg * 0.2;
  s += texture(uPrev, uv + vec2( texel.x, 0.0)).rg * 0.2;
  s += texture(uPrev, uv + vec2(0.0, -texel.y)).rg * 0.2;
  s += texture(uPrev, uv + vec2(0.0,  texel.y)).rg * 0.2;
  s += texture(uPrev, uv + vec2(-texel.x, -texel.y)).rg * 0.05;
  s += texture(uPrev, uv + vec2( texel.x, -texel.y)).rg * 0.05;
  s += texture(uPrev, uv + vec2(-texel.x,  texel.y)).rg * 0.05;
  s += texture(uPrev, uv + vec2( texel.x,  texel.y)).rg * 0.05;
  return s - texture(uPrev, uv).rg;
}
void main(){
  vec2 texel = 1.0 / uRes;
  vec2 ab = texture(uPrev, vUv).rg;
  if (uTime < 0.35) ab = vec2(1.0, hash12(vUv * 400.0) > 0.997 ? 1.0 : 0.0);
  float f = u_feed + uCentroid * 0.008;
  float k = u_kill + uHigh * 0.003;
  int steps = int(u_steps);
  for (int i = 0; i < 6; i++) {
    if (i >= steps) break;
    vec2 l = lap(vUv, texel);
    float reactTerm = ab.x * ab.y * ab.y;
    ab.x += (1.0 * l.x - reactTerm + f * (1.0 - ab.x));
    ab.y += (0.5 * l.y + reactTerm - (k + f) * ab.y);
    ab = clamp(ab, 0.0, 1.0);
  }
  // Beat-synced seeding keeps the pattern alive and locked to the music.
  vec2 c = centred(vUv, uRes);
  float seedRing = exp(-pow((length(c) - fract(uBarPhase) * 1.2) * 26.0, 2.0));
  ab.y = clamp(ab.y + seedRing * uBeatPulse * u_seed, 0.0, 1.0);
  fragColor = vec4(ab, 0.0, 1.0);
}`,
    // Gray-Scott state is not directly viewable; a display pass colourizes it.
    display: `
void main(){
  vec2 ab = texture(uPrev, vUv).rg;
  float v = clamp(ab.y * 4.0, 0.0, 1.0);
  vec3 col = palette(v * 0.8 + uTime * 0.02, uPalette) * smoothstep(0.02, 0.55, v);
  col += vec3(pow(v, 6.0)) * 0.6;
  fragColor = vec4(col, 1.0);
}`,
  },

  {
    id: 'starfield',
    name: 'Starfield',
    params: [
      { key: 'speed', label: 'Speed', min: 0, max: 4, def: 0.5 },
      { key: 'layers', label: 'Layers', type: 'int', min: 1, max: 8, def: 5 },
      { key: 'density', label: 'Density', min: 2, max: 30, def: 12 },
      { key: 'streak', label: 'Streak', min: 0, max: 1, def: 0.3 },
    ],
    frag: `
void main(){
  vec2 p = centred(vUv, uRes);
  vec3 col = vec3(0.0);
  int layers = int(u_layers);
  float t = uTime * u_speed * (0.6 + uLevel);
  for (int i = 0; i < 8; i++) {
    if (i >= layers) break;
    float fi = float(i);
    float depth = fract(fi / float(layers) + t * 0.15);
    float sc = mix(20.0, 1.0, depth) * (u_density / 12.0);
    vec2 q = p * sc;
    q *= rot2(fi * 1.7 + uBarPhase * 0.4);
    vec2 cell = floor(q);
    vec2 rnd = hash22(cell + fi * 31.7);
    vec2 pt = cell + 0.3 + 0.4 * rnd;
    vec2 dv = q - pt;
    dv.x *= 1.0 + u_streak * 8.0 * (1.0 - depth);
    float d = length(dv);
    float bright = (1.0 - depth) * (0.4 + spectrum(rnd.x) * 1.6);
    col += palette(rnd.y * 0.5 + depth, uPalette) * bright * 0.02 / max(d * d, 0.0004) * 0.02;
  }
  col *= 0.7 + uBeatPulse * 0.6;
  fragColor = vec4(col, 1.0);
}`,
  },
  // ---- built for a 90-degree room corner -----------------------------------
  //
  // These three hang their geometry on `uSeam`, the crease between the two wall
  // planes, via `cornerP`. On a flat screen they are ordinary perspective
  // pieces; on the corner they are the difference between a picture painted on
  // two walls and something that appears to occupy the room.
  //
  // The corner is the only real depth cue in the venue, so all three put their
  // strongest feature - a vanishing point, a lit edge, an occluding solid -
  // exactly on it. They lean on warm tones and luminance contrast, because
  // yellow paint absorbs blue and hands it back muddy.

  {
    id: 'corridor',
    name: 'Corner Corridor',
    params: [
      { key: 'focal', label: 'Depth', min: 0.3, max: 3, def: 1.1 },
      { key: 'speed', label: 'Speed', min: 0, max: 3, def: 0.35 },
      { key: 'rings', label: 'Rings', min: 0, max: 30, def: 9 },
      { key: 'bars', label: 'Ribs', min: 0, max: 16, def: 4 },
      { key: 'squash', label: 'Height', min: 0.3, max: 3, def: 1.0 },
      { key: 'fog', label: 'Fog', min: 0, max: 4, def: 1.2 },
      { key: 'glow', label: 'Corner glow', min: 0, max: 2, def: 0.7 },
      { key: 'reactive', label: 'Reactive', min: 0, max: 2, def: 1.0 },
    ],
    frag: `
void main(){
  vec2 p = cornerP(vUv, uRes);
  float react = u_reactive;
  vec3 rd = normalize(vec3(p, -max(u_focal, 0.2)));

  // Inside an infinite square tunnel down -z: the ray leaves through whichever
  // side it reaches first, and that hit is the surface being looked at.
  float tx = abs(rd.x) > 1e-4 ? 1.0 / abs(rd.x) : 1e9;
  float ty = abs(rd.y) > 1e-4 ? max(u_squash, 0.05) / abs(rd.y) : 1e9;
  float t = min(tx, ty);
  vec3 hit = rd * t;
  float d = -hit.z;                       // how far down the corridor
  float z = uTime * u_speed + uBarPhase * react * 0.4;

  float across = (tx < ty) ? hit.y : hit.x;
  float ring = fract(d * u_rings * 0.12 - z);
  float rib  = fract(across * u_bars * 0.5 + z * 0.05);
  float lines = (1.0 - smoothstep(0.0, 0.055, abs(ring - 0.5))) * 0.95
              + (1.0 - smoothstep(0.0, 0.045, abs(rib - 0.5))) * 0.45;

  float fog = exp(-d * u_fog * 0.11);
  vec3 col = palette(d * 0.045 + z * 0.09 + uCentroid * react * 0.25, uPalette);
  col *= lines * (0.55 + uHigh * react * 0.8) + 0.05;
  col *= fog;

  // The vanishing point is the real corner, so that is what glows.
  float centre = exp(-length(p) * max(u_focal, 0.2) * 3.0);
  col += centre * u_glow * (0.3 + uBass * react * 0.9)
       * palette(z * 0.13 + 0.4, uPalette);
  fragColor = vec4(col, 1.0);
}`,
  },

  {
    id: 'crease',
    name: 'Corner Light',
    params: [
      { key: 'width', label: 'Core width', min: 0.002, max: 0.4, def: 0.045 },
      { key: 'spread', label: 'Spill', min: 0.2, max: 6, def: 2.2 },
      { key: 'taper', label: 'Taper', min: 0, max: 1, def: 0.35 },
      { key: 'hot', label: 'Hot core', min: 0, max: 2, def: 0.8 },
      { key: 'drift', label: 'Drift', min: 0, max: 3, def: 0.5 },
      { key: 'reactive', label: 'Reactive', min: 0, max: 2, def: 1.0 },
    ],
    frag: `
void main(){
  vec2 p = cornerP(vUv, uRes);
  float react = u_reactive;
  float dx = abs(p.x);
  // A vertical taper stops it reading as a painted stripe and starts it reading
  // as a line of light with a top and a bottom.
  float taper = max(1.0 - u_taper * abs(p.y) * 1.7, 0.05);
  float pulse = 1.0 + (uBass * 1.1 + uBeatPulse * 0.7) * react;
  float w = max(u_width * taper * pulse, 0.004);
  float core = exp(-dx / w);
  float halo = exp(-dx / (w * u_spread * 5.0)) * 0.5;
  float v = core + halo;
  v *= 0.84 + 0.16 * sin(p.y * 5.0 + uTime * u_drift);
  vec3 col = palette(0.07 + dx * 0.3 + uCentroid * react * 0.18, uPalette) * v;
  // A near-white centre: the wall eats blue, so the brightest part of the
  // picture has to carry itself on luminance rather than on hue.
  col += vec3(1.0, 0.94, 0.84) * core * u_hot * (0.35 + uBeatPulse * react * 0.55);
  fragColor = vec4(col, 1.0);
}`,
  },

  {
    id: 'monolith',
    name: 'Monolith',
    params: [
      { key: 'count', label: 'Slabs', min: 1, max: 4, def: 2, step: 1 },
      { key: 'size', label: 'Size', min: 0.2, max: 1.6, def: 0.75 },
      { key: 'spread', label: 'Spread', min: 0, max: 2.5, def: 1.1 },
      { key: 'spin', label: 'Spin', min: 0, max: 3, def: 0.5 },
      { key: 'sway', label: 'Sway', min: 0, max: 1, def: 0.22 },
      { key: 'focal', label: 'Lens', min: 0.4, max: 2.5, def: 1.2 },
      { key: 'reactive', label: 'Reactive', min: 0, max: 2, def: 1.0 },
    ],
    frag: `
float sdBox(vec3 p, vec3 b){
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float scene(vec3 p){
  float t = uTime * u_spin * 0.25;
  float n = max(u_count, 1.0);
  float d = 1e9;
  for (int i = 0; i < 4; i++){
    if (float(i) >= n) break;
    float f = float(i);
    vec3 q = p;
    q.x -= (f - (n - 1.0) * 0.5) * u_spread;
    q.y -= sin(t * 1.2 + f * 2.1) * u_sway;
    q.z += f * 0.55;
    q.xz = rot2(t + f * 0.8) * q.xz;
    vec3 b = vec3(u_size * 0.22, u_size * (0.7 + 0.18 * sin(f * 1.7)), u_size * 0.22);
    d = min(d, sdBox(q, b) - 0.03);
  }
  return d;
}

void main(){
  vec2 p = cornerP(vUv, uRes);
  vec3 ro = vec3(0.0, 0.0, 3.4);
  vec3 rd = normalize(vec3(p, -max(u_focal, 0.3)));
  float react = u_reactive;

  float t = 0.0;
  bool hit = false;
  for (int i = 0; i < 72; i++){
    vec3 pos = ro + rd * t;
    float d = scene(pos);
    if (d < 0.0025) { hit = true; break; }
    t += d;
    if (t > 14.0) break;
  }

  vec3 col = vec3(0.0);
  if (hit) {
    vec3 pos = ro + rd * t;
    vec2 e = vec2(0.0018, 0.0);
    vec3 n = normalize(vec3(
      scene(pos + e.xyy) - scene(pos - e.xyy),
      scene(pos + e.yxy) - scene(pos - e.yxy),
      scene(pos + e.yyx) - scene(pos - e.yyx)));
    vec3 lig = normalize(vec3(0.55, 0.8, 0.6));
    float dif = clamp(dot(n, lig), 0.0, 1.0);
    // A rim is what separates a solid from the dark wall behind it.
    float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 2.5);
    vec3 base = palette(0.14 + pos.x * 0.07 + uCentroid * react * 0.2, uPalette);
    col = base * (0.13 + dif * (0.8 + uBeatPulse * react * 0.5));
    col += rim * base * (0.55 + uHigh * react * 0.9);
    col *= exp(-max(t - 2.4, 0.0) * 0.2);
  }
  fragColor = vec4(col, 1.0);
}`,
  },
  {
    id: 'hall',
    name: 'Corner Hall',
    params: [
      { key: 'focal', label: 'Lens', min: 0.4, max: 3, def: 1.2 },
      { key: 'height', label: 'Room height', min: 0.3, max: 3, def: 1.0 },
      { key: 'depth', label: 'Far wall', min: 2, max: 40, def: 14 },
      { key: 'grid', label: 'Grid', min: 0, max: 24, def: 7 },
      { key: 'speed', label: 'Walk', min: 0, max: 3, def: 0.3 },
      { key: 'horizon', label: 'Horizon lift', min: -0.4, max: 0.4, def: 0 },
      { key: 'fog', label: 'Fog', min: 0, max: 3, def: 1.0 },
      { key: 'reactive', label: 'Reactive', min: 0, max: 2, def: 1.0 },
    ],
    frag: `
// A room that continues past the corner: floor, ceiling and a far wall, all in
// honest perspective. The floor is the strongest spatial cue there is - a level
// plane crossing a 90-degree crease bends, and the eye reads that bend as depth
// rather than as a drawing.
void main(){
  vec2 p = cornerP(vUv, uRes);
  p.y -= u_horizon;
  float react = u_reactive;
  vec3 rd = normalize(vec3(p, -max(u_focal, 0.2)));
  float z = uTime * u_speed;
  float h = u_height;

  float best = 1e9;
  float kind = -1.0;       // 0 floor, 1 ceiling, 2 far wall
  vec2 sp = vec2(0.0);

  // Floor and ceiling: y = -h and y = +h.
  if (abs(rd.y) > 1e-4) {
    float tf = -h / rd.y;
    if (tf > 0.0 && rd.y < 0.0) { best = tf; kind = 0.0; }
    float tc = h / rd.y;
    if (tc > 0.0 && rd.y > 0.0 && tc < best) { best = tc; kind = 1.0; }
  }
  // The far wall closes the room, so the perspective has somewhere to end.
  if (rd.z < -1e-4) {
    float tw = -u_depth / rd.z;
    if (tw > 0.0 && tw < best) { best = tw; kind = 2.0; }
  }
  if (kind < 0.0) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec3 hit = rd * best;
  float d = -hit.z;
  sp = kind < 1.5 ? vec2(hit.x, d + z) : vec2(hit.x, hit.y);

  float g = max(u_grid, 0.001) * 0.25;
  vec2 cell = abs(fract(sp * g) - 0.5);
  float line = 1.0 - smoothstep(0.0, 0.035, min(cell.x, cell.y));

  vec3 tint = palette(d * 0.03 + z * 0.05 + uCentroid * react * 0.25, uPalette);
  // The ceiling sits back so the floor reads as the ground rather than as a
  // mirror of it, which is what sells which way up the room is.
  float face = kind < 0.5 ? 1.0 : kind < 1.5 ? 0.45 : 0.8;
  vec3 col = tint * line * face * (0.55 + uHigh * react * 0.7);
  col += tint * 0.05 * face;
  col *= exp(-d * u_fog * 0.07);
  // A glow where the floor meets the far wall: that join lands on the crease.
  col += palette(z * 0.1 + 0.3, uPalette)
       * exp(-length(p) * 3.5) * (0.25 + uBass * react * 0.8);
  fragColor = vec4(col, 1.0);
}`,
  },

  {
    id: 'vault',
    name: 'Vault',
    params: [
      { key: 'focal', label: 'Lens', min: 0.4, max: 3, def: 1.1 },
      { key: 'width', label: 'Opening', min: 0.1, max: 1.2, def: 0.45 },
      { key: 'tall', label: 'Height', min: 0.1, max: 1.5, def: 0.6 },
      { key: 'depth', label: 'Depth', min: 0.2, max: 8, def: 2.2 },
      { key: 'rings', label: 'Ribs', min: 0, max: 20, def: 5 },
      { key: 'glow', label: 'Back glow', min: 0, max: 2, def: 0.9 },
      { key: 'reactive', label: 'Reactive', min: 0, max: 2, def: 1.0 },
    ],
    frag: `
// A rectangular recess cut into the corner: you see the inner faces going back
// to a lit rear panel. Anamorphic in the useful sense - the opening is drawn
// where the real crease is, so the box appears to be behind the wall rather
// than painted on it.
void main(){
  vec2 p = cornerP(vUv, uRes);
  float react = u_reactive;
  float w = u_width;
  float t = u_tall;
  // Outside the opening there is wall, and wall is where the projector should
  // put nothing at all.
  if (abs(p.x) > w || abs(p.y) > t) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec3 rd = normalize(vec3(p, -max(u_focal, 0.2)));
  float D = u_depth * (1.0 + uBass * react * 0.12);

  // Which inner face this ray reaches first: the four sides or the back.
  float tb = -D / rd.z;
  float best = tb;
  float face = 4.0;
  if (abs(rd.x) > 1e-4) {
    float s = sign(rd.x) * w;
    float tx = s / rd.x;
    if (tx > 0.0 && tx < best) { best = tx; face = rd.x > 0.0 ? 0.0 : 1.0; }
  }
  if (abs(rd.y) > 1e-4) {
    float s = sign(rd.y) * t;
    float ty = s / rd.y;
    if (ty > 0.0 && ty < best) { best = ty; face = rd.y > 0.0 ? 2.0 : 3.0; }
  }

  vec3 hit = rd * best;
  float d = -hit.z;
  // Ribs running back into the recess give the depth something to be measured
  // against; without them a smooth box reads flat.
  float rib = 1.0 - smoothstep(0.0, 0.06, abs(fract(d * max(u_rings, 0.001) * 0.35) - 0.5));
  // Each face takes the light differently, which is most of the solidity.
  float shade = face == 4.0 ? 1.0
              : face < 1.5 ? 0.42 : 0.62;
  vec3 tint = palette(d * 0.12 + uCentroid * react * 0.2, uPalette);
  // The inner faces carry most of the frame, so they need real light on them -
  // a recess drawn in near-black is invisible on a dim projector.
  vec3 col = tint * shade * (0.55 + rib * 0.75);
  if (face == 4.0) {
    // The rear panel is the light source, so it carries the audio.
    float r = length(hit.xy / vec2(w, t));
    col += palette(0.35 + uTime * 0.03, uPalette)
         * u_glow * (0.5 + uBeatPulse * react * 0.8) * exp(-r * 1.6);
  }
  col *= exp(-max(d - D * 0.4, 0.0) * 0.25);
  fragColor = vec4(col, 1.0);
}`,
  },

  {
    id: 'helix',
    name: 'Corner Helix',
    params: [
      { key: 'focal', label: 'Lens', min: 0.4, max: 3, def: 1.2 },
      { key: 'radius', label: 'Radius', min: 0.1, max: 1.5, def: 0.55 },
      { key: 'turns', label: 'Turns', min: 0.5, max: 8, def: 2.5 },
      { key: 'thickness', label: 'Thickness', min: 0.01, max: 0.3, def: 0.06 },
      { key: 'spin', label: 'Spin', min: -3, max: 3, def: 0.4 },
      { key: 'reach', label: 'Reach', min: 1, max: 8, def: 3.5 },
      { key: 'reactive', label: 'Reactive', min: 0, max: 2, def: 1.0 },
    ],
    frag: `
// A ribbon winding around the axis that runs into the corner. Because it passes
// in front of and behind that axis, parts of it occlude other parts - and
// occlusion is the depth cue the eye trusts most, more than perspective.
void main(){
  vec2 p = cornerP(vUv, uRes);
  float react = u_reactive;
  vec3 ro = vec3(0.0, 0.0, 1.2);
  vec3 rd = normalize(vec3(p, -max(u_focal, 0.2)));
  float spin = uTime * u_spin;

  float hitT = -1.0;
  float hitPhase = 0.0;
  // March the ray and test the distance to the nearest point of the helix at
  // that depth. Cheap, and exact enough for a ribbon.
  float t = 0.0;
  for (int i = 0; i < 64; i++) {
    vec3 q = ro + rd * t;
    float depth = clamp(-q.z / max(u_reach, 0.01), 0.0, 1.0);
    float a = depth * u_turns * TAU + spin;
    // The helix narrows as it recedes, so it reads as going away rather than
    // as a flat spiral drawn on the wall.
    float r = u_radius * (1.0 - depth * 0.55);
    vec2 c = vec2(cos(a), sin(a)) * r;
    float dist = length(q.xy - c) - u_thickness * (1.0 - depth * 0.5);
    if (dist < 0.004) { hitT = t; hitPhase = depth; break; }
    t += max(dist * 0.6, 0.01);
    if (t > 6.0) break;
  }

  vec3 col = vec3(0.0);
  if (hitT > 0.0) {
    vec3 tint = palette(hitPhase * 0.7 + uCentroid * react * 0.2, uPalette);
    // Nearer turns are brighter, which is what separates the strands.
    col = tint * (1.05 - hitPhase * 0.65) * (0.5 + uBeatPulse * react * 0.5);
    col += tint * (1.0 - smoothstep(0.0, 0.35, hitPhase)) * uHigh * react * 0.4;
  }
  // A little light down the axis, which is the corner itself.
  col += palette(0.4, uPalette) * exp(-length(p) * 5.0)
       * (0.15 + uBass * react * 0.6);
  fragColor = vec4(col, 1.0);
}`,
  },
];

export const GENERATOR_BY_ID = Object.fromEntries(GENERATORS.map((g) => [g.id, g]));
