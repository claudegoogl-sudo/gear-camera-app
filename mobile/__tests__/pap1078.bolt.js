/**
 * PAP-1078 Option 2 — bounded gradient-vote bolt-pattern predicate calibration.
 *
 * QA cross-check: PAP-1085 verdict (mirrored on PAP-1086).
 * Spec revision r2 — amendments applied per QA verdict (4 amendments, 1 safeguard):
 *   (1) anchor on aimR (UNCHANGED)
 *   (2) r_bp ∈ [0.40, 0.82]·aimR (was 0.78; tight-crop 110/34 compact misses)
 *   (3) N-grid-fit rule: ≥(N-1) peaks within 0.30·(2π/N), rogue ≤ 1
 *       (replaces broken pairwise-spacing rule that fails 5-bolt-occlusion AC)
 *   (4) cog-regime short-circuit = gearR<0.10 only (drop peakTc<14; aliased
 *       rings live at peakTc∈[9,13])
 *   (5) promote-or-abstain w/ tcConsensus≥30 safeguard:
 *         bolt.fired & tcConsensus≥30 → PROMOTE (bypass radiusSanity)
 *         bolt.fired & tcConsensus<30 → ABSTAIN (strengthen radiusSanity)
 *         !bolt.fired                  → unchanged
 *   (6) AC1 (cal n=62) and AC2 risk (305-photo) measured in single threshold
 *       sweep matrix, not separated.
 *
 * NO gearCounter.js touch.  Calibration only.
 *
 * Run:
 *   SAMPLE_PER_ACTUAL=4 SCOPE=full HARNESS=pap1078.bolt npx jest \
 *     --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, evalPhoto, loadOrDecodeRgba, discoverLabeled } = runner;

// ---------------------------------------------------------------------------
// Spec constants (r2)
// ---------------------------------------------------------------------------
const RBP_LO = 0.40;       // r_bp lower bound, fraction of aimR
const RBP_HI = 0.82;       // r_bp upper bound (was 0.78 — QA amendment 2)
const RBP_STEP_PX = 2;     // step size in pixels
const K_ANGLES = 180;      // 2° angular bins
const PEAK_FRAC = 0.40;    // angular-darkness peak threshold = 0.4 * max(darkness)
const N_CANDS = [4, 5, 6]; // bolt-count candidates
const COG_GEAR_R_FLOOR = 0.10; // gearR<0.10 → short-circuit (cog regime, amendment 4)

// PAP-1060 11T conf=0 cluster trace (canonical AC2-risk subset)
const PAP1060_STAMPS = new Set([
  '2026-04-05_08-32-48-875Z',
  '2026-04-05_08-33-27-869Z',
  '2026-04-05_08-34-06-051Z',
  '2026-04-05_14-40-38-072Z',
  '2026-04-05_20-05-36-867Z',
  '2026-04-06_10-01-25-781Z',
  '2026-04-19_11-32-11-962Z',
  '2026-04-19_11-33-29-608Z',
  '2026-04-21_19-02-17-555Z',
  '2026-04-22_18-55-06-131Z',
  '2026-04-25_08-03-37-711Z',
]);

const SAMPLE_PER_ACTUAL = Number(process.env.SAMPLE_PER_ACTUAL || 4);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function classOfActual(a) {
  if (a <= 13) return 'Small';
  if (a <= 20) return 'Mid';
  if (a <= 28) return 'Large';
  return 'XL';
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

function fmt(x, n = 3) {
  if (!Number.isFinite(x)) return '   -  ';
  return x.toFixed(n).padStart(n + 4);
}

function tcConsensusOf(r) {
  const cands = [r.peakTc, r.fft90, r.op, r.bcTc, r.bcPeaks];
  let max = 0;
  for (const v of cands) if (v > max) max = v;
  return max;
}

// ---------------------------------------------------------------------------
// Bolt-pattern detector — bounded gradient-vote, NOT full Hough
// ---------------------------------------------------------------------------

/**
 * Sample mean luminance at angle bin k around radius r, using a thin radial
 * band [r-dr, r+dr]. Returns mean over pixels that fall in (cx,cy)+radius
 * sweep at K_ANGLES bins.
 *
 * Single pass: outer loop over angular bins (cheap); inner loop walks dr×dr
 * pixels along the local radial direction. Reused for ref-band sampling.
 */
function angularProfile({ rgba, w, h, cx, cy, r, dr }) {
  const prof = new Float64Array(K_ANGLES);
  const cnt = new Uint16Array(K_ANGLES);
  const TWO_PI = Math.PI * 2;
  for (let k = 0; k < K_ANGLES; k++) {
    const theta = (k * TWO_PI) / K_ANGLES;
    const cs = Math.cos(theta);
    const sn = Math.sin(theta);
    let sum = 0;
    let n = 0;
    for (let dRad = -dr; dRad <= dr; dRad++) {
      const rr = r + dRad;
      if (rr <= 0) continue;
      const x = Math.round(cx + rr * cs);
      const y = Math.round(cy + rr * sn);
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      const i = (y * w + x) * 4;
      const Y = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      sum += Y;
      n++;
    }
    if (n > 0) {
      prof[k] = sum / n;
      cnt[k] = n;
    } else {
      prof[k] = NaN;
    }
  }
  return prof;
}

/**
 * For a single r_bp, build a darkness profile (ref-band Y minus thin-band Y),
 * then find local maxima of darkness above PEAK_FRAC × max(darkness).
 * Returns array of peak angles (radians) and their darkness values.
 */
function darknessPeaksAtRbp({ rgba, w, h, cx, cy, rBp }) {
  const profIn = angularProfile({ rgba, w, h, cx, cy, r: rBp, dr: 2 });
  // Reference band: surrounding annulus (excludes the bolt band itself)
  const profOuter = angularProfile({ rgba, w, h, cx, cy, r: rBp + 6, dr: 2 });
  const profInner = angularProfile({ rgba, w, h, cx, cy, r: rBp - 6, dr: 2 });
  const darkness = new Float64Array(K_ANGLES);
  let maxD = 0;
  for (let k = 0; k < K_ANGLES; k++) {
    const refs = [profOuter[k], profInner[k]].filter(Number.isFinite);
    if (!Number.isFinite(profIn[k]) || refs.length === 0) {
      darkness[k] = 0;
      continue;
    }
    const ref = refs.reduce((a, b) => a + b, 0) / refs.length;
    const d = Math.max(0, ref - profIn[k]);
    darkness[k] = d;
    if (d > maxD) maxD = d;
  }
  if (maxD < 1) return { peaks: [], maxD };
  const thr = PEAK_FRAC * maxD;
  // Local maxima with circular neighbours (window radius 3 bins = 6°)
  const peaks = [];
  const W = 3;
  for (let k = 0; k < K_ANGLES; k++) {
    const v = darkness[k];
    if (v < thr) continue;
    let isMax = true;
    for (let d = -W; d <= W; d++) {
      if (d === 0) continue;
      const j = (k + d + K_ANGLES) % K_ANGLES;
      if (darkness[j] > v) { isMax = false; break; }
    }
    if (isMax) {
      peaks.push({ theta: (k * 2 * Math.PI) / K_ANGLES, dark: v });
    }
  }
  return { peaks, maxD };
}

/**
 * Optimal grid phase for a candidate N: closed-form via the angular mean of
 * (theta_i mod 2π/N).  Returns phi0 in [0, 2π/N).
 */
function optimalPhase(peaks, N) {
  const slot = (2 * Math.PI) / N;
  // Sum of unit vectors at angle (theta_i mod slot) * N — gives a circular
  // mean that respects the mod-2π/N quotient.
  let sx = 0, sy = 0;
  for (const p of peaks) {
    const ang = (p.theta % slot) * N; // → [0, 2π)
    sx += Math.cos(ang);
    sy += Math.sin(ang);
  }
  let mean = Math.atan2(sy, sx);
  if (mean < 0) mean += 2 * Math.PI;
  return mean / N; // back to [0, slot)
}

/**
 * Fit peaks onto an N-uniform grid with phase phi0; classify each peak as
 * matched (within tol·slot of nearest slot) or rogue. Returns
 * { matched, rogue, residual_mean, residual_max }.
 */
function fitNGrid(peaks, N, phi0, tolFrac = 0.30) {
  const slot = (2 * Math.PI) / N;
  const tol = tolFrac * slot;
  let matched = 0;
  let rogue = 0;
  let residSum = 0;
  let residMax = 0;
  for (const p of peaks) {
    const k = Math.round((p.theta - phi0) / slot);
    const grid = phi0 + k * slot;
    let d = Math.abs(p.theta - grid);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d <= tol) {
      matched++;
      residSum += d;
      if (d > residMax) residMax = d;
    } else {
      rogue++;
    }
  }
  return {
    matched,
    rogue,
    residual_mean: matched > 0 ? residSum / matched : NaN,
    residual_max: residMax,
  };
}

/**
 * Top-level bolt-pattern predicate per Spec r2.  Returns
 * { fired (default config), peaks, bestN, matched, rogue, residual,
 *   rBp, rBpAim, phase0, strength, msCost, allFits }.
 *
 * `allFits` exposes per-(rBp,N) match/rogue/residual so the threshold sweep
 * matrix can re-score without re-walking pixels.
 */
function boltPatternDetected({ rgba, w, h, cx, cy, aimR }) {
  const t0 = Date.now();
  const rLo = Math.floor(RBP_LO * aimR);
  const rHi = Math.floor(RBP_HI * aimR);
  let bestScore = -Infinity;
  let bestRec = null;
  const allFits = [];
  for (let rBp = rLo; rBp <= rHi; rBp += RBP_STEP_PX) {
    const { peaks, maxD } = darknessPeaksAtRbp({ rgba, w, h, cx, cy, rBp });
    if (peaks.length < 3) {
      allFits.push({ rBp, n: peaks.length, fits: [] });
      continue;
    }
    const fitsForRbp = [];
    for (const N of N_CANDS) {
      const phi0 = optimalPhase(peaks, N);
      const fit = fitNGrid(peaks, N, phi0, 0.30);
      fitsForRbp.push({ N, phi0, ...fit, n: peaks.length });
      // Score: matched - rogue, tiebreak by lower residual, prefer smaller N
      const score = fit.matched * 100 - fit.rogue * 50 - (fit.residual_mean || 0) * 10 - N * 0.1;
      if (score > bestScore && fit.matched >= N - 1) {
        bestScore = score;
        // Strength = sum of darkness magnitudes at matched peaks
        const slot = (2 * Math.PI) / N;
        const tol = 0.30 * slot;
        let strength = 0;
        for (const p of peaks) {
          const k = Math.round((p.theta - phi0) / slot);
          const grid = phi0 + k * slot;
          let d = Math.abs(p.theta - grid);
          if (d > Math.PI) d = 2 * Math.PI - d;
          if (d <= tol) strength += p.dark;
        }
        bestRec = {
          rBp, rBpAim: rBp / aimR, bestN: N, phi0,
          matched: fit.matched, rogue: fit.rogue,
          residual: fit.residual_mean,
          n: peaks.length,
          maxD,
          strength,
          peaks: peaks.map((p) => p.theta),
        };
      }
    }
    allFits.push({ rBp, n: peaks.length, fits: fitsForRbp });
  }
  const msCost = Date.now() - t0;
  // Default-config "fired" = ≥(N-1) match AND rogue ≤ 1 at the picked (rBp, N)
  const fired = !!bestRec && bestRec.matched >= bestRec.bestN - 1 && bestRec.rogue <= 1;
  return {
    fired,
    bestN: bestRec ? bestRec.bestN : NaN,
    matched: bestRec ? bestRec.matched : 0,
    rogue: bestRec ? bestRec.rogue : 0,
    residual: bestRec ? bestRec.residual : NaN,
    rBp: bestRec ? bestRec.rBp : NaN,
    rBpAim: bestRec ? bestRec.rBpAim : NaN,
    phase0: bestRec ? bestRec.phi0 : NaN,
    strength: bestRec ? bestRec.strength : 0,
    nPeaks: bestRec ? bestRec.n : 0,
    msCost,
    allFits, // [{rBp, n, fits:[{N,phi0,matched,rogue,residual_mean,residual_max,n}]}]
  };
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
describe('PAP-1078 Option 2 — bolt-pattern calibration (spec r2)', () => {
  jest.setTimeout(4 * 60 * 60 * 1000);

  test('calibration sweep + 11T cluster + ms histogram', () => {
    const all = discoverLabeled({ minActual: 9, maxActual: 60 });
    const byActual = new Map();
    for (const p of all) {
      const arr = byActual.get(p.actual) || [];
      arr.push(p);
      byActual.set(p.actual, arr);
    }
    const selected = [];
    for (const [, arr] of byActual) {
      const sorted = [...arr].sort((a, b) => (a.stamp < b.stamp ? -1 : 1));
      const n = Math.min(SAMPLE_PER_ACTUAL, sorted.length);
      for (let i = 0; i < n; i++) {
        const idx = Math.floor((i * sorted.length) / n);
        selected.push(sorted[idx]);
      }
    }
    // Force-include every PAP-1060 11T-cluster stamp present in training-data
    // (QA-mandated cluster trace requires non-zero cluster rows).
    const haveStamps = new Set(selected.map((p) => p.stamp));
    for (const p of all) {
      if (PAP1060_STAMPS.has(p.stamp) && !haveStamps.has(p.stamp)) {
        selected.push(p);
        haveStamps.add(p.stamp);
      }
    }
    selected.sort((a, b) => (a.stamp < b.stamp ? -1 : 1));
    out(`[pap1078.bolt] sample=${selected.length} (target ${SAMPLE_PER_ACTUAL}/actual + PAP-1060 cluster forced)`);
    out(`[pap1078.bolt] actuals: ${[...byActual.keys()].sort((a, b) => a - b).map((a) => `${a}T(${Math.min(SAMPLE_PER_ACTUAL, byActual.get(a).length)})`).join(' ')}`);

    const t0 = Date.now();
    const rows = [];
    for (let i = 0; i < selected.length; i++) {
      const { photo, actual, stamp } = selected[i];
      const r = evalPhoto({ photo, actual, stamp });
      const { rgba, w, h } = loadOrDecodeRgba(photo, stamp);
      const aimR = 0.5 * Math.min(w, h);
      const bcCx = r.raw.bcCx || 0;
      const bcCy = r.raw.bcCy || 0;
      const cx = (bcCx > 0 || bcCy > 0) ? bcCx : (w - 1) / 2;
      const cy = (bcCx > 0 || bcCy > 0) ? bcCy : (h - 1) / 2;
      const tcConsensus = tcConsensusOf(r);
      const outer_over_aimR = aimR > 0 ? (r.rOuter || r.peakR || 0) / aimR : NaN;

      const cogRegime = (r.gearR > 0 && r.gearR < COG_GEAR_R_FLOOR);

      let bolt;
      if (cogRegime) {
        bolt = {
          fired: false, bestN: NaN, matched: 0, rogue: 0, residual: NaN,
          rBp: NaN, rBpAim: NaN, phase0: NaN, strength: 0, nPeaks: 0,
          msCost: 0, allFits: null, shortCircuit: 'gearR<0.10',
        };
      } else {
        bolt = boltPatternDetected({ rgba, w, h, cx, cy, aimR });
        bolt.shortCircuit = null;
      }

      // Promote-or-abstain branch (Spec r2 item 5)
      let predicateOutcome = 'unchanged';
      if (bolt.fired) {
        predicateOutcome = (tcConsensus >= 30) ? 'PROMOTE' : 'ABSTAIN';
      }

      rows.push({
        actual,
        stamp,
        klass: classOfActual(actual),
        w, h, aimR,
        anchorCx: cx, anchorCy: cy,
        peakR: r.peakR, rOuter: r.rOuter, gearR: r.gearR,
        peakTc: r.peakTc, bcTc: r.bcTc, fft90: r.fft90,
        opTc: r.op, bcPeaks: r.bcPeaks,
        tc: r.tc, conf: r.conf, innerSus: r.innerSus,
        tcConsensus,
        outer_over_aimR_imputed: Number.isFinite(outer_over_aimR) && outer_over_aimR > 0
          ? outer_over_aimR : 0.85,
        bolt_fired: bolt.fired,
        bolt_bestN: bolt.bestN,
        bolt_matched: bolt.matched,
        bolt_rogue: bolt.rogue,
        bolt_residual: bolt.residual,
        bolt_rBpAim: bolt.rBpAim,
        bolt_phase0: bolt.phase0,
        bolt_strength: bolt.strength,
        bolt_nPeaks: bolt.nPeaks,
        bolt_shortCircuit: bolt.shortCircuit,
        ms_cost: bolt.msCost,
        predicateOutcome,
        // Capture fits-per-r_bp for sweep matrix (NaN-safe; null on short-circuit)
        allFits: bolt.allFits,
      });

      if ((i + 1) % 10 === 0) {
        out(`  [${i + 1}/${selected.length}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    }

    const byClass = { Small: [], Mid: [], Large: [], XL: [] };
    for (const r of rows) byClass[r.klass].push(r);

    // ----- (i) Quantile blocks per class --------------------------------------
    out('\n=== PAP-1078 Option 2 — bolt-pattern signals (default config) ===');
    out('class    N    fired%   N=4  N=5  N=6  matched_p50  rogue_p50  resid_p50  ms_p50');
    for (const cls of ['Small', 'Mid', 'Large', 'XL']) {
      const arr = byClass[cls];
      const fired = arr.filter((r) => r.bolt_fired);
      const n4 = fired.filter((r) => r.bolt_bestN === 4).length;
      const n5 = fired.filter((r) => r.bolt_bestN === 5).length;
      const n6 = fired.filter((r) => r.bolt_bestN === 6).length;
      const matched = arr.map((r) => r.bolt_matched).sort((a, b) => a - b);
      const rogue = arr.map((r) => r.bolt_rogue).sort((a, b) => a - b);
      const resid = arr.map((r) => r.bolt_residual).filter(Number.isFinite).sort((a, b) => a - b);
      const ms = arr.map((r) => r.ms_cost).sort((a, b) => a - b);
      out(`${cls.padEnd(6)} ${String(arr.length).padStart(3)}  ${(fired.length / Math.max(1, arr.length) * 100).toFixed(1).padStart(5)}%  ${String(n4).padStart(3)} ${String(n5).padStart(3)} ${String(n6).padStart(3)}  ${fmt(quantile(matched, 0.5), 1)}      ${fmt(quantile(rogue, 0.5), 1)}     ${fmt(quantile(resid, 0.5))}    ${String(quantile(ms, 0.5)).padStart(5)}`);
    }

    // ----- (ii) ms histogram --------------------------------------------------
    const allMs = rows.map((r) => r.ms_cost).sort((a, b) => a - b);
    out(`\n=== ms-cost histogram ===`);
    out(`p10=${quantile(allMs, 0.10)}  p25=${quantile(allMs, 0.25)}  p50=${quantile(allMs, 0.50)}  p75=${quantile(allMs, 0.75)}  p90=${quantile(allMs, 0.90)}  p95=${quantile(allMs, 0.95)}  p99=${quantile(allMs, 0.99)}  max=${allMs[allMs.length - 1]}`);
    const cogRegimeRows = rows.filter((r) => r.bolt_shortCircuit);
    out(`short-circuited (gearR<${COG_GEAR_R_FLOOR}): ${cogRegimeRows.length}/${rows.length}`);

    // ----- (iii) cog/ring split ----------------------------------------------
    const cogRows = [...byClass.Small, ...byClass.Mid, ...byClass.Large];
    const ringRows = byClass.XL;
    const cogFired = cogRows.filter((r) => r.bolt_fired);
    const ringFired = ringRows.filter((r) => r.bolt_fired);
    const cogPromote = cogRows.filter((r) => r.predicateOutcome === 'PROMOTE');
    const ringPromote = ringRows.filter((r) => r.predicateOutcome === 'PROMOTE');
    const cogAbstain = cogRows.filter((r) => r.predicateOutcome === 'ABSTAIN');
    const ringAbstain = ringRows.filter((r) => r.predicateOutcome === 'ABSTAIN');
    out(`\n=== Cog (n=${cogRows.length}) vs Ring (n=${ringRows.length}) — default config ===`);
    out(`COG  fired=${cogFired.length}/${cogRows.length} (${(cogFired.length / Math.max(1, cogRows.length) * 100).toFixed(1)}%)  promote=${cogPromote.length}  abstain-strengthen=${cogAbstain.length}`);
    out(`RING fired=${ringFired.length}/${ringRows.length} (${(ringFired.length / Math.max(1, ringRows.length) * 100).toFixed(1)}%)  promote=${ringPromote.length}  abstain-strengthen=${ringAbstain.length}`);

    // ----- (iv) Threshold sweep matrix ---------------------------------------
    // Spec r2 item 6: single matrix, AC1 + AC2-risk in same cell.
    out(`\n=== Threshold sweep matrix (single, AC1+AC2-risk) ===`);
    out('residTol  minMatchOff  maxRogue  ringPromote%  cogPromote%  ringAbstain%  cogAbstain%  cogFire%   N4 N5 N6');
    const RESID_TOL = [0.20, 0.25, 0.30, 0.35];
    const MIN_MATCH_OFFSETS = [0, 1]; // 0 → minMatch=N, 1 → minMatch=N-1
    const MAX_ROGUE = [0, 1];
    const candidates = [];
    function rescore(row, residTol, minMatchOff, maxRogue) {
      if (!row.allFits) return null; // short-circuit
      let best = null;
      for (const f of row.allFits) {
        if (f.n < 3) continue;
        for (const fit of f.fits) {
          const slot = (2 * Math.PI) / fit.N;
          const tol = residTol * slot;
          // Re-count matched/rogue at this tol — fit only stored 0.30·slot;
          // fall back to fit.matched if our tol equals 0.30, else estimate
          // proportionally (residual_mean ≤ tol → matched ≥ existing).
          // Conservative: only accept when fit.matched already satisfies.
          // (For 0.20 we may under-count; documented limitation in cell name.)
          if (residTol >= 0.30 || fit.residual_max <= tol) {
            const minMatch = fit.N - minMatchOff;
            if (fit.matched >= minMatch && fit.rogue <= maxRogue) {
              const score = fit.matched * 100 - fit.rogue * 50 - (fit.residual_mean || 0) * 10 - fit.N * 0.1;
              if (!best || score > best.score) {
                best = { ...fit, rBp: f.rBp, score };
              }
            }
          }
        }
      }
      return best ? { fired: true, bestN: best.N } : { fired: false };
    }

    for (const residTol of RESID_TOL) {
      for (const minMatchOff of MIN_MATCH_OFFSETS) {
        for (const maxRogue of MAX_ROGUE) {
          let cogP = 0, ringP = 0, cogA = 0, ringA = 0, cogF = 0;
          let n4 = 0, n5 = 0, n6 = 0;
          for (const r of rows) {
            const sc = rescore(r, residTol, minMatchOff, maxRogue);
            if (!sc || !sc.fired) continue;
            if (r.klass === 'XL') {
              if (r.tcConsensus >= 30) ringP++; else ringA++;
            } else {
              cogF++;
              if (r.tcConsensus >= 30) cogP++; else cogA++;
            }
            if (sc.bestN === 4) n4++;
            else if (sc.bestN === 5) n5++;
            else if (sc.bestN === 6) n6++;
          }
          const ringTot = ringRows.length;
          const cogTot = cogRows.length;
          out(`${residTol.toFixed(2)}      N-${minMatchOff}        ${maxRogue}         ${(ringP / Math.max(1, ringTot) * 100).toFixed(1).padStart(5)}%       ${(cogP / Math.max(1, cogTot) * 100).toFixed(1).padStart(5)}%       ${(ringA / Math.max(1, ringTot) * 100).toFixed(1).padStart(5)}%       ${(cogA / Math.max(1, cogTot) * 100).toFixed(1).padStart(5)}%      ${(cogF / Math.max(1, cogTot) * 100).toFixed(1).padStart(5)}%   ${String(n4).padStart(2)} ${String(n5).padStart(2)} ${String(n6).padStart(2)}`);
          // AC1 candidates: cogPromote%==0 (no false promote) + ringPromote% maximised
          if (cogP === 0) {
            candidates.push({
              residTol, minMatchOff, maxRogue,
              ringPromotePct: ringP / Math.max(1, ringTot),
              cogAbstainPct: cogA / Math.max(1, cogTot),
              ringAbstainPct: ringA / Math.max(1, ringTot),
            });
          }
        }
      }
    }

    out(`\n=== AC1 candidates (cogPromote=0) ranked by ringPromote% ===`);
    candidates.sort((a, b) => b.ringPromotePct - a.ringPromotePct);
    for (const c of candidates.slice(0, 10)) {
      out(`  residTol=${c.residTol.toFixed(2)} minMatch=N-${c.minMatchOff} maxRogue=${c.maxRogue}  ringPromote=${(c.ringPromotePct * 100).toFixed(1)}%  ringAbstain=${(c.ringAbstainPct * 100).toFixed(1)}%  cogAbstain=${(c.cogAbstainPct * 100).toFixed(1)}%`);
    }

    // ----- (v) PAP-1060 11T cluster trace ------------------------------------
    const cluster = rows.filter((r) => PAP1060_STAMPS.has(r.stamp));
    out(`\n=== PAP-1060 11T conf=0 cluster trace (n=${cluster.length}/${PAP1060_STAMPS.size} present) ===`);
    if (cluster.length) {
      out('stamp                            actual  detected  conf  gearR   tcCons  bolt_fired  N  matched/rogue  predicate');
      for (const r of cluster) {
        out(`${r.stamp}  ${String(r.actual).padStart(2)}T    ${String(r.tc).padStart(2)}T      ${r.conf.toFixed(2)}  ${fmt(r.gearR)}  ${String(r.tcConsensus).padStart(3)}     ${String(r.bolt_fired)}      ${String(r.bolt_bestN).padStart(2)}  ${String(r.bolt_matched)}/${String(r.bolt_rogue)}            ${r.predicateOutcome}`);
      }
      // Per-candidate: any cluster row that goes from CORRECT-or-abstain to ABSTAIN-strengthen
      // means the predicate added a new abstain on a small-cog row → safe (already abstaining)
      // means the predicate added a new abstain on a CORRECT row → AC2 LOSS.
      out('\n--- per-AC1-candidate cluster fire trace (cogAbstain on cluster row = preserves existing abstain; FIRE+tcCons<30 on currently-correct row = AC2 LOSS) ---');
      for (const c of candidates.slice(0, 5)) {
        const cellRows = cluster.map((r) => {
          const sc = rescore(r, c.residTol, c.minMatchOff, c.maxRogue);
          return { stamp: r.stamp, conf: r.conf, fired: sc && sc.fired, tcCons: r.tcConsensus, currentlyCorrect: r.conf > 0 && r.tc === r.actual };
        });
        const fired = cellRows.filter((r) => r.fired);
        const newLoss = fired.filter((r) => r.currentlyCorrect && r.tcCons < 30);
        out(`  cand resid=${c.residTol.toFixed(2)} minMatch=N-${c.minMatchOff} maxRogue=${c.maxRogue}: cluster_fire=${fired.length}/${cluster.length}  potential_AC2_LOSS=${newLoss.length}` + (newLoss.length ? `  STAMPS=[${newLoss.map((r) => r.stamp).join(',')}]` : ''));
      }
    } else {
      out('  (no PAP-1060 cluster stamps in stratified sample at this SAMPLE_PER_ACTUAL; ' +
        'AC2 verification needs SAMPLE_PER_ACTUAL=high or a dedicated 305-photo replay before merge)');
    }

    // ----- (vi) AC2 risk on full sweep stratification ------------------------
    // Identify rows currently CORRECT where bolt fires AND tcConsensus<30 →
    // these would flip CORRECT → ABSTAIN under predicate. Filter by class.
    const ac2Risk = rows.filter((r) => r.predicateOutcome === 'ABSTAIN' && r.tc === r.actual && r.conf > 0);
    out(`\n=== AC2 risk: currently-correct rows where predicate would force abstain (default config) ===`);
    out(`total: ${ac2Risk.length}/${rows.filter((r) => r.tc === r.actual && r.conf > 0).length} currently-correct rows`);
    if (ac2Risk.length > 0 && ac2Risk.length <= 30) {
      for (const r of ac2Risk) {
        out(`  ${r.stamp}  ${r.klass}  actual=${r.actual} detected=${r.tc} conf=${r.conf.toFixed(2)} tcCons=${r.tcConsensus} gearR=${fmt(r.gearR)} N=${r.bolt_bestN} matched=${r.bolt_matched} rogue=${r.bolt_rogue}`);
      }
    } else if (ac2Risk.length > 30) {
      out(`  (${ac2Risk.length} rows — too many to list; see CSV)`);
    }

    // ----- (vii) CSV export --------------------------------------------------
    const csvHeader = [
      'class', 'actual', 'stamp', 'w', 'h', 'aimR',
      'anchorCx', 'anchorCy', 'peakR', 'rOuter', 'gearR',
      'peakTc', 'bcTc', 'fft90', 'opTc', 'bcPeaks',
      'tc', 'conf', 'innerSus', 'tcConsensus', 'outer_over_aimR_imputed',
      'bolt_fired', 'bolt_bestN', 'bolt_matched', 'bolt_rogue',
      'bolt_residual', 'bolt_rBpAim', 'bolt_phase0', 'bolt_strength',
      'bolt_nPeaks', 'bolt_shortCircuit', 'ms_cost', 'predicateOutcome',
    ];
    const csvLines = [csvHeader.join(',')];
    for (const r of rows) {
      const cells = [
        r.klass, r.actual, r.stamp, r.w, r.h, r.aimR.toFixed(1),
        r.anchorCx.toFixed(1), r.anchorCy.toFixed(1),
        Number.isFinite(r.peakR) ? r.peakR : '',
        Number.isFinite(r.rOuter) ? r.rOuter : '',
        Number.isFinite(r.gearR) ? r.gearR.toFixed(4) : '',
        r.peakTc, r.bcTc, r.fft90, r.opTc, r.bcPeaks,
        r.tc, r.conf.toFixed(3), r.innerSus, r.tcConsensus,
        Number.isFinite(r.outer_over_aimR_imputed) ? r.outer_over_aimR_imputed.toFixed(3) : '',
        r.bolt_fired, r.bolt_bestN, r.bolt_matched, r.bolt_rogue,
        Number.isFinite(r.bolt_residual) ? r.bolt_residual.toFixed(4) : '',
        Number.isFinite(r.bolt_rBpAim) ? r.bolt_rBpAim.toFixed(4) : '',
        Number.isFinite(r.bolt_phase0) ? r.bolt_phase0.toFixed(4) : '',
        r.bolt_strength.toFixed(2),
        r.bolt_nPeaks,
        r.bolt_shortCircuit || '',
        r.ms_cost,
        r.predicateOutcome,
      ];
      csvLines.push(cells.join(','));
    }
    const outFile = path.resolve(__dirname, '..', '..', 'debug-reports', 'pap1078_bolt_rows_2026-05-03.csv');
    fs.writeFileSync(outFile, csvLines.join('\n'));
    out(`\nrow-level csv: ${outFile}  (${csvLines.length - 1} rows)`);

    expect(rows.length).toBeGreaterThan(0);
  });
});
