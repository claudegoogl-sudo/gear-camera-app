/**
 * PAP-885 b114 XL diag: full analyzeImage output for 5 b114 XL targets
 * (3× 34T, 2× 36T) so we can see why 34T off-by-{16,6} and 36T off-by-1
 * land confident-wrong (only 1/5 abstaining via inner-contour gates).
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap885.diag npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, DEBUG_DIR } = runner;

const TARGETS = [
  { stamp: 'report_2026-04-30_10-09-03-515Z', actual: 34 }, // det=18 conf=0
  { stamp: 'report_2026-04-30_10-14-44-086Z', actual: 34 }, // det=28 conf=0
  { stamp: 'report_2026-04-30_10-17-03-115Z', actual: 34 }, // det=34 conf=1 (correct)
  { stamp: 'report_2026-04-30_10-19-19-295Z', actual: 36 }, // det=35 conf=0
  { stamp: 'report_2026-04-30_10-23-07-161Z', actual: 36 }, // det=36 conf=0 (correct, but conf=0)
];

describe('PAP-885 b114 XL diag', () => {
  jest.setTimeout(20 * 60 * 1000);
  test('full analyzeImage output on 5 b114 XL targets', () => {
    out('\n=== PAP-885 b114 XL diag ===\n');
    for (const t of TARGETS) {
      const photo = path.join(DEBUG_DIR, t.stamp, 'cropped.jpg');
      if (!fs.existsSync(photo)) { out(`  [missing] ${t.stamp}`); continue; }
      const row = runner.evalPhoto({
        photo, actual: t.actual, stamp: t.stamp, applyMask: true,
      });
      if (row.raw && row.raw.error) { out(`  [err] ${t.stamp}: ${row.raw.error}`); continue; }
      const r = row.raw;
      const ms = row.runtime;

      out(`-- ${t.stamp} actual=${t.actual} ${ms}ms`);
      out(`   tc=${r.toothCount} conf=${(r.confidence||0).toFixed(2)} method=${r.methodUsed||'?'}`);
      out(`   peak=${r.peakTc||0} fft90=${r.fft90tc||0} op=${r.opTc||0} bc=${r.bcTc||0}(pk=${r.bcPeaks||0})`);
      out(`   peakRel=${(r.peakRel||0).toFixed(3)} fft90Rel=${(r.fft90Rel||0).toFixed(3)} opRel=${(r.opRel||0).toFixed(3)} bcRel=${(r.bcRel||0).toFixed(3)}`);
      out(`   peakR=${r.peakR||0} rOuter=${r.rOuter||0} rel=${r.radialRelDisagree!=null?r.radialRelDisagree.toFixed(4):'n/a'}`);
      out(`   gearRadius=${(r.gearRadius||0).toFixed(3)} cropNormR=${(r.cropNormR||0).toFixed(3)} contourR=${r.contourRadius||0}`);
      out(`   innerSus=${!!r.innerContourSuspected}`);
      out('');
    }
    expect(true).toBe(true);
  });
});
