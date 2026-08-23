/**
 * PAP-1639 (PAP-1635.2) frame-pipeline profiler + output-identity snapshot.
 *
 * Runs under plain `node`, not jest. babel-jest slows the algorithm's tight
 * typed-array loops by ~400x (gaussianBlur5x5: 19ms plain V8 -> 8100ms under
 * jest on the same 900x675 frame), which both distorts every stage share and
 * makes a full-corpus run take hours. See lib/node-esm-stubs.mjs.
 *
 * Two jobs in one pass, so a before/after comparison costs one run each:
 *
 *   1. TIMING — per-stage wall time for the stages PAP-1636 telemetry names
 *      (preprocess / detect / methods), with `detect` broken down into the
 *      seven bodies of analyzeImage. Reported as p50 / p95 / max: this is a
 *      camera path, so the tail is what the user feels.
 *
 *   2. OUTPUT SNAPSHOT — the ten fields every accuracy gate reads, per photo.
 *      A pure performance change must leave all of them byte-identical, which
 *      is a far stronger claim than an aggregate accuracy percentage.
 *
 * Usage:
 *   node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *     mobile/__tests__/pap1639.profile.mjs measure <label> [stride]
 *   node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *     mobile/__tests__/pap1639.profile.mjs diff <before> <after>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decode: jpegDecode } = require('jpeg-js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TRAINING_DIR = path.join(ROOT, 'training-data');
const DEBUG_DIR = path.join(ROOT, 'debug-reports');
const CACHE_DIR = path.join(ROOT, '.cache', 'training-rgba');
const TARGET_MAX_DIM = 900;

const gc = await import('../src/algorithm/gearCounter.js');
const { __test, countTeethFromRgba, bilinearDownsampleRgba } = gc;
const {
  rgbaToGray, clahe, gaussianBlur5x5, cannyEdges,
  findGearCenter, findGearRadius, fftAtOuterRadii, multiRadiusFftScan,
  outerProfileScan, binaryContourCount, clahePeakCounting,
} = __test;

console.log = () => {};
const out = (s) => process.stdout.write(s + '\n');

const COARSE = ['gray', 'clahe', 'blur', 'canny', 'detect', 'methods'];
const DETECT_SUB = [
  'center',      // findGearCenter
  'edgeRadius',  // findGearRadius
  'fft90',       // fftAtOuterRadii
  'multiR',      // multiRadiusFftScan
  'outerProf',   // outerProfileScan
  'binContour',  // binaryContourCount
  'clahePeak',   // clahePeakCounting
];
const OUT_KEYS = ['tc', 'conf', 'method', 'gearR', 'peakTc', 'fft90', 'op', 'bcTc', 'peakR', 'rOuter', 'cx', 'cy'];

const snapPath = (label) => path.join(DEBUG_DIR, `pap1639_${label}.json`);

// ── Corpus (mirrors lib/harness-runner.js discoverLabeled + the PAP-971 cache)
function discoverLabeled() {
  const labeled = [];
  for (const f of fs.readdirSync(TRAINING_DIR).sort()) {
    if (!f.endsWith('_meta.json')) continue;
    let meta;
    try {
      meta = JSON.parse(
        fs.readFileSync(path.join(TRAINING_DIR, f), 'utf8').replace(/[^\x00-\x7F]+/g, '?'),
      );
    } catch { continue; }
    const actual = Number(meta.actual_tooth_count || meta.actualTeethCount || 0);
    if (!actual || actual < 9 || actual > 60) continue;
    const stamp = f.replace('_meta.json', '');
    const photo = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
    if (!fs.existsSync(photo)) continue;
    labeled.push({ stamp, actual, photo });
  }
  return labeled;
}

function loadRgba(photo, stamp) {
  const bin = path.join(CACHE_DIR, `${stamp}_${TARGET_MAX_DIM}.bin`);
  const metaP = path.join(CACHE_DIR, `${stamp}_${TARGET_MAX_DIM}.meta.json`);
  const srcMtimeMs = fs.statSync(photo).mtimeMs;
  if (fs.existsSync(metaP) && fs.existsSync(bin)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaP, 'utf8'));
      if (m.sourceMtimeMs === srcMtimeMs && m.targetMaxDim === TARGET_MAX_DIM) {
        const buf = fs.readFileSync(bin);
        const rgba = new Uint8Array(buf.byteLength);
        rgba.set(buf);
        return { rgba, w: m.width, h: m.height };
      }
    } catch { /* fall through */ }
  }
  const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET_MAX_DIM);
  return { rgba: ds.rgba, w: ds.width, h: ds.height };
}

const PAP760_BUCKETS = [
  { lo: 9, hi: 15, tol: 0, name: 'Small  9-15T ' },
  { lo: 16, hi: 20, tol: 0, name: 'Mid    16-20T' },
  { lo: 21, hi: 28, tol: 1, name: 'Large  21-28T' },
  { lo: 29, hi: 60, tol: 1, name: 'XL     29-60T' },
];
const bucketOf = (a) => PAP760_BUCKETS.find((b) => a >= b.lo && a <= b.hi) || null;

// ── Measure ────────────────────────────────────────────────────────────────
function measure(label, stride) {
  let labeled = discoverLabeled();
  if (stride > 1) labeled = labeled.filter((_, i) => i % stride === 0);
  out(`[pap1639] measure label=${label} photos=${labeled.length} stride=${stride}`);

  const rows = [];
  const t0 = Date.now();
  for (let i = 0; i < labeled.length; i++) {
    const { photo, actual, stamp } = labeled[i];
    const { rgba, w, h } = loadRgba(photo, stamp);
    const t = {};

    const a = Date.now(); const gray = rgbaToGray(rgba, w, h);
    const b = Date.now(); const enhanced = clahe(gray, w, h, 3.0, 8, 8);
    const c = Date.now(); const blurred = gaussianBlur5x5(enhanced, w, h);
    const d = Date.now(); const edges = cannyEdges(blurred, w, h, 50, 150);
    const e = Date.now();
    t.gray = b - a; t.clahe = c - b; t.blur = d - c; t.canny = e - d;

    // Replicates analyzeImage's stage sequence so each body can be timed
    // independently. Read-only: the production path is untouched.
    const aimR = 0.5 * Math.min(w, h);
    const s0 = Date.now();
    const centerResult = findGearCenter(gray, enhanced, edges, w, h);
    const s1 = Date.now();
    const cx = centerResult.cx, cy = centerResult.cy;
    const contourRadius = centerResult.radius || 0;
    const edgeDensityR = findGearRadius(edges, cx, cy, w, h);
    const s2 = Date.now();
    let gearR;
    if (contourRadius <= 20) gearR = edgeDensityR;
    else if (edgeDensityR > contourRadius * 1.4) gearR = edgeDensityR;
    else if (contourRadius > edgeDensityR * 1.6) gearR = edgeDensityR;
    else gearR = Math.max(contourRadius, edgeDensityR);
    fftAtOuterRadii(enhanced, cx, cy, contourRadius, gearR, edges, w, h);
    const s3 = Date.now();
    multiRadiusFftScan(enhanced, edges, cx, cy, gearR, w, h, aimR);
    const s4 = Date.now();
    outerProfileScan(edges, cx, cy, Math.min(cx, w - cx, cy, h - cy) - 1, w, h, gearR);
    const s5 = Date.now();
    binaryContourCount(gray, cx, cy, w, h);
    const s6 = Date.now();
    clahePeakCounting(enhanced, cx, cy, gearR, w, h);
    const s7 = Date.now();
    t.center = s1 - s0; t.edgeRadius = s2 - s1; t.fft90 = s3 - s2;
    t.multiR = s4 - s3; t.outerProf = s5 - s4; t.binContour = s6 - s5;
    t.clahePeak = s7 - s6;
    t.detect = s7 - s0;

    // Production entry point: real total, plus the outputs that must not move.
    const f0 = Date.now();
    let r;
    try { r = countTeethFromRgba(rgba, w, h); }
    catch (err) { r = { toothCount: 0, confidence: 0, error: err.message }; }
    t.total = Date.now() - f0;
    // `methods` = whatever the production run spends beyond preprocess+detect,
    // i.e. the off-center / small-gear retry cascade.
    t.methods = Math.max(0, t.total - (t.gray + t.clahe + t.blur + t.canny + t.detect));

    rows.push({
      stamp, actual, w, h, t,
      o: {
        tc: r.toothCount || 0,
        conf: Number((r.confidence || 0).toFixed(6)),
        method: r.methodUsed || '?',
        gearR: r.gearRadius || 0,
        peakTc: r.peakTc || 0,
        fft90: r.fft90tc || 0,
        op: r.opTc || 0,
        bcTc: r.bcTc || 0,
        peakR: r.peakR || 0,
        rOuter: r.rOuter || 0,
        cx: r.cx || 0,
        cy: r.cy || 0,
      },
    });
    if ((i + 1) % 50 === 0) {
      out(`  [${i + 1}/${labeled.length}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }

  const elapsedMs = Date.now() - t0;
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(snapPath(label), JSON.stringify({ label, elapsedMs, rows }));
  report(label, rows, elapsedMs);
  out(`\n[pap1639] snapshot -> ${snapPath(label)}`);
}

const quantile = (sorted, q) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;

function statsFor(rows, key) {
  const v = rows.map((r) => r.t[key] || 0).sort((x, y) => x - y);
  const sum = v.reduce((x, y) => x + y, 0);
  return { p50: quantile(v, 0.5), p95: quantile(v, 0.95), max: v[v.length - 1] || 0, sum };
}

const ORDER = (() => {
  const k = [];
  for (const c of COARSE) { k.push(c); if (c === 'detect') k.push(...DETECT_SUB); }
  return k;
})();

function report(label, rows, elapsedMs) {
  const totalSum = rows.reduce((a, r) => a + (r.t.total || 0), 0);
  out(`\n=== PAP-1639 stage profile [${label}] ===`);
  out(`Corpus: ${rows.length} photos   Wall: ${(elapsedMs / 1000).toFixed(1)}s   Sum(total): ${(totalSum / 1000).toFixed(1)}s`);
  out('');
  out('stage           p50     p95     max    share');
  for (const k of ORDER) {
    const s = statsFor(rows, k);
    const indent = DETECT_SUB.includes(k) ? '  ' : '';
    out(
      `${(indent + k).padEnd(14)} ${String(s.p50).padStart(5)}   ${String(s.p95).padStart(5)}   ` +
      `${String(s.max).padStart(5)}   ${totalSum ? ((100 * s.sum) / totalSum).toFixed(1).padStart(5) + '%' : '  -  '}`,
    );
  }
  const st = statsFor(rows, 'total');
  out('------------------------------------------------');
  out(`${'total'.padEnd(14)} ${String(st.p50).padStart(5)}   ${String(st.p95).padStart(5)}   ${String(st.max).padStart(5)}   100.0%`);
}

// ── Diff ───────────────────────────────────────────────────────────────────
function diff(beforeLabel, afterLabel) {
  const before = JSON.parse(fs.readFileSync(snapPath(beforeLabel), 'utf8'));
  const after = JSON.parse(fs.readFileSync(snapPath(afterLabel), 'utf8'));
  const bMap = new Map(before.rows.map((r) => [r.stamp, r]));
  const paired = [];
  for (const a of after.rows) {
    const b = bMap.get(a.stamp);
    if (b) paired.push({ b, a });
  }
  out(`\n=== PAP-1639 before/after [${beforeLabel} -> ${afterLabel}] ===`);
  out(`Paired ${paired.length} photos (before=${before.rows.length}, after=${after.rows.length})`);
  out('');
  out('stage             p50 ms            p95 ms            sum s');
  for (const k of [...ORDER, 'total']) {
    const sb = statsFor(paired.map((p) => p.b), k);
    const sa = statsFor(paired.map((p) => p.a), k);
    const fmt = (x, y) => {
      const p = x ? ((y - x) / x) * 100 : 0;
      return `${String(x).padStart(5)}->${String(y).padStart(5)} ${(p >= 0 ? '+' : '') + p.toFixed(0)}%`;
    };
    const fmts = (x, y) => {
      const p = x ? ((y - x) / x) * 100 : 0;
      return `${(x / 1000).toFixed(1)}->${(y / 1000).toFixed(1)} ${(p >= 0 ? '+' : '') + p.toFixed(0)}%`;
    };
    const indent = DETECT_SUB.includes(k) ? '  ' : '';
    out(`${(indent + k).padEnd(15)} ${fmt(sb.p50, sa.p50).padEnd(18)}${fmt(sb.p95, sa.p95).padEnd(18)}${fmts(sb.sum, sa.sum)}`);
  }

  const divergent = [];
  for (const { b, a } of paired) {
    const changed = OUT_KEYS.filter((k) => b.o[k] !== a.o[k]);
    if (changed.length) divergent.push({ stamp: b.stamp, actual: b.actual, changed, b: b.o, a: a.o });
  }
  out(`\nOutput identity: ${paired.length - divergent.length}/${paired.length} photos identical on [${OUT_KEYS.join(',')}]`);
  if (divergent.length) {
    out(`DIVERGENT (${divergent.length}):`);
    for (const d of divergent.slice(0, 80)) {
      out(`  ${d.stamp} actual=${d.actual}`);
      for (const k of d.changed) out(`      ${k}: ${d.b[k]} -> ${d.a[k]}`);
    }
    if (divergent.length > 80) out(`  ... ${divergent.length - 80} more`);
  }

  const tally = (side) => {
    const st = { correct: 0, abstain: 0, cw: 0 };
    const per = new Map();
    for (const p of paired) {
      const bk = bucketOf(p.b.actual);
      if (!bk) continue;
      const o = p[side].o;
      const rec = per.get(bk.name) || { n: 0, correct: 0, abstain: 0, cw: 0 };
      rec.n++;
      if (o.conf === 0 || o.tc === 0) { rec.abstain++; st.abstain++; }
      else if (Math.abs(o.tc - p.b.actual) <= bk.tol) { rec.correct++; st.correct++; }
      else { rec.cw++; st.cw++; }
      per.set(bk.name, rec);
    }
    return { st, per };
  };
  const tb = tally('b'), ta = tally('a');
  out('\nAccuracy (PAP-760 buckets)');
  out('bucket          N    correct before -> after      abstain      conf-wrong');
  for (const bk of PAP760_BUCKETS) {
    const rb = tb.per.get(bk.name), ra = ta.per.get(bk.name);
    if (!rb) continue;
    const pc = (x, n) => `${x} (${((100 * x) / n).toFixed(1)}%)`;
    out(`${bk.name}  ${String(rb.n).padStart(3)}   ${pc(rb.correct, rb.n).padEnd(13)}->  ${pc(ra.correct, ra.n).padEnd(13)}  ${rb.abstain}->${ra.abstain}       ${rb.cw}->${ra.cw}`);
  }
  const n = paired.length;
  out(`TOTAL           ${String(n).padStart(3)}   ${tb.st.correct} (${((100 * tb.st.correct) / n).toFixed(1)}%)  ->  ${ta.st.correct} (${((100 * ta.st.correct) / n).toFixed(1)}%)   ${tb.st.abstain}->${ta.st.abstain}       ${tb.st.cw}->${ta.st.cw}`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'diff') diff(args[0], args[1]);
else measure(args[0] || 'run', Number(args[1] || 1));
