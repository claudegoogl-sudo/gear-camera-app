/**
 * PAP-772 abstain-gate classifier for the 11T cluster.
 *
 * Re-runs gearCounter against every actual=11 training photo, captures the
 * inputs the abstain gates consume (gearRadius, contourRadius, peakTc,
 * fft90tc, finalRel) and classifies which gate (if any) zeroed confidence:
 *   - PAP-553 Rule B:    gearRadius < 0.13                       → conf=0
 *   - PAP-673 cond:      gearRadius < 0.15 && tc >= 20           → conf=0
 *   - PAP-684/740 upper: cropNormR < 0.17 && tc in [9..13]       → conf=0
 *   - PAP-474/PAP-632:   collapsed earlier (finalTc set to 0 in analyzeImage)
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027). This
 * harness reaches into algorithm `__test` internals (analyzeImage, rgbaToGray,
 * etc.) per photo so it keeps a per-stamp decode + downsample loop using the
 * runner's algorithm bindings rather than going through evalPhoto.
 *
 * Run: HARNESS=pap772.gates npx jest --config mobile/__tests__/.jest.harness.config.js
 */

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const { decode: jpegDecode } = require('jpeg-js');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, TARGET_MAX_DIM } = runner;

const TARGET_ACTUAL = 11;

describe('PAP-772 11T abstain-gate classifier', () => {
  jest.setTimeout(30 * 60 * 1000);

  test('classify which gate fires per actual=11T photo', () => {
    const { bilinearDownsampleRgba, countTeethFromRgba } = runner.getAlgo();
    const __test = require('../src/algorithm/gearCounter').__test || {};

    const labeled = runner.discoverLabeled().filter((x) => x.actual === TARGET_ACTUAL);
    out(`\n[pap772] inspecting ${labeled.length} actual=${TARGET_ACTUAL}T photos`);

    const rows = [];
    for (let i = 0; i < labeled.length; i++) {
      const { photo, actual, stamp } = labeled[i];
      const buf = fs.readFileSync(photo);
      const raw = jpegDecode(buf, { useTArray: true });
      const { rgba, width: w, height: h } =
        bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET_MAX_DIM);

      let r;
      try { r = countTeethFromRgba(rgba, w, h); }
      catch (e) { r = { toothCount: 0, confidence: 0, error: e.message }; }

      // PAP-684/740 cropNormR is computed from r.contourRadius — but
      // countTeethFromRgba doesn't export contourRadius today, so we
      // reconstruct it via the analyzeImage internals.
      let contourRadius = NaN;
      let analyzeR = null;
      if (__test.analyzeImage && __test.rgbaToGray && __test.clahe
          && __test.gaussianBlur5x5 && __test.cannyEdges) {
        const gray = __test.rgbaToGray(rgba, w, h);
        const enh  = __test.clahe(gray, w, h, 3.0, 8, 8);
        const blur = __test.gaussianBlur5x5(enh, w, h);
        const edg  = __test.cannyEdges(blur, w, h, 50, 150);
        analyzeR = __test.analyzeImage(gray, enh, edg, w, h);
        contourRadius = analyzeR.contourRadius || 0;
      }

      const detected     = r.toothCount || 0;
      const confidence   = r.confidence || 0;
      const gearRadius   = r.gearRadius || 0;
      const cropNormR    = (contourRadius || 0) / Math.min(w, h);
      const innerSus     = !!r.innerContourSuspected;
      const peakTc       = r.peakTc || (analyzeR && analyzeR.peakTc) || 0;
      const fft90tc      = r.fft90tc || (analyzeR && analyzeR.fft90tc) || 0;
      const opTc         = r.opTc || (analyzeR && analyzeR.opTc) || 0;
      const method       = r.methodUsed || (analyzeR && analyzeR.methodUsed) || '?';

      const gates = [];
      if (detected === 0 && confidence === 0) {
        if (peakTc === 10 && fft90tc === 10) gates.push('PAP-474 (peak=fft90=10 floor)');
        else if (peakTc === 10) gates.push('PAP-632 fft-floor');
        else gates.push('analyzeImage abstain (no method matched)');
      }
      if (gearRadius < 0.13) gates.push('PAP-553 r<0.13');
      if (gearRadius < 0.15 && detected >= 20) gates.push('PAP-673 r<0.15 && tc>=20');
      if (cropNormR < 0.17 && detected >= 9 && detected <= 13)
        gates.push('PAP-684/740 cropNormR<0.17 && tc in [9..13]');

      rows.push({
        stamp, actual, detected, confidence,
        gearRadius, cropNormR, peakTc, fft90tc, opTc,
        method, innerSus, gates: gates.length ? gates : ['(no gate fired)'],
      });
    }

    out('\n=== PAP-772 11T per-photo gate trace ===');
    out('stamp                              det  conf   gR     cropNR  peak  fft90  op    method                               innerSus  gate(s)');
    for (const r of rows) {
      out(
        `${r.stamp.padEnd(34)} ${String(r.detected).padStart(3)}  ${r.confidence.toFixed(2)}  ` +
        `${r.gearRadius.toFixed(3)}  ${r.cropNormR.toFixed(3)}   ${String(r.peakTc).padStart(3)}   ${String(r.fft90tc).padStart(3)}   ${String(r.opTc).padStart(3)}  ` +
        `${(r.method || '?').padEnd(36)} ${String(r.innerSus).padStart(8)}  ${r.gates.join(' | ')}`
      );
    }

    const gateCounts = new Map();
    let abstainCorrect = 0, abstainWrong = 0, committedCorrect = 0, committedWrong = 0;
    for (const r of rows) {
      const isAbstain = r.confidence === 0 || r.detected === 0;
      const isCorrect = r.detected === r.actual;
      if (isAbstain && isCorrect) abstainCorrect++;
      else if (isAbstain && !isCorrect) abstainWrong++;
      else if (!isAbstain && isCorrect) committedCorrect++;
      else committedWrong++;
      for (const g of r.gates) {
        const key = `${g} | detected==actual=${isCorrect ? 'YES' : 'no'}`;
        gateCounts.set(key, (gateCounts.get(key) || 0) + 1);
      }
    }

    out('\n=== Gate-firing summary ===');
    for (const [k, v] of [...gateCounts.entries()].sort((a, b) => b[1] - a[1])) {
      out(`  ${String(v).padStart(3)}  ${k}`);
    }
    out('\n=== Outcome summary ===');
    out(`  abstain & correct      : ${abstainCorrect}`);
    out(`  abstain & wrong        : ${abstainWrong}`);
    out(`  committed & correct    : ${committedCorrect}`);
    out(`  committed & confidently-wrong : ${committedWrong}`);

    expect(rows.length).toBeGreaterThan(0);
  });
});
