/**
 * PAP-774 QA cross-check for PAP-772 triple-agreement override.
 *
 * Proposed override (in `mobile/src/algorithm/gearCounter.js`):
 *   const tripleAgree = peakTc === fft90tc
 *                    && peakTc === opTc
 *                    && peakTc === r.toothCount
 *                    && peakTc > MIN_TEETH;          // > 10
 *   const innerContourSuspected = (gearRadius < 0.13
 *       || (gearRadius < 0.15 && r.toothCount >= 20)
 *       || upperBoundMismatch)
 *     && !tripleAgree;
 *
 * Cross-check goal: confirm no large-gear (actual ≥ 21T) photo in the corpus
 * has triple-method agreement at a low value (11..15) that would, under the
 * proposed override, re-introduce a confident-wrong commit.
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap774.crosscheck npx jest --config mobile/__tests__/.jest.harness.config.js
 */

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out } = runner;

const MIN_ACTUAL = 21; // Large + XL bucket coverage (chainring focus is in XL).

describe('PAP-774 triple-agreement override cross-check', () => {
  jest.setTimeout(120 * 60 * 1000);

  test('scan large/XL corpus for triple-method agreement at low values', () => {
    const { rows: base, elapsedMs } = runner.runCorpus({
      targetRange: [MIN_ACTUAL, 60],
      label: 'pap774',
      progressEvery: 10,
    });
    out(`\n[pap774] inspecting ${base.length} actual≥${MIN_ACTUAL}T photos`);

    const rows = [];
    let dangerCount = 0;
    let chainringFloorCount = 0;

    for (const r of base) {
      const peakTc = r.peakTc;
      const fft90tc = r.fft90;
      const opTc = r.op;
      const detected = r.tc;
      const tripleAgree = peakTc > 10
        && peakTc === fft90tc
        && peakTc === opTc
        && peakTc === detected;

      let tag = 'OK';
      if (tripleAgree && peakTc <= 15) {
        tag = 'DANGER_TRIPLE';
        dangerCount++;
      } else if (peakTc === 10 && fft90tc === 10) {
        tag = 'CHAINRING_FLOOR';
        chainringFloorCount++;
      }

      rows.push({
        stamp: r.stamp, actual: r.actual, detected, conf: r.conf, innerSus: r.innerSus,
        peakTc, fft90tc, opTc, method: r.method, tag,
      });
    }

    out('\n=== PAP-774 triple-agreement scan (actual ≥ 21T) ===');
    out(`Corpus: ${base.length} photos.  Wall: ${(elapsedMs / 1000).toFixed(0)}s`);
    out(`DANGER_TRIPLE   (override would commit wrong answer): ${dangerCount}`);
    out(`CHAINRING_FLOOR (peak=fft90=10, override correctly skipped): ${chainringFloorCount}`);
    out('');

    out('-- DANGER_TRIPLE rows --');
    const dangerRows = rows.filter(r => r.tag === 'DANGER_TRIPLE');
    if (dangerRows.length === 0) {
      out('  (none)');
    } else {
      for (const r of dangerRows) {
        out(`  ${r.stamp}  actual=${r.actual}T detected=${r.detected} peak=${r.peakTc} fft90=${r.fft90tc} op=${r.opTc} conf=${r.conf.toFixed(2)} method=${r.method} innerSus=${r.innerSus}`);
      }
    }
    out('');

    out('-- CHAINRING_FLOOR rows (peakTc===10 & fft90tc===10) --');
    const floorRows = rows.filter(r => r.tag === 'CHAINRING_FLOOR');
    if (floorRows.length === 0) {
      out('  (none)');
    } else {
      for (const r of floorRows) {
        out(`  ${r.stamp}  actual=${r.actual}T detected=${r.detected} peak=${r.peakTc} fft90=${r.fft90tc} op=${r.opTc} conf=${r.conf.toFixed(2)} method=${r.method}`);
      }
    }
    out('');

    out('-- All triple agreements (peak===fft90===op===toothCount, any value > MIN_TEETH) --');
    const allTripleRows = rows.filter(r =>
      r.peakTc > 10 && r.peakTc === r.fft90tc && r.peakTc === r.opTc && r.peakTc === r.detected
    );
    if (allTripleRows.length === 0) out('  (none)');
    for (const r of allTripleRows) {
      out(`  ${r.stamp}  actual=${r.actual}T detected=${r.detected} peak=${r.peakTc} fft90=${r.fft90tc} op=${r.opTc} conf=${r.conf.toFixed(2)} method=${r.method}`);
    }
    out('');

    out('-- Per-actual breakdown of triple-agreement values --');
    const byActual = new Map();
    for (const r of rows) {
      const o = byActual.get(r.actual) || { total: 0, danger: 0, floor: 0 };
      o.total++;
      if (r.tag === 'DANGER_TRIPLE') o.danger++;
      if (r.tag === 'CHAINRING_FLOOR') o.floor++;
      byActual.set(r.actual, o);
    }
    out('actual   N   DANGER  FLOOR');
    for (const a of [...byActual.keys()].sort((x, y) => x - y)) {
      const o = byActual.get(a);
      out(`  ${String(a).padStart(2)}T   ${String(o.total).padStart(3)}   ${String(o.danger).padStart(6)}  ${String(o.floor).padStart(5)}`);
    }

    expect(rows.length).toBeGreaterThan(0);
  });
});
