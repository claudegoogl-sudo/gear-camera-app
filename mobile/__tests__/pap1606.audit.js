/**
 * PAP-1606 — Training-data harness input-pipeline audit (PAP-1599 follow-up).
 *
 * Quantifies the gap between the training-data full-photo pipeline (what every
 * PAP-758 child harness measures) and the device-equivalent cropped+mask pipeline
 * (what production actually runs).
 *
 * Pipelines:
 *   PATH-A (current full-photo / what harnesses measure):
 *     jpegDecode(3000x4000)  ->  bilinearDownsampleRgba(900)  ->  675x900
 *     no mask.  aimR = 0.5*min(w,h) = 337.5  (inside countTeethFromRgba)
 *
 *   PATH-B (device-equivalent synthetic crop+mask):
 *     jpegDecode(3000x4000)  ->  center-square-crop(3000x3000)
 *                            ->  bilinearDownsampleRgba(900)  ->  900x900
 *                            ->  applyCircularMask(cx, cy, 0.49*900)
 *     aimR = 0.5*min(w,h) = 450
 *
 * Sample: ~10 labeled photos per class (Small 9-13T / Mid 14-20T / Large 21-28T /
 * XL 29-60T) drawn deterministically by stamp order to keep the audit
 * reproducible.  N=40 total at ~25s/photo Path-A + ~25s Path-B ~= 35 min cold,
 * ~2 min warm (PAP-971 cache hits both paths since we hash by (stamp, op)).
 *
 * NOT in scope per PAP-1606:
 *   - algorithm code changes
 *   - per-signoff reversion (AC2 triage informs this)
 *   - b127 harness flip (already done under PAP-1603)
 *
 * Run:
 *   HARNESS=pap1606.audit npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');
const runner = require('./lib/harness-runner');

runner.silenceConsole();

const PER_CLASS = Number(process.env.PER_CLASS || 10);
const CSV_OUT = path.join(runner.DEBUG_DIR, 'pap1606_audit_2026-05-20.csv');

// Class definitions follow PAP-1606 description (Small/Mid/Large/XL).
// Mid here is 14-20T (the boundary class for PAP-961 aim-circle prior); the
// PAP-760 buckets put 14T in Small but PAP-1606 lists Mid as "one of 3 reps".
const CLASSES = [
  { name: 'Small',  lo:  9, hi: 13 },
  { name: 'Mid',    lo: 14, hi: 20 },
  { name: 'Large',  lo: 21, hi: 28 },
  { name: 'XL',     lo: 29, hi: 60 },
];

function centerSquareCrop(rgba, w, h) {
  const s = Math.min(w, h);
  const x0 = Math.floor((w - s) / 2);
  const y0 = Math.floor((h - s) / 2);
  const out = new Uint8Array(s * s * 4);
  for (let y = 0; y < s; y++) {
    const srcOff = ((y0 + y) * w + x0) * 4;
    out.set(rgba.subarray(srcOff, srcOff + s * 4), y * s * 4);
  }
  return { rgba: out, width: s, height: s };
}

function runPathA(photo, stamp) {
  // PATH-A: matches runner.loadOrDecodeRgba (PAP-971 cache, no mask).
  const { countTeethFromRgba } = runner.getAlgo();
  const { rgba, w, h } = runner.loadOrDecodeRgba(photo, stamp);
  const ts = Date.now();
  let r;
  try { r = countTeethFromRgba(rgba, w, h); }
  catch (e) { r = { toothCount: 0, confidence: 0, error: e.message }; }
  return { tc: r.toothCount || 0, conf: r.confidence || 0, method: r.methodUsed || '?', w, h, raw: r, ms: Date.now() - ts };
}

function runPathB(photo, stamp) {
  // PATH-B: synthetic center-square-crop -> downsample(900) -> 0.49 circular mask.
  const { countTeethFromRgba, bilinearDownsampleRgba, applyCircularMask } = runner.getAlgo();
  const buf = fs.readFileSync(photo);
  const raw = jpegDecode(buf, { useTArray: true });
  const sq = centerSquareCrop(raw.data, raw.width, raw.height);
  const ds = bilinearDownsampleRgba(sq.rgba, sq.width, sq.height, runner.TARGET_MAX_DIM);
  applyCircularMask(ds.rgba, ds.width, ds.height,
    (ds.width - 1) / 2, (ds.height - 1) / 2,
    0.49 * Math.min(ds.width, ds.height));
  const ts = Date.now();
  let r;
  try { r = countTeethFromRgba(ds.rgba, ds.width, ds.height); }
  catch (e) { r = { toothCount: 0, confidence: 0, error: e.message }; }
  return { tc: r.toothCount || 0, conf: r.confidence || 0, method: r.methodUsed || '?', w: ds.width, h: ds.height, raw: r, ms: Date.now() - ts };
}

function classifyOutcome(actual, tc, conf) {
  if (!conf || !tc) return 'ABSTAIN';
  const offBy = Math.abs(tc - actual);
  const tol = actual <= 20 ? 0 : 1;
  return offBy <= tol ? 'CORRECT' : 'CONF-WRONG';
}

function methodPredicates(method) {
  // Pull out the predicate tags PAP-758 children attach to methodUsed.
  if (!method) return [];
  const tags = [];
  // Match PAP-XXX tokens or known predicate suffixes.
  for (const tok of method.split('+')) {
    if (/^pap\d+/.test(tok)) tags.push(tok);
  }
  return tags;
}

describe('PAP-1606 training-data input-pipeline audit', () => {
  jest.setTimeout(60 * 60 * 1000);  // 1h ceiling

  test('full-photo vs device-equivalent', () => {
    const all = runner.discoverLabeled();
    // Stamp-ordered deterministic pick per class.
    const sample = [];
    for (const c of CLASSES) {
      const inClass = all.filter(r => r.actual >= c.lo && r.actual <= c.hi);
      // Stride-pick PER_CLASS rows across the corpus so we don't bunch on one day.
      const stride = Math.max(1, Math.floor(inClass.length / PER_CLASS));
      const picks = [];
      for (let i = 0; i < inClass.length && picks.length < PER_CLASS; i += stride) {
        picks.push(inClass[i]);
      }
      for (const p of picks) sample.push({ ...p, klass: c.name });
    }

    runner.out(`\n[pap1606] sampling: ${sample.length} photos (${PER_CLASS}/class across ${CLASSES.map(c=>c.name).join('/')})`);

    const rows = [];
    let methodChange = 0, tcChange = 0, confChangeBig = 0;
    let aCorrect = 0, bCorrect = 0, aAbstain = 0, bAbstain = 0, aWrong = 0, bWrong = 0;
    const predFireA = new Map();  // predicate -> count fired in PATH-A
    const predFireB = new Map();
    const predFireOnlyA = new Map(); // fired in A but not B
    const predFireOnlyB = new Map();

    const t0 = Date.now();
    for (let i = 0; i < sample.length; i++) {
      const { stamp, actual, photo, klass } = sample[i];
      const A = runPathA(photo, stamp);
      const B = runPathB(photo, stamp);
      const aOut = classifyOutcome(actual, A.tc, A.conf);
      const bOut = classifyOutcome(actual, B.tc, B.conf);
      if (aOut === 'CORRECT') aCorrect++; else if (aOut === 'ABSTAIN') aAbstain++; else aWrong++;
      if (bOut === 'CORRECT') bCorrect++; else if (bOut === 'ABSTAIN') bAbstain++; else bWrong++;
      if (A.tc !== B.tc) tcChange++;
      if (A.method !== B.method) methodChange++;
      if (Math.abs(A.conf - B.conf) > 0.05) confChangeBig++;

      const tagsA = methodPredicates(A.method);
      const tagsB = methodPredicates(B.method);
      const setA = new Set(tagsA);
      const setB = new Set(tagsB);
      for (const t of setA) predFireA.set(t, (predFireA.get(t) || 0) + 1);
      for (const t of setB) predFireB.set(t, (predFireB.get(t) || 0) + 1);
      for (const t of setA) if (!setB.has(t)) predFireOnlyA.set(t, (predFireOnlyA.get(t) || 0) + 1);
      for (const t of setB) if (!setA.has(t)) predFireOnlyB.set(t, (predFireOnlyB.get(t) || 0) + 1);

      rows.push({ stamp, klass, actual, A, B, aOut, bOut });
      if ((i + 1) % 10 === 0) {
        runner.out(`  [${i + 1}/${sample.length}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    }
    const elapsed = Date.now() - t0;

    // ── CSV dump ────────────────────────────────────────────────────────
    const fmt = (n) => (typeof n === 'number' ? n.toFixed(4) : '');
    const csv = [
      'stamp,klass,actual,A_w,A_h,A_tc,A_conf,A_method,A_outcome,A_ms,B_w,B_h,B_tc,B_conf,B_method,B_outcome,B_ms,tc_changed,method_changed,conf_delta',
    ];
    for (const r of rows) {
      csv.push([
        r.stamp, r.klass, r.actual,
        r.A.w, r.A.h, r.A.tc, fmt(r.A.conf), r.A.method, r.aOut, r.A.ms,
        r.B.w, r.B.h, r.B.tc, fmt(r.B.conf), r.B.method, r.bOut, r.B.ms,
        r.A.tc !== r.B.tc ? 1 : 0,
        r.A.method !== r.B.method ? 1 : 0,
        fmt(r.B.conf - r.A.conf),
      ].join(','));
    }
    fs.mkdirSync(runner.DEBUG_DIR, { recursive: true });
    fs.writeFileSync(CSV_OUT, csv.join('\n') + '\n');

    // ── Report ──────────────────────────────────────────────────────────
    runner.out(`\n=== PAP-1606 audit (N=${sample.length}, ${(elapsed / 1000).toFixed(1)}s) ===\n`);
    runner.out('Outcome distribution (Path-A = full-photo / current harnesses ; Path-B = device-equiv):');
    runner.out(`  Path-A:  CORRECT=${aCorrect}  ABSTAIN=${aAbstain}  CONF-WRONG=${aWrong}`);
    runner.out(`  Path-B:  CORRECT=${bCorrect}  ABSTAIN=${bAbstain}  CONF-WRONG=${bWrong}`);
    runner.out('');
    runner.out('Row-level deltas:');
    runner.out(`  tc differs:      ${tcChange}/${sample.length}`);
    runner.out(`  method differs:  ${methodChange}/${sample.length}`);
    runner.out(`  |Δ conf| > 0.05: ${confChangeBig}/${sample.length}`);
    runner.out('');

    // Per-class breakdown
    runner.out('Per-class (A_correct / B_correct / tc_changed):');
    for (const c of CLASSES) {
      const cr = rows.filter(r => r.klass === c.name);
      if (!cr.length) continue;
      const aC = cr.filter(r => r.aOut === 'CORRECT').length;
      const bC = cr.filter(r => r.bOut === 'CORRECT').length;
      const tcD = cr.filter(r => r.A.tc !== r.B.tc).length;
      runner.out(`  ${c.name.padEnd(6)} N=${String(cr.length).padStart(2)}  A=${aC}  B=${bC}  tc_chg=${tcD}`);
    }
    runner.out('');

    // Predicate-fire matrix (the AC2 evidence)
    runner.out('PAP-758 predicate-fire matrix (A=full-photo, B=device-equiv):');
    runner.out('  predicate                       A_fires  B_fires  only_A  only_B');
    const preds = new Set([...predFireA.keys(), ...predFireB.keys()]);
    const sortedPreds = [...preds].sort();
    for (const p of sortedPreds) {
      runner.out(`  ${p.padEnd(32)} ${String(predFireA.get(p) || 0).padStart(7)}  ${String(predFireB.get(p) || 0).padStart(7)}  ${String(predFireOnlyA.get(p) || 0).padStart(6)}  ${String(predFireOnlyB.get(p) || 0).padStart(6)}`);
    }

    runner.out('');
    runner.out('Triage hint (heuristic; AC2 still needs per-signoff review):');
    for (const p of sortedPreds) {
      const a = predFireA.get(p) || 0;
      const b = predFireB.get(p) || 0;
      const onlyA = predFireOnlyA.get(p) || 0;
      const onlyB = predFireOnlyB.get(p) || 0;
      let label;
      if (onlyA === 0 && onlyB === 0) label = 'HARMLESS  (identical fire-set)';
      else if (onlyA > onlyB) label = 'BENIGN    (over-tunes on training, under-fires on device)';
      else label = 'HARMFUL   (under-fires on training, fires more on device)';
      runner.out(`  ${p.padEnd(32)} A=${a} B=${b} onlyA=${onlyA} onlyB=${onlyB}  ${label}`);
    }

    runner.out(`\nCSV: ${CSV_OUT}\n`);
    expect(rows.length).toBe(sample.length);
  });
});
