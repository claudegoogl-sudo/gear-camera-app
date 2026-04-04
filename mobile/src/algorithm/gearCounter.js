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
const N_ANGLES         = 720;
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

// ── 5. Gear centre via contour detection ─────────────────────────────────────
//
// Finds the gear by thresholding the grayscale image to isolate dark regions
// (gear = dark metal), then uses connected-component labelling to find the
// most circular "donut" shape (dark blob with an interior hole = bore).
// This is far more robust against background clutter than edge centroids.

// 5a. Otsu threshold — automatic dark/light separation
function otsuThreshold(gray, width, height) {
  // Build histogram (256 bins)
  const hist = new Int32Array(256);
  const n = width * height;
  for (let i = 0; i < n; i++) {
    hist[Math.min(255, Math.max(0, Math.round(gray[i])))]++;
  }

  // Find threshold that minimises intra-class variance
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

  // Binary mask: 1 = dark (below threshold), 0 = light
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    mask[i] = gray[i] <= best ? 1 : 0;
  }
  return mask;
}

// 5b. Morphological close (dilate then erode) with a circular structuring element
function morphClose(mask, width, height, radius) {
  const n = width * height;
  const tmp = new Uint8Array(n);
  const out = new Uint8Array(n);

  // Build circular kernel offsets
  const offsets = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) offsets.push({ dx, dy });
    }
  }

  // Dilate: output pixel = 1 if any neighbour in kernel is 1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let val = 0;
      for (const { dx, dy } of offsets) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          if (mask[ny * width + nx]) { val = 1; break; }
        }
      }
      tmp[y * width + x] = val;
    }
  }

  // Erode: output pixel = 1 only if all neighbours in kernel are 1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let val = 1;
      for (const { dx, dy } of offsets) {
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

// 5c. Connected-component labelling (BFS flood-fill)
function labelComponents(mask, width, height, targetVal) {
  const n = width * height;
  const labels = new Int32Array(n);    // 0 = unlabelled
  let nextLabel = 1;
  const components = [];               // {id, area, sx, sy, minX, minY, maxX, maxY, touchesBorder}

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] !== targetVal || labels[idx] !== 0) continue;

      // BFS
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

        // 4-connected neighbours
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

// 5d. Compute perimeter of a labelled component (count boundary pixels)
function componentPerimeter(labels, width, height, compId) {
  let peri = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (labels[y * width + x] !== compId) continue;
      // Is boundary pixel? (has at least one 4-neighbour that's different)
      let isBoundary = false;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height ||
            labels[ny * width + nx] !== compId) {
          isBoundary = true;
          break;
        }
      }
      if (isBoundary) peri++;
    }
  }
  return peri;
}

// 5e. Main contour-based center detection
function findGearCenter(edges, width, height, gray) {
  // Step 1: Otsu threshold on grayscale to find dark regions
  const darkMask = otsuThreshold(gray, width, height);

  // Step 2: Morphological close to fill small gaps in gear body
  const closed = morphClose(darkMask, width, height, 2);

  // Step 3: Label dark components
  const { labels: darkLabels, components: darkComps } =
    labelComponents(closed, width, height, 1);

  // Step 4: Label light components (for hole/donut detection)
  const { labels: lightLabels, components: lightComps } =
    labelComponents(closed, width, height, 0);

  // Step 5: Find which dark components contain interior holes (donuts)
  // A light component is a "hole" if it doesn't touch the image border.
  // Its parent dark component is determined by checking the dark label
  // adjacent to the hole.
  const darkHasHole = new Set();
  for (const lc of lightComps) {
    if (lc.touchesBorder || lc.area < 50) continue;
    // Find which dark component surrounds this hole:
    // check the dark label just outside the hole's bounding box
    const checkX = Math.max(0, lc.minX - 1);
    const checkY = Math.max(0, lc.minY - 1);
    const parentId = darkLabels[checkY * width + checkX];
    if (parentId > 0) {
      darkHasHole.add(parentId);
    }
  }

  // Step 6: Score each dark component
  const n = width * height;
  let bestComp = null;
  let bestScore = -1;

  for (const dc of darkComps) {
    if (dc.area < 300 || dc.area > 0.5 * n) continue;
    if (dc.touchesBorder) continue;

    const peri = componentPerimeter(darkLabels, width, height, dc.id);
    const circ = peri > 0 ? (4 * Math.PI * dc.area) / (peri * peri) : 0;
    const hasHole = darkHasHole.has(dc.id);

    // Score: circularity × donut bonus
    const score = circ * (hasHole ? 1.5 : 1.0);

    if (score > bestScore) {
      bestScore = score;
      bestComp = {
        cx: Math.round(dc.sx / dc.area),
        cy: Math.round(dc.sy / dc.area),
        radius: Math.round(Math.sqrt(dc.area / Math.PI)),
        circularity: circ,
        hasHole,
      };
    }
  }

  // Fallback: center-weighted edge centroid (original approach)
  if (bestComp === null) {
    const cx0 = width / 2;
    const cy0 = height / 2;
    const sigX = width * 0.25;
    const sigY = height * 0.25;
    let wsx = 0, wsy = 0, wsum = 0;
    for (let y = 0; y < height; y++) {
      const dy = (y - cy0) / sigY;
      const wy = Math.exp(-dy * dy);
      for (let x = 0; x < width; x++) {
        if (edges[y * width + x] > 0) {
          const dx = (x - cx0) / sigX;
          const w = wy * Math.exp(-dx * dx);
          wsx += x * w;
          wsy += y * w;
          wsum += w;
        }
      }
    }
    if (wsum === 0) return { cx: Math.floor(cx0), cy: Math.floor(cy0) };
    return { cx: Math.round(wsx / wsum), cy: Math.round(wsy / wsum) };
  }

  return bestComp;
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

// ── 8. DFT (sparse — only compute bins needed for tooth scoring) ─────────────

function computeDFT(signal) {
  const N   = signal.length;
  const out = new Float32Array(Math.floor(N / 2) + 1);
  const mean = signal.reduce((a, b) => a + b, 0) / N;

  // Only compute bins we actually use: fundamentals MIN_TEETH..MAX_TEETH
  // plus their 2nd and 3rd harmonics (for harmonic-weighted scoring).
  const binsNeeded = new Set();
  for (let f = MIN_TEETH; f <= MAX_TEETH && f < out.length; f++) {
    binsNeeded.add(f);
    if (2 * f < out.length) binsNeeded.add(2 * f);
    if (3 * f < out.length) binsNeeded.add(3 * f);
  }

  for (const k of binsNeeded) {
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

  // Contour-based center detection uses grayscale directly; also provides
  // an approximate radius from the contour area.  Falls back to edge
  // centroid if no suitable contour is found.
  const centerResult = findGearCenter(edges, width, height, gray);
  const cx = centerResult.cx;
  const cy = centerResult.cy;
  const contourRadius = centerResult.radius || 0;

  // Use contour radius if available, otherwise fall back to edge-density
  const r = contourRadius > 20
    ? contourRadius
    : findGearRadius(edges, cx, cy, width, height);
  const t3 = Date.now();

  // ── Multi-radius FFT scan ──────────────────────────────────────────
  // Scan radii from 0.50× to 1.15× of the detected gear radius and
  // keep the result with the highest spectral purity (confidence).
  // Also accumulate per-tooth-count votes for small-gear refinement.
  let bestToothCount = 0;
  let bestConfidence = 0;
  let bestR          = r;

  const maxSafe = Math.min(cx, width - cx, cy, height - cy) - 1;

  // Collect all (radius, toothCount, confidence) results for voting
  const scanResults = [];

  for (let pct = 50; pct <= 115; pct += 4) {
    const rTest = Math.round(r * pct / 100);
    if (rTest < 20 || rTest >= maxSafe) continue;

    const ring = sampleIntensityRing(gray, cx, cy, rTest, width, height, N_ANGLES);
    const dft  = computeDFT(ring);
    const { toothCount: tc, confidence: conf } = pickToothCount(dft);

    scanResults.push({ rTest, tc, conf });

    if (conf > bestConfidence) {
      bestConfidence = conf;
      bestToothCount = tc;
      bestR          = rTest;
    }
  }

  // Small-gear refinement: when best result is in 10-20 range, inner
  // spline features can dominate.  Check if a nearby count (±3) has
  // stronger total support across outer-half radii.
  if (bestToothCount > 0 && bestToothCount <= 20) {
    const outerMin = r * 0.45;
    const tcVotes = {};
    for (const { rTest: rr, tc, conf } of scanResults) {
      if (rr >= outerMin && conf > 0) {
        tcVotes[tc] = (tcVotes[tc] || 0) + conf;
      }
    }
    let topVoteTc = bestToothCount;
    let topVote = tcVotes[bestToothCount] || 0;
    for (const [tcStr, vote] of Object.entries(tcVotes)) {
      const tcNum = Number(tcStr);
      if (Math.abs(tcNum - bestToothCount) <= 3 && vote > topVote) {
        topVote = vote;
        topVoteTc = tcNum;
      }
    }
    if (topVoteTc !== bestToothCount) {
      // Switch to the better-voted count; find its best confidence result
      for (const { rTest: rr, tc, conf } of scanResults) {
        if (tc === topVoteTc && rr >= outerMin && conf >= bestConfidence * 0.5) {
          bestToothCount = tc;
          bestR = rr;
          // Keep original bestConfidence as floor
          break;
        }
      }
    }
  }

  const t4 = Date.now();

  const centerMethod = centerResult.circularity != null ? 'contour' : 'edge-centroid';
  const radiusMethod = contourRadius > 20 ? 'contour' : 'edge-density';

  console.log(
    `[GearCounter] ${width}×${height}px | ` +
    `load=${t1-t0}ms preprocess=${t2-t1}ms detect=${t3-t2}ms fft=${t4-t3}ms total=${t4-t0}ms\n` +
    `  center=(${cx},${cy}) method=${centerMethod}` +
    (centerResult.circularity != null ? ` circ=${centerResult.circularity.toFixed(2)} donut=${centerResult.hasHole}` : '') + '\n' +
    `  radius=${r} method=${radiusMethod} scanBestR=${bestR}\n` +
    `  result=${bestToothCount}T conf=${(bestConfidence * 100).toFixed(1)}%`
  );

  return {
    toothCount: bestToothCount,
    confidence: bestConfidence,
    gearCenter: { x: cx / width, y: cy / height },
    gearRadius: bestR / width,
  };
}
