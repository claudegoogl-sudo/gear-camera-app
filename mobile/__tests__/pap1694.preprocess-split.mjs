/**
 * PAP-1694 AC3 baseline — per-primitive cost split of the `preprocess` stage.
 *
 * countTeeth's preprocess stage is exactly four calls:
 *   rgbaToGray -> clahe -> gaussianBlur5x5 -> cannyEdges
 * This measures each in isolation on the cached 900px corpus RGBA so we know
 * how much of the stage each primitive owns *before* deciding which ones are
 * worth moving to native OpenCV.
 *
 * Plain node only (never jest — babel-jest inflates typed-array loops ~400x,
 * see project_profiling_never_under_jest).
 *
 * Usage: node mobile/__tests__/pap1694.preprocess-split.mjs [stride] [reps]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'training-rgba');
const TARGET_MAX_DIM = 900;

const { rgbaToGray, clahe, gaussianBlur5x5, cannyEdges } =
  await import('../src/algorithm/imageUtils.js');

const stride = Number(process.argv[2] || 8);
const reps = Number(process.argv[3] || 1);

const stamps = fs.readdirSync(CACHE_DIR)
  .filter(f => f.endsWith(`_${TARGET_MAX_DIM}.meta.json`))
  .sort()
  .filter((_, i) => i % stride === 0);

const rows = [];
for (const metaFile of stamps) {
  const m = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, metaFile), 'utf8'));
  const bin = path.join(CACHE_DIR, metaFile.replace('.meta.json', '.bin'));
  if (!fs.existsSync(bin)) continue;
  const buf = fs.readFileSync(bin);
  const rgba = new Uint8Array(buf.byteLength);
  rgba.set(buf);
  const { width: w, height: h } = m;

  for (let rep = 0; rep < reps; rep++) {
    let t = process.hrtime.bigint();
    const gray = rgbaToGray(rgba, w, h);
    const tGray = Number(process.hrtime.bigint() - t) / 1e6;

    t = process.hrtime.bigint();
    const enhanced = clahe(gray, w, h, 3.0, 8, 8);
    const tClahe = Number(process.hrtime.bigint() - t) / 1e6;

    t = process.hrtime.bigint();
    const blurred = gaussianBlur5x5(enhanced, w, h);
    const tBlur = Number(process.hrtime.bigint() - t) / 1e6;

    t = process.hrtime.bigint();
    cannyEdges(blurred, w, h, 50, 150);
    const tCanny = Number(process.hrtime.bigint() - t) / 1e6;

    rows.push({ stamp: metaFile.replace(`_${TARGET_MAX_DIM}.meta.json`, ''), w, h,
                tGray, tClahe, tBlur, tCanny, total: tGray + tClahe + tBlur + tCanny });
  }
}

const pct = (arr, p) => {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const sum = a => a.reduce((x, y) => x + y, 0);

const cols = ['tGray', 'tClahe', 'tBlur', 'tCanny', 'total'];
console.log(`n=${rows.length} images (stride=${stride}, reps=${reps}) @ ${TARGET_MAX_DIM}px cap, plain node ${process.version}`);
console.log('stage       mean_ms   p50_ms   p95_ms   share_of_preprocess');
const grand = sum(rows.map(r => r.total));
for (const c of cols) {
  const v = rows.map(r => r[c]);
  const share = c === 'total' ? 100 : (sum(v) / grand) * 100;
  console.log(
    `${c.padEnd(10)} ${(sum(v) / v.length).toFixed(2).padStart(8)} ` +
    `${pct(v, 0.5).toFixed(2).padStart(8)} ${pct(v, 0.95).toFixed(2).padStart(8)} ` +
    `${share.toFixed(1).padStart(8)}%`);
}
fs.writeFileSync(path.join(ROOT, 'debug-reports', 'pap1694_preprocess_split.json'),
  JSON.stringify({ targetMaxDim: TARGET_MAX_DIM, stride, reps, node: process.version, rows }, null, 1));
