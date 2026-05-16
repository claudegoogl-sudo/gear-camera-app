/**
 * PAP-1537 AC1 sweep — verify chainring-abstain fire rate on the 80-photo
 * chainring (>=30T) training corpus. PAP-1536 ships an exported
 * `chainringRegime` flag from countTeeth() that drives the v1 chainring
 * abstain UX. AC1 of PAP-1536 requires the abstain to fire on ≥90% of
 * chainring-labelled photos.
 *
 * PAP-1538 amendment: cross-check #1 (id 5fc865d) measured chainringRegime
 * alone fires on only 51.2% — big-cluster 42T/52T misses have every FFT
 * channel collapsed to small-cassette range. The fix is to OR chainringRegime
 * with chainring-specific abstain method tags (pap961-aim-circle-prior-
 * abstain / pap963-campa-bolt-abstain / pap1059-chainring-tc-confirmed)
 * which fire orthogonally. The mobile UX (ResultScreen.jsx:81) ORs the two
 * predicates; this harness mirrors the same union so the AC1 gate is
 * measured against what the UI actually surfaces.
 *
 * Predicates measured per-row:
 *   A. chainringRegime alone (legacy AC1 measure — PAP-1537 baseline)
 *      peakTc>=30 OR fft90tc>=30 OR opTc>=30 OR bcTc>=30 OR bcPeaks>=30
 *   B. union (PAP-1538 production gate)
 *      A OR methodUsed includes pap961/pap963/pap1059
 *
 * The harness path (countTeethFromRgba) exposes the 5 channels on row.raw
 * and the enriched methodUsed on row.method; we recompute both here.
 *
 * Also reports per-bucket coverage to surface any chainring sizes that the
 * predicate may miss.
 *
 * Run: HARNESS=pap1537.ac1 npx jest --config mobile/__tests__/.jest.harness.config.js
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

describe('PAP-1537 chainring-abstain AC1 sweep', () => {
  jest.setTimeout(60 * 60 * 1000);
  test('fire rate on 80-photo chainring (>=30T) corpus', () => {
    out('\n=== PAP-1537 / PAP-1538 — chainring-abstain AC1 fire-rate sweep ===');
    out('predicate A (regime):  peakTc>=30 OR fft90tc>=30 OR opTc>=30 OR bcTc>=30 OR bcPeaks>=30');
    out('predicate B (union):   A OR methodUsed ⊇ {pap961,pap963,pap1059}  ← PAP-1538 production gate');

    const { rows } = runner.runCorpus({
      targetRange: [30, 60],
      label: 'pap1537-ac1',
      progressEvery: 20,
    });
    out(`\n[Chainring corpus] ${rows.length} photos (actual >= 30T)`);

    const perBucket = {};
    let firesA = 0, firesB = 0;
    const missesA = [];
    const missesB = [];
    for (const r of rows) {
      const key = r.actual;
      if (!perBucket[key]) perBucket[key] = { total: 0, firesA: 0, firesB: 0 };
      perBucket[key].total++;
      if (chainringRegimeFires(r)) {
        firesA++;
        perBucket[key].firesA++;
      } else {
        missesA.push(r);
      }
      if (chainringAbstainFires(r)) {
        firesB++;
        perBucket[key].firesB++;
      } else {
        missesB.push(r);
      }
    }

    const rateA = rows.length ? firesA / rows.length : 0;
    const rateB = rows.length ? firesB / rows.length : 0;
    out(`\n[A] regime alone : ${firesA}/${rows.length}  (${(rateA * 100).toFixed(1)}%)`);
    out(`[B] union (PAP-1538): ${firesB}/${rows.length}  (${(rateB * 100).toFixed(1)}%)`);

    out('\n=== per-bucket fire rate (A=regime / B=union) ===');
    for (const t of Object.keys(perBucket).sort((a, b) => +a - +b)) {
      const b = perBucket[t];
      out(`  ${String(t).padStart(3)}T  A=${b.firesA}/${b.total} (${(100 * b.firesA / b.total).toFixed(0)}%)` +
          `  B=${b.firesB}/${b.total} (${(100 * b.firesB / b.total).toFixed(0)}%)`);
    }

    if (missesA.length) {
      out('\n=== rows rescued by method-tag union (A miss → B fire) ===');
      const rescued = missesA.filter((r) => chainringAbstainFires(r));
      for (const r of rescued) {
        out(`  ${r.stamp}  actual=${r.actual}  tc=${r.tc}  conf=${r.conf.toFixed(2)}  ` +
            `peak=${r.peakTc} fft90=${r.fft90} op=${r.op} bc=${r.bcTc}(pk=${r.bcPeaks})  ` +
            `m=${r.method}`);
      }
    }

    if (missesB.length) {
      out('\n=== final miss rows (union DID NOT fire) ===');
      for (const r of missesB) {
        out(`  ${r.stamp}  actual=${r.actual}  tc=${r.tc}  conf=${r.conf.toFixed(2)}  ` +
            `peak=${r.peakTc} fft90=${r.fft90} op=${r.op} bc=${r.bcTc}(pk=${r.bcPeaks})  ` +
            `m=${r.method}`);
      }
    }

    out('\n=== AC1 GATE (PAP-1538 production gate is B) ===');
    out(`  [A] regime alone   >= 90% : ${(rateA * 100).toFixed(1)}% → ${rateA >= 0.9 ? 'PASS' : 'FAIL'}`);
    out(`  [B] union          >= 90% : ${(rateB * 100).toFixed(1)}% → ${rateB >= 0.9 ? 'PASS' : 'FAIL'}`);

    expect(rows.length).toBeGreaterThan(0);
  });
});
