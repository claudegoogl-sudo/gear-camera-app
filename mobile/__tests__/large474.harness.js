/**
 * PAP-474 diagnostic harness — large-gear (22-28T) b91 window.
 *
 * Runs current gearCounter on all labeled 22-28T reports from build 91
 * to confirm the tc=10 / conf~0.53 fallback failure mode observed in
 * field reports 2026-04-23_07-08-24-015Z (28T) and 2026-04-23_07-14-56-462Z (24T).
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPORTS = path.join(REPO_ROOT, 'debug-reports');
const TARGET = 900;

function bilinearResize(rgba, w, h, targetMaxDim) {
  const max = Math.max(w, h);
  if (max <= targetMaxDim) return { rgba, w, h };
  const scale = targetMaxDim / max;
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = (y + 0.5) * h / nh - 0.5;
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(h - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < nw; x++) {
      const sx = (x + 0.5) * w / nw - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(w - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const i00 = (y0*w+x0)*4, i01 = (y0*w+x1)*4, i10 = (y1*w+x0)*4, i11 = (y1*w+x1)*4;
      const io = (y*nw+x)*4;
      for (let c = 0; c < 4; c++) {
        const v = (rgba[i00+c]*(1-fx)+rgba[i01+c]*fx)*(1-fy)
                + (rgba[i10+c]*(1-fx)+rgba[i11+c]*fx)*fy;
        out[io+c] = Math.round(v);
      }
    }
  }
  return { rgba: out, w: nw, h: nh };
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/[^\x00-\x7F]+/g, '?')); }
  catch { return null; }
}

function parseBuild(b) {
  const m = String(b || '').match(/\((\d+)\)/);
  return m ? Number(m[1]) : 0;
}

function loadWindow(minBuild, maxBuild) {
  const rows = [];
  for (const f of fs.readdirSync(REPORTS).sort()) {
    if (!f.endsWith('_report.json')) continue;
    const meta = readJson(path.join(REPORTS, f));
    const actual = meta && (meta.actualTeethCount || meta.actual_tooth_count);
    if (!actual || actual < 22 || actual > 28) continue;
    const build = parseBuild(meta.build);
    if (build < minBuild || build > maxBuild) continue;
    const photo = path.join(REPORTS, f.replace('_report.json', '_photo.jpg'));
    if (!fs.existsSync(photo)) continue;
    rows.push({
      stamp: f.replace('_report.json', ''),
      build: 'b' + build,
      actual: Number(actual),
      prior: meta.result?.toothCount || 0,
      priorConf: meta.result?.confidence || 0,
      photo,
    });
  }
  return rows;
}

describe('PAP-474 large-gear b91 diagnostic', () => {
  jest.setTimeout(30 * 60 * 1000);
  test('b91 22-28T labeled reports — per-report diagnostic', () => {
    const { countTeethFromRgba } = require('../src/algorithm/gearCounter');
    const rows = loadWindow(91, 91);
    console.log(`\n=== PAP-474 large-gear (22-28T) b91 window: n=${rows.length} ===\n`);
    let hits = 0;
    const perClass = {};
    for (const r of rows) {
      const buf = fs.readFileSync(r.photo);
      const raw = jpegDecode(buf, { useTArray: true });
      const { rgba, w, h } = bilinearResize(raw.data, raw.width, raw.height, TARGET);
      const out = countTeethFromRgba(rgba, w, h);
      const hit = out.toothCount === r.actual;
      if (hit) hits++;
      perClass[r.actual] = perClass[r.actual] || { n: 0, hits: 0 };
      perClass[r.actual].n++;
      if (hit) perClass[r.actual].hits++;

      console.log(
        `${hit ? 'HIT ' : 'MISS'} ${r.stamp} ${r.build} actual=${r.actual} ` +
        `prior=${r.prior}T(${(r.priorConf*100).toFixed(0)}%) ` +
        `now=${out.toothCount}T(${(out.confidence*100).toFixed(0)}%) ` +
        `gearR=${(out.gearRadius*100).toFixed(1)}% ` +
        `ctr=(${out.gearCenter.x.toFixed(2)},${out.gearCenter.y.toFixed(2)}) ` +
        `via=${out.methodUsed} ` +
        `peak=${out.peakTc}(${(out.peakRel||0).toFixed(3)}) ` +
        `fft90=${out.fft90tc} ` +
        `bc=${out.bcTc}(pur=${(out.bcPurity||0).toFixed(3)},peaks=${out.bcPeaks}) ` +
        `op=${out.opTc}(${(out.opRel||0).toFixed(3)})`
      );
    }
    const pct = rows.length ? (hits/rows.length*100).toFixed(1) : '0';
    console.log(`\n=== OVERALL: ${hits}/${rows.length} = ${pct}% ===`);
    console.log('Per-class:');
    for (const k of Object.keys(perClass).sort((a,b)=>+a-+b)) {
      const c = perClass[k];
      console.log(`  ${k}T: ${c.hits}/${c.n} = ${(c.hits/c.n*100).toFixed(0)}%`);
    }
  });
});
