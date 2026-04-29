/**
 * PAP-815 pre-flight (per QA PAP-818): probe radial-gradient + cepstrum/ACF
 * channels at multiple radii on the 6 XL chainring failure photos and a
 * small/mid sanity sample. Pure measurement, no algorithm changes.
 *
 * Per-photo output:
 *   - finalTc / peak / fft90 / op / bcTc / bcPk from countTeethFromRgba
 *   - algo center (cx, cy) and bc center (bcCx, bcCy)
 *   - radial-mean |dI/dr| profile peaks (top 3) in the band
 *     [outerRingMin, gearR*1.10] anchored at both centers
 *   - at the dominant R_outer (bc-anchor), the angular FFT magnitude top-5
 *     peaks in tooth-count range, plus ACF and cepstrum top quefrencies
 *
 * Use the device-faithful cropped.jpg path for XL targets (PAP-810 pattern);
 * use training-data/_photo.jpg for sanity samples (no labeled cropped corpus
 * for small/mid).
 *
 * Run:
 *   npx jest --config mobile/__tests__/.jest.pap815preflight.config.js
 */

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

console.log = () => {};
console.warn = () => {};
console.info = () => {};
console.debug = () => {};
const out = (s) => process.stdout.write(s + '\n');

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');
const { fftMagnitude } = require('../src/algorithm/fft');
const { savgolSmooth } = require('../src/algorithm/imageUtils');

const DEBUG = path.resolve(__dirname, '..', '..', 'debug-reports');
const TRAINING = path.resolve(__dirname, '..', '..', 'training-data');
const TARGET_MAX_DIM = 900;
const N_ANGLES = 1024;
const N_ANGLES_RAD = 256;            // rays for the radial-gradient sweep (azimuthal mean)

// XL targets (cropped.jpg from debug-reports)
const TARGETS_XL = [
  { stamp: 'report_2026-04-29_05-29-04-170Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-31-25-376Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-33-35-933Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-35-33-518Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-37-38-177Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-39-22-521Z', actual: 52 },
];

// Small/mid/large sanity samples (training-data/_photo.jpg)
// Stratified across 11–28T to bound spurious-abstain rate per QA PAP-818 Q5.
const TARGETS_SANITY = [
  { stamp: '2026-04-04_09-10-51-656Z', actual: 11 },
  { stamp: '2026-04-05_08-32-48-875Z', actual: 11 },
  { stamp: '2026-04-05_08-33-27-869Z', actual: 11 },
  { stamp: '2026-04-04_09-10-20-407Z', actual: 13 },
  { stamp: '2026-04-05_08-31-06-222Z', actual: 13 },
  { stamp: '2026-04-05_08-31-34-725Z', actual: 13 },
  { stamp: '2026-04-04_09-09-54-631Z', actual: 14 },
  { stamp: '2026-04-04_16-15-39-652Z', actual: 14 },
  { stamp: '2026-04-04_16-16-09-444Z', actual: 14 },
  { stamp: '2026-04-04_09-09-24-950Z', actual: 15 },
  { stamp: '2026-04-05_08-29-38-474Z', actual: 15 },
  { stamp: '2026-04-05_08-30-34-676Z', actual: 15 },
  { stamp: '2026-04-08_18-28-12-142Z', actual: 18 },
  { stamp: '2026-04-08_19-54-20-313Z', actual: 18 },
  { stamp: '2026-04-08_18-30-50-993Z', actual: 21 },
  { stamp: '2026-04-08_19-51-45-965Z', actual: 21 },
  { stamp: '2026-04-08_18-34-56-184Z', actual: 24 },
  { stamp: '2026-04-08_19-49-12-150Z', actual: 24 },
  { stamp: '2026-04-11_17-17-26-759Z', actual: 24 },
  { stamp: '2026-04-08_18-38-08-065Z', actual: 28 },
  { stamp: '2026-04-08_19-46-53-896Z', actual: 28 },
  { stamp: '2026-04-11_17-20-57-425Z', actual: 28 },
];

// Bilinear sample at a sub-pixel position with edge clamping.
function sampleBilinear(gray, cx, cy, w, h) {
  const x = Math.max(0, Math.min(w - 1.0001, cx));
  const y = Math.max(0, Math.min(h - 1.0001, cy));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = x0 + 1, y1 = y0 + 1;
  const fx = x - x0, fy = y - y0;
  const i00 = gray[y0 * w + x0];
  const i10 = gray[y0 * w + x1];
  const i01 = gray[y1 * w + x0];
  const i11 = gray[y1 * w + x1];
  return (1 - fx) * (1 - fy) * i00 +
         fx       * (1 - fy) * i10 +
         (1 - fx) * fy       * i01 +
         fx       * fy       * i11;
}

// Azimuthally-averaged |dI/dr| at integer radii r in [rMin, rMax].
// Central-difference radial gradient with bilinear sampling.
function radialGradientProfile(gray, cx, cy, w, h, rMin, rMax, nAngles) {
  const profile = new Float64Array(rMax - rMin + 1);
  for (let r = rMin; r <= rMax; r++) {
    let s = 0;
    for (let i = 0; i < nAngles; i++) {
      const a = (2 * Math.PI * i) / nAngles;
      const ca = Math.cos(a), sa = Math.sin(a);
      const ix = sampleBilinear(gray, cx + (r + 1) * ca, cy + (r + 1) * sa, w, h);
      const ox = sampleBilinear(gray, cx + (r - 1) * ca, cy + (r - 1) * sa, w, h);
      s += Math.abs((ix - ox) * 0.5);
    }
    profile[r - rMin] = s / nAngles;
  }
  return profile;
}

// Top-K local maxima with prominence (max - max(left-shoulder min, right-shoulder min))
// over a reasonable shoulder window. Returns indices into `profile` (offset by rMin).
function topPeaks(profile, k, minDistance) {
  const peaks = [];
  for (let i = 1; i < profile.length - 1; i++) {
    if (profile[i] > profile[i - 1] && profile[i] >= profile[i + 1]) {
      // shoulder mins out to ±minDistance
      let lMin = profile[i], rMin = profile[i];
      for (let j = Math.max(0, i - minDistance); j < i; j++) if (profile[j] < lMin) lMin = profile[j];
      for (let j = i + 1; j <= Math.min(profile.length - 1, i + minDistance); j++) if (profile[j] < rMin) rMin = profile[j];
      const prom = profile[i] - Math.max(lMin, rMin);
      peaks.push({ idx: i, val: profile[i], prom });
    }
  }
  peaks.sort((a, b) => b.prom - a.prom);
  return peaks.slice(0, k);
}

// Angular intensity ring at sub-pixel radius using bilinear interpolation.
function sampleRingBilinear(gray, cx, cy, r, w, h, nAngles) {
  const ring = new Float64Array(nAngles);
  for (let i = 0; i < nAngles; i++) {
    const a = (2 * Math.PI * i) / nAngles;
    ring[i] = sampleBilinear(gray, cx + r * Math.cos(a), cy + r * Math.sin(a), w, h);
  }
  return ring;
}

// Mean-subtract, SavGol-smooth, FFT magnitude (matches existing fftCountAtRadius prep).
function angularFftMag(ring) {
  const halfWin = Math.max(2, Math.floor(ring.length / 90));
  const sm = savgolSmooth(ring, halfWin, true);
  let mean = 0;
  for (let i = 0; i < sm.length; i++) mean += sm[i];
  mean /= sm.length;
  const centered = new Array(sm.length);
  for (let i = 0; i < sm.length; i++) centered[i] = sm[i] - mean;
  return fftMagnitude(centered);
}

// Top-K bins in [kLo..kHi] with ±minSep separation enforcement.
function topBins(mag, kLo, kHi, k, minSep) {
  const out = [];
  const taken = new Array(mag.length).fill(false);
  while (out.length < k) {
    let bestK = -1, bestV = -Infinity;
    for (let i = kLo; i <= kHi && i < mag.length; i++) {
      if (taken[i]) continue;
      if (mag[i] > bestV) { bestV = mag[i]; bestK = i; }
    }
    if (bestK < 0) break;
    out.push({ k: bestK, v: bestV });
    for (let j = Math.max(0, bestK - minSep); j <= Math.min(mag.length - 1, bestK + minSep); j++) taken[j] = true;
  }
  return out;
}

// Real-cepstrum-like quefrency dump: q[τ] = Σ_k log(|X_k|² + ε) · cos(2πτk/N)/N for τ ∈ [τLo..τHi].
// Returns top-K quefrencies by magnitude.
function topCepstrum(mag, tauLo, tauHi, k) {
  const N = (mag.length - 1) * 2;          // FFT was zero-padded to N
  const eps = 1e-6;
  const log2mag = new Float64Array(mag.length);
  for (let i = 0; i < mag.length; i++) log2mag[i] = Math.log(mag[i] * mag[i] + eps);
  const peaks = [];
  for (let tau = tauLo; tau <= tauHi; tau++) {
    let s = 0;
    for (let i = 0; i < log2mag.length; i++) s += log2mag[i] * Math.cos((2 * Math.PI * tau * i) / N);
    peaks.push({ tau, period: tau, q: s / N });
  }
  // Local maxima only
  const local = [];
  for (let i = 1; i < peaks.length - 1; i++) {
    if (peaks[i].q > peaks[i - 1].q && peaks[i].q >= peaks[i + 1].q) local.push(peaks[i]);
  }
  local.sort((a, b) => b.q - a.q);
  return local.slice(0, k);
}

// Real-autocorrelation peaks via inverse-DFT of |FFT|² (Wiener-Khinchin).
// ACF[τ] = Σ_k |X_k|² · cos(2πτk/N)/N
function topAcf(mag, tauLo, tauHi, k) {
  const N = (mag.length - 1) * 2;
  const peaks = [];
  for (let tau = tauLo; tau <= tauHi; tau++) {
    let s = 0;
    for (let i = 0; i < mag.length; i++) s += mag[i] * mag[i] * Math.cos((2 * Math.PI * tau * i) / N);
    peaks.push({ tau, period: tau, acf: s });
  }
  const local = [];
  for (let i = 1; i < peaks.length - 1; i++) {
    if (peaks[i].acf > peaks[i - 1].acf && peaks[i].acf >= peaks[i + 1].acf) local.push(peaks[i]);
  }
  local.sort((a, b) => b.acf - a.acf);
  return local.slice(0, k);
}

function describePhoto(label, photoPath, actual, includeBcAnchor) {
  const { countTeethFromRgba, bilinearDownsampleRgba, __test } =
    require('../src/algorithm/gearCounter');
  const { sampleIntensityRing, rgbaToGray, clahe, gaussianBlur5x5, cannyEdges,
          findGearCenter, binaryContourCount } = __test;

  if (!fs.existsSync(photoPath)) {
    out(`  [${label}] MISSING ${photoPath}`);
    return;
  }
  const buf = fs.readFileSync(photoPath);
  const raw = jpegDecode(buf, { useTArray: true });
  const { rgba, width: w, height: h } =
    bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET_MAX_DIM);

  let r;
  try { r = countTeethFromRgba(rgba, w, h); }
  catch (e) { out(`  [${label}] ERROR ${e.message}`); return; }

  const tc = r.toothCount;
  const peak = r.peakTc;
  const peakR = r.peakR;
  const cx = Math.round(r.gearCenter.x * w);
  const cy = Math.round(r.gearCenter.y * h);

  const gray = rgbaToGray(rgba, w, h);
  const enhanced = clahe(gray, w, h, 3.0, 8, 8);
  const blurred = gaussianBlur5x5(enhanced, w, h);
  const edges = cannyEdges(blurred, w, h, 50, 150);

  // bc center (separate measurement; algorithm may have gone through retryNearCenter
  // so bc can be re-derived at the algo's chosen anchor)
  const bc = binaryContourCount(gray, cx, cy, w, h);
  const bcCx = bc.bcCx ? Math.round(bc.bcCx) : cx;
  const bcCy = bc.bcCy ? Math.round(bc.bcCy) : cy;
  const bcTc = bc.bcTc, bcPeaks = bc.bcPeaks, bcPurity = bc.bcPurity;

  // radial-gradient sweep band:
  //   inner = max(0.30 * baseR, 20) — skip the inner-spider region
  //   outer = min(halfMin, 1.50 * baseR)
  const halfMinAlgo = Math.min(cx, cy, w - cx, h - cy) - 1;
  const baseR = peakR > 0 ? peakR : Math.floor(halfMinAlgo * 0.5);
  const rMinAlgo = Math.max(20, Math.floor(0.30 * baseR));
  const rMaxAlgo = Math.min(halfMinAlgo, Math.floor(1.50 * baseR));
  const halfMinBc = Math.min(bcCx, bcCy, w - bcCx, h - bcCy) - 1;
  const rMinBc = Math.max(20, Math.floor(0.30 * baseR));
  const rMaxBc = Math.min(halfMinBc, Math.floor(1.50 * baseR));
  const bcSafe = rMaxBc >= rMinBc + 20 && halfMinBc >= 60;

  const rgAlgo = (rMaxAlgo >= rMinAlgo + 20)
    ? radialGradientProfile(enhanced, cx, cy, w, h, rMinAlgo, rMaxAlgo, N_ANGLES_RAD)
    : new Float64Array(0);
  const rgBc = bcSafe
    ? radialGradientProfile(enhanced, bcCx, bcCy, w, h, rMinBc, rMaxBc, N_ANGLES_RAD)
    : new Float64Array(0);

  // Top-3 prominent radial-gradient peaks at each anchor (minDistance 8 px)
  const peaksAlgo = topPeaks(rgAlgo, 3, 8).map(p => ({ r: p.idx + rMinAlgo, val: p.val, prom: p.prom }));
  const peaksBc = bcSafe
    ? topPeaks(rgBc, 3, 8).map(p => ({ r: p.idx + rMinBc, val: p.val, prom: p.prom }))
    : [];

  // R_outer selection per QA PAP-818 Q4: use bc anchor as primary IF bc geometrically
  // self-validates (|center delta| < 50 px AND bc sweep band is large enough), else
  // fall back to algo anchor.
  const centerDelta = Math.sqrt((bcCx - cx) ** 2 + (bcCy - cy) ** 2);
  const bcCenterValidated = bcSafe && centerDelta <= 50;
  // Pick anchor first
  const useAnchor = bcCenterValidated && peaksBc.length > 0 ? 'bc'
                   : peaksAlgo.length > 0 ? 'algo' : 'fallback';
  const peaksUsed = useAnchor === 'bc' ? peaksBc : peaksAlgo;
  const rOuterCx = useAnchor === 'bc' ? bcCx : cx;
  const rOuterCy = useAnchor === 'bc' ? bcCy : cy;

  // Two candidate R_outer values:
  //   STRONGEST: argmax of prominence (existing)
  //   OUTERMOST: outermost peak with prom >= 30% of strongest (catches inner-spider
  //              vs true-outer-edge ambiguity exposed in 05-35-33 — top-prom at
  //              r=176 is inner, while r=323/355 are the true chainring edge)
  let rOuterStrongest = peaksUsed.length > 0 ? peaksUsed[0].r : baseR;
  let rOuterOutermost = rOuterStrongest;
  if (peaksUsed.length > 0) {
    const promFloor = peaksUsed[0].prom * 0.30;
    let outermost = peaksUsed[0];
    for (const p of peaksUsed) {
      if (p.prom >= promFloor && p.r > outermost.r) outermost = p;
    }
    rOuterOutermost = outermost.r;
  }

  // Angular FFT, ACF, cepstrum at both R_outer candidates
  function probeAt(rTry) {
    const ring = sampleRingBilinear(enhanced, rOuterCx, rOuterCy, rTry, w, h, N_ANGLES);
    const halfWin = Math.max(2, Math.floor(N_ANGLES / 90));
    const sm = savgolSmooth(ring, halfWin, true);
    let mean = 0;
    for (let i = 0; i < sm.length; i++) mean += sm[i];
    mean /= sm.length;
    const centered = new Array(sm.length);
    for (let i = 0; i < sm.length; i++) centered[i] = sm[i] - mean;
    const mag = fftMagnitude(centered);
    return {
      angFft: topBins(mag, 10, 70, 5, 2),
      acf:    topAcf(mag, 12, 120, 5),
      cep:    topCepstrum(mag, 12, 120, 5),
    };
  }

  const probeStr = probeAt(rOuterStrongest);
  const probeOut = (rOuterOutermost !== rOuterStrongest) ? probeAt(rOuterOutermost) : null;

  out(`  [${label}] actual=${actual} tc=${tc} peak=${peak} fft90=${r.fft90tc} op=${r.opTc} bcTc=${bcTc} bcPk=${bcPeaks} bcPur=${bcPurity ? bcPurity.toFixed(3) : '-'} `);
  out(`    centers: algo=(${cx},${cy})  bc=(${bcCx},${bcCy})  Δ=${centerDelta.toFixed(1)} px  bcValidated=${bcCenterValidated}  anchor=${useAnchor}`);
  out(`    peakR=${peakR}  baseR=${baseR}  sweep@algo r∈[${rMinAlgo}..${rMaxAlgo}]  sweep@bc r∈[${rMinBc}..${rMaxBc}] (safe=${bcSafe})`);
  out(`    radial-grad@algo top3:  ${peaksAlgo.map(p => `r=${p.r}(v=${p.val.toFixed(1)},prom=${p.prom.toFixed(1)})`).join('  ')}`);
  out(`    radial-grad@bc   top3:  ${peaksBc.map(p => `r=${p.r}(v=${p.val.toFixed(1)},prom=${p.prom.toFixed(1)})`).join('  ')}`);
  out(`    R_outer:  STR=${rOuterStrongest}  OUTER=${rOuterOutermost}`);
  out(`    [STR=${rOuterStrongest}] angFFT top5:   ${probeStr.angFft.map(p => `k=${p.k}(M=${p.v.toFixed(0)})`).join('  ')}`);
  out(`    [STR=${rOuterStrongest}] cep top5:      ${probeStr.cep.map(p => `τ=${p.tau}→tc=${(N_ANGLES / p.tau).toFixed(1)}(q=${p.q.toFixed(2)})`).join('  ')}`);
  out(`    [STR=${rOuterStrongest}] ACF top5:      ${probeStr.acf.map(p => `τ=${p.tau}→tc=${(N_ANGLES / p.tau).toFixed(1)}(acf=${p.acf.toExponential(2)})`).join('  ')}`);
  if (probeOut) {
    out(`    [OUTER=${rOuterOutermost}] angFFT top5: ${probeOut.angFft.map(p => `k=${p.k}(M=${p.v.toFixed(0)})`).join('  ')}`);
    out(`    [OUTER=${rOuterOutermost}] cep top5:    ${probeOut.cep.map(p => `τ=${p.tau}→tc=${(N_ANGLES / p.tau).toFixed(1)}(q=${p.q.toFixed(2)})`).join('  ')}`);
    out(`    [OUTER=${rOuterOutermost}] ACF top5:    ${probeOut.acf.map(p => `τ=${p.tau}→tc=${(N_ANGLES / p.tau).toFixed(1)}(acf=${p.acf.toExponential(2)})`).join('  ')}`);
  }
  out('');
}

describe('PAP-815 pre-flight: radial-gradient + cepstrum/ACF', () => {
  jest.setTimeout(60 * 60 * 1000);

  test('print radial + angular signal channels per QA PAP-818', () => {
    out('\n=== PAP-815 pre-flight: radial-gradient outer-band + cepstrum/ACF ===');
    out('Per QA PAP-818: anchor radial sweep at bcCx/bcCy, find R_outer = argmax of azimuthally-averaged |dI/dr|,');
    out('then angular FFT + cepstrum + ACF at R_outer. Print also algo-anchor sweep for center self-validation.');
    out('Tooth-count interpretation: cepstrum/ACF τ → tc ≈ N_ANGLES/τ = 1024/τ');
    out('');

    out('--- XL targets (cropped.jpg device-faithful) ---');
    for (const t of TARGETS_XL) {
      const photo = path.join(DEBUG, t.stamp, 'cropped.jpg');
      describePhoto(t.stamp.replace(/^report_/, ''), photo, t.actual, true);
    }

    out('--- Sanity sample (training-data _photo.jpg, no cropped corpus available for these labels) ---');
    for (const t of TARGETS_SANITY) {
      const photo = path.join(TRAINING, `${t.stamp}_photo.jpg`);
      describePhoto(t.stamp, photo, t.actual, true);
    }

    expect(true).toBe(true);
  });
});
