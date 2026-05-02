/**
 * PAP-815 implementation audit (per QA PAP-818 gates 1, 2, 4).
 *
 * Runs countTeethFromRgba on:
 *   1. Full 9-60T training corpus (matches PAP-796 sweep) — gate 1.
 *   2. The 6 XL device targets via cropped.jpg (PAP-810 pattern) — gate 2.
 *
 * For each row reports:
 *   - actual / tc / conf / class / method
 *   - peakR / rOuter / radialRelDisagree
 *   - whether the new PAP-815 chainring abstain "fires" (tc !== 0 logic-only —
 *     the predicate forces conf=0 and innerSus=true, but tc itself stays the
 *     same; we read radialRelDisagree against the ≥0.18 threshold to detect
 *     predicate firing without depending on the abstain wiring being in
 *     place).
 *   - whether the row was previously confident-wrong (off>1) or confident-
 *     correct (within±1).
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap815.audit npx jest --config mobile/__tests__/.jest.harness.config.js
 */

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, DEBUG_DIR } = runner;

const THRESHOLD = 0.18;
const MIN_TEETH = 10;

// Baseline per-class accuracy from debug-reports/pap796_post_pap810_2026-04-29.log
// (HEAD with PAP-810 + PAP-814, BEFORE 2d55e26 PAP-815). Used to compute
// post-fix deltas per QA PAP-815 re-submission requirement.
const BASELINE = {
  Small: { n: 51, correct: 32, wrong: 1, abstain: 18 },
  Mid:   { n: 114, correct: 102, wrong: 2, abstain: 10 },
  Large: { n: 109, correct: 47, wrong: 15, abstain: 47 },
  XL:    { n: 31, correct: 8, wrong: 8, abstain: 15 },
};

// XL device targets (cropped.jpg path for device-faithful signal)
const XL_TARGETS = [
  { stamp: 'report_2026-04-29_05-29-04-170Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-31-25-376Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-33-35-933Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-35-33-518Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-37-38-177Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-39-22-521Z', actual: 52 },
];

// PAP-815 v2 production predicate (mirror of gearCounter.js after QA verdict
// 2026-04-29): chainring-regime gate OR AC1-rescue narrow override.
function enrich(r) {
  const peak = r.peakTc, fft90 = r.fft90, op = r.op, bcTc = r.bcTc, bcPeaks = r.bcPeaks;
  const rel = (r.raw && r.raw.radialRelDisagree != null) ? r.raw.radialRelDisagree : null;
  const chainring = peak >= 30 || fft90 >= 30 || op >= 30 || bcTc >= 30 || bcPeaks >= 30;
  const ac1Pattern =
    peak <= MIN_TEETH + 2 && fft90 <= MIN_TEETH + 2 && op <= MIN_TEETH + 2
    && bcTc <= MIN_TEETH + 2
    && bcPeaks >= 20 && bcPeaks <= 30;
  const eligible = chainring || ac1Pattern;
  const radialFires = eligible && rel != null && rel >= THRESHOLD;
  const wasConfidentWrong = !r.within1 && r.tc > 0;
  const wasConfidentCorrect = r.within1 && r.tc > 0;
  return Object.assign({}, r, {
    rel, chainring, ac1Pattern, eligible, radialFires,
    wasConfidentWrong, wasConfidentCorrect,
  });
}

function fmt(r) {
  return `${r.stamp} cls=${r.klass} actual=${r.actual} tc=${r.tc} ` +
    `conf=${r.conf.toFixed(2)} peak=${r.peakTc} fft90=${r.fft90} op=${r.op} ` +
    `bc=${r.bcTc}(pk=${r.bcPeaks}) ` +
    `peakR=${r.peakR} rOuter=${r.rOuter} ` +
    `rel=${r.rel != null ? r.rel.toFixed(4) : 'n/a'} ` +
    `chr=${r.chainring} ac1=${r.ac1Pattern} elig=${r.eligible} ` +
    `radFire=${r.radialFires} ` +
    `innerSus=${r.innerSus} method=${r.method}`;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

describe('PAP-815 implementation audit', () => {
  jest.setTimeout(60 * 60 * 1000);

  test('measure radial-chainring abstain on training + XL device corpus', () => {
    out(`\n=== PAP-815 implementation audit (radial-chainring abstain @ ≥${THRESHOLD}) ===`);

    // ── Part 1: Full 9-60T training corpus (matches PAP-796 sweep) ───────────
    const { rows: baseRows } = runner.runCorpus({
      targetRange: [9, 60],
      label: 'pap815-train',
    });
    const trainRows = baseRows.map(enrich);

    // ── Per-class summary (post-predicate) + delta vs baseline ───────────────
    out('\n-- Per-class accuracy (after PAP-815 v2 abstain) vs pap796_post_pap810 baseline --');
    out(`  ${pad('class', 6)} ${pad('n', 4)} ${pad('correct', 22)} ${pad('wrong', 18)} ${pad('abstain', 18)}`);
    const klasses = ['Small', 'Mid', 'Large', 'XL'];
    const totals = { correct: 0, wrong: 0, abstain: 0, n: 0 };
    const baseTotals = { correct: 0, wrong: 0, abstain: 0, n: 0 };
    for (const k of klasses) {
      const sub = trainRows.filter(r => r.klass === k);
      const correct = sub.filter(r => r.within1 && r.conf > 0).length;
      const wrong = sub.filter(r => !r.within1 && r.conf > 0 && !r.innerSus).length;
      const abstain = sub.filter(r => r.conf === 0 || r.innerSus).length;
      const b = BASELINE[k];
      const dC = correct - b.correct;
      const dW = wrong - b.wrong;
      const dA = abstain - b.abstain;
      const sign = (x) => (x > 0 ? `+${x}` : `${x}`);
      out(`  ${pad(k, 6)} ${pad(sub.length, 4)} ` +
          `${pad(`${correct} (${(100 * correct / Math.max(1, sub.length)).toFixed(1)}%) Δ${sign(dC)}`, 22)} ` +
          `${pad(`${wrong} Δ${sign(dW)}`, 18)} ${pad(`${abstain} Δ${sign(dA)}`, 18)}`);
      totals.correct += correct; totals.wrong += wrong; totals.abstain += abstain; totals.n += sub.length;
      baseTotals.correct += b.correct; baseTotals.wrong += b.wrong; baseTotals.abstain += b.abstain; baseTotals.n += b.n;
    }
    out(`  ${pad('TOTAL', 6)} ${pad(totals.n, 4)} ` +
        `correct=${totals.correct} (Δ${totals.correct - baseTotals.correct})  ` +
        `wrong=${totals.wrong} (Δ${totals.wrong - baseTotals.wrong})  ` +
        `abstain=${totals.abstain} (Δ${totals.abstain - baseTotals.abstain})`);

    // ── Predicate-fire rows on training corpus ───────────────────────────────
    const radialFireTrain = trainRows.filter(r => r.radialFires);
    const wins = radialFireTrain.filter(r => r.wasConfidentWrong);
    const losses = radialFireTrain.filter(r => r.wasConfidentCorrect);
    const neutral = radialFireTrain.filter(r => !r.wasConfidentWrong && !r.wasConfidentCorrect);

    out(`\n-- PAP-815 predicate firings on training corpus --`);
    out(`  total fires=${radialFireTrain.length}  wins(conf-wrong→abstain)=${wins.length}  ` +
        `losses(conf-correct→abstain)=${losses.length}  neutral=${neutral.length}`);
    out('\n  WIN rows (predicate caught a confident-wrong):');
    if (wins.length === 0) out('    (none)');
    for (const r of wins) out('    ' + fmt(r));
    out('\n  LOSS rows (predicate falsely abstained on a confident-correct):');
    if (losses.length === 0) out('    (none)');
    for (const r of losses) out('    ' + fmt(r));
    out('\n  NEUTRAL rows (predicate fired but tc=0/already abstained):');
    if (neutral.length === 0) out('    (none)');
    for (const r of neutral) out('    ' + fmt(r));

    // ── Confident-wrong rows that survive (predicate did NOT fire) ───────────
    out('\n-- Confident-wrong rows that survive (predicate not eligible) --');
    const survivors = trainRows.filter(r => r.wasConfidentWrong && !r.innerSus && r.conf > 0);
    out(`  ${survivors.length} rows`);
    for (const r of survivors) out('    ' + fmt(r));

    // ── Part 2: XL device targets (cropped.jpg) ──────────────────────────────
    out('\n[Part 2] XL device targets (cropped.jpg, device-faithful)');
    out(`-- ${XL_TARGETS.length} XL targets --`);
    const xlRows = [];
    for (const t of XL_TARGETS) {
      const photo = path.join(DEBUG_DIR, t.stamp, 'cropped.jpg');
      if (!fs.existsSync(photo)) {
        out(`  [MISSING] ${t.stamp}`);
        continue;
      }
      const row = enrich(runner.evalPhoto({
        photo, actual: t.actual, stamp: t.stamp, applyMask: true,
      }));
      xlRows.push(row);
      out('  ' + fmt(row));
    }
    const xlCorrect = xlRows.filter(r => r.within1 && r.conf > 0).length;
    const xlWrong = xlRows.filter(r => !r.within1 && r.conf > 0 && !r.innerSus).length;
    const xlAbstain = xlRows.filter(r => r.conf === 0 || r.innerSus).length;
    out(`\n  XL summary: correct=${xlCorrect} wrong=${xlWrong} abstain=${xlAbstain}`);

    expect(trainRows.length).toBeGreaterThan(0);
  });
});
