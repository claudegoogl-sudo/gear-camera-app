/**
 * PAP-1480 v2 §4.0 / A3 — pre-flight bypass-row guard.
 * v6.1 (PAP-1506, QA #6 APPROVED-W-AMENDMENTS B7+B8 via PAP-1505): wires
 * Option β (§3.4.7 skip-abstain) on top of Option α v5, and emits Pass B B6
 * with the 6-bucket `beta_outcome` enum + per-bucket cap evaluation.
 *
 * v6.1 layering (Option α stays in spec as tie-wins diagnostic channel):
 *   - Joint scan (§3) → Option α v5 (§3.4.6) → Option β v6 (§3.4.7) →
 *     bypass-predicate re-evaluation (Pass A) / per-row outcome bucketing
 *     (Pass B B6).
 *   - γ_bc default = 1.3 single value (B5 sentinel grid retired for v6.1;
 *     PAP-1499 measured 0/19 Option α commits across grid {1.0…2.5} so the
 *     sweep carries zero signal for v6.1's Pass B Option β surface).
 *   - option_beta=on default per §3.4 param table (binary toggle in Phase-1).
 *   - Per-row CSV `pap1485_preflight_v6_<DATE>.csv` + JSON rollup
 *     `pap1485_preflight_v6_<DATE>.json` for QA #2 machine-parse.
 *
 * v6.1 PASS criterion (gate before Phase-1):
 *   Pass A: 0 broken across PAP-861/868/885/889/1059 with α + β active at
 *           γ_bc=1.3.
 *   Pass B: per-bucket caps all independently hold:
 *           - regress_correct→CW ≤ 1            (B8 loss-aversion)
 *           - regress_abstain→CW ≤ 2            (B8 new noise)
 *           - regress_CW_worse_delta ≤ 1        (B8 silent regression, B7 enum)
 *   Sanity rollup (non-binding): correct→CW + abstain→CW ≤ 2 (v6 continuity).
 *
 * NO `gearCounter.js` edit.  Lazy-imports __test.{sampleIntensityRing,clahe,
 * rgbaToGray} for the inline simulator.
 *
 * Run:
 *   HARNESS=pap1480.preflight npx jest \
 *     --config mobile/__tests__/.jest.harness.config.js
 *
 * Approximations (documented for QA cross-check):
 *   - PAP-868 spec lists both Option A and Option E.  Only Option E is
 *     actively mirrored in countTeethFromRgba (Option A's `contourR` field is
 *     not exposed on the return), so the pre-flight enforces Option E only.
 *   - PAP-889's predicate is the live `xlCenterCollapse` condition from the
 *     mirror block (gearRadiusCropSpace<0.20 && tc<30 && conf<0.40 && !triple
 *     && !bcStrong).
 *   - Post-α/β toothCount: when Option β fires it commits tc*:=bcTc directly
 *     and leaves joint R* unchanged (per §3.4.7); when only Option α applies
 *     we propagate joint output through postRow() exactly as v5.
 *   - Pass B AC2 corpus: spec calls for the 305-photo PAP-760/796/939/1052
 *     union; implementation uses SCOPE='full' (~362 photos at HEAD) — a
 *     superset of the spec set; AC2 cap evaluation is conservative.
 *   - `downstream_abstain_after_beta` approximation: implements PAP-961
 *     (peakR<0.65·aimR) + PAP-553 radius-sanity (cropNormR<0.13 ||
 *     (cropNormR<0.15 && bcTc>=20)) as the canonical defence-in-depth checks
 *     after β commit.  PAP-815 chainring-gate requires more state than the
 *     pre-flight tracks and is not modelled here; flagged in the per-row
 *     `downstream_abstain_after_beta_components` field for QA review.
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

// ── Algorithm constants (mirror gearCounter.js:35-38) ──────────────────────
const MIN_TEETH = 10;
const MAX_TEETH = 65;
const N_ANGLES  = 1024;

// ── Spec v6.1 §3 defaults (γ_bc grid retired — single γ=1.3) ───────────────
const SIGMA_R_RATIO = 0.20;
const EPS_ABS       = 0.020;
const EPS_FLOOR     = 0.08;
const R_LO_RATIO    = 0.40;
const R_HI_RATIO    = 1.10;

// ── Option α γ_bc default (single value at v6.1; was a grid at v5) ─────────
const GAMMA_BC_DEFAULT = 1.3;

// ── Option β §3.4.7 conjunct (iii): bcTc ≥ 35 chainring-band floor ─────────
const BETA_BC_FLOOR = 35;
// ── Option β §3.4.7 conf signature: 0.97 (one ε below max) ─────────────────
const BETA_CONF = 0.97;

// ── PAP-961 downstream gate constant (peakR < 0.65·aimR abstain) ───────────
const PAP961_RATIO = 0.65;

// ── Inline joint-scan simulator (unchanged from v5) ────────────────────────
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
    jStar:  best.J,
    jDis,
    nCells: cells.length,
    cells,
    aimR,
    sigmaR,
  };
}

// ── Option α v5 evaluator (B3+B3' carries forward; single γ at v6.1) ───────
function evalOptionAlpha({ joint, enhanced, cx, cy, w, h, bcTc, bcPeaks, rOuter, gamma }) {
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
    J_bc: 0,
    subst_fired: false,
    J_star_v4: 0,
    commit_margin: 0,
    committed: false,
  };

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

  const disagreeWithJointArgmax = Number.isFinite(tcStar) && Math.abs(bcTc - tcStar) > 2;
  const gate_passed = bcSelfConfirms && rOuter > 0 && disagreeWithJointArgmax;
  result.gate_passed = gate_passed;

  const J_bc = J_bc_raw * gamma;
  const subst_fired = gate_passed && J_bc >= jStar;
  const J_star_v4 = subst_fired ? J_bc : jStar;
  const J_dis_post = subst_fired ? jDisNew : joint.jDis;
  const commit_margin = J_star_v4 - J_dis_post;
  const committed = (commit_margin >= EPS_ABS) && (J_star_v4 >= EPS_FLOOR);
  result.J_bc = J_bc;
  result.subst_fired = subst_fired;
  result.J_star_v4 = J_star_v4;
  result.commit_margin = commit_margin;
  result.committed = subst_fired && committed;
  return result;
}

// Apply Option α substitution to a joint result.
function applyOptionAlpha(joint, alpha) {
  if (!alpha || !alpha.gate_passed) return joint;
  if (!alpha.subst_fired) return joint;
  return {
    ...joint,
    peakTc: alpha.committed ? alpha.bcTc : 0,
    peakR:  alpha.committed ? alpha.R_bc : 0,
    jStar:  alpha.J_star_v4,
    jDis:   alpha.J_dis_new,
    abstain: !alpha.committed,
    optionAlphaApplied: true,
    optionAlphaCommitted: alpha.committed,
  };
}

// ── Option β §3.4.7 evaluator (v6) ─────────────────────────────────────────
// Fires ONLY when Option α did not commit AND v6 conjuncts hold:
//   (i)   !subst_committed
//   (ii)  |bcTc - bcPeaks| ≤ 2  AND  bcTc ≥ 30 (carry-forward bcSelfConfirms)
//   (iii) bcTc ≥ 35 (chainring-band floor, v6 C6)
//   (iv)  |bcTc - tc*| > 2 (disagree with post-α joint argmax)
//   (v)   rOuter > 0 (C3 carry-forward)
// On fire: tc* := bcTc; R*/J*/J_dis unchanged from joint argmax; conf:=0.97;
//          skip §3.4 abstain.
function evalOptionBeta({ alpha, postAlphaJoint, bcTc, bcPeaks, rOuter, optionBetaEnabled }) {
  const result = {
    fires: false,
    commit_tc: null,
    commit_delta: null,
    R_star: postAlphaJoint.peakR || 0,
    conf: BETA_CONF,
    reason_blocked: null,
  };
  if (!optionBetaEnabled) {
    result.reason_blocked = 'option_beta=off';
    return result;
  }
  if (alpha && alpha.committed) {
    result.reason_blocked = 'alpha_committed';
    return result;
  }
  const tcStar = postAlphaJoint.peakTc || 0;  // 0 when joint abstained
  const bcSelfConfirms =
    Number.isFinite(bcTc) && Number.isFinite(bcPeaks) &&
    bcTc >= 30 && Math.abs(bcTc - bcPeaks) <= 2;
  if (!bcSelfConfirms) {
    result.reason_blocked = 'bcSelfConfirms_fail';
    return result;
  }
  if (!(bcTc >= BETA_BC_FLOOR)) {
    result.reason_blocked = `bcTc<${BETA_BC_FLOOR}`;
    return result;
  }
  // |bcTc - tc*| > 2: when joint abstained (tc*=0) bcTc≥35 trivially passes.
  if (!(Math.abs(bcTc - tcStar) > 2)) {
    result.reason_blocked = 'bcTc_agrees_with_tcStar';
    return result;
  }
  if (!(rOuter > 0)) {
    result.reason_blocked = 'rOuter==0';
    return result;
  }
  result.fires = true;
  result.commit_tc = bcTc;
  return result;
}

// Apply Option β commit to a (post-α) joint result.
function applyOptionBeta(joint, beta, actual) {
  if (!beta || !beta.fires) return joint;
  const commit_delta = Number.isFinite(actual) ? Math.abs(beta.commit_tc - actual) : null;
  return {
    ...joint,
    peakTc: beta.commit_tc,
    // R*, J*, J_dis intentionally unchanged from joint argmax (§3.4.7).
    abstain: false,
    optionBetaApplied: true,
    optionBetaCommitTc: beta.commit_tc,
    optionBetaCommitDelta: commit_delta,
    confAfterBeta: BETA_CONF,
  };
}

// ── Bypass predicate evaluators (unchanged from v5) ────────────────────────
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

function predBcIsolated(r) {
  return methodHead(r.method) === 'bc-consensus'
      && r.bcTc >= 30 && r.bcPeaks >= 30
      && r.peakTc > 0 && r.fft90 > 0 && r.op > 0
      && (r.bcTc - r.peakTc) >= 10
      && (r.bcTc - r.fft90) >= 10
      && (r.bcTc - r.op)    >= 10;
}

function predFft90OuterRescue(r, gearRCrop) {
  return predRadialChainringFires(r)
      && r.peakTc === MIN_TEETH
      && r.fft90 >= 30
      && r.op > 0
      && Math.abs(r.fft90 - 2 * r.op) <= 2
      && gearRCrop > 0.30;
}

function predFiveWayAgree(r) {
  if (!predRadialChainringFires(r)) return false;
  const ch = [r.peakTc, r.fft90, r.op, r.bcTc, r.bcPeaks];
  if (ch.some(v => v < 30)) return false;
  return Math.max(...ch) - Math.min(...ch) <= 1;
}

function predXlCenterCollapse(r, gearRCrop) {
  return gearRCrop < 0.20
      && r.tc < 30
      && r.conf < 0.40
      && !predTripleAgree(r)
      && !predBcStrongAgree(r);
}

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

function postRow(pre, joint, beta) {
  const post = { ...pre };
  post.peakTc = joint.peakTc;
  post.peakR  = joint.peakR;
  if (beta && beta.fires) {
    // Option β commits tc* := bcTc; reflect into the row-level tc field so
    // PAP-1059 / PAP-861 predicates see the bc-committed tc as the post tc.
    post.tc = beta.commit_tc;
    post.conf = BETA_CONF;
  } else if (!joint.abstain && pre.peakTc === pre.tc) {
    post.tc = joint.peakTc;
  } else if (joint.abstain && pre.peakTc === pre.tc) {
    post.tc = 0;
  }
  return post;
}

// ── Outcome classifier (v6.1 B7 6-bucket enum) ─────────────────────────────
// Disposition / outcome definitions per spec §4.0 v6.1 Pass B table.
function dispositionFor(tc, actual) {
  if (tc === 0 || tc == null) return 'abstain';
  return Math.abs(tc - actual) <= 1 ? 'correct' : 'CW';
}

function classifyBetaOutcome({ currentTc, betaTc, actual }) {
  if (betaTc == null) {
    // β did not fire — outcome is "no_change_*" relative to the current row.
    const cur = dispositionFor(currentTc, actual);
    if (cur === 'correct') return 'no_change_correct';
    if (cur === 'CW') return 'no_change_CW_same_or_better';
    // Current abstain w/ β not firing — still no-change (no commit was added).
    // Spec §4.0 v6.1 table covers {rescue, regress_*, no_change_*}; when β
    // doesn't fire the row is effectively no_change.  Choose
    // `no_change_CW_same_or_better` as the conservative bucket since current
    // abstain is not user-visible-correct.  This row will not count toward
    // any cap (all caps are on regress_* buckets only).
    return 'no_change_CW_same_or_better';
  }
  const dOld = Math.abs((currentTc || 0) - actual);
  const dNew = Math.abs(betaTc - actual);
  const cur  = dispositionFor(currentTc, actual);
  const newDisp = dispositionFor(betaTc, actual);
  // β committed → newDisp ∈ {correct, CW} (abstain impossible after β commit).
  if (newDisp === 'correct') {
    if (cur === 'correct') return 'no_change_correct';
    return 'rescue';  // current ∈ {CW, abstain} → β correct
  }
  // newDisp === 'CW'
  if (cur === 'correct') return 'regress_correct→CW';
  if (cur === 'abstain') return 'regress_abstain→CW';
  // cur === 'CW' — silent regression iff dNew > dOld
  if (dNew > dOld) return 'regress_CW_worse_delta';
  return 'no_change_CW_same_or_better';
}

// ── Downstream defence-in-depth approximation ──────────────────────────────
// Models PAP-961 (peakR<0.65·aimR) + PAP-553 radius-sanity (cropNormR-based)
// on the (bcTc, joint R*) the post-β path would emit.  PAP-815 chainring-gate
// requires more row state than the pre-flight tracks and is excluded — flagged
// in the components field.
function downstreamAbstainAfterBeta({ joint, bcTc, gearRCrop }) {
  const components = {};
  // PAP-961: peakR < 0.65·aimR
  let pap961Fires = false;
  if (joint.aimR > 0 && joint.peakR > 0) {
    pap961Fires = joint.peakR < PAP961_RATIO * joint.aimR;
  }
  components.pap961 = pap961Fires;
  // PAP-553 radius-sanity: cropNormR<0.13 || (cropNormR<0.15 && bcTc>=20).
  // PAP-740 bumped 0.15→0.17 at b107 — keep 0.13/0.17 thresholds.
  const radiusSanityFires =
    gearRCrop > 0 && (gearRCrop < 0.13 || (gearRCrop < 0.17 && bcTc >= 20));
  components.radiusSanity = radiusSanityFires;
  components.pap815 = 'not_modelled';
  return {
    fires: pap961Fires || radiusSanityFires,
    components,
  };
}

// ── CSV serialization ──────────────────────────────────────────────────────
const PASS_B_CSV_COLS = [
  'stamp', 'actual', 'bcTc', 'bcPeaks',
  'current_tc', 'current_disposition',
  'alpha_committed',
  'beta_fires', 'beta_commit_tc', 'beta_commit_delta',
  'beta_outcome',
  'downstream_abstain_after_beta',
  'downstream_pap961', 'downstream_radiusSanity',
];

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvRow(obj) {
  return PASS_B_CSV_COLS.map(k => csvEscape(obj[k])).join(',');
}

// ── Test driver ────────────────────────────────────────────────────────────
describe('PAP-1485 pre-flight v6.1 (A3 + Option α v5 + Option β v6 + B6+B7+B8)', () => {
  jest.setTimeout(6 * 60 * 60 * 1000);  // 6h

  test('joint-scan + Option α + Option β preserves bypass rows and bounds per-bucket AC2 regressions', () => {
    const { rows, elapsedMs, total } = runner.runCorpus({
      scope: 'full',
      label: 'pap1485v6',
    });

    const today = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(runner.DEBUG_DIR, `pap1485_preflight_v6_${today}.log`);
    const csvPath    = path.join(runner.DEBUG_DIR, `pap1485_preflight_v6_${today}.csv`);
    const jsonPath   = path.join(runner.DEBUG_DIR, `pap1485_preflight_v6_${today}.json`);
    const lines = [];
    const pushLine = (s) => { lines.push(s); out(s); };

    pushLine('');
    pushLine('=== PAP-1485 pre-flight v6.1 (A3 + Option α v5 + Option β v6) ===');
    pushLine(`Corpus: ${rows.length}/${total} photos  Wall: ${(elapsedMs / 1000).toFixed(1)}s`);
    pushLine(`Spec v6.1 defaults: σ_R/aimR=${SIGMA_R_RATIO}, ε_abs=${EPS_ABS}, ε_floor=${EPS_FLOOR}, R=[${R_LO_RATIO},${R_HI_RATIO}]·aimR, extreme_R_abstain=off`);
    pushLine(`Option α γ_bc=${GAMMA_BC_DEFAULT} (single value, B5 grid retired); Option β=on, bcTc≥${BETA_BC_FLOOR}, conf=${BETA_CONF}`);

    // Pass A counters
    const counters = PREDICATES.map(p => ({
      name: p.name, fires: 0, broken: 0, brokenRows: [],
    }));

    // Pass B B6 — per-row enumeration + 6-bucket counts
    const passB = {
      scanned: 0,
      rows: [],   // raw row objects, also serialised to CSV
      counts: {
        rescue: 0,
        'regress_correct→CW': 0,
        'regress_abstain→CW': 0,
        regress_CW_worse_delta: 0,
        no_change_correct: 0,
        no_change_CW_same_or_better: 0,
      },
    };

    let scanned = 0;
    let jointAbstainCount = 0;
    let optionAlphaCommittedCount = 0;
    let optionBetaFiresCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const gearRCrop = row.raw && row.raw.gearRadius ? row.raw.gearRadius : 0;
      const pre = pluck(row);

      const preFires = PREDICATES.map(p => p.fn(pre, gearRCrop));
      const anyFires = preFires.some(Boolean);

      const bcSelfConfirms =
        pre.bcTc >= 30 && pre.bcTc <= MAX_TEETH &&
        Math.abs(pre.bcTc - pre.bcPeaks) <= 2 &&
        pre.rOuter > 0;

      if (!anyFires && !bcSelfConfirms) continue;

      const { rgba, w: rw, h: rh } = runner.loadOrDecodeRgba(row.photo, row.stamp);
      const gray = T.rgbaToGray(rgba, rw, rh);
      const enhanced = T.clahe(gray, rw, rh, 3.0, 8, 8);

      const aimR = 0.5 * Math.min(rw, rh);
      const gc = row.raw.gearCenter || { x: 0.5, y: 0.5 };
      const cx = Math.round(gc.x * rw);
      const cy = Math.round(gc.y * rh);
      const joint = jointScan({ enhanced, cx, cy, w: rw, h: rh, aimR });

      const alpha = evalOptionAlpha({
        joint, enhanced, cx, cy, w: rw, h: rh,
        bcTc: pre.bcTc, bcPeaks: pre.bcPeaks, rOuter: pre.rOuter,
        gamma: GAMMA_BC_DEFAULT,
      });

      const postAlphaJoint = applyOptionAlpha(joint, alpha);

      const beta = evalOptionBeta({
        alpha,
        postAlphaJoint,
        bcTc: pre.bcTc,
        bcPeaks: pre.bcPeaks,
        rOuter: pre.rOuter,
        optionBetaEnabled: true,
      });

      const finalJoint = applyOptionBeta(postAlphaJoint, beta, row.actual);
      if (finalJoint.optionAlphaCommitted) optionAlphaCommittedCount++;
      if (beta.fires) optionBetaFiresCount++;
      if (finalJoint.abstain) jointAbstainCount++;

      // ── Pass A — bypass-row guard with α+β applied ─────────────────────
      if (anyFires) {
        scanned++;
        const post = postRow(pre, finalJoint, beta);
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
                peakTc: joint.peakTc,
                peakR: joint.peakR,
                jStar: Number(joint.jStar.toFixed(4)),
                jDis:  Number(joint.jDis.toFixed(4)),
                abstain: joint.abstain,
                nCells: joint.nCells,
              },
              alpha: {
                committed: !!alpha.committed,
                gate_passed: !!alpha.gate_passed,
                J_bc_raw: Number((alpha.J_bc_raw || 0).toFixed(4)),
                J_bc: Number((alpha.J_bc || 0).toFixed(4)),
                commit_margin: Number((alpha.commit_margin || 0).toFixed(4)),
              },
              beta: {
                fires: !!beta.fires,
                commit_tc: beta.commit_tc,
                reason_blocked: beta.reason_blocked,
              },
            });
          }
        }
      }

      // ── Pass B B6 — per-row outcome bucketing over AC2 substrate ───────
      // Substrate: bcSelfConfirms ∧ rOuter > 0 (≥30 floor for ii; β-fire
      // additionally requires ≥35).  Spec §4.0 v6 prose lists this exact
      // substrate.
      if (bcSelfConfirms) {
        passB.scanned++;
        const currentTc = pre.tc;
        const betaTc = beta.fires ? beta.commit_tc : null;
        const outcome = classifyBetaOutcome({
          currentTc, betaTc, actual: row.actual,
        });
        passB.counts[outcome] = (passB.counts[outcome] || 0) + 1;

        const downstream = beta.fires
          ? downstreamAbstainAfterBeta({ joint: finalJoint, bcTc: pre.bcTc, gearRCrop })
          : { fires: false, components: { pap961: false, radiusSanity: false, pap815: 'not_modelled' } };

        const csvObj = {
          stamp: row.stamp,
          actual: row.actual,
          bcTc: pre.bcTc,
          bcPeaks: pre.bcPeaks,
          current_tc: currentTc,
          current_disposition: dispositionFor(currentTc, row.actual),
          alpha_committed: alpha.committed ? 'true' : 'false',
          beta_fires: beta.fires ? 'true' : 'false',
          beta_commit_tc: beta.commit_tc == null ? '' : beta.commit_tc,
          beta_commit_delta: beta.fires ? Math.abs(beta.commit_tc - row.actual) : '',
          beta_outcome: outcome,
          downstream_abstain_after_beta: downstream.fires ? 'true' : 'false',
          downstream_pap961: downstream.components.pap961 ? 'true' : 'false',
          downstream_radiusSanity: downstream.components.radiusSanity ? 'true' : 'false',
        };
        passB.rows.push(csvObj);
      }
    }

    // ── Pass A summary ──────────────────────────────────────────────────────
    pushLine('');
    pushLine(`-- Pass A — bypass-row guard (Option α + Option β at γ_bc=${GAMMA_BC_DEFAULT}) --`);
    pushLine(`Rows joint-scanned (≥1 bypass fired): ${scanned}/${rows.length}`);
    pushLine(`Option α committed: ${optionAlphaCommittedCount}`);
    pushLine(`Option β fired:     ${optionBetaFiresCount}`);
    pushLine(`Post (α∪β) joint abstained: ${jointAbstainCount}/${scanned || 1}`);
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

    for (const c of counters) {
      if (c.brokenRows.length === 0) continue;
      pushLine('');
      pushLine(`-- broken rows: ${c.name} --`);
      pushLine('stamp                                       actual  tc  peakTc  fft90  op  bcTc  bcPk  α-commit  β-fires  β-commit  β-reason-blocked');
      for (const br of c.brokenRows) {
        pushLine(
          `${br.stamp.padEnd(40)}  ${String(br.actual).padStart(5)}  ` +
          `${String(br.tc).padStart(2)}  ${String(br.peakTc).padStart(5)}  ` +
          `${String(br.fft90tc).padStart(5)}  ${String(br.opTc).padStart(3)}  ` +
          `${String(br.bcTc).padStart(4)}  ${String(br.bcPeaks).padStart(4)}  ` +
          `${br.alpha.committed ? 'Y' : 'N'}         ${br.beta.fires ? 'Y' : 'N'}        ` +
          `${br.beta.commit_tc == null ? ' - ' : String(br.beta.commit_tc).padStart(3)}      ` +
          `${br.beta.reason_blocked || '-'}`
        );
      }
    }

    // ── Pass B B6 summary ───────────────────────────────────────────────────
    pushLine('');
    pushLine(`-- Pass B B6 — per-row Option β outcome enumeration (v6.1) --`);
    pushLine(`Rows scanned (bcSelfConfirms ∧ rOuter>0): ${passB.scanned}/${rows.length}`);
    pushLine('');
    pushLine('outcome                                count');
    for (const [bucket, n] of Object.entries(passB.counts)) {
      pushLine(`${bucket.padEnd(38)} ${String(n).padStart(5)}`);
    }

    // Per-bucket caps
    const CAP_REGRESS_CORRECT_TO_CW    = 1;
    const CAP_REGRESS_ABSTAIN_TO_CW    = 2;
    const CAP_REGRESS_CW_WORSE_DELTA   = 1;
    const n_correct_to_CW   = passB.counts['regress_correct→CW']    || 0;
    const n_abstain_to_CW   = passB.counts['regress_abstain→CW']    || 0;
    const n_CW_worse_delta  = passB.counts['regress_CW_worse_delta'] || 0;
    const n_rescue          = passB.counts.rescue                    || 0;

    pushLine('');
    pushLine(`-- Per-bucket caps (B8) --`);
    pushLine(`regress_correct→CW:        ${n_correct_to_CW} / ≤ ${CAP_REGRESS_CORRECT_TO_CW}  ${n_correct_to_CW <= CAP_REGRESS_CORRECT_TO_CW ? 'PASS' : 'FAIL'}`);
    pushLine(`regress_abstain→CW:        ${n_abstain_to_CW} / ≤ ${CAP_REGRESS_ABSTAIN_TO_CW}  ${n_abstain_to_CW <= CAP_REGRESS_ABSTAIN_TO_CW ? 'PASS' : 'FAIL'}`);
    pushLine(`regress_CW_worse_delta:    ${n_CW_worse_delta} / ≤ ${CAP_REGRESS_CW_WORSE_DELTA}  ${n_CW_worse_delta <= CAP_REGRESS_CW_WORSE_DELTA ? 'PASS' : 'FAIL'}`);
    pushLine(`(sanity rollup, non-binding) correct→CW + abstain→CW = ${n_correct_to_CW + n_abstain_to_CW} / ≤ 2`);

    // ── v6.1 PASS gate evaluation ───────────────────────────────────────────
    const passA_pass = !anyBroken;
    const passB_correctToCW_pass = n_correct_to_CW <= CAP_REGRESS_CORRECT_TO_CW;
    const passB_abstainToCW_pass = n_abstain_to_CW <= CAP_REGRESS_ABSTAIN_TO_CW;
    const passB_worseDelta_pass  = n_CW_worse_delta <= CAP_REGRESS_CW_WORSE_DELTA;
    const passB_pass = passB_correctToCW_pass && passB_abstainToCW_pass && passB_worseDelta_pass;
    const overallPass = passA_pass && passB_pass;

    pushLine('');
    pushLine(`-- v6.1 PASS criterion (B8) --`);
    pushLine(`Pass A (0 broken across all 5 predicates):           ${passA_pass ? 'PASS' : 'FAIL'}`);
    pushLine(`Pass B regress_correct→CW ≤ ${CAP_REGRESS_CORRECT_TO_CW}:                 ${passB_correctToCW_pass ? 'PASS' : 'FAIL'}`);
    pushLine(`Pass B regress_abstain→CW ≤ ${CAP_REGRESS_ABSTAIN_TO_CW}:                 ${passB_abstainToCW_pass ? 'PASS' : 'FAIL'}`);
    pushLine(`Pass B regress_CW_worse_delta ≤ ${CAP_REGRESS_CW_WORSE_DELTA}:             ${passB_worseDelta_pass ? 'PASS' : 'FAIL'}`);

    const verdict = overallPass
      ? 'PASS — proceed to Phase-1 calibration child under PAP-1480 (6912-cell sweep)'
      : 'FAIL — file v7 round OR descope per PAP-1091 A5 hard-exit (Option γ data-ruled-out)';
    pushLine('');
    pushLine(`Verdict: ${verdict}`);
    pushLine(`Output:  ${reportPath}`);
    pushLine(`Output:  ${csvPath}`);
    pushLine(`Output:  ${jsonPath}`);

    // ── Write outputs ───────────────────────────────────────────────────────
    fs.writeFileSync(reportPath, lines.join('\n') + '\n');

    const csvLines = [PASS_B_CSV_COLS.join(',')];
    for (const r of passB.rows) csvLines.push(csvRow(r));
    fs.writeFileSync(csvPath, csvLines.join('\n') + '\n');

    const summary = {
      spec: 'pap1480_v6.1',
      corpusSize: rows.length,
      params: {
        gamma_bc: GAMMA_BC_DEFAULT,
        option_beta: 'on',
        beta_bcTc_floor: BETA_BC_FLOOR,
        beta_conf: BETA_CONF,
        sigma_R_ratio: SIGMA_R_RATIO,
        eps_abs: EPS_ABS,
        eps_floor: EPS_FLOOR,
        R_lo_ratio: R_LO_RATIO,
        R_hi_ratio: R_HI_RATIO,
      },
      passA: {
        scanned,
        jointAbstainCount,
        optionAlphaCommittedCount,
        optionBetaFiresCount,
        predicates: counters.map(c => ({
          name: c.name,
          fires: c.fires,
          broken: c.broken,
          brokenRows: c.brokenRows,
        })),
      },
      passB: {
        scanned: passB.scanned,
        counts: passB.counts,
        caps: {
          regress_correct_to_CW:    { value: n_correct_to_CW,  cap: CAP_REGRESS_CORRECT_TO_CW,  pass: passB_correctToCW_pass },
          regress_abstain_to_CW:    { value: n_abstain_to_CW,  cap: CAP_REGRESS_ABSTAIN_TO_CW,  pass: passB_abstainToCW_pass },
          regress_CW_worse_delta:   { value: n_CW_worse_delta, cap: CAP_REGRESS_CW_WORSE_DELTA, pass: passB_worseDelta_pass },
          sanity_rollup_correct_abstain_sum: { value: n_correct_to_CW + n_abstain_to_CW, cap: 2, binding: false },
        },
        rescue_count: n_rescue,
        csv_path: csvPath,
      },
      gate: {
        passA: passA_pass,
        passB_per_bucket: {
          correct_to_CW: passB_correctToCW_pass,
          abstain_to_CW: passB_abstainToCW_pass,
          CW_worse_delta: passB_worseDelta_pass,
        },
        passB_overall: passB_pass,
        overall: overallPass ? 'PASS' : 'FAIL',
      },
      verdict: overallPass ? 'PASS' : 'FAIL',
      elapsedMs,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

    expect(rows.length).toBeGreaterThan(0);
    // Verdict is a hand-off signal, not a jest failure.
  });
});
