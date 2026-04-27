/**
 * PAP-391 diagnostic: measure JS fftPurityCheck (findGearCenter's own
 * arbiter) at a grid of (cx,cy,r) combinations to determine whether the
 * correct Python center dominates JS's wrong big-blob center under JS's
 * own purity metric.
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
        const v = (rgba[i00+c]*(1-fx)+rgba[i01+c]*fx)*(1-fy) + (rgba[i10+c]*(1-fx)+rgba[i11+c]*fx)*fy;
        out[io+c] = Math.round(v);
      }
    }
  }
  return { rgba: out, w: nw, h: nh };
}

describe('purity grid diag', () => {
  jest.setTimeout(5 * 60 * 1000);
  test('fftPurityCheck at grid of centers (05-51-49, 28T)', () => {
    const mod = require('../src/algorithm/gearCounter');
    const { __test } = mod;
    const repoRoot = path.resolve(__dirname, '..', '..');
    const p = path.resolve(repoRoot, 'debug-reports/report_2026-04-21_05-51-49-491Z/photo.jpg');
    const buf = fs.readFileSync(p);
    const raw = jpegDecode(buf, { useTArray: true });
    const { rgba, w, h } = bilinearResize(raw.data, raw.width, raw.height, 900);
    const gray = __test.rgbaToGray(rgba, w, h);
    const enhanced = __test.clahe(gray, w, h, 3.0, 8, 8);

    console.log('\n=== fftPurityCheck grid on 05-51-49 (28T) ===');

    // Python center vs JS small candidate vs JS big candidate; try each radius.
    const cases = [
      { tag: 'py-ctr', cx: 338, cy: 383 },
      { tag: 'js-small', cx: 370, cy: 405 },
      { tag: 'js-big', cx: 393, cy: 396 },
    ];
    const radii = [85, 95, 104, 117, 130, 179, 240, 277];
    for (const c of cases) {
      for (const r of radii) {
        const pu = __test.fftPurityCheck(enhanced, c.cx, c.cy, r, w, h);
        console.log(`  ${c.tag} (${c.cx},${c.cy}) r=${r} purity=${pu.toFixed(4)}`);
      }
    }

    // Also sweep a 5-point grid around JS-small candidate to find the max-purity
    // offset — models "ellipse-fit" refinement as a local search.
    console.log('\n-- local refine around js-small (370,405) r=104 --');
    let bestP = 0, bestOff = null;
    for (let dx = -40; dx <= 40; dx += 8) {
      for (let dy = -40; dy <= 40; dy += 8) {
        const cx = 370 + dx, cy = 405 + dy;
        const pu = __test.fftPurityCheck(enhanced, cx, cy, 117, w, h);
        if (pu > bestP) { bestP = pu; bestOff = { dx, dy, cx, cy }; }
      }
    }
    console.log(`  best in ±40px grid: offset=(${bestOff.dx},${bestOff.dy}) center=(${bestOff.cx},${bestOff.cy}) purity=${bestP.toFixed(4)}`);
  });
});
