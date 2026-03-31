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
  let changed = true;
  while (changed) {
    changed = false;
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
