/**
 * PAP-1898 corpus A/B — countTeethFromRgba over the full 364-photo labeled
 * corpus + the 5 audited b153 crops, in the CURRENT process arm
 * (PAP1898_RESCUE_OFF=1 => baseline arm; unset => silhouette-rescue arm).
 * Rows land in debug-reports/pap1898_localization_2026-09-12/corpus_<arm>.json
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
const ARM = process.env.PAP1898_RESCUE_OFF === '1' ? 'baseline' : 'rescue';

const gc = await import('../src/algorithm/gearCounter.js');
const { countTeethFromRgba, bilinearDownsampleRgba } = gc;
const iu = await import('../src/algorithm/imageUtils.js');
const { applyCircularMask } = iu;

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
    } catch { /* fall through */ }
  }
  const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET);
  return { rgba: ds.rgba, w: ds.width, h: ds.height };
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
  if (fs.existsSync(photo)) items.push({ source: 'corpus', stamp, actual, photo });
}
// audited b153 evidence crops as anchors
const EV_LABELS = { f5886a846722: 52, af9294fe87f0: 50, caa1725c6bae: 42, f3a8e88a13d8: 36, '92e4b255112c': 24 };
for (const [stamp, actual] of Object.entries(EV_LABELS)) {
  items.push({ source: 'pap1897-audit', stamp: `b153_${stamp}`, actual, photo: path.join(EV, `${stamp}_cropped.jpg`) });
}

out(`[pap1898-corpus] arm=${ARM} photos=${items.length}`);
const rows = [];
const t0 = Date.now();
for (const item of items) {
  const { rgba, w, h } = loadRgba(item.photo, item.stamp);
  applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
  const f0 = Date.now();
  let r;
  try { r = countTeethFromRgba(rgba, w, h); }
  catch (err) { r = { toothCount: 0, confidence: 0, methodUsed: 'ERROR:' + err.message, budgetExhausted: false }; }
  rows.push({
    stamp: item.stamp, actual: item.actual,
    tc: r.toothCount || 0,
    conf: Number((r.confidence || 0).toFixed(3)),
    abstained: !!r.abstained,
    gateRule: r.abstainGateRule || null,
    method: (r.methodUsed || '?').slice(0, 90),
    contourR: r.contourRadius ?? null,
    budgetExhausted: !!r.budgetExhausted,
    runtime: Date.now() - f0,
  });
  if (rows.length % 40 === 0) out(`[pap1898-corpus] ${rows.length}/${items.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
fs.writeFileSync(path.join(OUT, `corpus_${ARM}.json`), JSON.stringify(rows, null, 1));

// summary
const sum = (rs) => {
  const n = rs.length;
  const strict = rs.filter(r => r.tc === r.actual).length;
  const within1 = rs.filter(r => Math.abs(r.tc - r.actual) <= 1).length;
  const wrongNonzero = rs.filter(r => r.tc > 0 && Math.abs(r.tc - r.actual) > 1).length;
  const abstain = rs.filter(r => r.tc === 0).length;
  return { n, strict, within1, wrongNonzero, abstain, strictPct: +(100 * strict / n).toFixed(1) };
};
const dense = rows.filter(r => r.actual >= 40);
const ordinary = rows.filter(r => r.actual < 40);
const anchors = rows.filter(r => r.source === 'pap1897-audit');
out(`[pap1898-corpus] ARM=${ARM}`);
out(`  all:      ${JSON.stringify(sum(rows))}`);
out(`  dense:    ${JSON.stringify(sum(dense))}`);
out(`  ordinary: ${JSON.stringify(sum(ordinary))}`);
out(`  anchors:  ${anchors.map(r => `${r.actual}T->${r.tc}${r.abstained ? '(abstain)' : ''}`).join(' ')}`);
out(`[pap1898-corpus] done elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);
