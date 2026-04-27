/**
 * PAP-555 inner profile harness — decompose analyzeImage into its six
 * component calls and attribute runtime cost.
 *
 * Not part of default test run.
 * Usage: npx jest --runTestsByPath mobile/__tests__/pap555.inner.harness.js
 */

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

const DEBUG = path.resolve(__dirname, '..', '..', 'debug-reports');

describe('PAP-555 inner profile', () => {
  jest.setTimeout(10 * 60 * 1000);

  test('attribute analyzeImage internal cost', () => {
    const gc = require('../src/algorithm/gearCounter');
    const { __test, bilinearDownsampleRgba } = gc;
    const {
      rgbaToGray, clahe, gaussianBlur5x5, cannyEdges,
      findGearCenter,
    } = __test;

    // Re-import private helpers via eval isn't ideal — instead, monkey-patch
    // __test to add wrappers for the helpers not exported.  We can't get
    // findGearRadius / fftAtOuterRadii / etc. directly; so instrument by
    // calling analyzeImage and injecting a console.time around each of its
    // six phases isn't possible without editing source.
    //
    // Fallback: time findGearCenter (the most-suspected hotspot) in isolation,
    // then the remainder = analyzeImage - findGearCenter.

    const photos = [
      'report_2026-04-24_10-43-20-913Z/photo.jpg', // 28T
      'report_2026-04-24_10-49-26-061Z/photo.jpg', // 17T
      'report_2026-04-24_10-52-48-721Z/photo.jpg', // 11T
      'report_2026-04-24_10-54-47-201Z/photo.jpg', // 12T
      'report_2026-04-24_10-59-07-941Z/photo.jpg', // 21T
    ];

    console.log('\n=== PAP-555 analyzeImage breakdown ===');
    for (const name of photos) {
      const p = path.join(DEBUG, name);
      if (!fs.existsSync(p)) { console.log(name, 'missing'); continue; }
      const buf = fs.readFileSync(p);
      const raw = jpegDecode(buf, { useTArray: true });
      const { rgba, width: w, height: h } = bilinearDownsampleRgba(raw.data, raw.width, raw.height, 900);
      const gray = rgbaToGray(rgba, w, h);
      const enhanced = clahe(gray, w, h, 3.0, 8, 8);
      const blurred = gaussianBlur5x5(enhanced, w, h);
      const edges = cannyEdges(blurred, w, h, 50, 150);

      const tFGC = Date.now();
      const cr = findGearCenter(gray, enhanced, edges, w, h);
      const findGearCenterMs = Date.now() - tFGC;

      const tAI = Date.now();
      const r = __test.analyzeImage(gray, enhanced, edges, w, h);
      const analyzeMs = Date.now() - tAI;

      console.log(
        `${name}  ${w}x${h}\n  findGearCenter=${findGearCenterMs}ms  ` +
        `analyzeImage(total)=${analyzeMs}ms  remainder=${analyzeMs - findGearCenterMs}ms\n` +
        `  center=(${cr.cx},${cr.cy}) r=${cr.radius} method=${cr.method}\n` +
        `  result=${r.toothCount}T conf=${(r.confidence*100).toFixed(0)}% via=${r.methodUsed}`,
      );
    }
  });
});
