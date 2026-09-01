/**
 * PAP-1693 (PAP-758 target 3, option 4) — TARGET_MAX_DIM accuracy/speed
 * sweep, full corpus, plain node (per project_profiling_never_under_jest.md:
 * babel-jest inflates the typed-array loops in gearCounter ~400x and would
 * mis-rank the speed side of this tradeoff).
 *
 * Same timing boundary as pap1672.speed.mjs (the "defensible host number"
 * boundary written into PRODUCT_TARGETS.md): RGBA-in-hand -> a single
 * countTeethFromRgba() call -> count-or-abstain. JPEG decode + downsample is
 * cached and excluded from the timed region, matching desktop and device
 * (device never re-decodes at multiple resolutions).
 *
 * Accuracy scoring matches mobile/__tests__/lib/harness-runner.js#evalPhoto
 * exactly (PAP-760 buckets, abstain-on-conf0/tc0/innerContourSuspected, same
 * per-bucket tolerance) so the RESDIM=900 row is comparable to the PAP-1658
 * baseline (58.0%, 210/362 @ 49a7498) without re-deriving scoring rules.
 *
 * Usage:
 *   node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *     mobile/__tests__/pap1693.resdim.mjs <RESDIM> [label]
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

// Algorithm modules log heavily per photo; silence before importing so a
// 362-photo sweep doesn't drown the summary (matches harness-runner's
// silenceConsole()). Final reports go through out()/process.stdout directly.
console.log = () => {};
console.warn = () => {};
console.info = () => {};
console.debug = () => {};

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

function loadRgba(photo, stamp, dim) {
  const bin = path.join(CACHE_DIR, `${stamp}_${dim}.bin`);
  const metaP = path.join(CACHE_DIR, `${stamp}_${dim}.meta.json`);
  const srcMtimeMs = fs.statSync(photo).mtimeMs;
  if (fs.existsSync(metaP) && fs.existsSync(bin)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaP, 'utf8'));
      if (m.sourceMtimeMs === srcMtimeMs && m.targetMaxDim === dim) {
        const buf = fs.readFileSync(bin);
        const rgba = new Uint8Array(buf.byteLength);
        rgba.set(buf);
        return { rgba, w: m.width, h: m.height };
      }
    } catch { /* fall through */ }
  }
  const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, dim);
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(`${bin}.tmp`, Buffer.from(ds.rgba.buffer, ds.rgba.byteOffset, ds.rgba.byteLength));
    fs.renameSync(`${bin}.tmp`, bin);
    fs.writeFileSync(`${metaP}.tmp`, JSON.stringify({
      stamp, width: ds.width, height: ds.height, targetMaxDim: dim, sourceMtimeMs: srcMtimeMs,
    }));
    fs.renameSync(`${metaP}.tmp`, metaP);
  } catch { /* cache failures are non-fatal */ }
  return { rgba: ds.rgba, w: ds.width, h: ds.height };
}

// PAP-760 buckets, identical to harness-runner.js.
const PAP760_BUCKETS = [
  { lo: 9, hi: 15, tol: 0, name: 'Small  9-15T ' },
  { lo: 16, hi: 20, tol: 0, name: 'Mid    16-20T' },
  { lo: 21, hi: 28, tol: 1, name: 'Large  21-28T' },
  { lo: 29, hi: 60, tol: 1, name: 'XL     29-60T' },
];
const bucketOf = (a) => PAP760_BUCKETS.find((b) => a >= b.lo && a <= b.hi) || null;

const quantile = (sorted, q) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;

function scoreRow({ actual, r, runtime, stamp, w, h }) {
  const tc = r.toothCount || 0;
  const conf = r.confidence || 0;
  const innerSus = !!r.innerContourSuspected;
  const abstain = conf === 0 || tc === 0 || innerSus;
  const offBy = Math.abs(tc - actual);
  const b = bucketOf(actual);
  const tol = b ? b.tol : 1;
  const correct = !abstain && offBy <= tol;
  const confidentWrong = !abstain && !correct;
  return { stamp, actual, w, h, tc, conf, runtime, abstain, correct, confidentWrong, offBy, bucket: b ? b.name : 'OUT' };
}

function measure(dim, label) {
  const labeled = discoverLabeled();
  out(`[pap1693-resdim] dim=${dim} label=${label} corpus=${labeled.length}`);

  const rows = [];
  const t0 = Date.now();
  for (let i = 0; i < labeled.length; i++) {
    const { photo, actual, stamp } = labeled[i];
    const { rgba, w, h } = loadRgba(photo, stamp, dim);
    const f0 = Date.now();
    let r;
    try { r = countTeethFromRgba(rgba, w, h); }
    catch (err) { r = { toothCount: 0, confidence: 0, error: err.message }; }
    const runtime = Date.now() - f0;
    rows.push(scoreRow({ actual, r, runtime, stamp, w, h }));
    if ((i + 1) % 50 === 0) out(`  [${i + 1}/${labeled.length}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  const elapsedMs = Date.now() - t0;

  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const snapPath = path.join(DEBUG_DIR, `pap1693_resdim_${dim}_${label}.json`);
  fs.writeFileSync(snapPath, JSON.stringify({ dim, label, elapsedMs, env: 'node', rows }));

  report(dim, rows, elapsedMs);
  out(`\n[pap1693-resdim] snapshot -> ${snapPath}`);
}

function report(dim, rows, elapsedMs) {
  const total = rows.length;
  const correct = rows.filter((r) => r.correct).length;
  const abstain = rows.filter((r) => r.abstain).length;
  const cw = rows.filter((r) => r.confidentWrong).length;
  const rt = rows.map((r) => r.runtime).sort((a, b) => a - b);
  out(`\n=== PAP-1693 RESDIM=${dim} summary ===`);
  out(`Corpus: ${total} photos   Wall: ${(elapsedMs / 1000).toFixed(1)}s`);
  out(`accuracy: ${correct}/${total} = ${((100 * correct) / total).toFixed(1)}%   abstain: ${abstain} (${((100 * abstain) / total).toFixed(1)}%)   confident-wrong: ${cw} (${((100 * cw) / total).toFixed(1)}%)`);
  out(`countTeethFromRgba runtime: p50=${quantile(rt, 0.5)}  p95=${quantile(rt, 0.95)}  max=${rt[rt.length - 1] || 0}  sum=${rt.reduce((a, b) => a + b, 0)}`);
  out('\nPer-bucket:');
  out('Bucket          Tol   N    Correct  Acc%    Abstain  Conf-Wrong   med(ms)');
  for (const bk of PAP760_BUCKETS) {
    const br = rows.filter((r) => r.bucket === bk.name);
    if (!br.length) continue;
    const bc = br.filter((r) => r.correct).length;
    const ba = br.filter((r) => r.abstain).length;
    const bcw = br.filter((r) => r.confidentWrong).length;
    const brt = br.map((r) => r.runtime).sort((a, b) => a - b);
    const tol = bk.tol === 0 ? 'exact' : `±${bk.tol}   `;
    out(`${bk.name}  ${tol}  ${String(br.length).padStart(3)}  ${String(bc).padStart(7)}  ${((100 * bc) / br.length).toFixed(1).padStart(5)}%  ${String(ba).padStart(7)}  ${String(bcw).padStart(10)}   ${String(quantile(brt, 0.5)).padStart(5)}`);
  }
}

const [dimArg, labelArg] = process.argv.slice(2);
if (!dimArg) { out('usage: pap1693.resdim.mjs <RESDIM> [label]'); process.exit(1); }
measure(Number(dimArg), labelArg || 'run');
