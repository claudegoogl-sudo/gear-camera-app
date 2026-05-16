/**
 * Gear Tooth Counter — JavaScript port of algorithm/gear_tooth_counter.py
 *
 * Pipeline (mirrors the Python implementation — commit 1288b1f):
 *   1. Decode JPEG → RGBA pixel buffer
 *   2. Convert to grayscale
 *   3. CLAHE contrast enhancement + Gaussian blur + Canny edge detection
 *   4. Multi-candidate center detection via multi-threshold contour sweep
 *      with FFT purity validation
 *   5. Build candidate radii from radial edge-density peaks + outer band
 *   6. Primary: FFT at ≥85% of max contour radius (tooth-tip zone)
 *   7. Fallback: multi-radius FFT → outer-profile scan → CLAHE peak counting
 *   8. Decision rule picks final tooth count
 *
 * Entry point:
 *   import { countTeeth } from './gearCounter';
 *   const { toothCount, confidence, gearCenter, gearRadius } = await countTeeth(photoUri);
 */

import * as FileSystem from 'expo-file-system/legacy';
import { decode as jpegDecode } from 'jpeg-js';
import { fftMagnitude } from './fft';
import {
  rgbaToGray,
  gaussianBlur5x5,
  cannyEdges,
  clahe,
  smoothSignal,
  savgolSmooth,
  findPeaks,
  applyCircularMask,
} from './imageUtils';

// ── Tuning constants (match Python defaults) ──────────��─────────────────────
const MIN_TEETH       = 10;
const MIN_TEETH_CLAHE = 8;
const MAX_TEETH       = 65;
const N_ANGLES        = 1024;  // Must be power of 2 — avoids FFT zero-padding frequency shift
// Small-gear retry: if detected gear is small and confidence is low, re-run
// at higher resolution to give the FFT more pixels per tooth.
const SMALL_GEAR_RADIUS_FRAC = 0.10;   // gear radius / image width
// PAP-282: raised from 0.50 → 0.65 so off-center retry fires more aggressively
// for large gears with misleading confidence from cutout artifacts.
const SMALL_GEAR_CONF        = 0.65;
// PAP-339: restored from 1000 to 1500 to match Python.  With primary
// resolution at 900px, the high-res retry at 1500px gives large gears
// ~67% more pixels for FFT analysis.
const RETRY_MAX_DIM          = 1500;

// PAP-1100: aim-circle prior on multiRadiusFftScan candidate-radii build.
// When aimR > 0 (caller has an aim signal) the FFT sweep is constrained to
// [α·aimR, β·aimR] — prevents inner sub-harmonic aliasing at the source
// rather than detecting it post-hoc (PAP-961).  Defaults are calibration
// midpoints; PAP-1108 calibration sweep (n≥80, 4×5 grid) locks final values.
// `setAimPriorBounds(α, β)` exposed so the calibration harness can sweep
// without forking the algorithm.  Identity behaviour when aimR===0.
let _aimPriorAlpha = 0.85;
let _aimPriorBeta  = 1.20;
export function setAimPriorBounds(alpha, beta) {
  _aimPriorAlpha = alpha;
  _aimPriorBeta  = beta;
}
export function getAimPriorBounds() {
  return { alpha: _aimPriorAlpha, beta: _aimPriorBeta };
}
// ────���─────────────────────────────────────────��─────────────────────────────

// ── 1. Image loading ───────────��─────────────────────────────────────────────

// PAP-394: bilinear downsample of RGBA to targetMaxDim on the long side.
// Mirrors cv2.INTER_LINEAR with pixel-center alignment (sy = (y+0.5)*h/nh - 0.5).
// Exported so `validation.harness.js` exercises the exact same math as the
// device pipeline, keeping host/device parity structural rather than duplicated.
export function bilinearDownsampleRgba(rgba, w, h, targetMaxDim) {
  const max = Math.max(w, h);
  if (max <= targetMaxDim) return { rgba, width: w, height: h };
  const scale = targetMaxDim / max;
  const nw = Math.round(w * scale);
  const nh = Math.round(h * scale);
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = (y + 0.5) * h / nh - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < nw; x++) {
      const sx = (x + 0.5) * w / nw - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const i00 = (y0 * w + x0) * 4;
      const i01 = (y0 * w + x1) * 4;
      const i10 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      const io = (y * nw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v = (rgba[i00 + c] * (1 - fx) + rgba[i01 + c] * fx) * (1 - fy)
                + (rgba[i10 + c] * (1 - fx) + rgba[i11 + c] * fx) * fy;
        out[io + c] = Math.round(v);
      }
    }
  }
  return { rgba: out, width: nw, height: nh };
}

// PAP-394: read the ORIGINAL JPEG bytes and decode in-process, then bilinear
// downsample in JS.  The prior path (expo-image-manipulator resize + JPEG
// re-encode, then jpeg-js decode of the re-encoded file) was perturbing
// near-threshold pixel values on device — see the b86 11T→15T regression
// where the same photo decoded correctly via the host oracle but failed
// on device because ImageManipulator's native resize+recompress produced a
// different pixel buffer from the host jpeg-js path.  Reading the JPEG once
// and decoding + downsampling in JS gives host/device parity by construction.
//
// PAP-339: targetMaxDim kept at 900px (same as prior path).  The 750px
// reduction (PAP-309) caused large gear contours (21T, 24T, 28T) to be
// under-resolved for the threshold sweep and morphological ops.
async function loadAndDecodeImage(photoUri, targetMaxDim = 900) {
  const base64 = await FileSystem.readAsStringAsync(photoUri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const binary = atob(base64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);

  const { width: fw, height: fh, data: fullRgba } = jpegDecode(buf, { useTArray: true });
  const { rgba, width, height } = bilinearDownsampleRgba(fullRgba, fw, fh, targetMaxDim);
  return { width, height, rgba };
}

// ── 2. Otsu threshold ────────��───────────────────────────────────────────────

function otsuThreshold(gray, width, height) {
  const hist = new Int32Array(256);
  const n = width * height;
  for (let i = 0; i < n; i++) hist[gray[i]]++;

  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];

  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = t; }
  }
  return best;
}

// ── 3. Morphological close (dilate then erode) ──────────────────────────────
//
// Optimised: pre-compute flattened offset table as Int32 row-offsets to avoid
// per-pixel multiplication.  Short-circuit on first hit (dilate) or first
// miss (erode) is preserved.

function _buildOffsets(radius, width) {
  const offsets = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) offsets.push(dy * width + dx);
    }
  }
  return offsets;
}

function morphClose(mask, width, height, radius, _tmp, _out) {
  const n = width * height;
  const tmp = _tmp || new Uint8Array(n);
  const out = _out || new Uint8Array(n);
  if (_out) out.fill(0); // border pixels must be 0 for erode output
  const offsets = _buildOffsets(radius, width);
  const nOff = offsets.length;

  // Dilate
  for (let y = radius; y < height - radius; y++) {
    const row = y * width;
    for (let x = radius; x < width - radius; x++) {
      const idx = row + x;
      let val = 0;
      for (let k = 0; k < nOff; k++) {
        if (mask[idx + offsets[k]]) { val = 1; break; }
      }
      tmp[idx] = val;
    }
  }
  // Handle border pixels conservatively (copy mask)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (y < radius || y >= height - radius || x < radius || x >= width - radius) {
        tmp[y * width + x] = mask[y * width + x];
      }
    }
  }

  // Erode
  for (let y = radius; y < height - radius; y++) {
    const row = y * width;
    for (let x = radius; x < width - radius; x++) {
      const idx = row + x;
      let val = 1;
      for (let k = 0; k < nOff; k++) {
        if (!tmp[idx + offsets[k]]) { val = 0; break; }
      }
      out[idx] = val;
    }
  }
  return out;
}

// ── 4. Morphological open (erode then dilate) ───────────────────────────────

function morphOpen(mask, width, height, radius, _tmp, _out) {
  const n = width * height;
  const tmp = _tmp || new Uint8Array(n);
  const out = _out || new Uint8Array(n);
  if (_tmp) tmp.fill(0); // border pixels must be 0 (erode doesn't write them)
  if (_out) out.fill(0);
  const offsets = _buildOffsets(radius, width);
  const nOff = offsets.length;

  // Erode
  for (let y = radius; y < height - radius; y++) {
    const row = y * width;
    for (let x = radius; x < width - radius; x++) {
      const idx = row + x;
      let val = 1;
      for (let k = 0; k < nOff; k++) {
        if (!mask[idx + offsets[k]]) { val = 0; break; }
      }
      tmp[idx] = val;
    }
  }

  // Dilate
  for (let y = radius; y < height - radius; y++) {
    const row = y * width;
    for (let x = radius; x < width - radius; x++) {
      const idx = row + x;
      let val = 0;
      for (let k = 0; k < nOff; k++) {
        if (tmp[idx + offsets[k]]) { val = 1; break; }
      }
      out[idx] = val;
    }
  }
  return out;
}

// ── 5. Connected-component labelling (BFS) ──────────────────────────────────

function labelComponents(mask, width, height, targetVal, _labels) {
  const n = width * height;
  const labels = _labels || new Int32Array(n);
  if (_labels) labels.fill(0);
  let nextLabel = 1;
  const components = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] !== targetVal || labels[idx] !== 0) continue;

      const id = nextLabel++;
      const queue = [idx];
      labels[idx] = id;
      let area = 0, sx = 0, sy = 0;
      let minX = x, minY = y, maxX = x, maxY = y;
      let touchesBorder = false;
      let head = 0;

      while (head < queue.length) {
        const ci = queue[head++];
        const cx = ci % width;
        const cy = (ci - cx) / width;
        area++;
        sx += cx;
        sy += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        if (cx <= 1 || cy <= 1 || cx >= width - 2 || cy >= height - 2) {
          touchesBorder = true;
        }

        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const ni = ny * width + nx;
            if (mask[ni] === targetVal && labels[ni] === 0) {
              labels[ni] = id;
              queue.push(ni);
            }
          }
        }
      }

      components.push({ id, area, sx, sy, minX, minY, maxX, maxY, touchesBorder });
    }
  }

  return { labels, components };
}

// ── 6. Component perimeter ──────────────────────────────────────────────────
//
// Optimised: only scan the component's bounding box instead of the full image.

function componentPerimeter(labels, width, height, compId, minX, minY, maxX, maxY) {
  let peri = 0;
  const y0 = Math.max(0, minY);
  const y1 = Math.min(height - 1, maxY);
  const x0 = Math.max(0, minX);
  const x1 = Math.min(width - 1, maxX);
  for (let y = y0; y <= y1; y++) {
    const row = y * width;
    for (let x = x0; x <= x1; x++) {
      if (labels[row + x] !== compId) continue;
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1 ||
          labels[row + x + 1] !== compId || labels[row + x - 1] !== compId ||
          labels[(y + 1) * width + x] !== compId || labels[(y - 1) * width + x] !== compId) {
        peri++;
      }
    }
  }
  return peri;
}

// ── 6b. Component boundary points ───────────────────────────────────────────
//
// PAP-391: collects pixel coordinates along a labelled component's boundary
// so findGearCenter() can ellipse-fit the contour (parity with Python's
// `cv2.fitEllipse(cnt)`).  Mirrors the same 4-neighbour boundary definition
// used by componentPerimeter() — a pixel is on the boundary if it belongs
// to the component AND any of its 4 neighbours does not.  The result is
// strided to keep the fit cheap (≤ MAX_BOUNDARY_POINTS per contour).

const MAX_BOUNDARY_POINTS = 512;

function componentBoundary(labels, width, height, compId, minX, minY, maxX, maxY) {
  const allPts = [];
  const y0 = Math.max(0, minY);
  const y1 = Math.min(height - 1, maxY);
  const x0 = Math.max(0, minX);
  const x1 = Math.min(width - 1, maxX);
  for (let y = y0; y <= y1; y++) {
    const row = y * width;
    for (let x = x0; x <= x1; x++) {
      if (labels[row + x] !== compId) continue;
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1 ||
          labels[row + x + 1] !== compId || labels[row + x - 1] !== compId ||
          labels[(y + 1) * width + x] !== compId || labels[(y - 1) * width + x] !== compId) {
        allPts.push(x, y);
      }
    }
  }
  const total = allPts.length / 2;
  if (total <= MAX_BOUNDARY_POINTS) return allPts;
  // Uniform stride sample to cap cost of the fit.
  const stride = Math.ceil(total / MAX_BOUNDARY_POINTS);
  const out = [];
  for (let i = 0; i < total; i += stride) {
    out.push(allPts[2 * i], allPts[2 * i + 1]);
  }
  return out;
}

// ── 6b-2. Outer-rim-only boundary filter ────────────────────────────────────
//
// PAP-391: Python's `cv2.findContours(RETR_EXTERNAL)` returns only the
// OUTERMOST polyline of a binary region.  `componentBoundary` above
// returns every edge pixel of a connected region, which for ring-shaped
// cassette cogs includes both outer-rim and inner-rim pixels.  Fitting
// an ellipse to both rims skews the centre.  This helper radially
// samples the farthest boundary pixel per angular bin from the blob
// centroid so the subsequent ellipse fit sees only outer-rim points,
// matching Python's RETR_EXTERNAL semantics.

const OUTER_BOUNDARY_BINS = 180;

function outerBoundaryPoints(coords, cx, cy) {
  if (coords.length < 2) return coords;
  const bins = OUTER_BOUNDARY_BINS;
  const farthestD2 = new Float64Array(bins);
  const farthestX  = new Float64Array(bins);
  const farthestY  = new Float64Array(bins);
  const hasPt      = new Uint8Array(bins);
  const TWO_PI = 2 * Math.PI;
  for (let i = 0; i < coords.length; i += 2) {
    const x = coords[i], y = coords[i + 1];
    const dx = x - cx, dy = y - cy;
    const d2 = dx * dx + dy * dy;
    let ang = Math.atan2(dy, dx);
    if (ang < 0) ang += TWO_PI;
    let b = Math.floor((ang / TWO_PI) * bins);
    if (b >= bins) b = bins - 1;
    if (!hasPt[b] || d2 > farthestD2[b]) {
      hasPt[b] = 1;
      farthestD2[b] = d2;
      farthestX[b] = x;
      farthestY[b] = y;
    }
  }
  const out = [];
  for (let b = 0; b < bins; b++) {
    if (hasPt[b]) out.push(farthestX[b], farthestY[b]);
  }
  return out;
}

// ── 6c. Ellipse-fit center ──────────────────────────────────────────────────
//
// PAP-391: JS parity port of the `cv2.fitEllipse(cnt)` center that Python's
// `find_gear_region` applies at L156-159 of gear_tooth_counter.py.  The
// divergence was observed as JS pixel-centroid vs Python fitEllipse-center
// being 30-40 px apart on large-gear contours (05-51-49 28T: centroid
// (370,405) vs fitEllipse (338,383)); this shift moves candidates into
// the high-purity region and lets the downstream fft90 branch land the
// correct tooth count.
//
// Implementation: Direct linear least-squares solution of the general
// conic a·x² + b·xy + c·y² + d·x + e·y = 1 on mean-centered boundary
// points.  This is Fitzgibbon-style algebraic fit without the ellipse-
// specific normalisation — since we only need the centre coordinate we
// skip the eigenproblem and solve the 5x5 normal equations directly.
// Reject degenerate hyperbola/parabola cases (b² − 4ac ≥ 0) and fall
// back to the centroid when the fit is ill-conditioned.

function solveLinearSystem(A, b, n) {
  // Gaussian elimination with partial pivoting. A is modified in place;
  // returns solution vector or null on singular matrix.
  for (let k = 0; k < n; k++) {
    let piv = k, pivAbs = Math.abs(A[k][k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(A[i][k]);
      if (v > pivAbs) { piv = i; pivAbs = v; }
    }
    if (pivAbs < 1e-12) return null;
    if (piv !== k) {
      const tmp = A[k]; A[k] = A[piv]; A[piv] = tmp;
      const bt = b[k]; b[k] = b[piv]; b[piv] = bt;
    }
    const pv = A[k][k];
    for (let i = k + 1; i < n; i++) {
      const f = A[i][k] / pv;
      if (f === 0) continue;
      for (let j = k; j < n; j++) A[i][j] -= f * A[k][j];
      b[i] -= f * b[k];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x;
}

function fitEllipseCenter(coords) {
  const n = coords.length / 2;
  if (n < 5) return null;

  // Mean-center for numerical stability.
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += coords[2 * i]; my += coords[2 * i + 1]; }
  mx /= n; my /= n;

  // Normalise scale as well so x² terms stay O(1).
  let sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = coords[2 * i] - mx, dy = coords[2 * i + 1] - my;
    sx2 += dx * dx; sy2 += dy * dy;
  }
  const scale = Math.sqrt((sx2 + sy2) / n);
  if (!(scale > 0)) return null;
  const invS = 1 / scale;

  // Build AtA (5x5) and Atb (5) for the system
  //   [x² xy y² x y] · [a b c d e]ᵀ = 1.
  const AtA = [
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ];
  const Atb = [0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const x = (coords[2 * i] - mx) * invS;
    const y = (coords[2 * i + 1] - my) * invS;
    const row = [x * x, x * y, y * y, x, y];
    for (let r = 0; r < 5; r++) {
      const rv = row[r];
      for (let c = 0; c < 5; c++) AtA[r][c] += rv * row[c];
      Atb[r] += rv;
    }
  }

  const sol = solveLinearSystem(AtA, Atb, 5);
  if (!sol) return null;
  const a = sol[0], b = sol[1], c = sol[2], d = sol[3], e = sol[4];
  const disc = b * b - 4 * a * c;
  if (!(disc < -1e-8)) return null;    // not a (proper) ellipse
  const xc = (2 * c * d - b * e) / disc;
  const yc = (2 * a * e - b * d) / disc;
  if (!isFinite(xc) || !isFinite(yc)) return null;

  return { cx: xc * scale + mx, cy: yc * scale + my };
}

// ── 7. Sample intensity ring ────────────────────────────────────────────────

function sampleIntensityRing(gray, cx, cy, r, width, height, nAngles) {
  const samples = new Float64Array(nAngles);
  for (let i = 0; i < nAngles; i++) {
    const angle = (2 * Math.PI * i) / nAngles;
    const px = Math.min(Math.max(Math.round(cx + r * Math.cos(angle)), 0), width - 1);
    const py = Math.min(Math.max(Math.round(cy + r * Math.sin(angle)), 0), height - 1);
    samples[i] = gray[py * width + px];
  }
  return samples;
}

// ── 8. FFT tooth count at a single radius ───────────────────────────────────

function fftCountAtRadius(enhanced, cx, cy, r, width, height) {
  const ring = sampleIntensityRing(enhanced, cx, cy, r, width, height, N_ANGLES);

  // Smooth (window ~ N/45) — SavGol matches Python savgol_filter (PAP-288)
  const halfWin = Math.max(2, Math.floor(N_ANGLES / 90));
  const sm = savgolSmooth(ring, halfWin, true);

  // Subtract mean
  let mean = 0;
  for (let i = 0; i < sm.length; i++) mean += sm[i];
  mean /= sm.length;
  const centered = new Array(sm.length);
  for (let i = 0; i < sm.length; i++) centered[i] = sm[i] - mean;

  const mag = fftMagnitude(centered);

  // Harmonic-weighted scoring
  let bestF = MIN_TEETH, bestScore = 0, totalScore = 0;
  for (let f = MIN_TEETH; f <= MAX_TEETH && f < mag.length; f++) {
    let score = mag[f];
    if (2 * f < mag.length) score += 0.5 * mag[2 * f];
    if (3 * f < mag.length) score += 0.25 * mag[3 * f];
    totalScore += score;
    if (score > bestScore) { bestScore = score; bestF = f; }
  }

  // NOTE: Sub-harmonic doubling was previously applied here per-radius, but
  // it caused false doubling (e.g. 14T→28T) because natural 2nd harmonics
  // of real tooth profiles easily exceed the 0.4 threshold.  The Python
  // reference implementation does NOT double per-radius — sub-harmonic
  // resolution is handled at the aggregate level (fftAtOuterRadii vote
  // accumulation + decision rule consensus).  Removed in b66 (PAP-266).

  const rel = totalScore > 0 ? bestScore / totalScore : 0;
  return { tc: bestF, rel };
}

// ── 9. FFT purity check for a candidate center/radius ───────────────────────
//
// Must match Python _fft_purity_check() fidelity: 1024 angles (power of 2),
// step 2, halfWin 10 (≈21-sample Savitzky-Golay). The previous 360/step-4/win-3
// settings were too coarse and allowed corner artifacts to score higher
// purity than the actual gear, breaking center detection (PAP-103).

const PURITY_ANGLES = 1024;  // Must be power of 2 — avoids FFT zero-padding frequency shift

function fftPurityCheck(enhanced, cx, cy, r, width, height, fast = false) {
  const lo = Math.floor(r * 0.85);
  const hi = Math.min(Math.floor(r * 1.10), Math.min(cx, width - cx, cy, height - cy) - 1);
  if (lo >= hi || lo < 10) return 0.0;

  // Fast mode: 256 angles, 4 sample radii, moving average — ~12× faster,
  // suitable for coarse grid search screening.
  const nAngles = fast ? 256 : PURITY_ANGLES;
  let radii;
  if (fast) {
    const span = hi - lo;
    if (span < 4) {
      radii = [lo + Math.floor(span / 2)];
    } else {
      radii = [];
      for (let i = 0; i < 4; i++) radii.push(lo + Math.floor(i * span / 3));
    }
  } else {
    radii = [];
    for (let rv = lo; rv <= hi; rv += 2) radii.push(rv);
  }

  const fftVotes = {};
  for (const rv of radii) {
    const ring = sampleIntensityRing(enhanced, cx, cy, rv, width, height, nAngles);
    let sm;
    if (fast) {
      // Simple moving average for speed
      const halfWin = Math.max(1, Math.floor(nAngles / 90));
      sm = smoothSignal(ring, halfWin, true);
    } else {
      // SavGol(21, 3) matches Python _fft_purity_check (PAP-288)
      const halfWin = 10;
      sm = savgolSmooth(ring, halfWin, true);
    }

    let smMin = Infinity, smMax = -Infinity;
    for (let i = 0; i < sm.length; i++) {
      if (sm[i] < smMin) smMin = sm[i];
      if (sm[i] > smMax) smMax = sm[i];
    }
    if (smMax - smMin < 5) continue;

    let mean = 0;
    for (let i = 0; i < sm.length; i++) mean += sm[i];
    mean /= sm.length;
    const centered = new Array(sm.length);
    for (let i = 0; i < sm.length; i++) centered[i] = sm[i] - mean;

    const mag = fftMagnitude(centered);
    for (let freq = MIN_TEETH; freq <= MAX_TEETH && freq < mag.length; freq++) {
      fftVotes[freq] = (fftVotes[freq] || 0) + mag[freq];
    }
  }

  const entries = Object.values(fftVotes);
  if (entries.length === 0) return 0.0;
  const total = entries.reduce((a, b) => a + b, 0);
  const best = Math.max(...entries);
  return total > 0 ? best / total : 0.0;
}

// ── 9b. FFT dominant frequency for a candidate (PAP-324) ────────────────
//
// Same FFT accumulation as fftPurityCheck (full mode) but also returns the
// dominant frequency.  Used by the frequency plausibility guard to reject
// inner-hub or background candidates whose dominant frequency is outside
// the valid tooth range.

function fftDominantFreq(enhanced, cx, cy, r, width, height) {
  const lo = Math.floor(r * 0.85);
  const hi = Math.min(Math.floor(r * 1.10), Math.min(cx, width - cx, cy, height - cy) - 1);
  if (lo >= hi || lo < 10) return { purity: 0.0, freq: 0 };

  const nAngles = PURITY_ANGLES;
  const fftVotes = {};
  for (let rv = lo; rv <= hi; rv += 2) {
    const ring = sampleIntensityRing(enhanced, cx, cy, rv, width, height, nAngles);
    const halfWin = 10;
    const sm = savgolSmooth(ring, halfWin, true);

    let smMin = Infinity, smMax = -Infinity;
    for (let i = 0; i < sm.length; i++) {
      if (sm[i] < smMin) smMin = sm[i];
      if (sm[i] > smMax) smMax = sm[i];
    }
    if (smMax - smMin < 5) continue;

    let mean = 0;
    for (let i = 0; i < sm.length; i++) mean += sm[i];
    mean /= sm.length;
    const centered = new Array(sm.length);
    for (let i = 0; i < sm.length; i++) centered[i] = sm[i] - mean;

    const mag = fftMagnitude(centered);
    for (let freq = MIN_TEETH; freq <= MAX_TEETH && freq < mag.length; freq++) {
      fftVotes[freq] = (fftVotes[freq] || 0) + mag[freq];
    }
  }

  if (Object.keys(fftVotes).length === 0) return { purity: 0.0, freq: 0 };
  const total = Object.values(fftVotes).reduce((a, b) => a + b, 0);
  let bestFreq = 0, bestVal = 0;
  for (const [f, v] of Object.entries(fftVotes)) {
    if (v > bestVal) { bestVal = v; bestFreq = Number(f); }
  }
  return { purity: total > 0 ? bestVal / total : 0.0, freq: bestFreq };
}

// ── 9a. Center refinement via FFT purity maximisation ─────────────────────
//
// After initial center detection, refine by searching for the point that
// maximises rotational symmetry (FFT spectral purity). Two-pass grid search:
// coarse (±25px, step 5) then fine (±5px, step 1).
// Only accepts the refined center when:
//   - shift ≥ 3px (avoids noise),
//   - purity gain > 15%, and
//   - refined purity ≥ 0.14 (clean tooth signal required).
//
// PAP-162: coarse pass expanded from ±15px to ±25px to match Python PAP-154.

function refineCenterBySymmetry(enhanced, cx, cy, r, width, height) {
  function search(cx0, cy0, radius, halfRange, step, fast = false) {
    let bestCx = cx0, bestCy = cy0;
    let bestP = fftPurityCheck(enhanced, cx0, cy0, radius, width, height, fast);
    for (let dx = -halfRange; dx <= halfRange; dx += step) {
      for (let dy = -halfRange; dy <= halfRange; dy += step) {
        if (dx === 0 && dy === 0) continue;
        const ncx = cx0 + dx, ncy = cy0 + dy;
        if (ncx < 10 || ncy < 10 || ncx >= width - 10 || ncy >= height - 10) continue;
        const p = fftPurityCheck(enhanced, ncx, ncy, radius, width, height, fast);
        if (p > bestP) {
          bestP = p;
          bestCx = ncx;
          bestCy = ncy;
        }
      }
    }
    return { cx: bestCx, cy: bestCy, purity: bestP };
  }

  const origPurity = fftPurityCheck(enhanced, cx, cy, r, width, height);

  // PAP-313 port: size-gate center refinement — large gears (r > 120)
  // may have detected center on inner hub feature up to 40+ px from
  // actual gear center; use wider coarse search with fast purity.
  // Small gears keep the tighter search to avoid drifting to wrong features.
  let coarse, acceptThreshold;
  if (r > 120) {
    coarse = search(cx, cy, r, 40, 10, true);
    const fine0 = search(coarse.cx, coarse.cy, r, 5, 2);
    acceptThreshold = Math.max(0.06, Math.min(0.14, origPurity * 1.5));
    coarse = fine0; // use fine result as the output of the two-pass
  } else {
    // PAP-309: coarse pass uses fast purity (~12× cheaper per call)
    coarse = search(cx, cy, r, 25, 8, true);
    acceptThreshold = 0.14;
  }
  // Fine pass (±4px, step 2 — full purity for precision)
  const fine = search(coarse.cx, coarse.cy, r, 4, 2);

  const shift = Math.sqrt((fine.cx - cx) ** 2 + (fine.cy - cy) ** 2);
  if (shift >= 3 && origPurity > 0 && fine.purity > origPurity * 1.15 && fine.purity >= acceptThreshold) {
    return { cx: fine.cx, cy: fine.cy };
  }
  return { cx, cy };
}

// ── 9b. Hough-like circle candidate detection ──────────────────────────────
//
// Simplified Hough circle detection for JS (no OpenCV available).
// Uses edge-ring accumulation: for a coarse grid of candidate centers,
// builds a distance histogram from edge pixels and finds the radius with
// the most edge support (normalized by circumference).
// Only called when contour FFT purity is weak (< 0.10).

function findHoughCircleCandidates(edges, width, height, minRadius, maxRadius) {
  const w = width, h = height;

  // Pre-collect edge pixel coordinates (subsample if too many for speed)
  const edgeX = [], edgeY = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (edges[y * w + x] > 0) { edgeX.push(x); edgeY.push(y); }
    }
  }
  const maxEdgePx = 4000;
  let step = 1;
  if (edgeX.length > maxEdgePx) step = Math.ceil(edgeX.length / maxEdgePx);

  // Coarse grid search for candidate centers
  const gridStep = Math.max(15, Math.floor(Math.min(w, h) / 20));
  const raw = [];

  for (let cy = gridStep; cy < h - gridStep; cy += gridStep) {
    for (let cx = gridStep; cx < w - gridStep; cx += gridStep) {
      const rBins = new Int32Array(maxRadius + 1);
      for (let i = 0; i < edgeX.length; i += step) {
        const dx = edgeX[i] - cx;
        const dy = edgeY[i] - cy;
        const d = Math.round(Math.sqrt(dx * dx + dy * dy));
        if (d >= minRadius && d <= maxRadius) rBins[d]++;
      }

      // Smooth bins and find peak radius
      let bestR = 0, bestScore = 0;
      for (let r = minRadius; r <= maxRadius; r++) {
        let sum = 0, cnt = 0;
        for (let dr = -2; dr <= 2; dr++) {
          const rr = r + dr;
          if (rr >= minRadius && rr <= maxRadius) { sum += rBins[rr]; cnt++; }
        }
        const norm = (sum / cnt) / (2 * Math.PI * r);
        if (norm > bestScore) { bestScore = norm; bestR = r; }
      }

      if (bestScore > 0.03) {
        raw.push({ cx, cy, r: bestR, score: bestScore });
      }
    }
  }

  // Sort by score, non-maximum suppression with minDist=100
  raw.sort((a, b) => b.score - a.score);
  const result = [];
  for (const c of raw) {
    let tooClose = false;
    for (const r of result) {
      const dist = Math.sqrt((c.cx - r.cx) ** 2 + (c.cy - r.cy) ** 2);
      if (dist < 100) { tooClose = true; break; }
    }
    if (!tooClose) result.push(c);
    if (result.length >= 3) break;
  }

  return result;
}

// ── 10. Multi-candidate center detection (multi-threshold contour sweep) ────
//
// Mirrors Python find_gear_region(): sweeps thresholds in both polarities,
// finds contour candidates, deduplicates by proximity, validates with FFT
// purity, and picks the best candidate.

function findGearCenter(gray, enhanced, edges, width, height) {
  const h = height, w = width;
  const n = w * h;

  let result = null;
  let resultPurity = 0;   // FFT purity of the chosen candidate (0 for fallback paths)

  const allCandidates = [];

  // PAP-555: pre-allocate work buffers for the sweep loop to avoid
  // ~350MB of short-lived Uint8Array/Int32Array allocations (36 iterations
  // × ~8 arrays each).  Reuse across iterations — zero accuracy change.
  const sweepBufA = new Uint8Array(n);
  const sweepBufC = new Uint8Array(n);
  const sweepLabels = new Int32Array(n);

  // PAP-588 Phase 2 (Option E): run morphological close/open at half
  // resolution, then NN-upsample the cleaned mask to full-res for
  // connected-component labeling.  Cuts findGearCenter's morph cost ~4×
  // (the dominant term in the sweep) while keeping labeling, area
  // thresholds, and component boundary geometry at full resolution so no
  // constants need rescaling.  Approved per PAP-588 cross-check; morphOpen
  // radius is held at r=1 (r=0 would be a no-op via _buildOffsets).
  const halfW = w >> 1;
  const halfH = h >> 1;
  const halfN = halfW * halfH;
  const halfBufA = new Uint8Array(halfN);
  const halfBufB = new Uint8Array(halfN);
  const halfBufC = new Uint8Array(halfN);

  // Sweep thresholds 40–220 in steps of 10 (PAP-346: reduced from 15 to
  // improve contour candidate coverage for large gears — Python uses
  // step=5 but 10 is a reasonable mobile compromise.  18 iterations vs
  // the previous 12, matching Python more closely without the full 36).
  for (let thresh = 40; thresh < 220; thresh += 10) {
    for (const invert of [true, false]) {
      // Build full-res mask in sweepBufA, then OR-downsample 2× to halfBufA.
      // OR-downsample (any of the 2×2 block is foreground) is more
      // conservative for thin-stroke features than top-left NN, which
      // matters because the threshold sweep relies on foreground continuity
      // for the morphClose chain to bridge gear-tooth gaps reliably.
      for (let i = 0; i < n; i++) {
        sweepBufA[i] = invert ? (gray[i] <= thresh ? 1 : 0) : (gray[i] > thresh ? 1 : 0);
      }
      for (let y = 0; y < halfH; y++) {
        const sy0 = y * 2;
        const sy1 = sy0 + 1;
        const r0 = sy0 * w;
        const r1 = sy1 * w;
        const dstRow = y * halfW;
        for (let x = 0; x < halfW; x++) {
          const sx0 = x * 2;
          const sx1 = sx0 + 1;
          halfBufA[dstRow + x] =
            (sweepBufA[r0 + sx0] | sweepBufA[r0 + sx1] |
             sweepBufA[r1 + sx0] | sweepBufA[r1 + sx1]) ? 1 : 0;
        }
      }

      // Morphological close (×2) then open at half-resolution.
      // PAP-324: apply close twice (matching Python iterations=2) for
      // more aggressive gap-bridging — critical for separating gears
      // from white paper backgrounds on medium-large cassette cogs.
      // Kernel scaling: at half-resolution, a r=1 cross corresponds to
      // ~r=2 disk in full-res equivalents (the kernel reach doubles after
      // NN upsample), so r=1 close at half-res preserves the original
      // full-res r=2 close semantics rather than the prior r=2 half-res
      // attempt which was effectively r=4 and over-merged spider arms.
      // halfBufA → halfBufC (close1), halfBufA reused as out for close2,
      // halfBufC reused as out for open — strict ABA→C→A→C ping-pong.
      const halfClosed1 = morphClose(halfBufA, halfW, halfH, 1, halfBufB, halfBufC);
      const halfClosed = morphClose(halfClosed1, halfW, halfH, 1, halfBufB, halfBufA);
      const halfCleaned = morphOpen(halfClosed, halfW, halfH, 1, halfBufB, halfBufC);

      // NN-upsample halfCleaned to sweepBufA at full resolution. Each
      // half-res pixel paints a 2×2 block in the full-res mask, which
      // produces a slight staircase along component edges but preserves
      // component identity, area, and bounding box at full-res granularity.
      for (let y = 0; y < h; y++) {
        const sy = y >> 1;
        const srcRow = (sy < halfH ? sy : halfH - 1) * halfW;
        const dstRow = y * w;
        for (let x = 0; x < w; x++) {
          const sx = x >> 1;
          sweepBufA[dstRow + x] = halfCleaned[srcRow + (sx < halfW ? sx : halfW - 1)];
        }
      }
      const cleaned = sweepBufA;

      // Label components (reuse sweepLabels)
      const { labels, components } = labelComponents(cleaned, w, h, 1, sweepLabels);

      for (const comp of components) {
        if (comp.area < 1000 || comp.area > 0.5 * n) continue;
        if (comp.touchesBorder) continue;

        const bw = comp.maxX - comp.minX + 1;
        const bh = comp.maxY - comp.minY + 1;

        // Aspect ratio check
        if (Math.min(bw, bh) / Math.max(bw, bh) < 0.5) continue;

        // Border margin
        const margin = 5;
        if (comp.minX <= margin || comp.minY <= margin ||
            comp.maxX >= w - margin || comp.maxY >= h - margin) continue;

        // Radius estimate: use bounding-box radius for annular shapes,
        // area-based encR for solid blobs, whichever is larger.
        // For ring-shaped cassette cogs, bboxR ≈ outer radius; the 0.90
        // factor accounts for slight non-circularity while preserving
        // the outer-tooth region (previously 0.70, which underestimated
        // outer radius by 15-20% for annular shapes).
        const encR = Math.sqrt(comp.area / Math.PI);
        const bboxR = Math.max(bw, bh) / 2;
        const effectiveR = Math.max(encR, bboxR * 0.90);
        if (effectiveR / Math.min(h, w) < 0.08 || effectiveR / Math.min(h, w) > 0.48) continue;

        const peri = componentPerimeter(labels, w, h, comp.id, comp.minX, comp.minY, comp.maxX, comp.maxY);
        const circ = peri > 0 ? (4 * Math.PI * comp.area) / (peri * peri) : 0;
        const compact = comp.area / (bw * bh);

        // Reject candidates whose center is too close to the frame edge.
        // A gear center at 94% across / 10% down is clearly a background
        // artifact — real gears should be roughly centered in the aim circle.
        let compCx = comp.sx / comp.area;
        let compCy = comp.sy / comp.area;
        // PAP-391: refine centroid via ellipse-fit on the contour boundary
        // (parity with Python's cv2.fitEllipse at L156-159).  The pixel
        // centroid is biased toward denser blob regions (e.g. hub +
        // spider arms on cassette cogs); the ellipse centre lands on the
        // geometric gear centre and shifts large-gear candidates into the
        // high-FFT-purity region so the downstream fft90 branch can
        // recover the correct tooth count.  Edge-margin and centre-bias
        // checks use the refined centre.
        const rawBoundary = componentBoundary(
          labels, w, h, comp.id,
          comp.minX, comp.minY, comp.maxX, comp.maxY,
        );
        const outerBoundary = outerBoundaryPoints(rawBoundary, compCx, compCy);
        const ellC = fitEllipseCenter(outerBoundary);
        if (ellC !== null) {
          const bxMin = comp.minX - 2, bxMax = comp.maxX + 2;
          const byMin = comp.minY - 2, byMax = comp.maxY + 2;
          if (ellC.cx >= bxMin && ellC.cx <= bxMax &&
              ellC.cy >= byMin && ellC.cy <= byMax) {
            compCx = ellC.cx;
            compCy = ellC.cy;
          }
        }

        const edgeMarginFrac = 0.10;
        if (compCx < w * edgeMarginFrac || compCx > w * (1 - edgeMarginFrac) ||
            compCy < h * edgeMarginFrac || compCy > h * (1 - edgeMarginFrac)) continue;
        const dx = (compCx - w / 2) / (w / 2);
        const dy = (compCy - h / 2) / (h / 2);
        const centerBias = Math.exp(-1.5 * (dx * dx + dy * dy));

        const score = circ * compact * Math.pow(comp.area, 0.3) * centerBias;
        const cx = Math.round(compCx);
        const cy = Math.round(compCy);
        const r = Math.round(effectiveR);

        allCandidates.push({ score, cx, cy, r });
      }
    }
  }

  // Deduplicate: keep highest score per (center, radius) neighborhood
  allCandidates.sort((a, b) => b.score - a.score);
  const topCandidates = [];
  for (const cand of allCandidates) {
    let duplicate = false;
    for (const t of topCandidates) {
      if (Math.abs(cand.cx - t.cx) < 30 && Math.abs(cand.cy - t.cy) < 30 &&
          Math.abs(cand.r - t.r) < 20) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) topCandidates.push(cand);
    if (topCandidates.length >= 5) break;
  }

  // FFT purity check on contour candidates
  if (topCandidates.length > 0) {
    let bestPurity = -1;
    let bestIdx = 0;
    // Evaluate purity for all candidates and store it
    const purities = new Array(topCandidates.length);
    for (let i = 0; i < topCandidates.length; i++) {
      const c = topCandidates[i];
      purities[i] = fftPurityCheck(enhanced, c.cx, c.cy, c.r, w, h);
      if (purities[i] > bestPurity) {
        bestPurity = purities[i];
        bestIdx = i;
      }
    }
    // ── Hough-like circle candidates ──────────────────────────────────
    // PAP-282: raised threshold from 0.10 → 0.15 so Hough circles run for
    // large cassette cogs where contour detection picks up cutout holes
    // with moderate purity (0.08–0.12).  Hough detects actual circular gear
    // outlines that contours miss due to teeth lowering circularity.
    if (bestPurity < 0.15) {
      const maxContourR = Math.max(...topCandidates.map(c => c.r), 0);
      // PAP-288: lowered minRadius from /4 to /6 so Hough detects large
      // cassette cogs (28T) that fill ~20-25% of image width.
      const houghCands = findHoughCircleCandidates(
        edges, w, h,
        Math.floor(Math.min(h, w) / 6),
        Math.floor(Math.min(h, w) / 2),
      );
      for (const hc of houghCands) {
        const margin = 5;
        if (!(margin < hc.cx && hc.cx < w - margin
              && margin < hc.cy && hc.cy < h - margin)) continue;
        const edgeDist = Math.min(hc.cx, w - hc.cx, hc.cy, h - hc.cy);
        if (edgeDist < hc.r * 0.92) continue;
        if (maxContourR > 0 && hc.r > maxContourR * 2) continue;
        let duplicate = false;
        for (const t of topCandidates) {
          if (Math.abs(hc.cx - t.cx) < 30 && Math.abs(hc.cy - t.cy) < 30
              && Math.abs(hc.r - t.r) < 20) {
            duplicate = true;
            break;
          }
        }
        // PAP-288: evaluate Hough purity even for near-duplicate contour
        // candidates.  Contour and Hough may detect the same feature with
        // different radii; the Hough radius can yield better FFT purity.
        const hcPurity = fftPurityCheck(enhanced, hc.cx, hc.cy, hc.r, w, h);
        const houghAdjPurity = hcPurity * 1.10;
        if (houghAdjPurity > bestPurity) {
          if (!duplicate) {
            topCandidates.push({ score: 0, cx: hc.cx, cy: hc.cy, r: hc.r });
          } else {
            topCandidates.push({ score: 0, cx: hc.cx, cy: hc.cy, r: hc.r });
          }
          const idx = topCandidates.length - 1;
          purities[idx] = hcPurity;
          bestPurity = hcPurity;
          bestIdx = idx;
        } else if (!duplicate) {
          topCandidates.push({ score: 0, cx: hc.cx, cy: hc.cy, r: hc.r });
          purities[topCandidates.length - 1] = hcPurity;
        }
      }
    }

    // ── PAP-346: Center-distance weighted purity (port of PAP-313) ────
    // When ALL candidates have low raw purity (< 0.10), the gear is
    // likely a large cog with spider-arm cutouts where inner hub features
    // or corner artifacts match the weak outer-tooth signal.  Center
    // weighting penalizes candidates far from the viewfinder aim circle.
    // Skipped when any candidate has strong purity (>= 0.10) to avoid
    // overriding confidently detected small/medium gears that may be
    // slightly off-center.
    if (Math.max(...purities) < 0.10) {
      const imgCx = w / 2, imgCy = h / 2;
      const maxDist = Math.max(1.0, Math.sqrt(imgCx * imgCx + imgCy * imgCy));
      let bestWeighted = -1.0;
      for (let i = 0; i < topCandidates.length; i++) {
        const dist = Math.sqrt(
          (topCandidates[i].cx - imgCx) ** 2 +
          (topCandidates[i].cy - imgCy) ** 2);
        const cw = Math.max(0.5, 1.0 - 0.5 * (dist / maxDist));
        const weighted = (purities[i] || 0) * cw;
        if (weighted > bestWeighted) {
          bestWeighted = weighted;
          bestIdx = i;
          bestPurity = purities[i] || 0;
        }
      }
    }

    // ── PAP-324: Frequency plausibility guard (port of PAP-313) ──────
    // Check if the selected candidate's dominant FFT frequency is in the
    // valid tooth range.  Inner hub splines and background artifacts often
    // have high purity but dominant frequency outside [MIN_TEETH, MAX_TEETH].
    // If so, override to a larger candidate with plausible frequency.
    {
      const sel = topCandidates[bestIdx];
      const { purity: selPurity, freq: selFreq } = fftDominantFreq(
        enhanced, sel.cx, sel.cy, sel.r, w, h);
      const purityFloor = Math.max(0.03, bestPurity * 0.30);

      if (selFreq < MIN_TEETH || selFreq > MAX_TEETH) {
        // Selected candidate's frequency is implausible — search for a
        // larger candidate with valid tooth frequency.
        let bestOverride = null;
        let bestOverridePurity = 0;
        for (let i = 0; i < topCandidates.length; i++) {
          if (i === bestIdx) continue;
          const lc = topCandidates[i];
          if (lc.r <= sel.r * 1.10) continue;          // must be larger
          if ((purities[i] || 0) < purityFloor) continue;
          if (lc.r > Math.min(h, w) * 0.45) continue;  // max radius cap
          const { freq: lcFreq, purity: lcPurity } = fftDominantFreq(
            enhanced, lc.cx, lc.cy, lc.r, w, h);
          if (lcFreq >= MIN_TEETH && lcFreq <= MAX_TEETH && lcPurity > bestOverridePurity) {
            bestOverride = i;
            bestOverridePurity = lcPurity;
          }
        }
        if (bestOverride !== null) {
          bestIdx = bestOverride;
          bestPurity = purities[bestIdx] || 0;
          console.log(`[GearCenter] freq plausibility override: freq ${selFreq} → ` +
            `candidate #${bestIdx} r=${topCandidates[bestIdx].r}`);
        }
      }
    }

    const winner = topCandidates[bestIdx];
    // Refine center by maximizing rotational symmetry
    const refined = refineCenterBySymmetry(enhanced, winner.cx, winner.cy, winner.r, w, h);
    result = { cx: refined.cx, cy: refined.cy, radius: winner.r, method: 'multi-threshold' };
    resultPurity = purities[bestIdx] || 0;
  }

  // Fallback: single Otsu + donut detection (original JS approach)
  const otsuT = otsuThreshold(gray, w, h);
  const darkMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) darkMask[i] = gray[i] <= otsuT ? 1 : 0;

  const closedDark = morphClose(darkMask, w, h, 2);
  const { labels: darkLabels, components: darkComps } =
    labelComponents(closedDark, w, h, 1);
  const { components: lightComps } = labelComponents(closedDark, w, h, 0);

  const darkHasHole = new Set();
  for (const lc of lightComps) {
    if (lc.touchesBorder || lc.area < 50) continue;
    const checkX = Math.max(0, lc.minX - 1);
    const checkY = Math.max(0, lc.minY - 1);
    const parentId = darkLabels[checkY * w + checkX];
    if (parentId > 0) darkHasHole.add(parentId);
  }

  let bestComp = null, bestScore = -1;
  for (const dc of darkComps) {
    if (dc.area < 300 || dc.area > 0.5 * n || dc.touchesBorder) continue;
    const peri = componentPerimeter(darkLabels, w, h, dc.id, dc.minX, dc.minY, dc.maxX, dc.maxY);
    const circ = peri > 0 ? (4 * Math.PI * dc.area) / (peri * peri) : 0;
    const hasHole = darkHasHole.has(dc.id);
    // Center-of-frame bias for Otsu fallback too
    const dcCx = dc.sx / dc.area;
    const dcCy = dc.sy / dc.area;
    const ddx = (dcCx - w / 2) / (w / 2);
    const ddy = (dcCy - h / 2) / (h / 2);
    const cBias = Math.exp(-1.5 * (ddx * ddx + ddy * ddy));
    const score = circ * (hasHole ? 1.5 : 1.0) * cBias;
    if (score > bestScore) {
      bestScore = score;
      bestComp = dc;
    }
  }

  if (!result && bestComp) {
    // Use bbox radius for annular shapes (area-based underestimates)
    const dcBw = bestComp.maxX - bestComp.minX + 1;
    const dcBh = bestComp.maxY - bestComp.minY + 1;
    const areaR = Math.sqrt(bestComp.area / Math.PI);
    const bboxR2 = Math.max(dcBw, dcBh) / 2;
    result = {
      cx: Math.round(bestComp.sx / bestComp.area),
      cy: Math.round(bestComp.sy / bestComp.area),
      radius: Math.round(Math.max(areaR, bboxR2 * 0.90)),
      method: 'otsu-contour',
    };
  }

  // Final fallback: center-weighted edge centroid with tight Gaussian
  // Use a narrow sigma to strongly bias toward center and reject corner artifacts
  if (!result) {
    const cx0 = w / 2, cy0 = h / 2;
    const sigX = w * 0.18, sigY = h * 0.18;
    let wsx = 0, wsy = 0, wsum = 0;
    for (let y = 0; y < h; y++) {
      const dyN = (y - cy0) / sigY;
      const wy = Math.exp(-dyN * dyN);
      for (let x = 0; x < w; x++) {
        if (edges[y * w + x] > 0) {
          const dxN = (x - cx0) / sigX;
          const wt = wy * Math.exp(-dxN * dxN);
          wsx += x * wt; wsy += y * wt; wsum += wt;
        }
      }
    }
    if (wsum === 0) {
      result = { cx: Math.floor(cx0), cy: Math.floor(cy0), radius: 0, method: 'fallback' };
    } else {
      // Estimate radius from weighted edge spread around found center
      const fcx = Math.round(wsx / wsum);
      const fcy = Math.round(wsy / wsum);
      let rSum = 0, rCnt = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (edges[y * w + x] > 0) {
            const d = Math.sqrt((x - fcx) ** 2 + (y - fcy) ** 2);
            const dxN = (x - cx0) / sigX;
            const dyN = (y - cy0) / sigY;
            const wt = Math.exp(-(dxN * dxN + dyN * dyN));
            rSum += d * wt;
            rCnt += wt;
          }
        }
      }
      const estR = rCnt > 0 ? Math.round(rSum / rCnt) : 0;
      result = { cx: fcx, cy: fcy, radius: estR, method: 'edge-centroid' };
    }
  }

  // ── PAP-684: Edge-density radius fallback for spider chainrings ───────
  // When the detected radius is suspiciously small (likely inner-feature
  // lockup on bolt holes / BCD circle), use radial edge density to find
  // the outer tooth ring.  Applies to ALL detection paths (multi-threshold,
  // Otsu, edge-centroid) per QA condition #1.
  // Gated on:
  //   - normalized radius < 0.15 (inner-feature suspected)
  //   - purity < 0.20 at current pick (QA condition #4 — protects
  //     11–15T tight-aimCrop edge cases from noisy outer-edge overrides)
  const normR = result.radius / Math.min(h, w);
  if (normR < 0.15 && resultPurity < 0.20) {
    // QA condition #3: try candidate center first, image center as 2nd pass
    const centers = [
      { cx: result.cx, cy: result.cy },
      { cx: Math.floor(w / 2), cy: Math.floor(h / 2) },
    ];
    let bestEdgeR = null;
    let bestEdgePurity = resultPurity;
    let bestEdgeCenter = null;

    for (const center of centers) {
      // Bounds check: findGearRadius needs margin from edges
      if (center.cx < 10 || center.cx > w - 10 ||
          center.cy < 10 || center.cy > h - 10) continue;
      const edgeR = findGearRadius(edges, center.cx, center.cy, w, h);
      const edgeNormR = edgeR / Math.min(h, w);
      if (edgeNormR > 0.20 && edgeR > result.radius * 2) {
        const p = fftPurityCheck(enhanced, center.cx, center.cy, edgeR, w, h);
        if (p > bestEdgePurity) {
          bestEdgeR = edgeR;
          bestEdgePurity = p;
          bestEdgeCenter = center;
        }
      }
    }

    if (bestEdgeR !== null) {
      const refined = refineCenterBySymmetry(
        enhanced, bestEdgeCenter.cx, bestEdgeCenter.cy, bestEdgeR, w, h);
      console.log(
        `[GearCenter] PAP-684 edge-density override: r=${result.radius}→${bestEdgeR} ` +
        `normR=${normR.toFixed(3)}→${(bestEdgeR / Math.min(h, w)).toFixed(3)} ` +
        `purity=${bestEdgePurity.toFixed(3)} from ${result.method}`);
      result = { cx: refined.cx, cy: refined.cy, radius: bestEdgeR, method: 'edge-density-fallback' };
    }
  }

  return result;
}

// ── 11. Radial edge-density → gear radius ─────���─────────────────────────────

function findGearRadius(edges, cx, cy, width, height) {
  const maxR = Math.floor(Math.min(cx, width - cx, cy, height - cy)) - 1;
  const density = new Float64Array(maxR);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (edges[y * width + x] > 0) {
        const d = Math.round(Math.sqrt((x - cx) ** 2 + (y - cy) ** 2));
        if (d < maxR) density[d]++;
      }
    }
  }

  const halfWin = Math.max(2, Math.floor(maxR / 16));
  const smooth = smoothSignal(density, halfWin);
  const cap = Math.floor(maxR * 0.90);

  const maxVal = Math.max(...smooth.slice(0, cap));
  const minPeakHeight = maxVal * 0.12;
  const peaks = [];
  for (let r = 1; r < cap - 1; r++) {
    if (smooth[r] > smooth[r-1] && smooth[r] > smooth[r+1] && smooth[r] >= minPeakHeight) {
      peaks.push(r);
    }
  }

  return peaks.length > 0 ? peaks[peaks.length - 1] : Math.floor(maxR * 0.5);
}

// ── 12. FFT at ≥85% of max contour radius (primary method) ─────────────────
//
// Mirrors Python _fft_at_90pct(): uses CLAHE-enhanced image, samples at
// radii ≥85% of the max contour radius, accumulates FFT votes per frequency,
// and returns the winning tooth count. Avoids inner hub/bore interference.

function fftAtOuterRadii(enhanced, cx, cy, contourRadius, gearRadius, edges, width, height) {
  const maxRUse = Math.max(contourRadius, gearRadius);
  if (maxRUse < 20) return 0;

  // Scan from 85% to 115% of max radius — matches Python _fft_at_90pct().
  // Previously 70%, but since bboxR factor was raised to 0.90 (commit 2dad86a)
  // the contour radius is accurate enough that starting at 85% avoids inner
  // features (spider arms, cutout holes) on large gears like 28T cassette cogs
  // which contaminate the FFT vote with spurious frequencies (PAP-203).
  const thresholdR = Math.floor(maxRUse * 0.85);
  const maxRScan = Math.min(
    Math.floor(maxRUse * 1.15),
    Math.min(cx, width - cx, cy, height - cy) - 1,
  );

  if (thresholdR >= maxRScan || thresholdR < 10) return 0;

  const fftVotes = {};
  for (let rv = thresholdR; rv <= maxRScan; rv += 2) {
    if (rv < 10) continue;

    const ring = sampleIntensityRing(enhanced, cx, cy, rv, width, height, N_ANGLES);
    // SavGol(21, 3) matches Python _fft_at_90pct savgol_filter (PAP-288)
    const halfWin = 10;
    const sm = savgolSmooth(ring, halfWin, true);

    let smMin = Infinity, smMax = -Infinity;
    for (let i = 0; i < sm.length; i++) {
      if (sm[i] < smMin) smMin = sm[i];
      if (sm[i] > smMax) smMax = sm[i];
    }
    if (smMax - smMin < 5) continue;

    let mean = 0;
    for (let i = 0; i < sm.length; i++) mean += sm[i];
    mean /= sm.length;
    const centered = new Array(sm.length);
    for (let i = 0; i < sm.length; i++) centered[i] = sm[i] - mean;

    const mag = fftMagnitude(centered);
    // Radius-weighted voting (PAP-280): weight outer radii more heavily.
    // Inner radii are contaminated by spider-arm cutouts and splines on
    // large cassette cogs, producing spurious sub-harmonic votes that
    // overpower the actual tooth frequency.  Linear ramp: 50% at inner
    // edge, 100% at outer edge.
    const radialWeight = 0.5 + 0.5 * (rv - thresholdR) / Math.max(1, maxRScan - thresholdR);
    for (let freq = MIN_TEETH; freq <= MAX_TEETH && freq < mag.length; freq++) {
      fftVotes[freq] = (fftVotes[freq] || 0) + mag[freq] * radialWeight;
    }
  }

  if (Object.keys(fftVotes).length === 0) return 0;

  let bestFreq = 0, bestVal = 0;
  for (const [freq, val] of Object.entries(fftVotes)) {
    if (val > bestVal) { bestVal = val; bestFreq = Number(freq); }
  }

  // Sub-harmonic doubling: if 2×bestFreq has ≥60% of the votes,
  // the winner is likely a sub-harmonic of the actual tooth frequency.
  // Threshold raised from 0.4 to 0.6 (PAP-266) — the lower threshold
  // caused false doubling when contour radius was wrong, leading the scan
  // to sample inner features (cutouts, splines) whose harmonics triggered
  // doubling even when the true tooth frequency wasn't dominant.
  while (bestFreq * 2 <= MAX_TEETH) {
    const doubleVotes = fftVotes[bestFreq * 2] || 0;
    if (doubleVotes >= bestVal * 0.6) {
      bestFreq = bestFreq * 2;
      bestVal = doubleVotes;
    } else {
      break;
    }
  }

  return bestFreq;
}

// ── 13. Multi-radius FFT scan ───────────────────────────────────────────────
//
// Evaluates FFT at candidate radii built from edge-density peaks + outer band.
// Returns: { tc, rel, r } for the outermost candidate with rel >= MIN_REL,
// plus scanResults for small-gear refinement.

function multiRadiusFftScan(enhanced, edges, cx, cy, contourRadius, width, height, aimR = 0) {
  // PAP-1100: aim-circle prior bounds (identity when aimR<=0).
  const priorActive = aimR > 0;
  const priorLo = priorActive ? Math.floor(_aimPriorAlpha * aimR) : 0;
  const priorHi = priorActive ? Math.floor(_aimPriorBeta  * aimR) : 0;

  // PAP-1100: maxR clip to β·aimR when prior active.
  const baseMaxR = Math.min(
    Math.floor(Math.min(cx, width - cx, cy, height - cy)) - 1,
    contourRadius > 20 ? Math.floor(contourRadius * 1.35) : Math.floor(Math.min(height, width) / 3),
  );
  const maxR = priorActive ? Math.min(baseMaxR, priorHi) : baseMaxR;

  // Build edge density
  const density = new Float64Array(maxR);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (edges[y * width + x] > 0) {
        const d = Math.round(Math.sqrt((x - cx) ** 2 + (y - cy) ** 2));
        if (d < maxR) density[d]++;
      }
    }
  }

  const halfWin = Math.max(2, Math.floor(maxR / 16));
  const smooth = smoothSignal(density, halfWin);
  const searchLimit = Math.floor(maxR * 0.90);

  // Find density peaks
  const candSet = new Set();
  const peakThresh = Math.max(...smooth.slice(0, searchLimit)) * 0.12;
  for (let r = 1; r < searchLimit - 1; r++) {
    if (smooth[r] > smooth[r-1] && smooth[r] > smooth[r+1] && smooth[r] >= peakThresh) {
      // PAP-1100: drop density-peak candidates outside [α·aimR, β·aimR].
      if (priorActive && (r < priorLo || r > priorHi)) continue;
      candSet.add(r);
    }
  }

  // Evenly-spaced outer radii — PAP-1100: when prior active, anchor on
  // [α·aimR, β·aimR] instead of contourRadius (which is the failure mode the
  // PAP-1078 ladder diagnosed: peakR aliasing onto inner sub-features when
  // contourRadius is the anchor).
  if (priorActive) {
    const span = priorHi - priorLo;
    if (span >= 12) {
      // ~12 evenly-spaced samples across the prior band (matches the legacy
      // gr*65..108 density of ~12 candidates).
      const stride = Math.max(1, Math.floor(span / 12));
      for (let r = priorLo; r <= priorHi; r += stride) {
        if (r >= 10 && r < maxR) candSet.add(r);
      }
    }
  } else {
    const gr = contourRadius > 20 ? contourRadius : maxR;
    for (let pct = 65; pct < 85; pct += 4) candSet.add(Math.floor(gr * pct / 100));
    for (let pct = 85; pct < 108; pct += 2) candSet.add(Math.floor(gr * pct / 100));
  }

  // Evaluate each candidate
  const candResults = [];
  for (const rVal of [...candSet].sort((a, b) => a - b)) {
    if (rVal < 10 || rVal >= maxR) continue;
    const { tc, rel } = fftCountAtRadius(enhanced, cx, cy, rVal, width, height);
    candResults.push({ r: rVal, tc, rel });
  }

  // Primary: outermost candidate with rel >= 0.12
  const MIN_REL = 0.12;
  let peakTc = 0, peakRel = 0, peakR = 0;
  for (let i = candResults.length - 1; i >= 0; i--) {
    if (candResults[i].rel >= MIN_REL) {
      peakTc = candResults[i].tc;
      peakRel = candResults[i].rel;
      peakR = candResults[i].r;
      break;
    }
  }

  // Small-gear refinement
  if (peakTc > 0 && peakTc <= 20 && candResults.length > 0) {
    const outerHalfMin = maxR * 0.45;
    const tcVotes = {};
    for (const { r, tc, rel } of candResults) {
      if (r >= outerHalfMin && rel >= 0.04) {
        tcVotes[tc] = (tcVotes[tc] || 0) + rel;
      }
    }
    if (Object.keys(tcVotes).length > 0) {
      let bestVoteTc = peakTc, bestVote = tcVotes[peakTc] || 0;
      for (const [tcStr, vote] of Object.entries(tcVotes)) {
        const tcNum = Number(tcStr);
        if (tcNum !== peakTc && Math.abs(tcNum - peakTc) <= 3 && vote > bestVote) {
          bestVote = vote;
          bestVoteTc = tcNum;
        }
      }
      if (bestVoteTc !== peakTc) {
        for (const cr of candResults.sort((a, b) => b.rel - a.rel)) {
          if (cr.tc === bestVoteTc && cr.r >= outerHalfMin) {
            peakTc = cr.tc; peakRel = cr.rel; peakR = cr.r;
            break;
          }
        }
      }
    }
  }

  if (peakTc === 0 && candResults.length > 0) {
    const best = candResults.reduce((a, b) => b.rel > a.rel ? b : a);
    peakTc = best.tc; peakRel = best.rel; peakR = best.r;
  }

  return { peakTc, peakRel, peakR, candResults };
}

// ── 14. Outer-profile scan ───���──────────────────────────────────────────────
//
// For each angle, scan outward to find the outermost edge pixel.
// FFT on this radial profile gives a tooth count independent of radius.

function outerProfileScan(edges, cx, cy, maxR, width, height, gearRadius) {
  const nOp = N_ANGLES;
  const cosA = new Float64Array(nOp);
  const sinA = new Float64Array(nOp);
  for (let i = 0; i < nOp; i++) {
    const a = (2 * Math.PI * i) / nOp;
    cosA[i] = Math.cos(a);
    sinA[i] = Math.sin(a);
  }

  // PAP-364: Constrain scan start using the known gear radius.  The old
  // approach started at maxR*0.95 (near the image edge), picking up
  // background edges (paper marks, table edges, cables) before reaching
  // the actual gear.  Starting from gearRadius*1.20 eliminates background
  // clutter and directly targets the tooth-tip zone.
  const scanStart = gearRadius > 20
    ? Math.min(Math.floor(maxR * 0.95), Math.floor(gearRadius * 1.20))
    : Math.floor(maxR * 0.95);

  const outerRadii = new Float64Array(nOp);
  let remaining = nOp;
  for (let rScan = scanStart; rScan > 10 && remaining > 0; rScan -= 3) {
    for (let i = 0; i < nOp; i++) {
      if (outerRadii[i] > 0) continue;
      const px = Math.min(Math.max(Math.round(cx + rScan * cosA[i]), 0), width - 1);
      const py = Math.min(Math.max(Math.round(cy + rScan * sinA[i]), 0), height - 1);
      if (edges[py * width + px] > 0) {
        outerRadii[i] = rScan;
        remaining--;
      }
    }
  }

  // Fill gaps with median
  const nonZero = [];
  for (let i = 0; i < nOp; i++) if (outerRadii[i] > 0) nonZero.push(outerRadii[i]);
  if (nonZero.length === 0) return { opTc: 0, opRel: 0 };
  nonZero.sort((a, b) => a - b);
  const med = nonZero[Math.floor(nonZero.length / 2)];
  for (let i = 0; i < nOp; i++) if (outerRadii[i] === 0) outerRadii[i] = med;

  // Smooth and FFT — SavGol matches Python savgol_filter (PAP-288)
  const halfWin = Math.max(2, Math.floor(nOp / 90));
  const sm = savgolSmooth(outerRadii, halfWin, true);

  let mean = 0;
  for (let i = 0; i < sm.length; i++) mean += sm[i];
  mean /= sm.length;
  const centered = new Array(sm.length);
  for (let i = 0; i < sm.length; i++) centered[i] = sm[i] - mean;

  const mag = fftMagnitude(centered);

  // Harmonic-weighted scoring
  let bestF = 0, bestScore = 0, totalScore = 0;
  for (let f = MIN_TEETH; f <= MAX_TEETH && f < mag.length; f++) {
    let score = mag[f];
    if (2 * f < mag.length) score += 0.5 * mag[2 * f];
    if (3 * f < mag.length) score += 0.25 * mag[3 * f];
    totalScore += score;
    if (score > bestScore) { bestScore = score; bestF = f; }
  }
  const opRel = totalScore > 0 ? bestScore / totalScore : 0;
  let opTc = bestF;

  // Sub-harmonic doubling
  if (opTc > 0 && opTc <= MAX_TEETH / 2 && 2 * opTc <= MAX_TEETH) {
    const f1 = opTc, f2 = 2 * opTc;
    const s1 = mag[f1] + (2 * f1 < mag.length ? 0.5 * mag[2 * f1] : 0);
    const s2 = mag[f2] + (2 * f2 < mag.length ? 0.5 * mag[2 * f2] : 0);
    if (s2 >= 0.75 * s1) opTc = f2;
  }

  return { opTc, opRel };
}

// ── 15. CLAHE peak counting for small gears ─────────────────────────────────

function clahePeakCounting(enhanced, cx, cy, gearRadius, width, height) {
  const maxR = Math.min(cx, width - cx, cy, height - cy) - 1;
  const minDist = Math.max(10, Math.floor(N_ANGLES / (MAX_TEETH + 5)));

  const votes = {};
  for (let pct = 90; pct <= 115; pct += 2) {
    const rVal = Math.floor(gearRadius * pct / 100);
    if (rVal < 10 || rVal >= maxR) continue;

    const ring = sampleIntensityRing(enhanced, cx, cy, rVal, width, height, N_ANGLES);
    // SavGol(21, 3) matching Python savgol_filter(intensity, 21, 3) (PAP-288)
    const sm = savgolSmooth(ring, 10, true);

    let smMin = Infinity, smMax = -Infinity;
    for (let i = 0; i < sm.length; i++) {
      if (sm[i] < smMin) smMin = sm[i];
      if (sm[i] > smMax) smMax = sm[i];
    }
    const amp = smMax - smMin;
    if (amp < 8) continue;

    const pks = findPeaks(sm, { distance: minDist, prominence: amp * 0.10 });
    const tcPk = pks.length;
    if (tcPk >= MIN_TEETH_CLAHE && tcPk <= MAX_TEETH) {
      votes[tcPk] = (votes[tcPk] || 0) + amp;
    }
  }

  if (Object.keys(votes).length === 0) return { claheTc: 0, claheConf: 0 };

  // Neighbour-smoothed scoring
  const scores = {};
  for (const tc of Object.keys(votes)) {
    const t = Number(tc);
    scores[t] = (votes[t] || 0) +
      0.5 * (votes[t - 1] || 0) +
      0.5 * (votes[t + 1] || 0);
  }

  let claheTc = 0, bestScore = 0;
  for (const [tc, sc] of Object.entries(scores)) {
    if (sc > bestScore) { bestScore = sc; claheTc = Number(tc); }
  }

  const totalW = Object.values(votes).reduce((a, b) => a + b, 0);
  let agreeingW = 0;
  for (const [tc, w] of Object.entries(votes)) {
    if (Math.abs(Number(tc) - claheTc) <= 1) agreeingW += w;
  }
  const claheConf = Math.min(1.0, agreeingW / (totalW * 0.4));

  return { claheTc, claheConf };
}

// ── 16. Binary contour tooth count (Otsu silhouette) ────────────────────────
//
// Port of Python _binary_contour_count(): Otsu-threshold in both polarities,
// find external contours, resample radius profile, and detect teeth via FFT +
// peak counting.  Added in commit 4243213 — the method that brought accuracy
// from 29% to 86%.

// Moore-neighbour outer-boundary tracer with Jacob's stopping criterion
// (PAP-364 / PAP-379).  Matches the behaviour of
// cv2.findContours(RETR_EXTERNAL, CHAIN_APPROX_NONE) on solid blobs: returns
// an ordered sequence of outer-boundary pixels.
//
// Direction convention: 8 Moore-neighbour offsets in clockwise order,
//   index 0: W   1: NW  2: N   3: NE   4: E   5: SE   6: S   7: SW
// After moving to a foreground pixel in direction `d`, the new scan-from
// direction is (d - 2 + 8) % 8 (the pixel we just came from, rotated one
// step counter-clockwise — matches the "start scanning clockwise from the
// neighbour you came from" definition).
function traceOuterContour(labels, compId, width, height, startX, startY) {
  const DX = [-1, -1, 0, 1, 1, 1, 0, -1];
  const DY = [ 0, -1, -1, -1, 0, 1, 1, 1];

  const isFg = (x, y) => x >= 0 && x < width && y >= 0 && y < height
                         && labels[y * width + x] === compId;

  // Scan clockwise from (bDir + 1) for the next foreground neighbour.
  function nextFg(px, py, bDir) {
    for (let k = 1; k <= 8; k++) {
      const d = (bDir + k) % 8;
      const nx = px + DX[d], ny = py + DY[d];
      if (isFg(nx, ny)) return { d, nx, ny };
    }
    return null;
  }

  const contour = [[startX, startY]];

  // First step: initial b is the west neighbour (background by scan order).
  const first = nextFg(startX, startY, 0);
  if (!first) return contour;  // isolated pixel

  const firstX = first.nx, firstY = first.ny;
  let px = first.nx, py = first.ny;
  let bDir = (first.d - 2 + 8) % 8;
  contour.push([px, py]);

  const maxSteps = 8 * (width + height);
  for (let step = 0; step < maxSteps; step++) {
    const nf = nextFg(px, py, bDir);
    if (!nf) break;  // single-pixel or isolated component

    const newBDir = (nf.d - 2 + 8) % 8;

    // Jacob's stopping criterion: stop when the (current, next) transition
    // we're about to take is the same as the (start, firstAfter) transition
    // we took at the beginning.  Prevents the classic "revisit start from
    // the wrong side" miss on thin boundary segments.
    if (px === startX && py === startY && nf.nx === firstX && nf.ny === firstY) {
      return contour;
    }

    px = nf.nx;
    py = nf.ny;
    bDir = newBDir;
    contour.push([px, py]);
  }
  return contour;
}

// np.interp equivalent for monotonically non-decreasing xp.
function linearInterp1d(x, xp, fp) {
  const n = xp.length;
  if (n === 0) return 0;
  if (x <= xp[0]) return fp[0];
  if (x >= xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (xp[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = xp[hi] - xp[lo];
  if (span <= 0) return fp[lo];
  const t = (x - xp[lo]) / span;
  return fp[lo] * (1 - t) + fp[hi] * t;
}

function binaryContourCount(gray, cx, cy, width, height) {
  const n = width * height;
  const BC_ANGLES = 4096;  // Must be power of 2 — avoids FFT zero-padding frequency shift
  const results = [];

  const otsuT = otsuThreshold(gray, width, height);

  // PAP-364 (v2, QA-approved [PAP-379]): align threshold grid with Python
  // reference (60..200 step 35).  The old step=40 grid missed 60 and 95
  // which catch low-contrast silver/metallic gears Otsu can't separate.
  const threshSet = new Set([otsuT]);
  for (let t = 60; t <= 200; t += 35) threshSet.add(t);
  const thresholds = [...threshSet].sort((a, b) => a - b);

  for (const thresh of thresholds) {
  for (const invert of [false, true]) {
    // Binary mask
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      mask[i] = invert ? (gray[i] <= thresh ? 1 : 0) : (gray[i] > thresh ? 1 : 0);
    }

    // PAP-364 (v2): no morphology — matches Python reference which calls
    // cv2.findContours directly on the raw binary mask.  The previous
    // useMorph ∈ {true,false} dual-pass doubled pipeline time and the
    // no-morph pass inside it generated the noisy 24T→44 FFT spike QA
    // flagged in b84.
    const { labels, components } = labelComponents(mask, width, height, 1);

    const nTotal = width * height;
    for (const comp of components) {
      if (comp.area < 100) continue;
      // PAP-364 (v2): Python's cv2.findContours does not filter out
      // border-touching contours, and real large gears at 900px can extend
      // to the frame edge.  Skip only components that cover most of the
      // image (the background silhouette) instead of any border contact.
      if (comp.area > 0.7 * nTotal) continue;

      // Find the scan-order start pixel for this component (first foreground
      // encountered in row-major order).  This is the canonical Moore
      // start — the pixel directly to its west must be background.
      let startX = -1, startY = -1;
      for (let y = comp.minY; y <= comp.maxY && startX < 0; y++) {
        const row = y * width;
        for (let x = comp.minX; x <= comp.maxX; x++) {
          if (labels[row + x] === comp.id) { startX = x; startY = y; break; }
        }
      }
      if (startX < 0) continue;

      // Ordered outer-contour trace.  Matches the semantics of
      // cv2.findContours(RETR_EXTERNAL, CHAIN_APPROX_NONE) for solid blobs.
      const contour = traceOuterContour(labels, comp.id, width, height, startX, startY);
      if (contour.length < 100) continue;

      // PAP-364 (v2): polar transform about the GLOBAL gear center
      // (findGearCenter's output), matching Python.  The previous version
      // used the component centroid, which lands at the silhouette's
      // geometric center — off-axis for ring-shaped cassette cogs and
      // asymmetric large gears, and produced the 28T→10 undercounts.
      const angles = new Float64Array(contour.length);
      const radii  = new Float64Array(contour.length);
      for (let i = 0; i < contour.length; i++) {
        const dx = contour[i][0] - cx;
        const dy = contour[i][1] - cy;
        angles[i] = Math.atan2(dy, dx);
        radii[i]  = Math.sqrt(dx * dx + dy * dy);
      }

      // Sort by angle — matches Python's np.argsort(angles_cnt) before
      // np.interp.  Contour-ordered points may wrap around ±π, so an
      // explicit sort is required before linear interpolation.
      const order = Array.from({ length: contour.length }, (_, i) => i);
      order.sort((a, b) => angles[a] - angles[b]);
      const aSorted = new Float64Array(contour.length);
      const rSorted = new Float64Array(contour.length);
      for (let i = 0; i < order.length; i++) {
        aSorted[i] = angles[order[i]];
        rSorted[i] = radii[order[i]];
      }

      // Reject contours that don't span close to a full circle (matches
      // Python's `if a_sorted[-1] - a_sorted[0] < 4.0: continue`).
      if (aSorted[aSorted.length - 1] - aSorted[0] < 4.0) continue;

      // Uniform angular grid, linear interp — matches Python's
      // np.interp(uniform, a_sorted, r_sorted) exactly.
      const rInterp = new Float64Array(BC_ANGLES);
      for (let i = 0; i < BC_ANGLES; i++) {
        const a = -Math.PI + (2 * Math.PI * i) / BC_ANGLES;
        rInterp[i] = linearInterp1d(a, aSorted, rSorted);
      }

      // SavGol(57, 3) — ~1.4% of 4096 ≈ Python savgol_filter(51, 3) on 3600 (PAP-288)
      const sm = savgolSmooth(rInterp, 28, true);

      let smMin = Infinity, smMax = -Infinity;
      for (let i = 0; i < sm.length; i++) {
        if (sm[i] < smMin) smMin = sm[i];
        if (sm[i] > smMax) smMax = sm[i];
      }
      const amp = smMax - smMin;
      if (amp < 2) continue;

      // Peak counting (min_d = 4096/80 = 51)
      const minD = Math.floor(BC_ANGLES / 80);
      const pks = findPeaks(sm, { distance: minD, prominence: amp * 0.10 });
      const nPeaks = pks.length;

      // FFT on centred signal
      let mean = 0;
      for (let i = 0; i < sm.length; i++) mean += sm[i];
      mean /= sm.length;
      const centred = new Array(sm.length);
      for (let i = 0; i < sm.length; i++) centred[i] = sm[i] - mean;

      const mag = fftMagnitude(centred);

      // Score in tooth-count range
      let total = 0;
      let bestVal = 0, bestFreq = 0;
      for (let f = MIN_TEETH; f <= MAX_TEETH && f < mag.length; f++) {
        total += mag[f];
        if (mag[f] > bestVal) { bestVal = mag[f]; bestFreq = f; }
      }
      if (total <= 0) continue;

      const fftPurity = bestVal / total;
      // Component centroid kept for downstream center-disagreement guard.
      const compCx = comp.sx / comp.area;
      const compCy = comp.sy / comp.area;
      results.push({ fftTc: bestFreq, fftPurity, nPeaks, compCx, compCy });
    }
  }
  }  // end threshold sweep

  if (results.length === 0) return { bcTc: 0, bcPurity: 0, bcPeaks: 0, bcCx: 0, bcCy: 0 };

  // Prefer results where peak count is in valid tooth range
  const valid = results.filter(r => r.nPeaks >= MIN_TEETH && r.nPeaks <= MAX_TEETH);
  if (valid.length > 0) {
    // Among valid, prefer where FFT and peaks agree closely
    const agreeing = valid.filter(r => Math.abs(r.fftTc - r.nPeaks) <= 2);
    const best = (agreeing.length > 0 ? agreeing : valid)
      .reduce((a, b) => b.fftPurity > a.fftPurity ? b : a);
    return { bcTc: best.fftTc, bcPurity: best.fftPurity, bcPeaks: best.nPeaks,
             bcCx: best.compCx, bcCy: best.compCy };
  }

  const best = results.reduce((a, b) => b.fftPurity > a.fftPurity ? b : a);
  return { bcTc: best.fftTc, bcPurity: best.fftPurity, bcPeaks: best.nPeaks,
           bcCx: best.compCx, bcCy: best.compCy };
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Count the teeth on a gear from a photo.
 *
 * @param {string} photoUri  - file:// URI from VisionCamera takePhoto()
 * @returns {Promise<{toothCount: number, confidence: number,
 *                    gearCenter: {x: number, y: number},
 *                    gearRadius: number}>}
 */
// ── PAP-815: outer-edge anchor radius via radial-mean intensity gradient ──
// Computes R_outer = outermost prominent peak of the azimuthally-averaged
// |dI/dr| profile in the band [0.30·peakR, 1.50·peakR], anchored at the bc
// center when geometrically self-validated (|Δcenter|≤50 px AND bc sweep band
// safe), else at the algo center.  Approved as the radial channel for the
// PAP-815 inner-feature-lock abstain (PAP-818 cross-check, predicate at
// rel-disagree ≥ 0.18 in chainring regime).  Returns 0 when sweep band is
// too small or no prominent peaks survive.  Caller is expected to gate the
// invocation on chainring regime so the cost (256 rays × ~300 r values ×
// 2 bilinear samples) only runs on ≥30T candidate detections.
function radialOuterEdgeRadius(enhanced, cx, cy, bcCx, bcCy, peakR, w, h) {
  if (peakR <= 0) return 0;
  const baseR = peakR;
  const halfMinAlgo = Math.min(cx, cy, w - cx, h - cy) - 1;
  const rMinAlgo = Math.max(20, Math.floor(0.30 * baseR));
  const rMaxAlgo = Math.min(halfMinAlgo, Math.floor(1.50 * baseR));
  // bc-anchor self-validation per QA PAP-818: |Δcenter|≤50 px AND bc sweep
  // band ≥60 px halfMin AND ≥20 px span.  When false, fall back to algo.
  const halfMinBc = Math.min(bcCx, bcCy, w - bcCx, h - bcCy) - 1;
  const rMinBc = Math.max(20, Math.floor(0.30 * baseR));
  const rMaxBc = Math.min(halfMinBc, Math.floor(1.50 * baseR));
  const bcSafe = bcCx > 0 && bcCy > 0 && rMaxBc >= rMinBc + 20 && halfMinBc >= 60;
  const centerDelta = Math.sqrt((bcCx - cx) ** 2 + (bcCy - cy) ** 2);
  const useBc = bcSafe && centerDelta <= 50;
  const useCx = useBc ? bcCx : cx;
  const useCy = useBc ? bcCy : cy;
  const rMin = useBc ? rMinBc : rMinAlgo;
  const rMax = useBc ? rMaxBc : rMaxAlgo;
  if (rMax < rMin + 20) return 0;

  // Azimuthally-averaged |dI/dr|, central difference, bilinear sampling.
  const N_RAYS = 256;
  const len = rMax - rMin + 1;
  const profile = new Float64Array(len);
  for (let r = rMin; r <= rMax; r++) {
    let s = 0;
    const ri = r + 1, ro = r - 1;
    for (let i = 0; i < N_RAYS; i++) {
      const a = (2 * Math.PI * i) / N_RAYS;
      const ca = Math.cos(a), sa = Math.sin(a);
      // Inner sample at r+1
      let xs = useCx + ri * ca, ys = useCy + ri * sa;
      if (xs < 0) xs = 0; else if (xs > w - 1.0001) xs = w - 1.0001;
      if (ys < 0) ys = 0; else if (ys > h - 1.0001) ys = h - 1.0001;
      const xi0 = xs | 0, yi0 = ys | 0;
      const fxi = xs - xi0, fyi = ys - yi0;
      const rowI0 = yi0 * w, rowI1 = rowI0 + w;
      const vI = (1 - fxi) * (1 - fyi) * enhanced[rowI0 + xi0]
               + fxi       * (1 - fyi) * enhanced[rowI0 + xi0 + 1]
               + (1 - fxi) * fyi       * enhanced[rowI1 + xi0]
               + fxi       * fyi       * enhanced[rowI1 + xi0 + 1];
      // Outer sample at r-1
      let xt = useCx + ro * ca, yt = useCy + ro * sa;
      if (xt < 0) xt = 0; else if (xt > w - 1.0001) xt = w - 1.0001;
      if (yt < 0) yt = 0; else if (yt > h - 1.0001) yt = h - 1.0001;
      const xo0 = xt | 0, yo0 = yt | 0;
      const fxo = xt - xo0, fyo = yt - yo0;
      const rowO0 = yo0 * w, rowO1 = rowO0 + w;
      const vO = (1 - fxo) * (1 - fyo) * enhanced[rowO0 + xo0]
               + fxo       * (1 - fyo) * enhanced[rowO0 + xo0 + 1]
               + (1 - fxo) * fyo       * enhanced[rowO1 + xo0]
               + fxo       * fyo       * enhanced[rowO1 + xo0 + 1];
      const d = (vI - vO) * 0.5;
      s += d >= 0 ? d : -d;
    }
    profile[r - rMin] = s / N_RAYS;
  }

  // Top-3 prominent local maxima (shoulder window ±8 px).
  const minDist = 8;
  const peaks = [];
  for (let i = 1; i < len - 1; i++) {
    if (profile[i] > profile[i - 1] && profile[i] >= profile[i + 1]) {
      let lMin = profile[i], rMinV = profile[i];
      const lLo = i - minDist > 0 ? i - minDist : 0;
      const rHi = i + minDist < len - 1 ? i + minDist : len - 1;
      for (let j = lLo; j < i; j++) if (profile[j] < lMin) lMin = profile[j];
      for (let j = i + 1; j <= rHi; j++) if (profile[j] < rMinV) rMinV = profile[j];
      const prom = profile[i] - (lMin > rMinV ? lMin : rMinV);
      peaks.push({ idx: i, prom });
    }
  }
  if (peaks.length === 0) return 0;
  peaks.sort((a, b) => b.prom - a.prom);
  // Outermost peak among top-3 with prom ≥ 30% of strongest.
  const top = peaks.slice(0, 3);
  const promFloor = top[0].prom * 0.30;
  let outermostIdx = top[0].idx;
  for (const p of top) {
    if (p.prom >= promFloor && p.idx > outermostIdx) outermostIdx = p.idx;
  }
  return outermostIdx + rMin;
}

/**
 * Core analysis pipeline — operates on already-loaded pixel buffers.
 * Returns { toothCount, confidence, gearCenter, gearRadius } in pixel units.
 */
function analyzeImage(gray, enhanced, edges, width, height, aimR = 0) {
  // ── Center detection (multi-candidate + FFT purity) ────────────────
  const centerResult = findGearCenter(gray, enhanced, edges, width, height);
  const cx = centerResult.cx;
  const cy = centerResult.cy;
  const contourRadius = centerResult.radius || 0;

  // Always compute edge-density radius as independent cross-check (PAP-266).
  // When findGearCenter locks onto an inner feature (cutout holes, splines)
  // the contour radius is too small and all downstream FFT methods scan the
  // wrong region.  Edge-density finds the outermost tooth ring reliably.
  const edgeDensityR = findGearRadius(edges, cx, cy, width, height);

  // Cross-check contour vs edge-density radius (PAP-266).
  // - If contour is much smaller than edge-density: inner-feature lockup → use edge-density
  // - If contour is much larger: background merge → use edge-density
  // - Otherwise: they agree → use max (conservative)
  let gearR;
  if (contourRadius <= 20) {
    gearR = edgeDensityR;
  } else if (edgeDensityR > contourRadius * 1.4) {
    // Contour locked on inner feature (e.g. 24T cutout holes) — edge-density
    // found the outer tooth ring further out.
    gearR = edgeDensityR;
  } else if (contourRadius > edgeDensityR * 1.6) {
    // Contour merged with background (e.g. 14T on textured surface) —
    // edge-density found the actual tooth ring closer in.
    gearR = edgeDensityR;
  } else {
    gearR = Math.max(contourRadius, edgeDensityR);
  }

  // ── Method evaluation (matches Python decision rule from commit 4243213) ──

  // Method 1: FFT at ≥85% of max contour radius
  const fft90tc = fftAtOuterRadii(enhanced, cx, cy, contourRadius, gearR, edges, width, height);

  // Always run multi-radius FFT scan (needed for confidence + cross-validation)
  let peakTc = 0, peakRel = 0, peakR = 0;
  ({ peakTc, peakRel, peakR } = multiRadiusFftScan(enhanced, edges, cx, cy, gearR, width, height, aimR));

  // Outer-profile scan
  let opTc = 0, opRel = 0;
  const maxRop = Math.min(cx, width - cx, cy, height - cy) - 1;
  ({ opTc, opRel } = outerProfileScan(edges, cx, cy, maxRop, width, height, gearR));

  // Binary contour method (commit 4243213 — accuracy 29%→86%)
  const { bcTc, bcPurity, bcPeaks, bcCx, bcCy } = binaryContourCount(gray, cx, cy, width, height);

  // CLAHE peak counting
  let claheTc = 0, claheConf = 0;
  ({ claheTc, claheConf } = clahePeakCounting(enhanced, cx, cy, gearR, width, height));

  // Best available purity for confidence calculation
  let finalRel = peakRel > 0 ? peakRel : (opRel > 0 ? opRel : 0);

  // FFT-based confidence (linear ramp: rel 0.05→0%, 0.20→100%)
  const fftConf = Math.min(1.0, Math.max(0.0, (finalRel - 0.05) / 0.15));

  // ── Decision rule ──────────────────────────────────────────────────
  let finalTc = 0;
  let methodUsed = 'none';

  // Inner-bore safeguard: when peakR is much smaller than contourRadius,
  // the multi-radius FFT is likely picking up inner features (splines,
  // mounting holes) not outer teeth.  Suppress high-confidence override.
  const innerBoreSuspect = contourRadius > 40 && peakR > 0 && peakR < contourRadius * 0.55;

  // Center-disagreement safeguard (PAP-266): when the binary contour's
  // self-centering centroid is far from findGearCenter's center, the FFT
  // methods (which use findGearCenter) may be scanning from the wrong point.
  // In that case, suppress high-confidence FFT override in favour of the
  // self-centering binary contour method.
  const minDim = Math.min(width, height);
  const centerDisagree = bcCx > 0 && bcCy > 0
    && Math.sqrt((bcCx - cx) ** 2 + (bcCy - cy) ** 2) > minDim * 0.10;

  // Binary contour consensus: when peak count and FFT on the same
  // Otsu silhouette agree within ±2, this is the strongest available
  // signal — the method is self-centering (uses component centroid)
  // and two independent analyses of the same contour agree.
  const bcConsensus = bcPurity >= 0.08
    && bcPeaks >= MIN_TEETH && bcPeaks <= MAX_TEETH
    && bcTc >= MIN_TEETH && bcTc <= MAX_TEETH
    && Math.abs(bcTc - bcPeaks) <= 2;

  // PAP-390: low-confidence 4-way consensus signals (precomputed).
  // When ≥3 of {peakTc, fft90tc, opTc, bcPeaks} agree within ±1 AND
  // overall fftConf is below the PAP-282/PAP-300 moderate-confidence
  // band (<0.40), trust the consensus count.  Rationale: device-side
  // image perturbation (Expo JPEG re-encode) drops confidence below
  // the existing cascade triggers, but the underlying signals still
  // converge on the correct count.  Includes bcPeaks (silhouette-
  // independent channel) so harmonic aliasing cannot trick the rule
  // by fooling all 3 angular methods the same way.
  const consensusSignals = [];
  if (peakTc >= MIN_TEETH && peakTc <= MAX_TEETH) consensusSignals.push(peakTc);
  if (fft90tc >= MIN_TEETH && fft90tc <= MAX_TEETH) consensusSignals.push(fft90tc);
  if (opTc >= MIN_TEETH && opTc <= MAX_TEETH) consensusSignals.push(opTc);
  if (bcPeaks >= MIN_TEETH && bcPeaks <= MAX_TEETH) consensusSignals.push(bcPeaks);
  let consensusValue = 0;
  let consensusCount = 0;
  for (const v of consensusSignals) {
    const agreeing = consensusSignals.filter(s => Math.abs(s - v) <= 1);
    if (agreeing.length > consensusCount) {
      consensusCount = agreeing.length;
      const sorted = [...agreeing].sort((a, b) => a - b);
      consensusValue = sorted[Math.floor(sorted.length / 2)];
    }
  }
  // 16T Shimano aliases to 14T via its 14 mounting holes (see QA
  // project memory `project_16t_aliasing.md`).  When consensus lands
  // on 14 or 16 AND the gear is large (contourRadius > 25% minDim),
  // fall through to the existing cascade rather than overriding —
  // the existing bc-fft / bc-peaks branches handle the aliasing case.
  const consensusAliasingSuspect = (consensusValue === 14 || consensusValue === 16)
    && contourRadius > minDim * 0.25;
  const lowConfConsensusFires = fftConf < 0.40
    && consensusCount >= 3
    && !consensusAliasingSuspect;

  if (bcConsensus) {
    // 0. Binary contour consensus — use FFT count (more precise than peaks).
    // When high-confidence multi-radius FFT agrees, defer to it for precision.
    if (fftConf >= 0.70 && peakTc > 0 && !innerBoreSuspect && !centerDisagree
        && Math.abs(peakTc - bcTc) <= 2) {
      finalTc = peakTc;
      methodUsed = 'bc-consensus+peak';
    } else if (peakTc > 0 && fft90tc > 0
        && peakTc === fft90tc
        && fftConf >= 0.40
        && Math.abs(peakTc - bcTc) <= 1) {
      // PAP-300: FFT agreement override — when two independent FFT methods
      // (multi-radius + fft@90%) agree on a count within ±1 of bcTc at
      // moderate confidence, prefer the FFT result.  Binary contour FFT
      // can be off by 1 due to threshold sensitivity (e.g. 23T vs 24T).
      finalTc = peakTc;
      methodUsed = 'bc-consensus+fft-agree';
    } else {
      finalTc = bcTc;
      methodUsed = 'bc-consensus';
    }
    finalRel = Math.max(finalRel, bcPurity * 0.50);
  } else if (lowConfConsensusFires) {
    // 0b. PAP-390: low-confidence 4-way consensus — trust the agreed
    // value when ≥3 of 4 independent tooth-count signals agree within
    // ±1 at sub-0.40 confidence.  Runs after bcConsensus so it never
    // double-overrides the high-quality silhouette path, and before
    // the high-conf peak / PAP-282 FFT-agreement rules so low-
    // confidence consensus cannot be clobbered by an unreliable
    // fft90-fallback.
    finalTc = consensusValue;
    methodUsed = 'low-conf-consensus';
    // PAP-408: op-preference when the FFT cluster leans high by 1 and op
    // dissents low.  peakTc and fft90tc are both FFT-based and share
    // aliasing failure modes (sub-pixel center bias, harmonic leakage from
    // mounting holes / spokes); treating them as one correlated vote rather
    // than two independent votes is supported by QA PAP-416 review.  opTc
    // (CLAHE outer-profile peak count) is silhouette-based and genuinely
    // independent.  When the two correlated FFT channels agree AND op
    // dissents by exactly -1 AND bcPeaks concurs that the count is ≤ op,
    // prefer op.  Fixes 2026-04-22_07-23-04-157Z (actual=11, cluster
    // [10,11,12,12] → upper-middle median picks 12).
    if (peakTc > 0 && fft90tc > 0 && opTc > 0
        && peakTc === fft90tc
        && opTc === peakTc - 1
        && bcPeaks > 0 && bcPeaks <= opTc) {
      finalTc = opTc;
      methodUsed = 'low-conf-consensus+op-override';
    }
    // PAP-632 Fix A: op-up override when FFT collapses to MIN_TEETH floor.
    // MIN_TEETH=10 is never a true count (no 10T gears exist in corpus — min
    // truth label is 11T), so peakTc===fft90tc===MIN_TEETH is always a sub-
    // harmonic floor.  When opTc reads exactly MIN_TEETH+1 (=11) the silhouette-
    // based channel found the correct count that the FFT missed.
    // Target: 2026-04-25_08-03-33-119Z (actual=11, peak=fft90=10, op=11).
    if (peakTc === MIN_TEETH && fft90tc === MIN_TEETH
        && opTc === MIN_TEETH + 1) {
      finalTc = opTc;
      methodUsed = 'low-conf-consensus+op-up-override';
    }
    console.log(`[${methodUsed}] final=${finalTc} fftConf=${fftConf.toFixed(3)} ` +
      `bcPeaks=${bcPeaks} fft90=${fft90tc} peak=${peakTc} op=${opTc} ` +
      `agree=${consensusCount}/4 contourR=${contourRadius}`);
  } else if (fftConf >= 0.70 && peakTc > 0 && !innerBoreSuspect && !centerDisagree) {
    // 1. Multi-radius outermost candidate is highly confident — trust it.
    // Suppressed when center disagrees with binary contour (PAP-266).
    finalTc = peakTc;
    methodUsed = 'peak';
  } else if (peakTc > 0 && fft90tc > 0
             && Math.abs(peakTc - fft90tc) <= 1
             && fftConf >= 0.40
             && bcPurity < 0.20) {
    // 1b. PAP-282: FFT agreement rule — when multi-radius FFT and FFT@90%
    // agree (±1 tooth), trust them even at moderate confidence.  Two
    // independent FFT methods agreeing is strong evidence; prevents
    // fallthrough to unreliable binary contour on large gears with
    // spider-arm cutouts.  Guard: do NOT override high-purity bc (>= 0.20).
    //
    // PAP-814: XL op-vote-boost.  Mirrors the PAP-632 Fix B `xl-peak-override`
    // pattern (line ~2125) but on the op channel and gated to the XL-narrow
    // (≥30T) range.  PAP-811 pre-flight ruled out integer-FFT sub-bin
    // refinement on the chosen peakR for the 42T device targets — the FFT
    // genuinely says 41 at the dominant ring radius — so the only remaining
    // signal for the missing tooth is the silhouette-based op channel.  When
    // both correlated FFT channels strictly agree (peakTc===fft90tc) at
    // peakTc≥30 AND op reads exactly peakTc+1 AND opRel meets the established
    // mid/large-op-override floor (0.04, see PAP-441/PAP-460), prefer op.
    // Equality `op === peak + 1` is intentionally strict so the lever cannot
    // fire on out-of-scope inner-locked photos (e.g. PAP-810 photo 2 has
    // op=13 ≠ peak+1=42).  Verified 0 predicate-eligible rows in the 292-
    // photo 9-60T pap796 audit corpus (zero new confident-wrongs by
    // construction).  Target: 2026-04-29_05-29-04-170Z (actual=42, peak=41,
    // fft90=41, op=42, opRel=0.0475).
    if (peakTc === fft90tc
        && peakTc >= 30
        && opTc === peakTc + 1
        && opRel >= 0.04) {
      console.log(`[xl-op-vote-boost] fft-agreement=>${opTc} ` +
        `peak=${peakTc} fft90=${fft90tc} op=${opTc}(rel=${opRel.toFixed(3)}) ` +
        `bc=${bcTc}(peaks=${bcPeaks})`);
      finalTc = opTc;
      methodUsed = 'fft-agreement+xl-op-vote-boost';
    } else {
      finalTc = peakTc;
      methodUsed = 'fft-agreement';
    }
  } else if (bcPurity >= 0.20 && bcTc >= MIN_TEETH && bcTc <= MAX_TEETH) {
    // 2. Binary contour FFT has high purity — use it.
    // PAP-308 port: raised multiplier from 0.30 → 0.50 so confident bc
    // detections produce realistic confidence and are not overridden by
    // off-center retries that lock onto background features.
    finalTc = bcTc;
    finalRel = Math.max(finalRel, bcPurity * 0.50);
    methodUsed = 'bc-fft';
  } else if (bcPurity >= 0.10 && bcPeaks >= MIN_TEETH && bcPeaks <= MAX_TEETH) {
    // PAP-282: raised threshold from 0.05 → 0.10; lower purities are
    // unreliable on large gears where spider-arm cutout features
    // dominate the silhouette contour.
    // 3. Binary contour peak count is in valid range.
    if (fft90tc > 0 && bcTc > 0
        && fft90tc === bcTc
        && Math.abs(fft90tc - bcPeaks) === 1) {
      finalTc = fft90tc;
    } else if (peakTc > 0 && fft90tc > 0
        && peakTc === fft90tc
        && Math.abs(peakTc - bcPeaks) === 1) {
      finalTc = peakTc;
    } else if (bcTc >= MIN_TEETH && bcTc <= MAX_TEETH
        && Math.abs(bcTc - bcPeaks) > 3
        && bcTc > bcPeaks
        && bcTc < 2 * bcPeaks) {
      // PAP-288: when binary contour FFT and peak count disagree
      // substantially (>3 teeth) and FFT is higher but not a harmonic,
      // prefer FFT.  Peak counting undercounts on large gears because
      // spider-arm cutouts split the silhouette.
      finalTc = bcTc;
    } else {
      finalTc = bcPeaks;
    }
    finalRel = Math.max(finalRel, bcPurity * 0.25);
    methodUsed = 'bc-peaks';
  } else if (fft90tc > 0) {
    // 4. fft90 available but not highly confident
    // PAP-407 / PAP-460 Rule M2 — peak-over-fft90-subharmonic:
    // when fft90 would be used but multi-radius peakTc is in mid/large-gear
    // range and reads as ~2× fft90tc, the fft90 channel has captured the
    // half-frequency alias and peakTc has the fundamental.  Prefer peakTc.
    // Approved on PAP-460.  Target hit b89 19-13-57 (peak=21, fft90=10).
    if (peakTc >= MIN_TEETH
        && peakTc >= 16 && peakTc <= 28
        && fft90tc > 0
        && Math.abs(peakTc - 2 * fft90tc) <= 1) {
      console.log(`[peak-over-fft90-subharmonic] fft90-fallback=>${peakTc} ` +
        `peak=${peakTc} fft90=${fft90tc} bc=${bcTc}(peaks=${bcPeaks}) ` +
        `op=${opTc}(rel=${opRel.toFixed(3)})`);
      finalTc = peakTc;
      methodUsed = 'fft90-fallback+peak-subharmonic';
    } else if (peakTc >= 29 && peakTc <= MAX_TEETH
        && fft90tc < peakTc * 0.5
        && peakRel >= 0.12) {
      // PAP-632 Fix B: XL-peak override — when fft90 fallback would fire but
      // multi-radius FFT found a strong XL-range signal (≥29T), prefer peakTc.
      // fft90 only samples the 85-115% radius band which is contaminated when
      // the contour locked onto an inner feature; multi-radius scans a wider
      // range and can resolve XL tooth counts the narrow band misses.
      // peakRel≥0.12 ensures the XL signal has reasonable quality.
      // Target: 2026-04-24_10-54-47-201Z (actual=42, peak=42, fft90=12).
      console.log(`[xl-peak-override] fft90-fallback=>${peakTc} ` +
        `peak=${peakTc}(rel=${peakRel.toFixed(3)}) fft90=${fft90tc} ` +
        `bc=${bcTc}(peaks=${bcPeaks}) op=${opTc}(rel=${opRel.toFixed(3)})`);
      finalTc = peakTc;
      methodUsed = 'fft90-fallback+xl-peak-override';
    } else {
      finalTc = fft90tc;
      methodUsed = 'fft90-fallback';
    }
  } else if (peakRel >= 0.15 && peakTc >= MIN_TEETH) {
    // 5. Multi-radius FFT
    finalTc = peakTc;
    methodUsed = 'multiR';
  } else if (opTc > 0 && opRel >= 0.10) {
    // 6. Outer-profile scan
    finalTc = opTc;
    methodUsed = 'outer';
  } else if (peakTc > 0) {
    // 7. Any multi-radius result
    finalTc = peakTc;
    methodUsed = 'multiR-fallback';
  } else if (claheTc > 0 && claheConf >= 0.5) {
    // 8. CLAHE peak counting (last resort)
    finalTc = claheTc;
    methodUsed = 'clahe';
  }

  // PAP-406 / PAP-441: large-gear op-preference override (Pattern A).
  // Extension of the PAP-408 Option C principle — when the correlated FFT
  // channels (peak, fft90) collapse to the sub-harmonic floor but the
  // silhouette-based op channel reads in the large-gear range, prefer op.
  // Narrow gate approved by QA on PAP-441; expected delta on b83–89 22–28T
  // corpus is +1 exact HIT (b89 19-16-05 op=24 vs actual=24).  Does NOT
  // solve Pattern B (total FFT collapse where op also fails) — that needs
  // QIFFT / radial-gradient per PAP-412 and will ship separately.
  // bcTc<=15 || bcPeaks<=15 tightening per QA PAP-441 review: keeps the
  // +1 HIT while preventing b88 07-04-49 (bc=20) from overshooting.
  const largeOpEligibleMethod = methodUsed === 'low-conf-consensus'
    || methodUsed === 'low-conf-consensus+op-override'
    || methodUsed === 'fft90-fallback'
    || methodUsed === 'fft-agreement'
    || methodUsed === 'bc-fft';
  if (largeOpEligibleMethod
      && contourRadius > minDim * 0.25
      && opTc >= 20
      && peakTc <= 15 && fft90tc <= 15
      && opRel >= 0.04
      && (bcTc <= 15 || bcPeaks <= 15)) {
    console.log(`[large-op-override] ${methodUsed}=>${opTc} ` +
      `peak=${peakTc} fft90=${fft90tc} bc=${bcTc}(peaks=${bcPeaks}) ` +
      `op=${opTc}(rel=${opRel.toFixed(3)}) contourR=${contourRadius} minDim=${minDim}`);
    finalTc = opTc;
    methodUsed = methodUsed + '+large-op-override';
  }

  // PAP-407 / PAP-460 Rule M1 — mid-gear op-preference override.
  // Mirrors large-op-override but for opTc in the 16–19 range (mid gears).
  // Tighter FFT gate (peakTc<=13, fft90tc<=14) so we only fire when the FFT
  // cluster is clearly in sub-harmonic territory and not just near-truth.
  // bcTc<=15 || bcPeaks<=15 tightening matches the large-op-override gate
  // for safety parity (per QA PAP-460 suggestion 1).
  // Distinct log tag [mid-op-override] so telemetry disambiguates from
  // [large-op-override] (per QA PAP-460 suggestion 2).
  // NOTE: Uses `gearR` (fused radius from line 1782, max of contourRadius
  // and edgeDensityR) instead of `contourRadius` for the "real gear
  // detected" gate — mid-gear contours often lock onto inner cutouts so
  // contourRadius is under-reported; gearR is the corrected estimate.
  // Verified on harness: target b86 19-18-26 has contourR=95 but gearR
  // reflects the actual outer tooth ring.
  // Target hit: b86 19-18-26 (op=18, actual=18).
  const midOpEligibleMethod = methodUsed === 'low-conf-consensus'
    || methodUsed === 'low-conf-consensus+op-override'
    || methodUsed === 'fft90-fallback'
    || methodUsed === 'fft-agreement'
    || methodUsed === 'bc-fft';
  // PAP-537: require peakTc === MIN_TEETH (FFT-collapse floor signal) so the
  // override only fires when the FFT has truly collapsed to its sub-harmonic
  // floor, not when peak is a real small-gear reading (e.g. b95 11T where
  // peak=fft90=11 is correct consensus).  Mirrors PAP-474 Option A abstain
  // precedent — MIN_TEETH=10 is the only known sub-harmonic floor value
  // since no 10T truth label exists in the corpus.  QA signed off on
  // PAP-538: n=22 mid-gear corpus (b83-89) unchanged, only firing is the
  // b86 19-18-26 target where peak=10.
  if (midOpEligibleMethod
      && gearR > minDim * 0.25
      && opTc >= 16 && opTc <= 19
      && peakTc === MIN_TEETH && fft90tc <= 14
      && opRel >= 0.04
      && (bcTc <= 15 || bcPeaks <= 15)) {
    console.log(`[mid-op-override] ${methodUsed}=>${opTc} ` +
      `peak=${peakTc} fft90=${fft90tc} bc=${bcTc}(peaks=${bcPeaks}) ` +
      `op=${opTc}(rel=${opRel.toFixed(3)}) ` +
      `gearR=${gearR} contourR=${contourRadius} minDim=${minDim}`);
    finalTc = opTc;
    methodUsed = methodUsed + '+mid-op-override';
  }

  // PAP-474 Option A (QA-approved via PAP-497): abstain on all-10 FFT collapse.
  // When peakTc and fft90tc both pin at MIN_TEETH=10 AND the gear is physically
  // large (gearR > 25% minDim, contourRadius > 20% minDim), the FFT cluster has
  // collapsed to its sub-harmonic floor.  QA corpus audit (295 training + 324
  // debug reports) confirmed zero 10T-labeled photos exist — min truth label is
  // 11T — so any peak=fft90=10 on a large-contour photo is by construction a
  // fallback floor, NOT a true 10T gear.  Converting this toxic
  // "10T @ conf≈0.53" false-positive into an honest "0T @ conf 0" (algorithm
  // failed to count) matches the user signal that's actually present.
  //
  // Guards:
  //  - `finalTc === MIN_TEETH` AND the FFT cluster both equal MIN_TEETH — only
  //    fires when the decision cascade actually landed on the floor value.
  //  - gearR > 25% minDim and contourRadius > 20% minDim — large-contour gate
  //    prevents small/mid gears where a valid low count might pass through.
  //
  // Architectural rescue (tooth-tip radial gradient, Option C) tracked in the
  // sibling ticket.  See PAP-497 for full cross-check.
  if (finalTc === MIN_TEETH
      && peakTc === MIN_TEETH
      && fft90tc === MIN_TEETH
      && gearR > minDim * 0.25
      && contourRadius > minDim * 0.20) {
    console.log(`[pap474-abstain] peak=${peakTc} fft90=${fft90tc} ` +
      `bc=${bcTc}(peaks=${bcPeaks}) op=${opTc}(rel=${opRel.toFixed(3)}) ` +
      `gearR=${gearR} contourR=${contourRadius} minDim=${minDim}`);
    finalTc = 0;
    finalRel = 0;
    methodUsed = methodUsed + '+pap474-abstain';
  }

  // PAP-632 Fix C (part 2): extended FFT-floor abstain.
  // When peakTc collapsed to MIN_TEETH (sub-harmonic floor) but fft90tc
  // landed on a different small count (so PAP-474 didn't fire), and the
  // contour is moderate-sized (contourRadius > 15% minDim), the algorithm
  // locked onto an inner structural ring.  Since no 10T truth label exists,
  // peakTc===MIN_TEETH on a non-tiny contour is always a false reading.
  // Abstain rather than returning a confident wrong count on XL gears.
  // Guard: finalTc < 20 ensures we only catch inner-contour small-count
  // lock-on, not legitimate mid/large detections where peakTc might alias.
  if (peakTc === MIN_TEETH
      && finalTc > 0 && finalTc < 20
      && contourRadius > minDim * 0.15) {
    // PAP-868 Option A: fft90-XL-rescue.  When the pap632-fft-floor abstain
    // would fire BUT the gear is physically large (gearR > 30% minDim) AND
    // fft90 reads at chainring scale (>= 30T), the outer-band fft90 signal
    // is reading the real outer tooth ring while the multi-radius FFT
    // collapsed onto an inner feature.  Trust fft90tc instead of abstaining.
    // Floor finalRel at 0.10 so the rescue commits as confident.
    // QA cross-check via PAP-871: 0 fires on 305-photo training corpus
    // (peak===MIN_TEETH ∧ fft90>=30 ∧ gearR>0.30 simultaneously is empty
    // in training); 2 b112 XL wins (05-34-20 → 43, 05-35-59 → 42).
    // Targets: 2026-04-30_05-34-20-458Z (42T, peak=10, fft90=43, gearR=0.484);
    // 2026-04-30_05-35-59-637Z (42T, peak=10, fft90=42, gearR=0.319).
    if (fft90tc >= 30
        && gearR > minDim * 0.30
        && contourRadius > minDim * 0.20) {
      console.log(`[pap868-fft90-xl-rescue-A] peak=${peakTc} fft90=${fft90tc} ` +
        `op=${opTc} bc=${bcTc}(peaks=${bcPeaks}) ` +
        `gearR=${gearR} contourR=${contourRadius} minDim=${minDim} → committing fft90`);
      finalTc = fft90tc;
      finalRel = Math.max(finalRel, 0.10);
      methodUsed = methodUsed + '+pap868-fft90-xl-rescue-A';
    } else {
      console.log(`[pap632-fft-floor-abstain] peak=${peakTc} fft90=${fft90tc} ` +
        `final=${finalTc} bc=${bcTc}(peaks=${bcPeaks}) op=${opTc}(rel=${opRel.toFixed(3)}) ` +
        `gearR=${gearR} contourR=${contourRadius} minDim=${minDim}`);
      finalTc = 0;
      finalRel = 0;
      methodUsed = methodUsed + '+pap632-fft-floor-abstain';
    }
  }

  const confidence = Math.min(1.0, Math.max(0.0, (finalRel - 0.05) / 0.15));

  const finalR = peakR > 0 ? peakR : gearR;

  // PAP-815: outer-edge anchor radius (outermost prominent radial-mean
  // |dI/dr| peak in [0.30·peakR, 1.50·peakR], anchored at bc center when
  // self-validated, else algo center).  Per QA PAP-818 the actual safety
  // mechanism is the rel-disagree threshold (0.18) — gating the computation
  // on chainring regime would silently disable AC1/AC2 because the failure
  // photos have all signal channels collapsed to inner-feature aliases
  // (peakTc=12 etc).  Compute whenever peakR is available; cost is bounded
  // (256 rays × ~300 r-values, ms-scale) and amortized vs. algorithm
  // baseline.  Returned on the result so countTeeth/countTeethFromRgba can
  // evaluate the inner-feature-lock abstain without re-doing the work.
  let rOuter = 0;
  if (peakR > 0) {
    rOuter = radialOuterEdgeRadius(enhanced, cx, cy, bcCx, bcCy, peakR, width, height);
  }

  return {
    toothCount: finalTc,
    confidence,
    cx, cy, gearR: finalR, initialGearR: gearR,
    contourRadius,
    centerResult,
    fft90tc, peakTc, peakRel, peakR, opTc, opRel,
    bcTc, bcPurity, bcPeaks, bcCx, bcCy,
    claheTc, claheConf,
    rOuter,
    methodUsed,
  };
}

// ── 14. Off-center retry (PAP-162: port of Python _retry_near_center) ─────
//
// When the detected center is far from the image center (aim circle) and
// confidence is low, the algorithm may have locked onto a background feature.
// Re-run with the center forced near the image center using a two-pass
// coarse-to-fine search:
//   1. Coarse: ±80px step 20, radii 10%-42% of min dim (step 8)
//   2. Fine:   ±15px step 5 around coarse-best position and radius
//   3. Final refinement via refineCenterBySymmetry

function retryNearCenter(gray, enhanced, edges, width, height, imgCx, imgCy, aimR = 0) {
  const h = height, w = width;
  let bestPurity = 0.0;
  let bestCx = imgCx, bestCy = imgCy, bestR = Math.floor(Math.min(h, w) / 4);

  // Search radii from 10% to 42% of image min dim
  const minR = Math.max(30, Math.floor(Math.min(h, w) * 0.10));
  const maxR = Math.floor(Math.min(h, w) * 0.42);

  // PAP-313 port: coarse pass tracks top candidates by purity so we can
  // later filter by frequency plausibility (matching Python behavior).
  const coarseCandidates = []; // { purity, cx, cy, r }
  for (let r = minR; r < maxR; r += 20) {
    for (let dx = -90; dx <= 90; dx += 30) {
      for (let dy = -90; dy <= 90; dy += 30) {
        const tcx = Math.min(Math.max(imgCx + dx, 10), w - 10);
        const tcy = Math.min(Math.max(imgCy + dy, 10), h - 10);
        const p = fftPurityCheck(enhanced, tcx, tcy, r, w, h, true);
        if (p > 0.03) {
          coarseCandidates.push({ purity: p, cx: tcx, cy: tcy, r });
        }
      }
    }
  }

  if (coarseCandidates.length === 0) return null;

  // Sort by purity descending
  coarseCandidates.sort((a, b) => b.purity - a.purity);

  // PAP-313 port: frequency plausibility — prefer candidates whose
  // dominant FFT frequency is in the valid tooth range (11-34).
  // Background patterns (paper edges, surface texture) produce high
  // purity but frequencies outside this range.
  let selected = null;
  for (let i = 0; i < Math.min(coarseCandidates.length, 10); i++) {
    const c = coarseCandidates[i];
    const { freq } = fftDominantFreq(enhanced, c.cx, c.cy, c.r, w, h);
    if (freq >= MIN_TEETH && freq <= 34) {
      selected = c;
      break;
    }
  }
  // Fall back to best overall purity if no freq-valid candidate
  if (!selected) selected = coarseCandidates[0];

  bestPurity = selected.purity;
  bestCx = selected.cx;
  bestCy = selected.cy;
  bestR = selected.r;

  // Fine pass: refine around coarse-best position and radius.
  // Uses fast purity — refineCenterBySymmetry (called after)
  // provides full-precision final refinement.
  let fineCx = bestCx, fineCy = bestCy, fineR = bestR;
  let finePurity = bestPurity;
  const rLo = Math.max(minR, bestR - 15);
  const rHi = Math.min(maxR, bestR + 16);
  for (let r = rLo; r < rHi; r += 5) {
    for (let dx = -10; dx <= 10; dx += 5) {
      for (let dy = -10; dy <= 10; dy += 5) {
        const tcx = Math.min(Math.max(bestCx + dx, 10), w - 10);
        const tcy = Math.min(Math.max(bestCy + dy, 10), h - 10);
        const p = fftPurityCheck(enhanced, tcx, tcy, r, w, h, true);
        if (p > finePurity) {
          finePurity = p;
          fineCx = tcx;
          fineCy = tcy;
          fineR = r;
        }
      }
    }
  }

  bestCx = fineCx;
  bestCy = fineCy;
  bestR = fineR;
  bestPurity = finePurity;

  if (bestPurity < 0.05) return null;

  // Final center refinement via rotational symmetry
  const refined = refineCenterBySymmetry(enhanced, bestCx, bestCy, bestR, w, h);

  // Re-run full analysis at the new center
  // Temporarily override findGearCenter by passing a pre-set center
  const retryResult = analyzeImageAtCenter(
    gray, enhanced, edges, w, h,
    refined.cx, refined.cy, bestR, aimR,
  );

  return retryResult;
}

// Analyze image with a pre-determined center (used by retryNearCenter)
function analyzeImageAtCenter(gray, enhanced, edges, width, height, cx, cy, contourRadius, aimR = 0) {
  const gearR = contourRadius > 20
    ? contourRadius
    : findGearRadius(edges, cx, cy, width, height);

  const fft90tc = fftAtOuterRadii(enhanced, cx, cy, contourRadius, gearR, edges, width, height);

  let peakTc = 0, peakRel = 0, peakR = 0;
  ({ peakTc, peakRel, peakR } = multiRadiusFftScan(enhanced, edges, cx, cy, gearR, width, height, aimR));

  const maxRop = Math.min(cx, width - cx, cy, height - cy) - 1;
  let opTc = 0, opRel = 0;
  ({ opTc, opRel } = outerProfileScan(edges, cx, cy, maxRop, width, height, gearR));

  const { bcTc, bcPurity, bcPeaks, bcCx, bcCy } = binaryContourCount(gray, cx, cy, width, height);

  let claheTc = 0, claheConf = 0;
  ({ claheTc, claheConf } = clahePeakCounting(enhanced, cx, cy, gearR, width, height));

  let finalRel = peakRel > 0 ? peakRel : (opRel > 0 ? opRel : 0);
  const fftConf = Math.min(1.0, Math.max(0.0, (finalRel - 0.05) / 0.15));
  const innerBoreSuspect2 = contourRadius > 40 && peakR > 0 && peakR < contourRadius * 0.55;

  let finalTc = 0;
  let methodUsed = 'none';

  const bcConsensus2 = bcPurity >= 0.08
    && bcPeaks >= MIN_TEETH && bcPeaks <= MAX_TEETH
    && bcTc >= MIN_TEETH && bcTc <= MAX_TEETH
    && Math.abs(bcTc - bcPeaks) <= 2;

  if (bcConsensus2) {
    if (fftConf >= 0.70 && peakTc > 0 && !innerBoreSuspect2
        && Math.abs(peakTc - bcTc) <= 2) {
      finalTc = peakTc;
      methodUsed = 'bc-consensus+peak';
    } else if (peakTc > 0 && fft90tc > 0
        && peakTc === fft90tc
        && fftConf >= 0.40
        && Math.abs(peakTc - bcTc) <= 1) {
      // PAP-300: FFT agreement override (see analyzeImage)
      finalTc = peakTc;
      methodUsed = 'bc-consensus+fft-agree';
    } else if (bcTc >= 30 && bcPeaks >= 30 && Math.abs(bcTc - bcPeaks) <= 2) {
      // PAP-810 Option 2 (QA PAP-811 approved): chainring-regime bcPk
      // tiebreak.  At ≥30T, the bc-FFT can lock to an off-by-1 sub-bin
      // (e.g. 52T → bcTc=53, bcPeaks=52); the silhouette peak count is
      // a more direct outer-ring signal in the chainring regime.  When
      // bcTc and bcPeaks both land in chainring territory and agree
      // within ±2, prefer bcPeaks.  Only fires after the peak / fft-agree
      // overrides above, so it never overrides a high-conf FFT vote.
      finalTc = bcPeaks;
      methodUsed = 'bc-consensus+chainring-pk';
    } else {
      finalTc = bcTc;
      methodUsed = 'bc-consensus';
    }
    finalRel = Math.max(finalRel, bcPurity * 0.50);
  } else if (fftConf >= 0.70 && peakTc > 0 && !innerBoreSuspect2) {
    finalTc = peakTc;
    methodUsed = 'peak';
  } else if (bcPurity >= 0.20 && bcTc >= MIN_TEETH && bcTc <= MAX_TEETH) {
    finalTc = bcTc;
    // PAP-308 port: match main analyzeImage multiplier (0.30 → 0.50)
    finalRel = Math.max(finalRel, bcPurity * 0.50);
    methodUsed = 'bc-fft';
  } else if (bcPurity >= 0.05 && bcPeaks >= MIN_TEETH && bcPeaks <= MAX_TEETH) {
    if (fft90tc > 0 && bcTc > 0 && fft90tc === bcTc && Math.abs(fft90tc - bcPeaks) === 1) {
      finalTc = fft90tc;
    } else if (peakTc > 0 && fft90tc > 0 && peakTc === fft90tc && Math.abs(peakTc - bcPeaks) === 1) {
      finalTc = peakTc;
    } else {
      finalTc = bcPeaks;
    }
    finalRel = Math.max(finalRel, bcPurity * 0.25);
    methodUsed = 'bc-peaks';
  } else if (fft90tc > 0) {
    finalTc = fft90tc;
    methodUsed = 'fft90-fallback';
  } else if (peakRel >= 0.15 && peakTc >= MIN_TEETH) {
    finalTc = peakTc;
    methodUsed = 'multiR';
  } else if (opTc > 0 && opRel >= 0.10) {
    finalTc = opTc;
    methodUsed = 'outer';
  } else if (peakTc > 0) {
    finalTc = peakTc;
    methodUsed = 'multiR-fallback';
  } else if (claheTc > 0 && claheConf >= 0.5) {
    finalTc = claheTc;
    methodUsed = 'clahe';
  }

  const confidence = Math.min(1.0, Math.max(0.0, (finalRel - 0.05) / 0.15));
  const finalR = peakR > 0 ? peakR : gearR;

  // PAP-815: outer-edge anchor (mirror of analyzeImage block — see there
  // for rationale on why the perf gate is omitted).  Retry path can replace
  // the primary result, so it must surface rOuter too.
  let rOuter = 0;
  if (peakR > 0) {
    rOuter = radialOuterEdgeRadius(enhanced, cx, cy, bcCx, bcCy, peakR, width, height);
  }

  return {
    toothCount: finalTc,
    confidence,
    cx, cy, gearR: finalR, initialGearR: gearR,
    contourRadius,
    centerResult: { cx, cy, radius: contourRadius, method: 'retry-near-center' },
    fft90tc, peakTc, peakRel, peakR, opTc, opRel,
    bcTc, bcPurity, bcPeaks, bcCx, bcCy,
    claheTc, claheConf,
    rOuter,
    methodUsed: 'retry-' + methodUsed,
  };
}

export async function countTeeth(photoUri, signal, opts) {
  const t0 = Date.now();

  // Yield to the event loop so pending UI events (e.g. cancel press) can
  // be processed, then check if the caller aborted.
  const yieldOrAbort = async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    if (signal?.aborted) throw new DOMException('Processing cancelled', 'AbortError');
  };

  // PAP-476: optional aim-circle pre-crop metadata.
  // When the caller has already cropped the source photo to the aim-circle
  // bounding square (CameraScreen.cropToAimCircle), this metadata lets us:
  //   1. apply a circular white mask to the four corners so the algorithm
  //      only sees the inscribed circle (matches the on-screen aim circle).
  //   2. transform the returned gear center/radius from cropped-image
  //      coordinates back to original-photo fractional coordinates so
  //      ResultScreen's aimCrop overlay math keeps working.
  const aimCrop = opts && opts.aimCrop ? opts.aimCrop : null;

  // ── Image loading ──────────────────────────────────────────────────
  const { width, height, rgba } = await loadAndDecodeImage(photoUri);
  const t1 = Date.now();

  // ── Aim-circle mask (PAP-476 / PAP-672) ───────────────────────────��─
  // Mask radius is 0.49 * min(W, H), 4 % above the algorithm's existing
  // search radius cap (`Math.min(h, w) * 0.45`).  The 4 % margin ensures
  // Canny edges at the mask boundary fall outside every center/radius
  // candidate the algorithm evaluates.
  //
  // PAP-672: the crop now includes padding beyond the aim circle, so the
  // mask scales with the full (padded) crop dimensions.  This lets the
  // algorithm see the padded area — an off-center gear whose contour
  // extends past the old aim-circle boundary is no longer clipped.
  if (aimCrop) {
    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;
    const maskR = 0.49 * Math.min(width, height);
    applyCircularMask(rgba, width, height, cx, cy, maskR);
  }

  await yieldOrAbort();

  // ── Preprocessing ──────────────────────────────────────────────────
  const gray     = rgbaToGray(rgba, width, height);
  const enhanced = clahe(gray, width, height, 3.0, 8, 8);
  const blurred  = gaussianBlur5x5(enhanced, width, height);
  const edges    = cannyEdges(blurred, width, height, 50, 150);
  const t2 = Date.now();

  await yieldOrAbort();

  // PAP-1100: aim-circle prior on FFT sweep range (pre-hoc).  aimR matches
  // the post-hoc PAP-961 calibration (0.5 * min(W,H) when aimCrop present).
  const aimR = aimCrop ? 0.5 * Math.min(width, height) : 0;

  let r = analyzeImage(gray, enhanced, edges, width, height, aimR);
  const t3 = Date.now();
  // PAP-288: save initial radius from gear-region detection before
  // detect_teeth may shrink it to peak_r.
  const initialGearRadius = r.initialGearR;

  await yieldOrAbort();

  // ── Off-center, low-confidence retry (PAP-162) ────────────────────
  // When detected center is far from the aim circle and confidence is
  // low, the algorithm may have locked onto a background feature.
  // Re-run with center forced near image center.
  if (r.confidence < SMALL_GEAR_CONF && r.cx !== undefined && r.cy !== undefined) {
    const imgCx = Math.floor(width / 2);
    const imgCy = Math.floor(height / 2);
    const cdist = Math.sqrt((r.cx - imgCx) ** 2 + (r.cy - imgCy) ** 2);
    // PAP-282: lowered from 0.15 → 0.08 so the retry fires more
    // aggressively for large gears whose detected center may be close
    // to image center but still wrong (e.g. locked onto a cutout hole).
    if (cdist > Math.min(height, width) * 0.08) {
      const retryR = retryNearCenter(gray, enhanced, edges, width, height, imgCx, imgCy, aimR);
      // PAP-282: accept retry if confidence is within 0.05 of original
      // (the original may have misleadingly high confidence from cutout
      // artifacts) AND tooth-density sanity check passes (reject retry
      // results where tooth count is unrealistically low for the radius).
      // PAP-288: sub-harmonic guard — reject retry when its count is a
      // sub-harmonic (half or third) of the initial detection.  Spider-arm
      // features create strong 12-fold or 10-fold symmetry that can dominate
      // at inner radii, producing counts like 12 vs actual 24.
      const isSubharmonic = retryR !== null
          && r.toothCount > 0 && retryR.toothCount > 0
          && [2, 3].some(k => Math.abs(retryR.toothCount * k - r.toothCount) <= 1);
      // PAP-288: radius consistency guard — reject retry when its radius
      // is much smaller than initial (< 80%).  The retry should refine the
      // center for the same gear, not lock onto a smaller inner feature.
      const radiusShrunk = retryR !== null
          && initialGearRadius > 100
          && retryR.gearR < initialGearRadius * 0.8;
      if (retryR !== null
          && !isSubharmonic
          && !radiusShrunk
          && retryR.confidence > r.confidence - 0.05
          && (retryR.gearR <= 150 || retryR.toothCount > retryR.gearR / 15)) {
        console.log(`[GearCounter] off-center retry: center (${r.cx},${r.cy})→(${retryR.cx},${retryR.cy}), ` +
          `${r.toothCount}T(${(r.confidence*100).toFixed(0)}%)→` +
          `${retryR.toothCount}T(${(retryR.confidence*100).toFixed(0)}%)`);
        r = retryR;
      }
    }
  }

  // ── Small-gear retry at higher resolution ──────────────────────────
  // When the gear is small in the frame and confidence is low, re-run
  // at 1500 px to give the FFT more pixels per tooth.
  await yieldOrAbort();
  if (r.confidence < SMALL_GEAR_CONF
      && r.gearR / width <= SMALL_GEAR_RADIUS_FRAC
      && r.toothCount > 0) {
    const hi = await loadAndDecodeImage(photoUri, RETRY_MAX_DIM);
    const hiGray     = rgbaToGray(hi.rgba, hi.width, hi.height);
    const hiEnhanced = clahe(hiGray, hi.width, hi.height, 3.0, 8, 8);
    const hiBlurred  = gaussianBlur5x5(hiEnhanced, hi.width, hi.height);
    const hiEdges    = cannyEdges(hiBlurred, hi.width, hi.height, 50, 150);
    const r2 = analyzeImage(hiGray, hiEnhanced, hiEdges, hi.width, hi.height);
    if (r2.confidence > r.confidence) {
      console.log(`[GearCounter] small-gear retry: ${width}→${hi.width}px, ` +
        `${r.toothCount}T(${(r.confidence*100).toFixed(0)}%)→` +
        `${r2.toothCount}T(${(r2.confidence*100).toFixed(0)}%)`);
      r = r2;
    }
  }
  // ──────────────────────────────────────────────────────────────────

  const t4 = Date.now();

  console.log(
    `[GearCounter] ${width}×${height}px | ` +
    `load=${t1-t0}ms preprocess=${t2-t1}ms detect=${t3-t2}ms methods=${t4-t3}ms total=${t4-t0}ms\n` +
    `  center=(${r.cx},${r.cy}) method=${r.centerResult.method}\n` +
    `  contourR=${r.contourRadius} gearR=${r.gearR}\n` +
    `  fft90=${r.fft90tc}T | multiR=${r.peakTc}T(rel=${r.peakRel.toFixed(3)}) | ` +
    `outer=${r.opTc}T(rel=${r.opRel.toFixed(3)}) | ` +
    `bc=${r.bcTc}T(pur=${r.bcPurity.toFixed(3)},peaks=${r.bcPeaks}) | ` +
    `clahe=${r.claheTc}T(conf=${r.claheConf.toFixed(2)})\n` +
    `  → result=${r.toothCount}T conf=${(r.confidence * 100).toFixed(1)}% via=${r.methodUsed}`
  );

  // PAP-476: when the caller pre-cropped to an aim-circle square, translate
  // gear center/radius from cropped-image fractional coords back to original-
  // photo fractional coords.  ResultScreen (PAP-622) transforms these back to
  // aimCrop space for the overlay.
  let gearCenter = { x: r.cx / width, y: r.cy / height };
  let gearRadius = r.gearR / width;
  if (aimCrop) {
    const { originX, originY, side, fullW, fullH } = aimCrop;
    gearCenter = {
      x: (originX + (r.cx / width) * side) / fullW,
      y: (originY + (r.cy / height) * side) / fullH,
    };
    gearRadius = (r.gearR / width) * side / fullW;
  }

  // PAP-553: radius-sanity abstain (Rule B).
  // When the gear-region radius is suspiciously small, findGearCenter has
  // most likely locked onto an inner hub / bolt-circle rather than the
  // outer tooth ring.  The 0.13 floor is applied to `gearRadius` — the
  // value that will be returned in the result object.  Without aimCrop this
  // equals r.gearR/width (crop-space); with aimCrop it is the post-
  // transform full-image-space value.  PAP-633 fix: the original gate used
  // crop-space unconditionally, which missed detections where the aimCrop
  // ratio (side/fullW) mapped a suspicious full-image radius back above
  // 0.13 in crop-space (e.g. r_full=0.093, crop=0.154 at side/fullW=0.602).
  // PAP-673: conditional extension — r < 0.15 with toothCount >= 20 is
  // also suspicious (a real >=20T gear has r >= 0.20 on device; small
  // radius + high count means inner features were detected).
  //
  // PAP-684/PAP-685: upper-bound abstain — when contour radius (crop-space)
  // is small but tooth count falls in [9, 13], the algorithm has locked onto
  // an inner feature of a much larger gear (e.g. bolt circle on a spider
  // chainring) and is confidently wrong rather than abstaining.  A real
  // 9-13T cassette cog at crop-space r < 0.15 would trigger small-gear
  // retry (SMALL_GEAR_RADIUS_FRAC = 0.10); r in the 0.10–0.15 range with
  // tc 9-13 indicates an inner BCD/shoulder feature, not a tiny cog.
  // PAP-740: bump 0.15 → 0.17 to compensate for PAP-738 removing CROP_PAD_FRAC.
  // With pad=0 the crop side shrinks by 1/1.15, scaling every crop-fractional
  // radius up by 1.15× — without the bump, inner-feature hits previously in
  // [0.13, 0.15] (abstained) shift into [0.15, 0.17] (no longer abstained).
  const cropNormR = (r.contourRadius || 0) / Math.min(width, height);
  const upperBoundMismatch = cropNormR < 0.17
    && r.toothCount >= 9 && r.toothCount <= 13;
  // PAP-772: triple-method exact agreement override.  When peakTc, fft90tc,
  // and opTc all land on the same value as the chosen toothCount AND that
  // value is above the MIN_TEETH=10 sub-harmonic floor, three independent
  // counting methods (multi-radius FFT, outer-band FFT, outer-profile scan)
  // have converged on the same count — override the radius-sanity abstain
  // and commit.  The MIN_TEETH guard preserves PAP-685/686 chainring
  // suppression (52T inner-feature lock-on collapses peak/fft90 to 10).
  // QA cross-check via PAP-774: 132-photo Large+XL scan found 0 dangerous
  // triple rows that would be unblocked; predicted +14 / +0 on 11T cluster.
  const tripleAgree = r.peakTc === r.fft90tc
    && r.peakTc === r.opTc
    && r.peakTc === r.toothCount
    && r.peakTc > MIN_TEETH;
  // PAP-792: bc-strong-disagree override.  When the binary-contour method
  // is internally self-consistent (bcTc===bcPeaks) at the chosen toothCount
  // AND peakTc has collapsed far below it (|bcTc-peakTc|>5), the bc method
  // (which auto-recenters via component centroid) has resolved a different
  // feature than peakTc — the outer tooth ring rather than an inner-feature
  // sub-harmonic.  Override the radius-sanity abstain in that case.
  // The trap pattern (peakTc===bcTc on the same inner feature, e.g. the
  // 52T 28/28/28/28 4-method consensus) is excluded by the |Δ|>5 guard.
  // QA cross-check via PAP-796: 292-photo full 9-60T audit found 2 wins
  // (24T Large + 42T XL) and 0 losses; threshold sweep [5..15] all clean.
  const bcStrongAgree = r.bcTc === r.bcPeaks
    && Math.abs(r.bcTc - r.peakTc) > 5
    && r.toothCount === r.bcTc
    && r.bcTc > MIN_TEETH;
  // PAP-1059 (QA verdict via PAP-1063): chainring tooth-count confirmed bypass.
  // High-tooth (>=30T) abstain rescue when the committed toothCount is itself
  // independently confirmed by ≥2 channels at chainring scale.  Targets the
  // PAP-1052 detected==actual conf=0 cluster (45 photos, top accuracy
  // bottleneck) which dominantly fires PAP-961 aimPriorAbstain (3/5 seeds) or
  // PAP-815 radialChainringFires (2/5).  Branch A' requires peakTc===tc PLUS a
  // second corroborator (bcTc>=30 or opTc===tc); branch B requires the bc
  // method self-consistent (bcTc===tc and bcPeaks within ±1 of bcTc).  The
  // tc>=30 floor is stricter than tripleAgree/bcStrongAgree (>10) so
  // Small/Mid/Large commits cannot fire the bypass — structural protection.
  // QA full 356-photo sweep (debug-reports/pap1063_full_sweep_2026-05-02.log):
  // refined A'∪B = +26 XL WIN / 0 LOSS Small/Mid/Large/XL.  Original A∪B
  // (peakTc===tc alone, no second-channel guard) regressed 1 XL row to
  // confident-wrong (10-54-55 act=42 d=40 single-peak) and was rejected by QA.
  // Bypasses all three existing abstain mechanisms (radiusSanityAbstain,
  // radialChainringFires, bcIsolatedHighDelta) since the AC1 seeds hit
  // different ones.  Method tag: pap1059-chainring-tc-confirmed.
  const chainringTcConfirmed =
    r.toothCount >= 30
    && (
      (r.peakTc === r.toothCount && (r.bcTc >= 30 || r.opTc === r.toothCount))
      || (r.bcTc === r.toothCount && Math.abs(r.bcPeaks - r.bcTc) <= 1)
    );
  // PAP-889 (QA verdict via PAP-896, Path 2): XL center-collapse abstain.
  // When findGearCenter locks onto a tiny inner feature on an aim-cropped
  // capture (gearRadius < 0.20 in full-image fractional space) AND the
  // chosen toothCount is sub-chainring AND the commit is low-confidence,
  // the FFT channels disagreed enough that no other rescue gate fires
  // (triple/bcStrong) — the result is a confident-wrong sub-harmonic read.
  // Force conf=0.  329-photo training sweep + 15-frame XL device sweep
  // (`debug-reports/pap889_optA_sweep_2026-04-30.log`) showed conf<0.40
  // cleanly separates the b114 34T 10-09-03 target (conf=0.37) from
  // legitimate high-confidence small/mid gears (all LOSS rows ≥0.81)
  // while still rescuing 4 confident-wrong training rows (conf 0.14-0.37).
  const xlCenterCollapse = aimCrop != null
    && gearRadius < 0.20
    && r.toothCount < 30
    && r.confidence < 0.40
    && !tripleAgree
    && !bcStrongAgree;
  // PAP-939 (QA verdict via PAP-941, Cand-3): XL chainring inner-lock abstain.
  // On large chainrings (50-52T), findGearCenter sometimes locks onto the BCD /
  // spider mounting-bolt ring rather than the outer tooth tips.  The peakR
  // (multi-radius FFT chosen radius) and rOuter (outermost radial-gradient
  // peak) BOTH anchor on that inner band — so the PAP-815 radial-disagreement
  // gate (|peakR-rOuter|/rOuter ≥ 0.18) does NOT fire — yet the FFT methods
  // commit a sub-harmonic or alias count well below chainring scale.
  // Signature: gearRadius small (< 0.22 fullImage on aim-cropped capture),
  // committed toothCount sub-chainring (<35), but at least one channel
  // resolved a chainring-scale candidate (≥30T) AND peakR≈rOuter dual-inner-
  // lock (|Δ|/rOuter < 0.10).  Force conf=0.  QA cross-check (PAP-941):
  // 340-photo training corpus → 1 LOSS (b114 34T 10-17-13 conf=0.90 → abstain;
  // ≤ 1 cap), 0 b116 LOSS / 2 WIN (52T 08-22-10 conf=0.41, 08-26-34 conf=0.51
  // both forced conf=0), 0 prior-XL LOSS (b111/b112/b114 unaffected).
  // Mirror of PAP-815 pattern (chainringRegime + radial signal).
  const xlChainringInnerLock = aimCrop != null
    && gearRadius < 0.22
    && r.toothCount < 35
    && r.peakR > 0 && r.rOuter > 0
    && Math.abs(r.peakR - r.rOuter) / r.rOuter < 0.10
    && (r.peakTc >= 30 || r.fft90tc >= 30 || r.opTc >= 30
        || r.bcTc >= 30 || r.bcPeaks >= 30)
    && !tripleAgree
    && !bcStrongAgree;
  // PAP-963 (QA verdict V2 via PAP-1032): Campagnolo bolt-pattern abstain.
  // Targets b117 Campa case `report_2026-05-01_14-52-05-858Z` (true 50T,
  // committed toothCount∈{12,13}) where consensus assembled a 12/13 from
  // BCD-aliasing inside the true outer band — yet at least one channel still
  // resolved a chainring-scale candidate (≥30T).  V2 (final toothCount gate)
  // selected over V1 (peakTc) and V3 (bcTc) by 356-photo training + 39-photo
  // b111-b117 XL sweep: V2 = 0 LOSS / +1 WIN; V1 and V3 both regress XL.
  // Calibration mirror of PAP-939 Cand-3: outer 0.22 (this site) ↔
  // in-crop 0.365 (countTeethFromRgba).  Sweep log:
  // debug-reports/pap963_full_sweep_2026-05-01.log.  Late-stage abstain only;
  // does not alter PAP-861/868/885/889/939 paths.  Method tag:
  // pap963-campa-bolt-abstain.
  const campaBoltAbstain =
    r.toothCount >= 12 && r.toothCount <= 13
    && (r.fft90tc >= 30 || r.opTc >= 30 || r.bcTc >= 30 || r.bcPeaks >= 30)
    && gearRadius >= 0.22;
  // PAP-961 (QA verdict via PAP-964, threshold 0.65): aim-circle prior abstain.
  // Architectural successor to PAP-950: when the user has aim-cropped (post
  // PAP-738 the crop bounding box IS the aim-circle bounding square) and the
  // multi-radius FFT chosen peakR is far inside the user-aimed reticle, the
  // FFT anchored on a sub-aim-circle inner feature (BCD/spider/inner ring)
  // rather than the outer tooth tips.  Abstain-only — no commit override.
  // aimR = 0.5 * min(width, height) per cropToAimCircle inscribed-circle
  // calibration (memory: project_aimCircleFrac_unused.md).  Threshold 0.65
  // (vs 0.75) preserves the b111 05-33-35 confident-correct 52T row
  // (pk/aim=0.733).  Chainring-regime gate prevents Small/Mid spurious fires.
  // Override bypasses tripleAgree/bcStrongAgree match existing radius-sanity
  // gates; PAP-868/PAP-885 method tags are not bypassed because their rescue
  // path is also late-stage and the predicate fires before final commit
  // (mirror-side harness sweep `debug-reports/pap961_sweep_2026-05-02.log`
  // shows 0 LOSS on b111-b117 39-photo XL device panel + 1 WIN on b117
  // 15-14-08 52T; Small/Mid/Large training 0 LOSS each; +17 XL training
  // confident-correct sacrificed — documented tradeoff for the device-panel
  // win).  Method tag: pap961-aim-circle-prior-abstain.
  // PAP-1100: aimR is now hoisted to top of countTeeth (passed into the FFT
  // sweep range as a pre-hoc prior).  The post-hoc PAP-961 abstain below is
  // retained as defence-in-depth per QA verdict PAP-1106.
  const aimPriorAbstain = aimCrop != null
    && aimR > 0
    && (r.peakTc >= 30 || r.fft90tc >= 30 || r.opTc >= 30
        || r.bcTc >= 30 || r.bcPeaks >= 30)
    && r.peakR > 0 && r.peakR < 0.65 * aimR;
  const radiusSanityFires = gearRadius < 0.13
    || (gearRadius < 0.15 && r.toothCount >= 20)
    || upperBoundMismatch
    || xlCenterCollapse
    || xlChainringInnerLock
    || campaBoltAbstain
    || aimPriorAbstain;
  const radiusSanityAbstain = radiusSanityFires && !tripleAgree && !bcStrongAgree
    && !chainringTcConfirmed;

  // PAP-815 (QA verdict 2026-04-29: REJECT → re-spin per Option 4): radial-
  // channel inner-feature-lock abstain.  When the chosen multi-radius FFT
  // peakR disagrees with the outermost prominent radial-mean |dI/dr| peak
  // (R_outer) by ≥18% of R_outer, the FFT anchored on an inner
  // spider/bolt-circle feature rather than the true outer tooth ring.
  // Force conf=0.  Predicate can only push to abstain (never creates new
  // confident-wrong by construction).
  //
  // Gate (Option 4 per QA):
  //   1. chainring-regime: ANY of peakTc/fft90tc/opTc/bcTc/bcPeaks >= 30.
  //      Threshold-only firing on Small/Mid (chainring=false) regressed
  //      training 305-photo corpus by -117 confident-correct rows
  //      (Mid 89.5% → 39.5%, Small 62.7% → 15.7%, Large 43.1% → 12.8%).
  //      The chainring gate restores baseline behavior on those rows
  //      while preserving the +21 chainring-regime confident-wrong
  //      rescues (13 Large / 6 XL / 2 Mid).
  //   2. ac1-rescue narrow override: AC1 (52T 05-35-33) has all FFT
  //      signals collapsed to MIN_TEETH-floor (peakTc=12, fft90=12,
  //      opTc=12, bcTc=11) with bcPeaks=24 elevated — the bc-method
  //      detected the chainring's mounting-hole ring (24 holes) but
  //      consensus committed at 24 vs actual 52.  Override fires when:
  //      all four FFT-method tooth counts are <= MIN_TEETH+2 AND bcPeaks
  //      sits in [20, 30].  Tightly-scoped: training Mid 18T LOSS rows
  //      have peakTc=18 (>MIN_TEETH+2) so this override does NOT fire on
  //      them.
  //
  // AC2 (52T 05-39-22, all 5 channels === 21) is NOT rescued in this
  // iteration — its signature could fire on training rows with 5-way
  // agreement at 20-25T which would need a separate corpus sweep before
  // adding.  Sacrificed back to baseline-equivalent confident-wrong.
  // Threshold 0.18 retained from pre-flight.
  const chainringRegime =
    r.peakTc >= 30 || r.fft90tc >= 30 || r.opTc >= 30
    || r.bcTc >= 30 || r.bcPeaks >= 30;
  const ac1RescuePattern =
    r.peakTc <= MIN_TEETH + 2
    && r.fft90tc <= MIN_TEETH + 2
    && r.opTc <= MIN_TEETH + 2
    && r.bcTc <= MIN_TEETH + 2
    && r.bcPeaks >= 20 && r.bcPeaks <= 30;
  const radialChainringEligible = chainringRegime || ac1RescuePattern;
  const radialChainringFires =
    radialChainringEligible
    && r.peakR > 0 && r.rOuter > 0
    && Math.abs(r.peakR - r.rOuter) / r.rOuter >= 0.18;

  const radialRel = (r.peakR > 0 && r.rOuter > 0)
    ? Math.abs(r.peakR - r.rOuter) / r.rOuter
    : null;

  // PAP-861: bc-isolated-high-delta abstain.  When the bc-consensus method
  // chooses the bcTc fallback at chainring scale (bcTc>=30, bcPeaks>=30) but
  // ALL three FFT methods (peak, fft90, op) land >=10 below bcTc, the bc
  // method has resolved an inner concentric feature (BCD / mounting holes)
  // that the FFT methods don't see.  Force conf=0.  Targets b112 42T
  // 05-37-35 (peak=11 fft90=20 op=26 bc=39 → committed 39 confidently-wrong).
  // QA cross-check via pap861.candidates.js: 305-photo training corpus
  // 2 fires / 0 wins / 0 losses (all neutral); device-XL targets 1 win
  // (b112 05-37-35) / 0 losses across 10 frames.
  const bcIsolatedHighDelta = r.methodUsed === 'bc-consensus'
    && r.bcTc >= 30 && r.bcPeaks >= 30
    && r.peakTc > 0 && r.fft90tc > 0 && r.opTc > 0
    && (r.bcTc - r.peakTc) >= 10
    && (r.bcTc - r.fft90tc) >= 10
    && (r.bcTc - r.opTc) >= 10;

  // PAP-868 Option E: fft90 outer-ring rescue.  When radialChainringFires
  // would abstain BUT the FFT collapsed (peakTc===MIN_TEETH) AND fft90
  // reads at chainring scale (>=30T) AND op is fft90's half-frequency alias
  // (|fft90 − 2·op| ≤ 2), the outer-band fft90 is reading the real outer
  // tooth ring while peakR locked onto an inner feature (BCD / mounting
  // holes).  Bypass the radial-chainring abstain and commit fft90tc.
  // Predicate is structurally narrower than radialChainringFires (fires
  // only inside that gate).  QA cross-check via PAP-871: 1 b112 XL win
  // (05-35-59); 0 fires on 305-photo training corpus.
  // Target: 2026-04-30_05-35-59-637Z (42T, peak=10, fft90=42, op=20,
  // gearR=0.319, rel=0.231).
  const fft90OuterRescue =
    radialChainringFires
    && r.peakTc === MIN_TEETH
    && r.fft90tc >= 30
    && r.opTc > 0
    && Math.abs(r.fft90tc - 2 * r.opTc) <= 2
    && gearRadius > 0.30;

  // PAP-885: 5-way-agree override for radial-chainring abstain.  When
  // radialChainringFires would zero conf BUT all 5 FFT channels (peakTc,
  // fft90tc, opTc, bcTc, bcPeaks) read at chainring scale (>= 30) AND their
  // max-min spread is <= 1, rOuter has mis-anchored to an inner band — the
  // 5-way ±1 consensus on tooth count is stronger evidence than the radial
  // disagreement.  Bypass the abstain and commit r.toothCount with raw
  // confidence preserved.  QA cross-check via PAP-886: 2 wins on b114 36T
  // (10-19-19 conf=0→raw, 10-23-07 conf=0→raw); 0 fires on 13 prior XL
  // device frames (b111+b112) — predicate fails the >=30 gate on the b111
  // 52T 05-35-33 false-consensus row (peak/fft90/op=12, bcPk=24) and the
  // b111 52T 05-39-22 sub-chainring 5-way-21 row (chFires=N).
  // Mutually exclusive with bcIsolatedHighDelta (requires bcTc-peak >=10)
  // and fft90OuterRescue (requires peakTc===MIN_TEETH).
  const fiveWayChainringAgree = (() => {
    if (!radialChainringFires) return false;
    const ch = [r.peakTc, r.fft90tc, r.opTc, r.bcTc, r.bcPeaks];
    if (ch.some((v) => v < 30)) return false;
    return Math.max(...ch) - Math.min(...ch) <= 1;
  })();

  const innerContourSuspected = radiusSanityAbstain
    || (radialChainringFires && !fft90OuterRescue && !fiveWayChainringAgree
        && !chainringTcConfirmed)
    || (bcIsolatedHighDelta && !chainringTcConfirmed);
  let finalToothCount = r.toothCount;
  let finalConfidence = innerContourSuspected ? 0 : r.confidence;
  if (fft90OuterRescue) {
    finalToothCount = r.fft90tc;
    finalConfidence = Math.max(r.confidence, 0.10);
  }

  if (radiusSanityAbstain) {
    console.log(
      `[GearCounter] radius-sanity abstain: r=${gearRadius.toFixed(4)} tc=${r.toothCount} — ` +
      `inner-contour suspected. raw conf=${r.confidence.toFixed(2)} → forcing conf=0.`
    );
    if (campaBoltAbstain) {
      // PAP-963 AC2: identifiable method tag for QA grep.
      console.log(
        `[GearCounter] pap963-campa-bolt-abstain: tc=${r.toothCount} ` +
        `fft90=${r.fft90tc} op=${r.opTc} bc=${r.bcTc}(pk=${r.bcPeaks}) ` +
        `r=${gearRadius.toFixed(4)} — forcing conf=0.`
      );
    }
    if (aimPriorAbstain) {
      // PAP-961: identifiable method tag for QA grep.
      const ratio = aimR > 0 ? (r.peakR / aimR).toFixed(3) : 'n/a';
      console.log(
        `[GearCounter] pap961-aim-circle-prior-abstain: tc=${r.toothCount} ` +
        `peakR=${r.peakR} aimR=${aimR.toFixed(0)} pk/aim=${ratio} ` +
        `peak=${r.peakTc} fft90=${r.fft90tc} op=${r.opTc} ` +
        `bc=${r.bcTc}(pk=${r.bcPeaks}) — forcing conf=0.`
      );
    }
  } else if (radiusSanityFires && tripleAgree) {
    console.log(
      `[GearCounter] PAP-772 triple-agree override: tc=${r.toothCount} ` +
      `peak=${r.peakTc} fft90=${r.fft90tc} op=${r.opTc} ` +
      `r=${gearRadius.toFixed(4)} cropNR=${cropNormR.toFixed(3)} — committing.`
    );
  } else if (radiusSanityFires && bcStrongAgree) {
    console.log(
      `[GearCounter] PAP-792 bc-strong-disagree override: tc=${r.toothCount} ` +
      `bcTc=${r.bcTc} bcPk=${r.bcPeaks} peak=${r.peakTc} dPB=${Math.abs(r.bcTc - r.peakTc)} ` +
      `r=${gearRadius.toFixed(4)} cropNR=${cropNormR.toFixed(3)} — committing.`
    );
  } else if ((radiusSanityFires
              || (radialChainringFires && !fft90OuterRescue && !fiveWayChainringAgree)
              || bcIsolatedHighDelta)
             && chainringTcConfirmed) {
    // PAP-1059: identifiable method tag for QA grep on harness logs.
    console.log(
      `[GearCounter] pap1059-chainring-tc-confirmed: tc=${r.toothCount} ` +
      `peak=${r.peakTc} fft90=${r.fft90tc} op=${r.opTc} bc=${r.bcTc}(pk=${r.bcPeaks}) ` +
      `r=${gearRadius.toFixed(4)} — committing.`
    );
  }
  if (fft90OuterRescue) {
    console.log(
      `[GearCounter] PAP-868 fft90-outer-rescue-E: tc=${r.toothCount}→${r.fft90tc} ` +
      `peak=${r.peakTc} fft90=${r.fft90tc} op=${r.opTc} ` +
      `peakR=${r.peakR} rOuter=${r.rOuter} rel=${radialRel.toFixed(4)} ` +
      `gearR=${gearRadius.toFixed(4)} — committing fft90.`
    );
  } else if (radialChainringFires) {
    console.log(
      `[GearCounter] PAP-815 radial-chainring abstain: tc=${r.toothCount} ` +
      `peak=${r.peakTc} fft90=${r.fft90tc} op=${r.opTc} bc=${r.bcTc}(pk=${r.bcPeaks}) ` +
      `peakR=${r.peakR} rOuter=${r.rOuter} rel=${radialRel.toFixed(4)} — forcing conf=0.`
    );
  }

  // PAP-1538 (PAP-1536 amendment): mirror the harness path's methodUsed
  // enrichment (see countTeethFromRgba ~line 3471) so the production UX can
  // OR chainringRegime with chainring-specific abstain tags.  PAP-1537
  // cross-check measured chainringRegime alone fires on only 51.2% of the
  // 80-photo chainring corpus (big-cluster 42T/52T misses have all 5 FFT
  // channels collapsed to small-cassette range); the union with method
  // tags is needed to hit the AC1 ≥90% gate.  No algorithm change —
  // both the predicates and console.log fires above already exist.
  let methodUsed = r.methodUsed;
  if (radiusSanityAbstain && campaBoltAbstain) {
    methodUsed = `${methodUsed}+pap963-campa-bolt-abstain`;
  }
  if (radiusSanityAbstain && aimPriorAbstain) {
    methodUsed = `${methodUsed}+pap961-aim-circle-prior-abstain`;
  }
  if (chainringTcConfirmed
      && (radiusSanityFires || radialChainringFires || bcIsolatedHighDelta)) {
    methodUsed = `${methodUsed}+pap1059-chainring-tc-confirmed`;
  }

  return {
    toothCount: finalToothCount,
    confidence: finalConfidence,
    gearCenter,
    gearRadius,
    algorithmRuntimeMs: t4 - t0,
    innerContourSuspected,
    // PAP-815 instrumentation: outer-edge anchor diagnostic surfaced for
    // debug JSON capture (per QA PAP-818 implementation gate 3).  peakR is
    // the multi-radius FFT chosen radius; rOuter is the outermost prominent
    // radial-gradient peak in [0.30·peakR, 1.50·peakR]; radialRelDisagree
    // is |peakR - rOuter|/rOuter and is ≥0.18 when the chainring abstain
    // fires.  All three null/0 outside chainring regime to keep the report
    // payload small for small/mid corpus.
    peakR: r.peakR,
    rOuter: r.rOuter,
    radialRelDisagree: radialRel,
    // PAP-1536 (PAP-758 v1 chainring descope): surface the existing PAP-961
    // / PAP-815 chainring-regime cue and the aim-circle prior radius (aimR)
    // so the UX layer can show a "Chainring not supported in v1" abstain
    // screen and emit telemetry.  No algorithm behaviour change — this is
    // a read-only export of internals already computed above.  Consumers:
    //   • ResultScreen.jsx renders chainring abstain when chainringRegime
    //     OR methodUsed includes pap961/pap963/pap1059 (PAP-1538 union).
    //   • chainringAbstainTelemetry uploads {aimR, peakR, ratio, channels}.
    chainringRegime,
    aimR,
    methodUsed,
  };
}

// ── Test / validation harness exports (not for production use) ──────────────
// PAP-364 / PAP-379: exposed so a Node-side harness can validate the
// full pipeline against labeled training JPGs without needing an on-device
// build.  Keeps the underlying countTeeth() entry point unchanged.
// PAP-810 / PAP-811: sampleIntensityRing is diagnostic-only (used by the
// pap810.preflight harness to measure FFT magnitudes at the chosen peakR).
export const __test = {
  analyzeImage,
  analyzeImageAtCenter,
  retryNearCenter,
  binaryContourCount,
  traceOuterContour,
  rgbaToGray,
  clahe,
  gaussianBlur5x5,
  cannyEdges,
  findGearCenter,
  fftPurityCheck,
  sampleIntensityRing,
  // PAP-950 diagnostic: needed by pap950.diag.js to probe wide-band rOuter
  // and FFT-at-radius rescue without changing production behavior.
  fftCountAtRadius,
  radialOuterEdgeRadius,
};

export function countTeethFromRgba(rgba, width, height) {
  const gray     = rgbaToGray(rgba, width, height);
  const enhanced = clahe(gray, width, height, 3.0, 8, 8);
  const blurred  = gaussianBlur5x5(enhanced, width, height);
  const edges    = cannyEdges(blurred, width, height, 50, 150);
  // PAP-1100: harness path mirrors countTeeth's aimR convention.  Training
  // photos have no aimCrop input but the harness applies the same circular
  // mask convention (PAP-961 mirror at line 3383); aimR = 0.5*min(W,H)
  // unconditionally per existing parity protocol with countTeeth().
  const aimR = 0.5 * Math.min(width, height);
  let r = analyzeImage(gray, enhanced, edges, width, height, aimR);
  if (r.confidence < SMALL_GEAR_CONF && r.cx !== undefined && r.cy !== undefined) {
    const imgCx = Math.floor(width / 2);
    const imgCy = Math.floor(height / 2);
    const cdist = Math.sqrt((r.cx - imgCx) ** 2 + (r.cy - imgCy) ** 2);
    if (cdist > Math.min(height, width) * 0.08) {
      const retryR = retryNearCenter(gray, enhanced, edges, width, height, imgCx, imgCy, aimR);
      const isSubharmonic = retryR !== null
          && r.toothCount > 0 && retryR.toothCount > 0
          && [2, 3].some(k => Math.abs(retryR.toothCount * k - r.toothCount) <= 1);
      const radiusShrunk = retryR !== null
          && r.initialGearR > 100
          && retryR.gearR < r.initialGearR * 0.8;
      // PAP-632 Fix C: reject retry when primary FFT collapsed to MIN_TEETH
      // floor AND retry also found a small count.  Both primary and retry are
      // locked on inner features — accepting the retry just swaps one wrong
      // answer for another while potentially boosting confidence, producing a
      // high-confidence false positive on XL gears.
      // Target: 2026-04-25_09-03-08-982Z (52T, primary peak=10/fft90=13,
      // retry=12 conf=0.92 — all inner-hub readings).
      const primaryFftCollapse = r.peakTc === MIN_TEETH
          && retryR !== null && retryR.toothCount < 20;
      if (retryR !== null && !isSubharmonic && !radiusShrunk
          && !primaryFftCollapse
          && retryR.confidence > r.confidence - 0.05
          && (retryR.gearR <= 150 || retryR.toothCount > retryR.gearR / 15)) {
        r = retryR;
      }
    }
  }
  // PAP-553 + PAP-673 + PAP-684 + PAP-772: radius-sanity abstain — mirrors
  // countTeeth() so harness validation sees the same gate as on-device runs.
  const gearRadiusCropSpace = r.gearR / width;
  // PAP-684/PAP-685: upper-bound mismatch (crop-space)
  // PAP-740: bump 0.15 → 0.17 to match countTeeth() after pad removal.
  const cropNormR = (r.contourRadius || 0) / Math.min(width, height);
  const upperBoundMismatch = cropNormR < 0.17
    && r.toothCount >= 9 && r.toothCount <= 13;
  // PAP-772: triple-method exact agreement override (see countTeeth() for
  // full rationale; QA cross-check signed off via PAP-774).
  const tripleAgree = r.peakTc === r.fft90tc
    && r.peakTc === r.opTc
    && r.peakTc === r.toothCount
    && r.peakTc > MIN_TEETH;
  // PAP-792: bc-strong-disagree override — when bc-method self-recenters and
  // its tooth count agrees with its peak count (bcTc===bcPeaks) AND bc lands
  // far from the peakTc reading (|bcTc-peakTc|>5), bc has resolved a
  // different feature (outer ring) than the FFT methods (inner alias).
  // QA PAP-796 validated 2 wins / 0 losses on full 292-photo 9-60T corpus.
  const bcStrongAgree = r.bcTc === r.bcPeaks
    && Math.abs(r.bcTc - r.peakTc) > 5
    && r.toothCount === r.bcTc
    && r.bcTc > MIN_TEETH;
  // PAP-1059 (QA verdict via PAP-1063): chainring tooth-count confirmed bypass
  // mirror — see countTeeth() for full rationale (PAP-1052 detected==actual
  // conf=0 cluster, refined A'∪B = +26 XL WIN / 0 LOSS on 356-photo sweep).
  // Method tag: pap1059-chainring-tc-confirmed.
  const chainringTcConfirmed =
    r.toothCount >= 30
    && (
      (r.peakTc === r.toothCount && (r.bcTc >= 30 || r.opTc === r.toothCount))
      || (r.bcTc === r.toothCount && Math.abs(r.bcPeaks - r.bcTc) <= 1)
    );
  // PAP-889 (QA verdict via PAP-896, Path 2): XL center-collapse abstain
  // mirror — see countTeeth() for full rationale.  Harness call site has
  // no aimCrop (training photos are not pre-cropped), so the aimCrop
  // guard is omitted here — same pattern as PAP-553 / PAP-673 / PAP-684 /
  // PAP-772 mirrors above.  This means the harness conservatively
  // surfaces tc∈[14,19] regression risk on training photos that real
  // device captures (aimCrop != null) would also see.
  const xlCenterCollapse = gearRadiusCropSpace < 0.20
    && r.toothCount < 30
    && r.confidence < 0.40
    && !tripleAgree
    && !bcStrongAgree;
  // PAP-939 (QA verdict via PAP-941, Cand-3): XL chainring inner-lock abstain
  // mirror — see countTeeth() for full rationale.  Harness call site has no
  // aimCrop (training photos are not pre-cropped), so threshold is in
  // crop-space (gearRadiusCropSpace < 0.365 ≈ device fullImage 0.22 at
  // typical side/fullW=0.602).
  const xlChainringInnerLock = gearRadiusCropSpace < 0.365
    && r.toothCount < 35
    && r.peakR > 0 && r.rOuter > 0
    && Math.abs(r.peakR - r.rOuter) / r.rOuter < 0.10
    && (r.peakTc >= 30 || r.fft90tc >= 30 || r.opTc >= 30
        || r.bcTc >= 30 || r.bcPeaks >= 30)
    && !tripleAgree
    && !bcStrongAgree;
  // PAP-963 (QA verdict V2 via PAP-1032): Campagnolo bolt-pattern abstain
  // mirror — see countTeeth() for full rationale.  In-crop calibration:
  // gearRadiusCropSpace >= 0.365 ↔ device fullImage 0.22 (per harness sweep,
  // matches PAP-939 Cand-3 mirror).  Method tag: pap963-campa-bolt-abstain.
  const campaBoltAbstain =
    r.toothCount >= 12 && r.toothCount <= 13
    && (r.fft90tc >= 30 || r.opTc >= 30 || r.bcTc >= 30 || r.bcPeaks >= 30)
    && gearRadiusCropSpace >= 0.365;
  // PAP-961 (QA verdict via PAP-964): aim-circle prior abstain mirror.
  // Harness call site has no aimCrop input (training photos are not pre-
  // cropped), but the harness sweep harness applies the same circular mask
  // for XL device replay (`mobile/__tests__/lib/harness-runner.js` evalPhoto
  // applyMask=true) and treats the photo as the aim-cropped canvas (aim_r ≈
  // 0.5 * min(W, H)).  Mirror unconditionally on training photos for parity
  // with countTeeth() — same pattern as PAP-553/PAP-673/PAP-684/PAP-772 and
  // PAP-963 mirrors above.  Threshold 0.65 retained from QA verdict.  Sweep
  // log: debug-reports/pap961_sweep_2026-05-02.log.  Method tag:
  // pap961-aim-circle-prior-abstain.
  // PAP-1100: aimR is now hoisted to top of countTeethFromRgba (passed into
  // the FFT sweep range as a pre-hoc prior).  PAP-961 abstain retained as
  // defence-in-depth per QA verdict PAP-1106.
  const aimPriorAbstain = aimR > 0
    && (r.peakTc >= 30 || r.fft90tc >= 30 || r.opTc >= 30
        || r.bcTc >= 30 || r.bcPeaks >= 30)
    && r.peakR > 0 && r.peakR < 0.65 * aimR;
  const radiusSanityFires = gearRadiusCropSpace < 0.13
    || (gearRadiusCropSpace < 0.15 && r.toothCount >= 20)
    || upperBoundMismatch
    || xlCenterCollapse
    || xlChainringInnerLock
    || campaBoltAbstain
    || aimPriorAbstain;
  const radiusSanityAbstain = radiusSanityFires && !tripleAgree && !bcStrongAgree
    && !chainringTcConfirmed;
  // PAP-815 v2 (Option 4 per QA verdict 2026-04-29): chainring-regime gate
  // OR ac1-rescue narrow override; mirror of countTeeth() — see there for
  // full rationale and threshold provenance.
  const chainringRegime =
    r.peakTc >= 30 || r.fft90tc >= 30 || r.opTc >= 30
    || r.bcTc >= 30 || r.bcPeaks >= 30;
  const ac1RescuePattern =
    r.peakTc <= MIN_TEETH + 2
    && r.fft90tc <= MIN_TEETH + 2
    && r.opTc <= MIN_TEETH + 2
    && r.bcTc <= MIN_TEETH + 2
    && r.bcPeaks >= 20 && r.bcPeaks <= 30;
  const radialChainringEligible = chainringRegime || ac1RescuePattern;
  const radialChainringFires =
    radialChainringEligible
    && r.peakR > 0 && r.rOuter > 0
    && Math.abs(r.peakR - r.rOuter) / r.rOuter >= 0.18;
  const radialRel = (r.peakR > 0 && r.rOuter > 0)
    ? Math.abs(r.peakR - r.rOuter) / r.rOuter
    : null;
  // PAP-861: bc-isolated-high-delta abstain (mirror of countTeeth() — see
  // there for full rationale and QA cross-check provenance).
  const bcIsolatedHighDelta = r.methodUsed === 'bc-consensus'
    && r.bcTc >= 30 && r.bcPeaks >= 30
    && r.peakTc > 0 && r.fft90tc > 0 && r.opTc > 0
    && (r.bcTc - r.peakTc) >= 10
    && (r.bcTc - r.fft90tc) >= 10
    && (r.bcTc - r.opTc) >= 10;
  // PAP-868 Option E: fft90 outer-ring rescue (mirror of countTeeth() — see
  // there for full rationale and QA cross-check provenance via PAP-871).
  const fft90OuterRescue =
    radialChainringFires
    && r.peakTc === MIN_TEETH
    && r.fft90tc >= 30
    && r.opTc > 0
    && Math.abs(r.fft90tc - 2 * r.opTc) <= 2
    && gearRadiusCropSpace > 0.30;
  // PAP-885: 5-way-agree override (mirror of countTeeth() — see there for
  // full rationale and QA cross-check provenance via PAP-886).
  const fiveWayChainringAgree = (() => {
    if (!radialChainringFires) return false;
    const ch = [r.peakTc, r.fft90tc, r.opTc, r.bcTc, r.bcPeaks];
    if (ch.some((v) => v < 30)) return false;
    return Math.max(...ch) - Math.min(...ch) <= 1;
  })();
  const innerContourSuspected = radiusSanityAbstain
    || (radialChainringFires && !fft90OuterRescue && !fiveWayChainringAgree
        && !chainringTcConfirmed)
    || (bcIsolatedHighDelta && !chainringTcConfirmed);
  let finalToothCount = r.toothCount;
  let finalConfidence = innerContourSuspected ? 0 : r.confidence;
  if (fft90OuterRescue) {
    finalToothCount = r.fft90tc;
    finalConfidence = Math.max(r.confidence, 0.10);
  }
  // PAP-963 / PAP-961 / PAP-1059: identifiable method tags for QA grep on harness JSON.
  let methodUsed = r.methodUsed;
  if (radiusSanityAbstain && campaBoltAbstain) {
    methodUsed = `${methodUsed}+pap963-campa-bolt-abstain`;
  }
  if (radiusSanityAbstain && aimPriorAbstain) {
    methodUsed = `${methodUsed}+pap961-aim-circle-prior-abstain`;
  }
  if (chainringTcConfirmed
      && (radiusSanityFires || radialChainringFires || bcIsolatedHighDelta)) {
    methodUsed = `${methodUsed}+pap1059-chainring-tc-confirmed`;
  }
  return {
    toothCount: finalToothCount,
    confidence: finalConfidence,
    gearCenter: { x: r.cx / width, y: r.cy / height },
    gearRadius: r.gearR / width,
    innerContourSuspected,
    methodUsed,
    bcTc: r.bcTc, bcPurity: r.bcPurity, bcPeaks: r.bcPeaks,
    // PAP-810 / PAP-811: peakR is diagnostic-only (consumed by pap810.preflight).
    // PAP-815: rOuter (outermost radial-grad prom peak) and radialRelDisagree
    // surfaced for harness validation of the chainring abstain predicate.
    peakTc: r.peakTc, peakRel: r.peakRel, peakR: r.peakR,
    rOuter: r.rOuter,
    radialRelDisagree: radialRel,
    fft90tc: r.fft90tc, opTc: r.opTc, opRel: r.opRel,
  };
}
