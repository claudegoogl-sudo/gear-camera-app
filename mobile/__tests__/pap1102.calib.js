/**
 * PAP-1102 H2 calibration harness — aim-anchored radial-gradient re-search.
 *
 * Applies the 5 QA amendments from cross-check #1 (PAP-1105):
 *   (1) WIN_HI vs PAP-738 mask — Option (b): g(r) computed on PRE-MASK luma
 *       buffer (raw RGBA from JPEG decode + bilinear downsample). Documented.
 *   (2) Distribution-first: per-stratum histograms of rOuterAimSnr,
 *       peakRMinusAim_px, peakR/aimR ratio reported BEFORE matrix.
 *   (3) Unified AC1+AC2 matrix per cell — single table.
 *   (4) ms-cost p99 of the polar-resample step per row.
 *   (5) AC3 corpus exclusion — pre-b97 (build < 97) photos skipped from
 *       AC2 LOSS calibration; 3+3 spot-check rows in CSV; 11T cluster
 *       (PAP-1060) kept as AC1 no-regression trace only.
 *
 * Predicate (v1, abstain-only — Q1 deferred to v2 per QA verdict):
 *   chainringRegime := (peakTc≥30 || fft90tc≥30 || opTc≥30 || bcTc≥30
 *                       || bcPeaks≥30)
 *   rOuterAim := argmax_{r∈[WIN_LO·aimR, WIN_HI·aimR]} g(r)
 *   gNoise   := median g(r) for r ∈ [0.20·aimR, 0.50·aimR]
 *   rOuterAimSnr := gOuterAim / max(gNoise, eps)
 *   innerLockAbstain :=
 *     chainringRegime
 *     AND aimR > 0
 *     AND rOuterAimSnr ≥ SNR_FLOOR
 *     AND |peakR - rOuterAim| > DISAGREE_PX
 *     AND peakR < SAFE_PEAKR_FRAC · aimR
 *     AND not tripleAgree
 *     AND not bcStrongAgree
 *     AND method ∉ {pap868-fft90-xl-rescue, pap885-fiveway,
 *                   pap963-campa-bolt-abstain, pap939-cand3-inner-lock}
 *
 * Run:
 *   HARNESS=pap1102.calib npx jest --config mobile/__tests__/.jest.harness.config.js
 *
 * Env knobs:
 *   PAP1102_QUICK=1     skip 432-cell sweep, run distribution-first only
 *   CACHE=off           bypass RGBA cache (PAP-971)
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, DEBUG_DIR, TRAINING_DIR } = runner;

const MIN_TEETH = 10;
const MIN_CHAINRING_TC = 30;
const EXCLUDED_METHODS = /pap868-fft90-xl-rescue|pap885-fiveway|pap963-campa-bolt-abstain|pap939-cand3-inner-lock/;

// ── Calibration grid (per amendment 1: WIN_HI capped by PAP-738 mask=0.98 if
// option (a); we picked option (b) → pre-mask g(r), full {1.00, 1.05, 1.10}).
const GRID = {
  WIN_LO:           [0.80, 0.85, 0.90],
  WIN_HI:           [1.00, 1.05, 1.10],
  SNR_FLOOR:        [1.5, 2.0, 2.5, 3.0],
  DISAGREE_PX:      [60, 90, 120, 150],
  SAFE_PEAKR_FRAC:  [0.75, 0.80, 0.85],
};
const TOTAL_CELLS = GRID.WIN_LO.length * GRID.WIN_HI.length
  * GRID.SNR_FLOOR.length * GRID.DISAGREE_PX.length * GRID.SAFE_PEAKR_FRAC.length;

// ── PAP-1060 11T cluster (AC1 no-regression trace, mostly pre-b97).
const PAP1060_STAMPS = [
  '2026-04-05_08-32-48-875Z', '2026-04-05_08-33-27-869Z',
  '2026-04-05_08-34-06-051Z', '2026-04-05_14-40-38-072Z',
  '2026-04-05_20-05-36-867Z', '2026-04-06_10-01-25-781Z',
  '2026-04-19_11-32-11-962Z', '2026-04-19_11-33-29-608Z',
  '2026-04-21_19-02-17-555Z', '2026-04-22_18-55-06-131Z',
  '2026-04-25_08-03-37-711Z',
];

// ── b111-b117 XL device captures (mirrors pap961.sweep.js panel).
const XL_DEVICE = [
  // PRIOR_XL (b111-b114)
  { stamp: 'report_2026-04-29_05-29-04-170Z', actual: 42, build: 'b111' },
  { stamp: 'report_2026-04-29_05-31-25-376Z', actual: 42, build: 'b111' },
  { stamp: 'report_2026-04-29_05-33-35-933Z', actual: 52, build: 'b111', protect: true, note: 'b111 conf-correct LOSS-protect' },
  { stamp: 'report_2026-04-29_05-35-33-518Z', actual: 52, build: 'b111' },
  { stamp: 'report_2026-04-29_05-37-38-177Z', actual: 52, build: 'b111' },
  { stamp: 'report_2026-04-29_05-39-22-521Z', actual: 52, build: 'b111' },
  { stamp: 'report_2026-04-30_05-32-51-092Z', actual: 42, build: 'b112' },
  { stamp: 'report_2026-04-30_05-34-20-458Z', actual: 42, build: 'b112' },
  { stamp: 'report_2026-04-30_05-35-59-637Z', actual: 42, build: 'b112' },
  { stamp: 'report_2026-04-30_05-37-35-156Z', actual: 42, build: 'b112' },
  { stamp: 'report_2026-04-30_10-09-03-515Z', actual: 34, build: 'b114' },
  { stamp: 'report_2026-04-30_10-14-44-086Z', actual: 34, build: 'b114' },
  { stamp: 'report_2026-04-30_10-17-03-115Z', actual: 34, build: 'b114' },
  { stamp: 'report_2026-04-30_10-19-19-295Z', actual: 36, build: 'b114' },
  { stamp: 'report_2026-04-30_10-23-07-161Z', actual: 36, build: 'b114' },
  // B116
  { stamp: 'report_2026-05-01_08-22-10-875Z', actual: 52, build: 'b116' },
  { stamp: 'report_2026-05-01_08-24-01-784Z', actual: 52, build: 'b116' },
  { stamp: 'report_2026-05-01_08-26-34-045Z', actual: 52, build: 'b116', note: 'AC1 candidate' },
  { stamp: 'report_2026-05-01_08-28-32-755Z', actual: 50, build: 'b116' },
  { stamp: 'report_2026-05-01_08-30-59-457Z', actual: 50, build: 'b116' },
  { stamp: 'report_2026-05-01_09-03-58-615Z', actual: 48, build: 'b116' },
  { stamp: 'report_2026-05-01_09-07-06-225Z', actual: 42, build: 'b116' },
  { stamp: 'report_2026-05-01_09-09-19-262Z', actual: 36, build: 'b116' },
  // B117
  { stamp: 'report_2026-05-01_14-52-05-858Z', actual: 42, build: 'b117', note: 'Campagnolo (PAP-963 abstain)' },
  { stamp: 'report_2026-05-01_14-53-36-988Z', actual: 42, build: 'b117', protect: true, note: 'b117 conf-correct LOSS-protect' },
  { stamp: 'report_2026-05-01_14-55-01-423Z', actual: 42, build: 'b117', protect: true, note: 'b117 conf-correct LOSS-protect' },
  { stamp: 'report_2026-05-01_14-56-37-862Z', actual: 48, build: 'b117' },
  { stamp: 'report_2026-05-01_15-00-42-140Z', actual: 48, build: 'b117' },
  { stamp: 'report_2026-05-01_15-03-56-895Z', actual: 48, build: 'b117' },
  { stamp: 'report_2026-05-01_15-06-13-796Z', actual: 50, build: 'b117' },
  { stamp: 'report_2026-05-01_15-08-16-433Z', actual: 50, build: 'b117' },
  { stamp: 'report_2026-05-01_15-10-25-896Z', actual: 50, build: 'b117' },
  { stamp: 'report_2026-05-01_15-12-27-152Z', actual: 52, build: 'b117', note: 'AC1 target' },
  { stamp: 'report_2026-05-01_15-14-08-511Z', actual: 52, build: 'b117', note: 'AC1 target' },
  { stamp: 'report_2026-05-01_15-20-25-637Z', actual: 52, build: 'b117' },
  { stamp: 'report_2026-05-01_15-21-57-850Z', actual: 52, build: 'b117', protect: true, note: 'b117 conf-correct LOSS-protect' },
  { stamp: 'report_2026-05-01_15-28-06-337Z', actual: 36, build: 'b117' },
  { stamp: 'report_2026-05-01_15-30-03-986Z', actual: 36, build: 'b117' },
  { stamp: 'report_2026-05-01_15-37-16-032Z', actual: 36, build: 'b117' },
];

// ── Build-number parser (AC3 amendment 5).
function buildOf(metaPath) {
  try {
    const raw = fs.readFileSync(metaPath, 'utf8').replace(/[^\x00-\x7F]+/g, '?');
    const m = JSON.parse(raw);
    const bm = /\((\d+)\)/.exec(m.build || '');
    return bm ? Number(bm[1]) : null;
  } catch { return null; }
}

// ── Polar-resample radial-gradient profile g(r).
//
// luma at integer (x, y) via ITU-R BT.601: Y = 0.299R + 0.587G + 0.114B.
// θ step = 1° (360 samples per ring), r step = 1 px integer.
// Out-of-frame samples skipped; if all θ skip at a given r, g(r) = 0.
//
// Returns Float32Array indexed by integer r ∈ [0, rMaxInt].
function radialGradientProfile(rgba, w, h, cx, cy, rMaxInt) {
  const NTHETA = 360;
  // Pre-compute cos/sin tables once per call (R is up to ~500, so 360 entries
  // is cheap).
  const cosT = new Float32Array(NTHETA);
  const sinT = new Float32Array(NTHETA);
  for (let i = 0; i < NTHETA; i++) {
    const a = (i * Math.PI) / 180;
    cosT[i] = Math.cos(a);
    sinT[i] = Math.sin(a);
  }
  // First pass: luma at every (r, θ) in a flat array of size (rMaxInt+1)*NTHETA.
  const Y = new Float32Array((rMaxInt + 1) * NTHETA);
  const VALID = new Uint8Array((rMaxInt + 1) * NTHETA);
  for (let r = 0; r <= rMaxInt; r++) {
    const base = r * NTHETA;
    for (let t = 0; t < NTHETA; t++) {
      const x = Math.round(cx + r * cosT[t]);
      const y = Math.round(cy + r * sinT[t]);
      if (x < 0 || x >= w || y < 0 || y >= h) { VALID[base + t] = 0; continue; }
      const idx = (y * w + x) * 4;
      Y[base + t] = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
      VALID[base + t] = 1;
    }
  }
  // Second pass: g(r) = mean over θ of |Y(r+1, θ) - Y(r-1, θ)|, central diff.
  // Edges (r=0 and r=rMaxInt) use forward/backward diff.
  const g = new Float32Array(rMaxInt + 1);
  for (let r = 0; r <= rMaxInt; r++) {
    const rPrev = r > 0 ? r - 1 : r;
    const rNext = r < rMaxInt ? r + 1 : r;
    if (rPrev === rNext) { g[r] = 0; continue; }
    let sum = 0; let n = 0;
    const bP = rPrev * NTHETA;
    const bN = rNext * NTHETA;
    for (let t = 0; t < NTHETA; t++) {
      if (!VALID[bP + t] || !VALID[bN + t]) continue;
      sum += Math.abs(Y[bN + t] - Y[bP + t]);
      n++;
    }
    g[r] = n > 0 ? sum / n : 0;
  }
  return g;
}

function sliceMedian(arr, lo, hi) {
  const v = [];
  const a = Math.max(0, Math.floor(lo));
  const b = Math.min(arr.length - 1, Math.floor(hi));
  for (let i = a; i <= b; i++) v.push(arr[i]);
  v.sort((x, y) => x - y);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
}

function sliceArgmax(arr, lo, hi) {
  const a = Math.max(0, Math.floor(lo));
  const b = Math.min(arr.length - 1, Math.floor(hi));
  let bestR = a, bestG = -Infinity;
  for (let r = a; r <= b; r++) {
    if (arr[r] > bestG) { bestG = arr[r]; bestR = r; }
  }
  return { r: bestR, g: Math.max(0, bestG) };
}

// Wilson 95% upper bound on a binomial proportion (k successes / n trials).
// PAP-1091 protocol — used as the AC1 hard-exit gate.
function wilson95UB(k, n) {
  if (n === 0) return 0;
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (center + margin) / denom;
}

function quantile(sortedArr, q) {
  if (!sortedArr.length) return 0;
  const i = Math.min(sortedArr.length - 1, Math.floor(q * sortedArr.length));
  return sortedArr[i];
}

function fmtFloat(x, dp = 3) { return Number.isFinite(x) ? x.toFixed(dp) : '-'; }

// ── Per-row evaluation: standard FFT fields + g(r) profile + derived metrics.
function evalRow({ photo, actual, stamp, applyMask, source }) {
  // applyMask=true mirrors PAP-961 XL device replay (debug-reports/cropped.jpg).
  // applyMask=false is the harness-runner default for training-data photos.
  const r = runner.evalPhoto({ photo, actual, stamp, applyMask });
  const { rgba, w, h } = runner.loadOrDecodeRgba
    ? runner.loadOrDecodeRgba(photo, stamp)
    : (() => {
        // Fall back to a fresh decode if the runner doesn't expose the cached
        // loader (older PAP-970 builds). Slower, but only used pre-PAP-971.
        const { decode: jpegDecode } = require('jpeg-js');
        const { bilinearDownsampleRgba } = require('../src/algorithm/gearCounter');
        const buf = fs.readFileSync(photo);
        const raw = jpegDecode(buf, { useTArray: true });
        const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, 900);
        return { rgba: ds.rgba, w: ds.width, h: ds.height };
      })();
  const aimR = 0.5 * Math.min(w, h);
  const aimCx = (w - 1) / 2;
  const aimCy = (h - 1) / 2;
  // Compute g(r) on PRE-MASK rgba (option (b) from QA amendment 1).
  // applyMask=true mutates the buffer in-place inside evalPhoto, so we always
  // re-decode here via loadOrDecodeRgba (PAP-971 cache hit).
  const rMaxInt = Math.ceil(1.10 * aimR) + 1;
  const t0 = Date.now();
  const g = radialGradientProfile(rgba, w, h, aimCx, aimCy, rMaxInt);
  const polarMs = Date.now() - t0;

  return {
    ...r,
    aimR,
    aimCx, aimCy,
    g,
    polarMs,
    source, // 'training' | '11t-cluster' | 'xl-device'
  };
}

// ── Predicate evaluation under a calibration cell.
function evalCell(row, cell) {
  const { aimR, peakR, peakTc, fft90, op, bcTc, bcPeaks, tc, method } = row;
  if (aimR <= 0) return { fires: false, reason: 'aimR=0' };

  const chainringRegime = (peakTc >= MIN_CHAINRING_TC) || (fft90 >= MIN_CHAINRING_TC)
    || (op >= MIN_CHAINRING_TC) || (bcTc >= MIN_CHAINRING_TC) || (bcPeaks >= MIN_CHAINRING_TC);
  if (!chainringRegime) return { fires: false, reason: 'no chainring regime' };

  const tripleAgree = peakTc === fft90 && peakTc === op && peakTc === tc && peakTc > MIN_TEETH;
  const bcStrongAgree = bcTc === bcPeaks && Math.abs(bcTc - peakTc) > 5
    && tc === bcTc && bcTc > MIN_TEETH;
  if (tripleAgree || bcStrongAgree) return { fires: false, reason: 'triple/bcStrong override' };
  if (EXCLUDED_METHODS.test(method || '')) return { fires: false, reason: 'method excluded' };

  // Compute aim-anchored search per cell.
  const ro = sliceArgmax(row.g, cell.WIN_LO * aimR, cell.WIN_HI * aimR);
  const gNoise = sliceMedian(row.g, 0.20 * aimR, 0.50 * aimR);
  const snr = ro.g / Math.max(gNoise, 1e-6);
  const disagreePx = Math.abs(peakR - ro.r);
  const peakRFrac = peakR / aimR;

  const fires = snr >= cell.SNR_FLOOR
    && disagreePx > cell.DISAGREE_PX
    && peakR < cell.SAFE_PEAKR_FRAC * aimR;

  return {
    fires,
    rOuterAim: ro.r,
    gOuterAim: ro.g,
    gNoise,
    rOuterAimSnr: snr,
    peakRMinusAim_px: disagreePx,
    peakRFrac,
  };
}

// Single per-row predicate metrics under the *widest* search band — used for
// distribution-first reporting (amendment 2). WIN_LO=0.80, WIN_HI=1.10 maxes
// the search range so histograms span the full feasible space.
function distMetrics(row) {
  return evalCell(row, {
    WIN_LO: 0.80, WIN_HI: 1.10, SNR_FLOOR: 0, DISAGREE_PX: -1, SAFE_PEAKR_FRAC: 99,
  });
}

function strataOf(row) {
  // 11T cluster trace overrides class.
  if (row.source === '11t-cluster') return '11T-cluster';
  return row.klass;
}

function histogram(values, bins) {
  const buckets = new Array(bins.length).fill(0);
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    let placed = false;
    for (let i = 0; i < bins.length - 1; i++) {
      if (v >= bins[i] && v < bins[i + 1]) { buckets[i]++; placed = true; break; }
    }
    if (!placed && v >= bins[bins.length - 1]) buckets[bins.length - 1]++;
  }
  return buckets;
}

function printHist(label, values, bins) {
  const h = histogram(values, bins);
  const total = h.reduce((a, b) => a + b, 0);
  const cells = h.map((c, i) => {
    const lo = bins[i].toFixed(2);
    const hi = i + 1 < bins.length ? bins[i + 1].toFixed(2) : '+inf';
    const pct = total ? ((100 * c) / total).toFixed(0) + '%' : '0%';
    return `[${lo},${hi})=${c}/${pct}`;
  });
  out(`    ${label} n=${total}: ${cells.join('  ')}`);
}

// ── Main test ─────────────────────────────────────────────────────────────
describe('PAP-1102 H2 calibration — aim-anchored radial-gradient re-search', () => {
  jest.setTimeout(180 * 60 * 1000);

  test('amendments (1)-(5) applied; distribution + matrix + ms-cost', () => {
    const QUICK = process.env.PAP1102_QUICK === '1';
    out('\n=== PAP-1102 H2 calibration ===');
    out(`Grid cells: ${TOTAL_CELLS} (WIN_LO×WIN_HI×SNR_FLOOR×DISAGREE_PX×SAFE_PEAKR_FRAC)`);
    out(`Pre-mask g(r) on RGBA (option (b)); WIN_HI grid {1.00, 1.05, 1.10}`);

    // ── Phase 1: post-b97 training corpus (AC2 calibration) ─────────────
    const allTraining = require('./lib/harness-runner').discoverLabeled
      ? require('./lib/harness-runner').discoverLabeled({ minActual: 9, maxActual: 60 })
      : (() => {
          // Minimal local discovery if runner doesn't export.
          const entries = fs.readdirSync(TRAINING_DIR).sort();
          const list = [];
          for (const f of entries) {
            if (!f.endsWith('_meta.json')) continue;
            const stamp = f.replace('_meta.json', '');
            const photo = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
            if (!fs.existsSync(photo)) continue;
            try {
              const raw = fs.readFileSync(path.join(TRAINING_DIR, f), 'utf8')
                .replace(/[^\x00-\x7F]+/g, '?');
              const m = JSON.parse(raw);
              const actual = Number(m.actual_tooth_count || m.actualTeethCount || 0);
              if (!actual || actual < 9 || actual > 60) continue;
              list.push({ stamp, actual, photo });
            } catch { /* skip */ }
          }
          return list;
        })();
    const postB97 = [];
    const preB97 = [];
    for (const t of allTraining) {
      const meta = path.join(TRAINING_DIR, `${t.stamp}_meta.json`);
      const bn = buildOf(meta);
      if (bn != null && bn >= 97) postB97.push({ ...t, build: `b${bn}` });
      else preB97.push({ ...t, build: bn != null ? `b${bn}` : 'b?' });
    }
    out(`\n[corpus] training total=${allTraining.length}  post-b97=${postB97.length}  pre-b97=${preB97.length}`);

    out(`\n[Phase 1] post-b97 training: evaluating ${postB97.length} photos…`);
    const trainRows = [];
    let i = 0;
    for (const t of postB97) {
      const row = evalRow({ photo: t.photo, actual: t.actual, stamp: t.stamp, applyMask: false, source: 'training' });
      row.build = t.build;
      trainRows.push(row);
      i++;
      if (i % 25 === 0) out(`  [${i}/${postB97.length}]`);
    }

    // ── Phase 1b: 3 pre-b97 + 3 post-b97 spot-check rows (amendment 5)
    out('\n[Phase 1b] AC3 spot-check (3 pre-b97 + 3 post-b97):');
    const spotPre = preB97.slice(0, 3);
    const spotPost = postB97.slice(0, 3);
    for (const t of [...spotPre, ...spotPost]) {
      const row = evalRow({ photo: t.photo, actual: t.actual, stamp: t.stamp, applyMask: false, source: 'training' });
      const era = (t.build && Number(t.build.slice(1)) >= 97) ? 'post' : 'pre';
      out(`  [${era}-b97] ${t.stamp} build=${t.build} actual=${t.actual} `
        + `aimR=${row.aimR.toFixed(0)} peakR=${row.peakR} pk/aim=${(row.peakR / Math.max(row.aimR, 1)).toFixed(3)} `
        + `tc=${row.tc} conf=${row.conf.toFixed(2)}`);
    }

    // ── Phase 2: 11T cluster (AC1 no-regression trace, no AC2 weight) ──
    out(`\n[Phase 2] PAP-1060 11T cluster (n=${PAP1060_STAMPS.length}) — AC1 trace only:`);
    const clusterRows = [];
    for (const stamp of PAP1060_STAMPS) {
      const photo = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
      if (!fs.existsSync(photo)) { out(`  [missing] ${stamp}`); continue; }
      const meta = path.join(TRAINING_DIR, `${stamp}_meta.json`);
      const bn = buildOf(meta);
      const row = evalRow({ photo, actual: 11, stamp, applyMask: false, source: '11t-cluster' });
      row.build = bn != null ? `b${bn}` : 'b?';
      clusterRows.push(row);
    }
    out(`  [11T cluster] loaded ${clusterRows.length}/${PAP1060_STAMPS.length}`);

    // ── Phase 3: XL device captures (b111-b117) ────────────────────────
    out(`\n[Phase 3] XL device captures (n=${XL_DEVICE.length}):`);
    const xlRows = [];
    for (const t of XL_DEVICE) {
      const photo = path.join(DEBUG_DIR, t.stamp, 'cropped.jpg');
      if (!fs.existsSync(photo)) { out(`  [missing] ${t.stamp}`); continue; }
      const row = evalRow({ photo, actual: t.actual, stamp: t.stamp, applyMask: true, source: 'xl-device' });
      row.build = t.build;
      row.protect = t.protect || false;
      row.note = t.note || '';
      xlRows.push(row);
    }
    out(`  [xl-device] loaded ${xlRows.length}/${XL_DEVICE.length}`);

    const allCalibRows = [...trainRows, ...xlRows]; // post-b97 + xl-device → AC2 calibration
    const all = [...allCalibRows, ...clusterRows];   // + 11T trace for AC1

    // ── Amendment 4: ms-cost p99 of polar resample ─────────────────────
    const msSorted = all.map((r) => r.polarMs).sort((a, b) => a - b);
    out(`\n[ms-cost] polar-resample-only on ${all.length} rows:`);
    out(`  p50=${quantile(msSorted, 0.50)}  p95=${quantile(msSorted, 0.95)}  p99=${quantile(msSorted, 0.99)}  max=${msSorted[msSorted.length - 1]}`);

    // ── Amendment 2: distribution-first per stratum ────────────────────
    out('\n[distribution-first] per-stratum metrics under widest search band (WIN_LO=0.80, WIN_HI=1.10):');
    const strata = ['Small', 'Mid', 'Large', 'XL', '11T-cluster'];
    const dist = {};
    for (const s of strata) dist[s] = { snr: [], disagree: [], pkRatio: [] };
    for (const r of all) {
      const m = distMetrics(r);
      const s = strataOf(r);
      if (!dist[s]) continue;
      if (Number.isFinite(m.rOuterAimSnr)) dist[s].snr.push(m.rOuterAimSnr);
      if (Number.isFinite(m.peakRMinusAim_px)) dist[s].disagree.push(m.peakRMinusAim_px);
      if (Number.isFinite(m.peakRFrac)) dist[s].pkRatio.push(m.peakRFrac);
    }
    for (const s of strata) {
      out(`  --- ${s} ---`);
      printHist('rOuterAimSnr  ', dist[s].snr,      [0, 1, 1.5, 2, 2.5, 3, 4, 6, 10]);
      printHist('|peakR-rAim|px', dist[s].disagree, [0, 30, 60, 90, 120, 150, 200, 300]);
      printHist('peakR/aimR    ', dist[s].pkRatio,  [0, 0.4, 0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 1.0]);
    }

    // ── Phase 4: per-row CSV (amendments 2-4 instrumentation) ──────────
    const csvPath = path.join(DEBUG_DIR, `pap1102_calib_rows_2026-05-03.csv`);
    const csv = fs.openSync(csvPath, 'w');
    fs.writeSync(csv, 'stamp,source,build,klass,actual,tc,conf,peak,fft90,op,bc,bcPk,peakR,aimR,pkOverAim,'
      + 'rOuterAim_widest,gOuterAim,gNoise,snrWidest,disagreePxWidest,polarMs,method\n');
    for (const r of all) {
      const m = distMetrics(r);
      fs.writeSync(csv, `${r.stamp},${r.source},${r.build || ''},${r.klass},${r.actual},${r.tc},${r.conf.toFixed(3)},`
        + `${r.peakTc},${r.fft90},${r.op},${r.bcTc},${r.bcPeaks},${r.peakR},${r.aimR.toFixed(0)},`
        + `${(r.peakR / Math.max(r.aimR, 1)).toFixed(3)},`
        + `${m.rOuterAim || 0},${fmtFloat(m.gOuterAim || 0, 2)},${fmtFloat(m.gNoise || 0, 2)},`
        + `${fmtFloat(m.rOuterAimSnr, 3)},${m.peakRMinusAim_px || 0},${r.polarMs},`
        + `"${(r.method || '').replace(/"/g, '""')}"\n`);
    }
    fs.closeSync(csv);
    out(`\n[csv] per-row instrumentation: ${csvPath}`);

    if (QUICK) {
      out('\n[QUICK MODE] skipping 432-cell AC1+AC2 matrix sweep. Distribution + CSV done.');
      expect(all.length).toBeGreaterThan(0);
      return;
    }

    // ── Phase 5: AC1+AC2 unified matrix (amendment 3) ──────────────────
    // For each cell:
    //   - AC2 LOSS (training+xl-device): predicate fires AND row was confident-correct (within1).
    //   - AC2 WIN: predicate fires AND row was confident-wrong (offBy>1, conf>0.40).
    //   - AC2 NOOP: predicate fires AND row already abstained / conf<0.40.
    //   - 11T cluster: count rows where predicate fires (AC1 trace; abstain-only
    //     means CW% on cluster stays at 0 trivially, but we still report).
    //   - LOSS-protect short-circuit: if any of {b111 05-33-35, b117 14-53-36,
    //     b117 14-55-01, b117 15-21-57} flips to LOSS → drop cell.
    //   - ringPromote% / cogPromote% per stratum, Wilson 95% UB on AC1 candidates.
    out('\n[Phase 5] 432-cell AC1+AC2 matrix:');
    out('  legend: ringP%=fires%/chainring rows  cogP%=fires%/non-chainring (target=0)');
    out('  AC2: LOSS=confident-correct→fires (BAD)  WIN=confident-wrong→fires (GOOD)  NOOP=already abstaining→fires');
    out('  short-circuit: drop cell if any LOSS-protect XL row flips');

    const cellResults = [];
    let cellIdx = 0;
    for (const WIN_LO of GRID.WIN_LO) {
      for (const WIN_HI of GRID.WIN_HI) {
        if (WIN_HI <= WIN_LO) continue;
        for (const SNR_FLOOR of GRID.SNR_FLOOR) {
          for (const DISAGREE_PX of GRID.DISAGREE_PX) {
            for (const SAFE_PEAKR_FRAC of GRID.SAFE_PEAKR_FRAC) {
              const cell = { WIN_LO, WIN_HI, SNR_FLOOR, DISAGREE_PX, SAFE_PEAKR_FRAC };
              cellIdx++;

              let lossProtectFlip = false;
              const stats = {
                chainringFires: 0, chainringRows: 0,
                cogFires: 0, cogRows: 0,
                ac2Loss: 0, ac2Win: 0, ac2Noop: 0,
                clusterFires: 0,
                ac1NoRegress: true, // any 11T cluster row currently CW that flips must not happen (always abstain-only → trivially true)
                lossDetail: [],
                winDetail: [],
              };

              for (const r of allCalibRows) {
                const decision = evalCell(r, cell);
                const isChainring = r.peakTc >= 30 || r.fft90 >= 30 || r.op >= 30 || r.bcTc >= 30 || r.bcPeaks >= 30;
                if (isChainring) { stats.chainringRows++; if (decision.fires) stats.chainringFires++; }
                else { stats.cogRows++; if (decision.fires) stats.cogFires++; }
                if (decision.fires) {
                  if (r.protect) lossProtectFlip = true;
                  if (r.conf >= 0.40 && r.within1 && !r.abstain) {
                    stats.ac2Loss++;
                    stats.lossDetail.push(r);
                  } else if (r.conf >= 0.40 && !r.within1 && !r.abstain) {
                    stats.ac2Win++;
                    stats.winDetail.push(r);
                  } else {
                    stats.ac2Noop++;
                  }
                }
              }
              for (const r of clusterRows) {
                const decision = evalCell(r, cell);
                if (decision.fires) stats.clusterFires++;
              }

              if (lossProtectFlip) continue; // amendment 3: short-circuit.

              const ringPromote = stats.chainringRows ? stats.chainringFires / stats.chainringRows : 0;
              const cogPromote = stats.cogRows ? stats.cogFires / stats.cogRows : 0;
              const w95ub = wilson95UB(stats.chainringFires, Math.max(1, stats.chainringRows));

              cellResults.push({
                cell, stats, ringPromote, cogPromote, w95ub,
              });
            }
          }
        }
      }
    }

    // Sort by AC1-candidate quality:
    //   1. zero AC2 LOSS (must)
    //   2. zero cogPromote (must)
    //   3. highest ringPromote
    //   4. highest w95ub (≥ 80% target)
    cellResults.sort((a, b) => {
      const lossA = a.stats.ac2Loss, lossB = b.stats.ac2Loss;
      if (lossA !== lossB) return lossA - lossB;
      if (a.cogPromote !== b.cogPromote) return a.cogPromote - b.cogPromote;
      if (a.ringPromote !== b.ringPromote) return b.ringPromote - a.ringPromote;
      return b.w95ub - a.w95ub;
    });

    out(`\n[Matrix] ${cellResults.length} cells survived LOSS-protect short-circuit (of ${cellIdx})`);

    // Top 20 cells (single unified table per amendment 3).
    out('\n  rank  WIN_LO WIN_HI  SNR  DISp  SAFE   ringP%  cogP%   W95UB%  AC2-LOSS  AC2-WIN  AC2-NOOP  11T-fire  ');
    const TOP_N = 20;
    for (let k = 0; k < Math.min(TOP_N, cellResults.length); k++) {
      const c = cellResults[k];
      const cell = c.cell;
      out(
        `  ${(k + 1).toString().padStart(3)}.  ${cell.WIN_LO.toFixed(2)}   ${cell.WIN_HI.toFixed(2)}    `
        + `${cell.SNR_FLOOR.toFixed(1)}  ${cell.DISAGREE_PX.toString().padStart(3)}   ${cell.SAFE_PEAKR_FRAC.toFixed(2)}   `
        + `${(100 * c.ringPromote).toFixed(1).padStart(5)}   `
        + `${(100 * c.cogPromote).toFixed(1).padStart(5)}   `
        + `${(100 * c.w95ub).toFixed(1).padStart(5)}    `
        + `${c.stats.ac2Loss.toString().padStart(3)}      `
        + `${c.stats.ac2Win.toString().padStart(3)}      `
        + `${c.stats.ac2Noop.toString().padStart(3)}      `
        + `${c.stats.clusterFires.toString().padStart(2)}/${clusterRows.length}`
      );
    }

    // AC1-candidate set: cogPromote=0 AND ac2Loss=0 (both required for shippable cell).
    const ac1Candidates = cellResults.filter((c) => c.cogPromote === 0 && c.stats.ac2Loss === 0);
    out(`\n[AC1 candidates] cogPromote=0 AND AC2-LOSS=0: ${ac1Candidates.length} cells`);
    if (ac1Candidates.length > 0) {
      const best = ac1Candidates.reduce((a, b) => (b.ringPromote > a.ringPromote ? b : a));
      out(`  best ringPromote=${(100 * best.ringPromote).toFixed(1)}%  W95UB=${(100 * best.w95ub).toFixed(1)}%  `
        + `cell=${JSON.stringify(best.cell)}  AC2-WIN=${best.stats.ac2Win}  11T-fire=${best.stats.clusterFires}/${clusterRows.length}`);
    }

    // ── Hard-exit gate (PAP-1091) ──────────────────────────────────────
    const bestW95 = ac1Candidates.length
      ? Math.max(...ac1Candidates.map((c) => c.w95ub))
      : 0;
    out('\n=== PAP-1102 HARD-EXIT GATE ===');
    out(`  AC1 W95UB target: ≥ 80%`);
    out(`  AC1 W95UB best:   ${(100 * bestW95).toFixed(1)}%`);
    out(`  Verdict: ${bestW95 >= 0.80 ? 'PASS — proceed to 305-photo regression sweep' : 'FAIL — descope per PAP-1091 protocol'}`);

    // Detail dump for top cell's AC2-WIN rows (so QA can sanity-check the hits).
    if (cellResults.length > 0) {
      const top = cellResults[0];
      out(`\n[top-cell detail] cell=${JSON.stringify(top.cell)}:`);
      out(`  AC2-WIN rows (predicate catches confident-wrong):`);
      for (const r of top.stats.winDetail.slice(0, 10)) {
        out(`    ${r.stamp} src=${r.source} cls=${r.klass} actual=${r.actual} tc=${r.tc} conf=${r.conf.toFixed(2)} peakR=${r.peakR} aimR=${r.aimR.toFixed(0)} pk/aim=${(r.peakR / Math.max(r.aimR, 1)).toFixed(3)}`);
      }
      out(`  AC2-LOSS rows (predicate catches confident-correct — BAD):`);
      for (const r of top.stats.lossDetail.slice(0, 10)) {
        out(`    ${r.stamp} src=${r.source} cls=${r.klass} actual=${r.actual} tc=${r.tc} conf=${r.conf.toFixed(2)} peakR=${r.peakR} aimR=${r.aimR.toFixed(0)} pk/aim=${(r.peakR / Math.max(r.aimR, 1)).toFixed(3)}`);
      }
    }

    expect(all.length).toBeGreaterThan(0);
  });
});
