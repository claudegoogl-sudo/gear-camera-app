/**
 * PAP-537 diagnostic harness — b95 11T failure (small gear in aim-circle crop).
 *
 * Reproduces the b95 pipeline for the 07:16:03 report:
 *   1. load original 4000×3000 photo
 *   2. crop to aim-circle bounding square (CameraScreen.cropToAimCircle)
 *      using the same math b95 uses on a typical portrait 1080×2400 screen
 *   3. apply the circular mask the algorithm applies when aimCrop is set
 *   4. bilinear-resample to 900px (same as loadAndDecodeImage default)
 *   5. run countTeethFromRgba and print per-stage diagnostics
 *
 * Also sweeps crop sizes (0.6× / 0.75× / 1.0× / 1.25× aim-circle width) as a
 * quick look at whether a tighter re-crop would rescue the 11T detection.
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap537.harness npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');
const runner = require('./lib/harness-runner');
// Custom crop sweep: this harness writes diagnostics through console.log —
// don't silence; only borrow algorithm + DEBUG_DIR via the shared runner.
const { DEBUG_DIR, TARGET_MAX_DIM } = runner;
const { countTeethFromRgba } = runner.getAlgo();
const TARGET_DOWN = TARGET_MAX_DIM;

// Typical portrait device used during board testing.  The measured
// `gearCenter.y` for the 14-28T cluster was ≈ 0.422-0.431 (see PAP-537 evidence
// table), so the aim-circle photoCY lands at ≈ 0.425 × fullH.  AIM_CIRCLE_FRAC
// is 0.95 (matches CameraScreen constant).
const SW = 1080, SH = 2400;
const AIM_CIRCLE_FRAC = 0.95;

function cropToAimCircleHost(rgba, W, H, fracScale = 1.0) {
  const scale = Math.max(SW / W, SH / H);
  const visW = SW / scale;
  const visH = SH / scale;
  const minVis = Math.min(visW, visH);
  const side = Math.min(
    Math.round(AIM_CIRCLE_FRAC * minVis * fracScale),
    W,
    H,
  );
  const visOriginX = (W - SW / scale) / 2;
  const visOriginY = (H - SH / scale) / 2;
  const acx = SW / 2;
  const acy = SH / 2;
  const photoCX = visOriginX + acx / scale;
  const photoCY = visOriginY + acy / scale;
  const originX = Math.max(0, Math.min(W - side, Math.round(photoCX - side / 2)));
  const originY = Math.max(0, Math.min(H - side, Math.round(photoCY - side / 2)));

  const out = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    const srcRow = (originY + y) * W;
    for (let x = 0; x < side; x++) {
      const si = (srcRow + originX + x) * 4;
      const di = (y * side + x) * 4;
      out[di]   = rgba[si];
      out[di+1] = rgba[si+1];
      out[di+2] = rgba[si+2];
      out[di+3] = rgba[si+3];
    }
  }
  return {
    rgba: out, w: side, h: side,
    aimCrop: { originX, originY, side, fullW: W, fullH: H, photoCX, photoCY },
  };
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

function applyCircularMaskHost(rgba, w, h) {
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const R = 0.49 * Math.min(w, h);
  const R2 = R * R;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx*dx + dy*dy > R2) {
        const i = (y * w + x) * 4;
        rgba[i] = 255; rgba[i+1] = 255; rgba[i+2] = 255; rgba[i+3] = 255;
      }
    }
  }
}

describe('PAP-537 11T repro', () => {
  jest.setTimeout(10 * 60 * 1000);

  test('reproduce b95 11T failure @ 07:16:03', () => {
    const photo = path.join(DEBUG_DIR, 'report_2026-04-24_07-16-03-083Z', 'photo.jpg');
    const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
    console.log(`\n=== PAP-537 11T repro (photo=${raw.width}×${raw.height}) ===`);

    const sweeps = [
      { label: 'b95-default (1.00×aim)',    frac: 1.00 },
      { label: 'tight 0.75×aim',            frac: 0.75 },
      { label: 'tight 0.60×aim',            frac: 0.60 },
      { label: 'tight 0.50×aim',            frac: 0.50 },
      { label: 'loose 1.25×aim',            frac: 1.25 },
    ];
    const results = [];
    for (const s of sweeps) {
      const c = cropToAimCircleHost(raw.data, raw.width, raw.height, s.frac);
      applyCircularMaskHost(c.rgba, c.w, c.h);
      const dn = bilinearResize(c.rgba, c.w, c.h, TARGET_DOWN);
      const out = countTeethFromRgba(dn.rgba, dn.w, dn.h);
      const radiusFracOfCrop = out.gearRadius;
      const radiusPxInCrop = radiusFracOfCrop * dn.w;
      const radiusPxInPhoto = (radiusFracOfCrop * dn.w / dn.w) * c.w;
      console.log(
        `${s.label.padEnd(26)} side=${c.w}px → dn=${dn.w} ` +
        `| res=${out.toothCount}T(${(out.confidence*100).toFixed(0)}%) ` +
        `ctr=(${out.gearCenter.x.toFixed(3)},${out.gearCenter.y.toFixed(3)}) ` +
        `r=${(out.gearRadius*100).toFixed(1)}% (≈${radiusPxInCrop.toFixed(0)}px-dn / ${radiusPxInPhoto.toFixed(0)}px-photo) ` +
        `via=${out.methodUsed} ` +
        `peak=${out.peakTc}(${(out.peakRel||0).toFixed(2)}) ` +
        `fft90=${out.fft90tc} ` +
        `bc=${out.bcTc}(pur=${(out.bcPurity||0).toFixed(2)},pk=${out.bcPeaks}) ` +
        `op=${out.opTc}(${(out.opRel||0).toFixed(2)})`
      );
      results.push({ label: s.label, frac: s.frac, out, sidePhoto: c.w, sideDown: dn.w });
    }
    console.log(`\n  (11T target: result should be 11T)\n`);
  });
});
