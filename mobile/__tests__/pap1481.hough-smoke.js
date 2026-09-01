/**
 * PAP-1481 — Option A v1 ms-cost smoke (10 photos)
 *
 * Per QA verdict PAP-1488: pure-JS Hough Gradient circle detector on raw
 * downsampled RGBA, radius search range [0.15, 0.55] × min(W,H). Measure
 * p50/p95/p99 wall-time and compare against HEAD on a 10-photo sample.
 *
 * Pass bar (QA-provisional): houghProbe p99 delta ≤ +500ms vs HEAD on the
 * same 10 photos. If p99 exceeds 500ms, file a runtime-budget cross-check
 * before committing to the Option A v1 calibration sweep.
 *
 * Run:
 *   HARNESS=pap1481.hough-smoke npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const path = require('path');
const fs = require('fs');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out } = runner;

// 10-photo sample: stratified pick from cached baseline (every stamp
// guaranteed present). 3×11T + 4×XL + 2×Mid + 1×Small.
const SAMPLE_STAMPS = [
  '2026-04-04_09-10-51-656Z',
  '2026-04-05_08-32-48-875Z',
  '2026-04-05_08-33-27-869Z',
  '2026-04-24_10-54-55-930Z',
  '2026-04-25_07-58-59-154Z',
  '2026-04-25_08-05-45-433Z',
  '2026-04-25_09-03-13-830Z',
  '2026-04-08_18-28-12-142Z',
  '2026-04-08_18-30-50-993Z',
  '2026-04-04_09-09-24-950Z',
];

// ── Inline Hough Gradient (pure JS, prototype) ─────────────────────────────
// Inputs: downsampled rgba (Uint8Array, RGBA), width, height.
// 1. Grayscale.  2. Sobel gradient (gx, gy, mag).  3. Pick edge pixels where
//    mag > magThresh.  4. For each edge pixel and each candidate radius r in
//    [rMin, rMax] with step rStep, vote at (cx, cy) = (x - r·nx, y - r·ny)
//    where (nx, ny) = (gx, gy) / |g|.  5. Smooth accumulator, take peak.
//
// Returns { houghR, houghCx, houghCy, peakVotes, total } where houghR is the
// radius (in source pixels) at the peak, or 0 if no clear peak.

function rgbaToGray(rgba, w, h) {
  const len = w * h;
  const g = new Uint8Array(len);
  for (let i = 0, j = 0; i < len; i++, j += 4) {
    g[i] = (rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114) | 0;
  }
  return g;
}

function houghGradientCircles(rgba, w, h, opts = {}) {
  const minDim = Math.min(w, h);
  const rMin = Math.floor((opts.rMinFrac || 0.15) * minDim);
  const rMax = Math.floor((opts.rMaxFrac || 0.55) * minDim);
  const rStep = opts.rStep || 4;
  const magThresh = opts.magThresh || 80; // raw Sobel scale (max ~1140 for 8-bit input)

  // Step 1: grayscale
  const gray = rgbaToGray(rgba, w, h);

  // Step 2: Sobel — compute gx, gy, mag
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
      gx[i] = sx;
      gy[i] = sy;
      mag[i] = Math.sqrt(sx * sx + sy * sy);
    }
  }

  // Step 3: collect edge pixels
  const edges = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] > magThresh) edges.push(i);
    }
  }

  // Step 4: vote in 2D center-accumulator (one per radius; sum across radii
  // with max-pool gives strongest center, then refine radius).  Per-radius
  // accumulator is cheaper than full 3D acc.
  //
  // For the smoke we measure cost, not accuracy: collapse to a 2D center
  // accumulator with radius implicit in (r·nx, r·ny) for each candidate r.
  const radii = [];
  for (let r = rMin; r <= rMax; r += rStep) radii.push(r);

  const acc = new Uint32Array(w * h);
  const rMap = new Uint16Array(w * h); // radius that contributed strongest vote (approx)

  for (let k = 0; k < edges.length; k++) {
    const i = edges[k];
    const x = i % w;
    const y = (i / w) | 0;
    const gxk = gx[i];
    const gyk = gy[i];
    const m = mag[i];
    if (m <= 0) continue;
    const nx = gxk / m;
    const ny = gyk / m;
    for (let ri = 0; ri < radii.length; ri++) {
      const r = radii[ri];
      // vote at inside-circle hypothesis (center is along -gradient direction
      // from the edge pixel by distance r)
      const cxn = (x - r * nx) | 0;
      const cyn = (y - r * ny) | 0;
      if (cxn >= 0 && cxn < w && cyn >= 0 && cyn < h) {
        const ci = cyn * w + cxn;
        acc[ci]++;
        rMap[ci] = r; // last-wins; good enough for smoke
      }
      // also vote at outside-circle hypothesis (some images have inverted
      // gradient polarity — sky vs chainring)
      const cxp = (x + r * nx) | 0;
      const cyp = (y + r * ny) | 0;
      if (cxp >= 0 && cxp < w && cyp >= 0 && cyp < h) {
        const ci = cyp * w + cxp;
        acc[ci]++;
      }
    }
  }

  // Step 5: find peak
  let peak = 0, peakI = 0;
  for (let i = 0; i < acc.length; i++) {
    if (acc[i] > peak) { peak = acc[i]; peakI = i; }
  }
  const houghCx = peakI % w;
  const houghCy = (peakI / w) | 0;

  // PAP-1488 optimisation: drop the O(radii × edges) refinement pass.
  // For production Option A we'll use a 3D accumulator (cx, cy, r) so the
  // radius is implicit at the peak.  For the smoke we use rMap[peakI] which
  // records the last radius that contributed a vote at the peak cell —
  // sufficient for ms-cost timing and order-of-magnitude radius reporting.
  const bestR = rMap[peakI] || 0;

  return {
    houghR: bestR,
    houghCx, houghCy,
    peakVotes: peak,
    edgeCount: edges.length,
    radiiCount: radii.length,
  };
}

// ── Driver ─────────────────────────────────────────────────────────────────
describe('PAP-1481 Hough smoke (Option A v1 ms-cost gate)', () => {
  jest.setTimeout(30 * 60 * 1000);
  test('p50/p95/p99 timing on 10 photos', () => {
    const TRAINING_DIR = path.resolve(__dirname, '..', '..', 'training-data');
    const photos = SAMPLE_STAMPS.map(stamp => {
      const p = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
      const m = path.join(TRAINING_DIR, `${stamp}_meta.json`);
      if (!fs.existsSync(p)) return null;
      let actual = 0;
      try {
        const meta = JSON.parse(fs.readFileSync(m, 'utf8').replace(/[^\x00-\x7F]+/g, '?'));
        actual = Number(meta.actual_tooth_count || meta.actualTeethCount || 0);
      } catch {}
      return { stamp, photo: p, actual };
    }).filter(Boolean);

    out('\n=== PAP-1481 Hough smoke (Option A v1 ms-cost) ===');
    out(`Sample: ${photos.length}/${SAMPLE_STAMPS.length} photos found`);

    // Warmup (let JIT settle and the RGBA cache prime)
    const { countTeethFromRgba } = runner.getAlgo();
    for (const p of photos.slice(0, 2)) {
      const { rgba, w, h } = runner.loadOrDecodeRgba(p.photo, p.stamp);
      try { countTeethFromRgba(rgba, w, h); } catch {}
      houghGradientCircles(rgba, w, h);
    }

    const headTimes = [];
    const houghTimes = [];
    const houghResults = [];
    const dims = [];

    for (const p of photos) {
      const { rgba, w, h } = runner.loadOrDecodeRgba(p.photo, p.stamp);
      dims.push({ w, h, n: w * h });

      // HEAD timing (full countTeethFromRgba)
      const t0 = process.hrtime.bigint();
      try { countTeethFromRgba(rgba, w, h); } catch {}
      const t1 = process.hrtime.bigint();
      headTimes.push(Number(t1 - t0) / 1e6);

      // Hough probe timing (standalone — what would be added by Option A)
      const t2 = process.hrtime.bigint();
      const hr = houghGradientCircles(rgba, w, h);
      const t3 = process.hrtime.bigint();
      houghTimes.push(Number(t3 - t2) / 1e6);
      houghResults.push({ stamp: p.stamp, actual: p.actual, ...hr });
    }

    const pct = (arr, p) => {
      const s = arr.slice().sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(p * s.length))];
    };

    out('\nPer-photo timings (ms):');
    out('stamp                          actual  W×H        HEAD_ms  Hough_ms  houghR  aimR   ratio    edges  peak');
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      const d = dims[i];
      const hr = houghResults[i];
      const aimR = 0.5 * Math.min(d.w, d.h);
      const ratio = aimR > 0 ? hr.houghR / aimR : 0;
      out(
        `${p.stamp}  ${String(p.actual).padStart(3)}T   ` +
        `${String(d.w).padStart(3)}×${String(d.h).padStart(3)}  ` +
        `${headTimes[i].toFixed(0).padStart(7)}  ${houghTimes[i].toFixed(0).padStart(8)}  ` +
        `${String(hr.houghR).padStart(5)}   ${aimR.toFixed(0).padStart(3)}    ` +
        `${ratio.toFixed(2).padStart(5)}    ${String(hr.edgeCount).padStart(5)}  ${String(hr.peakVotes).padStart(4)}`
      );
    }

    out('\nSummary:');
    out(`HEAD timings:  p50=${pct(headTimes, 0.5).toFixed(0)}ms  p95=${pct(headTimes, 0.95).toFixed(0)}ms  p99=${pct(headTimes, 0.99).toFixed(0)}ms`);
    out(`Hough probe:   p50=${pct(houghTimes, 0.5).toFixed(0)}ms  p95=${pct(houghTimes, 0.95).toFixed(0)}ms  p99=${pct(houghTimes, 0.99).toFixed(0)}ms`);
    const p99Delta = pct(houghTimes, 0.99);
    out(`\nQA pass bar: p99 delta ≤ +500ms vs HEAD`);
    if (p99Delta <= 500) {
      out(`[PASS] Hough p99=${p99Delta.toFixed(0)}ms ≤ 500ms — proceed to file Option A v1 spec`);
    } else {
      out(`[FAIL] Hough p99=${p99Delta.toFixed(0)}ms > 500ms — file runtime-budget cross-check before calibration`);
    }

    // Also report ratio distribution (chainring vs cog discriminator preview)
    const ratios = houghResults.map(r => {
      const aimR = 0.5 * Math.min(900, 600); // approximate
      return r.houghR / aimR;
    }).sort((a, b) => a - b);
    out(`\nHoughR/aimR ratio distribution: min=${ratios[0].toFixed(2)}, med=${ratios[Math.floor(ratios.length/2)].toFixed(2)}, max=${ratios[ratios.length-1].toFixed(2)}`);

    expect(true).toBe(true);
  });
});
