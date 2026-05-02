/**
 * PAP-796 QA cross-check measurement harness.
 *
 * For every labeled photo, classifies the row against Option E
 * (bc-strong-disagree):
 *   bcStrongAgree = bcTc === bcPeaks
 *                  && |bcTc - peakTc| > THRESH
 *                  && toothCount === bcTc
 *                  && bcTc > MIN_TEETH
 *
 * Sweeps THRESH ∈ {5,6,8,10,15} and prints WIN/LOSS rows.
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970). The Option E
 * predicate fires across the entire 9-60T span, so the targetRange is set to
 * [9, 60] — under SCOPE=targeted this still produces the legacy full-corpus
 * sweep; under SCOPE=full it is identical.
 *
 * Run:
 *   SCOPE=full HARNESS=pap796.crosscheck npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out } = runner;

const MIN_TEETH = 10;
const THRESHOLDS = [5, 6, 8, 10, 15];
const KLASSES = ['Small', 'Mid', 'Large', 'XL'];

describe('PAP-796 Option E cross-check', () => {
  jest.setTimeout(60 * 60 * 1000);

  test('measure bc-strong-disagree override on 9-60T corpus', () => {
    const { rows: base, elapsedMs } = runner.runCorpus({
      targetRange: [9, 60],
      label: 'pap796',
    });

    // Enrich each row with PAP-796-specific predicate state.
    const rows = base.map((r) => {
      const tripleAgree = r.peakTc > MIN_TEETH
        && r.peakTc === r.fft90 && r.peakTc === r.op && r.peakTc === r.tc;
      const isAbstain = r.innerSus || r.conf === 0;
      const bcSelf = r.bcTc > 0 && r.bcTc === r.bcPeaks;
      const bcCommitted = r.tc === r.bcTc;
      const dPeakBc = Math.abs(r.bcTc - r.peakTc);
      return Object.assign({}, r, {
        tripleAgree, isAbstain, bcSelf, bcCommitted, dPeakBc,
      });
    });

    const fmt = (r) => `${r.stamp}  cls=${r.klass} actual=${r.actual} tc=${r.tc} ` +
      `conf=${r.conf.toFixed(2)} peak=${r.peakTc} fft90=${r.fft90} op=${r.op} ` +
      `bcTc=${r.bcTc} bcPk=${r.bcPeaks} dPB=${r.dPeakBc} ` +
      `gR=${r.gearR.toFixed(3)} innerSus=${r.innerSus} tripleAgree=${r.tripleAgree} ` +
      `method=${r.method}`;

    out('\n=== PAP-796 Option E (bc-strong-disagree) cross-check ===');
    out(`Corpus: ${rows.length} photos.  Wall: ${(elapsedMs / 1000).toFixed(0)}s`);

    // ── 1. Per-class baseline ───────────────────────────────────────────
    out('\n-- Per-class baseline --');
    for (const k of KLASSES) {
      const sub = rows.filter((r) => r.klass === k);
      const correct = sub.filter((r) => r.within1 && r.conf > 0).length;
      const wrong = sub.filter((r) => !r.within1 && r.conf > 0 && !r.innerSus).length;
      const abstain = sub.filter((r) => r.isAbstain).length;
      out(`  ${k}: n=${sub.length} correct=${correct} (${(100 * correct / Math.max(1, sub.length)).toFixed(1)}%) ` +
          `wrong=${wrong} abstain=${abstain}`);
    }

    // ── 2. Threshold sweep ──────────────────────────────────────────────
    out('\n-- Option E threshold sweep (THRESH = |bcTc - peakTc| >) --');
    out('thresh | wins(±1) | losses(>±1) | new_wrong_committed | by_class W/L');
    const sweepRows = {};
    for (const T of THRESHOLDS) {
      let wins = 0, losses = 0;
      const cw = { Small: [0, 0], Mid: [0, 0], Large: [0, 0], XL: [0, 0] };
      const winRows = [], lossRows = [];
      for (const r of rows) {
        const bcStrong = r.bcSelf && r.bcCommitted && r.bcTc > MIN_TEETH && r.dPeakBc > T;
        if (r.isAbstain && bcStrong && !r.tripleAgree) {
          if (r.within1) { wins++; cw[r.klass][0]++; winRows.push(r); }
          else { losses++; cw[r.klass][1]++; lossRows.push(r); }
        }
      }
      sweepRows[T] = { wins, losses, cw, winRows, lossRows };
      const cwStr = KLASSES.map((k) => `${k} ${cw[k][0]}/${cw[k][1]}`).join('  ');
      out(`  ${String(T).padStart(2)}    | ${String(wins).padStart(7)}  | ${String(losses).padStart(10)}  | ${String(losses).padStart(18)}  | ${cwStr}`);
    }

    // ── 3. WIN/LOSS rows for primary T=5 ───────────────────────────────
    out('\n-- Option E (THRESH > 5) WIN rows --');
    if (sweepRows[5].winRows.length === 0) out('  (none)');
    for (const r of sweepRows[5].winRows) out('  ' + fmt(r));

    out('\n-- Option E (THRESH > 5) LOSS rows --');
    if (sweepRows[5].lossRows.length === 0) out('  (none)');
    for (const r of sweepRows[5].lossRows) out('  ' + fmt(r));

    // ── 4. 5→10 tightening deltas ───────────────────────────────────────
    out('\n-- Rows that DROP OUT when tightening 5→10 (no longer triggered) --');
    const w10 = new Set(sweepRows[10].winRows.map((r) => r.stamp));
    const l10 = new Set(sweepRows[10].lossRows.map((r) => r.stamp));
    const droppedWins = sweepRows[5].winRows.filter((r) => !w10.has(r.stamp));
    const droppedLosses = sweepRows[5].lossRows.filter((r) => !l10.has(r.stamp));
    out(`  Wins lost when raising threshold to >10 (${droppedWins.length}):`);
    for (const r of droppedWins) out('    ' + fmt(r));
    out(`  Losses avoided when raising threshold to >10 (${droppedLosses.length}):`);
    for (const r of droppedLosses) out('    ' + fmt(r));

    // ── 5. |Δ| distribution across abstain rows ─────────────────────────
    out('\n-- |bcTc - peakTc| distribution across ABSTAIN rows (bcSelf && bcCommitted only) --');
    const abstainBcSelf = rows.filter((r) => r.isAbstain && r.bcSelf && r.bcCommitted && r.bcTc > MIN_TEETH);
    const buckets = { '0': 0, '1-2': 0, '3-5': 0, '6-10': 0, '11-20': 0, '21+': 0 };
    for (const r of abstainBcSelf) {
      const d = r.dPeakBc;
      if (d === 0) buckets['0']++;
      else if (d <= 2) buckets['1-2']++;
      else if (d <= 5) buckets['3-5']++;
      else if (d <= 10) buckets['6-10']++;
      else if (d <= 20) buckets['11-20']++;
      else buckets['21+']++;
    }
    out(`  abstain ∧ bcSelf ∧ tc==bcTc ∧ bcTc>${MIN_TEETH}  total=${abstainBcSelf.length}`);
    for (const k of Object.keys(buckets)) out(`    |Δ| ${k.padEnd(5)} : ${buckets[k]}`);

    // ── 6. Full abstain dump ────────────────────────────────────────────
    out('\n-- All ABSTAIN rows (radius-sanity / inner-contour fired) --');
    const abstains = rows.filter((r) => r.isAbstain);
    out(`(${abstains.length} rows)`);
    for (const r of abstains) out('  ' + fmt(r));

    // ── 7. Confident-wrong dump ─────────────────────────────────────────
    out('\n-- Confident-wrong rows (off>1, conf>0, not abstain) --');
    const wrongRows = rows.filter((r) => !r.within1 && r.conf > 0 && !r.innerSus);
    out(`(${wrongRows.length} rows)`);
    for (const r of wrongRows) out('  ' + fmt(r));

    expect(rows.length).toBeGreaterThan(0);
  });
});
