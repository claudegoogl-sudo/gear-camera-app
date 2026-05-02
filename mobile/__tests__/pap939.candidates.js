/**
 * PAP-939 candidate sweep — XL chainring inner-lock abstain.
 *
 * Tests three candidate predicates against the training corpus AND the b116
 * XL device captures. Reports WIN / LOSS / NOOP for each.
 *
 *   Cand-2: gearR_crop<0.365 && tc<35 && chainringRegime
 *   Cand-3: gearR_crop<0.365 && |peakR-rOuter|/rOuter<0.10 && chainringRegime
 *   Cand-6: any channel >=30 && (channel - tc) >= 10 && gearR_crop<0.365 && tc<35
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970). The chainring
 * predicates fire across the whole corpus; targetRange=[9,60] keeps SCOPE=
 * targeted ≡ legacy SCOPE=full behaviour.
 *
 * Run: SCOPE=full HARNESS=pap939.candidates npx jest --config mobile/__tests__/.jest.harness.config.js
 *      PAP939_XL_ONLY=1 to skip the training sweep.
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, DEBUG_DIR } = runner;

const MIN_TEETH = 10;

const B116_XL = [
  { stamp: 'report_2026-05-01_08-22-10-875Z', actual: 52 },
  { stamp: 'report_2026-05-01_08-24-01-784Z', actual: 52 },
  { stamp: 'report_2026-05-01_08-26-34-045Z', actual: 52 },
  { stamp: 'report_2026-05-01_08-28-32-755Z', actual: 50 },
  { stamp: 'report_2026-05-01_08-30-59-457Z', actual: 50 },
  { stamp: 'report_2026-05-01_09-03-58-615Z', actual: 48 },
  { stamp: 'report_2026-05-01_09-07-06-225Z', actual: 42 },
  { stamp: 'report_2026-05-01_09-09-19-262Z', actual: 36 },
];

const PRIOR_XL = [
  { stamp: 'report_2026-04-29_05-29-04-170Z', actual: 42, build: 'b111' },
  { stamp: 'report_2026-04-29_05-31-25-376Z', actual: 42, build: 'b111' },
  { stamp: 'report_2026-04-29_05-33-35-933Z', actual: 52, build: 'b111' },
  { stamp: 'report_2026-04-29_05-35-33-518Z', actual: 52, build: 'b111' },
  { stamp: 'report_2026-04-29_05-37-38-177Z', actual: 52, build: 'b111' },
  { stamp: 'report_2026-04-29_05-39-22-521Z', actual: 52, build: 'b111' },
  { stamp: 'report_2026-04-30_05-32-51-092Z', actual: 42, build: 'b112' },
  { stamp: 'report_2026-04-30_05-34-20-458Z', actual: 42, build: 'b112' },
  { stamp: 'report_2026-04-30_05-35-59-637Z', actual: 42, build: 'b112' },
  { stamp: 'report_2026-04-30_05-37-35-156Z', actual: 42, build: 'b112' },
  { stamp: 'report_2026-04-30_10-09-03-515Z', actual: 34, build: 'b114' },
  { stamp: 'report_2026-04-30_10-14-44-086Z', actual: 34, build: 'b114' },
  { stamp: 'report_2026-04-30_10-17-03-115Z', actual: 34, build: 'b114' },
  { stamp: 'report_2026-04-30_10-19-19-295Z', actual: 36, build: 'b114' },
  { stamp: 'report_2026-04-30_10-23-07-161Z', actual: 36, build: 'b114' },
];

const chReg = (r) => r.peakTc >= 30 || r.fft90 >= 30 || r.op >= 30
  || r.bcTc >= 30 || r.bcPeaks >= 30;

const CANDS = {
  C2: (r) => r.gearR < 0.365 && r.tc < 35 && chReg(r),
  C3: (r) => r.gearR < 0.365 && r.tc < 35 && r.peakR > 0 && r.rOuter > 0
    && Math.abs(r.peakR - r.rOuter) / r.rOuter < 0.10 && chReg(r),
  C6: (r) => {
    if (r.gearR >= 0.365 || r.tc >= 35) return false;
    const ch = [r.peakTc, r.fft90, r.op, r.bcTc, r.bcPeaks];
    return ch.some((v) => v >= 30 && (v - r.tc) >= 10);
  },
};

function bucket(rows, fn) {
  // Mirror existing rescue exemptions (tripleAgree / bcStrongAgree) so a
  // would-fire row that the algorithm already overrides is classified as
  // PASS (NOOP), not WIN/LOSS.
  const wouldLoss = []; const wouldWin = []; const trueNoop = [];
  for (const r of rows) {
    const tripleAgree = r.peakTc === r.fft90 && r.peakTc === r.op
      && r.peakTc === r.tc && r.peakTc > MIN_TEETH;
    const bcStrongAgree = r.bcTc === r.bcPeaks && Math.abs(r.bcTc - r.peakTc) > 5
      && r.tc === r.bcTc && r.bcTc > MIN_TEETH;
    if (!fn(r)) continue;
    if (tripleAgree || bcStrongAgree) continue;
    if (r.tc === 0 || r.conf === 0 || r.innerSus) { trueNoop.push(r); continue; }
    if (r.within1) wouldLoss.push(r); else wouldWin.push(r);
  }
  return { wouldLoss, wouldWin, trueNoop };
}

function fmt(r) {
  return `${r.stamp.slice(0, 30)} cls=${r.klass} act=${r.actual} tc=${r.tc} ` +
    `conf=${r.conf.toFixed(2)} peak=${r.peakTc} fft90=${r.fft90} op=${r.op} ` +
    `bc=${r.bcTc}(pk=${r.bcPeaks}) gR=${r.gearR.toFixed(3)} ` +
    `peakR=${r.peakR} rO=${r.rOuter} m=${r.method}`;
}

describe('PAP-939 candidate sweep', () => {
  jest.setTimeout(180 * 60 * 1000);

  test('C2 / C3 / C6 sweep', () => {
    out('\n=== PAP-939 candidate sweep ===');
    const xlOnly = process.env.PAP939_XL_ONLY === '1';

    // ---- Training corpus ----
    let trainRows = [];
    if (!xlOnly) {
      const { rows } = runner.runCorpus({
        targetRange: [9, 60],
        applyMask: false,
        progressEvery: 50,
        label: 'pap939-train',
      });
      trainRows = rows;
    }

    // ---- Device captures (debug-reports/) ----
    const evalDevice = (t, build) => {
      const photo = path.join(DEBUG_DIR, t.stamp, 'cropped.jpg');
      if (!fs.existsSync(photo)) return null;
      const r = runner.evalPhoto({
        photo, actual: t.actual, stamp: t.stamp, applyMask: true,
      });
      r.build = build;
      return r;
    };
    const b116Rows = B116_XL.map((t) => evalDevice(t, 'b116')).filter(Boolean);
    const priorRows = PRIOR_XL.map((t) => evalDevice(t, t.build)).filter(Boolean);

    out(`\n[XL device] b116=${b116Rows.length} prior=${priorRows.length}`);
    for (const r of [...b116Rows, ...priorRows]) {
      out(`  ${r.build} ${fmt(r)}`);
    }

    for (const [name, fn] of Object.entries(CANDS)) {
      out(`\n--- ${name} ---`);
      const tBkt = bucket(trainRows, fn);
      out(`  TRAINING: LOSS=${tBkt.wouldLoss.length} WIN=${tBkt.wouldWin.length} NOOP=${tBkt.trueNoop.length}`);
      if (tBkt.wouldLoss.length) {
        out('    LOSS rows:');
        for (const r of tBkt.wouldLoss) out('      ' + fmt(r));
      }
      if (tBkt.wouldWin.length) {
        out('    WIN rows:');
        for (const r of tBkt.wouldWin) out('      ' + fmt(r));
      }
      const xBkt = bucket(b116Rows, fn);
      out(`  b116-XL: LOSS=${xBkt.wouldLoss.length} WIN=${xBkt.wouldWin.length} NOOP=${xBkt.trueNoop.length}`);
      for (const r of xBkt.wouldLoss) out('    LOSS ' + fmt(r));
      for (const r of xBkt.wouldWin) out('    WIN  ' + fmt(r));
      const pBkt = bucket(priorRows, fn);
      out(`  prior-XL: LOSS=${pBkt.wouldLoss.length} WIN=${pBkt.wouldWin.length} NOOP=${pBkt.trueNoop.length}`);
      for (const r of pBkt.wouldLoss) out('    LOSS ' + fmt(r));
      for (const r of pBkt.wouldWin) out('    WIN  ' + fmt(r));
    }

    out('\n=== summary ===');
    expect(b116Rows.length).toBeGreaterThan(0);
  });
});
