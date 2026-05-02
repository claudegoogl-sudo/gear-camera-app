/**
 * PAP-391 targeted corpus validator.
 * Runs full pipeline on:
 *   - ALL labeled 18–28T training photos
 *   - ALL labeled 18–28T debug-reports (b80+, last build cycle)
 *   - Full 10–15T labeled training subset (small-gear regression guard)
 * Reports per-class accuracy.
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027). The
 * stride-capped corpus loaders are bespoke to this harness, so the runner is
 * used per-stamp via evalPhoto rather than runCorpus.
 *
 * Run: HARNESS=pap391.harness npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
const { TRAINING_DIR: TRAINING, DEBUG_DIR: REPORTS, out } = runner;

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
  const all = [];
  for (const k of Object.keys(byClass).sort((a,b)=>Number(a)-Number(b))) all.push(...byClass[k]);
  return all;
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
  const CAP = 8;
  const all = [];
  for (const k of Object.keys(byClass)) {
    const arr = byClass[k].sort((a,b)=>a.stamp.localeCompare(b.stamp));
    if (arr.length <= CAP) { all.push(...arr); continue; }
    const step = arr.length / CAP;
    for (let i = 0; i < CAP; i++) all.push(arr[Math.floor(i * step)]);
  }
  return all;
}

describe('PAP-391 targeted corpus', () => {
  jest.setTimeout(30 * 60 * 1000);

  test('large-gear 18-28T (±1 tolerance)', () => {
    const corpus = loadLargeGearCorpus();
    const byClass = {};
    const fails = [];
    out(`[large] ${corpus.length} images`);
    const t0 = Date.now();
    for (let i = 0; i < corpus.length; i++) {
      const { photo, actual, src, stamp } = corpus[i];
      const row = runner.evalPhoto({ photo, actual, stamp });
      const r = row.raw;
      const ok = Math.abs(r.toothCount - actual) <= 1;
      byClass[actual] = byClass[actual] || { total: 0, ok: 0 };
      byClass[actual].total++;
      if (ok) byClass[actual].ok++;
      if (!ok) fails.push({ stamp, src, actual, detected: r.toothCount, method: r.methodUsed });
      out(`[${i+1}/${corpus.length}] ${src} ${stamp} actual=${actual} detected=${r.toothCount} ${ok?'OK':'FAIL'}`);
    }
    out(`\n=== LARGE-GEAR (±1) ===  elapsed=${((Date.now()-t0)/1000).toFixed(0)}s`);
    let totalOk = 0, totalN = 0;
    for (const k of Object.keys(byClass).sort((a,b)=>Number(a)-Number(b))) {
      const b = byClass[k];
      totalOk += b.ok; totalN += b.total;
      out(`  ${k}T: ${b.ok}/${b.total}  ${(100*b.ok/b.total).toFixed(1)}%`);
    }
    out(`  TOTAL 18-28T: ${totalOk}/${totalN}  ${(100*totalOk/Math.max(1,totalN)).toFixed(1)}%`);
    if (fails.length) {
      out(`  failures:`);
      for (const f of fails) out(`    ${f.src} ${f.stamp} actual=${f.actual} detected=${f.detected} method=${f.method}`);
    }
  });

  test('small-gear 10-15T (exact)', () => {
    const corpus = loadSmallGearCorpus();
    const byClass = {};
    const fails = [];
    out(`[small] ${corpus.length} images`);
    const t0 = Date.now();
    for (let i = 0; i < corpus.length; i++) {
      const { photo, actual, src, stamp } = corpus[i];
      const row = runner.evalPhoto({ photo, actual, stamp });
      const r = row.raw;
      const ok = r.toothCount === actual;
      byClass[actual] = byClass[actual] || { total: 0, ok: 0 };
      byClass[actual].total++;
      if (ok) byClass[actual].ok++;
      if (!ok) fails.push({ stamp, src, actual, detected: r.toothCount, method: r.methodUsed });
      out(`[${i+1}/${corpus.length}] ${src} ${stamp} actual=${actual} detected=${r.toothCount} ${ok?'OK':'FAIL'}`);
    }
    out(`\n=== SMALL-GEAR (exact) ===  elapsed=${((Date.now()-t0)/1000).toFixed(0)}s`);
    let totalOk = 0, totalN = 0;
    for (const k of Object.keys(byClass).sort((a,b)=>Number(a)-Number(b))) {
      const b = byClass[k];
      totalOk += b.ok; totalN += b.total;
      out(`  ${k}T: ${b.ok}/${b.total}  ${(100*b.ok/b.total).toFixed(1)}%`);
    }
    out(`  TOTAL 10-15T: ${totalOk}/${totalN}  ${(100*totalOk/Math.max(1,totalN)).toFixed(1)}%`);
    if (fails.length) {
      out(`  failures:`);
      for (const f of fails) out(`    ${f.src} ${f.stamp} actual=${f.actual} detected=${f.detected} method=${f.method}`);
    }
  });
});
