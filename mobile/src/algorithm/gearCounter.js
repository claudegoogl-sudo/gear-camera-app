/**
 * Gear Tooth Counter — JavaScript port of algorithm/gear_tooth_counter.py
 *
 * Pipeline (mirrors the Python implementation — commit 0d43382):
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
  findPeaks,
} from './imageUtils';

// ── Tuning constants (match Python defaults) ──────────��─────────────────────
const MIN_TEETH       = 10;
const MIN_TEETH_CLAHE = 8;
const MAX_TEETH       = 65;
const N_ANGLES        = 720;
// ────���─────────────────────────────────────────��─────────────────────────────

// ── 1. Image loading ───────────��─────────────────────────────────────────────

async function loadAndDecodeImage(photoUri) {
  const info    = await ImageManipulator.manipulateAsync(photoUri, [], {});
  const maxDim  = Math.max(info.width, info.height);
  const resizeOp = maxDim > 1000
    ? [{ resize: info.width >= info.height
        ? { width: Math.round(1000 * info.width / maxDim) }
        : { height: Math.round(1000 * info.height / maxDim) } }]
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

function morphClose(mask, width, height, radius) {
  const n = width * height;
  const tmp = new Uint8Array(n);
  const out = new Uint8Array(n);

  const offsets = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) offsets.push([dx, dy]);
    }
  }

  // Dilate
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let val = 0;
      for (const [dx, dy] of offsets) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          if (mask[ny * width + nx]) { val = 1; break; }
        }
      }
      tmp[y * width + x] = val;
    }
  }

  // Erode
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let val = 1;
      for (const [dx, dy] of offsets) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          if (!tmp[ny * width + nx]) { val = 0; break; }
        } else {
          val = 0; break;
        }
      }
      out[y * width + x] = val;
    }
  }
  return out;
}

// ── 4. Morphological open (erode then dilate) ───────────────────────────────

function morphOpen(mask, width, height, radius) {
  const n = width * height;
  const tmp = new Uint8Array(n);
  const out = new Uint8Array(n);

  const offsets = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) offsets.push([dx, dy]);
    }
  }

  // Erode
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let val = 1;
      for (const [dx, dy] of offsets) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          if (!mask[ny * width + nx]) { val = 0; break; }
        } else {
          val = 0; break;
        }
      }
      tmp[y * width + x] = val;
    }
  }

  // Dilate
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let val = 0;
      for (const [dx, dy] of offsets) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          if (tmp[ny * width + nx]) { val = 1; break; }
        }
      }
      out[y * width + x] = val;
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

// ── 6. Component perimeter ───────��──────────────────────────────────────────

function componentPerimeter(labels, width, height, compId) {
  let peri = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (labels[y * width + x] !== compId) continue;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height ||
            labels[ny * width + nx] !== compId) {
          peri++;
          break;
        }
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

function fftCountAtRadius(gray, cx, cy, r, width, height) {
  const ring = sampleIntensityRing(gray, cx, cy, r, width, height, N_ANGLES);

  // Smooth (window ~ N/45)
  const halfWin = Math.max(2, Math.floor(N_ANGLES / 90));
  const sm = smoothSignal(ring, halfWin, true);

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

  const rel = totalScore > 0 ? bestScore / totalScore : 0;
  return { tc: bestF, rel };
}

// ── 9. FFT purity check for a candidate center/radius ───────────────────────

function fftPurityCheck(enhanced, cx, cy, r, width, height) {
  const lo = Math.floor(r * 0.85);
  const hi = Math.min(Math.floor(r * 1.10), Math.min(cx, width - cx, cy, height - cy) - 1);
  if (lo >= hi || lo < 10) return 0.0;

  const fftVotes = {};
  for (let rv = lo; rv <= hi; rv += 2) {
    const ring = sampleIntensityRing(enhanced, cx, cy, rv, width, height, N_ANGLES);
    const halfWin = 5;
    const sm = smoothSignal(ring, halfWin, true);

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

// ── 10. Multi-candidate center detection (multi-threshold contour sweep) ────
//
// Mirrors Python find_gear_region(): sweeps thresholds in both polarities,
// finds contour candidates, deduplicates by proximity, validates with FFT
// purity, and picks the best candidate.

function findGearCenter(gray, enhanced, edges, width, height) {
  const h = height, w = width;
  const n = w * h;

  const allCandidates = [];

  // Sweep thresholds 40–220 in steps of 10 (coarser than Python's 5 for speed)
  for (let thresh = 40; thresh < 220; thresh += 10) {
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

        const peri = componentPerimeter(labels, w, h, comp.id);
        const circ = peri > 0 ? (4 * Math.PI * comp.area) / (peri * peri) : 0;
        const compact = comp.area / (bw * bh);

        // Enclosing circle radius estimate
        const encR = Math.sqrt(comp.area / Math.PI);
        if (encR / Math.min(h, w) < 0.08 || encR / Math.min(h, w) > 0.45) continue;

        const score = circ * compact * Math.pow(comp.area, 0.3);
        const cx = Math.round(comp.sx / comp.area);
        const cy = Math.round(comp.sy / comp.area);
        const r = Math.round(encR);

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

  // FFT purity check on each candidate
  if (topCandidates.length > 0) {
    let bestPurity = -1;
    let bestIdx = 0;
    for (let i = 0; i < topCandidates.length; i++) {
      const c = topCandidates[i];
      const purity = fftPurityCheck(enhanced, c.cx, c.cy, c.r, w, h);
      if (purity > bestPurity) {
        bestPurity = purity;
        bestIdx = i;
      }
    }
    const winner = topCandidates[bestIdx];
    return { cx: winner.cx, cy: winner.cy, radius: winner.r, method: 'multi-threshold' };
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
    const peri = componentPerimeter(darkLabels, w, h, dc.id);
    const circ = peri > 0 ? (4 * Math.PI * dc.area) / (peri * peri) : 0;
    const hasHole = darkHasHole.has(dc.id);
    const score = circ * (hasHole ? 1.5 : 1.0);
    if (score > bestScore) {
      bestScore = score;
      bestComp = dc;
    }
  }

  if (bestComp) {
    return {
      cx: Math.round(bestComp.sx / bestComp.area),
      cy: Math.round(bestComp.sy / bestComp.area),
      radius: Math.round(Math.sqrt(bestComp.area / Math.PI)),
      method: 'otsu-contour',
    };
  }

  // Final fallback: center-weighted edge centroid
  const cx0 = w / 2, cy0 = h / 2;
  const sigX = w * 0.25, sigY = h * 0.25;
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
  return { cx: Math.round(wsx / wsum), cy: Math.round(wsy / wsum), radius: 0, method: 'edge-centroid' };
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

  const thresholdR = Math.floor(maxRUse * 0.85);
  const maxRScan = Math.min(
    Math.floor(maxRUse * 1.10),
    Math.min(cx, width - cx, cy, height - cy) - 1,
  );

  if (thresholdR >= maxRScan || thresholdR < 10) return 0;

  const fftVotes = {};
  for (let rv = thresholdR; rv <= maxRScan; rv += 2) {
    if (rv < 10) continue;

    const ring = sampleIntensityRing(enhanced, cx, cy, rv, width, height, N_ANGLES);
    const halfWin = 5;
    const sm = smoothSignal(ring, halfWin, true);

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

  if (Object.keys(fftVotes).length === 0) return 0;

  let bestFreq = 0, bestVal = 0;
  for (const [freq, val] of Object.entries(fftVotes)) {
    if (val > bestVal) { bestVal = val; bestFreq = Number(freq); }
  }
  return bestFreq;
}

// ── 13. Multi-radius FFT scan ───────────────────────────────────────────────
//
// Evaluates FFT at candidate radii built from edge-density peaks + outer band.
// Returns: { tc, rel, r } for the outermost candidate with rel >= MIN_REL,
// plus scanResults for small-gear refinement.

function multiRadiusFftScan(gray, edges, cx, cy, contourRadius, width, height) {
  const maxR = Math.min(
    Math.floor(Math.min(cx, width - cx, cy, height - cy)) - 1,
    contourRadius > 20 ? Math.floor(contourRadius * 1.20) : Math.floor(Math.min(height, width) / 3),
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
    const { tc, rel } = fftCountAtRadius(gray, cx, cy, rVal, width, height);
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
  for (let rScan = Math.floor(maxR * 0.95); rScan > 10; rScan -= 3) {
    for (let i = 0; i < nOp; i++) {
      if (outerRadii[i] > 0) continue;
      const px = Math.min(Math.max(Math.round(cx + rScan * cosA[i]), 0), width - 1);
      const py = Math.min(Math.max(Math.round(cy + rScan * sinA[i]), 0), height - 1);
      if (edges[py * width + px] > 0) {
        outerRadii[i] = rScan;
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

  // Smooth and FFT
  const halfWin = Math.max(2, Math.floor(nOp / 90));
  const sm = smoothSignal(outerRadii, halfWin, true);

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
    const sm = smoothSignal(ring, 5, true);

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

// ── Public entry point ──────���─────────────────────────────────────────────────

/**
 * Count the teeth on a gear from a photo.
 *
 * @param {string} photoUri  - file:// URI from VisionCamera takePhoto()
 * @returns {Promise<{toothCount: number, confidence: number,
 *                    gearCenter: {x: number, y: number},
 *                    gearRadius: number}>}
 */
export async function countTeeth(photoUri) {
  const t0 = Date.now();

  // ── Image loading ──────────────────────────────────────────────────
  const { width, height, rgba } = await loadAndDecodeImage(photoUri);
  const t1 = Date.now();

  // ── Preprocessing ──────────────────────────────────────────────────
  const gray     = rgbaToGray(rgba, width, height);
  const enhanced = clahe(gray, width, height, 3.0, 8, 8);
  const blurred  = gaussianBlur5x5(enhanced, width, height);
  const edges    = cannyEdges(blurred, width, height, 50, 150);
  const t2 = Date.now();

  // ── Center detection (multi-candidate + FFT purity) ────────────────
  const centerResult = findGearCenter(gray, enhanced, edges, width, height);
  const cx = centerResult.cx;
  const cy = centerResult.cy;
  const contourRadius = centerResult.radius || 0;

  // Use contour radius if available, otherwise fall back to edge-density
  const gearR = contourRadius > 20
    ? contourRadius
    : findGearRadius(edges, cx, cy, width, height);
  const t3 = Date.now();

  // ── Method 1: FFT at ≥85% of max contour radius (primary) ─────────
  const fft90tc = fftAtOuterRadii(enhanced, cx, cy, contourRadius, gearR, edges, width, height);

  // ── Method 2: Multi-radius FFT scan ────────────────────────────────
  const { peakTc, peakRel, peakR } = multiRadiusFftScan(gray, edges, cx, cy, gearR, width, height);

  // ── Method 3: Outer-profile scan ───────��───────────────────────────
  const maxR = Math.min(cx, width - cx, cy, height - cy) - 1;
  const { opTc, opRel } = outerProfileScan(edges, cx, cy, maxR, width, height);

  // ── Method 4: CLAHE peak counting ──────────────────────────────────
  const { claheTc, claheConf } = clahePeakCounting(enhanced, cx, cy, gearR, width, height);

  const t4 = Date.now();

  // ── Decision rule (mirrors Python) ─────────────────────────────────
  // Primary: FFT at outer radii (≥85% of max contour radius).
  // Fallback chain: multi-radius FFT → outer-profile → CLAHE peaks.
  let finalTc;
  if (fft90tc > 0) {
    finalTc = fft90tc;
  } else if (peakRel >= 0.15 && peakTc >= MIN_TEETH) {
    finalTc = peakTc;
  } else if (opTc > 0 && opRel >= 0.10) {
    finalTc = opTc;
  } else if (peakTc > 0) {
    finalTc = peakTc;
  } else if (claheTc > 0 && claheConf >= 0.5) {
    finalTc = claheTc;
  } else {
    finalTc = 0;
  }

  // Best available purity for confidence
  const finalRel = peakRel > 0 ? peakRel : (opRel > 0 ? opRel : 0);
  const confidence = Math.min(1.0, Math.max(0.0, (finalRel - 0.05) / 0.15));

  const finalR = peakR > 0 ? peakR : gearR;

  console.log(
    `[GearCounter] ${width}×${height}px | ` +
    `load=${t1-t0}ms preprocess=${t2-t1}ms detect=${t3-t2}ms methods=${t4-t3}ms total=${t4-t0}ms\n` +
    `  center=(${cx},${cy}) method=${centerResult.method}\n` +
    `  contourR=${contourRadius} gearR=${gearR}\n` +
    `  fft90=${fft90tc}T | multiR=${peakTc}T(rel=${peakRel.toFixed(3)}) | ` +
    `outer=${opTc}T(rel=${opRel.toFixed(3)}) | clahe=${claheTc}T(conf=${claheConf.toFixed(2)})\n` +
    `  → result=${finalTc}T conf=${(confidence * 100).toFixed(1)}%`
  );

  return {
    toothCount: finalTc,
    confidence,
    gearCenter: { x: cx / width, y: cy / height },
    gearRadius: finalR / width,
  };
}
