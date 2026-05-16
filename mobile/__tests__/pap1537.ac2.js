/**
 * PAP-1537 AC2 sweep — verify chainring-abstain does NOT fire on the
 * cassette training corpus (9-28T). PAP-1536 AC2 requires zero false
 * positives: the chainring abstain UX must never surface for a true
 * cassette photo.
 *
 * PAP-1538 amendment: AC2 is measured against the same UI gate as AC1
 * (predicate B = chainringRegime ∪ {pap961, pap963, pap1059} method
 * tags). Today the union is mathematically identical to chainringRegime
 * alone because every chainring method tag carries a ≥30 channel gate,
 * so B ≡ A on this corpus; this sweep produces the empirical evidence
 * QA asked for in the PAP-1538 verdict (`Re-run pap1537.ac2 on the
 * cassette corpus to confirm the union does not introduce false
 * positives outside the regime predicate`).
 *
 * Predicates (mirror of pap1537.ac1):
 *   A. chainringRegime alone
 *      peakTc>=30 OR fft90tc>=30 OR opTc>=30 OR bcTc>=30 OR bcPeaks>=30
 *   B. union (PAP-1538 production gate)
 *      A OR methodUsed includes pap961/pap963/pap1059
 *
 * Run: HARNESS=pap1537.ac2 npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out } = runner;

function chainringRegimeFires(r) {
  return r.peakTc >= 30 || r.fft90 >= 30 || r.op >= 30
      || r.bcTc >= 30 || r.bcPeaks >= 30;
}

function chainringMethodTag(r) {
  const m = r.method || '';
  return m.includes('pap961-aim-circle-prior-abstain')
      || m.includes('pap963-campa-bolt-abstain')
      || m.includes('pap1059-chainring-tc-confirmed');
}

function chainringAbstainFires(r) {
  return chainringRegimeFires(r) || chainringMethodTag(r);
}

describe('PAP-1537 chainring-abstain AC2 sweep', () => {
  jest.setTimeout(60 * 60 * 1000);
  test('false-positive rate on cassette (9-28T) corpus', () => {
    out('\n=== PAP-1537 / PAP-1538 — chainring-abstain AC2 FP-rate sweep ===');
    out('predicate A (regime):  peakTc>=30 OR fft90tc>=30 OR opTc>=30 OR bcTc>=30 OR bcPeaks>=30');
    out('predicate B (union):   A OR methodUsed ⊇ {pap961,pap963,pap1059}  ← PAP-1538 production gate');

    const { rows } = runner.runCorpus({
      targetRange: [9, 28],
      label: 'pap1537-ac2',
      progressEvery: 50,
    });
    out(`\n[Cassette corpus] ${rows.length} photos (actual ∈ [9,28])`);

    const fpA = [];
    const fpB = [];
    for (const r of rows) {
      if (chainringRegimeFires(r)) fpA.push(r);
      if (chainringAbstainFires(r)) fpB.push(r);
    }

    const fpRateA = rows.length ? fpA.length / rows.length : 0;
    const fpRateB = rows.length ? fpB.length / rows.length : 0;
    out(`\n[A] regime alone : ${fpA.length}/${rows.length}  (${(fpRateA * 100).toFixed(2)}%)`);
    out(`[B] union (PAP-1538): ${fpB.length}/${rows.length}  (${(fpRateB * 100).toFixed(2)}%)`);

    if (fpA.length) {
      out('\n=== predicate A (regime) false-positive rows ===');
      for (const r of fpA) {
        out(`  ${r.stamp}  actual=${r.actual}  tc=${r.tc}  conf=${r.conf.toFixed(2)}  ` +
            `peak=${r.peakTc} fft90=${r.fft90} op=${r.op} bc=${r.bcTc}(pk=${r.bcPeaks})  ` +
            `m=${r.method}`);
      }
    }

    if (fpB.length > fpA.length) {
      out('\n=== rows added by method-tag union (B fires, A does not) — should be EMPTY ===');
      const added = fpB.filter((r) => !chainringRegimeFires(r));
      for (const r of added) {
        out(`  ${r.stamp}  actual=${r.actual}  tc=${r.tc}  conf=${r.conf.toFixed(2)}  ` +
            `peak=${r.peakTc} fft90=${r.fft90} op=${r.op} bc=${r.bcTc}(pk=${r.bcPeaks})  ` +
            `m=${r.method}`);
      }
    }

    out('\n=== AC2 GATE (PAP-1538 production gate is B) ===');
    out(`  [A] regime alone   FP <= 0% : ${(fpRateA * 100).toFixed(2)}% → ${fpA.length === 0 ? 'PASS' : 'FAIL'}`);
    out(`  [B] union          FP <= 0% : ${(fpRateB * 100).toFixed(2)}% → ${fpB.length === 0 ? 'PASS' : 'FAIL'}`);
    out('  [Δ B-A]            additions due to union : ' +
        `${fpB.length - fpA.length} (expected 0: method tags carry ≥30 channel gate, subset of A)`);

    expect(rows.length).toBeGreaterThan(0);
  });
});
