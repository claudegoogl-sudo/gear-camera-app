/**
 * PAP-537 fix-proposal verification — quick cross-check against two specific
 * cases:
 *   1. PAP-537 11T regression (07:16:03 photo + aim-circle crop)
 *      — currently fails: mid-op-override promotes 17T over FFT consensus of 11T
 *   2. PAP-407 mid-op-override target (b86 19-18-26, 19T gear)
 *      — currently passes: op=18 rescues FFT collapse
 *
 * Goal: confirm peak/fft90 values at each case so we can pick a gate that
 * preserves (2) while fixing (1).
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPORTS = path.join(REPO_ROOT, 'debug-reports');
const TARGET = 900;

const SW = 1080, SH = 2400;
const AIM_CIRCLE_FRAC = 0.95;

function cropToAimCircleHost(rgba, W, H) {
  const scale = Math.max(SW / W, SH / H);
  const visW = SW / scale, visH = SH / scale;
  const minVis = Math.min(visW, visH);
  const side = Math.min(Math.round(AIM_CIRCLE_FRAC * minVis), W, H);
  const visOriginX = (W - SW / scale) / 2;
  const visOriginY = (H - SH / scale) / 2;
  const photoCX = visOriginX + (SW / 2) / scale;
  const photoCY = visOriginY + (SH / 2) / scale;
  const originX = Math.max(0, Math.min(W - side, Math.round(photoCX - side / 2)));
  const originY = Math.max(0, Math.min(H - side, Math.round(photoCY - side / 2)));
  const out = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    const srcRow = (originY + y) * W;
    for (let x = 0; x < side; x++) {
      const si = (srcRow + originX + x) * 4;
      const di = (y * side + x) * 4;
      out[di]=rgba[si]; out[di+1]=rgba[si+1]; out[di+2]=rgba[si+2]; out[di+3]=rgba[si+3];
    }
  }
  return { rgba: out, w: side, h: side };
}

function applyCircularMaskHost(rgba, w, h) {
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const R2 = (0.49 * Math.min(w, h)) ** 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx*dx + dy*dy > R2) {
        const i = (y * w + x) * 4;
        rgba[i]=255; rgba[i+1]=255; rgba[i+2]=255; rgba[i+3]=255;
      }
    }
  }
}

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

describe('PAP-537 proposed-fix diagnostic cross-check', () => {
  jest.setTimeout(10 * 60 * 1000);

  test('case 1: 11T regression via aim-crop', () => {
    const photo = path.join(REPORTS, '2026-04-24_07-16-03-083Z_photo.jpg');
    const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
    const cr = cropToAimCircleHost(raw.data, raw.width, raw.height);
    applyCircularMaskHost(cr.rgba, cr.w, cr.h);
    const dn = bilinearResize(cr.rgba, cr.w, cr.h, TARGET);
    const { countTeethFromRgba } = require('../src/algorithm/gearCounter');
    const out = countTeethFromRgba(dn.rgba, dn.w, dn.h);
    console.log(`\n[case1 11T, aim-cropped 1283px→${dn.w}] actual=11 result=${out.toothCount} conf=${(out.confidence*100).toFixed(0)}% ` +
      `peak=${out.peakTc}(${(out.peakRel||0).toFixed(3)}) fft90=${out.fft90tc} ` +
      `bc=${out.bcTc}(pur=${(out.bcPurity||0).toFixed(3)},pk=${out.bcPeaks}) ` +
      `op=${out.opTc}(${(out.opRel||0).toFixed(3)}) via=${out.methodUsed}`);
  });

  test('case 2: b86 19-18-26 mid-op-override target (no aim crop, raw photo)', () => {
    const photo = path.join(REPORTS, '2026-04-21_19-18-26-917Z_photo.jpg');
    const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
    const dn = bilinearResize(raw.data, raw.width, raw.height, TARGET);
    const { countTeethFromRgba } = require('../src/algorithm/gearCounter');
    const out = countTeethFromRgba(dn.rgba, dn.w, dn.h);
    console.log(`\n[case2 19T b86 raw ${dn.w}px] actual=19 result=${out.toothCount} conf=${(out.confidence*100).toFixed(0)}% ` +
      `peak=${out.peakTc}(${(out.peakRel||0).toFixed(3)}) fft90=${out.fft90tc} ` +
      `bc=${out.bcTc}(pur=${(out.bcPurity||0).toFixed(3)},pk=${out.bcPeaks}) ` +
      `op=${out.opTc}(${(out.opRel||0).toFixed(3)}) via=${out.methodUsed}`);
  });
});
