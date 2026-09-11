// PAP-1873 heartbeat-6 probe P4: annulus contrast restoration (sharpening / Lucy-Richardson).
// Prereg db997652; AMENDED 4e209859 (first run VOID: raw-FFT metric deviated from the
// production convention -> degenerate census; amended metric = exact production
// conditioning chain). No tuning after results; gates unchanged.
//
// Metric (production-faithful, verbatim fftCountAtRadius semantics at fixed radii):
//   ring = sampleIntensityRing(enhanced, cx, cy, r, w, h, 1024)   [production sampler]
//   x    = armTransform(ring)                                     [prereg arm, injected]
//   sm   = savgolSmooth(x, 11, true); centered = sm - mean
//   mag  = fftMagnitude(centered)
//   score(f) = mag[f] + 0.5*mag[2f] + 0.25*mag[3f], f in [10,65]; rel = best/total
// census = exists ring with |tc - actual| <= 1 and rel >= 0.04 (PAP-1865 pass-1 conv.)
// vote   = majority tc across the 4 rings (tie -> higher rel)
//
// Gates (primary arm A2b Lucy sigma=4 10it; denominators 362: dense 64, 50T 7, ordinary 298):
//   P1 dense census >= 17/64
//   P2 ordinary census net vs A0 >= -5 AND ordinary vote regressions (A0 ok -> arm wrong) <= 5
//   P3 50T census >= 5/7
//   VOID: A0 dense census < 10
//
// Run: node --import ./mobile/__tests__/lib/node-esm-stubs.mjs mobile/__tests__/pap1873.sharpen_probe.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decode: jpegDecode } = require('jpeg-js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ROWS = path.join(ROOT, 'debug-reports/pap1865_mechanism_probe_2026-09-10/probe_rows.json');
const TRAIN = path.join(ROOT, 'training-data');
const OUT_DIR = path.join(ROOT, 'debug-reports/pap1873_sharpen_probe_2026-09-11');

const TARGET = 900;
const N = 1024;                                    // production N_ANGLES (gearCounter.js:42)
const MIN_TEETH = 10, MAX_TEETH = 65;              // production (gearCounter.js:39-41)
const HALF_WIN = Math.max(2, Math.floor(N / 90));  // = 11, production smoothing
const RINGS = [0.96, 1.00, 1.04, 1.08];            // x contourRadius (prereg, unchanged)
const REL_FLOOR = 0.04;

// ---------- circular convolution via FFT (for arm kernels) ----------
function fftInPlace(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const xr = re[i + k + len / 2], xi = im[i + k + len / 2];
        const vr = xr * cr - xi * ci, vi = xr * ci + xi * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
function gaussianKernelPadded(n, sigma) {
  const half = Math.max(1, Math.round(sigma * 3));
  const kern = new Float64Array(n);
  let s = 0;
  for (let i = -half; i <= half; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kern[(i + n) % n] = v; s += v;
  }
  for (let i = 0; i < n; i++) kern[i] /= s;
  return kern;
}
function convCircularFFT(x, kernPadded) {
  const n = x.length;
  const re1 = Float64Array.from(x), im1 = new Float64Array(n);
  const re2 = Float64Array.from(kernPadded), im2 = new Float64Array(n);
  fftInPlace(re1, im1); fftInPlace(re2, im2);
  for (let i = 0; i < n; i++) {
    const tr = re1[i] * re2[i] - im1[i] * im2[i];
    im1[i] = re1[i] * im2[i] + im1[i] * re2[i];
    re1[i] = tr;
  }
  fftInPlace(re1, im1, true);
  return re1;
}

// ---------- arms (prereg; transforms act on raw ring samples, BEFORE production conditioning) ----------
const ARM_A0 = (p) => p;
function makeUnsharp(sigma) {
  const kern = gaussianKernelPadded(N, sigma);
  return (p) => {
    const g = convCircularFFT(p, kern);
    const out = new Float64Array(p.length);
    for (let i = 0; i < p.length; i++) out[i] = p[i] + (p[i] - g[i]);
    return out;
  };
}
function makeLucy(sigma, iters = 10) {
  const kern = gaussianKernelPadded(N, sigma);
  return (p) => {
    let mn = Infinity;
    for (let i = 0; i < p.length; i++) if (p[i] < mn) mn = p[i];
    const y = new Float64Array(p.length);
    for (let i = 0; i < p.length; i++) y[i] = p[i] - mn;
    let x = Float64Array.from(y);
    const eps = 1e-9;
    for (let it = 0; it < iters; it++) {
      const est = convCircularFFT(x, kern);
      const ratioIn = new Float64Array(p.length);
      for (let i = 0; i < p.length; i++) ratioIn[i] = y[i] / Math.max(est[i], eps);
      const corr = convCircularFFT(ratioIn, kern); // PSF symmetric: conv == correlation
      for (let i = 0; i < p.length; i++) x[i] = Math.max(x[i] * corr[i], 0);
    }
    return x;
  };
}

const ARMS = [
  { id: 'A0_production', fn: ARM_A0, primary: false },
  { id: 'A1a_unsharp_s1.5', fn: makeUnsharp(1.5), primary: false },
  { id: 'A1b_unsharp_s3', fn: makeUnsharp(3), primary: false },
  { id: 'A2a_lucy_s2', fn: makeLucy(2), primary: false },
  { id: 'A2b_lucy_s4_PRIMARY', fn: makeLucy(4), primary: true },
];

// ---------- production pipeline ----------
const gc = await import('../src/algorithm/gearCounter.js');
const { bilinearDownsampleRgba } = gc;
const T = gc.__test;                               // sampleIntensityRing (production sampler)
const iu = await import('../src/algorithm/imageUtils.js');
const { applyCircularMask, savgolSmooth } = iu;
const pp = await import('../src/algorithm/preprocess.js');
const fftMod = await import('../src/algorithm/fft.js');
const { fftMagnitude } = fftMod;

function scoreRingProd(enhanced, cx, cy, r, width, height, armFn) {
  const ring = T.sampleIntensityRing(enhanced, cx, cy, r, width, height, N);
  const x = armFn(ring);
  const sm = savgolSmooth(x, HALF_WIN, true);
  let mean = 0;
  for (let i = 0; i < sm.length; i++) mean += sm[i];
  mean /= sm.length;
  const centered = new Array(sm.length);
  for (let i = 0; i < sm.length; i++) centered[i] = sm[i] - mean;
  const mag = fftMagnitude(centered);
  let bestF = MIN_TEETH, bestScore = 0, totalScore = 0;
  for (let f = MIN_TEETH; f <= MAX_TEETH && f < mag.length; f++) {
    let score = mag[f];
    if (2 * f < mag.length) score += 0.5 * mag[2 * f];
    if (3 * f < mag.length) score += 0.25 * mag[3 * f];
    totalScore += score;
    if (score > bestScore) { bestScore = score; bestF = f; }
  }
  const rel = totalScore > 0 ? bestScore / totalScore : 0;
  return { tc: bestF, rel };
}

function load900(photoPath) {
  const raw = jpegDecode(fs.readFileSync(photoPath), { useTArray: true });
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET);
  const { rgba, width: w, height: h } = ds;
  applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
  return { rgba, w, h };
}

function majorityVote(perRing) {
  const tally = {};
  for (const pr of perRing) {
    const e = (tally[pr.tc] ??= { n: 0, rel: 0 });
    e.n++; if (pr.rel > e.rel) e.rel = pr.rel;
  }
  let best = null;
  for (const [tc, e] of Object.entries(tally)) {
    if (!best || e.n > best.n || (e.n === best.n && e.rel > best.rel)) {
      best = { tc: Number(tc), n: e.n, rel: e.rel };
    }
  }
  return best;
}

function metrics(perRing, actual) {
  const census = perRing.some((pr) => Math.abs(pr.tc - actual) <= 1 && pr.rel >= REL_FLOOR);
  const mv = majorityVote(perRing);
  return {
    census, vote: mv.tc, voteCorrect: Math.abs(mv.tc - actual) <= 1,
    ringDetail: perRing.map((pr) => ({ tc: pr.tc, rel: Math.round(pr.rel * 1e4) / 1e4 })),
  };
}

// ---------- main ----------
const rows = JSON.parse(fs.readFileSync(ROWS, 'utf8'));
fs.mkdirSync(OUT_DIR, { recursive: true });
const outRows = [];
const skipped = [];
let done = 0;
const t0 = Date.now();

for (const row of rows) {
  const photo = path.join(TRAIN, `${row.stamp}_photo.jpg`);
  if (!fs.existsSync(photo)) { skipped.push(row.stamp); continue; }
  const { rgba, w, h } = load900(photo);
  const { enhanced } = pp.JS_BACKEND.run(rgba, w, h);
  const rec = { stamp: row.stamp, actual: row.actual, contourRadius: row.contourRadius, arms: {} };
  for (const arm of ARMS) {
    const perRing = [];
    for (const mult of RINGS) {
      perRing.push(scoreRingProd(enhanced, row.cx, row.cy, mult * row.contourRadius, w, h, arm.fn));
    }
    rec.arms[arm.id] = metrics(perRing, row.actual);
  }
  outRows.push(rec);
  done++;
  if (done % 50 === 0) console.log(`[pap1873.sharpen] ${done} photos, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// ---------- aggregate ----------
function summarize(armId) {
  const s = { n: outRows.length, denseCensus: 0, denseVote: 0, denseN: 0, fiftyCensus: 0, fiftyN: 0,
    ordCensus: 0, ordVote: 0, ordN: 0 };
  for (const r of outRows) {
    const m = r.arms[armId], dense = r.actual >= 40 && r.actual <= 60;
    if (dense) {
      s.denseN++; s.denseCensus += m.census ? 1 : 0; s.denseVote += m.voteCorrect ? 1 : 0;
      if (r.actual === 50) { s.fiftyN++; s.fiftyCensus += m.census ? 1 : 0; }
    } else {
      s.ordN++; s.ordCensus += m.census ? 1 : 0; s.ordVote += m.voteCorrect ? 1 : 0;
    }
  }
  return s;
}

const base = summarize('A0_production');
const summary = { prereg: 'db997652 + amendment 4e209859', primaryArm: 'A2b_lucy_s4_PRIMARY',
  skipped, base: summarize('A0_production'), arms: {} };
for (const arm of ARMS) {
  const s = summarize(arm.id);
  let ordVoteReg = 0;
  for (const r of outRows) {
    if (r.actual >= 40 && r.actual <= 60) continue;
    const ok0 = r.arms['A0_production'], okA = r.arms[arm.id];
    if (ok0.voteCorrect && !okA.voteCorrect) ordVoteReg++;
  }
  s.ordVoteRegressionsVsA0 = ordVoteReg;
  s.ordCensusNetVsA0 = s.ordCensus - base.ordCensus;
  summary.arms[arm.id] = s;
}

const P = summary.arms['A2b_lucy_s4_PRIMARY'];
summary.void = base.denseCensus < 10;
if (!summary.void) {
  summary.p1_denseCensus_ge17 = P.denseCensus >= 17;
  summary.p2_ordNetGeMinus5_and_voteRegLe5 = (P.ordCensusNetVsA0 >= -5) && (P.ordVoteRegressionsVsA0 <= 5);
  summary.p3_fiftyCensus_ge5of7 = P.fiftyCensus >= 5;
  summary.verdict = (summary.p1_denseCensus_ge17 && summary.p2_ordNetGeMinus5_and_voteRegLe5 && summary.p3_fiftyCensus_ge5of7)
    ? 'POSITIVE (route to AC2 QA cross-check)' : 'NEGATIVE (lever closed, no tuning)';
} else {
  summary.verdict = 'VOID (A0 baseline out of family - harness bug, no verdict)';
}

fs.writeFileSync(path.join(OUT_DIR, 'probe_rows.json'), JSON.stringify(outRows));
fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
