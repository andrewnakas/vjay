// Automatic projection mapping from the webcam.
//
// The idea people usually reach for - "aim the camera the same way as the
// projector, then use what it sees" - does not work: the two have different
// positions, lenses and fields of view, so a camera pixel is not a projector
// pixel however carefully you line them up. What does work is structured
// light: put a KNOWN image out of the projector, find where it lands in the
// camera, and solve the transform between the two from those correspondences.
//
//   1. Capture the wall lit (white) and unlit (black). The difference is
//      exactly the projector's footprint, and its brightness is the wall's
//      reflectance - which is what makes a dark painting findable.
//   2. Project four blobs at known projector coordinates, one at a time, and
//      take each one's centroid in the camera. Four correspondences give the
//      projector -> camera homography, and its inverse takes anything seen by
//      the camera back into projector space.
//   3. Find the dark rectangles inside the lit area. Those are the pictures.
//      Map their corners back through the inverse and they are surfaces.
//
// Everything here runs on the CPU over a downscaled camera frame. It is a few
// hundred pixels of connected components, not a vision pipeline, so there is no
// reason to carry OpenCV for it.

import { params } from './params.js';
import { squareToQuad, inverse3, MAX_SURFACES } from './mapping.js';

// The projection is often a small part of a wide camera view, so this is
// higher than it looks like it needs to be - at 320x180 a projection filling
// a sixth of the frame leaves barely 130x74 real pixels to find a picture in.
export const CAM_W = 640;
export const CAM_H = 360;
const SETTLE_MS = 260;             // projector + camera latency per pattern
const BLOB_UV = [[0.18, 0.18], [0.82, 0.18], [0.82, 0.82], [0.18, 0.82]];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Apply a row-major 3x3 to a point, with the perspective divide. */
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  if (Math.abs(w) < 1e-12) return null;
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function mul3(A, B) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let v = 0;
      for (let k = 0; k < 3; k++) v += A[r * 3 + k] * B[k * 3 + c];
      out[r * 3 + c] = v;
    }
  }
  return out;
}

/**
 * Homography taking quad `from` onto quad `to`, both as four [x, y] in the same
 * winding. Built by routing through the unit square, which is the one case
 * `squareToQuad` already solves.
 */
export function quadToQuad(from, to) {
  const A = squareToQuad(from);
  const B = squareToQuad(to);
  if (!A || !B) return null;
  const Ainv = inverse3(A);
  return Ainv ? mul3(B, Ainv) : null;
}

/**
 * Brightness-weighted centroid of the brightest cluster in `diff`.
 * Thresholding relative to the frame's own peak keeps it working whether the
 * room is dim or the wall is bright.
 */
export function brightestCentroid(diff, w, h, { minPeak = 18 } = {}) {
  let peak = 0;
  for (let i = 0; i < diff.length; i++) if (diff[i] > peak) peak = diff[i];
  if (peak < minPeak) return null;
  const cut = peak * 0.6;
  let sx = 0, sy = 0, sw = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = diff[y * w + x];
      if (v < cut) continue;
      sx += x * v; sy += y * v; sw += v; n++;
    }
  }
  if (!n || sw <= 0) return null;
  return { x: sx / sw, y: sy / sw, weight: sw, count: n, peak };
}

/**
 * Connected components over a boolean mask, iterative so a large blob cannot
 * blow the stack. Returns components with their bounding box and pixel count.
 */
export function components(mask, w, h, { minArea = 40 } = {}) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let minX = w, maxX = -1, minY = h, maxY = -1, area = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p / w) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    if (area < minArea) continue;
    out.push({ minX, maxX, minY, maxY, area, w: maxX - minX + 1, h: maxY - minY + 1 });
  }
  return out;
}

/**
 * Otsu's threshold over `values`: the split that best separates them into two
 * classes. Used to tell wall from painting without guessing a ratio - a dark
 * picture reflects a small fraction of the projector's light, but how small
 * depends on the paint, the frame and the room.
 */
export function otsu(values, lo, hi, bins = 64) {
  if (!values.length || hi <= lo) return null;
  const hist = new Float64Array(bins);
  for (const v of values) {
    let b = Math.floor(((v - lo) / (hi - lo)) * bins);
    if (b < 0) b = 0;
    if (b >= bins) b = bins - 1;
    hist[b]++;
  }
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, bestBin = 0;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestBin = i; }
  }
  return lo + ((bestBin + 1) / bins) * (hi - lo);
}

export class Calibrator {
  constructor(app) {
    this.app = app;
    this.running = false;
    this.lastResult = null;
    this.cameraKey = null;
    this._snapshot = null;
  }

  /**
   * The camera doing the looking. Set `cameraKey` to aim a specific one - the
   * built-in webcam faces the performer, so calibration usually wants a second
   * camera pointed at the wall instead.
   */
  get camera() {
    if (this.cameraKey) {
      const chosen = this.app.sources.get?.(this.cameraKey);
      if (chosen && chosen.ready) return chosen;
    }
    for (const src of this.app.sources.activeCameras()) if (src.ready) return src;
    return null;
  }

  /** Live cameras, for the picker. */
  cameras() {
    return this.app.sources.activeCameras?.().filter((s) => s.ready) || [];
  }

  _ensureCanvas() {
    if (!this._c) {
      this._c = document.createElement('canvas');
      this._c.width = CAM_W;
      this._c.height = CAM_H;
      this._ctx = this._c.getContext('2d', { willReadFrequently: true });
    }
    return this._ctx;
  }

  /** One greyscale camera frame at the working resolution. */
  _grab() {
    const cam = this.camera;
    const ctx = this._ensureCanvas();
    ctx.drawImage(cam.video, 0, 0, CAM_W, CAM_H);
    const d = ctx.getImageData(0, 0, CAM_W, CAM_H).data;
    const g = new Float32Array(CAM_W * CAM_H);
    for (let i = 0; i < g.length; i++) {
      g[i] = 0.21 * d[i * 4] + 0.72 * d[i * 4 + 1] + 0.07 * d[i * 4 + 2];
    }
    return g;
  }

  async _show(pattern, settle = SETTLE_MS) {
    this.app.renderer.calibration = pattern;
    await new Promise((r) => setTimeout(r, settle));
    return this._grab();
  }

  /** Snapshot the surfaces so a bad result can be undone in one click. */
  _saveSnapshot() {
    this._snapshot = this.app.mapping.serialize();
  }

  undo() {
    if (!this._snapshot) return false;
    this.app.mapping.restore(this._snapshot);
    this._snapshot = null;
    return true;
  }

  get canUndo() { return !!this._snapshot; }

  /**
   * @param onProgress (step, total, message) => void
   * @returns { ok, message, frames, homography, inverse, coverage }
   */
  async run({ onProgress = () => {}, assignFrames = true } = {}) {
    if (this.running) return { ok: false, message: 'Already calibrating' };
    if (!this.camera) {
      return { ok: false, message: 'Start a camera first — Sources › ⟳ Cameras › Start' };
    }
    this.running = true;
    const steps = 9;
    let step = 0;
    const tick = (msg) => onProgress(++step, steps, msg);

    try {
      tick('Reading the unlit wall…');
      const dark = await this._show({ mode: 'flat', level: 0 }, 500);

      tick('Lighting the wall…');
      const lit = await this._show({ mode: 'flat', level: 1 }, 500);

      // The difference is the projector's footprint, and its magnitude is how
      // much light each part of the surface sends back.
      const diff = new Float32Array(CAM_W * CAM_H);
      let peak = 0;
      for (let i = 0; i < diff.length; i++) {
        const v = lit[i] - dark[i];
        diff[i] = v > 0 ? v : 0;
        if (diff[i] > peak) peak = diff[i];
      }
      if (peak < 20) {
        return {
          ok: false,
          message: 'The camera cannot see the projection. Point it at the wall, '
            + 'dim the room lights, and make sure the output window is on the projector.',
        };
      }

      let litCount = 0;
      // Deliberately generous. A painting reflects only a fraction of the
      // projector's light, so a tight threshold here drops the very regions
      // this is trying to find and the search comes back empty.
      const litCut = Math.max(12, peak * 0.08);
      for (let i = 0; i < diff.length; i++) if (diff[i] > litCut) litCount++;
      // Kept only as a rough "is anything happening" signal. It is NOT the
      // projected area: a white screen bounces light off every wall in the
      // room, so this routinely reads 70% when the projection itself covers a
      // tenth of the frame. The real footprint comes from the homography below.
      const litShare = litCount / (CAM_W * CAM_H);

      // Four known projector points, located one at a time so there is no
      // question which blob is which.
      const camPts = [];
      for (let k = 0; k < 4; k++) {
        tick(`Locating corner ${k + 1} of 4…`);
        const shot = await this._show({ mode: 'blob', point: BLOB_UV[k], radius: 0.1 });
        const d2 = new Float32Array(CAM_W * CAM_H);
        for (let i = 0; i < d2.length; i++) {
          const v = shot[i] - dark[i];
          d2[i] = v > 0 ? v : 0;
        }
        const c = brightestCentroid(d2, CAM_W, CAM_H);
        if (!c) {
          return {
            ok: false,
            message: `Could not find calibration blob ${k + 1}. `
              + 'The whole projected area has to be inside the camera view.',
          };
        }
        camPts.push([c.x, c.y]);
      }

      // The four blobs must span a real area. If they collapse together the
      // homography still "fits" them perfectly and every later number is junk.
      const quadArea = Math.abs(
        camPts[0][0] * (camPts[1][1] - camPts[3][1])
        + camPts[1][0] * (camPts[2][1] - camPts[0][1])
        + camPts[2][0] * (camPts[3][1] - camPts[1][1])
        + camPts[3][0] * (camPts[0][1] - camPts[2][1])
      ) / 2;
      const quadShare = quadArea / (CAM_W * CAM_H);
      if (quadShare < 0.02) {
        return {
          ok: false,
          litShare,
          message: `The calibration dots landed almost on top of each other (${(quadShare * 100).toFixed(1)}% of the view). `
            + 'The camera is probably seeing a reflection rather than the projected image.',
        };
      }

      // projector uv -> camera pixels, and back.
      const H = quadToQuad(BLOB_UV, camPts);
      const Hinv = H ? inverse3(H) : null;
      if (!H || !Hinv) {
        return { ok: false, message: 'Calibration points were degenerate — reposition the camera and retry.' };
      }

      // Sanity: the solved transform must actually reproduce the blobs.
      let resid = 0;
      BLOB_UV.forEach((uv, i) => {
        const p = applyH(H, uv[0], uv[1]);
        if (p) resid = Math.max(resid, Math.hypot(p[0] - camPts[i][0], p[1] - camPts[i][1]));
      });

      tick('Looking for picture frames…');

      // Work in PROJECTOR space, not camera space. Sampling the difference
      // image through the homography rectifies the wall into the projector's
      // own rectangle, which (a) confines the search to what is actually being
      // projected on - immune to the room-wide bounce that makes a brightness
      // mask useless - and (b) means every region found is already in the
      // coordinates a surface wants.
      const RECT_W = 256;
      const RECT_H = 144;
      const rect = new Float32Array(RECT_W * RECT_H);
      const sampleDiff = (cx, cy) => {
        const x = Math.round(cx);
        const y = Math.round(cy);
        if (x < 0 || y < 0 || x >= CAM_W || y >= CAM_H) return -1;
        return diff[y * CAM_W + x];
      };
      let rectMax = 0;
      let inside = 0;
      for (let j = 0; j < RECT_H; j++) {
        for (let i = 0; i < RECT_W; i++) {
          const u = (i + 0.5) / RECT_W;
          const v = (j + 0.5) / RECT_H;
          const c = applyH(H, u, v);
          const val = c ? sampleDiff(c[0], c[1]) : -1;
          rect[j * RECT_W + i] = val;
          if (val >= 0) { inside++; if (val > rectMax) rectMax = val; }
        }
      }
      if (inside < RECT_W * RECT_H * 0.5) {
        return {
          ok: false,
          litShare,
          message: 'Part of the projected area falls outside the camera view. '
            + 'Pull the camera back so it sees the whole projection.',
        };
      }

      // How big the projection actually is in the camera - the honest number.
      const fullQuad = [[0, 0], [1, 0], [1, 1], [0, 1]].map((uv) => applyH(H, uv[0], uv[1]));
      const projArea = Math.abs(
        fullQuad[0][0] * (fullQuad[1][1] - fullQuad[3][1])
        + fullQuad[1][0] * (fullQuad[2][1] - fullQuad[0][1])
        + fullQuad[2][0] * (fullQuad[3][1] - fullQuad[1][1])
        + fullQuad[3][0] * (fullQuad[0][1] - fullQuad[2][1])
      ) / 2;
      const coverage = projArea / (CAM_W * CAM_H);

      const rectValues = [];
      for (let i = 0; i < rect.length; i++) if (rect[i] >= 0) rectValues.push(rect[i]);
      const darkCut = otsu(rectValues, 0, rectMax);
      const darkMask = new Uint8Array(RECT_W * RECT_H);
      let darkCount = 0;
      if (darkCut != null) {
        for (let i = 0; i < rect.length; i++) {
          if (rect[i] >= 0 && rect[i] < darkCut) { darkMask[i] = 1; darkCount++; }
        }
      }
      let sum = 0, n = 0;
      for (let i = 0; i < rect.length; i++) if (rect[i] >= 0 && !darkMask[i]) { sum += rect[i]; n++; }
      const wallLevel = n ? sum / n : rectMax;
      // Nothing to separate is a fine answer - a blank wall.
      const contrast = darkCount / Math.max(inside, 1);
      if (contrast > 0.6) darkMask.fill(0);

      // Where two walls meet, the second plane takes the light at a different
      // angle and comes back dimmer. That shows up as a step in the column
      // means running the full height - which is a wall corner, not a picture,
      // and wants splitting rather than framing.
      const colMean = new Float32Array(RECT_W);
      for (let i = 0; i < RECT_W; i++) {
        let sum = 0, cnt = 0;
        for (let j = 0; j < RECT_H; j++) {
          const v = rect[j * RECT_W + i];
          if (v >= 0) { sum += v; cnt++; }
        }
        colMean[i] = cnt ? sum / cnt : 0;
      }
      const smooth = new Float32Array(RECT_W);
      for (let i = 0; i < RECT_W; i++) {
        let sum = 0, cnt = 0;
        for (let k = -3; k <= 3; k++) {
          const j = i + k;
          if (j >= 0 && j < RECT_W) { sum += colMean[j]; cnt++; }
        }
        smooth[i] = sum / cnt;
      }
      let cornerAt = -1;
      let cornerStep = 0;
      // Measure the step across a baseline, not between neighbouring columns.
      // The profile is smoothed, so a sharp crease is spread over several
      // columns and a single-column gradient reads at a fraction of the real
      // difference - which is why a visible corner scored under the threshold.
      const BASE = Math.max(4, Math.round(RECT_W * 0.04));
      const plateau = (from, to) => {
        let sum = 0, cnt = 0;
        for (let k = from; k <= to; k++) {
          if (k >= 0 && k < RECT_W) { sum += smooth[k]; cnt++; }
        }
        return cnt ? sum / cnt : 0;
      };
      // Ignore the outer 12%: the projection's own edge is a step too.
      for (let i = Math.floor(RECT_W * 0.12); i < Math.floor(RECT_W * 0.88); i++) {
        const step = Math.abs(plateau(i + 2, i + 2 + BASE) - plateau(i - 2 - BASE, i - 2));
        if (step > cornerStep) { cornerStep = step; cornerAt = i; }
      }
      const cornerStrength = wallLevel > 0 ? cornerStep / wallLevel : 0;
      const corner = cornerStrength > 0.08
        ? { u: (cornerAt + 0.5) / RECT_W, strength: cornerStrength }
        : null;

      const blobs = components(darkMask, RECT_W, RECT_H, { minArea: 120 })
        .filter((b) => {
          const fill = b.area / (b.w * b.h);
          const aspect = b.w / Math.max(b.h, 1);
          const share = b.area / Math.max(inside, 1);
          // A picture is an island. A region running the full height or width,
          // or hugging an edge, is the far side of a corner or the projection
          // spilling off the surface - mapping a comp onto it would be wrong.
          const spansHeight = b.h > RECT_H * 0.85;
          const spansWidth = b.w > RECT_W * 0.85;
          const touchesEdge = b.minX <= 1 || b.maxX >= RECT_W - 2
            || b.minY <= 1 || b.maxY >= RECT_H - 2;
          if (spansHeight || spansWidth) return false;
          if (touchesEdge && share > 0.12) return false;
          return fill > 0.55 && aspect > 0.25 && aspect < 4 && share < 0.35;
        })
        .sort((a2, b2) => b2.area - a2.area)
        .slice(0, MAX_SURFACES - 1);

      // Rectified pixels ARE projector uv, so this is just a scale. Row 0 is
      // v=0, which is the bottom of the projector image.
      const frames = [];
      for (const b of blobs) {
        const u0 = clamp01((b.minX + 0.5) / RECT_W);
        const u1 = clamp01((b.maxX + 0.5) / RECT_W);
        const v0 = clamp01((b.minY + 0.5) / RECT_H);
        const v1 = clamp01((b.maxY + 0.5) / RECT_H);
        if (u1 - u0 < 0.03 || v1 - v0 < 0.03) continue;
        frames.push({
          corners: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
          area: b.area,
        });
      }

      tick(`Found ${frames.length} frame${frames.length === 1 ? '' : 's'}`
        + (corner ? ' + a wall corner' : ''));

      if (assignFrames) {
        this._saveSnapshot();
        // Surface 1 stays the wall, full frame. Detected pictures take the
        // surfaces after it, alternating between the two frame groups so two
        // pictures can show different comps.
        const map = this.app.mapping;
        params.setBase(`${map.ns(0)}.enabled`, 1);
        // The wall itself is left alone. Where two planes meet is a judgement
        // about the room, not about pixels - a detected step tells you roughly
        // where the crease is, and you put the planes on it by eye.
        const firstFrameSlot = 1;
        // Only ever write to surfaces this feature owns: ones that are switched
        // off, or that a previous run created. Running auto-map again must not
        // wipe planes you positioned by hand - and when it finds nothing, it
        // should leave every existing surface exactly as it was.
        const claimable = [];
        for (let i = firstFrameSlot; i < MAX_SURFACES; i++) {
          const off = params.get(`${map.ns(i)}.enabled`) < 0.5;
          const mine = /^Auto frame/.test(map.name(i));
          if (off || mine) claimable.push(i);
        }
        frames.forEach((f, idx) => {
          const i = claimable[idx];
          if (i === undefined) return;              // nothing free; keep what exists
          params.setBase(`${map.ns(i)}.enabled`, 1);
          params.setBase(`${map.ns(i)}.feed`, (idx % 2) + 1);
          // A detected frame is a painting. It shows the main comp until it is
          // given one of its own - varied per plane, so two paintings showing
          // the same comp do not look like two copies of it.
          params.setBase(`${map.ns(i)}.empty`, 0);
          params.setBase(`${map.ns(i)}.cropX`, 0);
          params.setBase(`${map.ns(i)}.cropW`, 1);
          for (let c = 0; c < 4; c++) map.setCorner(i, c, f.corners[c][0], f.corners[c][1]);
          map.rename(i, `Auto frame ${idx + 1}`);
          map.fitCrop(i);
        });
        // Retire leftover surfaces from an earlier auto-map, but nothing else.
        for (let k = frames.length; k < claimable.length; k++) {
          const i = claimable[k];
          if (/^Auto frame/.test(map.name(i))) params.setBase(`${map.ns(i)}.enabled`, 0);
        }
        map.onChange();
      }

      tick('Done');
      this.lastResult = {
        ok: true,
        frames,
        corner,
        homography: H,
        inverse: Hinv,
        coverage,
        litShare,
        columnProfile: Array.from(smooth, (v) => Math.round(v)),
        cornerStrength,
        residual: resid,
        wallLevel,
        quadShare,
        message: (frames.length
          ? `Mapped ${frames.length} picture frame${frames.length === 1 ? '' : 's'} `
            + `(projection fills ${(coverage * 100).toFixed(0)}% of the camera view)`
          : `Calibrated OK (projection fills ${(coverage * 100).toFixed(0)}% of the camera view), `
            + 'no picture stood out inside the projected area — check the projector '
            + 'actually covers the pictures, or place them by hand')
          + (corner
            ? ` A brightness step at ${(corner.u * 100).toFixed(0)}% across looks like a wall corner — put your wall planes there.`
            : ''),
      };
      return this.lastResult;
    } catch (e) {
      return { ok: false, message: `Calibration failed: ${e.message}` };
    } finally {
      this.app.renderer.calibration = null;
      this.running = false;
    }
  }
}
