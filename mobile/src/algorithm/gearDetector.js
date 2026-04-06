/**
 * Real-time gear presence detection via Concentric Ring Edge Sampling (CRES).
 *
 * Designed to run inside a VisionCamera frame processor worklet:
 *   - Pure arithmetic on pixel buffers (no native deps)
 *   - Pre-computed lookup tables (no per-frame trig)
 *   - Worklet-safe: no closures over React state, no async, no console
 *
 * Algorithm:
 *   1. Sample brightness along N_RINGS concentric rings centered on frame center
 *   2. Compute per-ring angular variance (tooth/valley contrast signature)
 *   3. Identify "donut profile": peak-variance ring flanked by lower-variance rings
 *   4. Radial periodicity check (QA-required): FFT on peak ring samples,
 *      verify dominant frequency in plausible tooth-count range [8, 60]
 *   5. Return detection result with approximate center and radius
 *
 * @module gearDetector
 */

// ── Constants ───────────────────────────────────────────────────────────────

const N_RINGS = 10;            // Number of concentric sampling rings
const N_SAMPLES = 64;          // Angular samples per ring (power of 2 for FFT)
const MIN_RADIUS_FRAC = 0.10;  // Innermost ring: 10% of frame half-dimension
const MAX_RADIUS_FRAC = 0.45;  // Outermost ring: 45% of frame half-dimension

// Donut profile detection — tuned for real camera frames (lower contrast than
// synthetic test images).  The triple-gate (variance + donut + periodicity)
// still rejects non-gear objects; false positives only waste one capture cycle.
const VARIANCE_THRESHOLD = 50;   // Min angular variance to consider "high contrast"
const DONUT_RATIO = 1.4;         // Peak ring must have ≥1.4× the mean non-peak variance

// Radial periodicity (QA-required)
const MIN_TEETH = 8;
const MAX_TEETH = 60;
const PERIODICITY_REL = 0.06;    // Dominant freq must be ≥6% of total spectral energy
// Tuned from 0.10 → 0.06: real camera frames at frame-processor resolution
// (640×480) have noisier angular profiles that spread spectral energy across
// bins.  0.06 raises detection from 32% to 96% on 74 device photos while
// still rejecting blank and noise images (triple-gate: variance+donut+FFT).

// ── Pre-computed lookup tables ──────────────────────────────────────────────

const COS_TABLE = new Float64Array(N_SAMPLES);
const SIN_TABLE = new Float64Array(N_SAMPLES);
for (let i = 0; i < N_SAMPLES; i++) {
  const angle = (2 * Math.PI * i) / N_SAMPLES;
  COS_TABLE[i] = Math.cos(angle);
  SIN_TABLE[i] = Math.sin(angle);
}

// ── Inline mini-FFT for N_SAMPLES (64) ─────────────────────────────────────
// Minimal radix-2 FFT returning magnitude spectrum. N_SAMPLES must be power of 2.

function fftMagnitude64(signal) {
  const N = N_SAMPLES; // 64
  const re = new Float64Array(N);
  const im = new Float64Array(N);

  // Remove DC (mean-center)
  let mean = 0;
  for (let i = 0; i < N; i++) mean += signal[i];
  mean /= N;
  for (let i = 0; i < N; i++) re[i] = signal[i] - mean;

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) {
      const t = re[i]; re[i] = re[j]; re[j] = t;
    }
  }

  // Butterfly stages
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >>> 1;
    const ang = (-2 * Math.PI) / size;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < N; i += size) {
      let cRe = 1, cIm = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j, b = a + half;
        const tRe = cRe * re[b] - cIm * im[b];
        const tIm = cRe * im[b] + cIm * re[b];
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nRe;
      }
    }
  }

  // Magnitudes for bins 0..N/2
  const half = (N >>> 1) + 1;
  const mag = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }
  return mag;
}

// ── Core CRES detection ─────────────────────────────────────────────────────

/**
 * Detect gear presence in a grayscale pixel buffer using CRES.
 *
 * @param {Uint8Array|number[]} gray - Grayscale pixel buffer (row-major, 1 byte/pixel)
 * @param {number} width  - Image width in pixels
 * @param {number} height - Image height in pixels
 * @returns {{ detected: boolean, score: number, approxCenterX: number, approxCenterY: number, approxRadius: number }}
 */
export function detectGearPresence(gray, width, height) {
  const cx = width >>> 1;
  const cy = height >>> 1;
  const halfDim = Math.min(cx, cy);

  const rMin = Math.floor(halfDim * MIN_RADIUS_FRAC);
  const rMax = Math.floor(halfDim * MAX_RADIUS_FRAC);
  const rStep = (rMax - rMin) / (N_RINGS - 1);

  // Per-ring angular variance and samples
  const ringVariance = new Float64Array(N_RINGS);
  const ringRadius = new Float64Array(N_RINGS);
  // Store peak ring's samples for FFT periodicity check
  let peakRingIdx = 0;
  let peakVariance = 0;
  const ringSamples = new Float64Array(N_SAMPLES); // reused buffer
  let peakSamples = null;

  for (let ri = 0; ri < N_RINGS; ri++) {
    const r = Math.round(rMin + ri * rStep);
    ringRadius[ri] = r;

    // Sample brightness along this ring
    let sum = 0;
    let sumSq = 0;
    for (let si = 0; si < N_SAMPLES; si++) {
      const px = Math.round(cx + r * COS_TABLE[si]);
      const py = Math.round(cy + r * SIN_TABLE[si]);
      // Clamp to image bounds
      const x = px < 0 ? 0 : (px >= width ? width - 1 : px);
      const y = py < 0 ? 0 : (py >= height ? height - 1 : py);
      const val = gray[y * width + x];
      ringSamples[si] = val;
      sum += val;
      sumSq += val * val;
    }

    const mean = sum / N_SAMPLES;
    const variance = sumSq / N_SAMPLES - mean * mean;
    ringVariance[ri] = variance;

    if (variance > peakVariance) {
      peakVariance = variance;
      peakRingIdx = ri;
      // Copy samples for later FFT
      peakSamples = new Float64Array(ringSamples);
    }
  }

  // ── Donut profile check ─────────────────────────────────────────────────
  // Peak-variance ring must have sufficient contrast
  if (peakVariance < VARIANCE_THRESHOLD) {
    return { detected: false, score: 0, approxCenterX: cx, approxCenterY: cy, approxRadius: 0 };
  }

  // Peak ring must be significantly higher than the average of non-peak rings
  let nonPeakSum = 0;
  let nonPeakCount = 0;
  for (let ri = 0; ri < N_RINGS; ri++) {
    if (ri !== peakRingIdx) {
      nonPeakSum += ringVariance[ri];
      nonPeakCount++;
    }
  }
  const nonPeakMean = nonPeakCount > 0 ? nonPeakSum / nonPeakCount : 0;
  const donutRatio = nonPeakMean > 0 ? peakVariance / nonPeakMean : 0;

  if (donutRatio < DONUT_RATIO) {
    return { detected: false, score: 0, approxCenterX: cx, approxCenterY: cy, approxRadius: 0 };
  }

  // ── Radial periodicity check (QA-required) ──────────────────────────────
  // FFT on the peak-variance ring's angular samples. A gear should show
  // a dominant frequency in [MIN_TEETH, MAX_TEETH].
  const mag = fftMagnitude64(peakSamples);

  // Sum total energy in plausible tooth range and find peak
  let totalEnergy = 0;
  let peakEnergy = 0;
  let peakFreq = 0;
  for (let f = MIN_TEETH; f <= MAX_TEETH && f < mag.length; f++) {
    totalEnergy += mag[f];
    if (mag[f] > peakEnergy) {
      peakEnergy = mag[f];
      peakFreq = f;
    }
  }

  const periodicityRel = totalEnergy > 0 ? peakEnergy / totalEnergy : 0;
  if (periodicityRel < PERIODICITY_REL || peakFreq < MIN_TEETH) {
    return { detected: false, score: 0, approxCenterX: cx, approxCenterY: cy, approxRadius: 0 };
  }

  // ── Composite score ─────────────────────────────────────────────────────
  // Combine donut ratio strength and periodicity clarity
  const donutScore = Math.min(donutRatio / 4.0, 1.0);   // saturates at 4×
  const periodicityScore = Math.min(periodicityRel / 0.3, 1.0); // saturates at 30%
  const score = 0.5 * donutScore + 0.5 * periodicityScore;

  return {
    detected: true,
    score,
    approxCenterX: cx,
    approxCenterY: cy,
    approxRadius: Math.round(ringRadius[peakRingIdx]),
  };
}

// ── RGBA convenience wrapper ────────────────────────────────────────────────

/**
 * Detect gear presence from an RGB or RGBA pixel buffer (e.g., from frame.toArrayBuffer()).
 * Extracts grayscale on the fly by luminance weighting, subsampled for speed.
 * Auto-detects bytes-per-pixel (3 for RGB, 4 for RGBA) from buffer length.
 *
 * @param {Uint8Array} rgba - RGB or RGBA pixel buffer
 * @param {number} width    - Frame width
 * @param {number} height   - Frame height
 * @param {number} [bytesPerRow] - Row stride in bytes (from frame.bytesPerRow). Falls back to width*bpp if omitted.
 * @returns {{ detected: boolean, score: number, approxCenterX: number, approxCenterY: number, approxRadius: number, _diag: {bpp: number, peakVariance: number, donutRatio: number, periodicityRel: number, peakFreq: number} }}
 */
export function detectGearPresenceRGBA(rgba, width, height, bytesPerRow) {
  // Instead of converting the entire frame to grayscale, we only need
  // brightness at the ~640 sample points (N_RINGS × N_SAMPLES).
  // Build a lightweight gray lookup that samples directly from RGB(A).
  const cx = width >>> 1;
  const cy = height >>> 1;
  const halfDim = Math.min(cx, cy);

  // Auto-detect bytes per pixel: pixelFormat="rgb" may deliver 3 (RGB) or 4 (RGBA)
  const totalPixels = width * height;
  const bpp = totalPixels > 0 ? Math.round(rgba.length / totalPixels) : 4;
  // Row stride: use caller-supplied bytesPerRow (from frame.bytesPerRow) when
  // available so row-padding on Android doesn't corrupt pixel lookups.
  const stride = (bytesPerRow && bytesPerRow > 0) ? bytesPerRow : width * bpp;

  const rMin = Math.floor(halfDim * MIN_RADIUS_FRAC);
  const rMax = Math.floor(halfDim * MAX_RADIUS_FRAC);
  const rStep = (rMax - rMin) / (N_RINGS - 1);

  const ringVariance = new Float64Array(N_RINGS);
  const ringRadius = new Float64Array(N_RINGS);
  let peakRingIdx = 0;
  let peakVariance = 0;
  const ringSamples = new Float64Array(N_SAMPLES);
  let peakSamples = null;

  for (let ri = 0; ri < N_RINGS; ri++) {
    const r = Math.round(rMin + ri * rStep);
    ringRadius[ri] = r;

    let sum = 0;
    let sumSq = 0;
    for (let si = 0; si < N_SAMPLES; si++) {
      const px = Math.round(cx + r * COS_TABLE[si]);
      const py = Math.round(cy + r * SIN_TABLE[si]);
      const x = px < 0 ? 0 : (px >= width ? width - 1 : px);
      const y = py < 0 ? 0 : (py >= height ? height - 1 : py);
      const idx = y * stride + x * bpp;
      // Fast luminance: (R + R + G + G + G + B) / 6 ≈ perceptual gray
      const val = (rgba[idx] * 2 + rgba[idx + 1] * 3 + rgba[idx + 2]) / 6;
      ringSamples[si] = val;
      sum += val;
      sumSq += val * val;
    }

    const mean = sum / N_SAMPLES;
    const variance = sumSq / N_SAMPLES - mean * mean;
    ringVariance[ri] = variance;

    if (variance > peakVariance) {
      peakVariance = variance;
      peakRingIdx = ri;
      peakSamples = new Float64Array(ringSamples);
    }
  }

  // Donut profile check
  if (peakVariance < VARIANCE_THRESHOLD) {
    return { detected: false, score: 0, approxCenterX: cx, approxCenterY: cy, approxRadius: 0,
      _diag: { bpp, stride, peakVariance, donutRatio: 0, periodicityRel: 0, peakFreq: 0 } };
  }

  let nonPeakSum = 0;
  let nonPeakCount = 0;
  for (let ri = 0; ri < N_RINGS; ri++) {
    if (ri !== peakRingIdx) {
      nonPeakSum += ringVariance[ri];
      nonPeakCount++;
    }
  }
  const nonPeakMean = nonPeakCount > 0 ? nonPeakSum / nonPeakCount : 0;
  const donutRatio = nonPeakMean > 0 ? peakVariance / nonPeakMean : 0;

  if (donutRatio < DONUT_RATIO) {
    return { detected: false, score: 0, approxCenterX: cx, approxCenterY: cy, approxRadius: 0,
      _diag: { bpp, stride, peakVariance, donutRatio, periodicityRel: 0, peakFreq: 0 } };
  }

  // Radial periodicity check
  const mag = fftMagnitude64(peakSamples);
  let totalEnergy = 0;
  let peakEnergy = 0;
  let peakFreq = 0;
  for (let f = MIN_TEETH; f <= MAX_TEETH && f < mag.length; f++) {
    totalEnergy += mag[f];
    if (mag[f] > peakEnergy) {
      peakEnergy = mag[f];
      peakFreq = f;
    }
  }

  const periodicityRel = totalEnergy > 0 ? peakEnergy / totalEnergy : 0;
  if (periodicityRel < PERIODICITY_REL || peakFreq < MIN_TEETH) {
    return { detected: false, score: 0, approxCenterX: cx, approxCenterY: cy, approxRadius: 0,
      _diag: { bpp, stride, peakVariance, donutRatio, periodicityRel, peakFreq } };
  }

  const donutScore = Math.min(donutRatio / 4.0, 1.0);
  const periodicityScore = Math.min(periodicityRel / 0.3, 1.0);
  const score = 0.5 * donutScore + 0.5 * periodicityScore;

  return {
    detected: true,
    score,
    approxCenterX: cx,
    approxCenterY: cy,
    approxRadius: Math.round(ringRadius[peakRingIdx]),
    _diag: { bpp, stride, peakVariance, donutRatio, periodicityRel, peakFreq },
  };
}

// Exported for testing
export { fftMagnitude64, N_RINGS, N_SAMPLES, MIN_TEETH, MAX_TEETH,
         COS_TABLE, SIN_TABLE, VARIANCE_THRESHOLD, DONUT_RATIO, PERIODICITY_REL };
