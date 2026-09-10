/**
 * PAP-1862 — two-feature D3-gate rescue measurement (QA cross-check).
 *
 * Question: the single-scalar fraction gate cannot separate dense chainrings
 * from ordinary gears on the real corpus (threshold sweep evidence). Does
 * adding a CHEAP confirming tooth-band estimate — fftAtOuterRadii +
 * outerProfileScan, the same first two method reads analyzeImage runs —
 * separate the fraction<0.50 population into ordinary (<30T -> let through)
 * vs dense (>=30T -> abstain)?
 *
 * Population: every sweep row with fraction < 0.50 (both capture anchors,
 * ordinary FPs, and currently-abstained dense photos). Rows ->
 * debug-reports/pap1862_fp5_b151_session_2026-09-10/rescue_rows.json
 * Measurement only; no algorithm changes.
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode } = require('jpeg-js');
const runner = require('./lib/harness-runner');
runner.silenceConsole();

const algo = require('../src/algorithm/gearCounter');
const { preprocess } = require('../src/algorithm/preprocess');
const { applyCircularMask } = require('../src/algorithm/imageUtils');

const BASE = path.resolve(__dirname, '..', '..', 'debug-reports', 'pap1862_fp5_b151_session_2026-09-10');
const SWEEP = path.join(BASE, 'threshold_sweep_rows.json');
const OUT = path.join(BASE, 'rescue_rows.json');
const ATT = path.join(BASE, 'attachments');

describe('PAP-1862 two-feature rescue probe (fraction<0.50 population)', () => {
  test('cheap FFT band read on the abstain band', () => {
    const sweep = JSON.parse(fs.readFileSync(SWEEP, 'utf8'));
    const band = sweep.filter((r) => !r.error && r.fraction < 0.50);
    runner.out(`PAP1862RESCUE band=${band.length}`);

    const rows = [];
    const t0 = Date.now();
    for (let i = 0; i < band.length; i++) {
      const r0 = band[i];
      let row = { ...r0, rescueError: null };
      try {
        let rgba, w, h;
        if (r0.source === 'pap1862-capture') {
          const f = r0.stamp.includes('captureA') ? 'captureA_898620612_cropped.jpg' : 'captureB_898623252_cropped.jpg';
          const raw = decode(fs.readFileSync(path.join(ATT, f)), { useTArray: true });
          ({ rgba, width: w, height: h } = algo.bilinearDownsampleRgba(raw.data, raw.width, raw.height, 900));
        } else {
          const photo = path.resolve(__dirname, '..', '..', 'training-data', `${r0.stamp}_photo.jpg`);
          ({ rgba, w, h } = runner.loadOrDecodeRgba(photo, r0.stamp));
        }
        applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
        const { gray, enhanced, edges } = preprocess(rgba, w, h);
        const c = algo.__test.findGearCenter(gray, enhanced, edges, w, h, Infinity, { hit: false });
        const cr = c.radius || 0;
        const dense = algo.__test.checkDenseChainringRegime(gray, c.cx, c.cy, cr, cr, w, h);
        const fft90tc = algo.__test.fftAtOuterRadii(enhanced, c.cx, c.cy, cr, cr, edges, w, h);
        const { opTc } = algo.__test.outerProfileScan(edges, c.cx, c.cy, Math.min(c.cx, w - c.cx, c.cy, h - c.cy) - 1, w, h, cr);
        row = { ...row, fraction: Number(dense.fraction.toFixed(4)), fft90tc, opTc, cheapMax: Math.max(fft90tc, opTc) };
      } catch (e) {
        row.rescueError = String((e && e.message) || e);
      }
      rows.push(row);
      if ((i + 1) % 5 === 0 || i === band.length - 1) {
        runner.out(`PAP1862RESCUE ${i + 1}/${band.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
      if ((i + 1) % 25 === 0) { try { fs.writeFileSync(OUT, JSON.stringify(rows, null, 1)); } catch { } }
    }
    fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));
    runner.out(`PAP1862RESCUE done rows=${rows.length}`);
    expect(rows.length).toBe(band.length);
  }, 7200000);
});
