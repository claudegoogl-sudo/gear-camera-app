/**
 * PAP-1481 — Option C exploratory probe (bolt-pattern symmetry)
 *
 * Option A (Hough on raw RGBA) is exhausted across smoke / v2a sparse /
 * v2b 3D argmax / v2c annular — all overlap (pap1481_v2_probe_2026-05-14.log).
 *
 * Option C attacks the *structural* signal cog-vs-chainring differ on: N-fold
 * rotational symmetry from spider arms (N∈{4,5}).  For each photo, sample
 * angular signal around several radii within the aim band; compute angular
 * autocorrelation; check if peak lag corresponds to N=4 or N=5 spokes.
 *
 * If XL42+ rows show high N=4/N=5 autocorr peaks while cog rows don't, Option C
 * is viable.  If both clusters overlap, PAP-1481 closes wontfix at the geometric
 * discriminator layer.
 *
 * Run:
 *   HARNESS=pap1481.optC-probe npx jest --config mobile/__tests__/.jest.harness.config.js
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

// Sample gray values around a circle of radius r centred at (cx, cy)
function sampleRing(gray, w, h, cx, cy, r, N) {
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const th = (i / N) * 2 * Math.PI;
    const x = (cx + r * Math.cos(th)) | 0;
    const y = (cy + r * Math.sin(th)) | 0;
    if (x >= 0 && x < w && y >= 0 && y < h) {
      out[i] = gray[y * w + x];
    } else {
      out[i] = 0;
    }
  }
  return out;
}

// Angular autocorrelation: for each lag k in 1..N/2, compute correlation of
// signal with itself shifted by k.  Returns array indexed by lag.
function angularAutocorr(signal) {
  const N = signal.length;
  let mean = 0;
  for (let i = 0; i < N; i++) mean += signal[i];
  mean /= N;
  let variance = 0;
  for (let i = 0; i < N; i++) variance += (signal[i] - mean) ** 2;
  variance /= N;
  if (variance === 0) return new Float32Array(N / 2);
  const ac = new Float32Array(N / 2);
  for (let k = 1; k < N / 2; k++) {
    let s = 0;
    for (let i = 0; i < N; i++) {
      const j = (i + k) % N;
      s += (signal[i] - mean) * (signal[j] - mean);
    }
    ac[k] = s / (N * variance);
  }
  return ac;
}

// For a chainring with N spokes, autocorrelation peaks at lag = totalSamples/N.
// Score: max(ac at lag M/4) and max(ac at lag M/5).
function boltPatternScore(gray, w, h, cx, cy, aimR) {
  const N = 120; // angular sample count (LCM-friendly: 120/4=30, 120/5=24, 120/6=20)
  // Probe multiple radii in the spider/arm zone — chainrings have spokes between
  // the BCD bolt circle and the outer tooth ring.
  const probeRadii = [0.50, 0.60, 0.70, 0.80].map(f => f * aimR);
  let bestScore4 = 0, bestScore5 = 0, bestR4 = 0, bestR5 = 0;
  for (const r of probeRadii) {
    if (r < 10 || r > Math.min(w, h) / 2) continue;
    const ring = sampleRing(gray, w, h, cx, cy, r, N);
    const ac = angularAutocorr(ring);
    // For N-fold symmetry, ac should peak at lag = N_samples/N_fold and its
    // multiples.  Look at lags near 120/4=30 and 120/5=24.
    const peak4 = Math.max(ac[30] || 0, ac[29] || 0, ac[31] || 0);
    const peak5 = Math.max(ac[24] || 0, ac[23] || 0, ac[25] || 0);
    if (peak4 > bestScore4) { bestScore4 = peak4; bestR4 = r; }
    if (peak5 > bestScore5) { bestScore5 = peak5; bestR5 = r; }
  }
  return { score4: bestScore4, score5: bestScore5, r4: bestR4, r5: bestR5 };
}

describe('PAP-1481 Option C probe (bolt-pattern symmetry, n=13)', () => {
  jest.setTimeout(15 * 60 * 1000);
  test('detect 4-fold / 5-fold rotational symmetry on aim-centred rings', () => {
    const TRAINING_DIR = path.resolve(__dirname, '..', '..', 'training-data');
    const rows = [];

    out('\n=== PAP-1481 Option C bolt-pattern probe (n=13) ===');
    out('Method: sample gray on rings at [0.50, 0.60, 0.70, 0.80]×aimR centred at image centre.');
    out('        Compute angular autocorrelation (N=120 samples).  Read peaks at lag=30 (4-fold) and lag=24 (5-fold).');
    out('');
    out('cluster   stamp                          a  W×H        score4   r4    score5   r5    bestScore  bestN');

    for (const [cluster, stamp, actual] of SAMPLE) {
      const photo = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
      if (!fs.existsSync(photo)) continue;
      const { rgba, w, h } = runner.loadOrDecodeRgba(photo, stamp);
      const gray = rgbaToGray(rgba, w, h);
      const cx = (w / 2) | 0; const cy = (h / 2) | 0;
      const aimR = 0.5 * Math.min(w, h);
      const s = boltPatternScore(gray, w, h, cx, cy, aimR);
      const bestScore = Math.max(s.score4, s.score5);
      const bestN = s.score4 >= s.score5 ? 4 : 5;
      out(
        `${cluster.padEnd(7)}   ${stamp}  ${String(actual).padStart(2)} ` +
        `${String(w).padStart(3)}×${String(h).padStart(3)}  ` +
        `${s.score4.toFixed(3)}   ${String(s.r4 | 0).padStart(3)}   ` +
        `${s.score5.toFixed(3)}   ${String(s.r5 | 0).padStart(3)}   ` +
        `${bestScore.toFixed(3)}     ${bestN}`
      );
      rows.push({ cluster, ...s, bestScore, bestN });
    }

    out('\n=== Per-cluster medians ===');
    out('cluster   n   score4_med (range)        score5_med (range)        bestScore_med (range)');
    const byC = {};
    for (const r of rows) (byC[r.cluster] ||= []).push(r);
    const med = (a) => a.slice().sort((x,y) => x-y)[Math.floor(a.length/2)];
    for (const c of ['11T', 'Small', 'Mid', 'XL42+']) {
      const rs = byC[c] || []; if (!rs.length) continue;
      const s4 = rs.map(r => r.score4);
      const s5 = rs.map(r => r.score5);
      const sb = rs.map(r => r.bestScore);
      out(
        `${c.padEnd(8)}  ${String(rs.length).padStart(2)}   ` +
        `${med(s4).toFixed(3)} (${Math.min(...s4).toFixed(3)}-${Math.max(...s4).toFixed(3)})   ` +
        `${med(s5).toFixed(3)} (${Math.min(...s5).toFixed(3)}-${Math.max(...s5).toFixed(3)})   ` +
        `${med(sb).toFixed(3)} (${Math.min(...sb).toFixed(3)}-${Math.max(...sb).toFixed(3)})`
      );
    }

    out('\nSeparability: XL42+ bestScore vs Small+Mid bestScore — disjoint?');
    const xl = (byC['XL42+']||[]).map(r => r.bestScore);
    const others = [...(byC['Small']||[]), ...(byC['Mid']||[])].map(r => r.bestScore);
    const xlMin = Math.min(...xl), xlMax = Math.max(...xl);
    const otMin = Math.min(...others), otMax = Math.max(...others);
    const disjoint = (xlMin > otMax) || (xlMax < otMin);
    out(`  XL42+ [${xlMin.toFixed(3)}, ${xlMax.toFixed(3)}] vs Small+Mid [${otMin.toFixed(3)}, ${otMax.toFixed(3)}] → ${disjoint ? 'DISJOINT (Option C VIABLE)' : 'OVERLAPS'}`);
    expect(true).toBe(true);
  });
});
