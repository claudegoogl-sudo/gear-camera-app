/**
 * PAP-632 retry diagnostic — check primary vs retry results for XL failures.
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap632.retry npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');
const runner = require('./lib/harness-runner');
const { DEBUG_DIR, TARGET_MAX_DIM } = runner;
const { bilinearDownsampleRgba, __test } = require('../src/algorithm/gearCounter');
const { analyzeImage, rgbaToGray, clahe, gaussianBlur5x5, cannyEdges } = __test;

const CASES = [
  { stamp: '2026-04-25_09-03-08-982Z', actual: 52, note: 'XL 52T→12T (retry regression)' },
  { stamp: '2026-04-24_10-54-47-201Z', actual: 42, note: 'XL 42T→12T' },
];

for (const c of CASES) {
  const photo = path.join(DEBUG_DIR, 'report_' + c.stamp, 'photo.jpg');
  if (!fs.existsSync(photo)) { console.log(`SKIP ${c.stamp}`); continue; }

  const buf = fs.readFileSync(photo);
  const raw = jpegDecode(buf, { useTArray: true });
  const { rgba, width: w, height: h } = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET_MAX_DIM);

  const gray = rgbaToGray(rgba, w, h);
  const enhanced = clahe(gray, w, h, 3.0, 8, 8);
  const blurred = gaussianBlur5x5(enhanced, w, h);
  const edges = cannyEdges(blurred, w, h, 50, 150);

  const primary = analyzeImage(gray, enhanced, edges, w, h);

  console.log(`\n=== ${c.stamp} (actual=${c.actual}) ===`);
  console.log(`PRIMARY (before retry):`);
  console.log(`  toothCount=${primary.toothCount} conf=${primary.confidence.toFixed(3)}`);
  console.log(`  gearR=${primary.gearR} initialGearR=${primary.initialGearR} contourR=${primary.contourRadius}`);
  console.log(`  cx=${primary.cx} cy=${primary.cy}`);
  console.log(`  method=${primary.methodUsed}`);
  console.log(`  peakTc=${primary.peakTc} peakRel=${primary.peakRel?.toFixed(4)}`);
  console.log(`  fft90tc=${primary.fft90tc} opTc=${primary.opTc} opRel=${primary.opRel?.toFixed(4)}`);
  console.log(`  bcTc=${primary.bcTc} bcPurity=${primary.bcPurity?.toFixed(4)} bcPeaks=${primary.bcPeaks}`);
  const minDim = Math.min(w, h);
  console.log(`  contourR/minDim=${(primary.contourRadius/minDim).toFixed(4)}`);
  console.log(`  gearR/minDim=${(primary.gearR/minDim).toFixed(4)}`);
  console.log(`  imgCenter=(${Math.floor(w/2)}, ${Math.floor(h/2)}) foundCenter=(${primary.cx}, ${primary.cy})`);
  const imgCx = Math.floor(w / 2), imgCy = Math.floor(h / 2);
  const cdist = Math.sqrt((primary.cx - imgCx) ** 2 + (primary.cy - imgCy) ** 2);
  console.log(`  center_dist_from_img_center=${cdist.toFixed(1)} threshold=${(minDim*0.08).toFixed(1)}`);
  console.log(`  would_retry=${primary.confidence < 0.65 && cdist > minDim * 0.08}`);
}
