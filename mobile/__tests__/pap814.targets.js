/**
 * PAP-814 — XL targets opRel snapshot.
 *
 * Runs the algorithm on the two PAP-810 device 42T targets (cropped.jpg) and
 * prints opRel so we can verify the chosen THRESH for the XL op-vote-boost
 * predicate.
 *
 * Measurement only.
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap814.targets npx jest --config mobile/__tests__/.jest.harness.config.js
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
];

describe('PAP-814 XL targets opRel snapshot', () => {
  jest.setTimeout(30 * 60 * 1000);

  test('opRel for 42T XL targets', () => {
    out('\n=== PAP-814 XL targets opRel snapshot ===');
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
      const opRel = r.opRel || 0;
      const conf = r.confidence || 0;
      const method = r.methodUsed || '?';
      const off = tc - t.actual;

      out(`  ${t.stamp}  actual=${t.actual} tc=${tc} (${off>=0?'+':''}${off}) ` +
          `conf=${conf.toFixed(3)} peak=${peak} fft90=${fft90} op=${op} ` +
          `opRel=${opRel.toFixed(4)} method=${method}`);

      const eligible = method === 'fft-agreement' && peak === fft90 &&
                       peak >= 30 && op === peak + 1;
      out(`    predicate-eligible: ${eligible}`);
      out(`    op-equals-actual: ${op === t.actual}`);
    }

    expect(true).toBe(true);
  });
});
