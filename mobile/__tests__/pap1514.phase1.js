/**
 * PAP-1514 — Phase-1 calibration sweep (6912 cells) for spec v6.1 §4.1.
 *
 * Pre-flight gate: PAP-1511 verdict on `pap1485_preflight_v6_2026-05-16.*` at
 * HEAD `6e2cfb4` was PASS (Pass A 0 broken, Pass B per-bucket caps all PASS).
 * Greenlight to run this sweep.
 *
 * Grid (per v6.1 §4.1 table):
 *   R_lo/aimR  ∈ {0.35, 0.40, 0.45}                   (3)
 *   R_hi/aimR  ∈ {1.05, 1.10, 1.15}                   (3)
 *   σ_R/aimR   ∈ {0.15, 0.20, 0.25, 0.30}             (4)  — A1
 *   ε_abs      ∈ {0.015, 0.020, 0.025, 0.030}         (4)
 *   ε_floor    ∈ {0.06, 0.08, 0.10}                   (3)
 *   extreme_R_abstain ∈ {off, on}                     (2)  — A4
 *   γ_bc (v4 B2)      ∈ {1.0, 1.3, 1.6, 2.0}          (4)
 *   option_beta (v6 C5) ∈ {off, on}                   (2)
 *   Total = 3·3·4·4·3·2·4·2 = 6912 cells.
 *
 * AC1: 11T cohort recovery (Wilson 95% UB; target ≥80% per AC4 hard-exit).
 * AC2: PAP-760+796+939+1052 corpus 0-LOSS (eliminate-first pruning).
 * AC5: per-bucket caps `regress_correct→CW ≤ 1` AND `regress_abstain→CW ≤ 2`
 *      AND `regress_CW_worse_delta ≤ 1` over the AC2 corpus.
 *
 * Optimization (makes 6912 × 329 photo evals tractable):
 *   1. Per-photo decode + CLAHE: once.
 *   2. Per (photo, R): cache `scoreSpec[R]` = subharmonic-aggregated FFT
 *      bins (Float64Array[MAX_TEETH+1]) plus `total`. Then per-cell J(R,tc)
 *      = scoreSpec[R][tc] / total[R] · P(R; σ_R).
 *   3. AC2-eliminate-first: skip AC1 once LOSS > 0.
 *   4. Cell-cache JSON: resumable across SIGINT/restart.
 *   5. Per-photo baseline (HEAD) computed once via the existing
 *      `runner.evalPhoto` so AC2 LOSS classification is consistent with
 *      production behaviour.
 *
 * Run:
 *   HARNESS=pap1514.phase1 SCOPE=full \
 *     npx jest --config mobile/__tests__/.jest.harness.config.js
 *
 * Optional env:
 *   PAP1514_QUICK=1         smoke (4 cells × ~10 photos AC1 / 30 photos AC2)
 *   PAP1514_CELLS=0,1,2,…   evaluate only specific cell indices (comma-sep)
 *   PAP1514_CELL_REFRESH=1  ignore cell-cache and recompute
 *   PAP1514_MAX_CELLS=N     evaluate only the first N cells (chunked runs)
 *
 * Approximations (carries forward from the pre-flight; see QA cross-check
 * #2 at sweep completion for verification scope):
 *   - PAP-868 Option A `contourR` is not exposed on the algorithm return so
 *     the harness mirrors Option E only (same as pre-flight).
 *   - Downstream abstain after β commit models PAP-961 + PAP-553 only
 *     (PAP-815 chainring-gate omitted; pre-flight does the same).
 *   - AC1 cohort sourced live as the 11T-actual photos where HEAD baseline
 *     is abstain or CW (matches `pap1100.aim-prior.js` pattern).
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const path = require('path');
const fs = require('fs');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out } = runner;

const algo = require('../src/algorithm/gearCounter');
const T = algo.__test;
const { fftMagnitude } = require('../src/algorithm/fft');
const { savgolSmooth } = require('../src/algorithm/imageUtils');

// ── Algorithm constants ────────────────────────────────────────────────────
const MIN_TEETH = 10;
const MAX_TEETH = 65;
const N_ANGLES  = 1024;

// Option β §3.4.7 — bcTc band floor + post-commit conf signature.
const BETA_BC_FLOOR = 35;
const BETA_CONF     = 0.97;
// PAP-961 downstream gate constant.
const PAP961_RATIO  = 0.65;

// ── Grid definition (v6.1 §4.1) ────────────────────────────────────────────
const GRID = {
  R_lo:      [0.35, 0.40, 0.45],
  R_hi:      [1.05, 1.10, 1.15],
  sigma_R:   [0.15, 0.20, 0.25, 0.30],
  eps_abs:   [0.015, 0.020, 0.025, 0.030],
  eps_floor: [0.06, 0.08, 0.10],
  extremeR:  [false, true],
  gamma_bc:  [1.0, 1.3, 1.6, 2.0],
  option_beta: [false, true],
};
const GRID_KEYS = ['R_lo', 'R_hi', 'sigma_R', 'eps_abs', 'eps_floor', 'extremeR', 'gamma_bc', 'option_beta'];

function enumerateCells() {
  const cells = [];
  let idx = 0;
  for (const R_lo of GRID.R_lo)
    for (const R_hi of GRID.R_hi)
      for (const sigma_R of GRID.sigma_R)
        for (const eps_abs of GRID.eps_abs)
          for (const eps_floor of GRID.eps_floor)
            for (const extremeR of GRID.extremeR)
              for (const gamma_bc of GRID.gamma_bc)
                for (const option_beta of GRID.option_beta) {
                  cells.push({ idx: idx++, R_lo, R_hi, sigma_R, eps_abs, eps_floor, extremeR, gamma_bc, option_beta });
                }
  return cells;
}

function cellKey(c) {
  return `${c.R_lo}|${c.R_hi}|${c.sigma_R}|${c.eps_abs}|${c.eps_floor}|${c.extremeR ? 1 : 0}|${c.gamma_bc}|${c.option_beta ? 1 : 0}`;
}

// ── Radii enumeration (mirrors pre-flight jointScan radius loop) ──────────
function radiiFor(R_lo, R_hi, aimR, w, h, cx, cy) {
  const maxRGeom = Math.floor(Math.min(cx, w - cx, cy, h - cy)) - 1;
  let Rlo, Rhi;
  if (aimR > 0) {
    Rlo = Math.max(10, Math.floor(R_lo * aimR));
    Rhi = Math.floor(Math.min(R_hi * aimR, maxRGeom));
  } else {
    Rlo = 10;
    Rhi = maxRGeom;
  }
  if (Rhi <= Rlo) return { radii: [], maxRGeom };
  const step = Math.max(2, Math.floor((Rhi - Rlo) / 32));
  const radii = [];
  for (let r = Rlo; r <= Rhi; r += step) {
    if (r >= 10 && r < maxRGeom) radii.push(r);
  }
  return { radii, maxRGeom };
}

// ── Per (photo, R) scoreSpec computation (cached) ─────────────────────────
function computeScoreSpec(enhanced, cx, cy, R, w, h) {
  const halfWin = Math.max(2, Math.floor(N_ANGLES / 90));
  const ring = T.sampleIntensityRing(enhanced, cx, cy, R, w, h, N_ANGLES);
  const sm = savgolSmooth(ring, halfWin, true);
  let mean = 0;
  for (let i = 0; i < sm.length; i++) mean += sm[i];
  mean /= sm.length;
  const centered = new Array(sm.length);
  for (let i = 0; i < sm.length; i++) centered[i] = sm[i] - mean;
  const mag = fftMagnitude(centered);
  const score = new Float64Array(MAX_TEETH + 1);
  let total = 0;
  for (let tc = MIN_TEETH; tc <= MAX_TEETH && tc < mag.length; tc++) {
    let s = mag[tc];
    if (2 * tc < mag.length) s += 0.5 * mag[2 * tc];
    if (3 * tc < mag.length) s += 0.25 * mag[3 * tc];
    score[tc] = s;
    total += s;
  }
  return { score, total };
}

// ── Per-photo prep: decode, CLAHE, baseline row, scoreSpec map ────────────
function preparePhoto(row, neededRadii) {
  const { rgba, w, h } = runner.loadOrDecodeRgba(row.photo, row.stamp);
  const gray = T.rgbaToGray(rgba, w, h);
  const enhanced = T.clahe(gray, w, h, 3.0, 8, 8);
  const aimR = 0.5 * Math.min(w, h);
  const gc = row.raw && row.raw.gearCenter ? row.raw.gearCenter : { x: 0.5, y: 0.5 };
  const cx = Math.round(gc.x * w);
  const cy = Math.round(gc.y * h);
  const maxRGeom = Math.floor(Math.min(cx, w - cx, cy, h - cy)) - 1;
  const specs = new Map();
  for (const R of neededRadii) {
    if (R >= 10 && R < maxRGeom) specs.set(R, computeScoreSpec(enhanced, cx, cy, R, w, h));
  }
  // Cache rOuter spec separately if not in set.
  const rOuter = Math.round(row.rOuter || 0);
  if (rOuter >= 10 && rOuter < maxRGeom && !specs.has(rOuter)) {
    specs.set(rOuter, computeScoreSpec(enhanced, cx, cy, rOuter, w, h));
  }
  return { w, h, cx, cy, aimR, maxRGeom, specs, rOuter };
}

function unionRadii(aimR, w, h, cx, cy) {
  const set = new Set();
  for (const R_lo of GRID.R_lo) {
    for (const R_hi of GRID.R_hi) {
      const { radii } = radiiFor(R_lo, R_hi, aimR, w, h, cx, cy);
      for (const r of radii) set.add(r);
    }
  }
  return [...set];
}

// ── Per-cell jointScan eval (from cached scoreSpecs) ──────────────────────
// Returns { abstain, peakTc, peakR, jStar, jDis, nCells, cellsByTc/R }.
function jointScanCell(prep, R_lo, R_hi, sigma_R_ratio) {
  const { aimR, w, h, cx, cy, specs } = prep;
  const { radii, maxRGeom } = radiiFor(R_lo, R_hi, aimR, w, h, cx, cy);
  if (radii.length === 0) return { abstain: true, peakTc: 0, peakR: 0, jStar: 0, jDis: 0, nCells: 0, sigmaR: 0 };
  const sigmaR = aimR > 0 ? sigma_R_ratio * aimR : 1;
  let bestJ = -1, bestR = 0, bestTc = 0;
  const cells = []; // [{R, tc, J}]
  for (const R of radii) {
    const spec = specs.get(R);
    if (!spec || spec.total <= 0) continue;
    const P = aimR > 0 ? Math.exp(-((R - aimR) * (R - aimR)) / (2 * sigmaR * sigmaR)) : 1;
    const invTotal = 1 / spec.total;
    const score = spec.score;
    for (let tc = MIN_TEETH; tc <= MAX_TEETH; tc++) {
      const J = score[tc] * invTotal * P;
      cells.push({ R, tc, J });
      if (J > bestJ) { bestJ = J; bestR = R; bestTc = tc; }
    }
  }
  if (cells.length === 0) return { abstain: true, peakTc: 0, peakR: 0, jStar: 0, jDis: 0, nCells: 0, sigmaR };
  let jDis = 0;
  for (const c of cells) {
    if (Math.abs(c.tc - bestTc) > 2 && c.J > jDis) jDis = c.J;
  }
  return { peakTc: bestTc, peakR: bestR, jStar: bestJ, jDis, nCells: cells.length, sigmaR, aimR, cells, maxRGeom };
}

// Option α — applied AFTER jointScanCell.
function evalOptionAlpha(joint, prep, pre, gamma_bc) {
  const { bcTc, bcPeaks } = pre;
  const result = { committed: false, gate_passed: false, R_bc: 0, J_bc_raw: 0, J_bc: 0, J_dis_new: 0, subst_fired: false };
  const bcSelfConfirms = bcTc >= 30 && bcTc <= MAX_TEETH && Math.abs(bcTc - bcPeaks) <= 2;
  if (!bcSelfConfirms) return result;
  const rOuter = prep.rOuter;
  if (!(rOuter > 0)) return result;
  const spec = prep.specs.get(rOuter);
  if (!spec || spec.total <= 0) return result;
  const sigmaR = joint.sigmaR;
  const aimR = prep.aimR;
  const P = aimR > 0 ? Math.exp(-((rOuter - aimR) * (rOuter - aimR)) / (2 * sigmaR * sigmaR)) : 1;
  const sRel = spec.score[bcTc] / spec.total;
  const J_bc_raw = sRel * P;
  result.R_bc = rOuter;
  result.J_bc_raw = J_bc_raw;
  const tcStar = joint.peakTc;
  const disagreeWithJointArgmax = Math.abs(bcTc - tcStar) > 2;
  result.gate_passed = disagreeWithJointArgmax;
  if (!disagreeWithJointArgmax) return result;
  const J_bc = J_bc_raw * gamma_bc;
  result.J_bc = J_bc;
  if (J_bc < joint.jStar) return result;
  result.subst_fired = true;
  // Recompute J_dis on disagree set w.r.t. new tc* := bcTc.
  let jDisNew = 0;
  for (const c of joint.cells) {
    if (Math.abs(c.tc - bcTc) > 2 && c.J > jDisNew) jDisNew = c.J;
  }
  result.J_dis_new = jDisNew;
  result.committed = true;
  return result;
}

function applyOptionAlpha(joint, alpha) {
  if (!alpha.committed) return joint;
  return {
    ...joint,
    peakTc: alpha.committed ? joint.peakTc : 0, // placeholder; substitute below
  };
}

// Option β §3.4.7 — fires only when α did not commit AND v6 conjuncts hold.
// `alphaCommitted` per pre-flight semantics = (alpha.subst_fired && std_commit).
function evalOptionBeta({ alphaCommitted, bcTc, bcPeaks, rOuter, postTcStar, optionBetaEnabled }) {
  const result = { fires: false, commit_tc: null };
  if (!optionBetaEnabled) return result;
  if (alphaCommitted) return result;
  const bcSelfConfirms = bcTc >= 30 && Math.abs(bcTc - bcPeaks) <= 2;
  if (!bcSelfConfirms) return result;
  if (!(bcTc >= BETA_BC_FLOOR)) return result;
  if (!(Math.abs(bcTc - (postTcStar || 0)) > 2)) return result;
  if (!(rOuter > 0)) return result;
  result.fires = true;
  result.commit_tc = bcTc;
  return result;
}

// Commit/abstain decision (§3.4 + A4 extreme_R toggle).
function commitDecision(joint, alpha, beta, eps_abs, eps_floor, extremeR) {
  // After Option α substitution: tc* := bcTc, R* := rOuter, J* := J_bc, J_dis := J_dis_new.
  let postTc = joint.peakTc, postR = joint.peakR;
  let jStar = joint.jStar, jDis = joint.jDis;
  if (alpha.committed) {
    postTc = 0;        // intermediate; the §3.4 commit decision below decides
    postR  = alpha.R_bc;
    jStar  = alpha.J_bc;
    jDis   = alpha.J_dis_new;
    // tc tracks bcTc after Option α substitution
    postTc = alpha._bcTcMarker; // set externally
  }
  // The above muddles state; instead pass alpha+joint and decide here.
  return null; // handled inline by evaluateCellOnPhoto
}

// ── Outcome buckets (B7 6-bucket enum) ─────────────────────────────────────
function disposition(tc, actual) {
  if (!tc) return 'abstain';
  return Math.abs(tc - actual) <= 1 ? 'correct' : 'CW';
}
function classifyBetaOutcome(currentTc, betaTc, actual) {
  if (betaTc == null) {
    const cur = disposition(currentTc, actual);
    if (cur === 'correct') return 'no_change_correct';
    return 'no_change_CW_same_or_better';
  }
  const cur = disposition(currentTc, actual);
  const nd  = disposition(betaTc, actual);
  if (nd === 'correct') return cur === 'correct' ? 'no_change_correct' : 'rescue';
  // newDisp === 'CW'
  if (cur === 'correct') return 'regress_correct→CW';
  if (cur === 'abstain') return 'regress_abstain→CW';
  const dOld = Math.abs((currentTc || 0) - actual);
  const dNew = Math.abs(betaTc - actual);
  if (dNew > dOld) return 'regress_CW_worse_delta';
  return 'no_change_CW_same_or_better';
}

// Downstream abstain after β commit (PAP-961 + PAP-553 mirror).
function downstreamAbstainPostBeta(joint, bcTc, gearRCrop) {
  let pap961 = false;
  if (joint.aimR > 0 && joint.peakR > 0) {
    pap961 = joint.peakR < PAP961_RATIO * joint.aimR;
  }
  const radiusSanity = gearRCrop > 0 && (gearRCrop < 0.13 || (gearRCrop < 0.17 && bcTc >= 20));
  return { fires: pap961 || radiusSanity, pap961, radiusSanity };
}

// ── Main per-cell evaluator (single photo) ─────────────────────────────────
function evaluateCellOnPhoto(prep, pre, baseline, actual, cell) {
  const { R_lo, R_hi, sigma_R, eps_abs, eps_floor, extremeR, gamma_bc, option_beta } = cell;
  const joint = jointScanCell(prep, R_lo, R_hi, sigma_R);
  // Option α substitution attempt (subst_fired iff bcSelfConfirms && rOuter>0 && disagree && J_bc>=J*).
  const alpha = evalOptionAlpha(joint, prep, pre, gamma_bc);
  // Post-α state (R*, tc*, J*, J_dis).
  let postTc, postR, postJ, postJDis;
  if (alpha.subst_fired) {
    postTc = pre.bcTc;
    postR  = alpha.R_bc;
    postJ  = alpha.J_bc;
    postJDis = alpha.J_dis_new;
  } else {
    postTc = joint.peakTc;
    postR  = joint.peakR;
    postJ  = joint.jStar;
    postJDis = joint.jDis;
  }
  // §3.4 commit/abstain on the (possibly α-substituted) state.
  const commit_margin = postJ - postJDis;
  let stdCommit = (commit_margin >= eps_abs) && (postJ >= eps_floor);
  if (stdCommit && extremeR) {
    const inBand = postR >= 0.50 * prep.aimR && postR <= 1.00 * prep.aimR;
    if (!inBand && postJDis === 0) stdCommit = false;
  }
  const alphaCommitted = alpha.subst_fired && stdCommit;
  if (!stdCommit) { postTc = 0; postR = 0; }
  // Option β (fires only when α did not commit, per spec/pre-flight semantics).
  const beta = evalOptionBeta({
    alphaCommitted,
    bcTc: pre.bcTc, bcPeaks: pre.bcPeaks, rOuter: pre.rOuter,
    postTcStar: postTc,
    optionBetaEnabled: option_beta,
  });
  let finalTc = postTc;
  if (beta.fires) {
    finalTc = beta.commit_tc;
    // Downstream defence-in-depth (PAP-961 + PAP-553) — joint R* unchanged.
    const downstream = downstreamAbstainPostBeta({ aimR: prep.aimR, peakR: joint.peakR }, pre.bcTc, pre.gearRCrop);
    if (downstream.fires) finalTc = 0;
  }
  const newDisp = disposition(finalTc, actual);
  const betaTc = beta.fires ? finalTc : null;
  const b6Bucket = classifyBetaOutcome(baseline.tc, betaTc, actual);
  const ac2Loss = baseline.disposition === 'correct' && newDisp === 'CW';
  const recovered = baseline.disposition !== 'correct' && newDisp === 'correct';
  return { newDisp, finalTc, ac2Loss, recovered, b6Bucket, alpha_committed: alphaCommitted, beta_fires: beta.fires };
}

// ── Wilson 95% CI ─────────────────────────────────────────────────────────
function wilson95(k, n) {
  if (n === 0) return { lb: 0, ub: 1, p: 0 };
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lb: center - half, ub: center + half, p };
}

// ── Driver ────────────────────────────────────────────────────────────────
describe('PAP-1514 Phase-1 calibration sweep (6912 cells, v6.1 §4.1)', () => {
  jest.setTimeout(48 * 60 * 60 * 1000);  // 48h

  test('sweep with AC2-eliminate-first + AC1 Wilson UB + B6 6-bucket counts', () => {
    const quick = process.env.PAP1514_QUICK === '1';
    const onlyCells = (process.env.PAP1514_CELLS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);
    const maxCells  = Number(process.env.PAP1514_MAX_CELLS || 0);
    const refresh   = process.env.PAP1514_CELL_REFRESH === '1';

    // ── Step 1: run HEAD on the labeled corpus (baseline), cached on disk ──
    const headSha = (() => {
      try { return require('child_process').execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().slice(0, 12); }
      catch { return 'unknown'; }
    })();
    const CACHE_DIR = path.resolve(__dirname, '..', '..', '.cache');
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const baselineCachePath = path.join(CACHE_DIR, `pap1514-baseline-${headSha}.json`);
    const refreshBase = process.env.PAP1514_BASELINE_REFRESH === '1';

    let rows, elapsedMs, total;
    if (!refreshBase && fs.existsSync(baselineCachePath)) {
      const cached = JSON.parse(fs.readFileSync(baselineCachePath, 'utf8'));
      rows = cached.rows;
      elapsedMs = cached.elapsedMs;
      total = cached.total;
      out(`\n[pap1514] BASELINE CACHE HIT (${rows.length} rows, sha=${headSha})`);
    } else {
      const scopeEnv = (process.env.SCOPE || 'full');
      const targetRange = process.env.PAP1514_TARGET_RANGE
        ? process.env.PAP1514_TARGET_RANGE.split(',').map(Number)
        : undefined;
      const res = runner.runCorpus({
        scope: scopeEnv, label: 'pap1514',
        targetRange: targetRange,
      });
      rows = res.rows;
      elapsedMs = res.elapsedMs;
      total = res.total;
      // Serialize only the fields we'll need (drops the heavy raw object).
      const serializable = rows.map(r => ({
        stamp: r.stamp, actual: r.actual, photo: r.photo,
        tc: r.tc, conf: r.conf, abstain: r.abstain, correct: r.correct,
        confidentWrong: r.confidentWrong,
        peakTc: r.peakTc, fft90: r.fft90, op: r.op,
        bcTc: r.bcTc, bcPeaks: r.bcPeaks,
        peakR: r.peakR, rOuter: r.rOuter, method: r.method,
        raw: {
          gearRadius: r.raw ? r.raw.gearRadius : 0,
          gearCenter: r.raw ? r.raw.gearCenter : { x: 0.5, y: 0.5 },
        },
      }));
      fs.writeFileSync(baselineCachePath + '.tmp', JSON.stringify({ rows: serializable, elapsedMs, total }));
      fs.renameSync(baselineCachePath + '.tmp', baselineCachePath);
      rows = serializable;
    }
    const today = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(runner.DEBUG_DIR, `pap1514_sweep_${today}.log`);
    const csvPath    = path.join(runner.DEBUG_DIR, `pap1514_sweep_${today}.csv`);
    const lines = [];
    const pushLine = (s) => { lines.push(s); out(s); };

    pushLine('');
    pushLine('=== PAP-1514 Phase-1 calibration sweep (v6.1 §4.1) ===');
    pushLine(`Baseline corpus: ${rows.length}/${total} photos  Wall: ${(elapsedMs / 1000).toFixed(1)}s`);

    // AC2 corpus = full labeled corpus (superset of the 305 PAP-760/796/939/1052 union;
    // conservative — any LOSS on the wider corpus also counts).
    const ac2Photos = rows;
    // AC1 cohort = 11T photos where HEAD is not correct.
    const ac1Photos = rows.filter(r => r.actual === 11 && (r.abstain || r.confidentWrong));
    pushLine(`AC2 corpus: ${ac2Photos.length} photos`);
    pushLine(`AC1 cohort (11T cluster, baseline not-correct): ${ac1Photos.length} photos`);

    // ── Step 2: prep per-photo cache (decode + CLAHE + scoreSpec union) ─
    // Cache is held in-memory; sweep is single-process.
    pushLine('');
    pushLine('-- Per-photo prep (decode + CLAHE + scoreSpec union) --');
    const allPhotos = new Set();
    for (const r of ac2Photos) allPhotos.add(r);
    for (const r of ac1Photos) allPhotos.add(r);
    const photoPreps = new Map();    // stamp → prep
    const photoBaseline = new Map(); // stamp → { tc, disposition }
    const photoPre = new Map();      // stamp → pluck()
    let pTotalRadii = 0;
    let pT0 = Date.now();
    let pIdx = 0;
    const totalPrep = allPhotos.size;
    for (const r of allPhotos) {
      pIdx++;
      const pre = {
        peakTc:  r.peakTc || 0,  fft90: r.fft90 || 0, op: r.op || 0,
        bcTc:    r.bcTc || 0,    bcPeaks: r.bcPeaks || 0,
        peakR:   r.peakR || 0,   rOuter: r.rOuter || 0,
        tc:      r.tc || 0,      conf: r.conf || 0,
        method:  r.method || '',
        gearRCrop: (r.raw && r.raw.gearRadius) ? r.raw.gearRadius : 0,
      };
      photoPre.set(r.stamp, pre);
      photoBaseline.set(r.stamp, {
        tc: r.tc, disposition: r.abstain ? 'abstain' : (r.correct ? 'correct' : 'CW'),
      });
      // Compute union of all radii for this photo across the 9 (R_lo, R_hi) combos.
      const { rgba, w, h } = runner.loadOrDecodeRgba(r.photo, r.stamp);
      const aimR = 0.5 * Math.min(w, h);
      const gc = r.raw && r.raw.gearCenter ? r.raw.gearCenter : { x: 0.5, y: 0.5 };
      const cx = Math.round(gc.x * w);
      const cy = Math.round(gc.y * h);
      const needed = unionRadii(aimR, w, h, cx, cy);
      const prep = preparePhoto(r, needed);
      photoPreps.set(r.stamp, prep);
      pTotalRadii += prep.specs.size;
      if (pIdx % 25 === 0) {
        pushLine(`  [${pIdx}/${totalPrep}] prepared (${pTotalRadii} (photo,R) entries, ${((Date.now()-pT0)/1000).toFixed(0)}s)`);
      }
    }
    pushLine(`Prep complete: ${totalPrep} photos / ${pTotalRadii} (photo,R) cache entries / ${((Date.now()-pT0)/1000).toFixed(0)}s`);

    // ── Step 3: cell sweep with AC2-eliminate-first + cell cache ──────
    const cellsCachePath = path.join(CACHE_DIR, `pap1514-cells-${headSha}.json`);
    let cellsCache = {};
    if (!refresh && fs.existsSync(cellsCachePath)) {
      try { cellsCache = JSON.parse(fs.readFileSync(cellsCachePath, 'utf8')); }
      catch { cellsCache = {}; }
    }
    const writeCellsCache = () => {
      fs.writeFileSync(cellsCachePath + '.tmp', JSON.stringify(cellsCache));
      fs.renameSync(cellsCachePath + '.tmp', cellsCachePath);
    };

    let allCells = enumerateCells();
    if (onlyCells.length) allCells = allCells.filter(c => onlyCells.includes(c.idx));
    if (quick) allCells = allCells.slice(0, 4);
    if (maxCells > 0) allCells = allCells.slice(0, maxCells);

    pushLine('');
    pushLine(`-- Cell sweep: ${allCells.length} cells (cache hits will be skipped) --`);

    const CSV_COLS = [
      'cell_idx', 'R_lo', 'R_hi', 'sigma_R', 'eps_abs', 'eps_floor', 'extremeR', 'gamma_bc', 'option_beta',
      'ac2_N', 'ac2_LOSS', 'ac2_eliminated', 'ac2_first_loss_stamp',
      'ac1_N', 'ac1_recovered', 'ac1_wilson_ub_pct',
      'b6_rescue', 'b6_regress_correct_to_CW', 'b6_regress_abstain_to_CW', 'b6_regress_CW_worse_delta',
      'b6_no_change_correct', 'b6_no_change_CW_same_or_better',
      'alpha_commits', 'beta_fires',
      'elapsed_ms',
    ];

    // Append-mode CSV write so partial chunks survive SIGINT.
    let csvFd;
    if (!fs.existsSync(csvPath)) {
      csvFd = fs.openSync(csvPath, 'a');
      fs.writeSync(csvFd, CSV_COLS.join(',') + '\n');
    } else {
      csvFd = fs.openSync(csvPath, 'a');
    }
    const csvEscape = (v) => {
      if (v == null) return '';
      const s = String(v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const writeCsvRow = (obj) => {
      fs.writeSync(csvFd, CSV_COLS.map(k => csvEscape(obj[k])).join(',') + '\n');
    };

    const sweepT0 = Date.now();
    let cellsRun = 0, cellsCached = 0;
    let cellsAC2Pass = 0, cellsAC2Eliminated = 0;
    const bestAc1 = []; // top-5 by AC1 Wilson UB among AC2-pass cells

    for (const cell of allCells) {
      const key = cellKey(cell);
      if (!refresh && cellsCache[key]) {
        cellsCached++;
        const e = cellsCache[key];
        if (!e.ac2_eliminated) {
          cellsAC2Pass++;
          bestAc1.push(e);
        } else cellsAC2Eliminated++;
        continue;
      }
      const cellT0 = Date.now();
      let ac2_LOSS = 0, ac2_first_loss_stamp = '';
      const b6 = {
        rescue: 0, 'regress_correct→CW': 0, 'regress_abstain→CW': 0,
        regress_CW_worse_delta: 0, no_change_correct: 0, no_change_CW_same_or_better: 0,
      };
      let alpha_commits = 0, beta_fires = 0;
      let ac2_eliminated = false;
      // AC2-eliminate-first.
      for (const r of ac2Photos) {
        const prep = photoPreps.get(r.stamp);
        const pre  = photoPre.get(r.stamp);
        const base = photoBaseline.get(r.stamp);
        const ev = evaluateCellOnPhoto(prep, pre, base, r.actual, cell);
        b6[ev.b6Bucket] = (b6[ev.b6Bucket] || 0) + 1;
        if (ev.alpha_committed) alpha_commits++;
        if (ev.beta_fires) beta_fires++;
        if (ev.ac2Loss) {
          ac2_LOSS++;
          if (!ac2_first_loss_stamp) ac2_first_loss_stamp = r.stamp;
          ac2_eliminated = true;
          break;
        }
      }
      let ac1_N = 0, ac1_recovered = 0, ac1_wilson_ub_pct = 0;
      if (!ac2_eliminated) {
        for (const r of ac1Photos) {
          const prep = photoPreps.get(r.stamp);
          const pre  = photoPre.get(r.stamp);
          const base = photoBaseline.get(r.stamp);
          const ev = evaluateCellOnPhoto(prep, pre, base, r.actual, cell);
          ac1_N++;
          if (ev.recovered) ac1_recovered++;
        }
        ac1_wilson_ub_pct = 100 * wilson95(ac1_recovered, ac1_N).ub;
      }
      const entry = {
        cell_idx: cell.idx, R_lo: cell.R_lo, R_hi: cell.R_hi, sigma_R: cell.sigma_R,
        eps_abs: cell.eps_abs, eps_floor: cell.eps_floor,
        extremeR: cell.extremeR ? 1 : 0, gamma_bc: cell.gamma_bc, option_beta: cell.option_beta ? 1 : 0,
        ac2_N: ac2Photos.length, ac2_LOSS, ac2_eliminated: ac2_eliminated ? 1 : 0, ac2_first_loss_stamp,
        ac1_N, ac1_recovered, ac1_wilson_ub_pct: Number(ac1_wilson_ub_pct.toFixed(2)),
        b6_rescue: b6.rescue,
        b6_regress_correct_to_CW: b6['regress_correct→CW'],
        b6_regress_abstain_to_CW: b6['regress_abstain→CW'],
        b6_regress_CW_worse_delta: b6.regress_CW_worse_delta,
        b6_no_change_correct: b6.no_change_correct,
        b6_no_change_CW_same_or_better: b6.no_change_CW_same_or_better,
        alpha_commits, beta_fires,
        elapsed_ms: Date.now() - cellT0,
      };
      cellsCache[key] = entry;
      writeCsvRow(entry);
      if (!ac2_eliminated) { cellsAC2Pass++; bestAc1.push(entry); }
      else cellsAC2Eliminated++;
      cellsRun++;
      if (cellsRun % 50 === 0) {
        writeCellsCache();
        pushLine(`  [${cellsRun}/${allCells.length - cellsCached}] cells run; ${cellsAC2Pass} AC2-pass, ${cellsAC2Eliminated} eliminated; ${((Date.now()-sweepT0)/1000).toFixed(0)}s`);
      }
    }
    writeCellsCache();
    fs.closeSync(csvFd);

    pushLine('');
    pushLine(`Sweep done: ${cellsRun} cells run / ${cellsCached} cached / ${(Date.now()-sweepT0)/1000}s`);
    pushLine(`AC2 pass:        ${cellsAC2Pass}`);
    pushLine(`AC2 eliminated:  ${cellsAC2Eliminated}`);
    pushLine(`CSV: ${csvPath}`);

    // ── Step 4: rank AC2-pass cells by AC1 Wilson UB ─────────────────
    bestAc1.sort((a, b) => (b.ac1_wilson_ub_pct || 0) - (a.ac1_wilson_ub_pct || 0));
    pushLine('');
    pushLine('-- Top 10 AC2-pass cells by AC1 Wilson 95% UB --');
    pushLine('rank  idx   R_lo  R_hi  σR     εabs   εfl    extR  γ_bc  β    rec/N    UB%     a→CW  abs→CW  CW.Δ  rescue');
    for (let i = 0; i < Math.min(10, bestAc1.length); i++) {
      const e = bestAc1[i];
      pushLine(
        `  ${String(i+1).padStart(2)}  ${String(e.cell_idx).padStart(4)}  ` +
        `${e.R_lo.toFixed(2)}  ${e.R_hi.toFixed(2)}  ${e.sigma_R.toFixed(2)}  ` +
        `${e.eps_abs.toFixed(3)} ${e.eps_floor.toFixed(2)}   ${e.extremeR}     ${e.gamma_bc.toFixed(1)}   ${e.option_beta}    ` +
        `${String(e.ac1_recovered).padStart(2)}/${String(e.ac1_N).padStart(2)}    ${(e.ac1_wilson_ub_pct).toFixed(1).padStart(5)}    ` +
        `${String(e.b6_regress_correct_to_CW).padStart(3)}    ${String(e.b6_regress_abstain_to_CW).padStart(3)}    ${String(e.b6_regress_CW_worse_delta).padStart(3)}    ${String(e.b6_rescue).padStart(3)}`
      );
    }

    // ── Step 5: AC5 per-bucket cap evaluation on top cell ─────────────
    if (bestAc1.length > 0) {
      const top = bestAc1[0];
      const ac5_correct = top.b6_regress_correct_to_CW <= 1;
      const ac5_abstain = top.b6_regress_abstain_to_CW <= 2;
      const ac5_worse   = top.b6_regress_CW_worse_delta <= 1;
      pushLine('');
      pushLine('-- AC5 per-bucket caps (top AC1 cell) --');
      pushLine(`regress_correct→CW:        ${top.b6_regress_correct_to_CW} / ≤ 1  ${ac5_correct ? 'PASS' : 'FAIL'}`);
      pushLine(`regress_abstain→CW:        ${top.b6_regress_abstain_to_CW} / ≤ 2  ${ac5_abstain ? 'PASS' : 'FAIL'}`);
      pushLine(`regress_CW_worse_delta:    ${top.b6_regress_CW_worse_delta} / ≤ 1  ${ac5_worse ? 'PASS' : 'FAIL'}`);
      const ac4_pass = top.ac1_wilson_ub_pct >= 20;  // AC4 hard-exit floor is UB > 20%
      pushLine('');
      pushLine(`AC4 hard-exit floor (Wilson UB > 20%): ${ac4_pass ? 'PASS' : 'FAIL → DESCOPE per PAP-1091'}`);
    }

    fs.writeFileSync(reportPath, lines.join('\n') + '\n');
    pushLine(`Report: ${reportPath}`);

    expect(allCells.length).toBeGreaterThan(0);
  });
});
