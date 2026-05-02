/**
 * PAP-810 pre-flight (per QA PAP-811): print FFT magnitudes M[k-2..k+2] around
 * peakTc for the 6 XL photos. We need to know whether sub-bin interpolation /
 * zero-padding to 2048 would round to k+1 (correct for 42T) or stay at k.
 *
 * Pure measurement — exposes peakR + sampleIntensityRing via __test, then
 * re-runs the same SavGol+FFT path the algorithm uses at the chosen peakR.
 *
 * Run:
 *   HARNESS=pap810.preflight npx jest --config __tests__/.jest.harness.config.js
 */

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const runner = require('./lib/harness-runner');
const { out, DEBUG_DIR, TARGET_MAX_DIM } = runner;
runner.silenceConsole();

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');
const { fftMagnitude } = require('../src/algorithm/fft');
const { savgolSmooth } = require('../src/algorithm/imageUtils');

const N_ANGLES = 1024;

const TARGETS = [
  { stamp: 'report_2026-04-29_05-29-04-170Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-31-25-376Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-33-35-933Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-35-33-518Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-37-38-177Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-39-22-521Z', actual: 52 },
];

function magsAtRadius(enhanced, cx, cy, r, w, h, sampleIntensityRing) {
  const ring = sampleIntensityRing(enhanced, cx, cy, r, w, h, N_ANGLES);
  const halfWin = Math.max(2, Math.floor(N_ANGLES / 90));
  const sm = savgolSmooth(ring, halfWin, true);
  let mean = 0;
  for (let i = 0; i < sm.length; i++) mean += sm[i];
  mean /= sm.length;
  const centered = new Array(sm.length);
  for (let i = 0; i < sm.length; i++) centered[i] = sm[i] - mean;
  return fftMagnitude(centered);
}

// Zero-pad the centered signal to 2N then FFT — gives sub-bin frequency
// resolution at no resample cost. (QA PAP-811 recommendation.)
function magsAtRadiusZeroPad(enhanced, cx, cy, r, w, h, sampleIntensityRing) {
  const ring = sampleIntensityRing(enhanced, cx, cy, r, w, h, N_ANGLES);
  const halfWin = Math.max(2, Math.floor(N_ANGLES / 90));
  const sm = savgolSmooth(ring, halfWin, true);
  let mean = 0;
  for (let i = 0; i < sm.length; i++) mean += sm[i];
  mean /= sm.length;
  const padded = new Array(sm.length * 2).fill(0);
  for (let i = 0; i < sm.length; i++) padded[i] = sm[i] - mean;
  return fftMagnitude(padded);
}

describe('PAP-810 pre-flight: FFT magnitudes around peakTc', () => {
  jest.setTimeout(30 * 60 * 1000);

  test('print M[k-2..k+2] at chosen peakR', () => {
    const { countTeethFromRgba, bilinearDownsampleRgba, __test } = runner.getAlgo();
    const { sampleIntensityRing, rgbaToGray, clahe } = __test;

    out('\n=== PAP-810 pre-flight: FFT mag slices at chosen peakR ===');
    out('Format: peakTc=k  M[k-2] M[k-1] M[k] M[k+1] M[k+2]   (zero-pad N=2048)  M[2(k-1)] M[2k-1] M[2k] M[2k+1] M[2(k+1)]');
    out('');

    for (const t of TARGETS) {
      const photo = path.join(DEBUG_DIR, t.stamp, 'cropped.jpg');
      if (!fs.existsSync(photo)) {
        out(`  ${t.stamp}  MISSING cropped.jpg`);
        continue;
      }
      const buf = fs.readFileSync(photo);
      const raw = jpegDecode(buf, { useTArray: true });
      const { rgba, width: w, height: h } =
        bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET_MAX_DIM);

      let r;
      try { r = countTeethFromRgba(rgba, w, h); }
      catch (e) { out(`  ${t.stamp}  ERROR ${e.message}`); continue; }

      const tc = r.toothCount;
      const peak = r.peakTc;
      const peakR = r.peakR;
      const cx = Math.round(r.gearCenter.x * w);
      const cy = Math.round(r.gearCenter.y * h);

      if (!peak || !peakR) {
        out(`  ${t.stamp}  actual=${t.actual} tc=${tc} peakTc=${peak} peakR=${peakR} — no peakR, skipping FFT diag`);
        continue;
      }

      // Re-derive enhanced from the same rgba path (matches countTeethFromRgba)
      const gray = rgbaToGray(rgba, w, h);
      const enhanced = clahe(gray, w, h, 3.0, 8, 8);

      const mag = magsAtRadius(enhanced, cx, cy, peakR, w, h, sampleIntensityRing);
      const magZp = magsAtRadiusZeroPad(enhanced, cx, cy, peakR, w, h, sampleIntensityRing);

      const fmt = (x) => (x === undefined ? '   --' : x.toFixed(1).padStart(7));
      const k = peak;
      const slice = `${fmt(mag[k-2])} ${fmt(mag[k-1])} ${fmt(mag[k])} ${fmt(mag[k+1])} ${fmt(mag[k+2])}`;
      // Zero-pad bins: k-th tooth count corresponds to bin 2k in 2N-padded FFT.
      const zk = 2 * k;
      const sliceZp = `${fmt(magZp[zk-2])} ${fmt(magZp[zk-1])} ${fmt(magZp[zk])} ${fmt(magZp[zk+1])} ${fmt(magZp[zk+2])}`;

      // Find argmax in zero-pad around the integer k (in ZP, look at ZP-bins 2(k-2)..2(k+2))
      const lo = Math.max(0, 2 * (k - 3));
      const hi = Math.min(magZp.length - 1, 2 * (k + 3));
      let bestZp = lo, bestZpMag = magZp[lo];
      for (let i = lo; i <= hi; i++) {
        if (magZp[i] > bestZpMag) { bestZpMag = magZp[i]; bestZp = i; }
      }
      const zpArgmaxTc = bestZp / 2;

      // Parabolic interp on integer-bin mag (M[k-1], M[k], M[k+1])
      let qiTc = k;
      const a = mag[k-1] || 0, b = mag[k] || 0, c = mag[k+1] || 0;
      const denom = a - 2 * b + c;
      if (denom !== 0) {
        const delta = 0.5 * (a - c) / denom;
        if (Math.abs(delta) < 1) qiTc = k + delta;
      }

      // HPS-R=3: harmonic product M[k]·M[2k]·M[3k] vs alternatives.
      // Capture also M[2k] and M[3k] to evaluate sub-harmonic discrimination
      // (Option 4 / HPS variant). For the 4-method false-consensus case
      // (05-39-22, k=21), check whether 2k=42 has comparable mag (suggesting
      // the actual gear is at 2k = 42 rather than 21).
      const fmt2 = (x) => (x === undefined ? '   --' : x.toFixed(1).padStart(7));
      const m2k = mag[2*k];
      const m3k = mag[3*k];
      const m2km1 = mag[2*k - 1];
      const m2kp1 = mag[2*k + 1];
      const ratio2 = (m2k && mag[k]) ? (m2k / mag[k]) : 0;
      const ratio3 = (m3k && mag[k]) ? (m3k / mag[k]) : 0;
      const hpsK  = mag[k] * (m2k || 0) * (m3k || 0);
      const hps2K = mag[2*k] ? mag[2*k] * (mag[4*k] || 0) * (mag[6*k] || 0) : 0;

      out(`  ${t.stamp}  actual=${t.actual} tc=${tc} peak=${peak} peakR=${peakR}`);
      out(`    M    [k-2..k+2]: ${slice}`);
      out(`    M_zp [zk-2..+2]: ${sliceZp}`);
      out(`    M[2k-1..2k+1]:   ${fmt2(m2km1)} ${fmt2(m2k)} ${fmt2(m2kp1)}    M[3k]=${fmt2(m3k)}`);
      out(`    M[2k]/M[k]=${ratio2.toFixed(3)}  M[3k]/M[k]=${ratio3.toFixed(3)}  HPS@k=${hpsK.toExponential(2)}  HPS@2k=${hps2K.toExponential(2)}`);
      out(`    -> parabolic: ${qiTc.toFixed(2)} (rounds to ${Math.round(qiTc)})  zero-pad argmax-bin: ${zpArgmaxTc.toFixed(2)}`);
      out('');
    }

    expect(true).toBe(true);
  });
});
