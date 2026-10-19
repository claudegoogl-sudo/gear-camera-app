/**
 * PAP-1977 device-faithful corpus harness: synthesises CameraScreen.cropToAimCircle
 * (centred, AIM_CIRCLE_FRAC 0.95, CROP_PAD_FRAC 0) on each labeled _photo.jpg, then
 * bilinear->900 + 0.49*min(W,H) mask, production countTeethFromRgba.
 * Screen aspect r=sw/sh=0.4533 calibrated so 3072x4096 -> side 1764 (captured anchors).
 * Scoring: conf===0 or tc===0 = ABSTAIN; S(9-15)/M(16-20) exact; L(21-28)/XL(29-60) +-1.
 * Usage: SRC=<mobile/src dir> OUT=<rows.json> node --import ./mobile/__tests__/lib/node-esm-stubs.mjs mobile/__tests__/pap1977.device_faithful.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decode: jpegDecode } = require('jpeg-js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SRC = process.env.SRC || path.join(ROOT, 'mobile', 'src');
const OUT = process.env.OUT || path.join(ROOT, 'debug-reports', 'pap1977', 'rows_head.json');
const FRAC = 1594 / 4096;
const ASPECT = 0.4533, AIM = 0.95, TARGET = 900;
const { countTeethFromRgba, bilinearDownsampleRgba } = await import(pathToFileURL(path.join(SRC, 'algorithm/gearCounter.js')).href);
const { applyCircularMask } = await import(pathToFileURL(path.join(SRC, 'algorithm/imageUtils.js')).href);

export function aimCrop(data, W, H) {
  const short = Math.min(W, H), long = Math.max(W, H);
  const side = Math.min(Math.round(AIM * Math.min(short, long * ASPECT)), W, H);
  // Device aim circle sits above screen centre: measured cy = 0.3891 of long axis (anchors: originY 712 of 4096, side 1764).
  // Stored-landscape (EXIF-6 raw) photos map upright-y to raw-x (rotate cw), so use fraction on the long axis from the start.
  const cx = W > H ? FRAC * W : W / 2, cy = W > H ? H / 2 : FRAC * H;
  const ox = Math.max(0, Math.min(W - side, Math.round(cx - side / 2)));
  const oy = Math.max(0, Math.min(H - side, Math.round(cy - side / 2)));
  const out = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    const s = ((oy + y) * W + ox) * 4;
    out.set(data.subarray(s, s + side * 4), y * side * 4);
  }
  return { data: out, w: side, h: side };
}
function run(data, W, H, crop) {
  let c = crop ? aimCrop(data, W, H) : { data, w: W, h: H };
  const ds = bilinearDownsampleRgba(c.data, c.w, c.h, TARGET);
  applyCircularMask(ds.rgba, ds.width, ds.height, (ds.width - 1) / 2, (ds.height - 1) / 2, 0.49 * Math.min(ds.width, ds.height));
  try { return { r: countTeethFromRgba(ds.rgba, ds.width, ds.height), side: c.w }; }
  catch (e) { return { r: { toothCount: 0, confidence: 0 }, side: c.w }; }
}
const bucket = (a) => a <= 15 ? 'S' : a <= 20 ? 'M' : a <= 28 ? 'L' : 'XL';
const tol = (b) => (b === 'S' || b === 'M') ? 0 : 1;
const A = path.join(ROOT, 'debug-reports', 'pap1862_fp5_b151_session_2026-09-10', 'attachments');
if (process.env.ANCHORS) {
  for (const n of ['captureA_898620610_photo.jpg:captureA_898620612_cropped.jpg', 'captureB_898623251_photo.jpg:captureB_898623252_cropped.jpg']) {
    const [p, c] = n.split(':');
    const ph = jpegDecode(fs.readFileSync(path.join(A, p)), { useTArray: true });
    const cr = jpegDecode(fs.readFileSync(path.join(A, c)), { useTArray: true });
    const up = new Uint8Array(ph.data.length); const uw = ph.height, uh = ph.width;
    for (let y = 0; y < ph.height; y++) for (let x = 0; x < ph.width; x++) { const o = (y * ph.width + x) * 4, n = (x * uw + (uw - 1 - y)) * 4; up.set(ph.data.subarray(o, o + 4), n); }
    const syn = run(up, uw, uh, true); 
    const dev = run(cr.data, cr.width, cr.height, false);
    console.log(n, 'synthSide', syn.side, 'deviceSide', cr.width, 'synth', syn.r.toothCount, syn.r.confidence, 'devCrop', dev.r.toothCount, dev.r.confidence);
  }
  process.exit(0);
}
const TD = path.join(ROOT, 'training-data');
const rows = [];
for (const f of fs.readdirSync(TD).sort()) {
  if (!f.endsWith('_meta.json')) continue;
  let m; try { m = JSON.parse(fs.readFileSync(path.join(TD, f), 'utf8').replace(/[^\x00-\x7F]+/g, '?')); } catch { continue; }
  const actual = Number(m.actual_tooth_count || m.actualTeethCount || 0);
  if (!actual || actual < 9 || actual > 60) continue;
  const stamp = f.replace('_meta.json', ''); const photo = path.join(TD, stamp + '_photo.jpg');
  if (!fs.existsSync(photo)) continue;
  const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
  const { r } = run(raw.data, raw.width, raw.height, true);
  const tc = r.toothCount || 0, conf = r.confidence || 0, b = bucket(actual);
  const abstain = conf === 0 || tc === 0;
  rows.push({ stamp, actual, b, tc, conf, abstain, correct: !abstain && Math.abs(tc - actual) <= tol(b) });
  if (rows.length % 50 === 0) console.log(rows.length);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(rows));
const agg = (rs) => { const n = rs.length, c = rs.filter(x => x.correct).length, a = rs.filter(x => x.abstain).length, w = n - c - a; return `n=${n} correct=${c} (${(100*c/n).toFixed(1)}%) abstain=${a} (${(100*a/n).toFixed(1)}%) confwrong=${w} (${(100*w/n).toFixed(1)}%) F=${(100*(c+w===0?0:(n-a)/n)).toFixed(1)}% ofAnswers=${(100*c/Math.max(1,n-a)).toFixed(1)}%`; };
console.log('ALL', agg(rows)); for (const b of ['S','M','L','XL']) console.log(b, agg(rows.filter(r => r.b === b)));
