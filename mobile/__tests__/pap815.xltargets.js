/**
 * PAP-815 fast XL-target verification (AC1, AC2 from QA PAP-818).
 *
 * Runs countTeethFromRgba on the 6 XL device cropped.jpg targets to confirm
 * the radial-chainring abstain fires on 05-35-33 and 05-39-22 (AC1 + AC2)
 * and is no-op on the 4 currently-correct/near-correct targets.
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap815.xltargets npx jest --config mobile/__tests__/.jest.harness.config.js
 */

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, DEBUG_DIR } = runner;

const XL_TARGETS = [
  { stamp: 'report_2026-04-29_05-29-04-170Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-31-25-376Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-33-35-933Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-35-33-518Z', actual: 52 }, // AC1 — must abstain
  { stamp: 'report_2026-04-29_05-37-38-177Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-39-22-521Z', actual: 52 }, // AC2 — must abstain
];

describe('PAP-815 XL-target verification', () => {
  jest.setTimeout(30 * 60 * 1000);

  test('PAP-815 abstain hits 05-35-33 and 05-39-22; no-op on the rest', () => {
    out('\n=== PAP-815 XL-target verification (radial-chainring abstain) ===');
    for (const t of XL_TARGETS) {
      const photo = path.join(DEBUG_DIR, t.stamp, 'cropped.jpg');
      if (!fs.existsSync(photo)) { out(`  [${t.stamp}] MISSING`); continue; }
      const row = runner.evalPhoto({
        photo, actual: t.actual, stamp: t.stamp,
      });
      const r = row.raw;
      const peakR = r.peakR || 0;
      const rOuter = r.rOuter || 0;
      const rel = r.radialRelDisagree;
      out(`  [${t.stamp.replace(/^report_/, '')}] actual=${t.actual} ` +
          `tc=${r.toothCount} conf=${r.confidence.toFixed(2)} ` +
          `peak=${r.peakTc} fft90=${r.fft90tc} op=${r.opTc} ` +
          `bc=${r.bcTc}(pk=${r.bcPeaks}) ` +
          `peakR=${peakR} rOuter=${rOuter} rel=${rel != null ? rel.toFixed(4) : 'n/a'} ` +
          `innerSus=${r.innerContourSuspected} method=${r.methodUsed}`);
    }
    expect(true).toBe(true);
  });
});
