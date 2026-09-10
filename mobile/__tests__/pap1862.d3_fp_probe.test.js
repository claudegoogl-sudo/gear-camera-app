/**
 * PAP-1862 — QA host reproduction: FP5 b151 live session, 2/2 labeled 20T
 * captures D3-abstained on device (methodUsed=pap1534-d3-dense-chainring-abstain).
 *
 * Ask (AE -> QA): run both captured cropped.jpg at HEAD through the standard
 * cropped+masked harness pipeline (PAP-1599/PAP-1609 protocol: bilinear->900,
 * 0.49*min(W,H) circular mask) and directly read the D3 gate
 * (checkDenseChainringRegime) on the SAME center findGearCenter picks, to
 * decide algorithm-bug-at-HEAD vs device-only divergence.
 *
 * Measurement only; no algorithm changes. Rows printed as JSON to stdout and
 * saved to debug-reports/pap1862_fp5_b151_session_2026-09-10/host_repro_rows.json.
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode } = require('jpeg-js');

const algo = require('../src/algorithm/gearCounter');
const { preprocess } = require('../src/algorithm/preprocess');
const { applyCircularMask } = require('../src/algorithm/imageUtils');

const BASE = path.resolve(__dirname, '..', '..', 'debug-reports', 'pap1862_fp5_b151_session_2026-09-10');
const ATT = path.join(BASE, 'attachments');

// Device telemetry (Sentry GEAR-CAMERA-APP-3, release v1.0.0 (151))
const CAPTURES = [
  { tag: 'A', event: 'dad332a5', file: 'captureA_898620612_cropped.jpg', actual: 20,
    device: { rOuter: 144, detectMs: 19813, totalMs: 24018, method: 'pap1534-d3-dense-chainring-abstain' } },
  { tag: 'B', event: '7d20ca5f', file: 'captureB_898623252_cropped.jpg', actual: 20,
    device: { rOuter: 155, detectMs: 20257, totalMs: 24284, method: 'pap1534-d3-dense-chainring-abstain' } },
];

describe('PAP-1862 host reproduction at HEAD (20T D3-abstain FP)', () => {
  const rows = [];

  test.each(CAPTURES)('capture $tag: full pipeline + direct D3 gate read', (c) => {
    const raw = decode(fs.readFileSync(path.join(ATT, c.file)), { useTArray: true });
    const { rgba, width: w, height: h } = algo.bilinearDownsampleRgba(raw.data, raw.width, raw.height, 900);
    applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));

    // 1) full production path (harness parity with countTeethFromRgba)
    const t0 = Date.now();
    const r = algo.countTeethFromRgba(rgba, w, h);
    const runtimeMs = Date.now() - t0;

    // 2) direct D3 gate read mirroring analyzeImage internals:
    //    checkDenseChainringRegime(gray, cx, cy, contourRadius, gearR, w, h)
    const { gray, enhanced, edges } = preprocess(rgba, w, h);
    const budgetState = { hit: false };
    const centerResult = algo.__test.findGearCenter(gray, enhanced, edges, w, h, Infinity, budgetState);
    const contourRadius = centerResult.radius || 0;
    const dense = algo.__test.checkDenseChainringRegime(
      gray, centerResult.cx, centerResult.cy, contourRadius, contourRadius, w, h,
    );

    const row = {
      capture: c.tag,
      event: c.event,
      actual: c.actual,
      device: c.device,
      host: {
        toothCount: r.toothCount,
        confidence: r.confidence,
        methodUsed: r.methodUsed || null,
        gearRadiusNorm: r.gearRadius ?? null,
        rOuter: r.rOuter ?? null,
        innerContourSuspected: r.innerContourSuspected,
        budgetExhausted: r.budgetExhausted,
        runtimeMs,
        gate: {
          isDense: dense.isDense,
          innerRadius: dense.innerRadius,
          fraction: Number(dense.fraction.toFixed(4)),
          threshold: 0.50,
          contourRadius,
          cx: centerResult.cx,
          cy: centerResult.cy,
        },
      },
    };
    rows.push(row);
    process.stdout.write(`PAP1862ROW ${JSON.stringify(row)}\n`);
    expect(true).toBe(true);
  }, 180000);

  afterAll(() => {
    try {
      fs.writeFileSync(path.join(BASE, 'host_repro_rows.json'), JSON.stringify(rows, null, 2));
    } catch (e) { /* best-effort artifact write */ }
  });
});
