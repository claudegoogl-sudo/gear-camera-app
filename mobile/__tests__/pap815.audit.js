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
 * Reports:
 *   - Per-class accuracy (with abstain in effect)
 *   - All radial-fire rows tagged WIN / LOSS / NEUTRAL
 *   - Confident-wrong rows that survive (predicate did NOT fire)
 *
 * Run:
 *   npx jest --config mobile/__tests__/.jest.pap815audit.config.js
 */

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

console.log = () => {};
console.warn = () => {};
console.info = () => {};
console.debug = () => {};
const out = (s) => process.stdout.write(s + '\n');

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

const TRAINING = path.resolve(__dirname, '..', '..', 'training-data');
const DEBUG = path.resolve(__dirname, '..', '..', 'debug-reports');
const TARGET_MAX_DIM = 900;
const MIN_ACTUAL = 9;
const MAX_ACTUAL = 60;
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

function classOf(actual) {
  if (actual <= 13) return 'Small';
  if (actual <= 20) return 'Mid';
  if (actual <= 28) return 'Large';
  return 'XL';
}

function evalPhoto(countTeethFromRgba, bilinearDownsampleRgba, photoPath, actual, stamp) {
  const buf = fs.readFileSync(photoPath);
  const raw = jpegDecode(buf, { useTArray: true });
  const { rgba, width: w, height: h } =
    bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET_MAX_DIM);
  let r;
  try { r = countTeethFromRgba(rgba, w, h); }
  catch (e) { return { stamp, actual, error: e.message }; }

  const tc = r.toothCount || 0;
  const peak = r.peakTc || 0;
  const fft90 = r.fft90tc || 0;
  const op = r.opTc || 0;
  const bcTc = r.bcTc || 0;
  const bcPeaks = r.bcPeaks || 0;
  const conf = r.confidence || 0;
  const innerSus = !!r.innerContourSuspected;
  const peakR = r.peakR || 0;
  const rOuter = r.rOuter || 0;
  const rel = (r.radialRelDisagree != null) ? r.radialRelDisagree : null;
  const offBy = Math.abs(tc - actual);
  const within1 = offBy <= 1;
  // PAP-815 v2 production predicate (mirror of gearCounter.js after QA verdict
  // 2026-04-29): chainring-regime gate OR AC1-rescue narrow override.
  // Gate the rel-disagree check the SAME way production does — earlier audit
  // version gated solely on chainring which undercounted Small/Mid abstains
  // by ~107 rows.
  const chainring = peak >= 30 || fft90 >= 30 || op >= 30 || bcTc >= 30 || bcPeaks >= 30;
  const ac1Pattern =
    peak <= MIN_TEETH + 2 && fft90 <= MIN_TEETH + 2 && op <= MIN_TEETH + 2
    && bcTc <= MIN_TEETH + 2
    && bcPeaks >= 20 && bcPeaks <= 30;
  const eligible = chainring || ac1Pattern;
  const radialFires = eligible && rel != null && rel >= THRESHOLD;
  // Was it previously a confident wrong / correct (before this predicate fired)?
  // tc itself doesn't change with this predicate; only conf/innerSus do.  So
  // pre-predicate "confidence" is what tc says vs actual.
  const wasConfidentWrong = !within1 && tc > 0;
  const wasConfidentCorrect = within1 && tc > 0;
  return {
    stamp, actual, tc, conf, innerSus, peak, fft90, op, bcTc, bcPeaks,
    peakR, rOuter, rel,
    chainring, ac1Pattern, eligible, radialFires,
    offBy, within1, wasConfidentWrong, wasConfidentCorrect,
    method: r.methodUsed || '?',
    klass: classOf(actual),
  };
}

function fmt(r) {
  return `${r.stamp} cls=${r.klass} actual=${r.actual} tc=${r.tc} ` +
    `conf=${r.conf.toFixed(2)} peak=${r.peak} fft90=${r.fft90} op=${r.op} ` +
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
    const { countTeethFromRgba, bilinearDownsampleRgba } =
      require('../src/algorithm/gearCounter');

    out(`\n=== PAP-815 implementation audit (radial-chainring abstain @ ≥${THRESHOLD}) ===`);

    // ── Part 1: Full 9-60T training corpus (matches PAP-796 sweep) ───────────
    const labeled = [];
    for (const f of fs.readdirSync(TRAINING).sort()) {
      if (!f.endsWith('_meta.json')) continue;
      let meta;
      try {
        const raw = fs.readFileSync(path.join(TRAINING, f), 'utf8')
          .replace(/[^\x00-\x7F]+/g, '?');
        meta = JSON.parse(raw);
      } catch { continue; }
      const actual = Number(meta.actual_tooth_count || meta.actualTeethCount || 0);
      if (!actual || actual < MIN_ACTUAL || actual > MAX_ACTUAL) continue;
      const photo = path.join(TRAINING, f.replace('_meta.json', '_photo.jpg'));
      if (!fs.existsSync(photo)) continue;
      labeled.push({ stamp: f.replace('_meta.json', ''), actual, photo });
    }
    out(`\n[Part 1] Training corpus: ${labeled.length} photos (9-60T)`);

    const trainRows = [];
    const t0 = Date.now();
    for (let i = 0; i < labeled.length; i++) {
      const { stamp, actual, photo } = labeled[i];
      const row = evalPhoto(countTeethFromRgba, bilinearDownsampleRgba, photo, actual, stamp);
      trainRows.push(row);
      if ((i + 1) % 25 === 0) {
        out(`  [${i + 1}/${labeled.length}] elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    }
    out(`  done. wall=${((Date.now() - t0) / 1000).toFixed(0)}s`);

    // ── Per-class summary (post-predicate) + delta vs baseline ───────────────
    // Baseline = pap796_post_pap810_2026-04-29.log (pre-PAP-815). QA's
    // PAP-815 re-submission requirement is to print these deltas so we
    // can't repeat the chainring-gate undercount that masked -117 lost
    // confident-correct rows in the prior submission.
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
      const photo = path.join(DEBUG, t.stamp, 'cropped.jpg');
      if (!fs.existsSync(photo)) {
        out(`  [MISSING] ${t.stamp}`);
        continue;
      }
      const row = evalPhoto(countTeethFromRgba, bilinearDownsampleRgba, photo, t.actual, t.stamp);
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
