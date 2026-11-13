/**
 * Accuracy and runtime of gear counter v2 (and, with ALGO=legacy, of the legacy counter) on the labelled photos.
 *
 *   node --import ./mobile/__tests__/lib/node-esm-stubs.mjs mobile/__tests__/v2.corpus.mjs
 *
 * env MODE:
 *   full  (default) every labelled training-data photo, whole frame, long side 1200 px
 *   pad   what the app analyses with v2: the aim square recorded in the debug report (aimCrop) plus 50 %, long side 1024 px
 *   real  what the app analysed before v2: the cropped.jpg stored in each debug report, 900 px (legacy adds its circular mask)
 * env ALGO: v2 (default) | legacy      env OUT: write one JSON row per photo      env SHARD: i/n
 *
 * Scoring: EXACT tooth count for every gear size. toothCount 0 (v2) or confidence 0 (legacy) = abstain.
 * With ALGO=v2 and no SHARD the script exits 1 when a set misses its limits below.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decode: jpegDecode } = require('jpeg-js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'mobile', 'src');
const MODE = process.env.MODE || 'full', ALGO = process.env.ALGO || 'v2';
const [SI, SN] = (process.env.SHARD || '0/1').split('/').map(Number);
// minimum exact answers / maximum wrong answers, measured 2026-11-13 minus a small margin (docs/gear-counter-v2.md)
const LIMITS = { full: { minExact: 0.95, maxWrong: 1 }, pad: { minExact: 0.94, maxWrong: 1 }, real: { minExact: 0.88, maxWrong: 1 } };

const { countTeethV2 } = await import(pathToFileURL(path.join(SRC, 'algorithm/gearCounterV2.js')).href);
const { countTeethFromRgba, bilinearDownsampleRgba } = await import(pathToFileURL(path.join(SRC, 'algorithm/gearCounter.js')).href);
const { applyCircularMask } = await import(pathToFileURL(path.join(SRC, 'algorithm/imageUtils.js')).href);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/[^\x00-\x7F]+/g, '?'));
const decode = (f) => jpegDecode(fs.readFileSync(f), { useTArray: true, maxMemoryUsageInMB: 2048 });

function items() {
  const out = [];
  if (MODE === 'full') {
    const TD = path.join(ROOT, 'training-data');
    const fix = readJson(path.join(TD, 'LABEL_CORRECTIONS.json'));
    for (const f of fs.readdirSync(TD).sort()) {
      if (!f.endsWith('_meta.json')) continue;
      const stamp = f.replace('_meta.json', ''), photo = path.join(TD, stamp + '_photo.jpg');
      const m = readJson(path.join(TD, f));
      const actual = fix[stamp] ? fix[stamp].correct : Number(m.actual_tooth_count || m.actualTeethCount || 0);
      if (actual && fs.existsSync(photo)) out.push({ id: stamp, actual, photo });
    }
  } else {
    const DR = path.join(ROOT, 'debug-reports');
    for (const d of fs.readdirSync(DR).sort()) {
      const rep = path.join(DR, d, 'report.json');
      if (!d.startsWith('report_') || !fs.existsSync(rep)) continue;
      const r = readJson(rep), actual = Number(r.actualTeethCount || 0);
      const photo = path.join(DR, d, 'photo.jpg'), cropped = path.join(DR, d, 'cropped.jpg');
      if (!actual || !r.aimCrop) continue;
      if (MODE === 'real' && fs.existsSync(cropped)) out.push({ id: d, actual, photo: cropped });
      if (MODE === 'pad' && fs.existsSync(photo)) out.push({ id: d, actual, photo, aimCrop: r.aimCrop });
    }
  }
  return out.filter((_, i) => i % SN === SI);
}

function frame(it) {
  const raw = decode(it.photo);
  let { data, width: w, height: h } = raw;
  if (MODE === 'pad') {
    if (w > h) return null;                       // the app does not crop landscape photos
    const { originX, originY, side } = it.aimCrop;
    const ps = Math.min(Math.round(side * 1.5), w, h);
    const ox = Math.max(0, Math.min(w - ps, Math.round(originX + side / 2 - ps / 2)));
    const oy = Math.max(0, Math.min(h - ps, Math.round(originY + side / 2 - ps / 2)));
    const out = new Uint8Array(ps * ps * 4);
    for (let y = 0; y < ps; y++) { const s = ((oy + y) * w + ox) * 4; out.set(data.subarray(s, s + ps * 4), y * ps * 4); }
    data = out; w = ps; h = ps;
  }
  return bilinearDownsampleRgba(data, w, h, MODE === 'full' ? 1200 : MODE === 'pad' ? 1024 : 900);
}

const bucket = (a) => (a <= 15 ? 'S 9-15' : a <= 20 ? 'M 16-20' : a <= 28 ? 'L 21-28' : 'XL 29-60');
const rows = [];
for (const it of items()) {
  const f = frame(it);
  if (!f) continue;
  let tc = 0, raw = 0, reason = null;
  if (ALGO === 'legacy' && MODE !== 'full') applyCircularMask(f.rgba, f.width, f.height, (f.width - 1) / 2, (f.height - 1) / 2, 0.49 * Math.min(f.width, f.height));
  const log = console.log;
  console.log = () => {};                         // the legacy counter logs every gate
  const t0 = performance.now();
  try {
    if (ALGO === 'legacy') { const r = countTeethFromRgba(f.rgba, f.width, f.height); raw = r.toothCount || 0; tc = r.confidence ? raw : 0; reason = r.abstainReason || null; }
    else { const r = countTeethV2(f.rgba, f.width, f.height); tc = r.toothCount; raw = r.rawCount; reason = r.abstainReason; }
  } catch (e) { reason = 'error: ' + e.message; }
  const ms = performance.now() - t0;
  console.log = log;
  rows.push({ id: it.id, actual: it.actual, tc, raw, reason, ms: Math.round(ms * 10) / 10 });
}
if (process.env.OUT) fs.writeFileSync(process.env.OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

const line = (name, rs) => {
  const n = rs.length, ans = rs.filter((r) => r.tc), ok = ans.filter((r) => r.tc === r.actual).length;
  return `${name.padEnd(9)} n=${String(n).padStart(3)}  exact=${String(ok).padStart(3)} (${(100 * ok / Math.max(n, 1)).toFixed(1)}%)  abstain=${String(n - ans.length).padStart(3)}  wrong=${String(ans.length - ok).padStart(2)}  of-answers=${(100 * ok / Math.max(ans.length, 1)).toFixed(1)}%`;
};
console.log(`ALGO=${ALGO} MODE=${MODE} photos=${rows.length}`);
console.log(line('ALL', rows));
for (const b of ['S 9-15', 'M 16-20', 'L 21-28', 'XL 29-60']) console.log(line(b, rows.filter((r) => bucket(r.actual) === b)));
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`runtime per photo (count only, this host): p50=${ms[ms.length >> 1]} ms  p95=${ms[Math.floor(ms.length * 0.95)]} ms  max=${ms[ms.length - 1]} ms`);
for (const r of rows) if (r.tc && r.tc !== r.actual) console.log(`  WRONG ${r.id}: actual ${r.actual}, answered ${r.tc}`);
if (ALGO === 'v2' && SN === 1) {
  const ok = rows.filter((r) => r.tc === r.actual).length, wrong = rows.filter((r) => r.tc && r.tc !== r.actual).length, L = LIMITS[MODE];
  if (ok / rows.length < L.minExact || wrong > L.maxWrong) { console.log(`FAIL: limits for ${MODE} are exact >= ${L.minExact * 100}% and wrong <= ${L.maxWrong}`); process.exit(1); }
  console.log('PASS');
}
