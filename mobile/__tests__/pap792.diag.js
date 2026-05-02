/**
 * PAP-792 / PAP-793 measurement harness.
 *
 * Runs countTeethFromRgba on the XL (29-60T) corpus, captures per-method
 * outputs and predicts deltas for the candidate Option A' override:
 *
 *   outerAgree = fft90tc === opTc === toothCount && toothCount > MIN_TEETH
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap792.diag npx jest --config mobile/__tests__/.jest.harness.config.js
 */

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out } = runner;

const MIN_ACTUAL = 29;
const MAX_ACTUAL = 60;
const MIN_TEETH = 10;

describe('PAP-792 XL diagnostic', () => {
  jest.setTimeout(60 * 60 * 1000);

  test('measure A\' (outer-only triple) coverage on XL corpus', () => {
    const { rows: base, elapsedMs } = runner.runCorpus({
      targetRange: [MIN_ACTUAL, MAX_ACTUAL],
      label: 'pap792',
      progressEvery: 5,
    });

    out(`\n[pap792] inspecting ${base.length} XL (${MIN_ACTUAL}-${MAX_ACTUAL}T) photos`);

    const rows = base.map((r) => {
      const tripleAgree = r.peakTc > MIN_TEETH && r.peakTc === r.fft90 && r.peakTc === r.op && r.peakTc === r.tc;
      const outerAgree  = r.fft90 > MIN_TEETH && r.fft90 === r.op && r.fft90 === r.tc;
      const isAbstain = r.innerSus || r.conf === 0;
      let tagAp = 'NO_CHANGE';
      if (isAbstain && outerAgree && !tripleAgree) {
        tagAp = r.within1 ? 'WIN_AP' : 'LOSS_AP';
      }
      return Object.assign({}, r, { tripleAgree, outerAgree, isAbstain, tagAp });
    });

    const fmt = (r) => `${r.stamp}  actual=${r.actual} tc=${r.tc} conf=${r.conf.toFixed(2)} ` +
      `peak=${r.peakTc} fft90=${r.fft90} op=${r.op} bcTc=${r.bcTc} bcPk=${r.bcPeaks} ` +
      `gR=${r.gearR.toFixed(3)} innerSus=${r.innerSus} tripleAgree=${r.tripleAgree} ` +
      `outerAgree=${r.outerAgree} method=${r.method}`;

    out('\n=== PAP-792 A\' (outer-only triple) prediction ===');
    out(`Corpus: ${base.length} XL photos.  Wall: ${(elapsedMs / 1000).toFixed(0)}s`);

    const wins = rows.filter(r => r.tagAp === 'WIN_AP');
    const losses = rows.filter(r => r.tagAp === 'LOSS_AP');
    out(`A' WINS  (currently abstain, outer-only triple, ±1 of actual): ${wins.length}`);
    out(`A' LOSSES (currently abstain, outer-only triple, off > ±1):    ${losses.length}`);
    out('');

    out('-- A\' WIN rows --');
    if (wins.length === 0) out('  (none)');
    for (const r of wins) out('  ' + fmt(r));
    out('');

    out('-- A\' LOSS rows --');
    if (losses.length === 0) out('  (none)');
    for (const r of losses) out('  ' + fmt(r));
    out('');

    out('-- All ABSTAIN rows (radius-sanity / inner-contour fired) --');
    const abstains = rows.filter(r => r.innerSus);
    out(`(${abstains.length} rows)`);
    for (const r of abstains) out('  ' + fmt(r));
    out('');

    out('-- All correct (within ±1) rows --');
    const correct = rows.filter(r => r.within1 && r.conf > 0);
    out(`(${correct.length} rows)`);
    for (const r of correct) out('  ' + fmt(r));
    out('');

    out('-- Confident-wrong rows (off>1, conf>0, not abstain) --');
    const wrong = rows.filter(r => !r.within1 && r.conf > 0 && !r.innerSus);
    out(`(${wrong.length} rows)`);
    for (const r of wrong) out('  ' + fmt(r));

    expect(rows.length).toBeGreaterThan(0);
  });
});
