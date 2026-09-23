/**
 * PAP-1930 — bc-consensus dense-gate override R′: unit tests.
 *
 * QA PAP-1929 verdict 648c12bd (APPROVED) binding condition 5 (PAP-1686
 * AC2 policy: a guard's test must assert the OUTCOME the rule preserves,
 * not just that the rule fired):
 *   bcPeaks 51 -> commit 51; 21 -> abstain; 39/36 -> abstain;
 *   ordinary bcPeaks 4 -> never commits.
 *
 * Vectors lifted from the probe-8 evidence (42e7642) and the QA
 * re-derivation (9da450d): rescues sit at bcPeaks 41-51, collapses at
 * 2-39 (nearest collapse 39 = true 42T, wrong-by-3 if committed), the
 * b158 collapsed field shot read bcPeaks 21 (stays abstain), and the
 * pap474-class ordinary fires read bcPeaks 4-18.
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const {
  checkDenseChainringAbstain,
  decideDenseGateOutcome,
} = require('../src/algorithm/gearCounter').__test;

// r-field templates (analyzeImage result fields the gate reads) — same
// conventions as pap1872.gate.test.js.
const baseR = { bcTc: 0, bcPeaks: 0, peakTc: 0, fft90tc: 0, opTc: 0, contourRadius: 200 };

// A G1-tc40 fire (chainring-scale commit) — the rule that fires on device.
const g1Fire = (bcPeaks) => checkDenseChainringAbstain(42, 1.0, { ...baseR, bcTc: 42, bcPeaks, peakTc: 10, fft90tc: 10, opTc: 12, contourRadius: 165 });
// A G3 spider-lock fire — the collapsed dense subclass.
const g3Fire = (bcPeaks) => checkDenseChainringAbstain(10, 0.518, { ...baseR, bcTc: 10, bcPeaks, peakTc: 11, fft90tc: 11, opTc: 10, contourRadius: 299 });

describe('PAP-1930 R′ outcome contract (QA condition 5)', () => {
  test('bcPeaks 51 on a gate fire -> commits 51 (b158 event 058f427c class)', () => {
    const g = g1Fire(51);
    expect(g.fires).toBe(true);
    const o = decideDenseGateOutcome(g, 51, 'bc-fft+peak');
    expect(o.override).toBe(true);
    expect(o.toothCount).toBe(51);
    expect(o.abstained).toBe(false);
    expect(o.abstainReason).toBeNull();
    // condition 2: distinct method tag + sub-1.0 confidence
    expect(o.methodUsed).toBe('bc-fft+peak+bc-consensus-override');
    expect(o.confidence).toBeLessThan(1.0);
    expect(o.confidence).toBeGreaterThan(0);
  });

  test('bcPeaks 48 on a G1-tc40 fire (bcTc agrees) -> commits 48 (b158 events a730f84f / 8e7b61dd class)', () => {
    const g = checkDenseChainringAbstain(48, 0.57, { ...baseR, bcTc: 48, bcPeaks: 48, peakTc: 10, fft90tc: 10, opTc: 10, contourRadius: 129 });
    expect(g.fires).toBe(true);
    expect(g.rule).toBe('G1-tc40');
    const o = decideDenseGateOutcome(g, 48, 'multiR');
    expect(o.override).toBe(true);
    expect(o.toothCount).toBe(48);
  });

  test('bcPeaks 45 on a G2-bc40 fire (tc collapsed low) -> commits 45 — the dense-mislocalization rescue path', () => {
    // G2 fires on bcPeaks >= 40 itself, so a mislocalized dense row whose
    // methods collapsed low still reaches the override through G2-bc40.
    const g = checkDenseChainringAbstain(10, 0.6, { ...baseR, bcTc: 45, bcPeaks: 45, peakTc: 12, fft90tc: 12, opTc: 10, contourRadius: 200 });
    expect(g.fires).toBe(true);
    expect(g.rule).toBe('G2-bc40');
    const o = decideDenseGateOutcome(g, 45, 'multiR');
    expect(o.override).toBe(true);
    expect(o.toothCount).toBe(45);
    expect(o.abstained).toBe(false);
    expect(o.methodUsed).toBe('multiR+bc-consensus-override');
  });

  test('bcPeaks 21 (collapsed) -> stays abstain (b158 event 1e0b5c41 — honest-abstain property)', () => {
    const o = decideDenseGateOutcome(g1Fire(21), 21, 'bc-fft');
    expect(o.override).toBe(false);
    expect(o.abstained).toBe(true);
    expect(o.toothCount).toBe(0);
    expect(o.confidence).toBe(0);
    expect(o.abstainReason).toBe('pap1872-dense-chainring');
    expect(o.methodUsed).toBe('bc-fft+pap1872-dense-chainring-abstain');
  });

  test('bcPeaks 39 and 36 (collapse band top) -> stay abstain (39 = wrong-by-3 on true 42T)', () => {
    for (const n of [39, 36]) {
      // G1 template: tc=42 fires G1-tc40 regardless of bcPeaks (a G3 spider-lock
      // vector cannot carry bcPeaks 36-39 — G3 requires bcPeaks <= 6 by rule).
      const g = g1Fire(n);
      expect(g.fires).toBe(true);
      const o = decideDenseGateOutcome(g, n, 'bc-fft');
      expect(o.override).toBe(false);
      expect(o.abstained).toBe(true);
      expect(o.toothCount).toBe(0);
    }
  });

  test('ordinary fire with bcPeaks 4 -> never commits (pap474 10T class, QA P2)', () => {
    // G3 fire on an ordinary row: bc saw only the 4-arm spider.
    const o = decideDenseGateOutcome(g3Fire(4), 4, 'outer');
    expect(o.override).toBe(false);
    expect(o.abstained).toBe(true);
    expect(o.toothCount).toBe(0);
  });

  test('window edges: 40 and 60 commit, 39 and 61 do not (edges pinned by QA re-derivation)', () => {
    expect(decideDenseGateOutcome(g1Fire(40), 40, 'm').override).toBe(true);
    expect(decideDenseGateOutcome(g1Fire(60), 60, 'm').override).toBe(true);
    expect(decideDenseGateOutcome(g1Fire(39), 39, 'm').override).toBe(false);
    expect(decideDenseGateOutcome(g1Fire(61), 61, 'm').override).toBe(false);
  });

  test('missing/invalid bcPeaks -> abstain (never NaN commits)', () => {
    for (const v of [null, undefined, 0, NaN]) {
      const o = decideDenseGateOutcome(g1Fire(v), v, 'm');
      expect(o.override).toBe(false);
      expect(o.abstained).toBe(true);
      expect(o.toothCount).toBe(0);
    }
  });

  test('condition 1: gate did NOT fire -> decision is null (no override on non-gate paths)', () => {
    // 39T large-ordinary-chainring commit: gate spares it.
    const spared = checkDenseChainringAbstain(39, 1.0, { ...baseR, bcTc: 39, bcPeaks: 38, peakTc: 39, fft90tc: 10, opTc: 18, contourRadius: 170 });
    expect(spared.fires).toBe(false);
    expect(decideDenseGateOutcome(spared, 55, 'bc-fft')).toBeNull();
    expect(decideDenseGateOutcome(null, 55, 'bc-fft')).toBeNull();
  });
});

describe('PAP-1930 choke-point wiring mirror + payload lane', () => {
  test('both choke points call decideDenseGateOutcome with the identical tuple (drift guard)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../src/algorithm/gearCounter.js'), 'utf8');
    const calls = [...src.matchAll(/const gateOutcome = denseAbstain\.fires\n\s*\? decideDenseGateOutcome\(([^)]*)\)\n\s*: null;/g)]
      .map((m) => m[1].replace(/\s+/g, ' ').trim());
    expect(calls.length).toBe(2);
    expect(calls[0]).toBe(calls[1]);
    expect(calls[0]).toBe('denseAbstain, r.bcPeaks, methodUsed');
  });

  test('the override is only consulted INSIDE the gate branch (source-level condition 1)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../src/algorithm/gearCounter.js'), 'utf8');
    // decideDenseGateOutcome appears exactly 4 times in the source: the
    // definition + the two gate-guarded call sites + the __test export.
    expect((src.match(/decideDenseGateOutcome/g) || []).length).toBe(4);
    // and both call sites are gate-guarded (denseAbstain.fires ternary)
    expect((src.match(/\? decideDenseGateOutcome\(/g) || []).length).toBe(2);
  });

  test('production return carries the condition-4 telemetry fields (both entry points)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../src/algorithm/gearCounter.js'), 'utf8');
    // bcTc on the countTeeth return (was countTeethFromRgba-only before —
    // the b158 payload gap that made R unimplementable).
    expect((src.match(/bcTc: r\.bcTc \?\? null,/g) || []).length).toBe(1);
    expect((src.match(/bcPeakProm: r\.bcPeakProm \?\? null,/g) || []).length).toBe(2);
    expect((src.match(/denseGateOverride,/g) || []).length).toBe(2);
  });

  test('CameraScreen algoDiagBlock carries bcTc + bcPeakProm + denseGateOverride into the device payload', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../src/screens/CameraScreen.jsx'), 'utf8');
    const i = src.indexOf('const algoDiagBlock = {');
    const block = src.slice(i, src.indexOf('};', i));
    expect(block).toContain('bcTc: result.bcTc ?? null');
    expect(block).toContain('bcPurity: result.bcPurity ?? null');
    expect(block).toContain('bcPeakProm: result.bcPeakProm ?? null');
    expect(block).toContain('denseGateOverride: result.denseGateOverride ?? false');
  });
});
