/**
 * PAP-391 Option 4 diagnostic: force JS to use Python's center/radius and
 * observe fft90/peak/bc outputs. Compares analyzer auto center vs injected
 * Python-reference center.
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

describe('option4 diag', () => {
  jest.setTimeout(5 * 60 * 1000);
  test('injected centers on 05-51-49 (28T)', () => {
    const mod = require('../src/algorithm/gearCounter');
    const { __test } = mod;

    const photoRel = 'debug-reports/report_2026-04-21_05-51-49-491Z/photo.jpg';
    const repoRoot = path.resolve(__dirname, '..', '..');
    const p = path.resolve(repoRoot, photoRel);
    if (!fs.existsSync(p)) { console.log('MISSING', p); return; }
    const buf = fs.readFileSync(p);
    const raw = jpegDecode(buf, { useTArray: true });

    const { rgba, w, h } = bilinearResize(raw.data, raw.width, raw.height, 900);
    const gray     = __test.rgbaToGray(rgba, w, h);
    const enhanced = __test.clahe(gray, w, h, 3.0, 8, 8);
    const blurred  = __test.gaussianBlur5x5(enhanced, w, h);
    const edges    = __test.cannyEdges(blurred, w, h, 50, 150);

    console.log(`\n=== ${photoRel} (28T label, ${w}x${h}) ===`);

    const auto = mod.countTeethFromRgba(rgba, w, h);
    console.log(`AUTO center=(${(auto.gearCenter.x*w).toFixed(0)},${(auto.gearCenter.y*h).toFixed(0)}) r=${(auto.gearRadius*w).toFixed(0)} => ${auto.toothCount}T (${auto.methodUsed}) fft90=${auto.fft90tc} peak=${auto.peakTc} bcPeaks=${auto.bcPeaks}`);

    // Python center=(375,425) r=117 at 1000-px max, scale 0.9 => (338,382) r=105
    const candidates = [
      { tag: 'py@900 scaled', cx: 338, cy: 382, r: 105 },
      { tag: 'py@900 r=117',  cx: 338, cy: 382, r: 117 },
      { tag: 'py@900 r=130',  cx: 338, cy: 382, r: 130 },
      { tag: 'py@900 r=95',   cx: 338, cy: 382, r: 95  },
      { tag: 'py@900 r=85',   cx: 338, cy: 382, r: 85  },
    ];

    for (const c of candidates) {
      const res = __test.analyzeImageAtCenter(gray, enhanced, edges, w, h, c.cx, c.cy, c.r);
      console.log(`FORCED ${c.tag} center=(${c.cx},${c.cy}) r=${c.r} => ${res.toothCount}T (${res.methodUsed}) fft90=${res.fft90tc} peak=${res.peakTc}(rel=${res.peakRel?.toFixed(3)}) bc=${res.bcTc}(peaks=${res.bcPeaks},pur=${res.bcPurity?.toFixed(3)}) op=${res.opTc}(rel=${res.opRel?.toFixed(3)})`);
    }
  });
});
