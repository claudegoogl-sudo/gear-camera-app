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
