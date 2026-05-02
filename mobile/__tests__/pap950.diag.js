/**
 * PAP-950 XL center-detection rework — diagnostic.
 *
 * Probes whether broadening the radialOuterEdgeRadius search band from
 * [0.30·peakR, 1.50·peakR] to [0.30·minDim, 0.95·minDim] (or other widths)
 * would surface the true chainring outer-tooth-ring radius for the 9
 * b116/b117 wrong-radius misses listed in PAP-957's triage re-kick.
 *
 * The harness:
 *   1) Decodes each cropped.jpg, downsamples to 900px, applies circular
 *      mask exactly as countTeethFromRgba does internally.
 *   2) Calls countTeethFromRgba to capture peakR, rOuter, conf, tc.
 *   3) Re-computes radial-mean |dI/dr| sweep on the CLAHE-enhanced buffer
 *      with a CONFIGURABLE band, prints outermost prominent peak.
 *
 * Run: HARNESS=pap950.diag npx jest --config mobile/__tests__/.jest.harness.config.js
 *
 * No production code changes — this is read-only diagnostic.
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const runner = require('./lib/harness-runner');
const { out, DEBUG_DIR, TARGET_MAX_DIM } = runner;
runner.silenceConsole();

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

// All 9 b116/b117 misses from PAP-957 wake comment + correct controls.
const ROWS = [
  { stamp: 'report_2026-05-01_08-22-10-875Z', actual: 52, build: 'b116', kind: 'MISS', note: 'BCD/spider lock → 13' },
  { stamp: 'report_2026-05-01_08-24-01-784Z', actual: 52, build: 'b116', kind: 'MISS', note: 'inner hub lock → abstain' },
  { stamp: 'report_2026-05-01_08-26-34-045Z', actual: 52, build: 'b116', kind: 'MISS', note: 'partial inner → 32' },
  { stamp: 'report_2026-05-01_09-09-19-262Z', actual: 36, build: 'b116', kind: 'MISS', note: 'inner-cog → abstain' },
  { stamp: 'report_2026-05-01_14-52-05-858Z', actual: 42, build: 'b117', kind: 'MISS', note: 'Campagnolo BCD freq → 12 conf=0.73 DANGEROUS' },
  { stamp: 'report_2026-05-01_15-12-27-152Z', actual: 52, build: 'b117', kind: 'MISS', note: 'BCD/spider lock → 36 abstain' },
  { stamp: 'report_2026-05-01_15-14-08-511Z', actual: 52, build: 'b117', kind: 'MISS', note: 'inner hub lock → 38' },
  { stamp: 'report_2026-05-01_15-28-06-337Z', actual: 36, build: 'b117', kind: 'MISS', note: 'inner-cog → 30' },
  { stamp: 'report_2026-05-01_15-30-03-986Z', actual: 36, build: 'b117', kind: 'MISS', note: 'inner-cog → 30 abstain' },
  // Correct b116 XL controls (do not regress).
  { stamp: 'report_2026-05-01_08-28-32-755Z', actual: 50, build: 'b116', kind: 'CTRL' },
  { stamp: 'report_2026-05-01_08-30-59-457Z', actual: 50, build: 'b116', kind: 'CTRL' },
  { stamp: 'report_2026-05-01_09-03-58-615Z', actual: 48, build: 'b116', kind: 'CTRL' },
  { stamp: 'report_2026-05-01_09-07-06-225Z', actual: 42, build: 'b116', kind: 'CTRL' },
];

// Local replica of radial-mean |dI/dr| sweep with arbitrary [rMin, rMax].
function radialOuterPeak(enhanced, cx, cy, w, h, rMin, rMax) {
  if (rMax < rMin + 20) return { idx: 0, prom: 0, profile: null, rMin, rMax };
  const N_RAYS = 256;
  const len = rMax - rMin + 1;
  const profile = new Float64Array(len);
  for (let r = rMin; r <= rMax; r++) {
    let s = 0;
    const ri = r + 1, ro = r - 1;
    for (let i = 0; i < N_RAYS; i++) {
      const a = (2 * Math.PI * i) / N_RAYS;
      const ca = Math.cos(a), sa = Math.sin(a);
      let xs = cx + ri * ca, ys = cy + ri * sa;
      if (xs < 0) xs = 0; else if (xs > w - 1.0001) xs = w - 1.0001;
      if (ys < 0) ys = 0; else if (ys > h - 1.0001) ys = h - 1.0001;
      const xi0 = xs | 0, yi0 = ys | 0;
      const fxi = xs - xi0, fyi = ys - yi0;
      const rowI0 = yi0 * w, rowI1 = rowI0 + w;
      const vI = (1 - fxi) * (1 - fyi) * enhanced[rowI0 + xi0]
               + fxi       * (1 - fyi) * enhanced[rowI0 + xi0 + 1]
               + (1 - fxi) * fyi       * enhanced[rowI1 + xi0]
               + fxi       * fyi       * enhanced[rowI1 + xi0 + 1];
      let xt = cx + ro * ca, yt = cy + ro * sa;
      if (xt < 0) xt = 0; else if (xt > w - 1.0001) xt = w - 1.0001;
      if (yt < 0) yt = 0; else if (yt > h - 1.0001) yt = h - 1.0001;
      const xo0 = xt | 0, yo0 = yt | 0;
      const fxo = xt - xo0, fyo = yt - yo0;
      const rowO0 = yo0 * w, rowO1 = rowO0 + w;
      const vO = (1 - fxo) * (1 - fyo) * enhanced[rowO0 + xo0]
               + fxo       * (1 - fyo) * enhanced[rowO0 + xo0 + 1]
               + (1 - fxo) * fyo       * enhanced[rowO1 + xo0]
               + fxo       * fyo       * enhanced[rowO1 + xo0 + 1];
      const d = (vI - vO) * 0.5;
      s += d >= 0 ? d : -d;
    }
    profile[r - rMin] = s / N_RAYS;
  }
  // Top-3 prominent local maxima with shoulder window ±8.
  const minDist = 8;
  const peaks = [];
  for (let i = 1; i < len - 1; i++) {
    if (profile[i] > profile[i - 1] && profile[i] >= profile[i + 1]) {
      let lMin = profile[i], rMinV = profile[i];
      const lLo = i - minDist > 0 ? i - minDist : 0;
      const rHi = i + minDist < len - 1 ? i + minDist : len - 1;
      for (let j = lLo; j < i; j++) if (profile[j] < lMin) lMin = profile[j];
      for (let j = i + 1; j <= rHi; j++) if (profile[j] < rMinV) rMinV = profile[j];
      const prom = profile[i] - (lMin > rMinV ? lMin : rMinV);
      peaks.push({ idx: i, prom });
    }
  }
  if (peaks.length === 0) return { idx: 0, prom: 0, profile, rMin, rMax };
  peaks.sort((a, b) => b.prom - a.prom);
  const top = peaks.slice(0, 3);
  const promFloor = top[0].prom * 0.30;
  let outermostIdx = top[0].idx, outermostProm = top[0].prom;
  for (const p of top) {
    if (p.prom >= promFloor && p.idx > outermostIdx) {
      outermostIdx = p.idx; outermostProm = p.prom;
    }
  }
  return { idx: outermostIdx + rMin, prom: outermostProm, profile, rMin, rMax,
           topPeaks: top.map((p) => ({ r: p.idx + rMin, prom: p.prom })) };
}

describe('PAP-950 XL center-detection diagnostic', () => {
  jest.setTimeout(20 * 60 * 1000);
  test('replay 9 b116/b117 misses + correct XL controls', () => {
    const gc = runner.getAlgo();
    const { countTeethFromRgba, bilinearDownsampleRgba } = gc;
    const { rgbaToGray, clahe } = gc.__test;
    const { applyCircularMask } = require('../src/algorithm/imageUtils');

    out('\n=== PAP-950 XL center-detection diagnostic ===');
    out('Probing radialOuterPeak with bands:');
    out('  current:  [0.30·peakR, 1.50·peakR]   (production)');
    out('  wide:     [0.30·minDim, 0.95·minDim]  (proposed Option A)');
    out('  midwide:  [0.30·peakR, 0.95·minDim]   (Option A-narrow)');

    const rows = [];
    for (const t of ROWS) {
      const photo = path.join(DEBUG_DIR, t.stamp, 'cropped.jpg');
      if (!fs.existsSync(photo)) { out(`  [missing] ${t.stamp}`); continue; }
      const buf = fs.readFileSync(photo);
      const raw = jpegDecode(buf, { useTArray: true });
      const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET_MAX_DIM);
      const { rgba, width: w, height: h } = ds;
      const cx = (w - 1) / 2, cy = (h - 1) / 2;
      applyCircularMask(rgba, w, h, cx, cy, 0.49 * Math.min(w, h));
      // Production output
      const r = countTeethFromRgba(rgba, w, h);
      // Re-compute enhanced for our own sweep
      const gray = rgbaToGray(rgba, w, h);
      const enhanced = clahe(gray, w, h, 3.0, 8, 8);
      const minDim = Math.min(w, h);

      const peakR = r.peakR || 0;
      const rOuterProd = r.rOuter || 0;

      // Our sweep replicas — capped at maskR-10 to avoid the mask discontinuity
      // peak at 0.49·minDim being indistinguishable from the chainring outer.
      const maskR = Math.floor(0.49 * minDim);
      const sweepCap = maskR - 10; // 431 on 900px crops
      const wide = radialOuterPeak(enhanced, w / 2, h / 2, w, h,
        Math.max(20, Math.floor(0.30 * minDim)), sweepCap);
      const midwide = peakR > 0 ? radialOuterPeak(enhanced, w / 2, h / 2, w, h,
        Math.max(20, Math.floor(0.30 * peakR)), sweepCap) : { idx: 0 };
      const cur = peakR > 0 ? radialOuterPeak(enhanced, w / 2, h / 2, w, h,
        Math.max(20, Math.floor(0.30 * peakR)), Math.floor(1.50 * peakR)) : { idx: 0 };

      // FFT-at-radius probe: what tooth count does FFT report at the wide
      // outer candidate?  This tells us if Option B (rescue via re-anchor)
      // would give the correct tc.
      const { fftCountAtRadius } = gc.__test;
      const fftAtWide = wide.idx > 0
        ? fftCountAtRadius(enhanced, w / 2, h / 2, wide.idx, w, h)
        : { tc: 0, rel: 0 };
      // Also probe at a few candidate radii between current peakR and wide:
      const fftProbes = [];
      if (peakR > 0 && wide.idx > peakR + 20) {
        for (let r = peakR + 10; r <= wide.idx; r += 20) {
          const f = fftCountAtRadius(enhanced, w / 2, h / 2, r, w, h);
          fftProbes.push({ r, tc: f.tc, rel: f.rel });
        }
      }

      rows.push({
        ...t, w, h, minDim, maskR, sweepCap,
        tc: r.toothCount, conf: r.confidence,
        peakTc: r.peakTc, fft90tc: r.fft90tc, opTc: r.opTc,
        bcTc: r.bcTc, bcPeaks: r.bcPeaks,
        peakR, rOuterProd,
        rOuterCur: cur.idx, rOuterCurProm: cur.prom || 0,
        rOuterMid: midwide.idx, rOuterMidProm: midwide.prom || 0,
        rOuterWide: wide.idx, rOuterWideProm: wide.prom || 0,
        wideTopPeaks: wide.topPeaks || [],
        fftAtWideTc: fftAtWide.tc, fftAtWideRel: fftAtWide.rel,
        fftProbes,
      });
    }

    out('\n--- per-row signal table ---');
    out('stamp                actual tc  conf  peakR rOprod rOcur rOmid rOwide  minDim   ratio_wide/peakR');
    for (const r of rows) {
      const ratio = r.peakR > 0 ? (r.rOuterWide / r.peakR).toFixed(3) : 'N/A';
      out(
        `${r.stamp.replace('report_2026-05-01_','').padEnd(20)} ${String(r.actual).padStart(5)} ` +
        `${String(r.tc).padStart(3)} ${r.conf.toFixed(2)} ` +
        `${String(r.peakR).padStart(5)} ${String(r.rOuterProd).padStart(6)} ` +
        `${String(r.rOuterCur).padStart(5)} ${String(r.rOuterMid).padStart(5)} ` +
        `${String(r.rOuterWide).padStart(6)}  ${String(r.minDim).padStart(6)}  ${ratio}  [${r.kind}]`
      );
    }

    out('\n--- wide-band top peaks per row ---');
    for (const r of rows) {
      const tops = r.wideTopPeaks.map((p) => `r=${p.r} prom=${p.prom.toFixed(2)}`).join(' | ');
      out(`${r.stamp.replace('report_2026-05-01_','')} target=${r.actual} [${r.kind}] : ${tops}`);
    }

    // Predict Option A (broaden rOuter when chainring channel ≥30 fires)
    // outcome: would |peakR - rOuterWide|/rOuterWide ≥ 0.18 fire and abstain?
    out('\n--- Option A simulation (broaden rOuter if chainringRegime ≥30) ---');
    out('A1: abstain-only (replace existing radialChainringFires gate with widened rOuter)');
    let aWins = 0, aLoss = 0, aNoFire = 0;
    for (const r of rows) {
      const chReg = r.peakTc >= 30 || r.fft90tc >= 30 || r.opTc >= 30 || r.bcTc >= 30 || r.bcPeaks >= 30;
      const wideRel = (r.peakR > 0 && r.rOuterWide > 0)
        ? Math.abs(r.peakR - r.rOuterWide) / r.rOuterWide : 0;
      const wouldFire = chReg && wideRel >= 0.18;
      const wasConfWrong = r.kind === 'MISS' && r.conf >= 0.40 && Math.abs(r.tc - r.actual) > 1;
      const wasCorrect = Math.abs(r.tc - r.actual) <= 1;
      const verdict = wouldFire
        ? (wasConfWrong ? 'WIN-abstain'
           : wasCorrect ? 'LOSS-abstain'
           : 'no-effect-already-abstain')
        : 'no-fire';
      if (verdict.startsWith('WIN')) aWins++;
      else if (verdict.startsWith('LOSS')) aLoss++;
      else if (verdict === 'no-fire') aNoFire++;
      out(`  ${r.stamp.replace('report_2026-05-01_','')} target=${r.actual} kind=${r.kind} ` +
          `chReg=${chReg} wideRel=${wideRel.toFixed(3)} -> ${verdict}`);
    }
    out(`Option A1 totals: WIN=${aWins} LOSS=${aLoss} no-fire=${aNoFire}`);

    out('\n--- Option B simulation: re-anchor FFT at rOuterWide and report tc/rel ---');
    out('Eligibility: chReg=true AND rOuterWide > peakR * 1.15');
    let bWins = 0, bLoss = 0, bNoFire = 0, bWeakFft = 0;
    for (const r of rows) {
      const chReg = r.peakTc >= 30 || r.fft90tc >= 30 || r.opTc >= 30 || r.bcTc >= 30 || r.bcPeaks >= 30;
      const wouldRescue = chReg && r.peakR > 0 && r.rOuterWide > r.peakR * 1.15;
      const fftStrong = r.fftAtWideRel >= 0.10;
      const isCorrectAtWide = Math.abs(r.fftAtWideTc - r.actual) <= 1;
      let verdict;
      if (!wouldRescue) verdict = 'no-rescue';
      else if (!fftStrong) { verdict = `weak-fft(rel=${r.fftAtWideRel.toFixed(3)})`; bWeakFft++; }
      else if (isCorrectAtWide && r.kind === 'MISS') { verdict = `WIN(${r.fftAtWideTc})`; bWins++; }
      else if (!isCorrectAtWide && r.kind === 'CTRL') { verdict = `LOSS(${r.fftAtWideTc})`; bLoss++; }
      else if (!isCorrectAtWide) { verdict = `MISS-still-wrong(${r.fftAtWideTc})`; }
      else verdict = `correct-control(${r.fftAtWideTc})`;
      out(`  ${r.stamp.replace('report_2026-05-01_','')} target=${r.actual} [${r.kind}] ` +
          `chReg=${chReg} rOuterWide=${r.rOuterWide} fftAt(${r.rOuterWide})={tc:${r.fftAtWideTc},rel:${r.fftAtWideRel.toFixed(3)}} ` +
          `→ ${verdict}`);
      if (r.fftProbes && r.fftProbes.length > 0) {
        const probes = r.fftProbes.map(p => `${p.r}:tc=${p.tc} rel=${p.rel.toFixed(2)}`).join(' | ');
        out(`     probes ${probes}`);
      }
    }
    out(`Option B totals: WIN=${bWins} LOSS=${bLoss} weakFft=${bWeakFft}`);
  });
});
