/**
 * PAP-1872 — dense-chainring honest-abstain gate: unit tests.
 *
 * Vectors are lifted from the committed corpus dump
 * (debug-reports/pap1872_dense_abstain_2026-09-11/feature_rows.json) —
 * each "fires" vector is a real dense row, each "spares" vector a real
 * ordinary row (or the two 20T capture anchors).
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const { checkDenseChainringAbstain } = require('../src/algorithm/gearCounter').__test;

// r-field templates (analyzeImage result fields the gate reads)
const baseR = { bcTc: 0, bcPeaks: 0, peakTc: 0, fft90tc: 0, opTc: 0, contourRadius: 200 };

describe('PAP-1872 dense-chainring abstain gate', () => {
  test('G1: chainring-scale commit (tc >= 40) abstains', () => {
    // 2026-04-13_05-33-15 42T committed 42 via bc-consensus+peak
    expect(checkDenseChainringAbstain(42, 1.0, { ...baseR, bcTc: 42, bcPeaks: 42, peakTc: 10, fft90tc: 10, opTc: 12, contourRadius: 165 }).fires).toBe(true);
    expect(checkDenseChainringAbstain(40, 0.5, baseR).fires).toBe(true);
  });

  test('G1 boundary: 39T commit does NOT fire (large ordinary chainring stays)', () => {
    expect(checkDenseChainringAbstain(39, 1.0, { ...baseR, bcTc: 39, bcPeaks: 38, peakTc: 39, fft90tc: 10, opTc: 18, contourRadius: 170 }).fires).toBe(false);
  });

  test('G2: bc channel resolving chainring scale (>= 40) abstains', () => {
    // dense 48T collapsed FFT with bc-consensus 48
    expect(checkDenseChainringAbstain(48, 0.57, { ...baseR, bcTc: 48, bcPeaks: 47, peakTc: 10, fft90tc: 10, opTc: 10, contourRadius: 129 }).fires).toBe(true);
    // bcPeaks alone at chainring scale also fires
    expect(checkDenseChainringAbstain(12, 0.4, { ...baseR, bcTc: 11, bcPeaks: 41, peakTc: 11, fft90tc: 11, opTc: 12, contourRadius: 160 }).fires).toBe(true);
  });

  test('G2 spares: true small cog whose bc reads true scale', () => {
    // true 14T: bc-consensus+peak 14/14 (corpus row 52-class twin zone)
    expect(checkDenseChainringAbstain(14, 1.0, { ...baseR, bcTc: 14, bcPeaks: 14, peakTc: 14, fft90tc: 20, opTc: 26, contourRadius: 198 }).fires).toBe(false);
  });

  test('G3: spider-lock collapse on a large gear abstains', () => {
    // dense 42T -> 10T, bc saw only the 4-arm spider, contourR 299
    expect(checkDenseChainringAbstain(10, 0.518, { ...baseR, bcTc: 10, bcPeaks: 4, peakTc: 11, fft90tc: 11, opTc: 10, contourRadius: 299 }).fires).toBe(true);
    // boundary: contourRadius exactly 170 fires
    expect(checkDenseChainringAbstain(11, 0.4, { ...baseR, bcTc: 10, bcPeaks: 4, peakTc: 11, fft90tc: 11, opTc: 12, contourRadius: 170 }).fires).toBe(true);
    // true 11T at contourRadius 166 stays (corpus row: correct conf 1.0)
    expect(checkDenseChainringAbstain(11, 1.0, { ...baseR, bcTc: 10, bcPeaks: 4, peakTc: 11, fft90tc: 11, opTc: 11, contourRadius: 166 }).fires).toBe(false);
    // QA PAP-1874 flag 1 hardening: conf <= 0.7 required — a high-confidence
    // correct small-cog commit survives even when contourR crosses 170
    // (device framing variance / the "move closer" retry hint).
    expect(checkDenseChainringAbstain(11, 1.0, { ...baseR, bcTc: 10, bcPeaks: 4, peakTc: 11, fft90tc: 11, opTc: 11, contourRadius: 175 }).fires).toBe(false);
    // boundary: conf exactly 0.7 still fires; 0.71 does not
    expect(checkDenseChainringAbstain(11, 0.7, { ...baseR, bcTc: 10, bcPeaks: 4, peakTc: 11, fft90tc: 11, opTc: 12, contourRadius: 170 }).fires).toBe(true);
    expect(checkDenseChainringAbstain(11, 0.71, { ...baseR, bcTc: 10, bcPeaks: 4, peakTc: 11, fft90tc: 11, opTc: 12, contourRadius: 170 }).fires).toBe(false);
  });

  test('G4: full FFT collapse with op-only >= 20T commit at conf >= 0.35 abstains', () => {
    // dense 52T -> 20T, peak/fft90 at floor, op committed, conf 0.657
    expect(checkDenseChainringAbstain(20, 0.657, { ...baseR, bcTc: 10, bcPeaks: 12, peakTc: 10, fft90tc: 10, opTc: 20, contourRadius: 299 }).fires).toBe(true);
    // conf 0.34 does not (collapsed low-conf rows belong to earlier gates)
    expect(checkDenseChainringAbstain(20, 0.34, { ...baseR, bcTc: 10, bcPeaks: 12, peakTc: 10, fft90tc: 10, opTc: 20, contourRadius: 299 }).fires).toBe(false);
  });

  test('G4 spares: true 20T anchors (b151 abstain bug stays dead)', () => {
    // pap1862 captureA: everything reads 20, conf 1.0
    expect(checkDenseChainringAbstain(20, 1.0, { ...baseR, bcTc: 20, bcPeaks: 20, peakTc: 20, fft90tc: 20, opTc: 10, contourRadius: 329 }).fires).toBe(false);
    // pap1862 captureB
    expect(checkDenseChainringAbstain(20, 1.0, { ...baseR, bcTc: 20, bcPeaks: 20, peakTc: 20, fft90tc: 20, opTc: 21, contourRadius: 350 }).fires).toBe(false);
  });

  test('G4 spares: true 12T cog (pixel-twin of the unresolvable dense subclass)', () => {
    // true 12T, all channels agree, small radius
    expect(checkDenseChainringAbstain(12, 1.0, { ...baseR, bcTc: 12, bcPeaks: 12, peakTc: 13, fft90tc: 10, opTc: 11, contourRadius: 151 }).fires).toBe(false);
  });

  test('already-abstained rows (tc = 0) never fire the gate', () => {
    expect(checkDenseChainringAbstain(0, 0, { ...baseR, bcTc: 50, bcPeaks: 50, contourRadius: 300 }).fires).toBe(false);
  });

  test('rule attribution is returned for telemetry/grep', () => {
    expect(checkDenseChainringAbstain(42, 1.0, baseR).rule).toBe('G1-tc40');
    expect(checkDenseChainringAbstain(12, 0.4, { ...baseR, bcPeaks: 41 }).rule).toBe('G2-bc40');
    expect(checkDenseChainringAbstain(11, 0.4, { ...baseR, bcPeaks: 4, contourRadius: 200 }).rule).toBe('G3-spider-lock');
    expect(checkDenseChainringAbstain(22, 0.5, { ...baseR, peakTc: 10, fft90tc: 10, opTc: 22, contourRadius: 290 }).rule).toBe('G4-fft-collapse-op-commit');
    expect(checkDenseChainringAbstain(14, 1.0, { ...baseR, bcTc: 14, bcPeaks: 14 }).rule).toBeNull();
  });
});

// ── PAP-1900 collapse guards (G5/G6) — PENDING QA sign-off (subtask PAP-1902)
// Session vectors are the algoDiag values from
// debug-reports/pap1897_fp5_b153_session_2026-09-11/ (audit-verdicts.json).
describe('PAP-1900 G5 radial-anchor disagreement', () => {
  const rr = (peakR, rOuter) => Math.abs(peakR - rOuter) / rOuter;

  test('fires: 50T→24T fft90-fallback alias (af9294fe: rr=0.212, conf=0.328)', () => {
    // real 50T, contour locked 10-12% high on a spider arm; count aliased
    const r = { ...baseR, bcTc: 24, bcPeaks: 15, peakTc: 12, fft90tc: 24, opTc: 12,
      contourRadius: 357, peakR: 335, rOuter: 425 };
    expect(checkDenseChainringAbstain(24, 0.3281, r).rule).toBe('G5-radial-anchor-conf');
  });

  test('conf cap boundary: conf 0.35 fires, conf 0.36 does not', () => {
    const r = { ...baseR, peakTc: 12, fft90tc: 24, bcTc: 24, bcPeaks: 15,
      contourRadius: 357, peakR: 335, rOuter: 425 };
    expect(checkDenseChainringAbstain(24, 0.35, r).fires).toBe(true);
    expect(checkDenseChainringAbstain(24, 0.36, r).fires).toBe(false);
  });

  test('rr boundary: just under 0.18 does not fire (corpus a=11 tc=24 conf=0.309 row)', () => {
    // 76/425 = 0.1788 — nearest under-threshold wrong row keeps its commit
    // (known residual risk class, documented in the QA subtask)
    const r = { ...baseR, peakTc: 24, fft90tc: 24, bcTc: 24, bcPeaks: 15,
      contourRadius: 357, peakR: 349, rOuter: 425 };
    expect(rr(349, 425)).toBeLessThan(0.18);
    expect(checkDenseChainringAbstain(24, 0.309, r).fires).toBe(false);
  });

  test('conf cap is load-bearing: captureB analog (rr=0.835, conf=1.0) does not fire', () => {
    const r = { ...baseR, bcTc: 20, bcPeaks: 20, peakTc: 20, fft90tc: 20, opTc: 21,
      contourRadius: 350, peakR: 750, rOuter: 408 };
    expect(rr(750, 408)).toBeGreaterThan(0.18);
    expect(checkDenseChainringAbstain(20, 1.0, r).fires).toBe(false);
  });

  test('missing radial fields (peakR/rOuter absent) never fire G5', () => {
    expect(checkDenseChainringAbstain(24, 0.3, { ...baseR, bcTc: 24, bcPeaks: 15 }).fires).toBe(false);
  });
});

describe('PAP-1900 G6 inner-contour numeric commit', () => {
  const rrQuiet = { ...baseR, peakTc: 11, fft90tc: 11, bcTc: 11, bcPeaks: 10,
    contourRadius: 91, peakR: 300, rOuter: 300 }; // rr = 0 → G5 quiet

  test('fires: 52T→13T conf-0 ics commit (f5886a84)', () => {
    // radial fields disagree wildly (rr=1.117) so G5 also fires — assert
    // attribution on the rr-quiet vector, then fires on the real one
    const rrReal = { ...baseR, bcTc: 13, bcPeaks: 1, peakTc: 13, fft90tc: 12,
      opTc: 12, contourRadius: 169, peakR: 163, rOuter: 77 };
    expect(checkDenseChainringAbstain(13, 0, rrReal, true).fires).toBe(true);
    expect(checkDenseChainringAbstain(11, 0, rrQuiet, true).rule).toBe('G6-inner-contour-commit');
  });

  test('fires: 36T→11T conf-0 budget-exhausted ics commit (f3a8e88a)', () => {
    expect(checkDenseChainringAbstain(11, 0, rrQuiet, true).fires).toBe(true);
  });

  test('spares: ics but conf > 0 (upstream did not distrust the commit)', () => {
    expect(checkDenseChainringAbstain(11, 0.2, rrQuiet, true).fires).toBe(false);
  });

  test('spares: conf-0 numeric commit with ics=false (fiveWay/fft90OuterRescue class)', () => {
    // all channels agree at 36 (fiveWayChainringAgree shape), ics=false
    const fiveWay = { ...baseR, peakTc: 36, fft90tc: 36, opTc: 36, bcTc: 36, bcPeaks: 36,
      contourRadius: 200, peakR: 300, rOuter: 300 };
    expect(checkDenseChainringAbstain(36, 0, fiveWay, false).fires).toBe(false);
  });

  test('spares: 20T anchors with ics=true but conf=1', () => {
    expect(checkDenseChainringAbstain(20, 1.0, { ...baseR, peakR: 345, rOuter: 407 }, true).fires).toBe(false);
  });
});
