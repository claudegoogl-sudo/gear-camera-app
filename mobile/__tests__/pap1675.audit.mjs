/**
 * PAP-1675 — full-corpus re-audit at a named SHA, plain node, resumable.
 *
 * Why not jest: two earlier whole-corpus attempts under jest were SIGTERM'd at
 * heartbeat teardown and lost everything (52-byte and 146-byte logs). jest is
 * also ~6x slower here (PAP-1672: babel-jest, not host contention), so the same
 * 362 photos cost ~48min under jest vs ~11min under plain node.
 *
 * Equivalence to the jest harness is not assumed, it is demonstrated: the
 * PAP-1693 dim=900 plain-node sweep reproduced the PAP-1674 jest audit exactly
 * — 210/362, abstain 126, conf-wrong 26, and all four bucket rows identical.
 * Scoring below matches harness-runner.js#evalPhoto (PAP-760 buckets,
 * abstain-on-conf0/tc0/innerContourSuspected, per-bucket tolerance).
 *
 * Resumability: every photo is appended to a JSONL checkpoint as it completes,
 * so a killed run resumes where it stopped. Progress is monotone across any
 * number of kills. CHUNK caps photos per invocation so each call finishes well
 * inside a single heartbeat.
 *
 * Usage:
 *   node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *     mobile/__tests__/pap1675.audit.mjs [CHUNK]
 *   node ... mobile/__tests__/pap1675.audit.mjs report
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
const CKPT = process.env.PAP1675_CKPT || '/tmp/pap1675_rows.jsonl';
// Production resolution. dim=900 is the value that reproduces the PAP-1658
// baseline; PAP-1666/PAP-1693 showed 700 collapses to 0% and 500 costs -11pp.
const DIM = 900;

console.log = () => {}; console.warn = () => {};
console.info = () => {}; console.debug = () => {};

const gc = await import('../src/algorithm/gearCounter.js');
const { countTeethFromRgba, bilinearDownsampleRgba } = gc;
const out = (s) => process.stdout.write(s + '\n');

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
  labeled.sort((a, b) => (a.stamp < b.stamp ? -1 : 1));
  return labeled;
}

function loadRgba(photo, stamp) {
  const bin = path.join(CACHE_DIR, `${stamp}_${DIM}.bin`);
  const metaP = path.join(CACHE_DIR, `${stamp}_${DIM}.meta.json`);
  const srcMtimeMs = fs.statSync(photo).mtimeMs;
  if (fs.existsSync(metaP) && fs.existsSync(bin)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaP, 'utf8'));
      if (m.sourceMtimeMs === srcMtimeMs && m.targetMaxDim === DIM) {
        const buf = fs.readFileSync(bin);
        const rgba = new Uint8Array(buf.byteLength);
        rgba.set(buf);
        return { rgba, w: m.width, h: m.height };
      }
    } catch { /* fall through to decode */ }
  }
  const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, DIM);
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(`${bin}.tmp`, Buffer.from(ds.rgba.buffer, ds.rgba.byteOffset, ds.rgba.byteLength));
    fs.renameSync(`${bin}.tmp`, bin);
    fs.writeFileSync(`${metaP}.tmp`, JSON.stringify({
      stamp, width: ds.width, height: ds.height, targetMaxDim: DIM, sourceMtimeMs: srcMtimeMs,
    }));
    fs.renameSync(`${metaP}.tmp`, metaP);
  } catch { /* cache failures are non-fatal */ }
  return { rgba: ds.rgba, w: ds.width, h: ds.height };
}

const BUCKETS = [
  { lo: 9, hi: 15, tol: 0, name: 'Small  9-15T ' },
  { lo: 16, hi: 20, tol: 0, name: 'Mid    16-20T' },
  { lo: 21, hi: 28, tol: 1, name: 'Large  21-28T' },
  { lo: 29, hi: 60, tol: 1, name: 'XL     29-60T' },
];
const bucketOf = (a) => BUCKETS.find((b) => a >= b.lo && a <= b.hi) || null;
const q = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);

function scoreRow({ actual, r, runtime, stamp }) {
  const tc = r.toothCount || 0;
  const conf = r.confidence || 0;
  const abstain = conf === 0 || tc === 0 || !!r.innerContourSuspected;
  const offBy = Math.abs(tc - actual);
  const b = bucketOf(actual);
  const correct = !abstain && offBy <= (b ? b.tol : 1);
  return {
    stamp, actual, tc, conf, runtime, abstain, correct,
    confidentWrong: !abstain && !correct, offBy,
    bucket: b ? b.name : 'OUT',
    budgetExhausted: !!r.budgetExhausted,
    method: r.method || '',
  };
}

function readCkpt() {
  const rows = [];
  if (!fs.existsSync(CKPT)) return rows;
  for (const line of fs.readFileSync(CKPT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn tail line */ }
  }
  return rows;
}

function run(chunk) {
  const labeled = discoverLabeled();
  const done = new Set(readCkpt().map((r) => r.stamp));
  const todo = labeled.filter((p) => !done.has(p.stamp)).slice(0, chunk);
  out(`[pap1675] corpus=${labeled.length} done=${done.size} this-chunk=${todo.length}`);
  const t0 = Date.now();
  for (let i = 0; i < todo.length; i++) {
    const { photo, actual, stamp } = todo[i];
    const { rgba, w, h } = loadRgba(photo, stamp);
    const f0 = Date.now();
    let r;
    try { r = countTeethFromRgba(rgba, w, h); }
    catch (err) { r = { toothCount: 0, confidence: 0, error: err.message }; }
    const row = scoreRow({ actual, r, runtime: Date.now() - f0, stamp });
    // Append-per-photo: a SIGTERM mid-chunk loses at most the photo in flight.
    fs.appendFileSync(CKPT, JSON.stringify(row) + '\n');
    if ((i + 1) % 25 === 0) {
      out(`  [${done.size + i + 1}/${labeled.length}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
  const remaining = labeled.length - done.size - todo.length;
  out(`[pap1675] chunk done in ${((Date.now() - t0) / 1000).toFixed(0)}s; remaining=${remaining}`);
  return remaining;
}

function report(sha) {
  const rows = readCkpt();
  const total = rows.length;
  const correct = rows.filter((r) => r.correct).length;
  const abstain = rows.filter((r) => r.abstain).length;
  const cw = rows.filter((r) => r.confidentWrong).length;
  const rt = rows.map((r) => r.runtime).sort((a, b) => a - b);
  out(`\n=== PAP-1675 full-corpus re-audit @ ${sha} ===`);
  out(`Corpus: ${total} photos   runner: plain node (dim=${DIM})`);
  out(`\nBucket          Tol   N    Correct  Acc%    Abstain  Conf-Wrong   med  p95  max  (ms)`);
  for (const bk of BUCKETS) {
    const br = rows.filter((r) => r.bucket === bk.name);
    if (!br.length) continue;
    const brt = br.map((r) => r.runtime).sort((a, b) => a - b);
    const tol = bk.tol === 0 ? 'exact' : `±${bk.tol}   `;
    out(`${bk.name}  ${tol}  ${String(br.length).padStart(3)}  ${String(br.filter(r=>r.correct).length).padStart(7)}  ${((100*br.filter(r=>r.correct).length)/br.length).toFixed(1).padStart(5)}%  ${String(br.filter(r=>r.abstain).length).padStart(7)}  ${String(br.filter(r=>r.confidentWrong).length).padStart(10)}   ${String(q(brt,0.5)).padStart(4)} ${String(q(brt,0.95)).padStart(4)} ${String(brt[brt.length-1]).padStart(4)}`);
  }
  out('-'.repeat(85));
  out(`TOTAL                ${String(total).padStart(3)}  ${String(correct).padStart(7)}  ${((100*correct)/total).toFixed(1).padStart(5)}%  ${String(abstain).padStart(7)}  ${String(cw).padStart(10)}   ${String(q(rt,0.5)).padStart(4)} ${String(q(rt,0.95)).padStart(4)} ${String(rt[rt.length-1]).padStart(4)}`);

  out('\nPer-actual breakdown:');
  out('actual   N   correct  abstain  conf-wrong  acc%');
  const actuals = [...new Set(rows.map((r) => r.actual))].sort((a, b) => a - b);
  for (const a of actuals) {
    const ar = rows.filter((r) => r.actual === a);
    const ac = ar.filter((r) => r.correct).length;
    out(`  ${String(a).padStart(2)}T  ${String(ar.length).padStart(4)}  ${String(ac).padStart(8)}  ${String(ar.filter(r=>r.abstain).length).padStart(7)}  ${String(ar.filter(r=>r.confidentWrong).length).padStart(10)}  ${((100*ac)/ar.length).toFixed(1).padStart(5)}%`);
  }

  // AC4: the PAP-1659 gate is only observable through budgetExhausted.
  const hits = rows.filter((r) => r.budgetExhausted);
  out(`\n[AC4] PAP-1659 budgetExhausted fires: ${hits.length}/${total}`);
  out(`[AC4] abstain=${abstain} (${((100*abstain)/total).toFixed(1)}%)  confident-wrong=${cw} (${((100*cw)/total).toFixed(1)}%)`);
  out(`[AC4] slowest photo: ${rt[rt.length-1]}ms vs WALL_CLOCK_BUDGET_MS=45000 — headroom ${(45000/(rt[rt.length-1]||1)).toFixed(1)}x`);
  if (hits.length) for (const h of hits) out(`   HIT ${h.stamp} actual=${h.actual} tc=${h.tc} ${h.runtime}ms`);

  const csv = ['stamp,actual,bucket,tc,conf,correct,abstain,confidentWrong,offBy,budgetExhausted,runtime,method'];
  for (const r of rows) {
    csv.push([r.stamp, r.actual, r.bucket.trim(), r.tc, r.conf.toFixed(3),
      r.correct?1:0, r.abstain?1:0, r.confidentWrong?1:0, r.offBy,
      r.budgetExhausted?1:0, r.runtime, r.method].join(','));
  }
  const csvPath = path.join(DEBUG_DIR, `pap1675_rows_${sha}.csv`);
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(csvPath, csv.join('\n'));
  out(`\nrow-level csv: ${csvPath} (${rows.length} rows)`);
}

const arg = process.argv[2] || '100';
if (arg === 'report') report(process.argv[3] || 'HEAD');
else run(Number(arg));
