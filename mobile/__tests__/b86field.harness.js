/**
 * PAP-391 b86 field-data validation — runs current gearCounter on every
 * labeled debug-report from 2026-04-21 and bucketises the result so we
 * can compare the ellipse-fit change against the baseline b86 accuracy
 * captured in the labeled reports' `result.toothCount`.
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

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

function loadReports(repoRoot) {
  const reportsDir = path.join(repoRoot, 'debug-reports');
  const reports = [];
  for (const dir of fs.readdirSync(reportsDir).filter(d => d.startsWith('report_2026-04-21_')).sort()) {
    const reportFile = path.join(reportsDir, dir, 'report.json');
    if (!fs.existsSync(reportFile)) continue;
    const raw = fs.readFileSync(reportFile, 'utf8').replace(/[^\x00-\x7F]+/g, '?');
    let d;
    try { d = JSON.parse(raw); } catch { continue; }
    const actual = d.actualTeethCount || d.actual_tooth_count;
    if (!actual) continue;
    const photoRel = 'debug-reports/' + dir + '/photo.jpg';
    if (!fs.existsSync(path.join(repoRoot, photoRel))) continue;
    reports.push({
      photo: photoRel,
      actual: Number(actual),
      b86: d.result?.toothCount || 0,
      stamp: dir.replace('report_', ''),
    });
  }
  return reports;
}

describe('b86 field validation', () => {
  jest.setTimeout(30 * 60 * 1000);
  test('run current JS on labeled b86 reports', () => {
    const { countTeethFromRgba } = require('../src/algorithm/gearCounter');
    const repoRoot = path.resolve(__dirname, '..', '..');
    const reports = loadReports(repoRoot);

    const TARGET = 900;
    const rows = [];
    for (let i = 0; i < reports.length; i++) {
      const r = reports[i];
      const p = path.join(repoRoot, r.photo);
      const buf = fs.readFileSync(p);
      const raw = jpegDecode(buf, { useTArray: true });
      const { rgba, w, h } = bilinearResize(raw.data, raw.width, raw.height, TARGET);
      const t0 = Date.now();
      const res = countTeethFromRgba(rgba, w, h);
      const ms = Date.now() - t0;
      rows.push({ stamp: r.stamp, actual: r.actual, b86: r.b86, cur: res.toothCount, ms });
      process.stdout.write(`[${i+1}/${reports.length}] ${r.stamp} actual=${r.actual} b86=${r.b86} cur=${res.toothCount} (${ms}ms)\n`);
    }

    const buckets = {
      '11-15T (strict)': { range: [11, 15], strict: true },
      '18-28T (±1)':     { range: [18, 28], strict: false },
    };
    for (const [name, cfg] of Object.entries(buckets)) {
      const inBucket = rows.filter(r => r.actual >= cfg.range[0] && r.actual <= cfg.range[1]);
      if (inBucket.length === 0) continue;
      const ok = (a, d) => cfg.strict ? a === d : Math.abs(a - d) <= 1;
      const curOk  = inBucket.filter(r => ok(r.actual, r.cur)).length;
      const b86Ok  = inBucket.filter(r => ok(r.actual, r.b86)).length;
      process.stdout.write(`\n${name}: b86_baseline=${b86Ok}/${inBucket.length}  current=${curOk}/${inBucket.length}\n`);
      for (const r of inBucket) {
        process.stdout.write(`  ${r.stamp}  actual=${r.actual}  b86=${r.b86}  cur=${r.cur}  ${ok(r.actual, r.cur) ? 'OK' : 'FAIL'}\n`);
      }
    }
  });
});
