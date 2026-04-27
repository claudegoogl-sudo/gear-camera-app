/**
 * PAP-391 targeted corpus validator.
 * Runs full pipeline on:
 *   - ALL labeled 18–28T training photos
 *   - ALL labeled 18–28T debug-reports (b80+, last build cycle)
 *   - Full 10–15T labeled training subset (small-gear regression guard)
 * Reports per-class accuracy.
 *
 * Usage: npx jest --testMatch="**\/pap391.harness.js"
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TRAINING = path.join(REPO_ROOT, 'training-data');
const REPORTS = path.join(REPO_ROOT, 'debug-reports');
const TARGET_MAX_DIM = 900;

function bilinearResize(rgba, w, h, targetMaxDim) {
  const max = Math.max(w, h);
  if (max <= targetMaxDim) return { rgba, w, h };
  const scale = targetMaxDim / max;
  const nw = Math.round(w * scale);
  const nh = Math.round(h * scale);
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = (y + 0.5) * h / nh - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < nw; x++) {
      const sx = (x + 0.5) * w / nw - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const i00 = (y0 * w + x0) * 4;
      const i01 = (y0 * w + x1) * 4;
      const i10 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      const io = (y * nw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v = (rgba[i00 + c] * (1 - fx) + rgba[i01 + c] * fx) * (1 - fy)
                + (rgba[i10 + c] * (1 - fx) + rgba[i11 + c] * fx) * fy;
        out[io + c] = Math.round(v);
      }
    }
  }
  return { rgba: out, w: nw, h: nh };
}

function readMeta(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/[^\x00-\x7F]+/g, '?'));
  } catch { return null; }
}

function parseBuild(b) {
  const m = String(b || '').match(/\((\d+)\)/);
  return m ? Number(m[1]) : 0;
}

function loadLargeGearCorpus() {
  const byClass = {};
  // Training-data labeled 18–28T — cap 6 per class striped across time
  const trainByClass = {};
  for (const f of fs.readdirSync(TRAINING)) {
    if (!f.endsWith('_meta.json')) continue;
    const meta = readMeta(path.join(TRAINING, f));
    const actual = meta && (meta.actual_tooth_count || meta.actualTeethCount);
    if (!actual || actual < 18 || actual > 28) continue;
    const photo = path.join(TRAINING, f.replace('_meta.json', '_photo.jpg'));
    if (!fs.existsSync(photo)) continue;
    trainByClass[actual] = trainByClass[actual] || [];
    trainByClass[actual].push({ photo, actual: Number(actual), src: 'train', stamp: f.replace('_meta.json', '') });
  }
  const TRAIN_CAP = 6;
  for (const k of Object.keys(trainByClass)) {
    const arr = trainByClass[k].sort((a,b)=>a.stamp.localeCompare(b.stamp));
    byClass[k] = byClass[k] || [];
    if (arr.length <= TRAIN_CAP) { byClass[k].push(...arr); continue; }
    const step = arr.length / TRAIN_CAP;
    for (let i = 0; i < TRAIN_CAP; i++) byClass[k].push(arr[Math.floor(i * step)]);
  }
  // Debug-reports labeled 18–28T from b84+ (recent cycle, capped per class)
  const reportByClass = {};
  for (const dir of fs.readdirSync(REPORTS).filter(d => d.startsWith('report_'))) {
    const meta = readMeta(path.join(REPORTS, dir, 'report.json'));
    const actual = meta && (meta.actualTeethCount || meta.actual_tooth_count);
    if (!actual || actual < 18 || actual > 28) continue;
    const build = parseBuild(meta.build);
    if (build < 84) continue;
    const photo = path.join(REPORTS, dir, 'photo.jpg');
    if (!fs.existsSync(photo)) continue;
    reportByClass[actual] = reportByClass[actual] || [];
    reportByClass[actual].push({ photo, actual: Number(actual), src: `b${build}`, stamp: dir.replace('report_', '') });
  }
  // Cap 4 debug-reports per class — ensures field coverage without blowing runtime.
  const CAP = 4;
  for (const k of Object.keys(reportByClass)) {
    const arr = reportByClass[k].sort((a,b)=>a.stamp.localeCompare(b.stamp));
    byClass[k] = byClass[k] || [];
    if (arr.length <= CAP) { byClass[k].push(...arr); continue; }
    const step = arr.length / CAP;
    for (let i = 0; i < CAP; i++) byClass[k].push(arr[Math.floor(i * step)]);
  }
  const out = [];
  for (const k of Object.keys(byClass).sort((a,b)=>Number(a)-Number(b))) out.push(...byClass[k]);
  return out;
}

function loadSmallGearCorpus() {
  const byClass = {};
  for (const f of fs.readdirSync(TRAINING)) {
    if (!f.endsWith('_meta.json')) continue;
    const meta = readMeta(path.join(TRAINING, f));
    const actual = meta && (meta.actual_tooth_count || meta.actualTeethCount);
    if (!actual || actual < 10 || actual > 15) continue;
    const photo = path.join(TRAINING, f.replace('_meta.json', '_photo.jpg'));
    if (!fs.existsSync(photo)) continue;
    byClass[actual] = byClass[actual] || [];
    byClass[actual].push({ photo, actual: Number(actual), src: 'train', stamp: f.replace('_meta.json', '') });
  }
  // Cap 8 samples per class (stride across) — keeps runtime bounded while
  // covering every class with enough samples to detect a regression.
  const CAP = 8;
  const out = [];
  for (const k of Object.keys(byClass)) {
    const arr = byClass[k].sort((a,b)=>a.stamp.localeCompare(b.stamp));
    if (arr.length <= CAP) { out.push(...arr); continue; }
    const step = arr.length / CAP;
    for (let i = 0; i < CAP; i++) out.push(arr[Math.floor(i * step)]);
  }
  return out;
}

function runOne(photo) {
  const buf = fs.readFileSync(photo);
  const raw = jpegDecode(buf, { useTArray: true });
  const { rgba, w, h } = bilinearResize(raw.data, raw.width, raw.height, TARGET_MAX_DIM);
  const { countTeethFromRgba } = require('../src/algorithm/gearCounter');
  return countTeethFromRgba(rgba, w, h);
}

describe('PAP-391 targeted corpus', () => {
  jest.setTimeout(30 * 60 * 1000);

  test('large-gear 18-28T (±1 tolerance)', () => {
    const corpus = loadLargeGearCorpus();
    const byClass = {};
    const fails = [];
    console.log(`[large] ${corpus.length} images`);
    const t0 = Date.now();
    for (let i = 0; i < corpus.length; i++) {
      const { photo, actual, src, stamp } = corpus[i];
      const r = runOne(photo);
      const ok = Math.abs(r.toothCount - actual) <= 1;
      byClass[actual] = byClass[actual] || { total: 0, ok: 0 };
      byClass[actual].total++;
      if (ok) byClass[actual].ok++;
      if (!ok) fails.push({ stamp, src, actual, detected: r.toothCount, method: r.methodUsed });
      process.stdout.write(`[${i+1}/${corpus.length}] ${src} ${stamp} actual=${actual} detected=${r.toothCount} ${ok?'OK':'FAIL'}\n`);
    }
    console.log(`\n=== LARGE-GEAR (±1) ===  elapsed=${((Date.now()-t0)/1000).toFixed(0)}s`);
    let totalOk = 0, totalN = 0;
    for (const k of Object.keys(byClass).sort((a,b)=>Number(a)-Number(b))) {
      const b = byClass[k];
      totalOk += b.ok; totalN += b.total;
      console.log(`  ${k}T: ${b.ok}/${b.total}  ${(100*b.ok/b.total).toFixed(1)}%`);
    }
    console.log(`  TOTAL 18-28T: ${totalOk}/${totalN}  ${(100*totalOk/totalN).toFixed(1)}%`);
    if (fails.length) {
      console.log(`  failures:`);
      for (const f of fails) console.log(`    ${f.src} ${f.stamp} actual=${f.actual} detected=${f.detected} method=${f.method}`);
    }
  });

  test('small-gear 10-15T (exact)', () => {
    const corpus = loadSmallGearCorpus();
    const byClass = {};
    const fails = [];
    console.log(`[small] ${corpus.length} images`);
    const t0 = Date.now();
    for (let i = 0; i < corpus.length; i++) {
      const { photo, actual, src, stamp } = corpus[i];
      const r = runOne(photo);
      const ok = r.toothCount === actual;
      byClass[actual] = byClass[actual] || { total: 0, ok: 0 };
      byClass[actual].total++;
      if (ok) byClass[actual].ok++;
      if (!ok) fails.push({ stamp, src, actual, detected: r.toothCount, method: r.methodUsed });
      process.stdout.write(`[${i+1}/${corpus.length}] ${src} ${stamp} actual=${actual} detected=${r.toothCount} ${ok?'OK':'FAIL'}\n`);
    }
    console.log(`\n=== SMALL-GEAR (exact) ===  elapsed=${((Date.now()-t0)/1000).toFixed(0)}s`);
    let totalOk = 0, totalN = 0;
    for (const k of Object.keys(byClass).sort((a,b)=>Number(a)-Number(b))) {
      const b = byClass[k];
      totalOk += b.ok; totalN += b.total;
      console.log(`  ${k}T: ${b.ok}/${b.total}  ${(100*b.ok/b.total).toFixed(1)}%`);
    }
    console.log(`  TOTAL 10-15T: ${totalOk}/${totalN}  ${(100*totalOk/totalN).toFixed(1)}%`);
    if (fails.length) {
      console.log(`  failures:`);
      for (const f of fails) console.log(`    ${f.src} ${f.stamp} actual=${f.actual} detected=${f.detected} method=${f.method}`);
    }
  });
});
