/**
 * PAP-1481 — v2 candidates pre-probe (a/b/c)
 *
 * The smoke kernel (Sobel + dense gradient Hough on raw RGBA) cannot separate
 * XL42+ from Small/Mid — see pap1481.hough-radius-diag.js / pap1481_radius_diag_2026-05-14.log.
 * Posted v1 descope recommendation on PAP-1489 and proposed v2a/v2b/v2c.
 *
 * This probe runs all three variants on the same n=13 stratified sample so
 * QA can pick the cheapest viable path without burning a calibration sweep.
 *
 *  v2a — Sparse-edge Hough: keep only top-percentile gradient magnitudes
 *        (high-threshold Sobel ≈ Canny strong-edges).
 *  v2b — Per-radius accumulator with proper 3D argmax (cx, cy, r tuple)
 *        — answers "is the outer ring drowned under inner BCD peak?"
 *  v2c — Annular Hough constrained to aim-prior band [0.30, 0.70]×minDim
 *        (= [0.6, 1.4]×aimR) — forces voting in the chainring radius range.
 *
 * Run:
 *   HARNESS=pap1481.v2-probe npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const path = require('path');
const fs = require('fs');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out } = runner;

const SAMPLE = [
  ['11T',   '2026-04-04_09-10-51-656Z', 11],
  ['11T',   '2026-04-05_08-32-48-875Z', 11],
  ['11T',   '2026-04-05_08-33-27-869Z', 11],
  ['Mid',   '2026-04-08_18-30-50-993Z', 21],
  ['Mid',   '2026-04-08_18-34-56-184Z', 24],
  ['Mid',   '2026-04-08_18-38-08-065Z', 28],
  ['Small', '2026-04-04_09-09-24-950Z', 15],
  ['Small', '2026-04-04_09-09-54-631Z', 14],
  ['Small', '2026-04-04_09-10-20-407Z', 13],
  ['XL42+', '2026-04-24_10-54-55-930Z', 42],
  ['XL42+', '2026-04-25_09-03-13-830Z', 51],
  ['XL42+', '2026-04-26_08-54-51-262Z', 52],
  ['XL42+', '2026-04-28_06-50-20-391Z', 42],
];

function rgbaToGray(rgba, w, h) {
  const len = w * h;
  const g = new Uint8Array(len);
  for (let i = 0, j = 0; i < len; i++, j += 4) {
    g[i] = (rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114) | 0;
  }
  return g;
}

function sobel(gray, w, h) {
  const gx = new Int16Array(w * h);
  const gy = new Int16Array(w * h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const sx =
        -gray[i - w - 1] + gray[i - w + 1] +
        -2 * gray[i - 1] + 2 * gray[i + 1] +
        -gray[i + w - 1] + gray[i + w + 1];
      const sy =
        -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] +
         gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      gx[i] = sx; gy[i] = sy;
      mag[i] = Math.sqrt(sx * sx + sy * sy);
    }
  }
  return { gx, gy, mag };
}

// pick edge pixels with magnitude > thresh, optionally cap to top-N strongest
function pickEdges(mag, w, h, thresh, topNFrac) {
  const candidates = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] > thresh) candidates.push([i, mag[i]]);
    }
  }
  if (topNFrac && topNFrac < 1.0) {
    candidates.sort((a, b) => b[1] - a[1]);
    candidates.length = Math.floor(candidates.length * topNFrac);
  }
  return candidates.map(c => c[0]);
}

// ── v2a: sparse-edge Hough (high-threshold edges, ~Canny strong-edge subset) ──
function houghSparse(rgba, w, h) {
  const minDim = Math.min(w, h);
  const rMin = Math.floor(0.15 * minDim);
  const rMax = Math.floor(0.55 * minDim);
  const rStep = 4;
  const gray = rgbaToGray(rgba, w, h);
  const { gx, gy, mag } = sobel(gray, w, h);
  // Aggressive threshold + top 20% retention → analogue of Canny strong edges
  const edges = pickEdges(mag, w, h, 200, 0.20);

  const radii = []; for (let r = rMin; r <= rMax; r += rStep) radii.push(r);
  const acc = new Uint32Array(w * h);
  for (let k = 0; k < edges.length; k++) {
    const i = edges[k]; const x = i % w; const y = (i / w) | 0;
    const m = mag[i]; if (m <= 0) continue;
    const nx = gx[i] / m; const ny = gy[i] / m;
    for (let ri = 0; ri < radii.length; ri++) {
      const r = radii[ri];
      const cxn = (x - r * nx) | 0, cyn = (y - r * ny) | 0;
      if (cxn >= 0 && cxn < w && cyn >= 0 && cyn < h) acc[cyn * w + cxn]++;
      const cxp = (x + r * nx) | 0, cyp = (y + r * ny) | 0;
      if (cxp >= 0 && cxp < w && cyp >= 0 && cyp < h) acc[cyp * w + cxp]++;
    }
  }
  let peak = 0, peakI = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > peak) { peak = acc[i]; peakI = i; }
  const peakCx = peakI % w, peakCy = (peakI / w) | 0;

  // per-radius vote at peak
  const perR = new Uint32Array(radii.length);
  for (let k = 0; k < edges.length; k++) {
    const i = edges[k]; const x = i % w; const y = (i / w) | 0;
    const m = mag[i]; if (m <= 0) continue;
    const nx = gx[i] / m; const ny = gy[i] / m;
    for (let ri = 0; ri < radii.length; ri++) {
      const r = radii[ri];
      const cxn = (x - r * nx) | 0, cyn = (y - r * ny) | 0;
      if (Math.abs(cxn - peakCx) <= 1 && Math.abs(cyn - peakCy) <= 1) perR[ri]++;
      const cxp = (x + r * nx) | 0, cyp = (y + r * ny) | 0;
      if (Math.abs(cxp - peakCx) <= 1 && Math.abs(cyp - peakCy) <= 1) perR[ri]++;
    }
  }
  let maxV = 0, maxRi = 0;
  for (let ri = 0; ri < radii.length; ri++) if (perR[ri] > maxV) { maxV = perR[ri]; maxRi = ri; }
  const total = perR.reduce((s, v) => s + v, 0) || 1;
  return { dominantR: radii[maxRi], peakShare: maxV / total, edgeCount: edges.length };
}

// ── v2b: per-radius 2D accumulator, 3D argmax (cx, cy, r) ──
function hough3D(rgba, w, h) {
  const minDim = Math.min(w, h);
  const rMin = Math.floor(0.15 * minDim);
  const rMax = Math.floor(0.55 * minDim);
  const rStep = 6; // coarser for perf
  const gray = rgbaToGray(rgba, w, h);
  const { gx, gy, mag } = sobel(gray, w, h);
  const edges = pickEdges(mag, w, h, 80);
  const radii = []; for (let r = rMin; r <= rMax; r += rStep) radii.push(r);
  const acc = new Uint32Array(w * h);

  let bestVotes = 0, bestR = 0, bestCx = 0, bestCy = 0;
  for (let ri = 0; ri < radii.length; ri++) {
    acc.fill(0);
    const r = radii[ri];
    for (let k = 0; k < edges.length; k++) {
      const i = edges[k]; const x = i % w; const y = (i / w) | 0;
      const m = mag[i]; if (m <= 0) continue;
      const nx = gx[i] / m; const ny = gy[i] / m;
      const cxn = (x - r * nx) | 0, cyn = (y - r * ny) | 0;
      if (cxn >= 0 && cxn < w && cyn >= 0 && cyn < h) acc[cyn * w + cxn]++;
      const cxp = (x + r * nx) | 0, cyp = (y + r * ny) | 0;
      if (cxp >= 0 && cxp < w && cyp >= 0 && cyp < h) acc[cyp * w + cxp]++;
    }
    let p = 0, pi = 0;
    for (let i = 0; i < acc.length; i++) if (acc[i] > p) { p = acc[i]; pi = i; }
    if (p > bestVotes) {
      bestVotes = p; bestR = r;
      bestCx = pi % w; bestCy = (pi / w) | 0;
    }
  }
  return { dominantR: bestR, peakVotes: bestVotes, cx: bestCx, cy: bestCy, edgeCount: edges.length };
}

// ── v2c: annular Hough — radius search restricted to aim-prior band ──
function houghAnnular(rgba, w, h) {
  const minDim = Math.min(w, h);
  // aimR = 0.5 × minDim. Band [0.6, 1.4] × aimR → [0.30, 0.70] × minDim.
  const rMin = Math.floor(0.30 * minDim);
  const rMax = Math.floor(0.70 * minDim);
  const rStep = 4;
  const gray = rgbaToGray(rgba, w, h);
  const { gx, gy, mag } = sobel(gray, w, h);
  const edges = pickEdges(mag, w, h, 80);
  const radii = []; for (let r = rMin; r <= rMax; r += rStep) radii.push(r);
  const acc = new Uint32Array(w * h);
  for (let k = 0; k < edges.length; k++) {
    const i = edges[k]; const x = i % w; const y = (i / w) | 0;
    const m = mag[i]; if (m <= 0) continue;
    const nx = gx[i] / m; const ny = gy[i] / m;
    for (let ri = 0; ri < radii.length; ri++) {
      const r = radii[ri];
      const cxn = (x - r * nx) | 0, cyn = (y - r * ny) | 0;
      if (cxn >= 0 && cxn < w && cyn >= 0 && cyn < h) acc[cyn * w + cxn]++;
      const cxp = (x + r * nx) | 0, cyp = (y + r * ny) | 0;
      if (cxp >= 0 && cxp < w && cyp >= 0 && cyp < h) acc[cyp * w + cxp]++;
    }
  }
  let peak = 0, peakI = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > peak) { peak = acc[i]; peakI = i; }
  const peakCx = peakI % w, peakCy = (peakI / w) | 0;
  // per-radius at peak
  const perR = new Uint32Array(radii.length);
  for (let k = 0; k < edges.length; k++) {
    const i = edges[k]; const x = i % w; const y = (i / w) | 0;
    const m = mag[i]; if (m <= 0) continue;
    const nx = gx[i] / m; const ny = gy[i] / m;
    for (let ri = 0; ri < radii.length; ri++) {
      const r = radii[ri];
      const cxn = (x - r * nx) | 0, cyn = (y - r * ny) | 0;
      if (Math.abs(cxn - peakCx) <= 1 && Math.abs(cyn - peakCy) <= 1) perR[ri]++;
      const cxp = (x + r * nx) | 0, cyp = (y + r * ny) | 0;
      if (Math.abs(cxp - peakCx) <= 1 && Math.abs(cyp - peakCy) <= 1) perR[ri]++;
    }
  }
  let maxV = 0, maxRi = 0;
  for (let ri = 0; ri < radii.length; ri++) if (perR[ri] > maxV) { maxV = perR[ri]; maxRi = ri; }
  const total = perR.reduce((s, v) => s + v, 0) || 1;
  return { dominantR: radii[maxRi], peakShare: maxV / total, peakVotes: peak, edgeCount: edges.length };
}

describe('PAP-1481 v2 probe (a/b/c on n=13)', () => {
  jest.setTimeout(15 * 60 * 1000);
  test('compare v2a sparse / v2b 3D / v2c annular', () => {
    const TRAINING_DIR = path.resolve(__dirname, '..', '..', 'training-data');
    const rows = [];

    out('\n=== PAP-1481 v2 candidate probe (n=13) ===');
    out('Definitions:');
    out('  v2a: sparse Sobel (thresh=200 + top 20%) → gradient Hough on raw RGBA');
    out('  v2b: per-radius 2D acc + 3D argmax → finds (cx,cy,r) tuple, not 2D-peak-then-radius');
    out('  v2c: gradient Hough constrained to annular band [0.30, 0.70]×minDim (= [0.6, 1.4]×aimR)');
    out('');
    out('cluster   stamp                          a  W×H        v2a_dR  v2a_share  v2b_dR  v2b_votes  v2c_dR  v2c_share  v2c_votes  v2a_ratio  v2b_ratio  v2c_ratio');

    for (const [cluster, stamp, actual] of SAMPLE) {
      const photo = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
      if (!fs.existsSync(photo)) continue;
      const { rgba, w, h } = runner.loadOrDecodeRgba(photo, stamp);
      const a = houghSparse(rgba, w, h);
      const b = hough3D(rgba, w, h);
      const c = houghAnnular(rgba, w, h);
      const aimR = 0.5 * Math.min(w, h);
      const r2a = a.dominantR / aimR;
      const r2b = b.dominantR / aimR;
      const r2c = c.dominantR / aimR;
      out(
        `${cluster.padEnd(7)}   ${stamp}  ${String(actual).padStart(2)} ` +
        `${String(w).padStart(3)}×${String(h).padStart(3)}  ` +
        `${String(a.dominantR).padStart(4)}    ${a.peakShare.toFixed(2)}      ` +
        `${String(b.dominantR).padStart(4)}    ${String(b.peakVotes).padStart(4)}       ` +
        `${String(c.dominantR).padStart(4)}    ${c.peakShare.toFixed(2)}       ${String(c.peakVotes).padStart(4)}    ` +
        `  ${r2a.toFixed(2)}      ${r2b.toFixed(2)}      ${r2c.toFixed(2)}`
      );
      rows.push({ cluster, stamp, actual, w, h, aimR, a, b, c });
    }

    out('\n=== Per-cluster medians (ratio = dominantR / aimR) ===');
    out('cluster   n   v2a_ratio_med  v2a_share_med   v2b_ratio_med   v2c_ratio_med  v2c_share_med');
    const byC = {};
    for (const r of rows) (byC[r.cluster] ||= []).push(r);
    const med = (a) => a.slice().sort((x,y) => x-y)[Math.floor(a.length/2)];
    for (const c of ['11T', 'Small', 'Mid', 'XL42+']) {
      const rs = byC[c] || []; if (!rs.length) continue;
      const va_r = rs.map(r => r.a.dominantR / r.aimR);
      const va_s = rs.map(r => r.a.peakShare);
      const vb_r = rs.map(r => r.b.dominantR / r.aimR);
      const vc_r = rs.map(r => r.c.dominantR / r.aimR);
      const vc_s = rs.map(r => r.c.peakShare);
      out(
        `${c.padEnd(8)}  ${String(rs.length).padStart(2)}   ` +
        `${med(va_r).toFixed(2)} (${Math.min(...va_r).toFixed(2)}-${Math.max(...va_r).toFixed(2)})   ` +
        `${med(va_s).toFixed(2)}            ` +
        `${med(vb_r).toFixed(2)} (${Math.min(...vb_r).toFixed(2)}-${Math.max(...vb_r).toFixed(2)})    ` +
        `${med(vc_r).toFixed(2)} (${Math.min(...vc_r).toFixed(2)}-${Math.max(...vc_r).toFixed(2)})   ` +
        `${med(vc_s).toFixed(2)}`
      );
    }

    out('\nSeparability check: does any variant show XL42+ ratio_range disjoint from Small+Mid?');
    for (const variant of ['a', 'b', 'c']) {
      const xl = (byC['XL42+'] || []).map(r => r[variant].dominantR / r.aimR);
      const others = [...(byC['Small']||[]), ...(byC['Mid']||[])].map(r => r[variant].dominantR / r.aimR);
      const xlMin = Math.min(...xl), xlMax = Math.max(...xl);
      const otherMin = Math.min(...others), otherMax = Math.max(...others);
      const disjoint = (xlMin > otherMax) || (xlMax < otherMin);
      out(`  v2${variant}: XL42+ [${xlMin.toFixed(2)}, ${xlMax.toFixed(2)}] vs Small+Mid [${otherMin.toFixed(2)}, ${otherMax.toFixed(2)}] → ${disjoint ? 'DISJOINT (viable)' : 'OVERLAPS'}`);
    }
    expect(true).toBe(true);
  });
});
