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
import * as ImageManipulator from 'expo-image-manipulator';
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
const RETRY_MAX_DIM          = 1500;
// ────���─────────────────────────────────────────��─────────────────────────────

// ── 1. Image loading ───────────��─────────────────────────────────────────────

async function loadAndDecodeImage(photoUri, targetMaxDim = 1000) {
  const info    = await ImageManipulator.manipulateAsync(photoUri, [], {});
  const maxDim  = Math.max(info.width, info.height);
  const resizeOp = maxDim > targetMaxDim
    ? [{ resize: info.width >= info.height
        ? { width: Math.round(targetMaxDim * info.width / maxDim) }
        : { height: Math.round(targetMaxDim * info.height / maxDim) } }]
    : [];
  const resized = await ImageManipulator.manipulateAsync(
    photoUri,
    resizeOp,
    { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG },
  );

  const base64 = await FileSystem.readAsStringAsync(resized.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const binary = atob(base64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);

  const { width, height, data } = jpegDecode(buf, { useTArray: true });
  return { width, height, rgba: data };
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

function morphClose(mask, width, height, radius) {
  const n = width * height;
  const tmp = new Uint8Array(n);
  const out = new Uint8Array(n);
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

function morphOpen(mask, width, height, radius) {
  const n = width * height;
  const tmp = new Uint8Array(n);
  const out = new Uint8Array(n);
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

function labelComponents(mask, width, height, targetVal) {
  const n = width * height;
  const labels = new Int32Array(n);
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

  // Coarse pass (±25px, step 8 — full purity for accuracy)
  const coarse = search(cx, cy, r, 25, 8);
  // Fine pass (±4px, step 2 — full purity for precision)
  const fine = search(coarse.cx, coarse.cy, r, 4, 2);

  const shift = Math.sqrt((fine.cx - cx) ** 2 + (fine.cy - cy) ** 2);
  if (shift >= 3 && origPurity > 0 && fine.purity > origPurity * 1.15 && fine.purity >= 0.14) {
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

  const allCandidates = [];

  // Sweep thresholds 40–220 in steps of 15 (PAP-300: raised from 10 to
  // reduce connected-component labelling overhead on mobile)
  for (let thresh = 40; thresh < 220; thresh += 15) {
    for (const invert of [true, false]) {
      // Binary mask
      const mask = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        mask[i] = invert ? (gray[i] <= thresh ? 1 : 0) : (gray[i] > thresh ? 1 : 0);
      }

      // Morphological close then open (radius=2 for speed)
      const closed = morphClose(mask, w, h, 2);
      const cleaned = morphOpen(closed, w, h, 1);

      // Label components
      const { labels, components } = labelComponents(cleaned, w, h, 1);

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
        const compCx = comp.sx / comp.area;
        const compCy = comp.sy / comp.area;
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
    // Among candidates with acceptable purity (>= 0.04), prefer the
    // largest radius.  Inner features (bore splines, mounting holes)
    // often have higher purity than the outer teeth — especially on
    // textured backgrounds — but we want the outer tooth ring.
    const MIN_ACCEPTABLE_PURITY = 0.04;
    if (bestPurity >= MIN_ACCEPTABLE_PURITY) {
      let largestR = topCandidates[bestIdx].r;
      for (let i = 0; i < topCandidates.length; i++) {
        if (purities[i] >= MIN_ACCEPTABLE_PURITY && topCandidates[i].r > largestR) {
          largestR = topCandidates[i].r;
          bestIdx = i;
        }
      }
      bestPurity = purities[bestIdx];
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

    const winner = topCandidates[bestIdx];
    // Refine center by maximizing rotational symmetry
    const refined = refineCenterBySymmetry(enhanced, winner.cx, winner.cy, winner.r, w, h);
    return { cx: refined.cx, cy: refined.cy, radius: winner.r, method: 'multi-threshold' };
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

  if (bestComp) {
    // Use bbox radius for annular shapes (area-based underestimates)
    const dcBw = bestComp.maxX - bestComp.minX + 1;
    const dcBh = bestComp.maxY - bestComp.minY + 1;
    const areaR = Math.sqrt(bestComp.area / Math.PI);
    const bboxR2 = Math.max(dcBw, dcBh) / 2;
    return {
      cx: Math.round(bestComp.sx / bestComp.area),
      cy: Math.round(bestComp.sy / bestComp.area),
      radius: Math.round(Math.max(areaR, bboxR2 * 0.90)),
      method: 'otsu-contour',
    };
  }

  // Final fallback: center-weighted edge centroid with tight Gaussian
  // Use a narrow sigma to strongly bias toward center and reject corner artifacts
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
  if (wsum === 0) return { cx: Math.floor(cx0), cy: Math.floor(cy0), radius: 0, method: 'fallback' };

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
  return { cx: fcx, cy: fcy, radius: estR, method: 'edge-centroid' };
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

function multiRadiusFftScan(enhanced, edges, cx, cy, contourRadius, width, height) {
  const maxR = Math.min(
    Math.floor(Math.min(cx, width - cx, cy, height - cy)) - 1,
    contourRadius > 20 ? Math.floor(contourRadius * 1.35) : Math.floor(Math.min(height, width) / 3),
  );

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
      candSet.add(r);
    }
  }

  // Evenly-spaced outer radii
  const gr = contourRadius > 20 ? contourRadius : maxR;
  for (let pct = 65; pct < 85; pct += 4) candSet.add(Math.floor(gr * pct / 100));
  for (let pct = 85; pct < 108; pct += 2) candSet.add(Math.floor(gr * pct / 100));

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

function outerProfileScan(edges, cx, cy, maxR, width, height) {
  const nOp = N_ANGLES;
  const cosA = new Float64Array(nOp);
  const sinA = new Float64Array(nOp);
  for (let i = 0; i < nOp; i++) {
    const a = (2 * Math.PI * i) / nOp;
    cosA[i] = Math.cos(a);
    sinA[i] = Math.sin(a);
  }

  const outerRadii = new Float64Array(nOp);
  let remaining = nOp;
  for (let rScan = Math.floor(maxR * 0.95); rScan > 10 && remaining > 0; rScan -= 3) {
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

function binaryContourCount(gray, cx, cy, width, height) {
  const n = width * height;
  const BC_ANGLES = 4096;  // Must be power of 2 — avoids FFT zero-padding frequency shift
  const results = [];

  const otsuT = otsuThreshold(gray, width, height);

  // Multi-threshold sweep: try Otsu plus fixed thresholds to handle cases
  // where Otsu fails (e.g. metallic gears on white paper have similar
  // brightness, making Otsu separation impossible).  PAP-266.
  // PAP-300: reduced from step 35 (5 extras) to step 70 (2 extras) to
  // cut connected-component labelling overhead on mobile.
  const threshSet = new Set([otsuT]);
  for (let t = 80; t <= 200; t += 70) threshSet.add(t);
  const thresholds = [...threshSet].sort((a, b) => a - b);

  for (const thresh of thresholds) {
  for (const invert of [false, true]) {
    // Binary mask
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      mask[i] = invert ? (gray[i] <= thresh ? 1 : 0) : (gray[i] > thresh ? 1 : 0);
    }

    // Find connected components (external contours)
    const { labels, components } = labelComponents(mask, width, height, 1);

    for (const comp of components) {
      if (comp.touchesBorder) continue;

      // Extract boundary pixels for this component
      const bx = [], by = [];
      const y0 = Math.max(0, comp.minY);
      const y1 = Math.min(height - 1, comp.maxY);
      const x0 = Math.max(0, comp.minX);
      const x1 = Math.min(width - 1, comp.maxX);
      for (let y = y0; y <= y1; y++) {
        const row = y * width;
        for (let x = x0; x <= x1; x++) {
          if (labels[row + x] !== comp.id) continue;
          // Boundary pixel: has at least one 4-connected neighbour outside
          if (x === 0 || x === width - 1 || y === 0 || y === height - 1 ||
              labels[row + x + 1] !== comp.id || labels[row + x - 1] !== comp.id ||
              labels[(y + 1) * width + x] !== comp.id || labels[(y - 1) * width + x] !== comp.id) {
            bx.push(x);
            by.push(y);
          }
        }
      }

      if (bx.length < 100) continue;

      // Use the component's own centroid instead of the passed-in (cx, cy).
      // This decouples the radial profile from center detection errors —
      // critical for ring-shaped cassette cogs where findGearCenter may
      // lock onto inner features (bore, splines, mounting holes).
      const compCx = comp.sx / comp.area;
      const compCy = comp.sy / comp.area;

      // Build outer-envelope radius profile: for each angular bin, take
      // the maximum boundary radius.  This correctly handles ring-shaped
      // gears (cassette cogs) where inner splines would otherwise corrupt
      // the tooth signal.
      const rInterp = new Float64Array(BC_ANGLES);
      const binHit = new Uint8Array(BC_ANGLES);
      for (let i = 0; i < bx.length; i++) {
        const dx = bx[i] - compCx;
        const dy = by[i] - compCy;
        const angle = Math.atan2(dy, dx);                     // -π to π
        const bin = ((Math.floor(((angle + Math.PI) / (2 * Math.PI)) * BC_ANGLES) % BC_ANGLES) + BC_ANGLES) % BC_ANGLES;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r > rInterp[bin]) { rInterp[bin] = r; binHit[bin] = 1; }
      }

      // Check angular coverage: need ≥ 60% of bins populated
      let hitCount = 0;
      for (let i = 0; i < BC_ANGLES; i++) if (binHit[i]) hitCount++;
      if (hitCount < BC_ANGLES * 0.6) continue;

      // Fill empty bins via nearest-neighbor interpolation
      for (let i = 0; i < BC_ANGLES; i++) {
        if (binHit[i]) continue;
        // Search outward in both directions for nearest populated bin
        for (let d = 1; d < BC_ANGLES / 2; d++) {
          const prev = (i - d + BC_ANGLES) % BC_ANGLES;
          const next = (i + d) % BC_ANGLES;
          if (binHit[prev] && binHit[next]) {
            rInterp[i] = (rInterp[prev] + rInterp[next]) / 2;
            break;
          } else if (binHit[prev]) {
            rInterp[i] = rInterp[prev];
            break;
          } else if (binHit[next]) {
            rInterp[i] = rInterp[next];
            break;
          }
        }
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
/**
 * Core analysis pipeline — operates on already-loaded pixel buffers.
 * Returns { toothCount, confidence, gearCenter, gearRadius } in pixel units.
 */
function analyzeImage(gray, enhanced, edges, width, height) {
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
  ({ peakTc, peakRel, peakR } = multiRadiusFftScan(enhanced, edges, cx, cy, gearR, width, height));

  // Outer-profile scan
  let opTc = 0, opRel = 0;
  const maxRop = Math.min(cx, width - cx, cy, height - cy) - 1;
  ({ opTc, opRel } = outerProfileScan(edges, cx, cy, maxRop, width, height));

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
    finalTc = peakTc;
    methodUsed = 'fft-agreement';
  } else if (bcPurity >= 0.20 && bcTc >= MIN_TEETH && bcTc <= MAX_TEETH) {
    // 2. Binary contour FFT has high purity — use it
    finalTc = bcTc;
    finalRel = Math.max(finalRel, bcPurity * 0.30);
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
    finalTc = fft90tc;
    methodUsed = 'fft90-fallback';
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

  const confidence = Math.min(1.0, Math.max(0.0, (finalRel - 0.05) / 0.15));

  const finalR = peakR > 0 ? peakR : gearR;

  return {
    toothCount: finalTc,
    confidence,
    cx, cy, gearR: finalR, initialGearR: gearR,
    contourRadius,
    centerResult,
    fft90tc, peakTc, peakRel, opTc, opRel,
    bcTc, bcPurity, bcPeaks,
    claheTc, claheConf,
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

function retryNearCenter(gray, enhanced, edges, width, height, imgCx, imgCy) {
  const h = height, w = width;
  let bestPurity = 0.0;
  let bestCx = imgCx, bestCy = imgCy, bestR = Math.floor(Math.min(h, w) / 4);

  // Search radii from 10% to 42% of image min dim
  const minR = Math.max(30, Math.floor(Math.min(h, w) * 0.10));
  const maxR = Math.floor(Math.min(h, w) * 0.42);

  // Coarse pass: wide center range, fast purity for screening
  for (let r = minR; r < maxR; r += 20) {
    for (let dx = -60; dx <= 60; dx += 30) {
      for (let dy = -60; dy <= 60; dy += 30) {
        const tcx = Math.min(Math.max(imgCx + dx, 10), w - 10);
        const tcy = Math.min(Math.max(imgCy + dy, 10), h - 10);
        const p = fftPurityCheck(enhanced, tcx, tcy, r, w, h, true);
        if (p > bestPurity) {
          bestPurity = p;
          bestCx = tcx;
          bestCy = tcy;
          bestR = r;
        }
      }
    }
  }

  if (bestPurity < 0.03) return null;

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
    refined.cx, refined.cy, bestR,
  );

  return retryResult;
}

// Analyze image with a pre-determined center (used by retryNearCenter)
function analyzeImageAtCenter(gray, enhanced, edges, width, height, cx, cy, contourRadius) {
  const gearR = contourRadius > 20
    ? contourRadius
    : findGearRadius(edges, cx, cy, width, height);

  const fft90tc = fftAtOuterRadii(enhanced, cx, cy, contourRadius, gearR, edges, width, height);

  let peakTc = 0, peakRel = 0, peakR = 0;
  ({ peakTc, peakRel, peakR } = multiRadiusFftScan(enhanced, edges, cx, cy, gearR, width, height));

  const maxRop = Math.min(cx, width - cx, cy, height - cy) - 1;
  let opTc = 0, opRel = 0;
  ({ opTc, opRel } = outerProfileScan(edges, cx, cy, maxRop, width, height));

  const { bcTc, bcPurity, bcPeaks } = binaryContourCount(gray, cx, cy, width, height);

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
    finalRel = Math.max(finalRel, bcPurity * 0.30);
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

  return {
    toothCount: finalTc,
    confidence,
    cx, cy, gearR: finalR, initialGearR: gearR,
    contourRadius,
    centerResult: { cx, cy, radius: contourRadius, method: 'retry-near-center' },
    fft90tc, peakTc, peakRel, opTc, opRel,
    bcTc, bcPurity, bcPeaks,
    claheTc, claheConf,
    methodUsed: 'retry-' + methodUsed,
  };
}

export async function countTeeth(photoUri, signal) {
  const t0 = Date.now();

  // Yield to the event loop so pending UI events (e.g. cancel press) can
  // be processed, then check if the caller aborted.
  const yieldOrAbort = async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    if (signal?.aborted) throw new DOMException('Processing cancelled', 'AbortError');
  };

  // ── Image loading ──────────────────────────────────────────────────
  const { width, height, rgba } = await loadAndDecodeImage(photoUri);
  const t1 = Date.now();

  await yieldOrAbort();

  // ── Preprocessing ──────────────────────────────────────────────────
  const gray     = rgbaToGray(rgba, width, height);
  const enhanced = clahe(gray, width, height, 3.0, 8, 8);
  const blurred  = gaussianBlur5x5(enhanced, width, height);
  const edges    = cannyEdges(blurred, width, height, 50, 150);
  const t2 = Date.now();

  await yieldOrAbort();

  let r = analyzeImage(gray, enhanced, edges, width, height);
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
      const retryR = retryNearCenter(gray, enhanced, edges, width, height, imgCx, imgCy);
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

  return {
    toothCount: r.toothCount,
    confidence: r.confidence,
    gearCenter: { x: r.cx / width, y: r.cy / height },
    gearRadius: r.gearR / width,
    algorithmRuntimeMs: t4 - t0,
  };
}
