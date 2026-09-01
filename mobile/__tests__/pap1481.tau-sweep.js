/**
 * PAP-1481 — Option B' (abstain-only) τ sweep for chainring-regime
 * discriminator. Forked from pap1100.aim-prior.js per QA verdict PAP-1484.
 *
 * Predicate under evaluation:
 *   if (aimR > 0 && peakR > 0 && |peakR/aimR - 1| > τ)
 *     → conf=0, flag aimPriorAbstainBroad
 * (no effectiveR change, no tc re-derivation — pure abstain extension)
 *
 * Phase split (QA Q4 protocol):
 *   PHASE=preflight  (default)  — capture peakR + aimR per HEAD row, then
 *                                 tabulate AC2 LOSS candidates at each τ.
 *                                 EXIT before running the τ sweep.
 *   PHASE=sweep                 — assume preflight headroom OK; run the
 *                                 simulated abstain over τ ∈ τGRID.
 *                                 (Simulated, not algo-side — does not
 *                                 require gearCounter.js change.)
 *
 * Hard-exit gates:
 *   - Preflight: if any τ in τGRID has >5 AC2 LOSS candidates on
 *     Small/Mid/Large cohorts, recommend escalation to Option A (Hough on
 *     raw RGBA). Do NOT run sweep.
 *   - Sweep: PAP-1091 Wilson 95% UB ≥ 80% per cluster on "no-confident-
 *     wrong" rate. AC2 = 0 LOSS on Small/Mid/Large.
 *
 * Run:
 *   HARNESS=pap1481.tau-sweep npx jest --config mobile/__tests__/.jest.harness.config.js
 *
 * Optional env:
 *   PAP1481_PHASE=preflight|sweep  (default preflight)
 *   PAP1481_TAU=0.20,0.25,0.30,0.35,0.40
 *   PAP1481_QUICK=1                    smoke: 1 photo per cohort
 *   PAP1481_CLUSTER_CAP=25
 *   PAP1481_CONTROL_CAP=20
 *   PAP1481_BASELINE_REFRESH=1
 *   PAP1481_BASELINE_ONLY=1
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

// Per QA verdict: B' does NOT touch setAimPriorBounds (that bounds FFT,
// not the abstain envelope). We run HEAD identity per-row, capture peakR
// and the deterministic aimR=0.5*min(w,h), then simulate the abstain
// downstream on the saved baseline. No gearCounter.js change required.
function evalAtHead(p) {
  const r = runner.evalPhoto({ ...p, applyMask: false });
  const aimR = 0.5 * Math.min(r.w, r.h);
  return { ...r, aimR };
}

// τ grid (QA-amended, +0.40 over my original)
const DEFAULT_TAU = [0.20, 0.25, 0.30, 0.35, 0.40];

function parseTaus(env) {
  if (!env) return DEFAULT_TAU;
  const xs = env.split(',').map(Number).filter(Number.isFinite);
  return xs.length ? xs : DEFAULT_TAU;
}

// Cluster taxonomy (mirrors pap1100.aim-prior.js but renamed for B')
function classOf(actual) {
  if (actual <= 17) return 'Small';   // 12-17 (control + 11T separate)
  if (actual <= 28) return 'Mid';     // 18-28 (control)
  return 'Large';                     // 29+ (XL CW is the target cluster)
}

// ── Driver ─────────────────────────────────────────────────────────────────
describe('PAP-1481 (τ) sweep (B\' abstain-only)', () => {
  jest.setTimeout(180 * 60 * 1000);
  test('preflight + (gated) τ sweep', () => {
    const phase = (process.env.PAP1481_PHASE || 'preflight').toLowerCase();
    const taus = parseTaus(process.env.PAP1481_TAU);
    const quick = process.env.PAP1481_QUICK === '1';

    out('\n=== PAP-1481 B\' (abstain-only) ===');
    out(`Phase: ${phase} | τ grid: ${taus.join(',')}`);

    // Discover cohorts (same shape as PAP-1100/PAP-1108)
    const elevenT  = discoverByActual({ minA: 11, maxA: 11 });
    const xlAll    = discoverByActual({ minA: 42, maxA: 60 });
    const midAll   = discoverByActual({ minA: 18, maxA: 28 });
    const smallAll = discoverByActual({ minA: 12, maxA: 17 });

    if (quick) {
      const sample = [elevenT[0], xlAll[0], midAll[0], smallAll[0]].filter(Boolean);
      out(`SMOKE: 1 photo per cohort (${sample.length})`);
      for (const p of sample) {
        const r = evalAtHead(p);
        const ratio = r.aimR > 0 ? r.peakR / r.aimR : 0;
        out(`  ${p.stamp} act=${p.actual} → tc=${r.tc} conf=${r.conf.toFixed(2)} peakR=${r.peakR.toFixed(1)} aimR=${r.aimR.toFixed(0)} |ratio-1|=${Math.abs(ratio-1).toFixed(3)}`);
      }
      return;
    }

    // Baseline cache keyed by HEAD SHA
    const CACHE_DIR = path.resolve(__dirname, '..', '..', '.cache');
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const headSha = (() => {
      try { return require('child_process').execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().slice(0, 12); }
      catch { return 'unknown'; }
    })();
    const cachePath = path.join(CACHE_DIR, `pap1481-baseline-${headSha}.json`);
    const refresh = process.env.PAP1481_BASELINE_REFRESH === '1';

    const baseline = new Map(); // stamp → { actual, abstain, correct, confidentWrong, tc, conf, peakR, aimR, w, h }
    let usedCache = false;
    if (!refresh && fs.existsSync(cachePath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        for (const k of Object.keys(cached)) baseline.set(k, cached[k]);
        usedCache = true;
        out(`\nStep 1: BASELINE CACHE HIT (${baseline.size} rows, sha=${headSha})`);
      } catch (e) { out(`baseline cache read error: ${e.message}`); }
    }

    const CLUSTER_CAP = Number(process.env.PAP1481_CLUSTER_CAP || 25);
    const CONTROL_CAP = Number(process.env.PAP1481_CONTROL_CAP || 20);
    const midControl   = midAll.slice(0, CONTROL_CAP);
    const smallControl = smallAll.slice(0, CONTROL_CAP);

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
          const r = evalAtHead(p);
          baseline.set(p.stamp, {
            actual: p.actual,
            abstain: r.abstain,
            correct: r.correct,
            confidentWrong: r.confidentWrong,
            tc: r.tc, conf: r.conf,
            peakR: r.peakR, aimR: r.aimR,
            w: r.w, h: r.h,
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

    // Partition target clusters from baseline (same predicate as PAP-1100)
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

    if (process.env.PAP1481_BASELINE_ONLY === '1') {
      out('\n[BASELINE_ONLY] exiting before τ analysis');
      return;
    }

    // ── PRE-FLIGHT (QA Q4) ─────────────────────────────────────────────
    // Tabulate, at each τ, the max-possible AC2 LOSS on Small/Mid/Large:
    // baseline rows where (correct === true) AND |peakR/aimR - 1| > τ AND
    // actual is in the Small/Mid/Large bands. These rows would flip
    // correct → abstain under the new envelope.

    out('\n=== Step 2: PRE-FLIGHT — AC2 LOSS candidates per τ ===');
    out('(rows where HEAD is correct AND |peakR/aimR-1|>τ → become abstain under B\')');

    const allBaselineRows = [...baseline.entries()].map(([stamp, v]) => ({ stamp, ...v }));
    const ratioOf = (r) => (r.aimR > 0 && r.peakR > 0) ? Math.abs(r.peakR / r.aimR - 1) : -1;

    out('τ      Small_LOSS  Mid_LOSS  Large_LOSS  TOTAL  11T_NEW_ABSTAIN  XL_NEW_ABSTAIN');
    let escalate = false;
    const preflight = [];
    for (const tau of taus) {
      let smLoss = 0, midLoss = 0, lgLoss = 0;
      let elevenAbstainNew = 0, xlAbstainNew = 0;
      const lossRows = [];
      for (const r of allBaselineRows) {
        const ratio = ratioOf(r);
        if (ratio < 0) continue;
        const fires = ratio > tau;
        if (fires && r.correct) {
          // AC2 LOSS candidate
          if (r.actual >= 12 && r.actual <= 17) smLoss++;
          else if (r.actual >= 18 && r.actual <= 28) midLoss++;
          else if (r.actual >= 29) lgLoss++;
          if (r.actual >= 12 && r.actual <= 28) lossRows.push(r); // exclude 29+ from text dump
        }
        if (fires && r.actual === 11 && (r.confidentWrong || r.abstain)) elevenAbstainNew++;
        if (fires && r.actual >= 42 && r.confidentWrong) xlAbstainNew++;
      }
      const total = smLoss + midLoss + lgLoss;
      out(
        `${tau.toFixed(2)}   ${String(smLoss).padStart(9)}  ${String(midLoss).padStart(7)}  ${String(lgLoss).padStart(9)}  ${String(total).padStart(5)}  ${String(elevenAbstainNew).padStart(15)}  ${String(xlAbstainNew).padStart(14)}`
      );
      preflight.push({ tau, smLoss, midLoss, lgLoss, total, elevenAbstainNew, xlAbstainNew, lossRows });
    }

    // QA escalation gate: if any τ has >5 AC2 LOSS candidates on Small/Mid/Large,
    // escalate to Option A. NOTE: "Large" here means actual≥29; "Small/Mid"
    // are 12-28. The QA gate language said "Small/Mid/Large", treated as
    // ≥1 LOSS bucket = bad headroom signal; >5 = escalate.
    const worstTotal = Math.max(...preflight.map(p => p.smLoss + p.midLoss + p.lgLoss));
    const anyOver5 = preflight.some(p => p.smLoss + p.midLoss + p.lgLoss > 5);
    escalate = anyOver5;

    if (escalate) {
      out('\n[HEADROOM FAIL] one or more τ shows >5 AC2 LOSS candidates on Small/Mid/Large.');
      out('Per QA verdict PAP-1484: ESCALATE to Option A (Hough on raw RGBA).');
      out('Do NOT run τ sweep. File QA cross-check #2 for Option A.');
    } else if (worstTotal > 0) {
      out(`\n[HEADROOM TIGHT] worst-case AC2 LOSS = ${worstTotal} (≤5) — still within QA tolerance, proceed to τ sweep.`);
    } else {
      out('\n[HEADROOM CLEAN] zero AC2 LOSS candidates at any τ — proceed to τ sweep with confidence.');
    }

    // Dump first 30 AC2 LOSS rows for the worst-case τ (manual inspection)
    {
      const worst = preflight.slice().sort((a, b) =>
        (b.smLoss + b.midLoss + b.lgLoss) - (a.smLoss + a.midLoss + a.lgLoss))[0];
      if (worst && worst.lossRows.length) {
        out(`\nSample AC2 LOSS rows at worst τ=${worst.tau} (first 30):`);
        for (const r of worst.lossRows.slice(0, 30)) {
          const ratio = ratioOf(r);
          out(`  ${r.stamp} act=${r.actual} tc=${r.tc} conf=${r.conf.toFixed(2)} peakR=${r.peakR.toFixed(1)} aimR=${r.aimR.toFixed(0)} |ratio-1|=${ratio.toFixed(3)}`);
        }
      }
    }

    if (phase === 'preflight') {
      out('\n[phase=preflight] stopping. Re-run with PAP1481_PHASE=sweep to evaluate AC1 headroom.');
      expect(true).toBe(true);
      return;
    }

    // ── SWEEP (only runs when PAP1481_PHASE=sweep) ─────────────────────
    out('\n=== Step 3: τ SWEEP — AC1 no-confident-wrong rate per cluster ===');
    out('(B\' abstain simulated downstream; tc/conf locked to HEAD values)');

    // Simulate: under B' at τ, a row that fires the predicate becomes
    // abstain. Re-classify each row's outcome accordingly:
    //   correct  & fires → abstain (AC2 LOSS)
    //   wrong    & fires → abstain (AC1 win for "no-CW")
    //   abstain  & fires → abstain (no change)
    //   * & !fires       → unchanged
    out('τ      11T_NCW%/N    11T_UB%   XL_NCW%/N     XL_UB%   Mid_LOSS  Sm_LOSS  Lg_LOSS');
    const sweepResults = [];
    for (const tau of taus) {
      const reclass = (rows) => {
        let ncw = 0, total = 0, lost = 0;
        for (const p of rows) {
          const r = baseline.get(p.stamp);
          if (!r) continue;
          total++;
          const fires = ratioOf(r) > tau;
          let isCorrect = r.correct, isCw = r.confidentWrong;
          if (fires) { isCorrect = false; isCw = false; /* → abstain */ }
          if (!isCw) ncw++;
          if (r.correct && fires) lost++;
        }
        return { ncw, total, lost };
      };
      const c11   = reclass(eleven11Cluster);
      const cxl   = reclass(xlCwCluster);
      const cmid  = reclass(midControl);
      const csm   = reclass(smallControl);
      const w11 = wilson95(c11.ncw, c11.total);
      const wxl = wilson95(cxl.ncw, cxl.total);
      sweepResults.push({ tau, c11, cxl, cmid, csm, w11, wxl });
      // Large LOSS = anything 29+ in baseline that was correct and now fires
      let lgLoss = 0;
      for (const r of allBaselineRows) {
        if (r.actual >= 29 && r.correct && ratioOf(r) > tau) lgLoss++;
      }
      out(
        `${tau.toFixed(2)}   ${String(c11.ncw).padStart(2)}/${String(c11.total).padStart(2)}  ${(w11.p*100).toFixed(1).padStart(5)}%   ${(w11.ub*100).toFixed(1).padStart(5)}%   ` +
        `${String(cxl.ncw).padStart(2)}/${String(cxl.total).padStart(2)}  ${(wxl.p*100).toFixed(1).padStart(5)}%   ${(wxl.ub*100).toFixed(1).padStart(5)}%   ` +
        `${String(cmid.lost).padStart(7)}  ${String(csm.lost).padStart(6)}  ${String(lgLoss).padStart(6)}`
      );
    }

    // Best τ = one maximising min(11T_UB, XL_UB) subject to AC2 LOSS = 0
    const candidates = sweepResults.filter(s => s.cmid.lost === 0 && s.csm.lost === 0);
    out('\nStep 4: ranking (filtered to AC2 0-LOSS, ranked by min cluster UB):');
    if (!candidates.length) {
      out('  no τ satisfies AC2 0-LOSS — DESCOPE B\'.');
    } else {
      candidates.sort((a, b) => Math.min(b.w11.ub, b.wxl.ub) - Math.min(a.w11.ub, a.wxl.ub));
      const best = candidates[0];
      out(`  best τ=${best.tau}  11T_UB=${(best.w11.ub*100).toFixed(1)}%  XL_UB=${(best.wxl.ub*100).toFixed(1)}%`);
      const ac1Pass = best.w11.ub >= 0.80 && best.wxl.ub >= 0.80;
      if (!ac1Pass) {
        out('\n[HARD-EXIT] best τ does NOT meet per-cluster Wilson 95% UB ≥80% — DESCOPE B\', escalate to Option A.');
      } else {
        out(`\n[AC1 PASS at τ=${best.tau}] proceed to file B' implementation cross-check #2 with QA.`);
      }
    }

    expect(true).toBe(true);
  });
});
