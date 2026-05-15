/**
 * PAP-1480 v2 §4.0 / A3 — pre-flight bypass-row guard.
 * v5 (PAP-1499, QA #5 APPROVED): wires Option α v5 into the inline simulator.
 *
 *   - γ_bc default = 1.3, grid {1.0, 1.3, 1.6, 2.0} + sentinel 2.5.
 *   - Pass A (bypass-row guard, v4 carry-forward): Option α substitution is
 *     APPLIED at γ_bc=1.3 default to the joint output BEFORE postRow / predicate
 *     replay (was read-only diagnostic in v4).  Per-row diag now includes the
 *     B3 (5 cols: J_bc_raw, J_star_v4, gamma_eff, subst_fired, gate_passed) +
 *     B3' (2 cols: J_dis_new, commit_margin) columns required by §4.0 v5.
 *     Advisory zero-cost cols: J_dis_new_R_k, J_dis_new_tc (discriminate
 *     Option β vs γ if v5 FAILs).
 *   - Pass B (AC2 substitution-FP scan, B4): on every labeled row that passes
 *     the cheap bcSelfConfirms pre-filter (|bcTc-bcPeaks|≤2 ∧ bcTc≥30 ∧
 *     rOuter>0), evaluate Option α across γ_bc ∈ {1.0, 1.3, 1.6, 2.0, 2.5},
 *     count rows where substitution commits to a tc that is >1 from `actual`
 *     (a true substitution-FP).  Emit ac2_fp_g10, _g13, _g16, _g20, _g25 +
 *     ac2_fp_default := ac2_fp_g13.
 *
 * v5 PASS criterion (gate before Phase-1, conjunction of three legs):
 *   Leg 1: Pass A 0 broken across all five PAP-861/868/885/889/1059 predicates
 *          at γ_bc=1.3.
 *   Leg 2: gamma_eff ≤ 2.5 for all 7 v2-broken rows.
 *   Leg 3: Pass B ac2_fp_g13 ≤ 2.
 *
 * NO `gearCounter.js` edit.  Lazy-imports __test.{sampleIntensityRing,clahe,
 * rgbaToGray} for the inline simulator.
 *
 * Output:
 *   debug-reports/pap1485_preflight_v5_<DATE>.log    human-readable
 *   debug-reports/pap1485_preflight_v5_<DATE>.json   structured summary
 *
 * Run:
 *   HARNESS=pap1480.preflight npx jest \
 *     --config mobile/__tests__/.jest.harness.config.js
 *
 * Approximations (documented for QA cross-check):
 *   - PAP-868 spec lists both Option A and Option E.  Only Option E is
 *     actively mirrored in countTeethFromRgba (Option A's `contourR` field is
 *     not exposed on the return), so the pre-flight enforces Option E only —
 *     matching what production currently bypasses.
 *   - PAP-889's predicate is the live `xlCenterCollapse` condition from the
 *     mirror block (gearRadiusCropSpace<0.20 && tc<30 && conf<0.40 && !triple
 *     && !bcStrong) — the operational form of the spec's "conf<0.40 secondary
 *     gate".
 *   - Post-substitution toothCount is approximated as `jointPeakTc` when the
 *     original toothCount was driven by peakTc (peakTc === tc); otherwise it
 *     is left unchanged.  Joint-scan only replaces peakTc/peakR, so this is
 *     the closest single-field approximation without re-running analyzeImage's
 *     full decision rule.  PAP-1059 is the only predicate that keys on `tc`.
 *   - Pass B AC2 corpus: spec calls for the 305-photo PAP-760/796/939/1052
 *     union.  Implementation uses scope='full' (the full labeled set ~362
 *     photos at HEAD); this is a superset, conservatively over-counting FPs
 *     relative to the spec's 305-photo set.
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const path = require('path');
const fs = require('fs');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out } = runner;

// Lazy require below silenceConsole so module-level logs (if any) are mute.
const algo = require('../src/algorithm/gearCounter');
const T = algo.__test;
const { fftMagnitude } = require('../src/algorithm/fft');
const { savgolSmooth } = require('../src/algorithm/imageUtils');

// ── Algorithm constants (mirror gearCounter.js:35-38) ──────────────────────
const MIN_TEETH = 10;
const MAX_TEETH = 65;
const N_ANGLES  = 1024;

// ── Spec v2 §3 defaults (no Phase-1 sweep here) ────────────────────────────
const SIGMA_R_RATIO = 0.20;
const EPS_ABS       = 0.020;
const EPS_FLOOR     = 0.08;
const R_LO_RATIO    = 0.40;
const R_HI_RATIO    = 1.10;

// ── Option α v5 parameters ─────────────────────────────────────────────────
// γ_bc Phase-1 grid (B2, v4) + sentinel (B5, v5).  Phase-1 sweep grid stays
// at 3456 cells — the 2.5 sentinel lives in the pre-flight harness only.
const GAMMA_BC_GRID_V5 = [1.0, 1.3, 1.6, 2.0, 2.5];
const GAMMA_BC_DEFAULT = 1.3;
const GAMMA_BC_SENTINEL = 2.5;

// ── Inline joint-scan simulator (no gearCounter.js edit) ───────────────────
// Replicates fftCountAtRadius math (gearCounter.js:534-569) but exposes
// per-tc magnitudes, applies a soft Gaussian prior on R, and decides via
// J*-J_dis margin instead of per-radius argmax.
function jointScan({ enhanced, cx, cy, w, h, aimR }) {
  const maxRGeom = Math.floor(Math.min(cx, w - cx, cy, h - cy)) - 1;
  let Rlo, Rhi;
  if (aimR > 0) {
    Rlo = Math.max(10, Math.floor(R_LO_RATIO * aimR));
    Rhi = Math.floor(Math.min(R_HI_RATIO * aimR, maxRGeom));
  } else {
    Rlo = 10;
    Rhi = maxRGeom;
  }
  if (Rhi <= Rlo) {
    return { abstain: true, peakTc: 0, peakR: 0, jStar: 0, jDis: 0, nCells: 0, cells: [], aimR, sigmaR: 0 };
  }
  const step = Math.max(2, Math.floor((Rhi - Rlo) / 32));
  const radii = [];
  for (let r = Rlo; r <= Rhi; r += step) {
    if (r >= 10 && r < maxRGeom) radii.push(r);
  }
  if (radii.length === 0) {
    return { abstain: true, peakTc: 0, peakR: 0, jStar: 0, jDis: 0, nCells: 0, cells: [], aimR, sigmaR: 0 };
  }

  const sigmaR = aimR > 0 ? SIGMA_R_RATIO * aimR : 1;
  const halfWin = Math.max(2, Math.floor(N_ANGLES / 90));
  const cells = [];

  for (const R of radii) {
    const ring = T.sampleIntensityRing(enhanced, cx, cy, R, w, h, N_ANGLES);
    const sm = savgolSmooth(ring, halfWin, true);
    let mean = 0;
    for (let i = 0; i < sm.length; i++) mean += sm[i];
    mean /= sm.length;
    const centered = new Array(sm.length);
    for (let i = 0; i < sm.length; i++) centered[i] = sm[i] - mean;
    const mag = fftMagnitude(centered);

    // Harmonic-weighted score per tc; per-radius normalisation (Q1 verdict).
    let total = 0;
    const scores = new Float64Array(MAX_TEETH + 1);
    for (let tc = MIN_TEETH; tc <= MAX_TEETH && tc < mag.length; tc++) {
      let s = mag[tc];
      if (2 * tc < mag.length) s += 0.5 * mag[2 * tc];
      if (3 * tc < mag.length) s += 0.25 * mag[3 * tc];
      scores[tc] = s;
      total += s;
    }
    const P = aimR > 0
      ? Math.exp(-((R - aimR) ** 2) / (2 * sigmaR * sigmaR))
      : 1;
    for (let tc = MIN_TEETH; tc <= MAX_TEETH && tc < mag.length; tc++) {
      const sRel = total > 0 ? scores[tc] / total : 0;
      cells.push({ R, tc, J: sRel * P });
    }
  }

  if (cells.length === 0) {
    return { abstain: true, peakTc: 0, peakR: 0, jStar: 0, jDis: 0, nCells: 0, cells: [], aimR, sigmaR };
  }

  let best = cells[0];
  for (const c of cells) if (c.J > best.J) best = c;
  let jDis = 0;
  for (const c of cells) {
    if (Math.abs(c.tc - best.tc) > 2 && c.J > jDis) jDis = c.J;
  }
  const commit = (best.J - jDis) >= EPS_ABS && best.J >= EPS_FLOOR;
  return {
    abstain: !commit,
    peakTc: commit ? best.tc : 0,
    peakR:  commit ? best.R  : 0,
    jStar:  best.J,             // joint argmax J (pre-substitution); always set
    jDis,                       // disagree-set max around joint argmax tc
    nCells: cells.length,
    cells,
    aimR,
    sigmaR,
  };
}

// ── Option α v5 evaluator (B3 + B3' instrumented) ──────────────────────────
// For the bc-cell at (rOuter, bcTc):
//   - gate_passed := bcSelfConfirms ∧ rOuter>0 ∧ |bcTc - tc*| > 2
//                    where bcSelfConfirms = |bcTc-bcPeaks|≤2 ∧ bcTc≥30  (v4 B1)
//   - J_bc_raw    := S_rel(rOuter, bcTc) · P(rOuter)              (B3)
//   - per γ ∈ grid: J_bc(γ) = J_bc_raw · γ, subst_fired = gate_passed ∧ J_bc≥J*
//   - J_dis_new   := max J over { (R_k,tc) : |tc - bcTc| > 2 }   (B3', new tc center)
//   - J_star_v4(γ) := substituted ? J_bc(γ) : J*                  (B3)
//   - commit_margin(γ) := J_star_v4(γ) - J_dis_post(γ)            (B3', new)
//        J_dis_post = J_dis_new when substituted, else original jDis from joint
//   - gamma_eff   := smallest γ ∈ grid with subst_fired           (B3)
//   - gamma_commit := smallest γ ∈ grid with commit_margin ≥ EPS_ABS ∧
//                     max(J*, J_bc(γ)) ≥ EPS_FLOOR                (informational)
//   - advisory: J_dis_new_R_k, J_dis_new_tc — coords of disagree-set winner
function evalOptionAlpha({ joint, enhanced, cx, cy, w, h, bcTc, bcPeaks, rOuter }) {
  const result = {
    gate_passed: false,
    bcSelfConfirms: false,
    R_bc: 0,
    bcTc,
    sRel: 0,
    P: 0,
    J_bc_raw: 0,
    J_dis_new: 0,
    J_dis_new_R_k: 0,
    J_dis_new_tc: 0,
    perGamma: {},          // γ → {J_bc, subst_fired, J_star_v4, commit_margin, committed}
    gamma_eff: null,        // smallest γ where subst_fired
    gamma_eff_off_grid: false,  // true if even γ=2.5 doesn't trigger
    gamma_commit: null,    // smallest γ where committed (informational)
  };

  // Cheap pre-filter — bcSelfConfirms (v4 B1)
  const bcSelfConfirms =
    Number.isFinite(bcTc) && Number.isFinite(bcPeaks) &&
    bcTc >= 30 && bcTc <= MAX_TEETH &&
    Math.abs(bcTc - bcPeaks) <= 2;
  result.bcSelfConfirms = bcSelfConfirms;
  if (!bcSelfConfirms) return result;
  if (!(rOuter > 0)) return result;

  const { aimR, sigmaR, jStar, peakTc: tcStar, cells } = joint;
  const Rint = Math.round(rOuter);
  result.R_bc = Rint;
  const maxRGeom = Math.floor(Math.min(cx, w - cx, cy, h - cy)) - 1;
  if (Rint < 10 || Rint >= maxRGeom) return result;

  // Re-sample at R_bc for bc-cell J value (rOuter typically sits at a non-grid radius)
  const halfWin = Math.max(2, Math.floor(N_ANGLES / 90));
  const ring = T.sampleIntensityRing(enhanced, cx, cy, Rint, w, h, N_ANGLES);
  const sm = savgolSmooth(ring, halfWin, true);
  let mean = 0;
  for (let i = 0; i < sm.length; i++) mean += sm[i];
  mean /= sm.length;
  const centered = new Array(sm.length);
  for (let i = 0; i < sm.length; i++) centered[i] = sm[i] - mean;
  const mag = fftMagnitude(centered);

  let total = 0, sBc = 0;
  for (let tc = MIN_TEETH; tc <= MAX_TEETH && tc < mag.length; tc++) {
    let s = mag[tc];
    if (2 * tc < mag.length) s += 0.5 * mag[2 * tc];
    if (3 * tc < mag.length) s += 0.25 * mag[3 * tc];
    if (tc === bcTc) sBc = s;
    total += s;
  }
  const sRel = total > 0 ? sBc / total : 0;
  const P = aimR > 0 ? Math.exp(-((Rint - aimR) ** 2) / (2 * sigmaR * sigmaR)) : 1;
  const J_bc_raw = sRel * P;
  result.sRel = sRel;
  result.P = P;
  result.J_bc_raw = J_bc_raw;

  // J_dis_new := max J over { (R_k, tc) : |tc - bcTc| > 2 }  + advisory coords
  let jDisNew = 0, jDisNewR = 0, jDisNewTc = 0;
  for (const c of cells) {
    if (Math.abs(c.tc - bcTc) > 2 && c.J > jDisNew) {
      jDisNew = c.J;
      jDisNewR = c.R;
      jDisNewTc = c.tc;
    }
  }
  result.J_dis_new = jDisNew;
  result.J_dis_new_R_k = jDisNewR;
  result.J_dis_new_tc = jDisNewTc;

  // Joint argmax disagrees by > 2 — gate's third clause
  const disagreeWithJointArgmax = Number.isFinite(tcStar) && Math.abs(bcTc - tcStar) > 2;
  // gate_passed requires bcSelfConfirms ∧ rOuter>0 ∧ joint argmax disagrees by >2
  const gate_passed = bcSelfConfirms && rOuter > 0 && disagreeWithJointArgmax;
  result.gate_passed = gate_passed;

  // Per-γ_bc instrumentation
  for (const gamma of GAMMA_BC_GRID_V5) {
    const J_bc = J_bc_raw * gamma;
    const subst_fired = gate_passed && J_bc >= jStar;
    const J_star_v4 = subst_fired ? J_bc : jStar;
    // J_dis_post: when substitution fires, use the new disagree set (around bcTc);
    // otherwise the original joint's disagree set (around joint argmax tc*).
    const J_dis_post = subst_fired ? jDisNew : joint.jDis;
    const commit_margin = J_star_v4 - J_dis_post;
    const committed = (commit_margin >= EPS_ABS) && (J_star_v4 >= EPS_FLOOR);
    result.perGamma[gamma] = {
      J_bc,
      subst_fired,
      J_star_v4,
      commit_margin,
      committed,
    };
    if (result.gamma_eff === null && subst_fired) result.gamma_eff = gamma;
    if (result.gamma_commit === null && committed && subst_fired) result.gamma_commit = gamma;
  }
  if (result.gamma_eff === null && gate_passed) {
    // Even γ=2.5 didn't push J_bc above J* — flag as off-grid.
    result.gamma_eff_off_grid = true;
  }
  return result;
}

// Apply Option α substitution to a joint result at a chosen γ_bc.  Returns a
// shallow-cloned joint with substituted (peakTc, peakR, jStar, jDis, abstain)
// IF subst_fired & committed at that γ; otherwise returns the original joint.
function applyOptionAlpha(joint, alpha, gamma) {
  if (!alpha || !alpha.gate_passed) return joint;
  const ent = alpha.perGamma[gamma];
  if (!ent || !ent.subst_fired) return joint;
  const committed = ent.committed;
  return {
    ...joint,
    peakTc: committed ? alpha.bcTc : 0,
    peakR:  committed ? alpha.R_bc : 0,
    jStar:  ent.J_star_v4,
    jDis:   alpha.J_dis_new,
    abstain: !committed,
    optionAlphaApplied: true,
    optionAlphaCommitted: committed,
    optionAlphaGamma: gamma,
  };
}

// ── Bypass predicate evaluators ────────────────────────────────────────────
// Mirror of countTeethFromRgba lines ≈3320–3470.  The harness row exposes
// {peakTc, fft90, op, bcTc, bcPeaks, peakR, rOuter, tc, conf, method, raw};
// gearRadiusCropSpace is `r.gearR / width` which equals `row.raw.gearRadius`.
function methodHead(method) {
  if (!method) return '';
  return method.split('+')[0];
}

function predTripleAgree(r) {
  return r.peakTc === r.fft90 &&
         r.peakTc === r.op &&
         r.peakTc === r.tc &&
         r.peakTc > MIN_TEETH;
}

function predBcStrongAgree(r) {
  return r.bcTc === r.bcPeaks &&
         Math.abs(r.bcTc - r.peakTc) > 5 &&
         r.tc === r.bcTc &&
         r.bcTc > MIN_TEETH;
}

function predRadialChainringFires(r) {
  const chainringRegime = r.peakTc >= 30 || r.fft90 >= 30 || r.op >= 30
                       || r.bcTc >= 30 || r.bcPeaks >= 30;
  const ac1Rescue =
       r.peakTc <= MIN_TEETH + 2
    && r.fft90  <= MIN_TEETH + 2
    && r.op     <= MIN_TEETH + 2
    && r.bcTc   <= MIN_TEETH + 2
    && r.bcPeaks >= 20 && r.bcPeaks <= 30;
  const eligible = chainringRegime || ac1Rescue;
  return eligible
      && r.peakR > 0 && r.rOuter > 0
      && Math.abs(r.peakR - r.rOuter) / r.rOuter >= 0.18;
}

// PAP-861 bc-isolated-high-delta
function predBcIsolated(r) {
  return methodHead(r.method) === 'bc-consensus'
      && r.bcTc >= 30 && r.bcPeaks >= 30
      && r.peakTc > 0 && r.fft90 > 0 && r.op > 0
      && (r.bcTc - r.peakTc) >= 10
      && (r.bcTc - r.fft90) >= 10
      && (r.bcTc - r.op)    >= 10;
}

// PAP-868 Option E (the operational mirror; Option A's contourR is not exposed)
function predFft90OuterRescue(r, gearRCrop) {
  return predRadialChainringFires(r)
      && r.peakTc === MIN_TEETH
      && r.fft90 >= 30
      && r.op > 0
      && Math.abs(r.fft90 - 2 * r.op) <= 2
      && gearRCrop > 0.30;
}

// PAP-885 5-way-agree
function predFiveWayAgree(r) {
  if (!predRadialChainringFires(r)) return false;
  const ch = [r.peakTc, r.fft90, r.op, r.bcTc, r.bcPeaks];
  if (ch.some(v => v < 30)) return false;
  return Math.max(...ch) - Math.min(...ch) <= 1;
}

// PAP-889 conf<0.40 secondary gate (operational form: xlCenterCollapse)
function predXlCenterCollapse(r, gearRCrop) {
  return gearRCrop < 0.20
      && r.tc < 30
      && r.conf < 0.40
      && !predTripleAgree(r)
      && !predBcStrongAgree(r);
}

// PAP-1059 chainring-tc-confirmed
function predChainringTcConfirmed(r) {
  return r.tc >= 30
      && (
        (r.peakTc === r.tc && (r.bcTc >= 30 || r.op === r.tc))
        || (r.bcTc   === r.tc && Math.abs(r.bcPeaks - r.bcTc) <= 1)
      );
}

const PREDICATES = [
  { name: 'PAP-861 bc-isolated',         fn: (r, g) => predBcIsolated(r) },
  { name: 'PAP-868 fft90-XL-rescue (E)', fn: (r, g) => predFft90OuterRescue(r, g) },
  { name: 'PAP-885 5-way-agree',         fn: (r, g) => predFiveWayAgree(r) },
  { name: 'PAP-889 xl-center-collapse',  fn: (r, g) => predXlCenterCollapse(r, g) },
  { name: 'PAP-1059 chainring-tc',       fn: (r, g) => predChainringTcConfirmed(r) },
];

function pluck(row) {
  return {
    peakTc:  row.peakTc  || 0,
    fft90:   row.fft90   || 0,
    op:      row.op      || 0,
    bcTc:    row.bcTc    || 0,
    bcPeaks: row.bcPeaks || 0,
    peakR:   row.peakR   || 0,
    rOuter:  row.rOuter  || 0,
    tc:      row.tc      || 0,
    conf:    row.conf    || 0,
    method:  row.method  || '',
  };
}

function postRow(pre, joint) {
  // Substitute peakTc/peakR with joint output (post Option α v5 if applied).
  // Approximate tc: when the original tc was driven by peakTc, follow joint
  // output; otherwise leave it alone (other methods could still carry it).
  const post = { ...pre };
  post.peakTc = joint.peakTc;
  post.peakR  = joint.peakR;
  if (!joint.abstain && pre.peakTc === pre.tc) {
    post.tc = joint.peakTc;
  } else if (joint.abstain && pre.peakTc === pre.tc) {
    post.tc = 0;
  }
  return post;
}

// ── Test driver ────────────────────────────────────────────────────────────
describe('PAP-1485 pre-flight v5 (A3 + Option α v5)', () => {
  jest.setTimeout(6 * 60 * 60 * 1000);  // 6h — Pass B adds bc-self-confirm rows

  test('joint-scan + Option α v5 preserves bypass rows and bounds AC2 FPs', () => {
    const { rows, elapsedMs, total } = runner.runCorpus({
      scope: 'full',     // union corpus is the full labeled set
      label: 'pap1485v5',
    });

    const today = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(runner.DEBUG_DIR, `pap1485_preflight_v5_${today}.log`);
    const jsonPath   = path.join(runner.DEBUG_DIR, `pap1485_preflight_v5_${today}.json`);
    const lines = [];
    const pushLine = (s) => { lines.push(s); out(s); };

    pushLine('');
    pushLine('=== PAP-1485 pre-flight v5 (A3 + Option α v5) ===');
    pushLine(`Corpus: ${rows.length}/${total} photos  Wall: ${(elapsedMs / 1000).toFixed(1)}s`);
    pushLine(`Spec v5 defaults: σ_R/aimR=${SIGMA_R_RATIO}, ε_abs=${EPS_ABS}, ε_floor=${EPS_FLOOR}, R=[${R_LO_RATIO},${R_HI_RATIO}]·aimR, extreme_R_abstain=off`);
    pushLine(`Option α v5: γ_bc default=${GAMMA_BC_DEFAULT}, grid=${JSON.stringify(GAMMA_BC_GRID_V5)} (last=sentinel B5)`);

    // Per-predicate counters: Pass A
    const counters = PREDICATES.map(p => ({
      name: p.name, fires: 0, broken: 0, brokenRows: [],
    }));
    // Pass B counters: substitution-FP at each γ_bc (true FP := bcTc differs from actual by >1)
    const passB = {
      scanned: 0,
      gatePassedRows: [],
      // Per-γ_bc FP counts
      ac2_fp: Object.fromEntries(GAMMA_BC_GRID_V5.map(g => [g, 0])),
    };

    let scanned = 0;     // rows where ≥1 bypass predicate fires
    let jointAbstainCount = 0;
    let optionAlphaCommittedCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const gearRCrop = row.raw && row.raw.gearRadius ? row.raw.gearRadius : 0;
      const pre = pluck(row);

      const preFires = PREDICATES.map(p => p.fn(pre, gearRCrop));
      const anyFires = preFires.some(Boolean);

      // Cheap pre-filter for Pass B (bcSelfConfirms gate's first two clauses)
      const bcSelfConfirms =
        pre.bcTc >= 30 && pre.bcTc <= MAX_TEETH &&
        Math.abs(pre.bcTc - pre.bcPeaks) <= 2 &&
        pre.rOuter > 0;

      if (!anyFires && !bcSelfConfirms) continue;

      // Reconstruct enhanced[] for the joint-scan simulator.  Uses the same
      // RGBA buffer the harness already decoded (PAP-971 cache makes this
      // basically free on the second pass).
      const { rgba, w: rw, h: rh } = runner.loadOrDecodeRgba(row.photo, row.stamp);
      const gray = T.rgbaToGray(rgba, rw, rh);
      const enhanced = T.clahe(gray, rw, rh, 3.0, 8, 8);

      const aimR = 0.5 * Math.min(rw, rh);
      const gc = row.raw.gearCenter || { x: 0.5, y: 0.5 };
      const cx = Math.round(gc.x * rw);
      const cy = Math.round(gc.y * rh);
      const joint = jointScan({ enhanced, cx, cy, w: rw, h: rh, aimR });

      // Evaluate Option α v5 (gate + per-γ_bc) once per scanned row
      const alpha = evalOptionAlpha({
        joint, enhanced, cx, cy, w: rw, h: rh,
        bcTc: pre.bcTc, bcPeaks: pre.bcPeaks, rOuter: pre.rOuter,
      });

      // Apply Option α at γ_bc=DEFAULT (1.3) to produce the post-substitution joint
      const newJoint = applyOptionAlpha(joint, alpha, GAMMA_BC_DEFAULT);
      if (newJoint.optionAlphaCommitted) optionAlphaCommittedCount++;
      if (newJoint.abstain) jointAbstainCount++;

      // Pass A — bypass-row guard with Option α v5 applied
      if (anyFires) {
        scanned++;
        const post = postRow(pre, newJoint);
        const postFires = PREDICATES.map(p => p.fn(post, gearRCrop));

        for (let p = 0; p < PREDICATES.length; p++) {
          if (!preFires[p]) continue;
          counters[p].fires++;
          if (!postFires[p]) {
            counters[p].broken++;
            counters[p].brokenRows.push({
              stamp: row.stamp,
              actual: row.actual,
              tc: pre.tc,
              peakTc: pre.peakTc,
              fft90tc: pre.fft90,
              opTc: pre.op,
              bcTc: pre.bcTc,
              bcPeaks: pre.bcPeaks,
              peakR: pre.peakR,
              rOuter: pre.rOuter,
              method: pre.method,
              conf: Number((pre.conf || 0).toFixed(3)),
              gearRCropSpace: Number(gearRCrop.toFixed(4)),
              joint: {
                peakTc: joint.peakTc,        // pre-Option-α joint argmax
                peakR: joint.peakR,
                jStar: Number(joint.jStar.toFixed(4)),
                jDis:  Number(joint.jDis.toFixed(4)),
                abstain: joint.abstain,
                nCells: joint.nCells,
              },
              optionAlpha: {
                gate_passed: alpha.gate_passed,
                bcSelfConfirms: alpha.bcSelfConfirms,
                R_bc: alpha.R_bc,
                J_bc_raw: Number(alpha.J_bc_raw.toFixed(4)),
                J_dis_new: Number(alpha.J_dis_new.toFixed(4)),
                J_dis_new_R_k: alpha.J_dis_new_R_k,    // advisory (B3' extension)
                J_dis_new_tc: alpha.J_dis_new_tc,      // advisory (B3' extension)
                gamma_eff: alpha.gamma_eff,
                gamma_eff_off_grid: alpha.gamma_eff_off_grid,
                gamma_commit: alpha.gamma_commit,
                perGamma: Object.fromEntries(
                  GAMMA_BC_GRID_V5.map(g => {
                    const e = alpha.perGamma[g] || {};
                    return [g, {
                      J_bc:           Number((e.J_bc || 0).toFixed(4)),
                      J_star_v4:      Number((e.J_star_v4 || 0).toFixed(4)),
                      commit_margin:  Number((e.commit_margin || 0).toFixed(4)),
                      subst_fired:    !!e.subst_fired,
                      committed:      !!e.committed,
                    }];
                  })
                ),
                applied_at_default: !!newJoint.optionAlphaApplied,
                committed_at_default: !!newJoint.optionAlphaCommitted,
              },
            });
          }
        }
      }

      // Pass B — AC2 substitution-FP scan (per-γ_bc)
      // FP definition: gate_passed ∧ committed at γ ∧ |bcTc - actual| > 1.
      // (A committed substitution at γ that gives a tc within ±1 of actual is
      // a genuine rescue, not an FP — bcTc==actual on PAP-861 catches that.)
      if (bcSelfConfirms) {
        passB.scanned++;
        if (alpha.gate_passed) {
          const wrongDirection = Math.abs(pre.bcTc - row.actual) > 1;
          for (const gamma of GAMMA_BC_GRID_V5) {
            const e = alpha.perGamma[gamma];
            if (e && e.subst_fired && e.committed && wrongDirection) {
              passB.ac2_fp[gamma]++;
            }
          }
          // Capture detail rows where ANY γ_bc committed substitution — both
          // rescues (bcTc≈actual) AND FPs (bcTc≠actual) for downstream review.
          const anyCommitted = GAMMA_BC_GRID_V5.some(g =>
            alpha.perGamma[g] && alpha.perGamma[g].subst_fired && alpha.perGamma[g].committed
          );
          if (anyCommitted) {
            passB.gatePassedRows.push({
              stamp: row.stamp,
              actual: row.actual,
              tc: pre.tc,
              bcTc: pre.bcTc,
              bcPeaks: pre.bcPeaks,
              rOuter: pre.rOuter,
              wrongDirection,
              J_bc_raw: Number(alpha.J_bc_raw.toFixed(4)),
              jStar: Number(joint.jStar.toFixed(4)),
              J_dis_new: Number(alpha.J_dis_new.toFixed(4)),
              committedAtGamma: GAMMA_BC_GRID_V5.filter(g =>
                alpha.perGamma[g] && alpha.perGamma[g].subst_fired && alpha.perGamma[g].committed
              ),
            });
          }
        }
      }
    }

    // ── Pass A summary ──────────────────────────────────────────────────────
    pushLine('');
    pushLine(`-- Pass A — bypass-row guard (Option α v5 at γ_bc=${GAMMA_BC_DEFAULT}) --`);
    pushLine(`Rows joint-scanned (≥1 bypass fired): ${scanned}/${rows.length}`);
    pushLine(`Joint-scan (post Option α) abstained: ${jointAbstainCount}/${scanned || 1}`);
    pushLine(`Option α committed at γ=${GAMMA_BC_DEFAULT}: ${optionAlphaCommittedCount}`);
    pushLine('');
    pushLine('Predicate                          fires   broken   broken%');
    let anyBroken = false;
    for (const c of counters) {
      if (c.broken > 0) anyBroken = true;
      const pct = c.fires > 0 ? ((100 * c.broken) / c.fires).toFixed(1) + '%' : '  -  ';
      pushLine(
        `${c.name.padEnd(33)}  ${String(c.fires).padStart(5)}   ${String(c.broken).padStart(6)}   ${pct.padStart(7)}`
      );
    }

    // Track gamma_eff for broken PAP-861 rows (Leg 2 gate)
    const brokenPap861GammaEff = [];
    for (const c of counters) {
      if (c.brokenRows.length === 0) continue;
      pushLine('');
      pushLine(`-- broken rows: ${c.name} --`);
      pushLine('stamp                                       actual  tc  peakTc  fft90  op  bcTc  bcPk  peakR  rOuter  conf   gR(crop)  joint(R*,tc*,J*,J_dis)  abst');
      for (const br of c.brokenRows) {
        pushLine(
          `${br.stamp.padEnd(40)}  ${String(br.actual).padStart(5)}  ` +
          `${String(br.tc).padStart(2)}  ${String(br.peakTc).padStart(5)}  ` +
          `${String(br.fft90tc).padStart(5)}  ${String(br.opTc).padStart(3)}  ` +
          `${String(br.bcTc).padStart(4)}  ${String(br.bcPeaks).padStart(4)}  ` +
          `${String(br.peakR).padStart(5)}  ${String(br.rOuter).padStart(6)}  ` +
          `${String(br.conf).padStart(5)}  ${String(br.gearRCropSpace).padStart(8)}  ` +
          `(${br.joint.peakR},${br.joint.peakTc},${br.joint.jStar},${br.joint.jDis})  ${br.joint.abstain ? 'Y' : 'N'}`
        );
        if (c.name.startsWith('PAP-861')) {
          brokenPap861GammaEff.push({
            stamp: br.stamp,
            gamma_eff: br.optionAlpha.gamma_eff,
            gamma_eff_off_grid: br.optionAlpha.gamma_eff_off_grid,
          });
        }
      }
      // B3 + B3' instrumentation block (v5)
      pushLine('');
      pushLine(`   B3+B3' (Option α v5 diag, per row):  γ grid = {${GAMMA_BC_GRID_V5.join(', ')}} (last=sentinel)`);
      pushLine('   stamp                                       bcTc  R_bc  J_bc_raw  J_dis_new  J_dis_new(R,tc)  gamma_eff  gamma_commit  gate  applied@1.3  committed@1.3');
      for (const br of c.brokenRows) {
        const oa = br.optionAlpha;
        const geff = oa.gamma_eff_off_grid ? '>2.5'
                    : (oa.gamma_eff == null ? '  -  ' : String(oa.gamma_eff));
        const gcom = oa.gamma_commit == null ? '  -  ' : String(oa.gamma_commit);
        const jdisRT = `(${oa.J_dis_new_R_k},${oa.J_dis_new_tc})`;
        pushLine(
          `   ${br.stamp.padEnd(40)}  ${String(oa.bcTc || br.bcTc).padStart(4)}  ` +
          `${String(oa.R_bc).padStart(4)}  ${oa.J_bc_raw.toFixed(4).padStart(8)}  ` +
          `${oa.J_dis_new.toFixed(4).padStart(9)}  ${jdisRT.padStart(15)}  ` +
          `${String(geff).padStart(9)}  ${String(gcom).padStart(12)}  ` +
          `${oa.gate_passed ? 'Y' : 'N'}     ${oa.applied_at_default ? 'Y' : 'N'}            ` +
          `${oa.committed_at_default ? 'Y' : 'N'}`
        );
      }
      // Per-γ_bc detail for each broken row
      pushLine('');
      pushLine(`   Per-γ_bc table (J_bc / J*_v4 / commit_margin / subst_fired / committed):`);
      pushLine('   stamp                                       γ_bc   J_bc    J*_v4   margin   subst  commit');
      for (const br of c.brokenRows) {
        for (const gamma of GAMMA_BC_GRID_V5) {
          const e = br.optionAlpha.perGamma[gamma];
          if (!e) continue;
          pushLine(
            `   ${br.stamp.padEnd(40)}  ${String(gamma).padStart(4)}  ` +
            `${e.J_bc.toFixed(4).padStart(6)}  ${e.J_star_v4.toFixed(4).padStart(6)}  ` +
            `${e.commit_margin.toFixed(4).padStart(7)}  ${e.subst_fired ? 'Y' : 'N'}      ${e.committed ? 'Y' : 'N'}`
          );
        }
      }
    }

    // ── Pass B summary ──────────────────────────────────────────────────────
    pushLine('');
    pushLine(`-- Pass B — AC2 substitution-FP scan (v5 B4) --`);
    pushLine(`Rows scanned (bcSelfConfirms ∧ rOuter>0): ${passB.scanned}/${rows.length}`);
    pushLine('FP definition: gate_passed ∧ committed at γ ∧ |bcTc - actual| > 1');
    pushLine('');
    pushLine('γ_bc       ac2_fp');
    for (const gamma of GAMMA_BC_GRID_V5) {
      const isDefault = gamma === GAMMA_BC_DEFAULT ? '  *default' : '';
      const isSentinel = gamma === GAMMA_BC_SENTINEL ? '  *sentinel' : '';
      pushLine(`${String(gamma).padStart(4)}      ${String(passB.ac2_fp[gamma]).padStart(5)}${isDefault}${isSentinel}`);
    }
    const ac2_fp_default = passB.ac2_fp[GAMMA_BC_DEFAULT];
    const ac2_fp_sentinel = passB.ac2_fp[GAMMA_BC_SENTINEL];
    pushLine('');
    pushLine(`ac2_fp_default (γ=${GAMMA_BC_DEFAULT}): ${ac2_fp_default}`);
    pushLine(`ac2_fp_g25 (sentinel ceiling): ${ac2_fp_sentinel}`);

    if (passB.gatePassedRows.length > 0) {
      pushLine('');
      pushLine(`   Pass B committed-substitution detail (rescues + FPs):`);
      pushLine('   stamp                                       actual  tc  bcTc  bcPk  rOuter  J_bc_raw  jStar   J_dis_new  wrongDir  committedAtγ');
      for (const r of passB.gatePassedRows) {
        pushLine(
          `   ${r.stamp.padEnd(40)}  ${String(r.actual).padStart(5)}  ` +
          `${String(r.tc).padStart(2)}  ${String(r.bcTc).padStart(4)}  ` +
          `${String(r.bcPeaks).padStart(4)}  ${String(r.rOuter).padStart(6)}  ` +
          `${r.J_bc_raw.toFixed(4).padStart(8)}  ${r.jStar.toFixed(4).padStart(6)}  ` +
          `${r.J_dis_new.toFixed(4).padStart(9)}  ${r.wrongDirection ? 'Y' : 'N'}        ` +
          `[${r.committedAtGamma.join(',')}]`
        );
      }
    }

    // ── v5 PASS gate evaluation ─────────────────────────────────────────────
    pushLine('');
    pushLine(`-- v5 PASS criterion --`);
    // Leg 1: Pass A 0 broken across all 5 predicates at γ_bc=DEFAULT
    const leg1Pass = !anyBroken;
    // Leg 2: gamma_eff ≤ 2.5 for every broken PAP-861 row
    // (For Leg 2, "broken at γ_bc=1.3 default" is the set we care about; we
    // ask whether ANY γ in the v5 grid (incl. 2.5 sentinel) would have closed
    // the row. If gamma_eff_off_grid for any row → FAIL Leg 2.)
    const leg2OffGrid = brokenPap861GammaEff.filter(r => r.gamma_eff_off_grid);
    const leg2Pass = leg2OffGrid.length === 0;
    // Leg 3: ac2_fp at γ_bc=1.3 default ≤ 2
    const AC2_FP_BUDGET = 2;
    const leg3Pass = ac2_fp_default <= AC2_FP_BUDGET;

    pushLine(`Leg 1 (Pass A 0 broken at γ=${GAMMA_BC_DEFAULT}):                       ${leg1Pass ? 'PASS' : 'FAIL'}`);
    pushLine(`Leg 2 (gamma_eff ≤ ${GAMMA_BC_SENTINEL} for broken PAP-861 rows):       ${leg2Pass ? 'PASS' : 'FAIL'}` +
             (leg2OffGrid.length ? `  (off-grid: ${leg2OffGrid.map(r=>r.stamp).join(', ')})` : ''));
    pushLine(`Leg 3 (ac2_fp_default ≤ ${AC2_FP_BUDGET}):                              ${leg3Pass ? 'PASS' : 'FAIL'}  (ac2_fp_g${GAMMA_BC_DEFAULT.toString().replace('.','')}=${ac2_fp_default})`);
    const overallPass = leg1Pass && leg2Pass && leg3Pass;
    const verdict = overallPass
      ? 'PASS — proceed to Phase-1 calibration child under PAP-1480 (3456-cell sweep)'
      : 'FAIL — file v6 round (Option β skip-abstain or Option γ commit-relaxation)';

    pushLine('');
    pushLine(`Verdict: ${verdict}`);
    pushLine(`Output:  ${reportPath}`);
    pushLine(`Output:  ${jsonPath}`);

    const summary = {
      spec: 'pap1480_v5',
      corpusSize: rows.length,
      passA: {
        scanned,
        jointAbstainCount,
        optionAlphaCommittedCount,
        predicates: counters.map(c => ({
          name: c.name,
          fires: c.fires,
          broken: c.broken,
          brokenRows: c.brokenRows,
        })),
      },
      passB: {
        scanned: passB.scanned,
        ac2_fp_g10: passB.ac2_fp[1.0],
        ac2_fp_g13: passB.ac2_fp[1.3],
        ac2_fp_g16: passB.ac2_fp[1.6],
        ac2_fp_g20: passB.ac2_fp[2.0],
        ac2_fp_g25: passB.ac2_fp[2.5],
        ac2_fp_default: ac2_fp_default,
        ac2_fp_sentinel: ac2_fp_sentinel,
        ac2_fp_budget: AC2_FP_BUDGET,
        committed_rows: passB.gatePassedRows,
      },
      gate: {
        leg1_pass_a_broken: leg1Pass,
        leg2_gamma_eff_in_grid: leg2Pass,
        leg2_off_grid_rows: leg2OffGrid,
        leg3_ac2_fp_under_budget: leg3Pass,
        overall: overallPass ? 'PASS' : 'FAIL',
      },
      verdict: overallPass ? 'PASS' : 'FAIL',
      elapsedMs,
    };
    fs.writeFileSync(reportPath, lines.join('\n') + '\n');
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

    expect(rows.length).toBeGreaterThan(0);
    // Do NOT fail the jest run on verdict=FAIL — verdict is a hand-off signal,
    // not a test failure.  AE inspects the report; QA reads the verdict on the
    // PAP-1499 / PAP-1485 thread.
  });
});
