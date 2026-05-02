/**
 * PAP-963 Campagnolo bolt-pattern band-aid sweep.
 *
 * Predicate under test (campaBoltAbstain):
 *   peakTc ∈ {12,13}
 *   AND (fft90tc>=30 || opTc>=30 || bcTc>=30 || bcPeaks>=30)   // chainring channel
 *   AND gearRadius >= 0.365                                     // in-crop call site
 *
 * Sweeps:
 *   - Full 9-60T training corpus (PAP-939 convention: countTeethFromRgba, no mask)
 *   - b111-b117 XL device captures (cropped.jpg, mask=0.49*minDim)
 *
 * AC1: 0 LOSS on training corpus
 * AC2: 0 LOSS on b111-b117 XL device targets
 * AC3: ≥1 WIN including report_2026-05-01_14-52-05-858Z
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap961c.sweep npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, DEBUG_DIR } = runner;

const MIN_TEETH = 10;

// b117 XL device captures (2026-05-01 afternoon session)
const B117_XL = [
  { stamp: 'report_2026-05-01_14-52-05-858Z', actual: 42, build: 'b117', note: 'Campagnolo dangerous' },
  { stamp: 'report_2026-05-01_14-53-36-988Z', actual: 42, build: 'b117' },
  { stamp: 'report_2026-05-01_14-55-01-423Z', actual: 42, build: 'b117' },
  { stamp: 'report_2026-05-01_14-56-37-862Z', actual: 48, build: 'b117' },
  { stamp: 'report_2026-05-01_15-00-42-140Z', actual: 48, build: 'b117' },
  { stamp: 'report_2026-05-01_15-03-56-895Z', actual: 48, build: 'b117' },
  { stamp: 'report_2026-05-01_15-06-13-796Z', actual: 50, build: 'b117' },
  { stamp: 'report_2026-05-01_15-08-16-433Z', actual: 50, build: 'b117' },
  { stamp: 'report_2026-05-01_15-10-25-896Z', actual: 50, build: 'b117' },
  { stamp: 'report_2026-05-01_15-12-27-152Z', actual: 52, build: 'b117' },
  { stamp: 'report_2026-05-01_15-14-08-511Z', actual: 52, build: 'b117' },
  { stamp: 'report_2026-05-01_15-20-25-637Z', actual: 52, build: 'b117' },
  { stamp: 'report_2026-05-01_15-21-57-850Z', actual: 52, build: 'b117' },
  { stamp: 'report_2026-05-01_15-28-06-337Z', actual: 36, build: 'b117' },
  { stamp: 'report_2026-05-01_15-30-03-986Z', actual: 36, build: 'b117' },
  { stamp: 'report_2026-05-01_15-37-16-032Z', actual: 36, build: 'b117' },
];

// b116 XL (mirrors PAP-939 sweep)
const B116_XL = [
  { stamp: 'report_2026-05-01_08-22-10-875Z', actual: 52, build: 'b116' },
  { stamp: 'report_2026-05-01_08-24-01-784Z', actual: 52, build: 'b116' },
  { stamp: 'report_2026-05-01_08-26-34-045Z', actual: 52, build: 'b116' },
  { stamp: 'report_2026-05-01_08-28-32-755Z', actual: 50, build: 'b116' },
  { stamp: 'report_2026-05-01_08-30-59-457Z', actual: 50, build: 'b116' },
  { stamp: 'report_2026-05-01_09-03-58-615Z', actual: 48, build: 'b116' },
  { stamp: 'report_2026-05-01_09-07-06-225Z', actual: 42, build: 'b116' },
  { stamp: 'report_2026-05-01_09-09-19-262Z', actual: 36, build: 'b116' },
];

// b111-b114 XL (mirrors PAP-939 PRIOR_XL)
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

// PAP-963 predicates (in-crop calibration: gearR >= 0.365)
function campaBoltAbstainV1(r) {
  if (!(r.peakTc >= 12 && r.peakTc <= 13)) return false;
  const chReg = r.fft90 >= 30 || r.op >= 30 || r.bcTc >= 30 || r.bcPeaks >= 30;
  if (!chReg) return false;
  if (!(r.gearR >= 0.365)) return false;
  return true;
}

function campaBoltAbstainV2(r) {
  if (!(r.tc >= 12 && r.tc <= 13)) return false;
  const chReg = r.fft90 >= 30 || r.op >= 30 || r.bcTc >= 30 || r.bcPeaks >= 30;
  if (!chReg) return false;
  if (!(r.gearR >= 0.365)) return false;
  return true;
}

function campaBoltAbstainV3(r) {
  if (!(r.bcTc >= 12 && r.bcTc <= 13)) return false;
  const chReg = r.fft90 >= 30 || r.op >= 30 || r.bcPeaks >= 30;
  if (!chReg) return false;
  if (!(r.gearR >= 0.365)) return false;
  return true;
}

function bucket(rows, predFn) {
  const wouldLoss = []; const wouldWin = []; const trueNoop = [];
  for (const r of rows) {
    const tripleAgree = r.peakTc === r.fft90 && r.peakTc === r.op
      && r.peakTc === r.tc && r.peakTc > MIN_TEETH;
    const bcStrongAgree = r.bcTc === r.bcPeaks && Math.abs(r.bcTc - r.peakTc) > 5
      && r.tc === r.bcTc && r.bcTc > MIN_TEETH;
    if (!predFn(r)) continue;
    if (tripleAgree || bcStrongAgree) continue;
    if (r.tc === 0 || r.conf === 0 || r.innerSus) { trueNoop.push(r); continue; }
    if (r.conf < 0.40) { trueNoop.push(r); continue; }
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

describe('PAP-963 Campagnolo band-aid sweep', () => {
  jest.setTimeout(180 * 60 * 1000);
  test('campaBoltAbstain — training + b111-b117 XL', () => {
    out('\n=== PAP-963 Campagnolo band-aid sweep ===');

    const xlOnly = process.env.PAP963_XL_ONLY === '1';

    // ---- Training corpus ----
    let trainRows = [];
    if (!xlOnly) {
      const { rows: base } = runner.runCorpus({
        targetRange: [9, 60],
        label: 'pap961c-train',
        progressEvery: 50,
      });
      trainRows = base;
    }
    out(`[Training] ${trainRows.length} photos (9-60T)`);

    // ---- XL device targets ----
    const xlAll = [];
    for (const t of [...PRIOR_XL, ...B116_XL, ...B117_XL]) {
      const photo = path.join(DEBUG_DIR, t.stamp, 'cropped.jpg');
      if (!fs.existsSync(photo)) { out(`  [skip missing] ${t.stamp}`); continue; }
      const r = runner.evalPhoto({
        photo, actual: t.actual, stamp: t.stamp, applyMask: true,
      });
      r.build = t.build;
      r.note = t.note || '';
      xlAll.push(r);
    }
    out(`\n[XL device] total=${xlAll.length}`);
    for (const r of xlAll) {
      const v1 = campaBoltAbstainV1(r) ? 'V1' : '..';
      const v2 = campaBoltAbstainV2(r) ? 'V2' : '..';
      const v3 = campaBoltAbstainV3(r) ? 'V3' : '..';
      out(`  [${v1}|${v2}|${v3}] ${r.build} ${fmt(r)}${r.note ? ' /* ' + r.note + ' */' : ''}`);
    }

    const variants = [
      ['V1 peakTc∈{12,13} (verbatim spec)', campaBoltAbstainV1],
      ['V2 toothCount∈{12,13} (final-output gate)', campaBoltAbstainV2],
      ['V3 bcTc∈{12,13} (bc-channel gate)', campaBoltAbstainV3],
    ];

    for (const [label, fn] of variants) {
      out(`\n--- ${label} ---`);
      const tBkt = bucket(trainRows, fn);
      out(`  [TRAINING ${trainRows.length}] LOSS=${tBkt.wouldLoss.length} WIN=${tBkt.wouldWin.length} NOOP=${tBkt.trueNoop.length}`);
      if (tBkt.wouldLoss.length) { out('    LOSS rows:'); for (const r of tBkt.wouldLoss) out('      ' + fmt(r)); }
      if (tBkt.wouldWin.length) { out('    WIN rows:'); for (const r of tBkt.wouldWin) out('      ' + fmt(r)); }
      if (tBkt.trueNoop.length) { out('    NOOP rows:'); for (const r of tBkt.trueNoop) out('      ' + fmt(r)); }
      const xBkt = bucket(xlAll, fn);
      out(`  [XL ${xlAll.length}] LOSS=${xBkt.wouldLoss.length} WIN=${xBkt.wouldWin.length} NOOP=${xBkt.trueNoop.length}`);
      for (const r of xBkt.wouldLoss) out('    LOSS ' + r.build + ' ' + fmt(r));
      for (const r of xBkt.wouldWin) out('    WIN  ' + r.build + ' ' + fmt(r));
      for (const r of xBkt.trueNoop) out('    NOOP ' + r.build + ' ' + fmt(r));
      const ac1 = tBkt.wouldLoss.length === 0;
      const ac2 = xBkt.wouldLoss.length === 0;
      const ac3 = xBkt.wouldWin.some((r) => r.stamp === 'report_2026-05-01_14-52-05-858Z')
        || tBkt.wouldWin.some((r) => r.stamp === 'report_2026-05-01_14-52-05-858Z');
      out(`  ⇒ AC1 train-0-LOSS=${ac1?'PASS':'FAIL'} | AC2 XL-0-LOSS=${ac2?'PASS':'FAIL'} | AC3 Campa-WIN=${ac3?'PASS':'FAIL'}`);
    }

    expect(xlAll.length).toBeGreaterThan(0);
  });
});
