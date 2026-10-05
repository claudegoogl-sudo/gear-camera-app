/**
 * PAP-1948 AC3: hub-star-dominant 36T sprocket must not emit an off-gear
 * contour. Fixture = b159 Sentry event 23275ba4 cropped.jpg (36T, device
 * radius 0.106 = inside the 5-arm hub star). QA-approved rule PAP-1949.
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });
const fs = require('fs');
const path = require('path');
const { decode } = require('jpeg-js');
const algo = require('../src/algorithm/gearCounter');
const { applyCircularMask } = require('../src/algorithm/imageUtils');

const FIX = path.join(__dirname, 'fixtures', 'pap1948', '23275ba4_36T_hubstar_cropped.jpg');

describe('PAP-1948 hub-star localization gate', () => {
  test('helper: abstain-only, threshold 0.30*min(w,h)', () => {
    const f = algo.pap1948HubStarLocalization;
    expect(algo.PAP1948_HUBSTAR_PEAKR_FRAC).toBe(0.30);
    expect(f(166, 900, 900, 0, true)).toBe(true);      // 23275ba4-like
    expect(f(233, 900, 900, 0, false)).toBe(true);     // tc=0 counts as abstain
    expect(f(311, 900, 900, 0, true)).toBe(false);     // good geometry abstain
    expect(f(166, 900, 900, 36, false)).toBe(false);   // committed: never touched
    expect(f(0, 900, 900, 0, true)).toBe(false);       // no peak: no claim
  });

  test('23275ba4 (36T hub-star dominant): explicit localization abstain, no contour', () => {
    const raw = decode(fs.readFileSync(FIX), { useTArray: true, maxMemoryUsageInMB: 2048 });
    const { rgba, width: w, height: h } = algo.bilinearDownsampleRgba(raw.data, raw.width, raw.height, 900);
    applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
    const r = algo.countTeethFromRgba(rgba, w, h);
    expect(r.toothCount).toBe(0);
    expect(r.abstained).toBe(true);
    expect(r.abstainReason).toBe('pap1948-localization-failure');
    expect(r.methodUsed).toContain('+pap1948-hubstar-localization');
    expect(r.gearCenter).toBeNull();
    expect(r.gearRadius).toBeNull();
    expect(r.peakR).toBeLessThan(0.30 * Math.min(w, h));
  }, 120000);
});
