/**
 * PAP-889 candidate sweep: XL center-collapse abstain (Option A from
 * PAP-890 QA cross-check verdict).
 *
 * Predicate (gated to !tripleAgree && !bcStrongAgree to avoid clobbering
 * PAP-772 / PAP-792 rescue paths):
 *
 *   gearRadius < 0.20
 *   AND r.toothCount < 30
 *   AND !tripleAgree
 *   AND !bcStrongAgree
 *
 * (The countTeeth() wrapper additionally gates on aimCrop != null. The
 * harness mirror at countTeethFromRgba() intentionally drops the aimCrop
 * guard — same pattern as PAP-553/673/684/772 — so the training corpus
 * surfaces the worst-case risk surface QA flagged: tc∈[14,19] in tight
 * aim-crops where gearRadius∈[0.13, 0.20] for legitimate small/mid gears.)
 *
 * Buckets:
 *   wouldAbstainCorrect — currently confident-correct → would force conf=0  (LOSS)
 *   wouldAbstainWrong   — currently confident-wrong   → would force conf=0  (WIN)
 *   wouldNoop           — already conf=0 / abstain (no-op)
 *
 * Verdict thresholds (from PAP-890):
 *   - 0 LOSS rows on tc∈[14,19] training corpus
 *   - 0 abstain regressions on b94–b114 XL device targets (10-17-03, 32T,
 *     42T, 48T, 50T, 52T, 36T)
 *   - 1+ WIN on b114 34T 10-09-03 (the AC1 case)
 *
 * Run: npx jest --config mobile/__tests__/.jest.pap889.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });
console.log = () => {}; console.warn = () => {};
console.info = () => {}; console.debug = () => {};
const out = (s) => process.stdout.write(s + '\n');

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

const TRAINING = path.resolve(__dirname, '..', '..', 'training-data');
const DEBUG = path.resolve(__dirname, '..', '..', 'debug-reports');
const TARGET_MAX_DIM = 900;
const MIN_ACTUAL = 9;
const MAX_ACTUAL = 60;
const MIN_TEETH = 10;

// Reuse the PAP-885 XL device target lists; expand later if needed.
const B111_XL = [
  { stamp: 'report_2026-04-29_05-29-04-170Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-31-25-376Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-33-35-933Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-35-33-518Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-37-38-177Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-39-22-521Z', actual: 52 },
];
const B112_XL = [
  { stamp: 'report_2026-04-30_05-32-51-092Z', actual: 42 },
  { stamp: 'report_2026-04-30_05-34-20-458Z', actual: 42 },
  { stamp: 'report_2026-04-30_05-35-59-637Z', actual: 42 },
  { stamp: 'report_2026-04-30_05-37-35-156Z', actual: 42 },
];
const B114_XL = [
  { stamp: 'report_2026-04-30_10-09-03-515Z', actual: 34 },
  { stamp: 'report_2026-04-30_10-14-44-086Z', actual: 34 },
  { stamp: 'report_2026-04-30_10-17-03-115Z', actual: 34 },
  { stamp: 'report_2026-04-30_10-19-19-295Z', actual: 36 },
  { stamp: 'report_2026-04-30_10-23-07-161Z', actual: 36 },
];

function classOf(actual) {
  if (actual <= 13) return 'Small';
  if (actual <= 20) return 'Mid';
  if (actual <= 28) return 'Large';
  return 'XL';
}

function evalPhoto(countTeethFromRgba, bilinearDownsampleRgba, applyCircularMask, photoPath, actual, stamp, applyMask) {
  const buf = fs.readFileSync(photoPath);
  const raw = jpegDecode(buf, { useTArray: true });
  const { rgba, width: w, height: h } =
    bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET_MAX_DIM);
  if (applyMask) {
    const cx = (w - 1) / 2; const cy = (h - 1) / 2;
    applyCircularMask(rgba, w, h, cx, cy, 0.49 * Math.min(w, h));
  }
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
  const gearRadius = r.gearRadius || 0;
  const offBy = Math.abs(tc - actual);
  const within1 = offBy <= 1;

  // Mirror countTeeth()'s rescue exemptions exactly.
  const tripleAgree = peak === fft90 && peak === op && peak === tc && peak > MIN_TEETH;
  const bcStrongAgree = bcTc === bcPeaks
    && Math.abs(bcTc - peak) > 5
    && tc === bcTc
    && bcTc > MIN_TEETH;

  // Option A predicate (per PAP-896 Path 2 verdict — `conf<0.40` gate).
  const optionAFires = gearRadius < 0.20
    && tc < 30
    && conf < 0.40
    && !tripleAgree
    && !bcStrongAgree;

  return {
    stamp, actual, tc, conf, innerSus,
    peak, fft90, op, bcTc, bcPeaks,
    gearRadius, offBy, within1,
    tripleAgree, bcStrongAgree, optionAFires,
    method: r.methodUsed || '?',
    klass: classOf(actual),
  };
}

function fmt(r) {
  return `${r.stamp} cls=${r.klass} actual=${r.actual} tc=${r.tc} ` +
    `conf=${r.conf.toFixed(2)} peak=${r.peak} fft90=${r.fft90} op=${r.op} ` +
    `bc=${r.bcTc}(pk=${r.bcPeaks}) ` +
    `gearR=${r.gearRadius.toFixed(3)} ` +
    `triple=${r.tripleAgree?'Y':'N'} bcStr=${r.bcStrongAgree?'Y':'N'} ` +
    `method=${r.method}`;
}

// Bucket Option A fires by *would-have-been* outcome (pre-gate classification).
// This bucketing is stable across pre-/post-implementation runs because it
// uses within1 and tc, which are unchanged by the gate (the gate only zeros
// confidence and sets innerContourSuspected, not toothCount or correctness).
//
// wouldLoss: row's tc would have committed within ±1 of actual → gate forces
//            this previously-correct row to abstain (REGRESSION).
// wouldWin:  row's tc would have committed wrong → gate converts confident-
//            wrong to abstain (DESIRABLE).
// trueNoop:  tc=0 (no candidate at all) or already abstaining via another
//            radius-sanity / chainring gate before Option A — no behaviour
//            change from Option A on these rows.
function bucketOptionA(rows) {
  const wouldLoss = [];
  const wouldWin = [];
  const trueNoop = [];
  // Code-vs-predicate consistency: post-impl, every optionAFires row should
  // ALSO have r.innerSus=true (gate fired in algorithm).  Rows that satisfy
  // the predicate but innerSus=false indicate the predicate is not wired
  // into both call sites OR the gate was suppressed by another rescue.
  const inconsistent = [];
  for (const r of rows) {
    if (!r.optionAFires) continue;
    if (!r.innerSus && r.conf > 0) inconsistent.push(r);
    if (r.tc === 0 || (r.conf === 0 && !r.optionAFires)) {
      trueNoop.push(r); continue;
    }
    if (r.within1 && r.tc > 0) wouldLoss.push(r);
    else if (!r.within1 && r.tc > 0) wouldWin.push(r);
    else trueNoop.push(r);
  }
  return { wouldLoss, wouldWin, trueNoop, inconsistent };
}

describe('PAP-889 Option A candidate sweep', () => {
  jest.setTimeout(180 * 60 * 1000);
  test('gearR<0.20 abstain extension', () => {
    const { countTeethFromRgba, bilinearDownsampleRgba } =
      require('../src/algorithm/gearCounter');
    const { applyCircularMask } = require('../src/algorithm/imageUtils');
    out('\n=== PAP-889 Option A sweep ===');

    const xlOnly = process.env.PAP889_XL_ONLY === '1';

    // ---- Training corpus ----
    const labeled = [];
    for (const f of (xlOnly ? [] : fs.readdirSync(TRAINING).sort())) {
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
    out(`\n[Training] ${labeled.length} photos (9-60T)`);

    const trainRows = [];
    const t0 = Date.now();
    for (let i = 0; i < labeled.length; i++) {
      const { stamp, actual, photo } = labeled[i];
      const row = evalPhoto(countTeethFromRgba, bilinearDownsampleRgba, applyCircularMask, photo, actual, stamp, false);
      trainRows.push(row);
      if ((i + 1) % 50 === 0) out(`  [${i + 1}/${labeled.length}] ${((Date.now() - t0)/1000).toFixed(0)}s`);
    }
    out(`  done in ${((Date.now()-t0)/1000).toFixed(0)}s`);

    // ---- XL device targets ----
    const allXl = [
      ...B111_XL.map(t => ({ ...t, build: 'b111' })),
      ...B112_XL.map(t => ({ ...t, build: 'b112' })),
      ...B114_XL.map(t => ({ ...t, build: 'b114' })),
    ];
    const xlRows = [];
    for (const t of allXl) {
      const photo = path.join(DEBUG, t.stamp, 'cropped.jpg');
      if (!fs.existsSync(photo)) { out(`  [missing] ${t.stamp}`); continue; }
      const row = evalPhoto(countTeethFromRgba, bilinearDownsampleRgba, applyCircularMask, photo, t.actual, t.stamp, true);
      row.build = t.build;
      xlRows.push(row);
    }
    out(`\n[XL device] ${xlRows.length} targets`);
    for (const r of xlRows) out(`  build=${r.build} ${fmt(r)}`);

    // ---- Bucket Option A on training ----
    out('\n--- Option A on TRAINING corpus ---');
    const trainBkt = bucketOptionA(trainRows);
    out(`  fires=${trainBkt.wouldLoss.length + trainBkt.wouldWin.length + trainBkt.trueNoop.length} ` +
        `LOSS=${trainBkt.wouldLoss.length} WIN=${trainBkt.wouldWin.length} NOOP=${trainBkt.trueNoop.length} ` +
        `inconsistent=${trainBkt.inconsistent.length}`);
    if (trainBkt.inconsistent.length) {
      out(`  INCONSISTENT rows (predicate fires but gate didn't) — IMPLEMENTATION BUG:`);
      for (const r of trainBkt.inconsistent) out('    ' + fmt(r));
    }
    if (trainBkt.wouldLoss.length) {
      out(`  LOSS rows (confident-correct → would abstain) — REGRESSION:`);
      for (const r of trainBkt.wouldLoss) out('    ' + fmt(r));
    }
    if (trainBkt.wouldWin.length) {
      out(`  WIN rows (confident-wrong → would abstain):`);
      for (const r of trainBkt.wouldWin) out('    ' + fmt(r));
    }

    // Histogram of training rows by tc bucket / gearR bucket — context for
    // QA's [14,19] risk surface.
    const byTc = {};
    for (const r of trainRows) {
      if (!r.optionAFires) continue;
      const isCommit = r.tc > 0 && r.conf > 0 && !r.innerSus;
      if (!isCommit) continue;
      const k = r.actual;
      if (!byTc[k]) byTc[k] = { correct: 0, wrong: 0 };
      if (r.within1) byTc[k].correct += 1; else byTc[k].wrong += 1;
    }
    out('  histogram by actual tc (committed rows that fire Option A):');
    const keys = Object.keys(byTc).map(Number).sort((a,b) => a-b);
    for (const k of keys) {
      out(`    tc=${k}: correct=${byTc[k].correct} wrong=${byTc[k].wrong}`);
    }

    // ---- Bucket Option A on XL device ----
    out('\n--- Option A on XL device ---');
    const xlBkt = bucketOptionA(xlRows);
    out(`  fires=${xlBkt.wouldLoss.length + xlBkt.wouldWin.length + xlBkt.trueNoop.length} ` +
        `LOSS=${xlBkt.wouldLoss.length} WIN=${xlBkt.wouldWin.length} NOOP=${xlBkt.trueNoop.length} ` +
        `inconsistent=${xlBkt.inconsistent.length}`);
    if (xlBkt.inconsistent.length) {
      out(`  INCONSISTENT rows (predicate fires but gate didn't) — IMPLEMENTATION BUG:`);
      for (const r of xlBkt.inconsistent) out('    ' + fmt(r) + ` build=${r.build}`);
    }
    if (xlBkt.wouldLoss.length) {
      out(`  LOSS rows (REGRESSION on device targets):`);
      for (const r of xlBkt.wouldLoss) out('    ' + fmt(r) + ` build=${r.build}`);
    }
    if (xlBkt.wouldWin.length) {
      out(`  WIN rows (confident-wrong → abstain on device):`);
      for (const r of xlBkt.wouldWin) out('    ' + fmt(r) + ` build=${r.build}`);
    }
    if (xlBkt.trueNoop.length) {
      out(`  NOOP rows (already abstaining via other gate):`);
      for (const r of xlBkt.trueNoop) out('    ' + fmt(r) + ` build=${r.build}`);
    }

    out('\n=== verdict ===');
    out(`  TRAINING: LOSS=${trainBkt.wouldLoss.length} WIN=${trainBkt.wouldWin.length} ` +
        `inconsistent=${trainBkt.inconsistent.length}`);
    out(`  XL: LOSS=${xlBkt.wouldLoss.length} WIN=${xlBkt.wouldWin.length} ` +
        `inconsistent=${xlBkt.inconsistent.length}`);
    expect(xlRows.length).toBeGreaterThan(0);
    // QA gate: inconsistent must be 0 — every predicate fire must result in
    // gate firing in the algorithm (innerContourSuspected=true).
    expect(trainBkt.inconsistent.length).toBe(0);
    expect(xlBkt.inconsistent.length).toBe(0);
  });
});
