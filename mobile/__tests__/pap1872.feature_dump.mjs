/**
 * PAP-1872 — full-corpus per-method feature dump at HEAD (gate off).
 * Plain-node, pap1862.audit.mjs conventions (bilinear->900 + 0.49*min(W,H)
 * circular mask), production countTeethFromRgba. Dumps the FULL result
 * object per photo so the dense-abstain gate calibration can be done
 * offline against every method output (bc/peak/op/fft90/rOuter/fraction).
 *
 * Rows -> debug-reports/pap1872_dense_abstain_2026-09-11/feature_rows.json
 *
 * Usage: node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *          mobile/__tests__/pap1872.feature_dump.mjs
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

const gc = await import('../src/algorithm/gearCounter.js');
const { countTeethFromRgba, bilinearDownsampleRgba } = gc;
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

const ANCHORS = [
  { source: 'pap1862-capture', stamp: 'pap1862_captureA_cropped', actual: 20, file: path.join(ROOT, 'debug-reports', 'pap1862_fp5_b151_session_2026-09-10', 'attachments', 'captureA_898620612_cropped.jpg') },
  { source: 'pap1862-capture', stamp: 'pap1862_captureB_cropped', actual: 20, file: path.join(ROOT, 'debug-reports', 'pap1862_fp5_b151_session_2026-09-10', 'attachments', 'captureB_898623252_cropped.jpg') },
];

const labeled = [];
for (const f of fs.readdirSync(TRAINING_DIR).sort()) {
  if (!f.endsWith('_meta.json')) continue;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(TRAINING_DIR, f), 'utf8').replace(/[^\x00-\x7F]+/g, '?'));
  } catch { continue; }
  const actual = Number(meta.actual_tooth_count || meta.actualTeethCount || 0);
  if (!actual || actual < 9 || actual > 60) continue;
  const stamp = f.replace('_meta.json', '');
  const photo = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
  if (fs.existsSync(photo)) labeled.push({ source: 'training-data', stamp, actual, photo });
}

out(`[pap1872-dump] corpus=${labeled.length} + anchors=${ANCHORS.length} at HEAD (gate off)`);
const rows = [];
const t0 = Date.now();
for (const item of [...ANCHORS, ...labeled]) {
  const { rgba, w, h } = loadRgba(item.photo || item.file, item.stamp);
  applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
  const f0 = Date.now();
  let r;
  try { r = countTeethFromRgba(rgba, w, h); }
  catch (err) { r = { toothCount: 0, confidence: 0, methodUsed: 'ERROR:' + err.message, budgetExhausted: false }; }
  const runtime = Date.now() - f0;
  rows.push({
    source: item.source, stamp: item.stamp, actual: item.actual,
    tc: r.toothCount || 0,
    conf: Number((r.confidence || 0).toFixed(3)),
    method: r.methodUsed || '?',
    budgetExhausted: !!r.budgetExhausted,
    runtime,
    peakTc: r.peakTc || 0, peakRel: Number((r.peakRel || 0).toFixed(4)), peakR: r.peakR || 0,
    fft90tc: r.fft90tc || 0, opTc: r.opTc || 0, opRel: Number((r.opRel || 0).toFixed(4)),
    bcTc: r.bcTc || 0, bcPurity: Number((r.bcPurity || 0).toFixed(4)), bcPeaks: r.bcPeaks || 0,
    rOuter: Number((r.rOuter || 0).toFixed(4)),
    gearRadius: Number((r.gearRadius || 0).toFixed(4)),
    innerContourSuspected: !!r.innerContourSuspected,
  });
  if (rows.length % 25 === 0 || rows.length === labeled.length + ANCHORS.length) {
    out(`[pap1872-dump] ${rows.length}/${labeled.length + ANCHORS.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  if (rows.length % 100 === 0) {
    try { fs.mkdirSync(DEBUG_DIR, { recursive: true }); fs.writeFileSync(path.join(DEBUG_DIR, 'feature_rows.json'), JSON.stringify(rows, null, 1)); } catch { }
  }
}
fs.mkdirSync(DEBUG_DIR, { recursive: true });
fs.writeFileSync(path.join(DEBUG_DIR, 'feature_rows.json'), JSON.stringify(rows, null, 1));
out(`[pap1872-dump] done rows=${rows.length} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);
