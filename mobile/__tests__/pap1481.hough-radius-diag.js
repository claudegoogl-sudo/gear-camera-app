/**
 * PAP-1481 — Hough radius-distribution diagnostic
 *
 * The smoke (pap1481.hough-smoke.js) used `rMap[peakI]` last-vote-wins to
 * report the radius at the peak cell.  That is noisy: if many radii vote at
 * the same cell, rMap captures whichever fired *last*, not the dominant.
 *
 * This diagnostic answers: when we find the Hough peak (cx, cy), what is the
 * actual vote distribution across radii at that cell?  If chainrings produce
 * a single sharp radius peak well above cogs, the v1 spec is sound (the smoke
 * ratio overlap is an artifact).  If the distribution is genuinely smeared,
 * Option A v1 with the smoke kernel cannot work — need v2 (3D accumulator).
 *
 * Method (cheap two-pass):
 *  Pass 1 — same as smoke: build 2D accumulator over all radii, find peak
 *           (cx, cy).
 *  Pass 2 — replay each edge for each radius, count only the votes whose
 *           target cell == (cx, cy).  This yields per-radius vote counts at
 *           the peak — i.e. the true radius distribution at the peak.
 *
 * Output per photo: peak cell, top-3 (radius, votes), entropy of the
 * distribution.  Aggregate per cluster.
 *
 * Run:
 *   HARNESS=pap1481.hough-radius-diag npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const path = require('path');
const fs = require('fs');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out } = runner;

// 13-photo stratified diagnostic (3×11T + 3×Mid + 3×Small + 4×XL42+).
// Picked from cached baseline; XL prefers confidentWrong (chainring regime
// where the discriminator must fire).
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

function houghDiag(rgba, w, h, opts = {}) {
  const minDim = Math.min(w, h);
  const rMin = Math.floor((opts.rMinFrac || 0.15) * minDim);
  const rMax = Math.floor((opts.rMaxFrac || 0.55) * minDim);
  const rStep = opts.rStep || 4;
  const magThresh = opts.magThresh || 80;

  const gray = rgbaToGray(rgba, w, h);

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

  const edges = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] > magThresh) edges.push(i);
    }
  }

  const radii = [];
  for (let r = rMin; r <= rMax; r += rStep) radii.push(r);

  // Pass 1: vote into shared accumulator, find peak
  const acc = new Uint32Array(w * h);
  for (let k = 0; k < edges.length; k++) {
    const i = edges[k];
    const x = i % w; const y = (i / w) | 0;
    const m = mag[i]; if (m <= 0) continue;
    const nx = gx[i] / m; const ny = gy[i] / m;
    for (let ri = 0; ri < radii.length; ri++) {
      const r = radii[ri];
      const cxn = (x - r * nx) | 0;
      const cyn = (y - r * ny) | 0;
      if (cxn >= 0 && cxn < w && cyn >= 0 && cyn < h) acc[cyn * w + cxn]++;
      const cxp = (x + r * nx) | 0;
      const cyp = (y + r * ny) | 0;
      if (cxp >= 0 && cxp < w && cyp >= 0 && cyp < h) acc[cyp * w + cxp]++;
    }
  }
  let peak = 0, peakI = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > peak) { peak = acc[i]; peakI = i; }
  const peakCx = peakI % w; const peakCy = (peakI / w) | 0;

  // Pass 2: per-radius vote count at the peak cell (3x3 tolerance window —
  // accumulator quantisation can spread a peak across neighbours)
  const perRadiusVotes = new Uint32Array(radii.length);
  const tol = 1;
  for (let k = 0; k < edges.length; k++) {
    const i = edges[k];
    const x = i % w; const y = (i / w) | 0;
    const m = mag[i]; if (m <= 0) continue;
    const nx = gx[i] / m; const ny = gy[i] / m;
    for (let ri = 0; ri < radii.length; ri++) {
      const r = radii[ri];
      const cxn = (x - r * nx) | 0;
      const cyn = (y - r * ny) | 0;
      if (Math.abs(cxn - peakCx) <= tol && Math.abs(cyn - peakCy) <= tol) perRadiusVotes[ri]++;
      const cxp = (x + r * nx) | 0;
      const cyp = (y + r * ny) | 0;
      if (Math.abs(cxp - peakCx) <= tol && Math.abs(cyp - peakCy) <= tol) perRadiusVotes[ri]++;
    }
  }

  // Build sorted (radius, votes) list
  const dist = radii.map((r, ri) => ({ r, votes: perRadiusVotes[ri] })).sort((a, b) => b.votes - a.votes);
  const total = dist.reduce((s, d) => s + d.votes, 0) || 1;
  // Shannon entropy of normalised distribution (lower = sharper peak)
  let H = 0;
  for (const d of dist) if (d.votes > 0) {
    const p = d.votes / total;
    H -= p * Math.log2(p);
  }

  return {
    peakCx, peakCy, peakVotes: peak,
    edgeCount: edges.length,
    radiiCount: radii.length,
    top3: dist.slice(0, 3),
    entropy: H,
    dominantR: dist[0].r,
    dominantVoteShare: dist[0].votes / total,
  };
}

describe('PAP-1481 Hough radius-distribution diagnostic', () => {
  jest.setTimeout(15 * 60 * 1000);
  test('per-radius vote distribution at peak (13 photos, 4 clusters)', () => {
    const TRAINING_DIR = path.resolve(__dirname, '..', '..', 'training-data');
    const rows = [];

    out('\n=== PAP-1481 Hough radius distribution diagnostic ===');
    out('Method: 2-pass — shared accumulator find peak, replay edges to count per-radius votes at peak (±1 tol)');
    out('');
    out('cluster  stamp                          actual  W×H        edges  peakVotes  dominantR  share   entropy  top3(r:votes)');

    for (const [cluster, stamp, actual] of SAMPLE) {
      const photo = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
      if (!fs.existsSync(photo)) { out(`${cluster}  ${stamp}  NOT FOUND`); continue; }
      const { rgba, w, h } = runner.loadOrDecodeRgba(photo, stamp);
      const d = houghDiag(rgba, w, h);
      const aimR = 0.5 * Math.min(w, h);
      const rRatio = d.dominantR / aimR;
      const top3str = d.top3.map(t => `${t.r}:${t.votes}`).join(' ');
      out(
        `${cluster.padEnd(7)}  ${stamp}  ${String(actual).padStart(3)}T   ` +
        `${String(w).padStart(3)}×${String(h).padStart(3)}  ` +
        `${String(d.edgeCount).padStart(5)}  ${String(d.peakVotes).padStart(8)}   ` +
        `${String(d.dominantR).padStart(4)}     ${d.dominantVoteShare.toFixed(2)}    ${d.entropy.toFixed(2)}    ${top3str}` +
        `   (ratio=${rRatio.toFixed(2)})`
      );
      rows.push({ cluster, stamp, actual, w, h, ...d, aimR, rRatio });
    }

    out('\nPer-cluster summary:');
    out('cluster   n   dominantR_med   ratio_med   ratio_min..max   entropy_med   peakShare_med');
    const byCluster = {};
    for (const r of rows) (byCluster[r.cluster] ||= []).push(r);
    for (const c of ['11T', 'Small', 'Mid', 'XL42+']) {
      const rs = byCluster[c] || [];
      if (rs.length === 0) continue;
      const rR = rs.map(r => r.rRatio).sort((a, b) => a - b);
      const drM = rs.map(r => r.dominantR).sort((a, b) => a - b);
      const Hm = rs.map(r => r.entropy).sort((a, b) => a - b);
      const sm = rs.map(r => r.dominantVoteShare).sort((a, b) => a - b);
      const med = (a) => a[Math.floor(a.length / 2)];
      out(
        `${c.padEnd(8)}  ${String(rs.length).padStart(2)}   ` +
        `${String(med(drM)).padStart(4)}            ` +
        `${med(rR).toFixed(2)}        ` +
        `${rR[0].toFixed(2)}..${rR[rR.length-1].toFixed(2)}      ` +
        `${med(Hm).toFixed(2)}          ${med(sm).toFixed(2)}`
      );
    }

    out('\nKey question: do XL42+ rows show dominantR / dominantVoteShare separable from 11T+Small?');
    out('  - If XL42+ ratio_med > Small+11T ratio_max → S1 (radius floor) discriminator viable.');
    out('  - If XL42+ peakShare_med >> other clusters → S2 (concentration) discriminator viable.');
    out('  - If both overlap → smoke kernel is insufficient; v1 must descope to v2 (3D accumulator + Canny pre-filter).');

    expect(true).toBe(true);
  });
});
