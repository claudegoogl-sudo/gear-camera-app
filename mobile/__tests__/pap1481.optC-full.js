/**
 * PAP-1481 — Option C full-cohort distribution scan (n=145)
 *
 * The n=13 exploratory probe (pap1481.optC-probe.js) showed `bestN===4 AND
 * score4>0.18` fires on 3/4 XL42+ and 0/9 cog rows.  This scan runs the same
 * bolt-pattern detector on the full 145-row cached baseline and sweeps the
 * (τ4, τ5) predicate grid to find an operating point that meets:
 *
 *   AC1 candidate:  Wilson 95% UB on XL42+ hit rate ≥ 80%
 *   AC2 candidate:  zero FP on currently-correct Small + 11T + Mid rows
 *                   (abstain on a correct row = LOSS in production)
 *
 * Predicate: (bestN==4 AND score4>τ4) OR (bestN==5 AND score5>τ5)
 *
 * Run:
 *   HARNESS=pap1481.optC-full npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const path = require('path');
const fs = require('fs');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out } = runner;

const CACHE = path.resolve(__dirname, '..', '..', '.cache', 'pap1481-baseline-d321c3d62aa3.json');
const TRAINING_DIR = path.resolve(__dirname, '..', '..', 'training-data');

function rgbaToGray(rgba, w, h) {
  const len = w * h;
  const g = new Uint8Array(len);
  for (let i = 0, j = 0; i < len; i++, j += 4) {
    g[i] = (rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114) | 0;
  }
  return g;
}

function sampleRing(gray, w, h, cx, cy, r, N) {
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const th = (i / N) * 2 * Math.PI;
    const x = (cx + r * Math.cos(th)) | 0;
    const y = (cy + r * Math.sin(th)) | 0;
    if (x >= 0 && x < w && y >= 0 && y < h) out[i] = gray[y * w + x];
  }
  return out;
}

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

function boltPattern(gray, w, h, cx, cy, aimR) {
  const N = 120;
  const probeRadii = [0.50, 0.60, 0.70, 0.80].map(f => f * aimR);
  let bestS4 = 0, bestS5 = 0;
  for (const r of probeRadii) {
    if (r < 10 || r > Math.min(w, h) / 2) continue;
    const ring = sampleRing(gray, w, h, cx, cy, r, N);
    const ac = angularAutocorr(ring);
    bestS4 = Math.max(bestS4, ac[30] || 0, ac[29] || 0, ac[31] || 0);
    bestS5 = Math.max(bestS5, ac[24] || 0, ac[23] || 0, ac[25] || 0);
  }
  return { score4: bestS4, score5: bestS5 };
}

function wilson(k, n) {
  if (n === 0) return { lb: 0, ub: 0 };
  const z = 1.96;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z / den) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lb: centre - half, ub: centre + half };
}

function cluster(a) {
  if (a === 11) return '11T';
  if (a >= 42) return 'XL42+';
  if (a >= 20) return 'Mid';
  return 'Small';
}

describe('PAP-1481 Option C full-cohort scan (n=145)', () => {
  jest.setTimeout(20 * 60 * 1000);
  test('predicate (τ4, τ5) sweep against XL42+ AC1 / cog AC2', () => {
    const baseline = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    const rows = [];
    let i = 0, total = Object.keys(baseline).length;

    out(`\n=== PAP-1481 Option C full-cohort scan (n=${total}) ===`);
    out('Scoring all rows with bolt-pattern detector...');

    for (const [stamp, b] of Object.entries(baseline)) {
      i++;
      if (!b || typeof b.actual !== 'number') continue;
      const photo = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
      if (!fs.existsSync(photo)) continue;
      const { rgba, w, h } = runner.loadOrDecodeRgba(photo, stamp);
      const gray = rgbaToGray(rgba, w, h);
      const cx = (w / 2) | 0; const cy = (h / 2) | 0;
      const aimR = b.aimR || 0.5 * Math.min(w, h);
      const s = boltPattern(gray, w, h, cx, cy, aimR);
      rows.push({
        stamp, actual: b.actual, cluster: cluster(b.actual),
        correct: !!b.correct, confidentWrong: !!b.confidentWrong,
        ...s,
        bestN: s.score4 >= s.score5 ? 4 : 5,
        bestScore: Math.max(s.score4, s.score5),
      });
    }

    out(`Scored ${rows.length}/${total} rows.`);

    // Per-cluster summary
    const byC = {};
    for (const r of rows) (byC[r.cluster] ||= []).push(r);

    out('\nPer-cluster summary (score4, score5):');
    out('cluster   n   score4_med (range)        score5_med (range)        4-fold_count  5-fold_count');
    const med = (a) => a.slice().sort((x,y) => x-y)[Math.floor(a.length/2)];
    for (const c of ['11T', 'Small', 'Mid', 'XL42+']) {
      const rs = byC[c] || []; if (!rs.length) continue;
      const s4 = rs.map(r => r.score4);
      const s5 = rs.map(r => r.score5);
      const n4 = rs.filter(r => r.bestN === 4).length;
      const n5 = rs.filter(r => r.bestN === 5).length;
      out(
        `${c.padEnd(8)}  ${String(rs.length).padStart(2)}   ` +
        `${med(s4).toFixed(3)} (${Math.min(...s4).toFixed(3)}-${Math.max(...s4).toFixed(3)})   ` +
        `${med(s5).toFixed(3)} (${Math.min(...s5).toFixed(3)}-${Math.max(...s5).toFixed(3)})   ` +
        `${String(n4).padStart(3)}           ${String(n5).padStart(3)}`
      );
    }

    // Predicate sweep — (bestN==4 AND score4>τ4) OR (bestN==5 AND score5>τ5)
    out('\nPredicate sweep — (bestN==4 ∧ score4>τ4) OR (bestN==5 ∧ score5>τ5):');
    out('              AC1 = fires on XL42+ rows (chainring detection)');
    out('              AC2 = fires on currently-correct {Small,11T,Mid} rows (= LOSS)');
    out('              We want AC1 Wilson UB ≥ 80% AND AC2 = 0');
    out('');
    out('τ4    τ5      XL_hit/n_XL    XL_W95UB    cog_FP/n_correct_cog    cog_FP_W95UB    verdict');
    const tau4Grid = [0.10, 0.12, 0.14, 0.16, 0.18, 0.20, 0.22];
    const tau5Grid = [0.10, 0.15, 0.18, 0.20, 0.22, 0.25, 0.30];
    const xl = (byC['XL42+'] || []);
    const correctCogs = [...(byC['11T']||[]), ...(byC['Small']||[]), ...(byC['Mid']||[])].filter(r => r.correct);
    const bestCells = [];
    for (const t4 of tau4Grid) for (const t5 of tau5Grid) {
      const fires = (r) => (r.bestN === 4 && r.score4 > t4) || (r.bestN === 5 && r.score5 > t5);
      const xlHit = xl.filter(fires).length;
      const xlW = wilson(xlHit, xl.length);
      const fpHit = correctCogs.filter(fires).length;
      const fpW = wilson(fpHit, correctCogs.length);
      const verdict = (xlW.ub >= 0.80 && fpHit === 0) ? 'PASS' : (fpHit === 0 ? '~  ' : 'FAIL_cog');
      if (verdict === 'PASS' || (fpHit === 0 && xlW.ub >= 0.70)) {
        out(
          `${t4.toFixed(2)}  ${t5.toFixed(2)}    ${String(xlHit).padStart(2)}/${String(xl.length).padStart(2)}        ` +
          `${(xlW.ub*100).toFixed(1).padStart(5)}%       ${String(fpHit).padStart(2)}/${String(correctCogs.length).padStart(2)}                  ` +
          `${(fpW.ub*100).toFixed(1).padStart(5)}%         ${verdict}`
        );
        if (verdict === 'PASS') bestCells.push({ t4, t5, xlHit, n: xl.length, xlUB: xlW.ub, fpHit, fpUB: fpW.ub });
      }
    }
    if (bestCells.length === 0) {
      out('\n  No (τ4, τ5) cell meets AC1 W95UB ≥ 80% AND AC2=0 simultaneously.');
      out('  → Honest verdict: Option C predicate as-formulated CANNOT close PAP-1481 at the AC1 bar.');
      out('  Need either:');
      out('  (i)   relax AC1 bar (probably out of scope per PAP-1091 precedent)');
      out('  (ii)  enrich Option C signal (add radial-mean-gradient sharpness, BCD-circle locator, gradient-vs-grey-only check)');
      out('  (iii) escalate to Option B (operator-aim authoritative) under fresh subtask');
      out('  (iv)  close PAP-1481 wontfix at the geometric-discriminator layer.');
    } else {
      out(`\n  ${bestCells.length} cell(s) PASS both AC1 and AC2.  Best AC1 cell:`);
      const best = bestCells.sort((a,b) => b.xlUB - a.xlUB)[0];
      out(`  τ4=${best.t4}  τ5=${best.t5}  →  XL ${best.xlHit}/${best.n} (UB ${(best.xlUB*100).toFixed(1)}%)  cog 0 FP`);
    }

    // Also dump the XL42+ rows that score4 or score5 BELOW any threshold candidate
    out('\nXL42+ rows with LOW bolt-pattern score (potential AC1 misses):');
    out('stamp                          actual  correct  confidentWrong  bestN  score4   score5');
    const xlSorted = xl.slice().sort((a, b) => a.bestScore - b.bestScore);
    for (const r of xlSorted.slice(0, 12)) {
      out(
        `${r.stamp}  ${String(r.actual).padStart(3)}T   ` +
        `${r.correct ? 'YES' : 'no '}      ${r.confidentWrong ? 'YES' : 'no '}             ` +
        `${r.bestN}     ${r.score4.toFixed(3)}    ${r.score5.toFixed(3)}`
      );
    }

    expect(true).toBe(true);
  });
});
