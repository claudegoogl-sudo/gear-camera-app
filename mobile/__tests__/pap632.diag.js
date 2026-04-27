/**
 * PAP-632 diagnostic — runs gearCounter on the 6 failure photos from PAP-632
 * with enhanced logging to understand inner-contour lock-on root cause.
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

const { countTeethFromRgba, bilinearDownsampleRgba } = require('../src/algorithm/gearCounter');

const DEBUG_DIR = path.resolve(__dirname, '..', '..', 'debug-reports');
const TARGET_MAX_DIM = 900;

const FAILURES = [
  { stamp: '2026-04-24_06-12-31-044Z', actual: 28, issue: 'Inner ring of sprocket' },
  { stamp: '2026-04-24_06-54-04-432Z', actual: 28, issue: 'Wrong center + inner ring' },
  { stamp: '2026-04-24_07-16-03-083Z', actual: 11, issue: 'Knurled hub ring' },
  { stamp: '2026-04-24_10-59-07-941Z', actual: 51, issue: 'Inner hub of chainring' },
  { stamp: '2026-04-25_08-03-33-119Z', actual: 11, issue: 'Multi-gear scene' },
  { stamp: '2026-04-26_08-54-41-520Z', actual: 52, issue: 'Inner hub, PAP-553 gate failed' },
];

for (const f of FAILURES) {
  const photo = path.join(DEBUG_DIR, 'report_' + f.stamp, 'photo.jpg');
  if (!fs.existsSync(photo)) { console.log(`SKIP ${f.stamp} — no photo`); continue; }

  const buf = fs.readFileSync(photo);
  const raw = jpegDecode(buf, { useTArray: true });
  const { rgba, width: w, height: h } = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET_MAX_DIM);

  const result = countTeethFromRgba(rgba, w, h);
  const minDim = Math.min(w, h);

  console.log(`\n=== ${f.stamp} ===`);
  console.log(`  actual=${f.actual}  detected=${result.toothCount}  conf=${result.confidence.toFixed(3)}`);
  console.log(`  contourR=${result.contourRadius}  gearR=${result.gearR}  initialGearR=${result.initialGearR}`);
  console.log(`  cx=${result.cx}  cy=${result.cy}  imgCenter=(${Math.round(w/2)}, ${Math.round(h/2)})`);
  console.log(`  method=${result.methodUsed}`);
  console.log(`  peakTc=${result.peakTc} peakRel=${result.peakRel?.toFixed(3)}`);
  console.log(`  fft90tc=${result.fft90tc}`);
  console.log(`  opTc=${result.opTc} opRel=${result.opRel?.toFixed(3)}`);
  console.log(`  bcTc=${result.bcTc} bcPurity=${result.bcPurity?.toFixed(3)} bcPeaks=${result.bcPeaks}`);
  console.log(`  claheTc=${result.claheTc} claheConf=${result.claheConf?.toFixed(3)}`);
  console.log(`  contourR/minDim=${(result.contourRadius / minDim).toFixed(3)}`);
  console.log(`  gearR/minDim=${(result.gearR / minDim).toFixed(3)}`);
  console.log(`  centerResult.method=${result.centerResult?.method}`);
  console.log(`  DIAGNOSIS: ${f.issue}`);
  console.log(`  CORRECT? ${result.toothCount === f.actual ? 'YES' : 'NO (off by ' + (result.toothCount - f.actual) + ')'}`);
}
