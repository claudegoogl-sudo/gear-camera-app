/**
 * PAP-1731 — corpus probe for the bc-fft MIN_TEETH-floor override predicate.
 *
 * For every labeled corpus photo, runs ONE analyzeImage pass (same unmasked
 * dim=900 convention as pap1675.audit) and dumps every arbitration-relevant
 * channel value to a JSONL checkpoint so guard predicates can be evaluated
 * offline without re-running the corpus per gate variant.
 *
 * Usage:
 *   node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *     mobile/__tests__/pap1731.probe.mjs [CHUNK]
 *   CKPT=/tmp/pap1731_probe.jsonl node ... (default /tmp/pap1731_probe.jsonl)
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
const CACHE_DIR = path.join(ROOT, '.cache', 'training-rgba');
const CKPT = process.env.CKPT || '/tmp/pap1731_probe.jsonl';
const DIM = 900;

console.log = () => {}; console.warn = () => {};
console.info = () => {}; console.debug = () => {};
const out = (s) => process.stdout.write(s + '\n');

const gc = await import('../src/algorithm/gearCounter.js');
const { bilinearDownsampleRgba } = gc;
const { preprocess } = await import('../src/algorithm/preprocess.js');
const { analyzeImage } = gc.__test;

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
  if (fs.existsSync(metaP) && fs.existsSync(bin)) {
    const m = JSON.parse(fs.readFileSync(metaP, 'utf8'));
    const buf = fs.readFileSync(bin);
    const rgba = new Uint8Array(buf.byteLength);
    rgba.set(buf);
    return { rgba, w: m.width, h: m.height };
  }
  const raw = jpegDecode(fs.readFileSync(photo));
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, DIM);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(bin, Buffer.from(ds.rgba.buffer, ds.rgba.byteOffset, ds.rgba.byteLength));
  fs.writeFileSync(metaP, JSON.stringify({ stamp, width: ds.width, height: ds.height, targetMaxDim: DIM }));
  return { rgba: ds.rgba, w: ds.width, h: ds.height };
}

function readCkpt() {
  if (!fs.existsSync(CKPT)) return [];
  const rows = [];
  for (const line of fs.readFileSync(CKPT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn tail */ }
  }
  return rows;
}

const chunk = Number(process.argv[2] || 400);
const labeled = discoverLabeled();
const done = new Set(readCkpt().map((r) => r.stamp));
const todo = labeled.filter((p) => !done.has(p.stamp)).slice(0, chunk);
out(`[pap1731.probe] corpus=${labeled.length} done=${done.size} this-chunk=${todo.length}`);
const t0 = Date.now();
for (let i = 0; i < todo.length; i++) {
  const { photo, actual, stamp } = todo[i];
  const { rgba, w, h } = loadRgba(photo, stamp);
  let a;
  try {
    const pre = preprocess(rgba, w, h);
    a = analyzeImage(pre.gray, pre.enhanced, pre.edges, w, h, 0.5 * Math.min(w, h),
      Date.now() + 45000, { hit: false });
  } catch (err) {
    fs.appendFileSync(CKPT, JSON.stringify({ stamp, actual, error: err.message }) + '\n');
    continue;
  }
  fs.appendFileSync(CKPT, JSON.stringify({
    stamp, actual,
    tc: a.toothCount, conf: a.confidence, method: a.methodUsed,
    peakTc: a.peakTc, peakRel: a.peakRel, peakR: a.peakR,
    fft90tc: a.fft90tc, opTc: a.opTc, opRel: a.opRel,
    bcTc: a.bcTc, bcPurity: a.bcPurity, bcPeaks: a.bcPeaks,
    claheTc: a.claheTc, claheConf: a.claheConf,
    contourRadius: a.contourRadius, gearR: a.gearR,
    cx: a.cx, cy: a.cy, w, h,
  }) + '\n');
  if ((i + 1) % 25 === 0) {
    out(`  [${done.size + i + 1}/${labeled.length}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
out(`[pap1731.probe] done in ${((Date.now() - t0) / 1000).toFixed(0)}s; remaining=${labeled.length - done.size - todo.length}`);
