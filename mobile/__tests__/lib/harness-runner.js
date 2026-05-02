/**
 * Shared harness runner (PAP-970).
 *
 * Extracts the common boilerplate from the ~46 PAP-* measurement harnesses
 * under mobile/__tests__/. A harness file should be ~50 lines:
 *
 *   const runner = require('./lib/harness-runner');
 *   runner.silenceConsole();
 *   const { rows, labeled } = runner.runCorpus({ targetRange: [29, 60] });
 *   // ... analysis-specific reporting on rows ...
 *
 * SCOPE selection
 *   SCOPE=targeted    only images in `targetRange` (default)
 *   SCOPE=regression  20% seeded sample of images OUTSIDE `targetRange`
 *   SCOPE=full        every labeled image (≡ legacy harness behaviour)
 *
 * SCOPE=full produces a row set that is identical (same stamps, same order)
 * to the pre-migration harnesses, so legacy reports stay reproducible.
 *
 * The runner deliberately stays test-framework-agnostic: it exposes plain
 * functions so harnesses can pick which jest `describe/test` shape they need
 * (some jest configs use 30-min timeouts, some 3-hour, some run a single
 * test, some run a sweep).
 */

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

const TRAINING_DIR = path.resolve(__dirname, '..', '..', '..', 'training-data');
const DEBUG_DIR = path.resolve(__dirname, '..', '..', '..', 'debug-reports');
const CACHE_DIR = path.resolve(__dirname, '..', '..', '..', '.cache', 'training-rgba');
const TARGET_MAX_DIM = 900;

// ──────────────────────────────────────────────────────────────────────────
// Output helpers
// ──────────────────────────────────────────────────────────────────────────

function silenceConsole() {
  // Algorithm modules log heavily; jest buffers every line which makes a
  // 400+-image sweep unbearable. Final reports go through stdout directly.
  console.log = () => {};
  console.warn = () => {};
  console.info = () => {};
  console.debug = () => {};
}

const out = (s) => process.stdout.write(s + '\n');

// ──────────────────────────────────────────────────────────────────────────
// Classification helpers
// ──────────────────────────────────────────────────────────────────────────

// PAP-760 board buckets (used by audit-style reports)
const PAP760_BUCKETS = [
  { name: 'Small  9-15T ', lo: 9, hi: 15, tol: 0 },
  { name: 'Mid    16-20T', lo: 16, hi: 20, tol: 0 },
  { name: 'Large  21-28T', lo: 21, hi: 28, tol: 1 },
  { name: 'XL     29-60T', lo: 29, hi: 60, tol: 1 },
];

function bucketOf(actual, buckets = PAP760_BUCKETS) {
  for (const b of buckets) if (actual >= b.lo && actual <= b.hi) return b;
  return null;
}

// Per-class label used by pap796/pap885/pap939-style sweeps.
function classOf(actual) {
  if (actual <= 13) return 'Small';
  if (actual <= 20) return 'Mid';
  if (actual <= 28) return 'Large';
  return 'XL';
}

// ──────────────────────────────────────────────────────────────────────────
// Corpus discovery + scope filtering
// ──────────────────────────────────────────────────────────────────────────

/**
 * Discover every labeled (photo, actual) pair under training-data/.
 * Returns a list sorted by stamp (ascending) so SCOPE=full is reproducible.
 */
function discoverLabeled({ minActual = 9, maxActual = 60 } = {}) {
  if (!fs.existsSync(TRAINING_DIR)) return [];
  const entries = fs.readdirSync(TRAINING_DIR).sort();
  const labeled = [];
  for (const f of entries) {
    if (!f.endsWith('_meta.json')) continue;
    let meta;
    try {
      // utf8 decode replaces invalid bytes with U+FFFD; strip non-ASCII so
      // older meta files (some have stray Unicode spaces) parse cleanly.
      const raw = fs.readFileSync(path.join(TRAINING_DIR, f), 'utf8')
        .replace(/[^\x00-\x7F]+/g, '?');
      meta = JSON.parse(raw);
    } catch { continue; }
    const actual = Number(meta.actual_tooth_count || meta.actualTeethCount || 0);
    if (!actual || actual < minActual || actual > maxActual) continue;
    const stamp = f.replace('_meta.json', '');
    const photo = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
    if (!fs.existsSync(photo)) continue;
    labeled.push({ stamp, actual, photo });
  }
  return labeled;
}

// Mulberry32 — small deterministic PRNG so SCOPE=regression is reproducible
// across machines without pulling in a dep.
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Resolve SCOPE for the current run.
 * Priority: explicit opt → process.env.SCOPE → default 'targeted'.
 */
function resolveScope(explicit) {
  const v = (explicit || process.env.SCOPE || 'targeted').toLowerCase();
  if (v !== 'targeted' && v !== 'regression' && v !== 'full') {
    throw new Error(`harness-runner: unknown SCOPE='${v}' (expected targeted|regression|full)`);
  }
  return v;
}

/**
 * Select the (subset of) labeled corpus to run, given a target tooth-count
 * range and the active SCOPE.
 *
 *   targetRange=[lo,hi]  inclusive
 *   regressionFrac       fraction of OUT-OF-RANGE rows kept under regression
 *   regressionSeed       PRNG seed (deterministic)
 */
function selectCorpus({
  targetRange,
  scope,
  regressionFrac = 0.2,
  regressionSeed = 1337,
  minActual = 9,
  maxActual = 60,
} = {}) {
  const all = discoverLabeled({ minActual, maxActual });
  const resolved = resolveScope(scope);
  if (resolved === 'full' || !targetRange) {
    return { selected: all, scope: resolved, total: all.length };
  }
  const [lo, hi] = targetRange;
  const inRange = all.filter((x) => x.actual >= lo && x.actual <= hi);
  if (resolved === 'targeted') {
    return { selected: inRange, scope: resolved, total: all.length };
  }
  // regression: keep all in-range PLUS a seeded sample of out-of-range rows.
  const outRange = all.filter((x) => x.actual < lo || x.actual > hi);
  const rand = mulberry32(regressionSeed);
  const kept = outRange.filter(() => rand() < regressionFrac);
  // Re-sort so the merged list stays stamp-ordered.
  const merged = [...inRange, ...kept].sort((a, b) =>
    a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0,
  );
  return { selected: merged, scope: resolved, total: all.length };
}

// ──────────────────────────────────────────────────────────────────────────
// Algorithm invocation
// ──────────────────────────────────────────────────────────────────────────

let _algo = null;
function getAlgo() {
  if (_algo) return _algo;
  // Lazy require so silenceConsole() can run before the algorithm module's
  // top-level logs fire.
  const { countTeethFromRgba, bilinearDownsampleRgba } =
    require('../../src/algorithm/gearCounter');
  let applyCircularMask = null;
  try {
    applyCircularMask = require('../../src/algorithm/imageUtils').applyCircularMask;
  } catch { /* not all harness setups need it */ }
  _algo = { countTeethFromRgba, bilinearDownsampleRgba, applyCircularMask };
  return _algo;
}

// ──────────────────────────────────────────────────────────────────────────
// Pre-decoded RGBA cache (PAP-971)
//
// JPEG decode + bilinear downsample is the bulk of per-image cost on a sweep
// (~30-40%). Cache the post-downsample buffer keyed by source mtime so a
// re-run skips both. CACHE=off bypasses; cache invalidates on photo touch.
// ──────────────────────────────────────────────────────────────────────────

function _cacheEnabled() {
  return (process.env.CACHE || '').toLowerCase() !== 'off';
}

function _cachePaths(stamp) {
  return {
    bin: path.join(CACHE_DIR, `${stamp}_${TARGET_MAX_DIM}.bin`),
    meta: path.join(CACHE_DIR, `${stamp}_${TARGET_MAX_DIM}.meta.json`),
  };
}

/**
 * Read a downsampled RGBA buffer for `photo`, using the on-disk cache when
 * the source mtime matches. Returns { rgba: Uint8Array, w, h }.
 */
function loadOrDecodeRgba(photo, stamp) {
  const { bilinearDownsampleRgba } = getAlgo();
  const useCache = _cacheEnabled();
  const srcMtimeMs = fs.statSync(photo).mtimeMs;

  if (useCache) {
    const { bin, meta } = _cachePaths(stamp);
    if (fs.existsSync(meta) && fs.existsSync(bin)) {
      try {
        const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
        if (
          m.sourceMtimeMs === srcMtimeMs &&
          m.targetMaxDim === TARGET_MAX_DIM &&
          Number.isInteger(m.width) && Number.isInteger(m.height)
        ) {
          const buf = fs.readFileSync(bin);
          // Copy out of Buffer's pooled slab to a standalone Uint8Array so
          // downstream code (and any future cache eviction) can't alias it.
          const rgba = new Uint8Array(buf.byteLength);
          rgba.set(buf);
          return { rgba, w: m.width, h: m.height };
        }
      } catch { /* fall through to decode */ }
    }
  }

  const buf = fs.readFileSync(photo);
  const raw = jpegDecode(buf, { useTArray: true });
  const { rgba, width: w, height: h } = bilinearDownsampleRgba(
    raw.data, raw.width, raw.height, TARGET_MAX_DIM,
  );

  if (useCache) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const { bin, meta } = _cachePaths(stamp);
      // Write atomically so a SIGINT mid-write can't leave a torn cache row.
      fs.writeFileSync(`${bin}.tmp`, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
      fs.renameSync(`${bin}.tmp`, bin);
      fs.writeFileSync(`${meta}.tmp`, JSON.stringify({
        stamp, width: w, height: h, targetMaxDim: TARGET_MAX_DIM,
        sourceMtimeMs: srcMtimeMs,
      }));
      fs.renameSync(`${meta}.tmp`, meta);
    } catch { /* cache failures are non-fatal */ }
  }

  return { rgba, w, h };
}

/**
 * Decode a JPEG from disk, downsample to TARGET_MAX_DIM, optionally apply the
 * crop circular mask (used by debug-report cropped.jpg replay), run the
 * gear-count algorithm, and return a normalised row of fields.
 *
 * The row is a superset of every field used across pap760/pap796/pap939; if
 * a harness needs more fields it can read them straight off `row.raw`.
 */
function evalPhoto({ photo, actual, stamp, applyMask = false, tol }) {
  const { countTeethFromRgba, applyCircularMask } = getAlgo();
  const { rgba, w, h } = loadOrDecodeRgba(photo, stamp);
  if (applyMask) {
    if (!applyCircularMask) throw new Error('applyCircularMask unavailable');
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    applyCircularMask(rgba, w, h, cx, cy, 0.49 * Math.min(w, h));
  }
  const ts = Date.now();
  let r;
  try { r = countTeethFromRgba(rgba, w, h); }
  catch (e) { r = { toothCount: 0, confidence: 0, error: e.message }; }
  const runtime = Date.now() - ts;

  const tc = r.toothCount || 0;
  const conf = r.confidence || 0;
  const innerSus = !!r.innerContourSuspected;
  const abstain = conf === 0 || tc === 0 || innerSus;
  const offBy = Math.abs(tc - actual);
  const within1 = offBy <= 1;
  const b = bucketOf(actual);
  const tolUsed = typeof tol === 'number' ? tol : (b ? b.tol : 1);
  const correct = !abstain && offBy <= tolUsed;
  const confidentWrong = !abstain && !correct;

  return {
    stamp,
    actual,
    photo,
    w, h,
    tc,
    conf,
    runtime,
    innerSus,
    abstain,
    within1,
    correct,
    confidentWrong,
    offBy,
    klass: classOf(actual),
    bucket: b ? b.name : 'OUT',
    method: r.methodUsed || '?',
    gearR: r.gearRadius || 0,
    peakTc: r.peakTc || 0,
    fft90: r.fft90tc || 0,
    op: r.opTc || 0,
    bcTc: r.bcTc || 0,
    bcPeaks: r.bcPeaks || 0,
    peakR: r.peakR || 0,
    rOuter: r.rOuter || 0,
    raw: r,
  };
}

/**
 * Convenience: select corpus and evaluate every photo. Logs progress at
 * `progressEvery` intervals to stdout. Returns { rows, elapsedMs, scope, total }.
 */
function runCorpus({
  targetRange,
  scope,
  regressionFrac,
  regressionSeed,
  minActual,
  maxActual,
  applyMask = false,
  progressEvery = 25,
  label = 'harness',
} = {}) {
  const { selected, scope: resolved, total } = selectCorpus({
    targetRange, scope, regressionFrac, regressionSeed, minActual, maxActual,
  });
  out(`\n[${label}] SCOPE=${resolved} running ${selected.length}/${total} labeled photos`);
  const rows = [];
  const t0 = Date.now();
  for (let i = 0; i < selected.length; i++) {
    const { photo, actual, stamp } = selected[i];
    rows.push(evalPhoto({ photo, actual, stamp, applyMask }));
    if (progressEvery > 0 && (i + 1) % progressEvery === 0) {
      out(`  [${i + 1}/${selected.length}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
  const elapsedMs = Date.now() - t0;
  return { rows, elapsedMs, scope: resolved, total, labeled: selected };
}

// ──────────────────────────────────────────────────────────────────────────
// Reporting helpers
// ──────────────────────────────────────────────────────────────────────────

function pct(n, d) {
  return d ? ((100 * n) / d).toFixed(1) + '%' : '  -  ';
}

function quantile(sortedArr, q) {
  if (!sortedArr.length) return 0;
  const i = Math.min(sortedArr.length - 1, Math.floor(q * sortedArr.length));
  return sortedArr[i];
}

/**
 * PAP-760-style headline accuracy report. Prints the per-bucket matrix and
 * per-actual breakdown, then a failures dump. Tailored to a full audit; cross-
 * check harnesses normally print their own bespoke matrix instead.
 */
function printAuditReport({ rows, elapsedMs, label = 'harness' }) {
  const stats = PAP760_BUCKETS.map((b) => ({
    b, total: 0, correct: 0, abstain: 0, confidentWrong: 0, runtimes: [], failures: [],
  }));
  const fails = new Map();
  for (const r of rows) {
    const idx = PAP760_BUCKETS.findIndex((b) => b.name === r.bucket);
    if (idx < 0) continue;
    const s = stats[idx];
    s.total++;
    s.runtimes.push(r.runtime);
    if (r.abstain) s.abstain++;
    else if (r.correct) s.correct++;
    else { s.confidentWrong++; s.failures.push(r); }
    if (!r.correct) {
      const arr = fails.get(r.bucket) || [];
      arr.push(r);
      fails.set(r.bucket, arr);
    }
  }
  out(`\n=== ${label} per-class accuracy ===`);
  out(`Corpus: ${rows.length} photos   Wall: ${(elapsedMs / 1000).toFixed(1)}s`);
  out('');
  out('Bucket          Tol   N    Correct  Acc%    Abstain  Conf-Wrong   med  p95  max  (ms)');
  const agg = { total: 0, correct: 0, abstain: 0, cw: 0, runtimes: [] };
  for (const s of stats) {
    const rt = s.runtimes.slice().sort((a, b) => a - b);
    const med = quantile(rt, 0.5);
    const p95 = quantile(rt, 0.95);
    const max = rt[rt.length - 1] || 0;
    const tol = s.b.tol === 0 ? 'exact' : `±${s.b.tol}   `;
    out(
      `${s.b.name}  ${tol}  ${String(s.total).padStart(3)}  ${String(s.correct).padStart(7)}  ${pct(s.correct, s.total).padStart(6)}  ${String(s.abstain).padStart(7)}  ${String(s.confidentWrong).padStart(10)}   ${String(med).padStart(4)} ${String(p95).padStart(4)} ${String(max).padStart(4)}`,
    );
    agg.total += s.total; agg.correct += s.correct; agg.abstain += s.abstain;
    agg.cw += s.confidentWrong; agg.runtimes.push(...s.runtimes);
  }
  const aggRt = agg.runtimes.sort((a, b) => a - b);
  out('-------------------------------------------------------------------------------------');
  out(
    `TOTAL                ${String(agg.total).padStart(3)}  ${String(agg.correct).padStart(7)}  ${pct(agg.correct, agg.total).padStart(6)}  ${String(agg.abstain).padStart(7)}  ${String(agg.cw).padStart(10)}   ${String(quantile(aggRt, 0.5)).padStart(4)} ${String(quantile(aggRt, 0.95)).padStart(4)} ${String(aggRt[aggRt.length - 1] || 0).padStart(4)}`,
  );

  const byActual = new Map();
  for (const r of rows) {
    const o = byActual.get(r.actual) || { total: 0, correct: 0, abstain: 0, cw: 0 };
    o.total++;
    if (r.abstain) o.abstain++; else if (r.correct) o.correct++; else o.cw++;
    byActual.set(r.actual, o);
  }
  out('\nPer-actual breakdown:');
  out('actual   N   correct  abstain  conf-wrong  acc%');
  for (const a of [...byActual.keys()].sort((x, y) => x - y)) {
    const o = byActual.get(a);
    out(
      `  ${String(a).padStart(2)}T   ${String(o.total).padStart(3)}   ${String(o.correct).padStart(7)}  ${String(o.abstain).padStart(7)}  ${String(o.cw).padStart(10)}   ${pct(o.correct, o.total)}`,
    );
  }

  out('\nFailures (not correct):');
  for (const [bucket, arr] of fails) {
    out(`  -- ${bucket} --`);
    for (const r of arr) {
      const tag = r.abstain ? 'ABSTAIN' : 'WRONG  ';
      out(`    ${tag} ${r.stamp} actual=${r.actual} detected=${r.tc} conf=${r.conf.toFixed?.(3) ?? r.conf} ${r.runtime}ms`);
    }
  }

  for (const s of stats) {
    if (s.total === 0) continue;
    const acc = (s.correct / s.total) * 100;
    if (acc < 50) {
      out(`[${label}] WARN ${s.b.name} accuracy ${acc.toFixed(1)}% (<50%) — likely regression`);
    }
  }
}

module.exports = {
  // dirs / constants
  TRAINING_DIR,
  DEBUG_DIR,
  CACHE_DIR,
  TARGET_MAX_DIM,
  PAP760_BUCKETS,
  // setup
  silenceConsole,
  out,
  // discovery / selection
  discoverLabeled,
  resolveScope,
  selectCorpus,
  // execution
  getAlgo,
  loadOrDecodeRgba,
  evalPhoto,
  runCorpus,
  // reporting
  bucketOf,
  classOf,
  pct,
  quantile,
  printAuditReport,
};
