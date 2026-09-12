/**
 * PAP-1898: silhouette-anchored localization helpers.
 *
 * pap1898SilhouetteFit — 720-angle inward walk from the mask boundary +
 * trimmed Kasa circle fit. pap1898RimSupport — 360-ray angular edge support.
 * These are the PAP-1897 wrong-center rescue primitives (dense chainrings).
 */

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

import { __test } from '../src/algorithm/gearCounter.js';

const { pap1898SilhouetteFit, pap1898RimSupport } = __test;

const W = 900, H = 900;

function circleEdges(cx, cy, r, { thickness = 1, noise = 0 } = {}) {
  const edges = new Uint8Array(W * H);
  for (let a = 0; a < 3600; a++) {
    const t = (2 * Math.PI * a) / 3600;
    for (let dt = 0; dt < thickness; dt++) {
      const x = Math.round(cx + (r + dt) * Math.cos(t));
      const y = Math.round(cy + (r + dt) * Math.sin(t));
      if (x >= 0 && x < W && y >= 0 && y < H) edges[y * W + x] = 1;
    }
  }
  // deterministic pseudo-noise
  let s = 12345;
  for (let i = 0; i < noise; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const x = s % W;
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const y = s % H;
    edges[y * W + x] = 1;
  }
  return edges;
}

describe('pap1898SilhouetteFit', () => {
  test('recovers a clean full circle (center + radius)', () => {
    const edges = circleEdges(452, 448, 300);
    const { coverage, fit } = pap1898SilhouetteFit(edges, W, H);
    expect(coverage).toBeGreaterThanOrEqual(0.95);
    expect(fit).not.toBeNull();
    expect(Math.abs(fit.cx - 452)).toBeLessThanOrEqual(4);
    expect(Math.abs(fit.cy - 448)).toBeLessThanOrEqual(4);
    expect(Math.abs(fit.r - 300)).toBeLessThanOrEqual(6);
  });

  test('trimmed fit rejects scattered outlier points', () => {
    const edges = circleEdges(450, 450, 260, { noise: 1500 });
    const { coverage, fit } = pap1898SilhouetteFit(edges, W, H);
    expect(coverage).toBeGreaterThanOrEqual(0.95);
    expect(fit).not.toBeNull();
    expect(Math.abs(fit.cx - 450)).toBeLessThanOrEqual(6);
    expect(Math.abs(fit.cy - 450)).toBeLessThanOrEqual(6);
    expect(Math.abs(fit.r - 260)).toBeLessThanOrEqual(8);
  });

  test('depth gate rejects a 35% contiguous inner-ring sector (PAP-1901 ref.1)', () => {
    // bolt-circle / spider-arm shape: a contiguous 35% angular sector walks
    // much deeper (inner ring at 0.55r) than the true silhouette at r=380.
    // keep-70% trimming alone converges onto the sector; the depth gate must
    // arm (>=12% deep-latched angles) and recover the silhouette.
    const edges = circleEdges(450, 450, 380);
    const cx0 = 450, cy0 = 450, maxR = 435;
    for (let a = 0; a < 0.35 * 720; a++) {
      const t = (2 * Math.PI * a) / 720;
      for (let r = maxR; r > 200; r--) {
        const x = Math.round(cx0 + r * Math.cos(t));
        const y = Math.round(cy0 + r * Math.sin(t));
        edges[y * W + x] = 0; // erase the silhouette along the sector
      }
      for (let dt = 0; dt < 2; dt++) {
        const x = Math.round(cx0 + (205 + dt) * Math.cos(t));
        const y = Math.round(cy0 + (205 + dt) * Math.sin(t));
        if (x >= 0 && x < W && y >= 0 && y < H) edges[y * W + x] = 1;
      }
    }
    const { coverage, fit } = pap1898SilhouetteFit(edges, W, H);
    expect(coverage).toBeGreaterThanOrEqual(0.6);
    expect(fit).not.toBeNull();
    expect(Math.abs(fit.cx - 450)).toBeLessThanOrEqual(6);
    expect(Math.abs(fit.cy - 450)).toBeLessThanOrEqual(6);
    expect(Math.abs(fit.r - 380)).toBeLessThanOrEqual(8);
  });

  test('clean circle is untouched by the depth gate (equals untrimmed Kasa)', () => {
    // PAP-1901 refinement 2 (corpus lesson): annulus placement is
    // load-bearing, so the gate must stay inert on uncontaminated rims.
    const edges = circleEdges(452, 448, 300);
    const pts = __test.pap1898SilhouettePoints(edges, W, H);
    const { fit } = pap1898SilhouetteFit(edges, W, H);
    // untrimmed Kasa on the same points
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0, sz = 0;
    for (const pt of pts) {
      const z = pt.x * pt.x + pt.y * pt.y;
      sx += pt.x; sy += pt.y; sxx += pt.x * pt.x; sxy += pt.x * pt.y;
      syy += pt.y * pt.y; sxz += pt.x * z; syz += pt.y * z; sz += z;
    }
    const n = pts.length;
    // Solve the same 4x4 normal system via Cramer (small helper, test-only).
    const M = [[sxx, sxy, sx, sxz], [sxy, syy, sy, syz], [sx, sy, n, sz]];
    const rhs = [sxz, syz, sz];
    // Solve M3x3 * [A,B,C] = rhs via Cramer's rule
    const det3 = (m) =>
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
      - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
      + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const m1 = [[rhs[0], M[0][1], M[0][2]], [rhs[1], M[1][1], M[1][2]], [rhs[2], M[2][1], M[2][2]]];
    const m2 = [[M[0][0], rhs[0], M[0][2]], [M[1][0], rhs[1], M[1][2]], [M[2][0], rhs[2], M[2][2]]];
    const m3 = [[M[0][0], M[0][1], rhs[0]], [M[1][0], M[1][1], rhs[1]], [M[2][0], M[2][1], rhs[2]]];
    const D = det3([M[0].slice(0, 3), M[1].slice(0, 3), M[2].slice(0, 3)]);
    const A = det3(m1) / D, B = det3(m2) / D, C = det3(m3) / D;
    const kx = A / 2, ky = B / 2;
    const kr = Math.sqrt(C + kx * kx + ky * ky);
    expect(fit.cx).toBeCloseTo(kx, 0);
    expect(fit.cy).toBeCloseTo(ky, 0);
    expect(fit.r).toBeCloseTo(kr, 0);
  });

  test('returns fit:null when there are almost no edge points', () => {
    const edges = new Uint8Array(W * H);
    const { coverage, fit } = pap1898SilhouetteFit(edges, W, H);
    expect(coverage).toBe(0);
    expect(fit).toBeNull();
  });
});

describe('pap1898RimSupport', () => {
  test('a full circle rim scores ~1.0', () => {
    const edges = circleEdges(450, 450, 300);
    const s = pap1898RimSupport(edges, W, H, 450, 450, 300);
    expect(s).toBeGreaterThanOrEqual(0.9);
  });

  test('a half arc scores ~0.5', () => {
    const edges = new Uint8Array(W * H);
    for (let a = 0; a < 1800; a++) {
      const t = (2 * Math.PI * a) / 3600;
      const x = Math.round(450 + 300 * Math.cos(t));
      const y = Math.round(450 + 300 * Math.sin(t));
      if (x >= 0 && x < W && y >= 0 && y < H) edges[y * W + x] = 1;
    }
    const s = pap1898RimSupport(edges, W, H, 450, 450, 300);
    expect(s).toBeGreaterThanOrEqual(0.35);
    expect(s).toBeLessThanOrEqual(0.65);
  });

  test('empty edges score 0', () => {
    const edges = new Uint8Array(W * H);
    expect(pap1898RimSupport(edges, W, H, 450, 450, 300)).toBe(0);
  });
});

describe('pap1898ShouldRescue', () => {
  const { pap1898ShouldRescue } = __test;
  const MASK_R = 0.49 * Math.min(W, H); // 441

  // draws INTO the given edge map (Uint8Array.set would replace it wholesale)
  function drawHalfArc(edges, cx, cy, r) {
    for (let a = 0; a < 1800; a++) {
      const t = (2 * Math.PI * a) / 3600;
      const x = Math.round(cx + r * Math.cos(t));
      const y = Math.round(cy + r * Math.sin(t));
      if (x >= 0 && x < W && y >= 0 && y < H) edges[y * W + x] = 1;
    }
    return edges;
  }

  test('refuses a mask-boundary-latch silhouette (FP5-b151 anchor B class)', () => {
    // silhouette "fit" at 0.943·maskR (the vignette/mask-edge latch), pick
    // deep inside as a partial arc: small-lock geometry would fire without
    // the proximity refusal.
    const edges = circleEdges(450, 450, 416);
    const picked = { cx: 450, cy: 450, radius: 200 };
    const sil = { coverage: 1, fit: { cx: 450, cy: 450, r: 416 } };
    const v = pap1898ShouldRescue(edges, W, H, picked, sil);
    expect(v.fire).toBe(false);
    expect(v.reason).toBe('mask-boundary-latch');
  });

  test('same geometry just inside the ceiling still fires (small-lock)', () => {
    const edges = drawHalfArc(circleEdges(450, 450, 390), 450, 450, 200);
    const picked = { cx: 450, cy: 450, radius: 200 };
    const sil = { coverage: 1, fit: { cx: 450, cy: 450, r: 390 } };
    const v = pap1898ShouldRescue(edges, W, H, picked, sil);
    expect(v.fire).toBe(true);
    expect(v.arm).toBe('small-lock');
  });

  test('ceiling boundary: 396 (0.898·maskR) fires, 399 (0.905·maskR) refuses', () => {
    const picked = { cx: 450, cy: 450, radius: 200 };
    const sil = (r) => ({ coverage: 1, fit: { cx: 450, cy: 450, r } });
    const edgesIn = drawHalfArc(circleEdges(450, 450, 396), 450, 450, 200);
    expect(pap1898ShouldRescue(edgesIn, W, H, picked, sil(396)).fire).toBe(true);
    const edgesOut = circleEdges(450, 450, 399);
    const vOut = pap1898ShouldRescue(edgesOut, W, H, picked, sil(399));
    expect(vOut.fire).toBe(false);
    expect(vOut.reason).toBe('mask-boundary-latch');
    expect(399 / MASK_R).toBeGreaterThan(0.90);
    expect(396 / MASK_R).toBeLessThan(0.90);
  });

  test('no arm when radii are comparable (0.85–1.15 band)', () => {
    const edges = circleEdges(450, 450, 300);
    const picked = { cx: 450, cy: 450, radius: 290 };
    const sil = { coverage: 1, fit: { cx: 450, cy: 450, r: 300 } };
    const v = pap1898ShouldRescue(edges, W, H, picked, sil);
    expect(v.fire).toBe(false);
    expect(v.reason).toBe('no-arm');
  });

  test('poor silhouette coverage never fires', () => {
    const edges = new Uint8Array(W * H);
    const sil = { coverage: 0.5, fit: { cx: 450, cy: 450, r: 300 } };
    const v = pap1898ShouldRescue(edges, W, H, { cx: 450, cy: 450, radius: 200 }, sil);
    expect(v.fire).toBe(false);
    expect(v.reason).toBe('fit-quality');
  });
});
