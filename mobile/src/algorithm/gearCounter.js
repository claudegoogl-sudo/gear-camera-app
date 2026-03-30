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

import * as FileSystem from 'expo-file-system';
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
  // Resize to max 1000px wide — keeps processing time predictable.
  const resized = await ImageManipulator.manipulateAsync(
    photoUri,
    [{ resize: { width: 1000 } }],
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

// ── 5. Gear centre (centroid of edge pixels) ──────────────────────────────────

function findGearCenter(edges, width, height) {
  let sx = 0, sy = 0, count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (edges[y * width + x] > 0) {
        sx += x; sy += y; count++;
      }
    }
  }
  if (count === 0) return { cx: Math.floor(width / 2), cy: Math.floor(height / 2) };
  return { cx: Math.round(sx / count), cy: Math.round(sy / count) };
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
  }

  // Find best in valid range
  let best = MIN_TEETH;
  for (let f = MIN_TEETH + 1; f <= MAX_TEETH; f++) {
    if (scores[f] > scores[best]) best = f;
  }

  // Confidence: ratio of best to second-best, normalised to [0,1]
  let secondBest = 0;
  for (let f = MIN_TEETH; f <= MAX_TEETH; f++) {
    if (f !== best && scores[f] > secondBest) secondBest = scores[f];
  }
  const ratio      = secondBest > 0 ? scores[best] / secondBest : 10;
  const confidence = Math.min(1.0, (ratio - 1.0) / 9.0);

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
  const { width, height, rgba } = await loadAndDecodeImage(photoUri);
  const gray  = toGrayscale(rgba, width, height);
  const blur  = gaussianBlur(gray, width, height);
  const edges = sobelEdges(blur, width, height);

  const { cx, cy } = findGearCenter(edges, width, height);
  const r           = findGearRadius(edges, cx, cy, width, height);

  const ring        = sampleIntensityRing(gray, cx, cy, r, width, height, N_ANGLES);
  const dft         = computeDFT(ring);
  const { toothCount, confidence } = pickToothCount(dft);

  return {
    toothCount,
    confidence,
    gearCenter: { x: cx / width, y: cy / height },   // normalised 0-1 for overlay
    gearRadius: r / width,                            // normalised relative to width
  };
}
