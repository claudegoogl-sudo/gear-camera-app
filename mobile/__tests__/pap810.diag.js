/**
 * PAP-810 — XL near-miss diagnostic.
 *
 * Targets the six XL photos from the 2026-04-29 session (42T x2, 52T x4) and
 * runs the algorithm on the *device cropped.jpg* (post-aimCrop, ~1806x1806)
 * — the same input the on-device pipeline sees — so harness output mirrors
 * what the build produced. Prints all internal method outputs.
 *
 * Measurement only — no code changes.
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap810.diag npx jest --config mobile/__tests__/.jest.harness.config.js
 */

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, DEBUG_DIR } = runner;

const TARGETS = [
  { stamp: 'report_2026-04-29_05-29-04-170Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-31-25-376Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-33-35-933Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-35-33-518Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-37-38-177Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-39-22-521Z', actual: 52 },
];

describe('PAP-810 XL near-miss diagnostic (cropped.jpg path)', () => {
  jest.setTimeout(30 * 60 * 1000);

  test('per-method snapshot for 42T/52T cluster', () => {
    out('\n=== PAP-810 per-method snapshot (cropped.jpg) ===');
    for (const t of TARGETS) {
      const photo = path.join(DEBUG_DIR, t.stamp, 'cropped.jpg');
      if (!fs.existsSync(photo)) {
        out(`  ${t.stamp}  MISSING cropped.jpg`);
        continue;
      }
      const row = runner.evalPhoto({
        photo, actual: t.actual, stamp: t.stamp,
      });
      const r = row.raw;

      const tc = r.toothCount || 0;
      const peak = r.peakTc || 0;
      const fft90 = r.fft90tc || 0;
      const op = r.opTc || 0;
      const bcTc = r.bcTc || 0;
      const bcPeaks = r.bcPeaks || 0;
      const conf = r.confidence || 0;
      const innerSus = !!r.innerContourSuspected;
      const gearR = r.gearRadius || 0;
      const method = r.methodUsed || '?';
      const off = tc - t.actual;

      out(`  ${t.stamp}  ${row.w}x${row.h}  ` +
          `actual=${t.actual} tc=${tc} (${off>=0?'+':''}${off}) ` +
          `conf=${conf.toFixed(3)} peak=${peak} fft90=${fft90} op=${op} ` +
          `bcTc=${bcTc} bcPk=${bcPeaks} gR=${gearR.toFixed(4)} ` +
          `innerSus=${innerSus} method=${method}`);
    }

    expect(true).toBe(true);
  });
});
