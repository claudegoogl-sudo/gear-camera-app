/**
 * PAP-1672 AC1/AC2 — host speed reconciliation, plain-node side.
 *
 * Same measurement boundary as pap1672.speed.js (jest side): decode/cache
 * happens before the timer starts, one call to countTeethFromRgba(), timer
 * stops on return. Unlike pap1639.profile.mjs this does NOT re-run the
 * internal stage bodies a second time for instrumentation — a single real
 * call, not doubled work. countTeethFromRgba() does not expose stageMs
 * (that field only exists on the device-path countTeeth()), so this reads
 * budgetExhausted (PAP-1659) off the return value and reports total wall
 * time only.
 *
 * Usage:
 *   node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *     mobile/__tests__/pap1672.speed.mjs <label> [stride]
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

const snapPath = (label) => path.join(DEBUG_DIR, `pap1672_speed_node_${label}.json`);

function measure(label, stride) {
  let labeled = discoverLabeled();
  if (stride > 1) labeled = labeled.filter((_, i) => i % stride === 0);
  out(`[pap1672-node] measure label=${label} photos=${labeled.length} stride=${stride}`);

  const rows = [];
  const t0 = Date.now();
  for (let i = 0; i < labeled.length; i++) {
    const { photo, actual, stamp } = labeled[i];
    const { rgba, w, h } = loadRgba(photo, stamp);
    const f0 = Date.now();
    let r;
    try { r = countTeethFromRgba(rgba, w, h); }
    catch (err) { r = { toothCount: 0, confidence: 0, error: err.message, budgetExhausted: false, methodUsed: 'ERROR' }; }
    const runtime = Date.now() - f0;
    rows.push({
      stamp, actual, w, h, runtime,
      budgetExhausted: !!r.budgetExhausted,
      methodUsed: r.methodUsed || '?',
      tc: r.toothCount || 0,
    });
    if ((i + 1) % 50 === 0) {
      out(`  [${i + 1}/${labeled.length}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
  const elapsedMs = Date.now() - t0;
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  fs.writeFileSync(snapPath(label), JSON.stringify({ label, elapsedMs, env: 'node', rows }));
  report(label, rows, elapsedMs);
  out(`\n[pap1672-node] snapshot -> ${snapPath(label)}`);
}

const quantile = (sorted, q) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;

function statsFor(rows, pick) {
  const v = rows.map(pick).sort((x, y) => x - y);
  const sum = v.reduce((x, y) => x + y, 0);
  return { p50: quantile(v, 0.5), p95: quantile(v, 0.95), max: v[v.length - 1] || 0, sum };
}

function report(label, rows, elapsedMs) {
  out(`\n=== PAP-1672 node-side speed [${label}] ===`);
  out(`Corpus: ${rows.length} photos   Wall: ${(elapsedMs / 1000).toFixed(1)}s`);
  const budgetHits = rows.filter((r) => r.budgetExhausted).length;
  out(`Budget-exhausted (pap1659-budget-exhausted): ${budgetHits}/${rows.length} (${((100 * budgetHits) / rows.length).toFixed(1)}%)`);
  const s = statsFor(rows, (r) => r.runtime);
  out(`total          p50=${s.p50}  p95=${s.p95}  max=${s.max}`);
  out('\nPer-bucket total runtime (matches PAP-760 buckets):');
  for (const bk of PAP760_BUCKETS) {
    const bucketRows = rows.filter((r) => bucketOf(r.actual)?.name === bk.name);
    if (!bucketRows.length) continue;
    const s = statsFor(bucketRows, (r) => r.runtime);
    const hits = bucketRows.filter((r) => r.budgetExhausted).length;
    out(`${bk.name}  N=${String(bucketRows.length).padStart(3)}  p50=${String(s.p50).padStart(5)}  p95=${String(s.p95).padStart(5)}  max=${String(s.max).padStart(5)}  budgetHit=${hits}`);
  }
}

const [label, strideArg] = process.argv.slice(2);
measure(label || 'run', Number(strideArg || 1));
