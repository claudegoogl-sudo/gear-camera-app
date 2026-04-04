/**
 * Gear Tooth Counter — JavaScript port of algorithm/gear_tooth_counter.py
 *
 * Pipeline (mirrors the Python implementation exactly):
 *   1. Decode JPEG → RGBA pixel buffer
 *   2. Convert to grayscale
 *   3. 5×5 Gaussian blur
 *   4. Sobel edge detection → binary edge map
 *   5. Find gear centre (edge-pixel centroid)
 *   6. Radial edge-density scan → outer gear radius (90% cap avoids frame edges)
 *   7. Sample grayscale intensity at the tooth-tip circle (360 angles)
 *   8. DFT of intensity ring → harmonic-weighted score → tooth count
 *
 * Entry point:
 *   import { countTeeth } from './gearCounter';
 *   const { toothCount, confidence, gearCenter, gearRadius } = await countTeeth(photoUri);
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { decode as jpegDecode } from 'jpeg-js';

// ── Tuning constants (match Python defaults) ────────────────────────────────
const GAUSS_SIGMA      = 1.5;
const EDGE_PERCENTILE  = 0.85;   // keep top 15% of Sobel magnitudes as edges
const DENSITY_PEAK_CAP = 0.90;   // ignore density peaks in outer 10% (frame edges)
const N_ANGLES         = 360;
const MIN_TEETH        = 10;
const MAX_TEETH        = 65;
// ────────────────────────────────────────────────────────────────────────────

// ── 1. Image loading ─────────────────────────────────────────────────────────

async function loadAndDecodeImage(photoUri) {
  // Resize so the longest edge is at most 1000 px — keeps processing time
  // predictable on both landscape and portrait photos.
  const info    = await ImageManipulator.manipulateAsync(photoUri, [], {});
  const maxDim  = Math.max(info.width, info.height);
  const resizeOp = maxDim > 1000
    ? [{ resize: info.width >= info.height ? { width: Math.round(1000 * info.width / maxDim) } : { height: Math.round(1000 * info.height / maxDim) } }]
    : [];
  const resized = await ImageManipulator.manipulateAsync(
    photoUri,
    resizeOp,
    { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG },
  );

  const base64 = await FileSystem.readAsStringAsync(resized.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // base64 → Uint8Array
  const binary = atob(base64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);

  const { width, height, data } = jpegDecode(buf, { useTArray: true });
  return { width, height, rgba: data }; // data: RGBA Uint8Array, row-major
}

// ── 2. Grayscale ─────────────────────────────────────────────────────────────

function toGrayscale(rgba, width, height) {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return gray;
}

// ── 3. Gaussian blur (5×5 approximate kernel, σ≈1.5) ─────────────────────────

const GAUSS_KERNEL_5 = [
  2, 4, 5, 4, 2,
  4, 9,12, 9, 4,
  5,12,15,12, 5,
  4, 9,12, 9, 4,
  2, 4, 5, 4, 2,
];
const GAUSS_SUM = GAUSS_KERNEL_5.reduce((a, b) => a + b, 0); // 159

function gaussianBlur(gray, width, height) {
  const out = new Float32Array(width * height);
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      let acc = 0;
      for (let ky = -2; ky <= 2; ky++) {
        for (let kx = -2; kx <= 2; kx++) {
          acc += gray[(y + ky) * width + (x + kx)] * GAUSS_KERNEL_5[(ky + 2) * 5 + (kx + 2)];
        }
      }
      out[y * width + x] = acc / GAUSS_SUM;
    }
  }
  return out;
}

// ── 4. Sobel edge detection → binary edge map ─────────────────────────────────

function sobelEdges(gray, width, height) {
  const mag = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const tl = gray[(y-1)*width+(x-1)], tc = gray[(y-1)*width+x], tr = gray[(y-1)*width+(x+1)];
      const ml = gray[y    *width+(x-1)],                            mr = gray[y    *width+(x+1)];
      const bl = gray[(y+1)*width+(x-1)], bc = gray[(y+1)*width+x], br = gray[(y+1)*width+(x+1)];
      const gx = -tl - 2*ml - bl + tr + 2*mr + br;
      const gy = -tl - 2*tc - tr + bl + 2*bc + br;
      mag[y * width + x] = Math.sqrt(gx*gx + gy*gy);
    }
  }

  // Threshold at EDGE_PERCENTILE of non-zero values
  const vals = Array.from(mag).filter(v => v > 0).sort((a, b) => a - b);
  const threshold = vals[Math.floor(vals.length * EDGE_PERCENTILE)] ?? 1;

  const edges = new Uint8Array(width * height);
  for (let i = 0; i < mag.length; i++) {
    edges[i] = mag[i] >= threshold ? 255 : 0;
  }
  return edges;
}

// ── 5. Gear centre (center-weighted centroid of edge pixels) ─────────────────
//
// Weights edge pixels by a Gaussian centered on the image so that edges
// near the frame borders (paper-towel hearts, table clutter, etc.) have
// much less influence on the detected centre than edges near the middle
// of the photo where the gear is expected.

function findGearCenter(edges, width, height) {
  const cx0 = width  / 2;
  const cy0 = height / 2;
  const sigX = width  * 0.25;
  const sigY = height * 0.25;

  let wsx = 0, wsy = 0, wsum = 0;
  for (let y = 0; y < height; y++) {
    const dy = (y - cy0) / sigY;
    const wy = Math.exp(-dy * dy);           // pre-compute row weight
    for (let x = 0; x < width; x++) {
      if (edges[y * width + x] > 0) {
        const dx = (x - cx0) / sigX;
        const w  = wy * Math.exp(-dx * dx);  // 2-D Gaussian weight
        wsx  += x * w;
        wsy  += y * w;
        wsum += w;
      }
    }
  }
  if (wsum === 0) return { cx: Math.floor(cx0), cy: Math.floor(cy0) };
  return { cx: Math.round(wsx / wsum), cy: Math.round(wsy / wsum) };
}

// ── 6. Radial edge-density → outer gear radius ────────────────────────────────

function smoothArray(arr, halfWin) {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let sum = 0, cnt = 0;
    for (let d = -halfWin; d <= halfWin; d++) {
      const j = i + d;
      if (j >= 0 && j < arr.length) { sum += arr[j]; cnt++; }
    }
    out[i] = sum / cnt;
  }
  return out;
}

function findGearRadius(edges, cx, cy, width, height) {
  const maxR = Math.floor(Math.min(cx, width - cx, cy, height - cy)) - 1;
  const density = new Float32Array(maxR);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (edges[y * width + x] > 0) {
        const d = Math.round(Math.sqrt((x - cx) ** 2 + (y - cy) ** 2));
        if (d < maxR) density[d]++;
      }
    }
  }

  const halfWin = Math.max(2, Math.floor(maxR / 16));
  const smooth  = smoothArray(density, halfWin);
  const cap     = Math.floor(maxR * DENSITY_PEAK_CAP);

  // Find peaks (local maxima above 12% of max within cap)
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

// ── 7. Sample grayscale intensity around the tooth-tip circle ─────────────────

function sampleIntensityRing(gray, cx, cy, r, width, height, nAngles) {
  const samples = new Float32Array(nAngles);
  for (let i = 0; i < nAngles; i++) {
    const angle = (2 * Math.PI * i) / nAngles;
    const px = Math.round(cx + r * Math.cos(angle));
    const py = Math.round(cy + r * Math.sin(angle));
    if (px >= 0 && px < width && py >= 0 && py < height) {
      samples[i] = gray[py * width + px];
    } else {
      samples[i] = 128;
    }
  }
  return samples;
}

// ── 8. DFT (O(N²) — fine for N=360) ──────────────────────────────────────────

function computeDFT(signal) {
  const N   = signal.length;
  const out = new Float32Array(Math.floor(N / 2) + 1);
  const mean = signal.reduce((a, b) => a + b, 0) / N;

  for (let k = 0; k <= Math.floor(N / 2); k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const angle = (2 * Math.PI * k * n) / N;
      re += (signal[n] - mean) * Math.cos(angle);
      im -= (signal[n] - mean) * Math.sin(angle);
    }
    out[k] = Math.sqrt(re * re + im * im);
  }
  return out;
}

// ── 9. Harmonic-weighted scoring → tooth count ───────────────────────────────

function pickToothCount(dft) {
  const scores = new Float32Array(MAX_TEETH + 1);

  for (let f = MIN_TEETH; f <= MAX_TEETH; f++) {
    if (f >= dft.length) break;
    scores[f] = dft[f];
    if (2 * f < dft.length) scores[f] += 0.5 * dft[2 * f];
    if (3 * f < dft.length) scores[f] += 0.25 * dft[3 * f];
  }

  // Find best in valid range
  let best = MIN_TEETH;
  for (let f = MIN_TEETH + 1; f <= MAX_TEETH; f++) {
    if (scores[f] > scores[best]) best = f;
  }

  // Confidence: relative spectral purity mapped to [0,1].
  // rel=0.05 → 0%,  rel=0.20 → 100%  (matches Python algorithm).
  let total = 0;
  for (let f = MIN_TEETH; f <= MAX_TEETH; f++) total += scores[f];
  const rel        = total > 0 ? scores[best] / total : 0;
  const confidence = Math.min(1.0, Math.max(0.0, (rel - 0.05) / 0.15));

  return { toothCount: best, confidence };
}

// ── Public entry point ────────────────────────────────────────────────────────

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

  const { width, height, rgba } = await loadAndDecodeImage(photoUri);
  const t1 = Date.now();

  const gray  = toGrayscale(rgba, width, height);
  const blur  = gaussianBlur(gray, width, height);
  const edges = sobelEdges(blur, width, height);
  const t2 = Date.now();

  const { cx, cy } = findGearCenter(edges, width, height);
  const r           = findGearRadius(edges, cx, cy, width, height);
  const t3 = Date.now();

  // ── Multi-radius FFT scan ──────────────────────────────────────────
  // Instead of a single radius, scan multiple radii from 0.60× to 1.10×
  // of the detected gear radius and keep the result with the highest
  // spectral purity (confidence).  This avoids locking on to an inner
  // hub ring or a radius where background texture dominates.
  let bestToothCount = 0;
  let bestConfidence = 0;
  let bestR          = r;

  const maxSafe = Math.min(cx, width - cx, cy, height - cy) - 1;

  for (let pct = 60; pct <= 110; pct += 5) {
    const rTest = Math.round(r * pct / 100);
    if (rTest < 20 || rTest >= maxSafe) continue;

    const ring = sampleIntensityRing(gray, cx, cy, rTest, width, height, N_ANGLES);
    const dft  = computeDFT(ring);
    const { toothCount: tc, confidence: conf } = pickToothCount(dft);

    if (conf > bestConfidence) {
      bestConfidence = conf;
      bestToothCount = tc;
      bestR          = rTest;
    }
  }

  const t4 = Date.now();

  console.log(
    `[GearCounter] ${width}×${height}px | ` +
    `load=${t1-t0}ms blur+edges=${t2-t1}ms radius=${t3-t2}ms fft=${t4-t3}ms total=${t4-t0}ms | ` +
    `center=(${cx},${cy}) baseR=${r} bestR=${bestR} teeth=${bestToothCount} conf=${bestConfidence.toFixed(3)}`
  );

  return {
    toothCount: bestToothCount,
    confidence: bestConfidence,
    gearCenter: { x: cx / width, y: cy / height },
    gearRadius: bestR / width,
  };
}
