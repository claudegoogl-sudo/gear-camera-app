/**
 * PAP-1898 corpus pass 2 — baseline geometry + silhouette fit + rim-support
 * for every photo, for offline gate-rule simulation.
 * Run with PAP1898_RESCUE_OFF=1 so countTeethFromRgba is baseline.
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
const EV = path.join(ROOT, 'debug-reports', 'pap1897_fp5_b153_session_2026-09-11');
const OUT = path.join(ROOT, 'debug-reports', 'pap1898_localization_2026-09-12');
const TARGET = 900;

const gc = await import('../src/algorithm/gearCounter.js');
const { countTeethFromRgba, bilinearDownsampleRgba, __test } = gc;
const iu = await import('../src/algorithm/imageUtils.js');
const { applyCircularMask } = iu;
const pp = await import('../src/algorithm/preprocess.js');

const out = (s) => process.stdout.write(s + '\n');
const CACHE_DIR = path.join(ROOT, '.cache', 'training-rgba');
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
    } catch { }
  }
  const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET);
  return { rgba: ds.rgba, w: ds.width, h: ds.height };
}

// angular rim support of a circle: fraction of 360 rays with an edge within ±3% r
function rimSupport(edges, w, h, cx, cy, r) {
  let hits = 0;
  const tol = Math.max(2, 0.03 * r);
  for (let i = 0; i < 360; i++) {
    const a = (2 * Math.PI * i) / 360;
    const ca = Math.cos(a), sa = Math.sin(a);
    let hit = false;
    for (let rr = r - tol; rr <= r + tol && !hit; rr++) {
      const px = Math.round(cx + rr * ca), py = Math.round(cy + rr * sa);
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      if (edges[py * w + px] > 0) hit = true;
    }
    if (hit) hits++;
  }
  return hits / 360;
}

const items = [];
for (const f of fs.readdirSync(TRAINING_DIR).sort()) {
  if (!f.endsWith('_meta.json')) continue;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(TRAINING_DIR, f), 'utf8').replace(/[^\x00-\x7F]+/g, '?')); }
  catch { continue; }
  const actual = Number(meta.actual_tooth_count || meta.actualTeethCount || 0);
  if (!actual || actual < 9 || actual > 60) continue;
  const stamp = f.replace('_meta.json', '');
  const photo = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
  if (fs.existsSync(photo)) items.push({ stamp, actual, photo });
}
const EV_LABELS = { f5886a846722: 52, af9294fe87f0: 50, caa1725c6bae: 42, f3a8e88a13d8: 36, '92e4b255112c': 24 };
for (const [stamp, actual] of Object.entries(EV_LABELS)) {
  items.push({ stamp: `b153_${stamp}`, actual, photo: path.join(EV, `${stamp}_cropped.jpg`) });
}

out(`[pap1898-c2] photos=${items.length} rescueOff=${process.env.PAP1898_RESCUE_OFF}`);
const rows = [];
const t0 = Date.now();
for (const item of items) {
  const { rgba, w, h } = loadRgba(item.photo, item.stamp);
  applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
  const r = countTeethFromRgba(rgba, w, h);
  const { gray, enhanced, edges } = pp.preprocess(rgba, w, h);
  const sil = __test.pap1898SilhouetteFit(edges, w, h);
  const minDim = Math.min(w, h);
  const bc = r.gearCenter; // baseline center (crop fractions)
  const bcx = bc.x * w, bcy = bc.y * h, br = r.gearRadius * w;
  const supportProd = rimSupport(edges, w, h, bcx, bcy, br);
  const supportSil = sil.fit ? rimSupport(edges, w, h, sil.fit.cx, sil.fit.cy, sil.fit.r) : 0;
  rows.push({
    stamp: item.stamp, actual: item.actual,
    tc: r.toothCount || 0, conf: +(r.confidence || 0).toFixed(3), abstained: !!r.abstained,
    contourR: r.contourRadius ?? null,
    prodCx: +bcx.toFixed(1), prodCy: +bcy.toFixed(1), prodR: +br.toFixed(1),
    sil: sil.fit ? { cx: +sil.fit.cx.toFixed(1), cy: +sil.fit.cy.toFixed(1), r: +sil.fit.r.toFixed(1) } : null,
    coverage: +sil.coverage.toFixed(3),
    supportProd: +supportProd.toFixed(3), supportSil: +supportSil.toFixed(3),
  });
  if (rows.length % 40 === 0) out(`[pap1898-c2] ${rows.length}/${items.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
fs.writeFileSync(path.join(OUT, 'corpus_geom.json'), JSON.stringify(rows, null, 1));
out(`[pap1898-c2] done elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s rows=${rows.length}`);
