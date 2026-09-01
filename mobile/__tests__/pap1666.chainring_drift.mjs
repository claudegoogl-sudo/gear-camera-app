/**
 * PAP-1666 Option A verification: chainring-bucket-sliced accuracy +
 * pixel-drift report, per QA cross-check PAP-1676's sharpened bar (plain
 * aggregate byte/bucket diff is not sufficient — slice by chainring regime
 * and report raw centroid-shift-in-pixels, not just whether tc changed).
 *
 * Usage:
 *   node mobile/__tests__/pap1666.chainring_drift.mjs <before-label> <after-label>
 *
 * Reads debug-reports/pap1639_<label>.json snapshots (written by
 * pap1639.profile.mjs measure), which must include the `cx`/`cy` output
 * fields (PAP-1666 addition to OUT_KEYS).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DEBUG_DIR = path.join(ROOT, 'debug-reports');
const snapPath = (label) => path.join(DEBUG_DIR, `pap1639_${label}.json`);

const [beforeLabel, afterLabel] = process.argv.slice(2);
if (!beforeLabel || !afterLabel) {
  console.error('Usage: node pap1666.chainring_drift.mjs <before-label> <after-label>');
  process.exit(1);
}

const before = JSON.parse(fs.readFileSync(snapPath(beforeLabel), 'utf8'));
const after = JSON.parse(fs.readFileSync(snapPath(afterLabel), 'utf8'));
const bMap = new Map(before.rows.map((r) => [r.stamp, r]));

const PAP760_BUCKETS = [
  { lo: 9, hi: 15, tol: 0, name: 'Small  9-15T ' },
  { lo: 16, hi: 20, tol: 0, name: 'Mid    16-20T' },
  { lo: 21, hi: 28, tol: 1, name: 'Large  21-28T' },
  { lo: 29, hi: 60, tol: 1, name: 'XL     29-60T' },
];
const bucketOf = (a) => PAP760_BUCKETS.find((b) => a >= b.lo && a <= b.hi) || null;

// chainringRegime mirrors gearCounter.js's own definition (line ~3421):
// any of the count-method estimates landing at/above 30T.
const isChainring = (o) =>
  (o.peakTc || 0) >= 30 || (o.fft90 || 0) >= 30 || (o.op || 0) >= 30 || (o.bcTc || 0) >= 30;

const paired = [];
for (const a of after.rows) {
  const b = bMap.get(a.stamp);
  if (b) paired.push({ b, a });
}

console.log(`Paired ${paired.length} photos (before=${before.rows.length}, after=${after.rows.length})`);

function accuracyReport(rows, label) {
  let correct = 0, abstain = 0, cw = 0;
  const perBucket = new Map();
  for (const { b, a } of rows) {
    const bk = bucketOf(b.actual);
    if (!bk) continue;
    const rec = perBucket.get(bk.name) || { n: 0, correct: 0, abstain: 0, cw: 0 };
    rec.n++;
    const o = a.o;
    if (o.conf === 0 || o.tc === 0) { rec.abstain++; abstain++; }
    else if (Math.abs(o.tc - b.actual) <= bk.tol) { rec.correct++; correct++; }
    else { rec.cw++; cw++; }
    perBucket.set(bk.name, rec);
  }
  const n = rows.length;
  console.log(`\n[${label}] N=${n}  correct=${correct} (${n ? (100 * correct / n).toFixed(1) : '0.0'}%)  abstain=${abstain}  conf-wrong=${cw}`);
  for (const bk of PAP760_BUCKETS) {
    const rec = perBucket.get(bk.name);
    if (!rec) continue;
    console.log(`  ${bk.name}  N=${String(rec.n).padStart(3)}  correct=${rec.correct} (${(100 * rec.correct / rec.n).toFixed(1)}%)  abstain=${rec.abstain}  cw=${rec.cw}`);
  }
}

// ── Full corpus accuracy, before vs after (sanity — mirrors profile diff) ──
accuracyReport(paired.map((p) => ({ b: { actual: p.b.actual }, a: p.b })), 'BEFORE (full corpus)');
accuracyReport(paired.map((p) => ({ b: { actual: p.b.actual }, a: p.a })), 'AFTER  (full corpus)');

// ── Chainring-regime slice (before OR after flags it as chainring-regime,
//    so a photo that only becomes/stops being chainring-regime after the
//    change is still captured in the slice) ──────────────────────────────
const chainringRows = paired.filter(({ b, a }) => isChainring(b.o) || isChainring(a.o));
console.log(`\n=== Chainring-regime slice: ${chainringRows.length}/${paired.length} photos ===`);
accuracyReport(chainringRows.map((p) => ({ b: { actual: p.b.actual }, a: p.b })), 'BEFORE (chainring-regime)');
accuracyReport(chainringRows.map((p) => ({ b: { actual: p.b.actual }, a: p.a })), 'AFTER  (chainring-regime)');

// ── XL bucket slice (29-60T actual label — the other proxy for "large-in-
//    frame chainring images" QA asked to slice by) ───────────────────────
const xlRows = paired.filter(({ b }) => b.actual >= 29 && b.actual <= 60);
console.log(`\n=== XL-bucket slice: ${xlRows.length}/${paired.length} photos ===`);
accuracyReport(xlRows.map((p) => ({ b: { actual: p.b.actual }, a: p.b })), 'BEFORE (XL bucket)');
accuracyReport(xlRows.map((p) => ({ b: { actual: p.b.actual }, a: p.a })), 'AFTER  (XL bucket)');

// ── Pixel-drift on the chainring-regime slice ─────────────────────────────
function drift(rows, label) {
  const deltas = rows
    .filter(({ b, a }) => b.o.cx && b.o.cy && a.o.cx && a.o.cy) // both located a center
    .map(({ b, a }) => Math.hypot(a.o.cx - b.o.cx, a.o.cy - b.o.cy));
  deltas.sort((x, y) => x - y);
  const n = deltas.length;
  const mean = n ? deltas.reduce((s, d) => s + d, 0) / n : 0;
  const p50 = n ? deltas[Math.floor(0.5 * n)] : 0;
  const p95 = n ? deltas[Math.min(n - 1, Math.floor(0.95 * n))] : 0;
  const max = n ? deltas[n - 1] : 0;
  const zero = deltas.filter((d) => d === 0).length;
  console.log(`\n[${label}] centroid drift (px), N=${n}: mean=${mean.toFixed(2)}  p50=${p50.toFixed(2)}  p95=${p95.toFixed(2)}  max=${max.toFixed(2)}  exact-match=${zero}/${n}`);
  // Flag the worst offenders for manual eyeballing.
  const withDelta = rows
    .filter(({ b, a }) => b.o.cx && b.o.cy && a.o.cx && a.o.cy)
    .map(({ b, a }) => ({ stamp: b.stamp, actual: b.actual, d: Math.hypot(a.o.cx - b.o.cx, a.o.cy - b.o.cy), btc: b.o.tc, atc: a.o.tc }))
    .sort((x, y) => y.d - x.d)
    .slice(0, 15);
  for (const w of withDelta) console.log(`    ${w.stamp} actual=${w.actual} drift=${w.d.toFixed(1)}px tc ${w.btc}->${w.atc}`);
}
drift(chainringRows, 'Chainring-regime');
drift(xlRows, 'XL-bucket');
drift(paired, 'Full corpus');
