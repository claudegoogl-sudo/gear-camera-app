/**
 * PAP-1872 — rim edge-transition probe (G5 candidate for the dense gate).
 * For each corpus photo (pap1862.audit conventions: bilinear->900 +
 * 0.49*min(W,H) mask): run preprocess, then along circles at
 * r = 0.70..0.98 * contourRadius count angular edge-pixel runs
 * (tooth-tip transitions) at ANG=720 samples. Dumps max/median run
 * counts per photo plus edge density in the outer annulus.
 *
 * Rows -> debug-reports/pap1872_dense_abstain_2026-09-11/rim_probe_rows.json
 *
 * Usage: node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *          mobile/__tests__/pap1872.rim_probe.mjs
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
const DEBUG_DIR = path.join(ROOT, 'debug-reports', 'pap1872_dense_abstain_2026-09-11');
const CACHE_DIR = path.join(ROOT, '.cache', 'training-rgba');
const TARGET = 900;
const ANG = 720;

const gc = await import('../src/algorithm/gearCounter.js');
const { bilinearDownsampleRgba } = gc;
const pp = await import('../src/algorithm/preprocess.js');
const { preprocess } = pp;
const iu = await import('../src/algorithm/imageUtils.js');
const { applyCircularMask } = iu;

const out = (s) => process.stdout.write(s + '\n');

function loadRgba(photo, stamp) {
  const bin = path.join(CACHE_DIR, `${stamp}_${TARGET}.bin`);
  const metaP = path.join(CACHE_DIR, `${stamp}_${TARGET}.meta.json`);
  const srcMtimeMs = fs.statSync(photo).mtimeMs;
  if (fs.existsSync(metaP) && fs.existsSync(bin)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaP, 'utf8'));
      if (m.sourceMtimeMs === srcMtimeMs && m.targetMaxDim === TARGET) {
        const buf = fs.readFileSync(bin);
        const rgba = new Uint8Array(buf.byteLength);
        rgba.set(buf);
        return { rgba, w: m.width, h: m.height };
      }
    } catch { /* fall through */ }
  }
  const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET);
  return { rgba: ds.rgba, w: ds.width, h: ds.height };
}

function rimStats(edges, w, h, cx, cy, cr) {
  const runCounts = [];
  let edgePixels = 0, annulusPixels = 0;
  for (let rr = 0.70; rr <= 0.981; rr += 0.02) {
    const r = cr * rr;
    const samples = new Uint8Array(ANG);
    for (let a = 0; a < ANG; a += 1) {
      const th = (a / ANG) * Math.PI * 2;
      const x = Math.round(cx + r * Math.cos(th));
      const y = Math.round(cy + r * Math.sin(th));
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      annulusPixels += 1;
      if (edges[y * w + x]) { samples[a] = 1; edgePixels += 1; }
    }
    // count angular runs of edge samples (wrap-aware)
    let runs = 0;
    let start = 0;
    while (start < ANG && samples[start] === 0) start += 1;
    if (start === ANG) { runCounts.push(0); continue; }
    let inRun = false;
    for (let k = 0; k < ANG; k += 1) {
      const v = samples[(start + k) % ANG];
      if (v && !inRun) { runs += 1; inRun = true; }
      else if (!v) inRun = false;
    }
    runCounts.push(runs);
  }
  runCounts.sort((a, b) => a - b);
  return {
    maxRuns: runCounts[runCounts.length - 1],
    medRuns: runCounts[Math.floor(runCounts.length / 2)],
    p75Runs: runCounts[Math.floor(runCounts.length * 0.75)],
    edgeDensity: annulusPixels > 0 ? Number((edgePixels / annulusPixels).toFixed(4)) : 0,
  };
}

const ANCHORS = [
  { stamp: 'pap1862_captureA_cropped', actual: 20, file: path.join(ROOT, 'debug-reports', 'pap1862_fp5_b151_session_2026-09-10', 'attachments', 'captureA_898620612_cropped.jpg') },
  { stamp: 'pap1862_captureB_cropped', actual: 20, file: path.join(ROOT, 'debug-reports', 'pap1862_fp5_b151_session_2026-09-10', 'attachments', 'captureB_898623252_cropped.jpg') },
];

const sweep = JSON.parse(fs.readFileSync(path.join(ROOT, 'debug-reports', 'pap1862_fp5_b151_session_2026-09-10', 'threshold_sweep_rows.json'), 'utf8'));
const geoByStamp = new Map(sweep.filter((r) => !r.error).map((r) => [r.stamp, r]));

const labeled = [];
for (const f of fs.readdirSync(TRAINING_DIR).sort()) {
  if (!f.endsWith('_meta.json')) continue;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(TRAINING_DIR, f), 'utf8').replace(/[^\x00-\x7F]+/g, '?')); } catch { continue; }
  const actual = Number(meta.actual_tooth_count || meta.actualTeethCount || 0);
  if (!actual || actual < 9 || actual > 60) continue;
  const stamp = f.replace('_meta.json', '');
  const photo = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
  if (fs.existsSync(photo)) labeled.push({ stamp, actual, photo });
}

out(`[pap1872-rim] corpus=${labeled.length} + anchors=${ANCHORS.length}`);
const rows = [];
const t0 = Date.now();
for (const item of [...ANCHORS, ...labeled]) {
  const geo = geoByStamp.get(item.stamp);
  if (!geo) continue; // need committed contourRadius for band placement
  const { rgba, w, h } = loadRgba(item.photo || item.file, item.stamp);
  applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
  const { edges } = preprocess(rgba, w, h);
  const stats = rimStats(edges, w, h, geo.cx, geo.cy, geo.contourRadius);
  rows.push({ stamp: item.stamp, actual: item.actual, contourRadius: geo.contourRadius, ...stats });
  if (rows.length % 50 === 0) out(`[pap1872-rim] ${rows.length}/${labeled.length + ANCHORS.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.writeFileSync(path.join(DEBUG_DIR, 'rim_probe_rows.json'), JSON.stringify(rows, null, 1));
out(`[pap1872-rim] done rows=${rows.length} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);
