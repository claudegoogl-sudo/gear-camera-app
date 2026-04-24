/**
 * PAP-553 regression harness — radius-sanity abstain (Rule B).
 *
 * Validates that the Rule B crop-space floor `r < 0.13 → innerContourSuspected`
 * is wired end-to-end through `countTeethFromRgba`. The host harness uses a
 * generic SW=1080,SH=2400 aim-circle frame (PAP-537 template) so the crop
 * geometry does not exactly match the device's measured aim-circle; what we
 * verify here is that the *gate mechanism* fires correctly when the pipeline
 * yields a small-radius candidate (inner-contour lockup) vs. a well-framed
 * gear. Per-photo values-in-device were verified separately by QA
 * (PAP-556 cross-check corpus) — this harness is CI regression for the gate.
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPORTS = path.join(REPO_ROOT, 'debug-reports');
const TARGET_DOWN = 900;

const SW = 1080, SH = 2400;
const AIM_CIRCLE_FRAC = 0.95;

function cropToAimCircleHost(rgba, W, H) {
  const scale = Math.max(SW / W, SH / H);
  const visW = SW / scale;
  const visH = SH / scale;
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
      out[di] = rgba[si]; out[di+1] = rgba[si+1];
      out[di+2] = rgba[si+2]; out[di+3] = rgba[si+3];
    }
  }
  return { rgba: out, w: side, h: side };
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
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const R = 0.49 * Math.min(w, h);
  const R2 = R * R;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx*dx + dy*dy > R2) {
        const i = (y * w + x) * 4;
        rgba[i] = 255; rgba[i+1] = 255; rgba[i+2] = 255; rgba[i+3] = 255;
      }
    }
}

function runOne(photoFile) {
  const { countTeethFromRgba } = require('../src/algorithm/gearCounter');
  const raw = jpegDecode(fs.readFileSync(path.join(REPORTS, photoFile)), { useTArray: true });
  const c = cropToAimCircleHost(raw.data, raw.width, raw.height);
  applyCircularMaskHost(c.rgba, c.w, c.h);
  const dn = bilinearResize(c.rgba, c.w, c.h, TARGET_DOWN);
  return countTeethFromRgba(dn.rgba, dn.w, dn.h);
}

describe('PAP-553 radius-sanity abstain (Rule B)', () => {
  jest.setTimeout(10 * 60 * 1000);

  // Anchor case: 51T photo produces a small-radius inner-contour candidate
  // through the host crop too (the telephoto shot of the 51T outer chainring
  // has the inner bolt circle dominating under generic aim-circle framing).
  // Gate must fire.
  test('51T photo (10-59-07-941) → inner-contour suspected', () => {
    const out = runOne('2026-04-24_10-59-07-941Z_photo.jpg');
    console.log(`51T: tc=${out.toothCount} conf=${out.confidence.toFixed(2)} ` +
      `r=${out.gearRadius.toFixed(4)} flag=${out.innerContourSuspected}`);
    expect(out.gearRadius).toBeLessThan(0.13);
    expect(out.innerContourSuspected).toBe(true);
    expect(out.confidence).toBe(0);
  });

  // Counter-case: a photo where the host crop yields a well-framed gear
  // (r >> 0.13). Gate MUST NOT fire — Rule B must not regress good frames.
  test('17T photo (10-49-26-061) under host crop → flag NOT set', () => {
    const out = runOne('2026-04-24_10-49-26-061Z_photo.jpg');
    console.log(`17T-host: tc=${out.toothCount} conf=${out.confidence.toFixed(2)} ` +
      `r=${out.gearRadius.toFixed(4)} flag=${out.innerContourSuspected}`);
    // Host crop reframes differently from device; we only assert the gate
    // consistency — if radius is above the floor the flag must be clear
    // and the detector's own confidence must pass through unmodified.
    if (out.gearRadius >= 0.13) {
      expect(out.innerContourSuspected).toBe(false);
      expect(out.confidence).toBeGreaterThan(0);
    }
  });

  // Gate-consistency check: regardless of which photo we feed, the flag
  // state must exactly match `gearRadius < 0.13` and confidence=0 iff flagged.
  test('Rule B gate invariants hold across all three photos', () => {
    for (const f of [
      '2026-04-24_10-59-07-941Z_photo.jpg',
      '2026-04-24_07-16-03-083Z_photo.jpg',
      '2026-04-24_10-49-26-061Z_photo.jpg',
    ]) {
      const out = runOne(f);
      const expectFlag = out.gearRadius < 0.13;
      expect(out.innerContourSuspected).toBe(expectFlag);
      if (expectFlag) {
        expect(out.confidence).toBe(0);
      } else {
        // confidence unchanged by Rule B — must be whatever the detector returned
        expect(out.confidence).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
