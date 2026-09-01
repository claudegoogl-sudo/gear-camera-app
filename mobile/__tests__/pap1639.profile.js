/**
 * PAP-1639 (PAP-1635.2) frame-pipeline profiler + output-identity snapshot.
 *
 * Two jobs in one pass over the corpus, so a before/after comparison costs
 * one run each rather than two:
 *
 *   1. TIMING — per-stage wall time for every stage the PAP-1636 telemetry
 *      names (load / preprocess / detect / methods), plus a breakdown of the
 *      `detect` stage into the seven bodies of analyzeImage. Reported as
 *      p50 / p95 / max, because this is a camera path and the tail is what
 *      the user feels.
 *
 *   2. OUTPUT SNAPSHOT — (stamp, tc, conf, method, gearR, peakTc, fft90,
 *      op, bcTc, peakR, rOuter) per photo, written to JSON. A pure
 *      performance change must leave every one of these byte-identical;
 *      MODE=diff proves that far more strongly than an aggregate accuracy
 *      percentage can.
 *
 * Modes (env):
 *   MODE=measure LABEL=<name>   run the corpus, write
 *                               debug-reports/pap1639_<name>.json
 *   MODE=diff BEFORE=<name> AFTER=<name>
 *                               join the two snapshots on stamp and report
 *                               timing deltas + any output divergence
 *
 * Run:
 *   MODE=measure LABEL=baseline HARNESS=pap1639.profile \
 *     npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();

const { out, quantile, DEBUG_DIR } = runner;

const MODE = (process.env.MODE || 'measure').toLowerCase();
const LABEL = process.env.LABEL || 'run';
const REPEATS = Number(process.env.REPEATS || 1);

const snapPath = (label) => path.join(DEBUG_DIR, `pap1639_${label}.json`);

// Stage names in pipeline order. `detect` is the sum of the analyzeImage
// bodies below it; it is kept as its own row so the numbers tie back to the
// PAP-1636 on-device telemetry, which only knows the four coarse stages.
const COARSE = ['gray', 'clahe', 'blur', 'canny', 'detect', 'retry'];
const DETECT_SUB = [
  'center',      // findGearCenter
  'edgeRadius',  // findGearRadius
  'fft90',       // fftAtOuterRadii
  'multiR',      // multiRadiusFftScan
  'outerProf',   // outerProfileScan
  'binContour',  // binaryContourCount
  'clahePeak',   // clahePeakCounting
];

// ──────────────────────────────────────────────────────────────────────────
// Measure
// ──────────────────────────────────────────────────────────────────────────

function measure() {
  const gc = require('../src/algorithm/gearCounter');
  const { __test, countTeethFromRgba } = gc;
  const {
    rgbaToGray, clahe, gaussianBlur5x5, cannyEdges,
    findGearCenter, findGearRadius, fftAtOuterRadii, multiRadiusFftScan,
    outerProfileScan, binaryContourCount, clahePeakCounting,
  } = __test;

  let labeled = runner.discoverLabeled();
  // STRIDE=n keeps every nth photo — a deterministic sub-corpus for smoke
  // runs. Default 1 (full corpus); before/after must use the same value.
  const stride = Number(process.env.STRIDE || 1);
  if (stride > 1) labeled = labeled.filter((_, i) => i % stride === 0);
  out(`\n[pap1639] MODE=measure LABEL=${LABEL} — ${labeled.length} labeled photos, STRIDE=${stride}, REPEATS=${REPEATS}`);

  const rows = [];
  const t0 = Date.now();
  for (let i = 0; i < labeled.length; i++) {
    const { photo, actual, stamp } = labeled[i];

    // The RGBA cache makes decode ~free on a warm run, which is what we want:
    // JPEG decode is expo-image-manipulator's job on device, not ours, and it
    // is not the stage under optimization here.
    const tLoad0 = Date.now();
    const { rgba, w, h } = runner.loadOrDecodeRgba(photo, stamp);
    const loadMs = Date.now() - tLoad0;

    const t = {};
    let best = null;
    for (let rep = 0; rep < REPEATS; rep++) {
      const m = {};
      const a = Date.now(); const gray = rgbaToGray(rgba, w, h);
      const b = Date.now(); const enhanced = clahe(gray, w, h, 3.0, 8, 8);
      const c = Date.now(); const blurred = gaussianBlur5x5(enhanced, w, h);
      const d = Date.now(); const edges = cannyEdges(blurred, w, h, 50, 150);
      const e = Date.now();
      m.gray = b - a; m.clahe = c - b; m.blur = d - c; m.canny = e - d;

      // Replicate analyzeImage's stage sequence so each body can be timed.
      // The arguments mirror gearCounter.js analyzeImage() exactly; this is a
      // read-only profile, the production path is untouched.
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
      const maxRop = Math.min(cx, w - cx, cy, h - cy) - 1;
      outerProfileScan(edges, cx, cy, maxRop, w, h, gearR);
      const s5 = Date.now();
      binaryContourCount(gray, cx, cy, w, h);
      const s6 = Date.now();
      clahePeakCounting(enhanced, cx, cy, gearR, w, h);
      const s7 = Date.now();

      m.center = s1 - s0; m.edgeRadius = s2 - s1; m.fft90 = s3 - s2;
      m.multiR = s4 - s3; m.outerProf = s5 - s4; m.binContour = s6 - s5;
      m.clahePeak = s7 - s6;
      m.detect = s7 - s0;

      // Keep the fastest repeat: on a shared host a slow repeat is noise from
      // another tenant, not a property of the code.
      if (best === null || m.detect + m.gray + m.clahe + m.blur + m.canny < best) {
        best = m.detect + m.gray + m.clahe + m.blur + m.canny;
        Object.assign(t, m);
      }
    }

    // Full production entry point: gives the real total (incl. any retry) and
    // the outputs that must stay identical.
    const tFull0 = Date.now();
    let r;
    try { r = countTeethFromRgba(rgba, w, h); }
    catch (err) { r = { toothCount: 0, confidence: 0, error: err.message }; }
    const fullMs = Date.now() - tFull0;

    t.retry = Math.max(0, fullMs - (t.gray + t.clahe + t.blur + t.canny + t.detect));
    t.load = loadMs;
    t.total = fullMs;

    rows.push({
      stamp, actual, w, h,
      t,
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
      },
    });

    if ((i + 1) % 50 === 0) {
      out(`  [${i + 1}/${labeled.length}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }

  const elapsedMs = Date.now() - t0;
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(snapPath(LABEL), JSON.stringify({ label: LABEL, elapsedMs, rows }));
  report(LABEL, rows, elapsedMs);
  out(`\n[pap1639] snapshot -> ${snapPath(LABEL)}`);
  return rows;
}

function statsFor(rows, key) {
  const v = rows.map((r) => r.t[key] || 0).sort((a, b) => a - b);
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    p50: quantile(v, 0.5),
    p95: quantile(v, 0.95),
    max: v[v.length - 1] || 0,
    mean: v.length ? sum / v.length : 0,
    sum,
  };
}

function report(label, rows, elapsedMs) {
  const totalSum = rows.reduce((a, r) => a + (r.t.total || 0), 0);
  out(`\n=== PAP-1639 stage profile [${label}] ===`);
  out(`Corpus: ${rows.length} photos   Wall: ${(elapsedMs / 1000).toFixed(1)}s   Σtotal: ${(totalSum / 1000).toFixed(1)}s`);
  out('');
  out('stage          p50    p95    max    mean    share');
  const emit = (name, indent) => {
    const s = statsFor(rows, name);
    out(
      `${(indent + name).padEnd(13)} ${String(s.p50).padStart(5)}  ${String(s.p95).padStart(5)}  ` +
      `${String(s.max).padStart(5)}  ${s.mean.toFixed(1).padStart(6)}  ` +
      `${totalSum ? ((100 * s.sum) / totalSum).toFixed(1).padStart(5) + '%' : '   -  '}`,
    );
  };
  for (const k of COARSE) {
    emit(k, '');
    if (k === 'detect') for (const sub of DETECT_SUB) emit(sub, '  ');
  }
  out('-------------------------------------------------');
  emit('total', '');
}

// ──────────────────────────────────────────────────────────────────────────
// Diff
// ──────────────────────────────────────────────────────────────────────────

function diff() {
  const before = JSON.parse(fs.readFileSync(snapPath(process.env.BEFORE), 'utf8'));
  const after = JSON.parse(fs.readFileSync(snapPath(process.env.AFTER), 'utf8'));
  const bMap = new Map(before.rows.map((r) => [r.stamp, r]));

  const paired = [];
  for (const a of after.rows) {
    const b = bMap.get(a.stamp);
    if (b) paired.push({ b, a });
  }
  out(`\n=== PAP-1639 before/after [${before.label} -> ${after.label}] ===`);
  out(`Paired ${paired.length} photos (before=${before.rows.length}, after=${after.rows.length})`);

  out('\nstage           p50 before -> after      p95 before -> after      Σ before -> after');
  const keys = [];
  for (const k of COARSE) { keys.push(k); if (k === 'detect') keys.push(...DETECT_SUB); }
  keys.push('total');
  for (const k of keys) {
    const sb = statsFor(paired.map((p) => p.b), k);
    const sa = statsFor(paired.map((p) => p.a), k);
    const d = (x, y) => {
      const pctv = x ? ((y - x) / x) * 100 : 0;
      return `${String(x).padStart(5)} -> ${String(y).padStart(5)} (${pctv >= 0 ? '+' : ''}${pctv.toFixed(1)}%)`;
    };
    const ds = (x, y) => {
      const pctv = x ? ((y - x) / x) * 100 : 0;
      return `${(x / 1000).toFixed(1)}s -> ${(y / 1000).toFixed(1)}s (${pctv >= 0 ? '+' : ''}${pctv.toFixed(1)}%)`;
    };
    const indent = DETECT_SUB.includes(k) ? '  ' : '';
    out(`${(indent + k).padEnd(14)} ${d(sb.p50, sa.p50).padEnd(24)} ${d(sb.p95, sa.p95).padEnd(24)} ${ds(sb.sum, sa.sum)}`);
  }

  // Output identity — the accuracy gate for a pure-perf change.
  const OUT_KEYS = ['tc', 'conf', 'method', 'gearR', 'peakTc', 'fft90', 'op', 'bcTc', 'peakR', 'rOuter'];
  const divergent = [];
  for (const { b, a } of paired) {
    const changed = OUT_KEYS.filter((k) => b.o[k] !== a.o[k]);
    if (changed.length) divergent.push({ stamp: b.stamp, actual: b.actual, changed, b: b.o, a: a.o });
  }
  out(`\nOutput identity: ${paired.length - divergent.length}/${paired.length} photos byte-identical on [${OUT_KEYS.join(',')}]`);
  if (divergent.length) {
    out(`DIVERGENT (${divergent.length}):`);
    for (const d of divergent.slice(0, 60)) {
      out(`  ${d.stamp} actual=${d.actual} changed=[${d.changed.join(',')}]`);
      for (const k of d.changed) out(`      ${k}: ${d.b[k]} -> ${d.a[k]}`);
    }
    if (divergent.length > 60) out(`  ... ${divergent.length - 60} more`);
  }

  // Accuracy tally either way, so the report stands alone even if outputs move.
  const tally = (side) => {
    let correct = 0, abstain = 0, cw = 0;
    for (const p of paired) {
      const r = p[side];
      const bucket = runner.bucketOf(p.b.actual);
      const tol = bucket ? bucket.tol : 1;
      const ab = r.o.conf === 0 || r.o.tc === 0;
      if (ab) abstain++;
      else if (Math.abs(r.o.tc - p.b.actual) <= tol) correct++;
      else cw++;
    }
    return { correct, abstain, cw };
  };
  const tb = tally('b'), ta = tally('a');
  out(`\nAccuracy (PAP-760 buckets, ${paired.length} photos)`);
  out(`  before: correct=${tb.correct} (${((100 * tb.correct) / paired.length).toFixed(1)}%)  abstain=${tb.abstain}  conf-wrong=${tb.cw}`);
  out(`  after : correct=${ta.correct} (${((100 * ta.correct) / paired.length).toFixed(1)}%)  abstain=${ta.abstain}  conf-wrong=${ta.cw}`);
}

describe('PAP-1639 frame-pipeline profile', () => {
  jest.setTimeout(180 * 60 * 1000);

  test(`MODE=${MODE}`, () => {
    if (MODE === 'diff') { diff(); return; }
    const rows = measure();
    expect(rows.length).toBeGreaterThan(0);
  });
});
