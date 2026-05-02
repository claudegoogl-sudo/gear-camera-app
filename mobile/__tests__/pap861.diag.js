/**
 * PAP-861 — 42T b112 radius-lock diagnostic.
 * Runs the algorithm on the 6 XL targets from b112 (2026-04-30) and prints
 * every signal we can surface so we can design the radius-stability fix.
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap861.diag npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, DEBUG_DIR } = runner;

const TARGETS = [
  { stamp: 'report_2026-04-30_05-32-51-092Z', actual: 42, label: 'CORRECT' },
  { stamp: 'report_2026-04-30_05-34-20-458Z', actual: 42, label: 'TOO_LARGE_0.292' },
  { stamp: 'report_2026-04-30_05-35-59-637Z', actual: 42, label: 'TOO_SMALL_0.192_BCD' },
  { stamp: 'report_2026-04-30_05-37-35-156Z', actual: 42, label: 'TOO_SMALL_0.158_BOLT' },
  // Also include earlier b112 42T reports as comparison
  { stamp: 'report_2026-04-29_05-29-04-170Z', actual: 42, label: 'b111 prior' },
  { stamp: 'report_2026-04-29_05-31-25-376Z', actual: 42, label: 'b111 prior' },
];

describe('PAP-861 42T b112 radius-lock diagnostic', () => {
  jest.setTimeout(30 * 60 * 1000);
  test('dump signals for each target', () => {
    out('\n=== PAP-861 42T b112 diagnostic ===');
    for (const t of TARGETS) {
      const photo = path.join(DEBUG_DIR, t.stamp, 'cropped.jpg');
      if (!fs.existsSync(photo)) { out(`  [${t.stamp}] MISSING`); continue; }
      const row = runner.evalPhoto({
        photo, actual: t.actual, stamp: t.stamp, applyMask: true,
      });
      const r = row.raw;
      const w = row.w, h = row.h;
      const peakR = r.peakR || 0;
      const rOuter = r.rOuter || 0;
      const rel = r.radialRelDisagree;
      const cropNR = (r.contourRadius || 0) / Math.min(w, h);
      out(`  [${t.label}] ${t.stamp.replace(/^report_/, '')} actual=${t.actual}`);
      out(`    tc=${r.toothCount} conf=${r.confidence.toFixed(3)} method=${r.methodUsed} innerSus=${r.innerContourSuspected}`);
      out(`    peak=${r.peakTc} fft90=${r.fft90tc} op=${r.opTc} bc=${r.bcTc}(pk=${r.bcPeaks})`);
      out(`    gearRadius=${r.gearRadius?.toFixed(4)} contourR=${r.contourRadius} cropNR=${cropNR.toFixed(4)} (w,h)=(${w},${h})`);
      out(`    peakR=${peakR} rOuter=${rOuter} rel=${rel != null ? rel.toFixed(4) : 'n/a'}`);
    }
    expect(true).toBe(true);
  });
});
