/**
 * Pure-JS image processing primitives used by the gear tooth counter.
 * Operates on flat Uint8Array grayscale buffers (one byte per pixel).
 */

/**
 * Convert an RGBA pixel buffer to single-channel grayscale.
 * @param {Uint8Array} rgba - RGBA pixel data (length = w*h*4)
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array} grayscale buffer (length = w*h)
 */
export function rgbaToGray(rgba, width, height) {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const j = i * 4;
    // ITU-R BT.601 luminance weights
    gray[i] = Math.round(0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]);
  }
  return gray;
}

/**
 * 5×5 Gaussian blur (σ ≈ 1.4) applied to a grayscale buffer.
 * Separable implementation (horizontal then vertical) for speed.
 */
export function gaussianBlur5x5(gray, width, height) {
  // 1-D kernel for σ≈1.4:  [1, 4, 6, 4, 1] / 16
  const kernel = [1, 4, 6, 4, 1];
  const kSum = 16;

  const tmp = new Uint8Array(width * height);
  const out = new Uint8Array(width * height);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -2; k <= 2; k++) {
        const sx = Math.min(Math.max(x + k, 0), width - 1);
        sum += gray[y * width + sx] * kernel[k + 2];
      }
      tmp[y * width + x] = (sum / kSum) | 0;
    }
  }

  // Vertical pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -2; k <= 2; k++) {
        const sy = Math.min(Math.max(y + k, 0), height - 1);
        sum += tmp[sy * width + x] * kernel[k + 2];
      }
      out[y * width + x] = (sum / kSum) | 0;
    }
  }

  return out;
}

/**
 * Canny edge detection (simplified).
 *
 * 1. Sobel gradient (3×3)
 * 2. Non-maximum suppression
 * 3. Double-threshold hysteresis
 *
 * @param {Uint8Array} gray - blurred grayscale buffer
 * @param {number} width
 * @param {number} height
 * @param {number} [low=50]  - lower hysteresis threshold
 * @param {number} [high=150] - upper hysteresis threshold
 * @returns {Uint8Array} edge map (0 or 255)
 */
export function cannyEdges(gray, width, height, low = 50, high = 150) {
  const len = width * height;
  const mag = new Float32Array(len);
  const dir = new Uint8Array(len); // quantised to 0,1,2,3 (0°,45°,90°,135°)

  // ── Sobel gradient ────────────────────────────────────────────────────
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -gray[i - width - 1] + gray[i - width + 1] +
        -2 * gray[i - 1] + 2 * gray[i + 1] +
        -gray[i + width - 1] + gray[i + width + 1];
      const gy =
        -gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1] +
         gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1];

      mag[i] = Math.sqrt(gx * gx + gy * gy);

      // Quantise angle to 4 directions
      let angle = Math.atan2(gy, gx) * (180 / Math.PI);
      if (angle < 0) angle += 180;
      if (angle < 22.5 || angle >= 157.5) dir[i] = 0;       // horizontal
      else if (angle < 67.5) dir[i] = 1;                     // 45°
      else if (angle < 112.5) dir[i] = 2;                    // vertical
      else dir[i] = 3;                                        // 135°
    }
  }

  // ── Non-maximum suppression ───────────────────────────────────────────
  const nms = new Float32Array(len);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      let p1, p2;
      switch (dir[i]) {
        case 0: p1 = mag[i - 1]; p2 = mag[i + 1]; break;
        case 1: p1 = mag[i - width + 1]; p2 = mag[i + width - 1]; break;
        case 2: p1 = mag[i - width]; p2 = mag[i + width]; break;
        default: p1 = mag[i - width - 1]; p2 = mag[i + width + 1]; break;
      }
      nms[i] = (mag[i] >= p1 && mag[i] >= p2) ? mag[i] : 0;
    }
  }

  // ── Double-threshold hysteresis ───────────────────────────────────────
  const edges = new Uint8Array(len); // 0 = none, 128 = weak, 255 = strong
  for (let i = 0; i < len; i++) {
    if (nms[i] >= high) edges[i] = 255;
    else if (nms[i] >= low) edges[i] = 128;
  }

  // Connect weak edges adjacent to strong edges
  // PAP-309: cap iterations to prevent pathological cases on complex images
  // (gear teeth + background texture can create long chains of weak edges
  // that require 50-100+ passes, dominating runtime on mobile).
  let changed = true;
  let hysteresisIter = 0;
  const MAX_HYSTERESIS_ITER = 20;
  while (changed && hysteresisIter < MAX_HYSTERESIS_ITER) {
    changed = false;
    hysteresisIter++;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        if (edges[i] !== 128) continue;
        // Check 8-connected neighbours for a strong pixel
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (edges[(y + dy) * width + (x + dx)] === 255) {
              edges[i] = 255;
              changed = true;
            }
          }
        }
      }
    }
  }

  // Suppress remaining weak edges
  for (let i = 0; i < len; i++) {
    if (edges[i] !== 255) edges[i] = 0;
  }

  return edges;
}

// ── CLAHE (Contrast Limited Adaptive Histogram Equalization) ────────────────

/**
 * Apply CLAHE to a grayscale buffer.
 * Divides the image into tiles, computes clipped histograms per tile,
 * then bilinearly interpolates the mappings for each pixel.
 *
 * @param {Uint8Array} gray - grayscale buffer
 * @param {number} width
 * @param {number} height
 * @param {number} [clipLimit=3.0]
 * @param {number} [tilesX=8]
 * @param {number} [tilesY=8]
 * @returns {Uint8Array} enhanced grayscale buffer
 */
export function clahe(gray, width, height, clipLimit = 3.0, tilesX = 8, tilesY = 8) {
  const tileW = Math.floor(width / tilesX);
  const tileH = Math.floor(height / tilesY);
  if (tileW < 2 || tileH < 2) return new Uint8Array(gray); // too small

  const nPixels = tileW * tileH;
  const clipCount = Math.max(1, Math.floor(clipLimit * nPixels / 256));

  // Compute CDF lookup for each tile
  const maps = []; // [tilesY][tilesX] -> Uint8Array(256)
  for (let ty = 0; ty < tilesY; ty++) {
    const row = [];
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * tileW;
      const y0 = ty * tileH;

      // Build histogram
      const hist = new Int32Array(256);
      for (let dy = 0; dy < tileH; dy++) {
        for (let dx = 0; dx < tileW; dx++) {
          hist[gray[(y0 + dy) * width + (x0 + dx)]]++;
        }
      }

      // Clip histogram and redistribute
      let excess = 0;
      for (let i = 0; i < 256; i++) {
        if (hist[i] > clipCount) {
          excess += hist[i] - clipCount;
          hist[i] = clipCount;
        }
      }
      const perBin = Math.floor(excess / 256);
      let leftover = excess - perBin * 256;
      for (let i = 0; i < 256; i++) {
        hist[i] += perBin;
        if (leftover > 0) { hist[i]++; leftover--; }
      }

      // Build CDF → mapping
      const mapping = new Uint8Array(256);
      let cdf = 0;
      for (let i = 0; i < 256; i++) {
        cdf += hist[i];
        mapping[i] = Math.min(255, Math.round((cdf * 255) / nPixels));
      }
      row.push(mapping);
    }
    maps.push(row);
  }

  // Bilinear interpolation of tile mappings
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    // Tile coordinate (float)
    const tyf = Math.min(Math.max((y - tileH / 2) / tileH, 0), tilesY - 1 - 1e-6);
    const ty0 = Math.floor(tyf);
    const ty1 = Math.min(ty0 + 1, tilesY - 1);
    const fy = tyf - ty0;

    for (let x = 0; x < width; x++) {
      const txf = Math.min(Math.max((x - tileW / 2) / tileW, 0), tilesX - 1 - 1e-6);
      const tx0 = Math.floor(txf);
      const tx1 = Math.min(tx0 + 1, tilesX - 1);
      const fx = txf - tx0;

      const v = gray[y * width + x];
      const tl = maps[ty0][tx0][v];
      const tr = maps[ty0][tx1][v];
      const bl = maps[ty1][tx0][v];
      const br = maps[ty1][tx1][v];

      out[y * width + x] = Math.round(
        tl * (1 - fx) * (1 - fy) +
        tr * fx * (1 - fy) +
        bl * (1 - fx) * fy +
        br * fx * fy
      );
    }
  }
  return out;
}

// ── Smoothing filters ───────────────────────────────────────────────────────

/**
 * Simple moving-average (box filter) smooth for a 1-D signal.
 * Uses a window of (2*halfWin+1) samples, wrapping at boundaries.
 *
 * @param {Float32Array|Float64Array|number[]} signal
 * @param {number} halfWin
 * @param {boolean} [wrap=false] - if true, treat signal as circular
 * @returns {Float64Array}
 */
export function smoothSignal(signal, halfWin, wrap = false) {
  const N = signal.length;
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0, cnt = 0;
    for (let d = -halfWin; d <= halfWin; d++) {
      let j = i + d;
      if (wrap) {
        j = ((j % N) + N) % N;
      } else if (j < 0 || j >= N) {
        continue;
      }
      sum += signal[j];
      cnt++;
    }
    out[i] = sum / cnt;
  }
  return out;
}

// ── Savitzky-Golay smoothing (cubic polynomial fit) ──────────────────────────
//
// Matches Python scipy.signal.savgol_filter(signal, window_length, polyorder=3).
// For 0th-derivative smoothing with order 3, the convolution coefficients are:
//   c_i = (S4 - S2 * i²) / (S0*S4 - S2²)
// where S_k = Σ j^k for j = -M..M.  This preserves polynomial shapes up to
// cubic, giving a much sharper frequency cutoff than a box filter — critical
// for preserving 24T+ tooth signals in the FFT.  (PAP-288)

/**
 * Compute Savitzky-Golay smoothing coefficients for a given half-window.
 * @param {number} halfWin - half-window M; total window = 2M+1
 * @returns {Float64Array} coefficients of length 2M+1 (symmetric)
 */
function computeSavgolCoeffs(halfWin) {
  const M = halfWin;
  const W = 2 * M + 1;
  let S0 = W, S2 = 0, S4 = 0;
  for (let i = -M; i <= M; i++) {
    const i2 = i * i;
    S2 += i2;
    S4 += i2 * i2;
  }
  const det = S0 * S4 - S2 * S2;
  const coeffs = new Float64Array(W);
  for (let i = -M; i <= M; i++) {
    coeffs[i + M] = (S4 - S2 * i * i) / det;
  }
  return coeffs;
}

// Pre-compute coefficients for commonly used window sizes
const _savgolCache = {};
function getSavgolCoeffs(halfWin) {
  if (!_savgolCache[halfWin]) {
    _savgolCache[halfWin] = computeSavgolCoeffs(halfWin);
  }
  return _savgolCache[halfWin];
}

/**
 * Savitzky-Golay (cubic, 0th-derivative) smoothing for a 1-D signal.
 * Drop-in replacement for smoothSignal on ring (wrap=true) signals where
 * frequency preservation matters (FFT-based tooth counting).
 *
 * @param {Float32Array|Float64Array|number[]} signal
 * @param {number} halfWin - half-window size (total window = 2*halfWin+1)
 * @param {boolean} [wrap=false] - if true, treat signal as circular
 * @returns {Float64Array}
 */
export function savgolSmooth(signal, halfWin, wrap = false) {
  const N = signal.length;
  const coeffs = getSavgolCoeffs(halfWin);
  const M = halfWin;
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let val = 0;
    for (let d = -M; d <= M; d++) {
      let j = i + d;
      if (wrap) {
        j = ((j % N) + N) % N;
      } else if (j < 0 || j >= N) {
        j = Math.max(0, Math.min(N - 1, j));
      }
      val += coeffs[d + M] * signal[j];
    }
    out[i] = val;
  }
  return out;
}

// ── Peak finding ────────────────────────────────────────────────────────────

/**
 * Find local maxima in a 1-D signal with distance and prominence constraints.
 *
 * @param {Float64Array|Float32Array|number[]} signal
 * @param {object} opts
 * @param {number} [opts.distance=1]    - minimum samples between peaks
 * @param {number} [opts.prominence=0]  - minimum prominence
 * @returns {number[]} indices of detected peaks
 */
export function findPeaks(signal, { distance = 1, prominence = 0 } = {}) {
  const N = signal.length;

  // Step 1: find all local maxima
  const candidates = [];
  for (let i = 1; i < N - 1; i++) {
    if (signal[i] > signal[i - 1] && signal[i] >= signal[i + 1]) {
      candidates.push(i);
    }
  }

  // Step 2: filter by prominence
  const prominent = prominence > 0
    ? candidates.filter(i => {
        // Walk left to find the lowest valley before a higher peak
        let leftMin = signal[i];
        for (let j = i - 1; j >= 0; j--) {
          if (signal[j] > signal[i]) break;
          if (signal[j] < leftMin) leftMin = signal[j];
        }
        // Walk right
        let rightMin = signal[i];
        for (let j = i + 1; j < N; j++) {
          if (signal[j] > signal[i]) break;
          if (signal[j] < rightMin) rightMin = signal[j];
        }
        const prom = signal[i] - Math.max(leftMin, rightMin);
        return prom >= prominence;
      })
    : candidates;

  // Step 3: enforce minimum distance (greedy, highest first)
  const sorted = prominent.slice().sort((a, b) => signal[b] - signal[a]);
  const kept = [];
  const used = new Uint8Array(N);
  for (const idx of sorted) {
    if (used[idx]) continue;
    kept.push(idx);
    for (let d = -distance + 1; d < distance; d++) {
      const j = idx + d;
      if (j >= 0 && j < N) used[j] = 1;
    }
  }

  return kept.sort((a, b) => a - b);
}
