/**
 * PAP-1100 — aim-circle prior on FFT peakR sweep range.
 *
 * Calibration sweep over (α, β) ∈ {0.75, 0.80, 0.85, 0.90} × {1.10, 1.15,
 * 1.20, 1.25, 1.30} per QA verdict PAP-1106 (β=1.35 dropped).
 *
 * Stratified harness sub-cluster floors per QA:
 *   - ≥15 PAP-1060 11T cluster (actual==11; conf=0 OR confidently-wrong at HEAD)
 *   - ≥15 XL 42T+ confident-wrong cluster (actual≥42 AND CW at HEAD)
 *   - ≥15 control Mid (actual ∈ [18,28])
 *   - ≥15 control Small (actual ∈ [12,17])
 *
 * Outputs per (α, β) cell: per-cluster N / correct / abstain / CW + per-
 * cluster Wilson 95% LB AND UB on AC1 (recovery rate among PAP-1060 11T +
 * XL 42T+ clusters), plus fft90tc-vs-peakTc agreement % per row.
 *
 * Hard-exit gate (PAP-1091 protocol): if best (α, β) has Wilson 95% UB on
 * AC1 < 80% per-cluster → DESCOPE.  Do NOT iterate (α, β) without a new
 * spec round; file successor under PAP-758.
 *
 * Run:
 *   HARNESS=pap1100.aim-prior npx jest --config mobile/__tests__/.jest.harness.config.js
 *
 * Optional env:
 *   PAP1100_CELLS=0.85,1.20|0.85,1.25  // run a custom subset of (α, β) cells
 *   PAP1100_QUICK=1                    // smoke test: 2 cells × 4 photos
 *   PAP1100_CONTROL_CAP=20             // per-control-cohort sample cap (default 20)
 *   PAP1100_CLUSTER_CAP=25             // per-target-cluster cap (default 25)
 *   PAP1100_BASELINE_REFRESH=1         // ignore cached baseline and recompute
 *   PAP1100_BASELINE_ONLY=1            // compute + cache baseline, then exit
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const path = require('path');
const fs = require('fs');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out } = runner;

const algo = require('../src/algorithm/gearCounter');

// ── Wilson 95% confidence interval ─────────────────────────────────────────
function wilson95(k, n) {
  if (n === 0) return { lb: 0, ub: 1, p: 0 };
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lb: center - half, ub: center + half, p };
}

// ── Cluster definitions ────────────────────────────────────────────────────
// "Recovery" for AC1 = becomes within tolerance under the prior.  At HEAD
// (PAP-1052 audit) the 11T conf=0 cluster is 45 photos and the XL 42T+ CW
// cluster is sourced live by re-running HEAD identity (α=0, β=0 → identity)
// once at startup.
const TRAINING_DIR = path.resolve(__dirname, '..', '..', 'training-data');

function discoverByActual({ minA, maxA, exclude = [] }) {
  if (!fs.existsSync(TRAINING_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(TRAINING_DIR).sort()) {
    if (!f.endsWith('_meta.json')) continue;
    let m;
    try {
      m = JSON.parse(fs.readFileSync(path.join(TRAINING_DIR, f), 'utf8')
        .replace(/[^\x00-\x7F]+/g, '?'));
    } catch { continue; }
    const a = Number(m.actual_tooth_count || m.actualTeethCount || 0);
    if (!a || a < minA || a > maxA) continue;
    if (exclude.includes(a)) continue;
    const stamp = f.replace('_meta.json', '');
    const photo = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
    if (!fs.existsSync(photo)) continue;
    out.push({ stamp, actual: a, photo });
  }
  return out;
}

// Set the prior to identity, run a row, restore prior.
function evalAtIdentity(p) {
  const before = algo.getAimPriorBounds();
  // identity = aimR=0; but the prior reads aimR from caller.  To get a
  // true HEAD baseline we need (α, β) covering the legacy [0, ∞) sweep —
  // use very wide bounds so prior never clips.
  algo.setAimPriorBounds(0.0, 99.0);
  try {
    return runner.evalPhoto({ ...p, applyMask: false });
  } finally {
    algo.setAimPriorBounds(before.alpha, before.beta);
  }
}

function evalAtCell(p, alpha, beta) {
  const before = algo.getAimPriorBounds();
  algo.setAimPriorBounds(alpha, beta);
  try {
    return runner.evalPhoto({ ...p, applyMask: false });
  } finally {
    algo.setAimPriorBounds(before.alpha, before.beta);
  }
}

// ── Cell grid ──────────────────────────────────────────────────────────────
const FULL_GRID = (() => {
  const cells = [];
  for (const a of [0.75, 0.80, 0.85, 0.90]) {
    for (const b of [1.10, 1.15, 1.20, 1.25, 1.30]) cells.push([a, b]);
  }
  return cells;
})();

const QUICK_GRID = [[0.85, 1.20], [0.85, 1.25]];

function parseCells(env) {
  if (!env) return null;
  const cells = [];
  for (const tok of env.split('|')) {
    const [a, b] = tok.split(',').map(Number);
    if (Number.isFinite(a) && Number.isFinite(b)) cells.push([a, b]);
  }
  return cells.length ? cells : null;
}

// ── Driver ─────────────────────────────────────────────────────────────────
describe('PAP-1100 (α, β) calibration sweep', () => {
  jest.setTimeout(180 * 60 * 1000);
  test('sweep + per-cluster Wilson 95% UB on AC1', () => {
    const quick = process.env.PAP1100_QUICK === '1';
    const cells = parseCells(process.env.PAP1100_CELLS)
      || (quick ? QUICK_GRID : FULL_GRID);

    out('\n=== PAP-1100 calibration sweep ===');
    out(`Cells: ${cells.length} | grid: ${cells.map(c => `(${c[0]},${c[1]})`).join(' ')}`);

    // Discover cohorts.
    const elevenT = discoverByActual({ minA: 11, maxA: 11 });
    const xlAll   = discoverByActual({ minA: 42, maxA: 60 });
    const midAll  = discoverByActual({ minA: 18, maxA: 28 });
    const smallAll = discoverByActual({ minA: 12, maxA: 17 });

    if (quick) {
      // Smoke: 2 cells × 1 photo from each cohort = 4 photos × 2 cells = 8 evals
      const sample = [
        elevenT[0], xlAll[0], midAll[0], smallAll[0],
      ].filter(Boolean);
      out(`SMOKE mode: 1 photo per cohort (${sample.length}); ${cells.length} cells`);
      for (const [a, b] of cells) {
        out(`\n--- cell α=${a} β=${b} ---`);
        for (const p of sample) {
          const r = evalAtCell(p, a, b);
          out(`  ${p.stamp} act=${p.actual} → tc=${r.tc} conf=${r.conf.toFixed(2)} peakR=${r.peakR} fft90=${r.fft90} agree=${r.peakTc === r.fft90 ? 'Y' : 'N'} ${r.runtime}ms`);
        }
      }
      return;
    }

    // ── Baseline cache (per HEAD SHA) ───────────────────────────────────
    const CACHE_DIR = path.resolve(__dirname, '..', '..', '.cache');
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const headSha = (() => {
      try { return require('child_process').execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().slice(0, 12); }
      catch { return 'unknown'; }
    })();
    const cachePath = path.join(CACHE_DIR, `pap1100-baseline-${headSha}.json`);
    const refresh = process.env.PAP1100_BASELINE_REFRESH === '1';

    const baseline = new Map(); // stamp → { abstain, confidentWrong, correct, tc, conf }
    let usedCache = false;
    if (!refresh && fs.existsSync(cachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        for (const k of Object.keys(cached)) baseline.set(k, cached[k]);
        usedCache = true;
        out(`\nStep 1: BASELINE CACHE HIT (${baseline.size} rows, sha=${headSha})`);
      } catch (e) { out(`baseline cache read error: ${e.message}`); }
    }

    // Pre-sample controls deterministically before baseline to bound work.
    const CLUSTER_CAP = Number(process.env.PAP1100_CLUSTER_CAP || 25);
    const CONTROL_CAP = Number(process.env.PAP1100_CONTROL_CAP || 20);
    const midControl   = midAll.slice(0, CONTROL_CAP);
    const smallControl = smallAll.slice(0, CONTROL_CAP);

    // Allow resumable baseline (write incrementally, skip already-cached stamps).
    const writeBaselineCache = () => {
      const obj = {}; baseline.forEach((v, k) => { obj[k] = v; });
      fs.writeFileSync(cachePath + '.tmp', JSON.stringify(obj));
      fs.renameSync(cachePath + '.tmp', cachePath);
    };

    {
      const baselineSet = [...elevenT, ...xlAll, ...midControl, ...smallControl];
      const remaining = baselineSet.filter(p => !baseline.has(p.stamp));
      if (remaining.length) {
        out(`\nStep 1: HEAD baseline — ${baselineSet.length - remaining.length}/${baselineSet.length} cached, computing ${remaining.length}`);
        const t0 = Date.now();
        let i = 0;
        for (const p of remaining) {
          const r = evalAtIdentity(p);
          baseline.set(p.stamp, {
            abstain: r.abstain, confidentWrong: r.confidentWrong, correct: r.correct,
            tc: r.tc, conf: r.conf, actual: p.actual,
          });
          if (++i % 10 === 0) {
            writeBaselineCache();
            out(`  baseline [${i}/${remaining.length}] ${((Date.now()-t0)/1000).toFixed(0)}s (saved)`);
          }
        }
        writeBaselineCache();
        out(`  baseline saved → ${path.relative(process.cwd(), cachePath)} (${((Date.now()-t0)/1000).toFixed(0)}s)`);
      }
    }

    // ── Partition + sub-sample target clusters (deterministic file order) ─
    const eleven11Cluster = elevenT.filter(p => {
      const b = baseline.get(p.stamp);
      return b && (b.abstain || b.confidentWrong);
    }).slice(0, CLUSTER_CAP);
    const xlCwCluster = xlAll.filter(p => {
      const b = baseline.get(p.stamp);
      return b && b.confidentWrong;
    }).slice(0, CLUSTER_CAP);

    out(`  PAP-1060 11T cluster: ${eleven11Cluster.length} (target ≥15)`);
    out(`  XL 42T+ CW cluster:   ${xlCwCluster.length} (target ≥15)`);
    out(`  Mid control:           ${midControl.length} (target ≥15)`);
    out(`  Small control:         ${smallControl.length} (target ≥15)`);

    if (eleven11Cluster.length < 15 || xlCwCluster.length < 15
        || midControl.length < 15 || smallControl.length < 15) {
      out('\n[WARN] sub-cluster floors not met — sweep results below are advisory only');
    }

    if (process.env.PAP1100_BASELINE_ONLY === '1') {
      out('\n[BASELINE_ONLY] exiting before cell sweep');
      return;
    }

    // Step 2: per-cell sweep across all cohorts (with per-cell result cache).
    const cellsCachePath = path.join(CACHE_DIR, `pap1100-cells-${headSha}.json`);
    const cellsCache = (() => {
      if (fs.existsSync(cellsCachePath)) {
        try { return JSON.parse(fs.readFileSync(cellsCachePath, 'utf8')); }
        catch { return {}; }
      }
      return {};
    })();

    out('\nStep 2: (α, β) sweep');
    const results = []; // { alpha, beta, cohorts: { ... } }
    const evalCohort = (rows, alpha, beta) => {
      let recovered = 0, lostVsBaseline = 0, abstain = 0, cw = 0, fft90Agree = 0;
      for (const p of rows) {
        const r = evalAtCell(p, alpha, beta);
        if (r.correct) recovered++;
        else if (r.abstain) abstain++;
        else { cw++; }
        const base = baseline.get(p.stamp);
        if (base && base.correct && !r.correct) lostVsBaseline++;
        if (r.peakTc === r.fft90) fft90Agree++;
      }
      return { N: rows.length, recovered, abstain, cw, lostVsBaseline, fft90Agree };
    };

    for (const [alpha, beta] of cells) {
      const key = `${alpha}|${beta}`;
      let entry = cellsCache[key];
      if (entry && !process.env.PAP1100_CELL_REFRESH) {
        const w11 = wilson95(entry.c11.recovered, entry.c11.N);
        const wxl = wilson95(entry.cxl.recovered, entry.cxl.N);
        results.push({ alpha, beta, ...entry, w11, wxl });
        out(`  α=${alpha} β=${beta}  [cache] 11T=${entry.c11.recovered}/${entry.c11.N} XL=${entry.cxl.recovered}/${entry.cxl.N} Mid_LOSS=${entry.cmid.lostVsBaseline} Sm_LOSS=${entry.csm.lostVsBaseline}`);
        continue;
      }
      const t0 = Date.now();
      const c11   = evalCohort(eleven11Cluster, alpha, beta);
      const cxl   = evalCohort(xlCwCluster,    alpha, beta);
      const cmid  = evalCohort(midControl,     alpha, beta);
      const csm   = evalCohort(smallControl,   alpha, beta);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const w11 = wilson95(c11.recovered, c11.N);
      const wxl = wilson95(cxl.recovered, cxl.N);
      entry = { c11, cxl, cmid, csm };
      cellsCache[key] = entry;
      fs.writeFileSync(cellsCachePath, JSON.stringify(cellsCache));
      results.push({ alpha, beta, c11, cxl, cmid, csm, w11, wxl });
      out(
        `  α=${alpha} β=${beta}  11T_rec=${c11.recovered}/${c11.N} ` +
        `(LB=${(w11.lb*100).toFixed(1)}% UB=${(w11.ub*100).toFixed(1)}%)  ` +
        `XL_rec=${cxl.recovered}/${cxl.N} (LB=${(wxl.lb*100).toFixed(1)}% UB=${(wxl.ub*100).toFixed(1)}%)  ` +
        `Mid_LOSS=${cmid.lostVsBaseline}  Sm_LOSS=${csm.lostVsBaseline}  ${elapsed}s`
      );
    }

    // Skip ranking if we're a partial chunk (results may be empty for unrun cells)
    if (results.length < cells.length) {
      // Compose ranking from full cellsCache
      results.length = 0;
      for (const k of Object.keys(cellsCache)) {
        const [a, b] = k.split('|').map(Number);
        const e = cellsCache[k];
        results.push({ alpha: a, beta: b, ...e,
          w11: wilson95(e.c11.recovered, e.c11.N),
          wxl: wilson95(e.cxl.recovered, e.cxl.N) });
      }
      out(`\n[chunk] aggregated ${results.length} cell(s) from cache`);
    }
    if (results.length === 0) { out('\nno cells run yet'); return; }

    // Step 3: rank by AC1 (best per-cluster Wilson 95% UB sum).
    out('\nStep 3: ranking by min(11T_UB, XL_UB) descending');
    const ranked = results.slice().sort((a, b) =>
      Math.min(b.w11.ub, b.wxl.ub) - Math.min(a.w11.ub, a.wxl.ub),
    );
    out('rank  α    β    11T_p%   11T_UB%  XL_p%    XL_UB%   Mid_LOSS  Sm_LOSS');
    for (let i = 0; i < ranked.length; i++) {
      const r = ranked[i];
      out(
        `  ${String(i+1).padStart(2)}  ${r.alpha.toFixed(2)}  ${r.beta.toFixed(2)}  ` +
        `${(r.w11.p*100).toFixed(1).padStart(5)}    ${(r.w11.ub*100).toFixed(1).padStart(5)}    ` +
        `${(r.wxl.p*100).toFixed(1).padStart(5)}    ${(r.wxl.ub*100).toFixed(1).padStart(5)}    ` +
        `${String(r.cmid.lostVsBaseline).padStart(7)}  ${String(r.csm.lostVsBaseline).padStart(7)}`
      );
    }

    // Step 4: AC1 hard-exit gate (PAP-1091).
    const best = ranked[0];
    out(`\nBest cell: α=${best.alpha} β=${best.beta}`);
    out(`  AC1 11T Wilson UB: ${(best.w11.ub*100).toFixed(1)}% (target ≥80%)`);
    out(`  AC1 XL  Wilson UB: ${(best.wxl.ub*100).toFixed(1)}% (target ≥80%)`);
    const ac1Pass = (best.w11.ub >= 0.80) && (best.wxl.ub >= 0.80);
    if (!ac1Pass) {
      out('\n[HARD-EXIT] PAP-1091 protocol: best (α, β) does NOT meet per-cluster Wilson 95% UB ≥80% — DESCOPE.');
      out('AE: do NOT run AC2 305-sweep.  File successor under PAP-758.');
    } else {
      out('\n[AC1 PASS] proceed to AC2 (pap760+pap796+pap939+pap1052 305-photo 0-LOSS sweep) at (α, β) = (' +
          `${best.alpha}, ${best.beta}).`);
    }

    expect(true).toBe(true);
  });
});
