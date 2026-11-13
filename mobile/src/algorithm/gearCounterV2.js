/**
 * Gear tooth counter v2 — one measured pipeline, no retries, no tuning per gear size.
 *
 *   1. edges      : Sobel gradient magnitude on blurred gray, one robust threshold
 *   2. centre     : every edge pixel votes along its gradient line (both ways); a gear centre collects
 *                   the votes of all its concentric arcs (bore, root circle, tooth flanks)
 *   3. tooth ring : outermost radius band around that centre in which most rays hit an edge
 *   4. geometry   : circle fit, then ellipse fit (tilted camera), on the outline points of that band
 *   5. outline    : r(theta) = outermost edge of the band's own edge components, on ellipse-normalised rays
 *   6. count      : dominant frequency of r(theta) (FFT), then the exact number of cycles of the
 *                   narrow-band signal around it (winding number) — stays exact when the tooth pitch
 *                   varies slowly around the circle (perspective, centre offset)
 *   7. gates      : abstain with a reason when the outline is not tooth-shaped, cut off, or unclear
 *
 * Input: RGBA pixels of a frame that shows the WHOLE gear with some margin (no circular mask).
 * About 1000 px on the long side is enough; the gear can be anywhere in the frame.
 *
 * Measured numbers and how to reproduce them: docs/gear-counter-v2.md
 */

export const V2_PARAMS = {
  coarse: 320,        // long side of the image used for the centre vote
  fineBlur: 2,        // box blur radius before the gradient (width 5, sigma about 1.4)
  nTheta: 1024,       // outline samples (power of 2)
  kMin: 7, kMax: 80,  // tooth-count search range
  gradFloor: 40, gradK: 4, gradAdd: 20,   // edge threshold = max(floor, K * median(|grad|) + add)
  nCentres: 3,
  band: 1.14,         // radial width of the tooth band (outer / inner radius)
  occ: 0.55,          // min share of rays that hit an edge inside the band
  vis: 0.4,           // min share of rays that are inside the image at the band's outer radius
  keep: 0.04,         // an edge component belongs to the band when it holds >= this share of the band's hits
  bw: 0.18,           // relative width of the band-pass around the dominant frequency
  okPurity: 0.25, okEnv: 0.3,             // "good enough, stop searching"
  minAspect: 2.05,    // tooth count * tooth height / tip radius; chain teeth are about 2.1 - 5
  minValid: 0.7, maxMissing: 4,           // cut-off gears: visible share of the outline, max extrapolated teeth
  minPurity: 0.25, minEnv: 0.2, maxGaps: 0.3,
  minAxisRatio: 0.7,  // ellipse axis ratio below this = camera tilted more than about 45 degrees: not supported
};

// ── small numeric helpers ────────────────────────────────────────────────────

function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return NaN;
  const idx = (p / 100) * (n - 1), lo = Math.floor(idx), hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function sortedCopy(arr, mask) {
  const out = [];
  for (let i = 0; i < arr.length; i++) if (!mask || mask[i]) out.push(arr[i]);
  return Float64Array.from(out).sort();
}

/** Solve A x = b (n x n, row-major, in place) by Gaussian elimination with partial pivoting. Returns x or null. */
function solve(A, b, n) {
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[p * n + c])) p = r;
    if (Math.abs(A[p * n + c]) < 1e-12) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[p * n + k]; A[p * n + k] = t; }
      const t = b[c]; b[c] = b[p]; b[p] = t;
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / A[c * n + c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / A[r * n + r];
  }
  return x;
}

/** Least squares for rows M[i] (m values each) against target 1 or t[i], only rows with keep[i]. */
function lstsq(rows, m, target, keep) {
  const A = new Float64Array(m * m), b = new Float64Array(m);
  const n = rows.length / m;
  for (let i = 0; i < n; i++) {
    if (keep && !keep[i]) continue;
    const t = target ? target[i] : 1;
    for (let a = 0; a < m; a++) {
      const va = rows[i * m + a];
      b[a] += va * t;
      for (let c = a; c < m; c++) A[a * m + c] += va * rows[i * m + c];
    }
  }
  for (let a = 0; a < m; a++) for (let c = 0; c < a; c++) A[a * m + c] = A[c * m + a];
  return solve(A, b, m);
}

/** In-place radix-2 complex FFT. inverse=true gives the unscaled inverse (caller divides by n). */
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// ── image helpers ────────────────────────────────────────────────────────────
// These loops run in the Hermes interpreter on the phone, so they are written for few operations per pixel.

/** Luminance as (77 R + 150 G + 29 B) / 256. */
function rgbaToGray(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
  return g;
}

/** Box blur of width 2*rad+1 with running sums (cost does not depend on rad). Borders repeat the edge pixel. */
function boxBlur(src, w, h, rad) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), norm = 1 / (2 * rad + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = src[row] * (rad + 1);
    for (let i = 1; i <= rad; i++) s += src[row + Math.min(i, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s * norm;
      const add = x + rad + 1, sub = x - rad;
      s += src[row + (add < w ? add : w - 1)] - src[row + (sub > 0 ? sub : 0)];
    }
  }
  const acc = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let s = tmp[x] * (rad + 1);
    for (let i = 1; i <= rad; i++) s += tmp[Math.min(i, h - 1) * w + x];
    acc[x] = s;
  }
  for (let y = 0; y < h; y++) {
    const row = y * w, add = Math.min(y + rad + 1, h - 1) * w, sub = Math.max(y - rad, 0) * w;
    for (let x = 0; x < w; x++) {
      out[row + x] = acc[x] * norm;
      acc[x] += tmp[add + x] - tmp[sub + x];
    }
  }
  return out;
}

/** Sobel gradient magnitude (and, when wantDir, gx / gy) of an already blurred image, plus the robust edge threshold. */
function gradients(g, w, h, P, wantDir) {
  const mag = new Float32Array(w * h);
  const gx = wantDir ? new Float32Array(w * h) : null, gy = wantDir ? new Float32Array(w * h) : null;
  const hist = new Uint32Array(1024);            // |grad| in steps of 1, every 3rd pixel, for the median
  let nHist = 0;
  for (let y = 1; y < h - 1; y++) {
    const y0 = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = y0 + x;
      const a = g[i - w - 1], c = g[i - w + 1], p = g[i + w - 1], r = g[i + w + 1];
      const dx = c + r - a - p + 2 * (g[i + 1] - g[i - 1]), dy = p + r - a - c + 2 * (g[i + w] - g[i - w]);
      const m = Math.sqrt(dx * dx + dy * dy);
      mag[i] = m;
      if (wantDir) { gx[i] = dx; gy[i] = dy; }
      if (i % 3 === 0) { hist[m < 1023 ? m | 0 : 1023]++; nHist++; }
    }
  }
  let acc = 0, med = 0;
  for (let i = 0; i < 1024; i++) { acc += hist[i]; if (acc >= nHist / 2) { med = i + 0.5; break; } }
  return { gx, gy, mag, thr: Math.max(P.gradFloor, P.gradK * med + P.gradAdd) };
}

/** Hough-style centre vote. Returns [{x, y, votes}] in coarse-image pixels, best first. */
function voteCentres(G, w, h, P) {
  const { gx, gy, mag, thr } = G;
  const big = Math.max(w, h), m = Math.floor(0.25 * big);      // the centre of a cut-off gear may lie outside the image
  const W = w + 2 * m, H = h + 2 * m, tmax = Math.floor(0.6 * big);
  const acc = new Float32Array(W * H);
  let nEdges = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, mi = mag[i];
      if (mi <= thr) continue;
      const ux = gx[i] / mi, uy = gy[i] / mi;
      // thin the edge: vote only from the ridge of the gradient magnitude
      const sx = Math.round(ux), sy = Math.round(uy);
      if (mag[i + sy * w + sx] > mi || mag[i - sy * w - sx] >= mi) continue;
      nEdges++;
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        const dx = 2 * sgn * ux, dy = 2 * sgn * uy;       // steps of 2 px; the accumulator is smoothed afterwards
        let fx = x + m + 0.5 + 3 * dx, fy = y + m + 0.5 + 3 * dy;
        for (let t = 6; t < tmax; t += 2, fx += dx, fy += dy) {
          if (fx < 0 || fx >= W || fy < 0 || fy >= H) break;
          acc[(fy | 0) * W + (fx | 0)] += 1;
        }
      }
    }
  }
  if (nEdges < 15) return [];
  const sm = boxBlur(boxBlur(acc, W, H, 2), W, H, 2);
  const out = [], supp = Math.floor(0.08 * big);
  for (let c = 0; c < P.nCentres; c++) {
    let best = 0, bi = -1;
    for (let i = 0; i < sm.length; i++) if (sm[i] > best) { best = sm[i]; bi = i; }
    if (bi < 0 || (out.length && best < 0.25 * out[0].votes)) break;
    const px = bi % W, py = (bi - px) / W;
    out.push({ x: px - m, y: py - m, votes: best });
    for (let y = Math.max(0, py - supp); y <= Math.min(H - 1, py + supp); y++)
      for (let x = Math.max(0, px - supp); x <= Math.min(W - 1, px + supp); x++)
        if ((x - px) ** 2 + (y - py) ** 2 <= supp * supp) sm[y * W + x] = 0;
  }
  return out;
}

/** 8-connected component labels of mag > thr (0 = background). */
function labelEdges(mag, thr, w, h) {
  const lab = new Int32Array(w * h);
  const parent = [0];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const nb = [-1, -w - 1, -w, -w + 1];           // left, up-left, up, up-right (mag is 0 on the image border, so no bounds checks)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) {
      if (mag[i] <= thr) continue;
      let l = 0;
      for (let k = 0; k < 4; k++) {
        const o = lab[i + nb[k]];
        if (!o) continue;
        const r = find(o);
        if (!l) l = r;
        else if (r < l) { parent[l] = r; l = r; } else if (r > l) parent[r] = l;
      }
      if (!l) { l = parent.length; parent.push(l); }
      lab[i] = l;
    }
  }
  for (let i = 0; i < lab.length; i++) if (lab[i]) lab[i] = find(lab[i]);
  return { lab, nLabels: parent.length };
}

/**
 * hit[theta * rmax + r] = 1 when the pixel on ray theta at radius r is an edge of a kept component;
 * inside[...] = 1 when that sample is in the image. With ell = {a, b, phi} the rays are the images of
 * a circle's rays under the ellipse's affine map, and r counts pixels along the major axis.
 */
function polarHits(lab, keep, w, h, cx, cy, rmax, nTheta, ell) {
  const hit = new Uint8Array(nTheta * rmax), inside = new Uint8Array(nTheta * rmax);
  const cp = ell ? Math.cos(ell.phi) : 1, sp = ell ? Math.sin(ell.phi) : 0, q = ell ? ell.b / ell.a : 1;
  for (let t = 0; t < nTheta; t++) {
    const th = (2 * Math.PI * t) / nTheta, c = Math.cos(th), s = q * Math.sin(th);
    const ex = c * cp - s * sp, ey = c * sp + s * cp, row = t * rmax;
    for (let r = 0; r < rmax; r++) {
      const fx = cx + ex * r, fy = cy + ey * r;
      if (fx < 0 || fx > w - 1 || fy < 0 || fy > h - 1) continue;
      inside[row + r] = 1;
      const l = lab[Math.round(fy) * w + Math.round(fx)];
      if (l && (!keep || keep[l])) hit[row + r] = 1;
    }
  }
  return { hit, inside };
}

/** Radii r (outer first) where the band [r, band*r) is hit by most of the rays that are inside the image there. */
function toothBands(hit, inside, nTheta, rmax, rmin, P) {
  const cs = new Int32Array(nTheta * (rmax + 1));
  for (let t = 0; t < nTheta; t++) {
    let s = 0;
    for (let r = 0; r < rmax; r++) { s += hit[t * rmax + r]; cs[t * (rmax + 1) + r + 1] = s; }
  }
  const occAt = (r) => {
    const r2 = Math.min(rmax, Math.ceil(r * P.band));
    let vis = 0, occ = 0;
    for (let t = 0; t < nTheta; t++) {
      if (!inside[t * rmax + r2 - 1]) continue;
      vis++;
      if (cs[t * (rmax + 1) + r2] - cs[t * (rmax + 1) + r] > 0) occ++;
    }
    return vis / nTheta >= P.vis ? occ / vis : 0;
  };
  const out = [];
  let r = Math.floor(rmax / P.band) - 1;
  while (r >= rmin) {
    const occ = occAt(r);
    if (occ >= P.occ) {
      // slide inwards while the occupancy still grows: best alignment of the band with the ring
      let best = occ, rb = r;
      for (let q = r - 1; q > Math.max(rmin, Math.floor(r / P.band)); q--) { const o = occAt(q); if (o > best) { best = o; rb = q; } }
      out.push({ r: rb, occ: best });
      if (out.length >= 3) break;
      r = Math.floor(rb / P.band) - 1;
      continue;
    }
    r--;
  }
  return out;
}

/** Outermost hit per ray within [rLo, rHi): r (NaN = none) and outside flags (ray leaves the image before rNeed). */
function bandProfile(hit, inside, nTheta, rmax, rLo, rNeed) {
  const r = new Float64Array(nTheta), outside = new Uint8Array(nTheta);
  const need = Math.min(Math.floor(rNeed), rmax - 1);
  for (let t = 0; t < nTheta; t++) {
    const row = t * rmax;
    outside[t] = inside[row + need] ? 0 : 1;
    r[t] = NaN;
    if (outside[t]) continue;
    for (let k = rmax - 1; k >= rLo; k--) if (hit[row + k]) { r[t] = k; break; }
  }
  return { r, outside };
}

function fitCircle(xs, ys) {
  const n = xs.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  const rows = new Float64Array(n * 3), tgt = new Float64Array(n), keep = new Uint8Array(n).fill(1), res = new Float64Array(n);
  for (let i = 0; i < n; i++) { const x = xs[i] - mx, y = ys[i] - my; rows[i * 3] = 2 * x; rows[i * 3 + 1] = 2 * y; rows[i * 3 + 2] = 1; tgt[i] = x * x + y * y; }
  let cx = 0, cy = 0, rad = 0;
  for (let it = 0; it < 3; it++) {
    const s = lstsq(rows, 3, tgt, keep);
    if (!s) break;
    cx = s[0]; cy = s[1]; rad = Math.sqrt(Math.max(s[2] + cx * cx + cy * cy, 1e-9));
    for (let i = 0; i < n; i++) res[i] = Math.abs(Math.hypot(xs[i] - mx - cx, ys[i] - my - cy) - rad);
    const lim = Math.max(percentile(sortedCopy(res), 85), 1.0);
    for (let i = 0; i < n; i++) keep[i] = res[i] <= lim ? 1 : 0;
  }
  return { cx: cx + mx, cy: cy + my, r: rad };
}

/** Least-squares conic A x^2 + B xy + C y^2 + D x + E y = 1 around (cx, cy). Returns {cx, cy, a, b, phi} (a >= b) or null. */
function fitEllipse(xs, ys, cx, cy) {
  const n = xs.length, u = new Float64Array(n), v = new Float64Array(n);
  let sc = 0;
  for (let i = 0; i < n; i++) { u[i] = xs[i] - cx; v[i] = ys[i] - cy; sc += u[i] * u[i] + v[i] * v[i]; }
  sc = Math.sqrt(sc / n) + 1e-9;
  const rows = new Float64Array(n * 5), keep = new Uint8Array(n).fill(1), res = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = u[i] / sc, b = v[i] / sc; rows.set([a * a, a * b, b * b, a, b], i * 5); }
  let p = null;
  for (let it = 0; it < 3; it++) {
    p = lstsq(rows, 5, null, keep);
    if (!p) return null;
    for (let i = 0; i < n; i++) { let s = -1; for (let k = 0; k < 5; k++) s += rows[i * 5 + k] * p[k]; res[i] = Math.abs(s); }
    const lim = Math.max(percentile(sortedCopy(res), 85), 1e-3);
    for (let i = 0; i < n; i++) keep[i] = res[i] <= lim ? 1 : 0;
  }
  const [A, B, C, D, E] = p;
  const det = 4 * A * C - B * B;
  if (det <= 1e-9) return null;
  const x0 = (B * E - 2 * C * D) / det, y0 = (B * D - 2 * A * E) / det;
  const Fc = 1 + A * x0 * x0 + B * x0 * y0 + C * y0 * y0;
  const tr = A + C, df = Math.hypot(A - C, B), l1 = (tr - df) / 2, l2 = (tr + df) / 2;
  if (Fc <= 0 || l1 <= 0) return null;
  return { cx: cx + x0 * sc, cy: cy + y0 * sc, a: Math.sqrt(Fc / l1) * sc, b: Math.sqrt(Fc / l2) * sc, phi: 0.5 * Math.atan2(B, A - C) + Math.PI / 2 };
}

/** Tooth count and quality figures from the outline r(theta). */
function analyseProfile(r, outside, P) {
  const n = r.length;
  const have = new Uint8Array(n);
  let nHave = 0, nOut = 0, first = -1;
  for (let i = 0; i < n; i++) { if (!Number.isNaN(r[i])) { have[i] = 1; nHave++; if (first < 0) first = i; } if (outside[i]) nOut++; }
  if (nHave < 0.5 * n) return null;
  // fill holes by linear interpolation around the circle
  const rf = new Float64Array(n);
  let prev = first;
  for (let step = 1; step <= n; step++) {
    const i = (first + step) % n;
    if (!have[i]) continue;
    const gap = ((i - prev + n) % n) || n;
    for (let j = 1; j < gap; j++) rf[(prev + j) % n] = r[prev] + ((r[i] - r[prev]) * j) / gap;
    rf[i] = r[i]; prev = i;
  }
  const sv = sortedCopy(rf, have), lo = percentile(sv, 5), hi = percentile(sv, 95), span = Math.max(hi - lo, 1e-6);
  let mean = 0;
  for (let i = 0; i < n; i++) { rf[i] = Math.min(hi + 0.5 * span, Math.max(lo - 0.5 * span, rf[i])); mean += rf[i]; }
  mean /= n;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = rf[i] - mean;
  fft(re, im, false);
  const half = n / 2, A2 = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) A2[k] = re[k] * re[k] + im[k] * im[k];
  let k = P.kMin;
  for (let i = P.kMin; i <= P.kMax; i++) if (A2[i] > A2[k]) k = i;
  let tot = 1e-12;
  for (let i = 4; i < Math.min(4 * P.kMax, half + 1); i++) tot += A2[i];
  const purity = A2[k] / tot;
  // narrow band around k, positive frequencies only -> analytic signal
  for (let i = 0; i < n; i++) {
    if (i > half) { re[i] = 0; im[i] = 0; continue; }
    const g = Math.exp(-0.5 * ((i - k) / (P.bw * k)) ** 2);
    re[i] *= g; im[i] *= g;
  }
  fft(re, im, true);
  const env = new Float64Array(n), dph = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + n - 1) % n;
    env[i] = Math.hypot(re[i], im[i]);
    dph[i] = Math.atan2(im[i] * re[j] - re[i] * im[j], re[i] * re[j] + im[i] * im[j]);   // phase step from sample i-1 to i
  }
  const core = new Uint8Array(n).fill(1);
  let turns;
  if (nHave > 0.98 * n && nOut === 0) {
    let s = 0;
    for (let i = 0; i < n; i++) s += dph[i];
    turns = Math.round(s / (2 * Math.PI));          // winding number: exact cycle count of the closed outline
  } else {
    // part of the outline is missing (outside the image, or no edge found): use the mean tooth pitch of the
    // measured arcs only, without the half pitch next to each hole (the band-pass filter smears the hole into it)
    const m = Math.ceil((0.5 * n) / k);
    let nCore = 0, s = 0;
    for (let i = 0; i < n; i++) {
      let ok = have[i];
      for (let sh = 1; ok && sh <= m; sh++) ok = have[(i + sh) % n] && have[(i - sh + n) % n];
      core[i] = ok ? 1 : 0;
      if (ok) { nCore++; s += dph[i]; }
    }
    if (nCore < 0.25 * n) return null;
    turns = Math.round((s / (2 * Math.PI)) * (n / nCore));
  }
  const se = sortedCopy(env, core);
  return {
    k, turns, purity, envMin: se[0] / (percentile(se, 50) + 1e-12),
    valid: 1 - nOut / n, gaps: (n - nHave - nOut > 0 ? (n - nHave - nOut) / n : 0), depth: hi - lo,
  };
}

/** Refine the geometry on one tooth band and analyse its outline. Only the edge components that make up
 *  the band are used, so clutter next to the gear does not enter the outline. */
function measure(lab, nLabels, w, h, cx, cy, rBand, P) {
  const rOut = Math.ceil(rBand * P.band);
  const cnt = new Uint32Array(nLabels);
  let total = 0;
  for (let t = 0; t < 360; t++) {
    const c = Math.cos((2 * Math.PI * t) / 360), s = Math.sin((2 * Math.PI * t) / 360);
    for (let r = rBand; r < rOut; r++) {
      const X = Math.round(cx + c * r), Y = Math.round(cy + s * r);
      if (X < 0 || X >= w || Y < 0 || Y >= h) continue;
      const l = lab[Y * w + X];
      if (l) { cnt[l]++; total++; }
    }
  }
  if (!total) return null;
  const keep = new Uint8Array(nLabels);
  for (let l = 1; l < nLabels; l++) keep[l] = cnt[l] >= P.keep * total ? 1 : 0;

  let ell = null, R = rOut, rNeed = (rBand * (1 + P.band)) / 2, prof = null;
  for (let it = 0; it < 3; it++) {
    const final = it === 2, nTheta = final ? P.nTheta : 360;
    const rmax = Math.ceil(R * (final ? 1.12 : 1.25)) + 2;
    const { hit, inside } = polarHits(lab, keep, w, h, cx, cy, rmax, nTheta, final ? ell : null);
    prof = bandProfile(hit, inside, nTheta, rmax, Math.floor(R * 0.6), rNeed);
    const xs = [], ys = [];
    for (let t = 0; t < nTheta; t++) {
      if (Number.isNaN(prof.r[t])) continue;
      const th = (2 * Math.PI * t) / nTheta;
      xs.push(cx + prof.r[t] * Math.cos(th)); ys.push(cy + prof.r[t] * Math.sin(th));
    }
    if (xs.length < 0.5 * nTheta) return null;
    if (final) break;
    const c = fitCircle(xs, ys);
    cx = c.cx; cy = c.cy;
    const d = new Float64Array(xs.length);
    for (let i = 0; i < xs.length; i++) d[i] = Math.hypot(xs[i] - cx, ys[i] - cy);
    R = percentile(d.sort(), 97); rNeed = R;
    if (it === 1 && xs.length > 0.9 * nTheta) {
      const e = fitEllipse(xs, ys, cx, cy);
      if (e && e.b / e.a > 0.6 && e.b / e.a < 0.985 && Math.hypot(e.cx - cx, e.cy - cy) < 0.15 * R) {
        cx = e.cx; cy = e.cy; ell = { a: e.a, b: e.b, phi: e.phi }; R = e.a * 1.04; rNeed = e.a;
      }
    }
  }
  const res = analyseProfile(prof.r, prof.outside, P);
  if (!res) return null;
  return { ...res, cx, cy, R, ell };
}

/**
 * Count the teeth of the gear in an RGBA frame.
 * @returns {{toothCount:number, rawCount:number, confidence:number, abstainReason:(string|null),
 *            gearCenter:({x:number,y:number}|null), gearRadius:number, diag:object, stageMs:object}}
 *   toothCount is 0 when the counter abstains; abstainReason then says why:
 *   'no-gear' | 'not-teeth' | 'cut-off' | 'unclear'. rawCount is the ungated count (diagnostics only).
 */
export function countTeethV2(rgba, width, height, params) {
  const P = params ? { ...V2_PARAMS, ...params } : V2_PARAMS;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const t0 = now();
  const blurred = boxBlur(rgbaToGray(rgba, width, height), width, height, P.fineBlur);
  const tb = now();
  const s = Math.min(1, P.coarse / Math.max(width, height));
  const cw = Math.max(8, Math.round(width * s)), ch = Math.max(8, Math.round(height * s));
  // coarse image for the centre vote: the blurred image, sampled (the blur is the anti-alias filter)
  let small = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    const sy = Math.min(height - 1, Math.floor((y + 0.5) / s));
    for (let x = 0; x < cw; x++) small[y * cw + x] = blurred[sy * width + Math.min(width - 1, Math.floor((x + 0.5) / s))];
  }
  small = boxBlur(small, cw, ch, 1);
  const centres = voteCentres(gradients(small, cw, ch, P, true), cw, ch, P);
  const t1 = now();
  const G = gradients(blurred, width, height, P, false);
  const { lab, nLabels } = labelEdges(G.mag, G.thr, width, height);
  const t2 = now();

  let best = null, tried = 0;
  for (const c of centres) {
    const cx = (c.x + 0.5) / s, cy = (c.y + 0.5) / s;
    const rmax = Math.max(10, Math.floor(Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy))));
    const { hit, inside } = polarHits(lab, null, width, height, cx, cy, rmax, 360, null);
    for (const b of toothBands(hit, inside, 360, rmax, Math.floor(0.03 * Math.max(width, height)), P)) {
      const res = measure(lab, nLabels, width, height, cx, cy, b.r, P);
      tried++;
      if (!res) continue;
      res.good = res.purity >= P.okPurity && res.envMin >= P.okEnv;
      res.score = (res.purity * c.votes) / centres[0].votes;
      if (!best || (res.good && !best.good) || (res.good === best.good && res.score > best.score)) best = res;
      if (res.good) break;
    }
    if (best && best.good) break;
  }
  const stageMs = { blur: tb - t0, vote: t1 - tb, edges: t2 - t1, measure: now() - t2, total: now() - t0 };
  if (!best) {
    return { toothCount: 0, rawCount: 0, confidence: 0, abstainReason: 'no-gear', gearCenter: null, gearRadius: 0, diag: { tried }, stageMs };
  }
  const n = best.turns, aspect = (n * best.depth) / best.R;     // about 2*pi * tooth height / tooth pitch
  const axisRatio = best.ell ? best.ell.b / best.ell.a : 1;
  let reason = null;
  if (n < P.kMin || aspect < P.minAspect) reason = 'not-teeth';                                       // periodic, but not shaped like chain teeth (spider arms, holes)
  else if (best.valid < P.minValid || n * (1 - best.valid) > P.maxMissing) reason = 'cut-off';        // too much of the gear is outside the frame
  else if (best.purity < P.minPurity || best.envMin < P.minEnv || best.gaps > P.maxGaps || axisRatio < P.minAxisRatio) reason = 'unclear';
  // Answers that pass the gates were right in the measured sets; the value only drops below 0.9
  // (the result screen's "low confidence" limit) for answers close to a gate or with a cut outline.
  const margin = Math.min(1, best.purity / (1.4 * P.minPurity), best.envMin / (1.4 * P.minEnv));
  const confidence = reason ? 0 : best.valid * (0.5 + 0.5 * margin);
  return {
    toothCount: reason ? 0 : n, rawCount: n, confidence, abstainReason: reason,
    gearCenter: { x: best.cx, y: best.cy }, gearRadius: best.R,
    diag: { k: best.k, purity: best.purity, envMin: best.envMin, valid: best.valid, gaps: best.gaps, aspect, depth: best.depth,
            axisRatio, tried },
    stageMs,
  };
}
