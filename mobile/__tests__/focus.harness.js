/**
 * Focused diagnostic harness — one image, full method breakdown.
 * Usage: FOCUS_PHOTO=debug-reports/2026-04-21_05-48-17-838Z_photo.jpg \
 *        npx jest --testMatch="**\/focus.harness.js"
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

describe('focused diag', () => {
  jest.setTimeout(5 * 60 * 1000);
  test('one image, full breakdown', () => {
    const photos = (process.env.FOCUS_PHOTO || '').split(',').filter(Boolean);
    if (!photos.length) { console.log('no FOCUS_PHOTO set'); return; }
    const { countTeethFromRgba } = require('../src/algorithm/gearCounter');
    const repoRoot = path.resolve(__dirname, '..', '..');
    for (const relp of photos) {
      const p = path.resolve(repoRoot, relp);
      if (!fs.existsSync(p)) { console.log('missing', p); continue; }
      const buf = fs.readFileSync(p);
      const raw = jpegDecode(buf, { useTArray: true });
      const { rgba, w, h } = bilinearResize(raw.data, raw.width, raw.height, 900);
      const t0 = Date.now();
      const r = countTeethFromRgba(rgba, w, h);
      console.log(`\n=== ${relp} ===`);
      console.log(`  input ${raw.width}x${raw.height} -> ${w}x${h}`);
      console.log(`  runtime=${Date.now()-t0}ms method=${r.methodUsed}`);
      console.log(`  result=${r.toothCount}T conf=${r.confidence.toFixed(3)}`);
      console.log(`  bc=${r.bcTc}T(pur=${r.bcPurity.toFixed(3)},peaks=${r.bcPeaks})`);
      console.log(`  peak=${r.peakTc}T(rel=${r.peakRel.toFixed(3)}) fft90=${r.fft90tc}T op=${r.opTc}T(rel=${r.opRel.toFixed(3)})`);
      console.log(`  center=(${(r.gearCenter.x*w).toFixed(0)},${(r.gearCenter.y*h).toFixed(0)}) radius=${(r.gearRadius*w).toFixed(0)}`);
    }
  });
});
