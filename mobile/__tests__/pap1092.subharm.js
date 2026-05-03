/**
 * PAP-1092 Option 3 — spectral sub-harmonic at peakR (chainring-regime
 * discriminator).  Calibration harness, NO gearCounter.js touch.
 *
 * QA cross-check #1 verdict (PAP-1093, conditional approval, folded via PAP-1094):
 *   amendment 1: harmonic-set sweep includes {3} (3-arm spider coverage)
 *                   variants = { {3}, {4}, {5}, {3,4}, {4,5}, {3,4,5}, {4,5,6} }
 *   amendment 2: 3-bin max window for mag[k/N] lookup
 *                   max(mag[k/N-1], mag[k/N], mag[k/N+1])
 *                   small-k guard: when round(k/N) <= 2 → single-bin only
 *                   keep mag.length and mag[k]>0 guards
 *   amendment 3: naming clearly distinct from L2238 super-harmonic predicate
 *                   variable: chainringSubHarmAtPeakR
 *                   log tag:  [pap1092-subharm-spider]
 *   amendment 4: log per-N subHarmRel{N} into r.flags-style row record
 *   amendment 5: emit per-stratum (Small/Mid/Large/XL) histograms BEFORE
 *                picking T_subHarm
 *
 * Hard exit criterion (PAP-1091 / AC1):
 *   if best ringPromote% Wilson 95% UB < 80% on n>=60 stratified, DESCOPE
 *   without running the 305-photo sweep.
 *
 * Run:
 *   SAMPLE_PER_ACTUAL=4 SCOPE=full HARNESS=pap1092.subharm npx jest \
 *     --config mobile/__tests__/.jest.harness.config.js
 *
 * Produces:
 *   debug-reports/pap1092_subharm_2026-05-03.log    (stdout)
 *   debug-reports/pap1092_subharm_rows_2026-05-03.csv  (per-photo)
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, evalPhoto, loadOrDecodeRgba, discoverLabeled } = runner;

// Direct imports — runner.getAlgo() doesn't expose __test today.
const {
  __test: algoTest,
} = require('../src/algorithm/gearCounter');
const { fftMagnitude } = require('../src/algorithm/fft');
const { savgolSmooth } = require('../src/algorithm/imageUtils');

const { rgbaToGray, clahe, gaussianBlur5x5, sampleIntensityRing } = algoTest;

const N_ANGLES = 1024;        // matches gearCounter.js fftCountAtRadius
const HARMONIC_SETS = [
  { name: '{3}',       set: [3] },
  { name: '{4}',       set: [4] },
  { name: '{5}',       set: [5] },
  { name: '{3,4}',     set: [3, 4] },
  { name: '{4,5}',     set: [4, 5] },
  { name: '{3,4,5}',   set: [3, 4, 5] },
  { name: '{4,5,6}',   set: [4, 5, 6] },
];

// QA-mandated PAP-1060 11T conf=0 cluster trace (carried forward from pap1078.bolt).
const PAP1060_STAMPS = new Set([
  '2026-04-05_08-32-48-875Z',
  '2026-04-05_08-33-27-869Z',
  '2026-04-05_08-34-06-051Z',
  '2026-04-05_14-40-38-072Z',
  '2026-04-05_20-05-36-867Z',
  '2026-04-06_10-01-25-781Z',
  '2026-04-19_11-32-11-962Z',
  '2026-04-19_11-33-29-608Z',
  '2026-04-21_19-02-17-555Z',
  '2026-04-22_18-55-06-131Z',
  '2026-04-25_08-03-37-711Z',
]);

const SAMPLE_PER_ACTUAL = Number(process.env.SAMPLE_PER_ACTUAL || 4);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function classOfActual(a) {
  if (a <= 13) return 'Small';
  if (a <= 20) return 'Mid';
  if (a <= 28) return 'Large';
  return 'XL';
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

function fmt(x, n = 3) {
  if (!Number.isFinite(x)) return '   -  ';
  return x.toFixed(n).padStart(n + 4);
}

// Wilson score 95% UB for a binomial proportion.
function wilson95UB(successes, total) {
  if (total <= 0) return NaN;
  const z = 1.959963984540054;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const halfwidth = (z * Math.sqrt(p * (1 - p) / total + (z * z) / (4 * total * total))) / denom;
  return center + halfwidth;
}

/**
 * 3-bin max window with QA amendment 2 small-k guard.
 *
 * @param {Float64Array} mag  full magnitude spectrum
 * @param {number} k          dominant tooth-count bin (peakTc)
 * @param {number} N          sub-harmonic divisor in {3,4,5,6}
 * @returns {{mag:number, kSub:number, mode:'single'|'tri'}}  NaN if not lookable.
 */
function subHarmMag(mag, k, N) {
  if (!Number.isFinite(k) || k < 1 || N < 2) return { mag: NaN, kSub: NaN, mode: 'na' };
  const kSub = Math.round(k / N);
  if (kSub <= 0) return { mag: NaN, kSub, mode: 'na' };
  if (kSub >= mag.length) return { mag: NaN, kSub, mode: 'na' };
  if (!(mag[k] > 0)) return { mag: NaN, kSub, mode: 'na' };

  // Small-k guard: <=2 → single-bin only (avoid bleeding into mag[k/(N-1)]
  // when adjacent sub-harmonic divisors collide on neighbouring bins).
  if (kSub <= 2) return { mag: mag[kSub], kSub, mode: 'single' };

  let m = mag[kSub];
  if (kSub - 1 >= 0 && mag[kSub - 1] > m) m = mag[kSub - 1];
  if (kSub + 1 < mag.length && mag[kSub + 1] > m) m = mag[kSub + 1];
  return { mag: m, kSub, mode: 'tri' };
}

/**
 * Compute radial-FFT magnitude spectrum at (cx,cy,r). Mirrors fftCountAtRadius
 * in gearCounter.js (PAP-288 SavGol path) so sub-harmonic bin lookups are
 * apples-to-apples with the path that produced peakTc.
 */
function magsAtRadius(enhanced, cx, cy, r, w, h) {
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

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
describe('PAP-1092 Option 3 — chainringSubHarmAtPeakR calibration (cross-check #1 r1)', () => {
  jest.setTimeout(4 * 60 * 60 * 1000);

  test('per-stratum subHarmRel histograms + harmonic-set sweep + Wilson exit', () => {
    const all = discoverLabeled({ minActual: 9, maxActual: 60 });
    const byActual = new Map();
    for (const p of all) {
      const arr = byActual.get(p.actual) || [];
      arr.push(p);
      byActual.set(p.actual, arr);
    }
    const selected = [];
    for (const [, arr] of byActual) {
      const sorted = [...arr].sort((a, b) => (a.stamp < b.stamp ? -1 : 1));
      const n = Math.min(SAMPLE_PER_ACTUAL, sorted.length);
      for (let i = 0; i < n; i++) {
        const idx = Math.floor((i * sorted.length) / n);
        selected.push(sorted[idx]);
      }
    }
    // Force-include PAP-1060 cluster (QA-mandated cluster trace).
    const haveStamps = new Set(selected.map((p) => p.stamp));
    for (const p of all) {
      if (PAP1060_STAMPS.has(p.stamp) && !haveStamps.has(p.stamp)) {
        selected.push(p);
        haveStamps.add(p.stamp);
      }
    }
    selected.sort((a, b) => (a.stamp < b.stamp ? -1 : 1));
    out(`[pap1092-subharm-spider] sample=${selected.length} (target ${SAMPLE_PER_ACTUAL}/actual + PAP-1060 cluster forced)`);
    out(`[pap1092-subharm-spider] actuals: ${[...byActual.keys()].sort((a, b) => a - b).map((a) => `${a}T(${Math.min(SAMPLE_PER_ACTUAL, byActual.get(a).length)})`).join(' ')}`);

    const t0 = Date.now();
    const rows = [];
    for (let i = 0; i < selected.length; i++) {
      const { photo, actual, stamp } = selected[i];
      const r = evalPhoto({ photo, actual, stamp });
      // Skip rows where peakR didn't anchor (algorithm fell into a different
      // branch). subHarmAtPeakR is only meaningful when peakR > 0.
      const peakR = r.raw && r.raw.peakR ? r.raw.peakR : r.peakR;
      const peakTc = r.peakTc;
      const gC = r.raw && r.raw.gearCenter ? r.raw.gearCenter : null;
      let cx = NaN, cy = NaN;
      if (gC && Number.isFinite(gC.x) && Number.isFinite(gC.y)) {
        // gearCenter is in normalized [0,1] coords per gearCounter.js:2825.
        cx = Math.round(gC.x * r.w);
        cy = Math.round(gC.y * r.h);
      }

      let subPerN = { 3: NaN, 4: NaN, 5: NaN, 6: NaN };
      let kPerN = { 3: NaN, 4: NaN, 5: NaN, 6: NaN };
      let modePerN = { 3: 'na', 4: 'na', 5: 'na', 6: 'na' };
      let magK = NaN;
      let lookable = false;

      if (peakR > 0 && peakTc > 0 && Number.isFinite(cx) && Number.isFinite(cy)) {
        try {
          const { rgba, w, h } = loadOrDecodeRgba(photo, stamp);
          const gray = rgbaToGray(rgba, w, h);
          const enhanced = clahe(gray, w, h, 3.0, 8, 8);
          // gearCounter's fftCountAtRadius operates on `enhanced` directly (no
          // gaussian blur on the FFT path); skip blur to mirror.
          const mag = magsAtRadius(enhanced, cx, cy, peakR, w, h);
          if (mag && mag.length > peakTc && mag[peakTc] > 0) {
            magK = mag[peakTc];
            lookable = true;
            for (const N of [3, 4, 5, 6]) {
              const sh = subHarmMag(mag, peakTc, N);
              kPerN[N] = sh.kSub;
              modePerN[N] = sh.mode;
              subPerN[N] = Number.isFinite(sh.mag) ? sh.mag / magK : NaN;
            }
          }
        } catch (e) {
          // best-effort; row stays with NaN subHarmRel.
        }
      }

      rows.push({
        actual,
        stamp,
        klass: classOfActual(actual),
        w: r.w, h: r.h,
        peakR,
        peakTc,
        bcTc: r.bcTc, fft90: r.fft90, opTc: r.op, bcPeaks: r.bcPeaks,
        tc: r.tc, conf: r.conf, innerSus: r.innerSus,
        gearR: r.gearR,
        cx, cy,
        magK,
        lookable,
        subRel3: subPerN[3], subRel4: subPerN[4], subRel5: subPerN[5], subRel6: subPerN[6],
        kSub3: kPerN[3], kSub4: kPerN[4], kSub5: kPerN[5], kSub6: kPerN[6],
        mode3: modePerN[3], mode4: modePerN[4], mode5: modePerN[5], mode6: modePerN[6],
        // ground-truth correctness (used only for AC2-LOSS analysis at sweep)
        currentlyCorrect: !r.abstain && r.tc === r.actual && r.conf > 0,
      });

      if ((i + 1) % 25 === 0) {
        out(`  [${i + 1}/${selected.length}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    }

    const byClass = { Small: [], Mid: [], Large: [], XL: [] };
    for (const row of rows) byClass[row.klass].push(row);

    out(`\n[pap1092-subharm-spider] elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`);
    out(`[pap1092-subharm-spider] lookable=${rows.filter((r) => r.lookable).length}/${rows.length}`);

    // -------------------------------------------------------------------
    // (i) Per-stratum subHarmRel histograms — amendment 5 (BEFORE picking T)
    // -------------------------------------------------------------------
    out(`\n=== subHarmRel{N} per-stratum histograms (amendment 5) ===`);
    out('class    N    lookable   subRel3                              subRel4                              subRel5                              subRel6');
    out('                          p10   p25   p50   p75   p90   p95   p10   p25   p50   p75   p90   p95   p10   p25   p50   p75   p90   p95   p10   p25   p50   p75   p90   p95');
    for (const cls of ['Small', 'Mid', 'Large', 'XL']) {
      const arr = byClass[cls].filter((r) => r.lookable);
      const cells = [];
      for (const N of [3, 4, 5, 6]) {
        const vals = arr.map((r) => r[`subRel${N}`]).filter(Number.isFinite).sort((a, b) => a - b);
        cells.push(
          fmt(quantile(vals, 0.10), 2),
          fmt(quantile(vals, 0.25), 2),
          fmt(quantile(vals, 0.50), 2),
          fmt(quantile(vals, 0.75), 2),
          fmt(quantile(vals, 0.90), 2),
          fmt(quantile(vals, 0.95), 2),
        );
      }
      out(
        `${cls.padEnd(6)} ${String(byClass[cls].length).padStart(3)}  ${String(arr.length).padStart(7)}    ${cells.join(' ')}`,
      );
    }

    // -------------------------------------------------------------------
    // (ii) Harmonic-set sweep × T_subHarm (default config: max-of-set)
    // -------------------------------------------------------------------
    out(`\n=== Harmonic-set × T_subHarm sweep (amendment 1: 7 sets, including {3}) ===`);
    out('hset       T      ringPromote%  cogPromote%  ringFire   cogFire    AC1_W95UB  AC2_LOSS  AC2_LOSS_stamps_sample');
    const T_GRID = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70];
    const cogRows = [...byClass.Small, ...byClass.Mid, ...byClass.Large];
    const ringRows = byClass.XL;
    const candidates = [];
    for (const hset of HARMONIC_SETS) {
      for (const T of T_GRID) {
        // Per-row: subHarmRel(hset) = max over N in hset of subRelN
        let cogP = 0, ringP = 0;
        let cogFire = 0, ringFire = 0;
        const ac2LossRows = [];
        for (const row of rows) {
          if (!row.lookable) continue;
          let subMax = -Infinity;
          for (const N of hset.set) {
            const v = row[`subRel${N}`];
            if (Number.isFinite(v) && v > subMax) subMax = v;
          }
          if (!Number.isFinite(subMax)) continue;
          const fires = subMax >= T;
          if (!fires) continue;
          if (row.klass === 'XL') {
            ringFire++;
            // PROMOTE (correct outcome on XL): the predicate identifies a
            // chainring-regime frame, downstream gates abstain on aliased peakR.
            ringP++;
          } else {
            cogFire++;
            // PROMOTE on a cog frame is a false positive of the predicate
            // (cogs shouldn't fire). cogPromote% MUST be 0 to satisfy AC1
            // semantics inherited from PAP-1078 ladder ("ring% / cogPromote%").
            cogP++;
            if (row.currentlyCorrect) ac2LossRows.push(row.stamp);
          }
        }
        const ringTotal = ringRows.filter((r) => r.lookable).length;
        const cogTotal = cogRows.filter((r) => r.lookable).length;
        const ringPct = ringTotal ? ringP / ringTotal : 0;
        const cogPct = cogTotal ? cogP / cogTotal : 0;
        const w95 = wilson95UB(ringP, ringTotal);
        out(
          `${hset.name.padEnd(8)} ${T.toFixed(2)}   ${(ringPct * 100).toFixed(1).padStart(5)}%       ${(cogPct * 100).toFixed(1).padStart(5)}%       ${String(ringFire).padStart(3)}/${String(ringTotal).padStart(3)}    ${String(cogFire).padStart(3)}/${String(cogTotal).padStart(3)}     ${(w95 * 100).toFixed(1).padStart(5)}%     ${String(ac2LossRows.length).padStart(2)}        ${ac2LossRows.slice(0, 3).join(',')}`,
        );
        candidates.push({
          hset: hset.name, T, ringPromote: ringPct, cogPromote: cogPct,
          ringFire, ringTotal, cogFire, cogTotal,
          ac2LossCount: ac2LossRows.length, w95UB: w95,
        });
      }
    }

    // -------------------------------------------------------------------
    // (iii) AC1 candidates filtered by cogPromote%==0, ranked by ringPromote%
    // -------------------------------------------------------------------
    out(`\n=== AC1 candidates (cogPromote%==0) ranked by ringPromote% ===`);
    const ac1 = candidates.filter((c) => c.cogPromote === 0).sort((a, b) => b.ringPromote - a.ringPromote);
    out('hset     T       ringPromote%   AC1_W95UB%   AC1_pass(>=80)');
    for (const c of ac1.slice(0, 12)) {
      const pass = c.w95UB >= 0.80 ? 'PASS' : 'FAIL';
      out(`${c.hset.padEnd(8)} ${c.T.toFixed(2)}    ${(c.ringPromote * 100).toFixed(1).padStart(5)}%        ${(c.w95UB * 100).toFixed(1).padStart(5)}%       ${pass}`);
    }

    // -------------------------------------------------------------------
    // (iv) Wilson exit-criterion verdict (PAP-1091 / hard exit)
    // -------------------------------------------------------------------
    const bestAc1 = ac1[0] || null;
    const bestUB = bestAc1 ? bestAc1.w95UB : 0;
    out(`\n=== HARD EXIT (PAP-1091): best ringPromote% Wilson 95% UB ===`);
    if (bestAc1) {
      out(
        `  best cogPromote==0 cell: hset=${bestAc1.hset} T=${bestAc1.T.toFixed(2)} ` +
        `ringPromote=${(bestAc1.ringPromote * 100).toFixed(1)}% W95UB=${(bestUB * 100).toFixed(1)}%`,
      );
    } else {
      out(`  no AC1 candidate found with cogPromote==0`);
    }
    if (bestUB < 0.80) {
      out(`  >>> DESCOPE per PAP-1091: best Wilson 95% UB ${(bestUB * 100).toFixed(1)}% < 80% target.`);
    } else {
      out(`  >>> PROCEED per PAP-1091: best Wilson 95% UB ${(bestUB * 100).toFixed(1)}% >= 80%.`);
    }

    // -------------------------------------------------------------------
    // (v) PAP-1060 11T cluster trace (per AC4)
    // -------------------------------------------------------------------
    const cluster = rows.filter((r) => PAP1060_STAMPS.has(r.stamp));
    out(`\n=== PAP-1060 11T conf=0 cluster trace (n=${cluster.length}/${PAP1060_STAMPS.size} present) ===`);
    if (cluster.length) {
      out('stamp                            actual  detected  conf  peakTc  peakR  subRel3  subRel4  subRel5  subRel6');
      for (const r of cluster) {
        out(
          `${r.stamp}  ${String(r.actual).padStart(2)}T    ${String(r.tc).padStart(2)}T      ${r.conf.toFixed(2)}  ${String(r.peakTc).padStart(3)}    ${String(r.peakR).padStart(4)}  ${fmt(r.subRel3, 2)}  ${fmt(r.subRel4, 2)}  ${fmt(r.subRel5, 2)}  ${fmt(r.subRel6, 2)}`,
        );
      }
    } else {
      out(`  (no PAP-1060 cluster stamps in this sample at SAMPLE_PER_ACTUAL=${SAMPLE_PER_ACTUAL}; rerun w/ higher sample to verify)`);
    }

    // -------------------------------------------------------------------
    // (vi) CSV export
    // -------------------------------------------------------------------
    const csvHeader = [
      'class', 'actual', 'stamp', 'w', 'h', 'cx', 'cy',
      'peakR', 'peakTc', 'bcTc', 'fft90', 'opTc', 'bcPeaks',
      'tc', 'conf', 'innerSus', 'gearR', 'currentlyCorrect',
      'lookable', 'magK',
      'subRel3', 'subRel4', 'subRel5', 'subRel6',
      'kSub3', 'kSub4', 'kSub5', 'kSub6',
      'mode3', 'mode4', 'mode5', 'mode6',
    ];
    const csvLines = [csvHeader.join(',')];
    for (const r of rows) {
      const cells = [
        r.klass, r.actual, r.stamp, r.w, r.h,
        Number.isFinite(r.cx) ? r.cx : '',
        Number.isFinite(r.cy) ? r.cy : '',
        Number.isFinite(r.peakR) ? r.peakR : '',
        r.peakTc, r.bcTc, r.fft90, r.opTc, r.bcPeaks,
        r.tc, r.conf.toFixed(3), r.innerSus,
        Number.isFinite(r.gearR) ? r.gearR.toFixed(4) : '',
        r.currentlyCorrect,
        r.lookable,
        Number.isFinite(r.magK) ? r.magK.toFixed(4) : '',
        Number.isFinite(r.subRel3) ? r.subRel3.toFixed(4) : '',
        Number.isFinite(r.subRel4) ? r.subRel4.toFixed(4) : '',
        Number.isFinite(r.subRel5) ? r.subRel5.toFixed(4) : '',
        Number.isFinite(r.subRel6) ? r.subRel6.toFixed(4) : '',
        Number.isFinite(r.kSub3) ? r.kSub3 : '',
        Number.isFinite(r.kSub4) ? r.kSub4 : '',
        Number.isFinite(r.kSub5) ? r.kSub5 : '',
        Number.isFinite(r.kSub6) ? r.kSub6 : '',
        r.mode3, r.mode4, r.mode5, r.mode6,
      ];
      csvLines.push(cells.join(','));
    }
    const outFile = path.resolve(__dirname, '..', '..', 'debug-reports', 'pap1092_subharm_rows_2026-05-03.csv');
    fs.writeFileSync(outFile, csvLines.join('\n'));
    out(`\nrow-level csv: ${outFile}  (${csvLines.length - 1} rows)`);

    expect(rows.length).toBeGreaterThan(0);
  });
});
