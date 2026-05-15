/**
 * PAP-1480 v2 §4.0 / A3 — pre-flight bypass-row guard.
 * v4 (PAP-1491, QA #3 verdict): adds B3 instrumentation block per broken row
 * — `J_bc_raw = S_rel(rOuter, bcTc)·P(rOuter)` and the smallest γ_bc on the
 * v4 grid {1.0, 1.3, 1.6, 2.0} that would substitute / commit Option α v4.
 * Pure read-only diagnostic; Option α v4 substitution itself is NOT applied
 * here — that wiring lands after QA cross-check #4 APPROVED.
 *
 * Hard-exit gate before the Phase-1 calibration sweep (PAP-1485 child).  For
 * every photo in the union corpus (PAP-760 ∪ PAP-796 ∪ PAP-939 ∪ PAP-1052,
 * ~305 rows) we:
 *
 *   1. Run the live algorithm via runner.evalPhoto → record the row state the
 *      bypass predicates currently see (peakTc/fft90tc/opTc/bcTc/bcPeaks/peakR/
 *      rOuter/methodUsed/toothCount/confidence/gearRadius).
 *   2. Replay each of the five active bypass predicates (PAP-861 bc-isolated /
 *      PAP-868 fft90-XL-rescue / PAP-885 5-way-agree / PAP-889 xl-center-
 *      collapse / PAP-1059 chainring-tc-confirmed) — mirrored verbatim from
 *      gearCounter.js' countTeethFromRgba post-processing block.
 *   3. For every row where ≥1 predicate fires, run the inline joint-scan
 *      simulator using spec v2 §3 defaults (σ_R/aimR=0.20, ε_abs=0.020,
 *      ε_floor=0.08, R-band [0.40,1.10]·aimR, extreme_R_abstain=off) →
 *      (jointPeakTc, jointPeakR, J*, J_dis).
 *   4. Clone the row, substitute peakTc/peakR with the joint-scan output,
 *      re-evaluate each bypass predicate → bypassFires_post.
 *   5. Hard-exit: PASS if zero rows have bypassFires=true AND
 *      bypassFires_post=false.  Otherwise FAIL — predicate revision required
 *      before Phase-1 sweep can be filed.
 *
 * NO `gearCounter.js` edit.  Lazy-imports __test.{sampleIntensityRing,clahe,
 * rgbaToGray} for the inline simulator.
 *
 * Output:
 *   debug-reports/pap1485_preflight_<DATE>.log    human-readable
 *   debug-reports/pap1485_preflight_<DATE>.json   structured summary
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
    return { abstain: true, peakTc: 0, peakR: 0, jStar: 0, jDis: 0, nCells: 0 };
  }
  const step = Math.max(2, Math.floor((Rhi - Rlo) / 32));
  const radii = [];
  for (let r = Rlo; r <= Rhi; r += step) {
    if (r >= 10 && r < maxRGeom) radii.push(r);
  }
  if (radii.length === 0) {
    return { abstain: true, peakTc: 0, peakR: 0, jStar: 0, jDis: 0, nCells: 0 };
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
    return { abstain: true, peakTc: 0, peakR: 0, jStar: 0, jDis: 0, nCells: 0, cells: [] };
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
    cells,        // exposed for B3 (per-row J_bc_raw / gamma_eff diagnostic)
    aimR,         // exposed for B3 (P(rOuter) recomputation)
    sigmaR: aimR > 0 ? SIGMA_R_RATIO * aimR : 1,
  };
}

// ── B3 instrumentation (per QA cross-check #3 / spec v4 §4.0) ──────────────
// For each row where ≥1 bypass predicate fires, compute the bc-cell pre-boost
// score `J_bc_raw = S_rel(rOuter, bcTc) · P(rOuter)` and derive the smallest
// γ_bc on the v4 grid {1.0, 1.3, 1.6, 2.0} that would (a) substitute (J_bc≥J*)
// and (b) commit (J_bc-J_dis_new≥ε_abs AND J_bc≥ε_floor).  Pure read-only
// diagnostic — Option α v4 substitution is NOT applied to `joint` here; that
// wiring lands after QA cross-check #4 APPROVED.
const GAMMA_BC_GRID_V4 = [1.0, 1.3, 1.6, 2.0];

function bcDiagAt({ joint, enhanced, cx, cy, w, h, R_bc, bcTc }) {
  if (!Number.isFinite(bcTc) || bcTc < MIN_TEETH || bcTc > MAX_TEETH) return null;
  if (!(R_bc > 0)) return null;
  const { aimR, sigmaR, jStar, peakTc: tcStar, cells } = joint;
  const Rint = Math.round(R_bc);
  const maxRGeom = Math.floor(Math.min(cx, w - cx, cy, h - cy)) - 1;
  if (Rint < 10 || Rint >= maxRGeom) return null;

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

  // Post-substitution disagree: max J over §3.2 grid cells with |tc - bcTc| > 2
  let jDisBc = 0;
  for (const c of cells) {
    if (Math.abs(c.tc - bcTc) > 2 && c.J > jDisBc) jDisBc = c.J;
  }

  // γ thresholds — use J_bc_raw > 0 guard
  const gammaSubstMin = J_bc_raw > 0 ? jStar / J_bc_raw : Infinity;
  const gammaCommitMin = J_bc_raw > 0
    ? Math.max((jDisBc + EPS_ABS) / J_bc_raw, EPS_FLOOR / J_bc_raw)
    : Infinity;

  // Smallest grid γ that meets each threshold
  const pickGrid = (thr) => {
    for (const g of GAMMA_BC_GRID_V4) if (g >= thr) return g;
    return null; // > 2.0 → off-grid
  };
  const gammaSubstGrid = pickGrid(gammaSubstMin);
  const gammaCommitGrid = pickGrid(gammaCommitMin);

  // v4 gate (B1)
  const gatePassedV4 = Number.isFinite(tcStar)
    ? Math.abs(bcTc - tcStar) > 2 && bcTc >= 30 && R_bc > 0
    : false;

  return {
    R_bc: Rint,
    bcTc,
    sRel: Number(sRel.toFixed(4)),
    P: Number(P.toFixed(4)),
    J_bc_raw: Number(J_bc_raw.toFixed(4)),
    jDisBc: Number(jDisBc.toFixed(4)),
    gammaSubstMin: Number(gammaSubstMin.toFixed(3)),
    gammaCommitMin: Number(gammaCommitMin.toFixed(3)),
    gammaSubstGrid,
    gammaCommitGrid,
    gatePassedV4,
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
  // Substitute peakTc/peakR with joint-scan output.  Approximate tc: when the
  // original tc was driven by peakTc, follow joint-scan; otherwise leave it
  // alone (other methods could still carry it).  Documented in file header.
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
describe('PAP-1487 — PAP-1485 pre-flight bypass-row guard (A3)', () => {
  jest.setTimeout(60 * 60 * 1000);

  test('joint-scan simulator preserves every active bypass-row', () => {
    const { rows, elapsedMs, total } = runner.runCorpus({
      scope: 'full',     // union corpus is the full labeled set
      label: 'pap1485',
    });

    const today = new Date().toISOString().slice(0, 10);
    const reportPath = path.join(runner.DEBUG_DIR, `pap1485_preflight_${today}.log`);
    const jsonPath   = path.join(runner.DEBUG_DIR, `pap1485_preflight_${today}.json`);
    const lines = [];
    const pushLine = (s) => { lines.push(s); out(s); };

    pushLine('');
    pushLine('=== PAP-1485 pre-flight bypass-row guard (A3) ===');
    pushLine(`Corpus: ${rows.length}/${total} photos  Wall: ${(elapsedMs / 1000).toFixed(1)}s`);
    pushLine(`Spec v2 defaults: σ_R/aimR=${SIGMA_R_RATIO}, ε_abs=${EPS_ABS}, ε_floor=${EPS_FLOOR}, R=[${R_LO_RATIO},${R_HI_RATIO}]·aimR, extreme_R_abstain=off`);

    const counters = PREDICATES.map(p => ({
      name: p.name, fires: 0, broken: 0, brokenRows: [],
    }));
    let scanned = 0, jointAbstainCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const gearRCrop = row.raw && row.raw.gearRadius ? row.raw.gearRadius : 0;
      const pre = pluck(row);

      const preFires = PREDICATES.map(p => p.fn(pre, gearRCrop));
      const anyFires = preFires.some(Boolean);
      if (!anyFires) continue;

      scanned++;
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
      if (joint.abstain) jointAbstainCount++;

      const post = postRow(pre, joint);
      const postFires = PREDICATES.map(p => p.fn(post, gearRCrop));

      // B3 diagnostic — compute once per joint-scanned row (cheap; only fires
      // when bcTc is in [MIN_TEETH, MAX_TEETH] and rOuter > 0).
      const bcDiag = bcDiagAt({
        joint, enhanced, cx, cy, w: rw, h: rh,
        R_bc: pre.rOuter, bcTc: pre.bcTc,
      });

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
            bcDiag, // B3: J_bc_raw, gammaSubstMin, gammaCommitMin, gatePassedV4 (null if bcTc/rOuter invalid)
          });
        }
      }

      // Also tally the predicates that did NOT fire on pre but the row is in
      // scope for diagnostics; this is just the counter increment above.
    }

    pushLine('');
    pushLine(`Rows joint-scanned (≥1 bypass fired): ${scanned}/${rows.length}`);
    pushLine(`Joint-scan abstained: ${jointAbstainCount}/${scanned || 1}`);
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
      }
      // B3 instrumentation block (per QA cross-check #3 / spec v4 §4.0)
      const bcRows = c.brokenRows.filter(br => br.bcDiag != null);
      if (bcRows.length > 0) {
        pushLine('');
        pushLine(`   B3 (Option α v4 diag, per row):  γ grid = {${GAMMA_BC_GRID_V4.join(', ')}}`);
        pushLine('   stamp                                       bcTc  R_bc  S_rel    P     J_bc_raw  jDisBc   γ_subst_min  γ_commit_min  γ_subst_grid  γ_commit_grid  gateV4');
        for (const br of bcRows) {
          const d = br.bcDiag;
          pushLine(
            `   ${br.stamp.padEnd(40)}  ${String(d.bcTc).padStart(4)}  ` +
            `${String(d.R_bc).padStart(4)}  ${d.sRel.toFixed(4).padStart(6)}  ` +
            `${d.P.toFixed(4).padStart(6)}  ${d.J_bc_raw.toFixed(4).padStart(8)}  ` +
            `${d.jDisBc.toFixed(4).padStart(7)}  ${String(d.gammaSubstMin).padStart(11)}  ` +
            `${String(d.gammaCommitMin).padStart(12)}  ${String(d.gammaSubstGrid ?? '>2.0').padStart(12)}  ` +
            `${String(d.gammaCommitGrid ?? '>2.0').padStart(13)}  ${d.gatePassedV4 ? 'Y' : 'N'}`
          );
        }
      }
    }

    pushLine('');
    const verdict = anyBroken
      ? 'FAIL — ≥1 broken bypass row → revise predicate before Phase-1 sweep'
      : 'PASS — zero broken bypass rows → proceed to Phase-1 calibration child';
    pushLine(`Verdict: ${verdict}`);
    pushLine(`Output:  ${reportPath}`);
    pushLine(`Output:  ${jsonPath}`);

    const summary = {
      spec: 'pap1480_v2_defaults',
      corpusSize: rows.length,
      scanned,
      jointAbstainCount,
      verdict: anyBroken ? 'FAIL' : 'PASS',
      elapsedMs,
      predicates: counters.map(c => ({
        name: c.name,
        fires: c.fires,
        broken: c.broken,
        brokenRows: c.brokenRows,
      })),
    };
    fs.writeFileSync(reportPath, lines.join('\n') + '\n');
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

    expect(rows.length).toBeGreaterThan(0);
    // Do NOT fail the jest run on verdict=FAIL — the spec uses FAIL as a
    // hand-off signal, not a test failure.  AE inspects the report; QA reads
    // the verdict on the PAP-1485 thread.
  });
});
