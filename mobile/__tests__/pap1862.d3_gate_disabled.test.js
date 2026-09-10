/**
 * PAP-1862 — the D3 dense-chainring gate (PAP-1534) is DISABLED on main:
 * gearCounter.js keeps checkDenseChainringRegime but no longer honors its
 * abstain (D3_DENSE_GATE_ENABLED = false).
 *
 * QA evidence (commit 61f968b, debug-reports/pap1862_fp5_b151_session_2026-09-10/):
 *  - 364-photo threshold sweep: class fraction-medians interleave (AUC 0.375);
 *    at THRESHOLD 0.50 the gate abstains 200/284 = 70.4% of ordinary gears —
 *    no threshold meets PAP-1855 (dense abstain >=90%, ordinary FP <5%).
 *  - Cheap-FFT two-feature rescue ruled out (28.6% dense retention).
 *  - FP5 b151 live session: 2/2 labeled 20T captures abstained, host-exact
 *    at HEAD; with the gate bypassed both anchors return toothCount=20.
 *
 * Per the PAP-1686 AC2 standing policy these tests assert the OUTCOME the
 * change preserves — ordinary gears are counted, not abstained — not merely
 * that a guard flipped. Spot-check photos are chosen deterministically from
 * QA's committed threshold_sweep_rows.json: labeled photos the gate WOULD
 * have abstained (fraction < 0.50), spread across the ordinary classes.
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode } = require('jpeg-js');
const runner = require('./lib/harness-runner');
runner.silenceConsole();

const algo = require('../src/algorithm/gearCounter');
const { applyCircularMask } = require('../src/algorithm/imageUtils');

const BASE = path.resolve(__dirname, '..', '..', 'debug-reports', 'pap1862_fp5_b151_session_2026-09-10');
const ATT = path.join(BASE, 'attachments');
const TRAINING_DIR = path.resolve(__dirname, '..', '..', 'training-data');

const ANCHORS = [
  { tag: 'A', file: path.join(ATT, 'captureA_898620612_cropped.jpg'), actual: 20 },
  { tag: 'B', file: path.join(ATT, 'captureB_898623252_cropped.jpg'), actual: 20 },
];

function runPipelineFile(file) {
  const raw = decode(fs.readFileSync(file), { useTArray: true });
  const { rgba, width: w, height: h } = algo.bilinearDownsampleRgba(raw.data, raw.width, raw.height, 900);
  applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
  return algo.countTeethFromRgba(rgba, w, h);
}

// Deterministic picks from the committed QA sweep: rows the gate would have
// abstained (isDense=true), 8 spread across ordinary classes (9-39T) plus 1
// true-dense photo (>=40T) pinning the ACCEPTED regression (dense photos go
// back to the pre-D3 collapse until a validated D-track replacement lands).
function pickSpotChecks() {
  const rows = JSON.parse(fs.readFileSync(path.join(BASE, 'threshold_sweep_rows.json'), 'utf8'))
    .filter((r) => r.source === 'training-data' && r.isDense === true && !r.error);
  const ordinary = rows.filter((r) => r.actual >= 9 && r.actual <= 39);
  const dense = rows.filter((r) => r.actual >= 40);
  const spread = (arr, n) => {
    const out = [];
    for (let i = 0; i < n && arr.length; i++) out.push(arr[Math.floor((i * arr.length) / n)]);
    return out;
  };
  return [
    ...spread(ordinary, 8).map((r) => ({ stamp: r.stamp, actual: r.actual, dense: false })),
    ...dense.slice(0, 1).map((r) => ({ stamp: r.stamp, actual: r.actual, dense: true })),
  ];
}

describe('PAP-1862: D3 gate disabled — ordinary gears are counted again', () => {
  test.each(ANCHORS)(
    'anchor $tag (device-labeled 20T): pipeline returns 20, not the D3 abstain',
    (c) => {
      const r = runPipelineFile(c.file);
      runner.out(`PAP1862GATEOFF anchor${c.tag} tc=${r.toothCount} conf=${r.confidence} method=${r.methodUsed}`);
      expect(r.methodUsed).not.toBe('pap1534-d3-dense-chainring-abstain');
      expect(r.toothCount).toBe(c.actual);
      expect(r.confidence).toBeGreaterThan(0);
    },
    180000,
  );

  test('gate function itself still reports isDense=true on the anchors (feature unchanged; pipeline ignores it)', () => {
    const { preprocess } = require('../src/algorithm/preprocess');
    for (const c of ANCHORS) {
      const raw = decode(fs.readFileSync(c.file), { useTArray: true });
      const { rgba, width: w, height: h } = algo.bilinearDownsampleRgba(raw.data, raw.width, raw.height, 900);
      applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
      const { gray, enhanced, edges } = preprocess(rgba, w, h);
      const center = algo.__test.findGearCenter(gray, enhanced, edges, w, h, Infinity, { hit: false });
      const dense = algo.__test.checkDenseChainringRegime(gray, center.cx, center.cy, center.radius || 0, center.radius || 0, w, h);
      expect(dense.isDense).toBe(true); // known-false-positive feature, deliberately bypassed
    }
  }, 180000);

  test('spot-checks: labeled photos the gate used to eat are no longer D3-abstained', () => {
    const checks = pickSpotChecks();
    expect(checks.filter((c) => !c.dense).length).toBe(8); // QA sweep data present
    const rows = [];
    for (const c of checks) {
      const file = path.join(TRAINING_DIR, `${c.stamp}_photo.jpg`);
      expect(fs.existsSync(file)).toBe(true);
      const r = runPipelineFile(file);
      rows.push({ stamp: c.stamp, actual: c.actual, dense: c.dense, tc: r.toothCount, conf: r.confidence, method: r.methodUsed });
      runner.out(`PAP1862GATEOFF ${c.stamp} actual=${c.actual} tc=${r.toothCount} conf=${Number(r.confidence).toFixed(2)} method=${r.methodUsed}`);
      // The outcome this change preserves: the D3 abstain never fires. What
      // the pre-D3 pipeline then does per photo is its baseline behavior —
      // some photos carry INDEPENDENT pre-existing abstains (e.g. 11T
      // 2026-04-19_11-32-11-962Z hits pap632-fft-floor-abstain, which the
      // D3 gate used to shadow), so toothCount>0 is asserted only on the
      // device-labeled anchors above, not here.
      expect(r.methodUsed).not.toBe('pap1534-d3-dense-chainring-abstain');
    }
    // information-only accuracy echo for the ordinary spot-checks
    const ord = rows.filter((r) => !r.dense);
    const exact = ord.filter((r) => r.tc === r.actual).length;
    const counted = ord.filter((r) => r.tc > 0).length;
    runner.out(`PAP1862GATEOFF ordinary-spotcheck exact ${exact}/${ord.length} counted ${counted}/${ord.length}`);
  }, 900000);
});
