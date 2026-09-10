/**
 * PAP-1862 — QA threshold-evidence sweep for the D3 dense-chainring gate
 * (PAP-1534) after the 2026-09-10 FP5 b151 2/2 labeled-20T FP abstain.
 *
 * For EVERY labeled training photo (9..60T, standard harness protocol:
 * bilinear->900 + 0.49*min(W,H) circular mask) this reads ONLY:
 *   preprocess -> findGearCenter -> checkDenseChainringRegime
 * i.e. the exact inputs/outputs analyzeImage feeds the gate at HEAD,
 * plus the two PAP-1862 captured cropped.jpg as device-truth anchors.
 *
 * Purpose: place innerRadius/contourRadius fraction distributions per
 * actual-tooth class so a revised threshold can be chosen with evidence
 * (dense abstain >=90% kept, ordinary-gear FP <5% per PAP-1855 criteria).
 * Measurement only; no algorithm changes.
 *
 * Rows -> debug-reports/pap1862_fp5_b151_session_2026-09-10/threshold_sweep_rows.json
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
const OUT = path.join(BASE, 'threshold_sweep_rows.json');
const ATT = path.join(BASE, 'attachments');

const ANCHORS = [
  { source: 'pap1862-capture', stamp: 'pap1862_captureA_cropped', actual: 20, file: path.join(ATT, 'captureA_898620612_cropped.jpg') },
  { source: 'pap1862-capture', stamp: 'pap1862_captureB_cropped', actual: 20, file: path.join(ATT, 'captureB_898623252_cropped.jpg') },
];

function gateRead(rgba, w, h) {
  const { gray, enhanced, edges } = preprocess(rgba, w, h);
  const budgetState = { hit: false };
  const centerResult = algo.__test.findGearCenter(gray, enhanced, edges, w, h, Infinity, budgetState);
  const contourRadius = centerResult.radius || 0;
  const dense = algo.__test.checkDenseChainringRegime(
    gray, centerResult.cx, centerResult.cy, contourRadius, contourRadius, w, h,
  );
  return {
    contourRadius,
    cx: centerResult.cx, cy: centerResult.cy,
    innerRadius: dense.innerRadius,
    fraction: Number(dense.fraction.toFixed(4)),
    isDense: dense.isDense,
  };
}

describe('PAP-1862 D3 threshold sweep (full labeled corpus + 2 capture anchors)', () => {
  test('gate fraction per labeled photo', () => {
    const rows = [];

    // device-truth anchors first
    for (const a of ANCHORS) {
      const raw = decode(fs.readFileSync(a.file), { useTArray: true });
      const { rgba, width: w, height: h } = algo.bilinearDownsampleRgba(raw.data, raw.width, raw.height, 900);
      applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
      const g = gateRead(rgba, w, h);
      rows.push({ source: a.source, stamp: a.stamp, actual: a.actual, ...g });
      runner.out(`PAP1862SWEEP ${rows.length} ${JSON.stringify(rows[rows.length - 1])}`);
    }

    // full labeled corpus (standard harness protocol)
    const labeled = runner.discoverLabeled({ minActual: 9, maxActual: 60 });
    runner.out(`PAP1862SWEEP corpus=${labeled.length}`);
    const t0 = Date.now();
    for (let i = 0; i < labeled.length; i++) {
      const { photo, actual, stamp } = labeled[i];
      let row;
      try {
        const { rgba, w, h } = runner.loadOrDecodeRgba(photo, stamp);
        applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
        const g = gateRead(rgba, w, h);
        row = { source: 'training-data', stamp, actual, ...g };
      } catch (e) {
        row = { source: 'training-data', stamp, actual, error: String(e && e.message || e) };
      }
      rows.push(row);
      if ((i + 1) % 5 === 0 || i === labeled.length - 1) {
        runner.out(`PAP1862SWEEP ${i + 1}/${labeled.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
      // incremental save so a kill mid-run still leaves usable data
      if ((i + 1) % 25 === 0) {
        try { fs.writeFileSync(OUT, JSON.stringify(rows, null, 1)); } catch { /* best-effort */ }
      }
    }
    fs.writeFileSync(OUT, JSON.stringify(rows, null, 1));
    runner.out(`PAP1862SWEEP done rows=${rows.length}`);
    expect(rows.length).toBe(labeled.length + ANCHORS.length);
  }, 7200000);
});
