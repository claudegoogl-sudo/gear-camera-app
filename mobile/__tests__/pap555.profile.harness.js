/**
 * PAP-555 profiling harness — measure per-stage cost inside countTeethFromRgba
 * using the exposed __test entry points, so we can attribute the ~90s runtime
 * seen in b96 debug reports.
 *
 * Not part of default test run.
 * Usage: npx jest --runTestsByPath mobile/__tests__/pap555.profile.harness.js
 */

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

const TRAINING = path.resolve(__dirname, '..', '..', 'training-data');
const DEBUG    = path.resolve(__dirname, '..', '..', 'debug-reports');
const TARGET_MAX_DIM = 900;

describe('PAP-555 profile', () => {
  jest.setTimeout(10 * 60 * 1000);

  test('per-stage timing on recent captures', () => {
    const gc = require('../src/algorithm/gearCounter');
    const { __test, bilinearDownsampleRgba, countTeethFromRgba } = gc;
    const {
      rgbaToGray, clahe, gaussianBlur5x5, cannyEdges,
      analyzeImage, findGearCenter, fftPurityCheck,
      retryNearCenter,
    } = __test;

    // Pick a spread of photos: the five b96 debug reports referenced in PAP-555.
    const photos = [
      'report_2026-04-24_10-43-20-913Z/photo.jpg',
      'report_2026-04-24_10-49-26-061Z/photo.jpg',
      'report_2026-04-24_10-52-48-721Z/photo.jpg',
      'report_2026-04-24_10-54-47-201Z/photo.jpg',
      'report_2026-04-24_10-59-07-941Z/photo.jpg',
    ];

    const rows = [];
    for (const name of photos) {
      const p = path.join(DEBUG, name);
      if (!fs.existsSync(p)) { rows.push({ name, err: 'missing' }); continue; }
      const buf = fs.readFileSync(p);
      const raw = jpegDecode(buf, { useTArray: true });
      const ds  = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET_MAX_DIM);
      const { rgba, width: w, height: h } = ds;

      const tA = Date.now();
      const gray = rgbaToGray(rgba, w, h);
      const tB = Date.now();
      const enhanced = clahe(gray, w, h, 3.0, 8, 8);
      const tC = Date.now();
      const blurred = gaussianBlur5x5(enhanced, w, h);
      const tD = Date.now();
      const edges = cannyEdges(blurred, w, h, 50, 150);
      const tE = Date.now();
      const r = analyzeImage(gray, enhanced, edges, w, h);
      const tF = Date.now();

      let retryMs = 0;
      if (r && r.confidence !== undefined && r.confidence < 0.6 && r.cx !== undefined) {
        const imgCx = Math.floor(w / 2), imgCy = Math.floor(h / 2);
        const cdist = Math.sqrt((r.cx - imgCx) ** 2 + (r.cy - imgCy) ** 2);
        if (cdist > Math.min(w, h) * 0.08) {
          const tR = Date.now();
          retryNearCenter(gray, enhanced, edges, w, h, imgCx, imgCy);
          retryMs = Date.now() - tR;
        }
      }
      const tG = Date.now();

      rows.push({
        name, w, h,
        rgbaToGray: tB - tA,
        clahe: tC - tB,
        blur: tD - tC,
        canny: tE - tD,
        analyze: tF - tE,
        retry: retryMs,
        total: tG - tA,
        toothCount: r.toothCount,
        confidence: r.confidence,
      });
    }

    console.log('\n=== PAP-555 per-stage timings ===');
    for (const r of rows) {
      if (r.err) { console.log(r.name, r.err); continue; }
      console.log(
        `${r.name}\n  ${r.w}x${r.h}  gray=${r.rgbaToGray}ms  clahe=${r.clahe}ms  blur=${r.blur}ms  canny=${r.canny}ms  analyze=${r.analyze}ms  retry=${r.retry}ms  total=${r.total}ms\n  result=${r.toothCount}T conf=${(r.confidence*100).toFixed(0)}%`,
      );
    }
  });
});
