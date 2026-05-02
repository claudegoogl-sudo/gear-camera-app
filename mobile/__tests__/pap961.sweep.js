/**
 * PAP-961 aim-circle prior — pre-flight sweep.
 *
 * Predicate under test (per QA verdict on PAP-964, AC1 descope endorsed,
 * threshold 0.65, NOT 0.75):
 *
 *   aimPriorAbstain :=
 *     chainringMode (peakTc/fft90/op/bcTc/bcPeaks ≥ 30)
 *     AND peakR > 0
 *     AND peakR < 0.65 * aimR        // aimR = 0.5 * min(w,h)
 *     AND not tripleAgree
 *     AND not bcStrongAgree
 *     AND method ∉ {pap868-fft90-xl-rescue, pap885-fiveway-agree}
 *
 * Sweeps:
 *   - Full 9-60T training corpus (countTeethFromRgba, no mask) — proxy for
 *     Mid/Small/Large corpus per PAP-760 buckets.
 *   - b111-b117 XL device captures (cropped.jpg, mask=0.49*minDim) — AC1+AC2.
 *
 * Pass criteria (gates ship):
 *   - Small ≤ 2 LOSS
 *   - Mid   ≤ 2 LOSS
 *   - Large ≤ 2 LOSS
 *   - XL      0 LOSS
 *   - ≥ 1 net-new WIN on b117 panel (15-14-08 expected)
 *
 * Run: HARNESS=pap961.sweep npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, DEBUG_DIR } = runner;

const MIN_TEETH = 10;
const THRESH = 0.65;

// Same XL device panels as pap961c.sweep.js (PAP-963).
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
  { stamp: 'report_2026-05-01_15-12-27-152Z', actual: 52, build: 'b117', note: 'AC1 target' },
  { stamp: 'report_2026-05-01_15-14-08-511Z', actual: 52, build: 'b117', note: 'AC1 target' },
  { stamp: 'report_2026-05-01_15-20-25-637Z', actual: 52, build: 'b117' },
  { stamp: 'report_2026-05-01_15-21-57-850Z', actual: 52, build: 'b117' },
  { stamp: 'report_2026-05-01_15-28-06-337Z', actual: 36, build: 'b117' },
  { stamp: 'report_2026-05-01_15-30-03-986Z', actual: 36, build: 'b117' },
  { stamp: 'report_2026-05-01_15-37-16-032Z', actual: 36, build: 'b117' },
];

const B116_XL = [
  { stamp: 'report_2026-05-01_08-22-10-875Z', actual: 52, build: 'b116' },
  { stamp: 'report_2026-05-01_08-24-01-784Z', actual: 52, build: 'b116' },
  { stamp: 'report_2026-05-01_08-26-34-045Z', actual: 52, build: 'b116', note: 'AC1 candidate' },
  { stamp: 'report_2026-05-01_08-28-32-755Z', actual: 50, build: 'b116' },
  { stamp: 'report_2026-05-01_08-30-59-457Z', actual: 50, build: 'b116' },
  { stamp: 'report_2026-05-01_09-03-58-615Z', actual: 48, build: 'b116' },
  { stamp: 'report_2026-05-01_09-07-06-225Z', actual: 42, build: 'b116' },
  { stamp: 'report_2026-05-01_09-09-19-262Z', actual: 36, build: 'b116' },
];

// b111-b114 XL — includes 05-33-35 confident-correct b111 52T row that QA
// flagged as the LOSS-protection case driving 0.75→0.65 threshold change.
const PRIOR_XL = [
  { stamp: 'report_2026-04-29_05-29-04-170Z', actual: 42, build: 'b111' },
  { stamp: 'report_2026-04-29_05-31-25-376Z', actual: 42, build: 'b111' },
  { stamp: 'report_2026-04-29_05-33-35-933Z', actual: 52, build: 'b111', note: 'b111 conf-correct (LOSS-protect)' },
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

function aimPriorAbstain(r) {
  const aimR = 0.5 * Math.min(r.w, r.h);
  if (aimR <= 0) return false;
  const chReg = r.peakTc >= 30 || r.fft90 >= 30 || r.op >= 30
    || r.bcTc >= 30 || r.bcPeaks >= 30;
  if (!chReg) return false;
  if (!(r.peakR > 0 && r.peakR < THRESH * aimR)) return false;
  // Honour existing override bypasses so we do not collide with PAP-868/PAP-885.
  if (/pap868-fft90-xl-rescue|pap885-fiveway/.test(r.method || '')) return false;
  return true;
}

function bucket(rows) {
  const wouldLoss = []; const wouldWin = []; const trueNoop = [];
  for (const r of rows) {
    const tripleAgree = r.peakTc === r.fft90 && r.peakTc === r.op
      && r.peakTc === r.tc && r.peakTc > MIN_TEETH;
    const bcStrongAgree = r.bcTc === r.bcPeaks && Math.abs(r.bcTc - r.peakTc) > 5
      && r.tc === r.bcTc && r.bcTc > MIN_TEETH;
    if (!aimPriorAbstain(r)) continue;
    if (tripleAgree || bcStrongAgree) continue;
    if (r.tc === 0 || r.conf === 0 || r.innerSus) { trueNoop.push(r); continue; }
    if (r.conf < 0.40) { trueNoop.push(r); continue; }
    if (r.within1) wouldLoss.push(r); else wouldWin.push(r);
  }
  return { wouldLoss, wouldWin, trueNoop };
}

function fmt(r) {
  const aimR = 0.5 * Math.min(r.w, r.h);
  const ratio = aimR > 0 ? (r.peakR / aimR).toFixed(3) : '-';
  return `${r.stamp.slice(0, 30)} cls=${r.klass} act=${r.actual} tc=${r.tc} ` +
    `conf=${r.conf.toFixed(2)} peak=${r.peakTc} fft90=${r.fft90} op=${r.op} ` +
    `bc=${r.bcTc}(pk=${r.bcPeaks}) peakR=${r.peakR} aimR=${aimR.toFixed(0)} ` +
    `pk/aim=${ratio} m=${r.method}`;
}

describe('PAP-961 aim-circle prior pre-flight sweep', () => {
  jest.setTimeout(180 * 60 * 1000);
  test(`aimPriorAbstain peakR<${THRESH}*aimR — training + b111-b117 XL`, () => {
    out(`\n=== PAP-961 aim-circle prior sweep (peakR < ${THRESH} * aimR) ===`);

    const xlOnly = process.env.PAP961_XL_ONLY === '1';

    let trainRows = [];
    if (!xlOnly) {
      const { rows } = runner.runCorpus({
        targetRange: [9, 60],
        label: 'pap961-train',
        progressEvery: 50,
      });
      trainRows = rows;
    }
    out(`[Training] ${trainRows.length} photos (9-60T)`);

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
      const fires = aimPriorAbstain(r) ? 'AP' : '..';
      out(`  [${fires}] ${r.build} ${fmt(r)}${r.note ? ' /* ' + r.note + ' */' : ''}`);
    }

    // ── Training bucket ──
    const tBkt = bucket(trainRows);
    out(`\n[TRAINING ${trainRows.length}] LOSS=${tBkt.wouldLoss.length} WIN=${tBkt.wouldWin.length} NOOP=${tBkt.trueNoop.length}`);

    // Per-class LOSS distribution (against PAP-961 AC2 ≤2 each).
    const cls = { Small: 0, Mid: 0, Large: 0, XL: 0 };
    for (const r of tBkt.wouldLoss) cls[r.klass] = (cls[r.klass] || 0) + 1;
    out(`  per-class LOSS: Small=${cls.Small} Mid=${cls.Mid} Large=${cls.Large} XL=${cls.XL}`);
    if (tBkt.wouldLoss.length) { out('  LOSS rows:'); for (const r of tBkt.wouldLoss) out('    ' + fmt(r)); }
    if (tBkt.wouldWin.length) { out('  WIN rows:'); for (const r of tBkt.wouldWin) out('    ' + fmt(r)); }

    // ── XL device bucket ──
    const xBkt = bucket(xlAll);
    out(`\n[XL ${xlAll.length}] LOSS=${xBkt.wouldLoss.length} WIN=${xBkt.wouldWin.length} NOOP=${xBkt.trueNoop.length}`);
    for (const r of xBkt.wouldLoss) out('  LOSS ' + r.build + ' ' + fmt(r));
    for (const r of xBkt.wouldWin)  out('  WIN  ' + r.build + ' ' + fmt(r));
    for (const r of xBkt.trueNoop)  out('  NOOP ' + r.build + ' ' + fmt(r));

    const acSmall = (cls.Small || 0) <= 2;
    const acMid   = (cls.Mid   || 0) <= 2;
    const acLarge = (cls.Large || 0) <= 2;
    const acXL    = xBkt.wouldLoss.length === 0;
    const winB117 = xBkt.wouldWin.some((r) =>
      r.stamp === 'report_2026-05-01_15-14-08-511Z'
      || r.stamp === 'report_2026-05-01_15-12-27-152Z',
    );

    out('\n=== PAP-961 PASS GATES ===');
    out(`  Small LOSS ≤2 : ${cls.Small || 0} → ${acSmall ? 'PASS' : 'FAIL'}`);
    out(`  Mid   LOSS ≤2 : ${cls.Mid   || 0} → ${acMid   ? 'PASS' : 'FAIL'}`);
    out(`  Large LOSS ≤2 : ${cls.Large || 0} → ${acLarge ? 'PASS' : 'FAIL'}`);
    out(`  XL    LOSS  0 : ${xBkt.wouldLoss.length} → ${acXL ? 'PASS' : 'FAIL'}`);
    out(`  ≥1 WIN b117  : ${winB117 ? 'PASS' : 'FAIL'}`);
    out(`  OVERALL      : ${(acSmall && acMid && acLarge && acXL && winB117) ? 'PASS' : 'FAIL'}`);

    expect(xlAll.length).toBeGreaterThan(0);
  });
});
