/**
 * PAP-1865 — QA gate-amendment 5: mechanism falsification probe (BEFORE any
 * implementation). Question: does the dense rim fundamental survive at the
 * silhouette if (a) angular sampling goes 1024 -> 2048 and (b) the SavGol
 * window is removed / made tooth-scale-aware?  QA mechanism hypothesis:
 * production SavGol halfWin = N_ANGLES/90 = 11 (23-sample window) spans
 * ~1.35 tooth periods at 60T (1024/60 = 17.1 samples/tooth) and low-passes
 * the dense rim fundamental away, which is why multiRadiusFftScan's
 * outermost-candidate rel>=0.12 selection falls inward to the bolt circle.
 *
 * Arms (all at the same silhouette-anchored radii, fracs 0.88..1.06 of
 * rRim = argmax of the radial edge-density profile — no peakR input):
 *   legacy1024 : production fftCountAtRadius (n=1024, SavGol hw=11)  [control]
 *   raw2048    : n=2048, no smoothing, same harmonic scoring
 *   tp2048     : n=2048, two-pass: rough tc0 from raw, SavGol
 *                halfWin = floor(2048/(4*tc0)) (~1 tooth period window)
 *   off±3/±6%  : tp2048 at shifted centers (center-robustness spot-check)
 * Context: production multiRadiusFftScan candResults (peakR lock picture).
 *
 * Plain node (PAP-1672: jest babel inflation ~6.8x; node = honest host number).
 * Usage: node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *          mobile/__tests__/pap1865.mechanism_probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decode: jpegDecode } = require('jpeg-js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TRAINING_DIR = path.join(ROOT, 'training-data');
const DEBUG_DIR = path.join(ROOT, 'debug-reports', 'pap1865_mechanism_probe_2026-09-10');
const CACHE_DIR = path.join(ROOT, '.cache', 'training-rgba');
const TARGET = 900;

const gc = await import('../src/algorithm/gearCounter.js');
const { bilinearDownsampleRgba } = gc;
const T = gc.__test; // findGearCenter, fftCountAtRadius, sampleIntensityRing, multiRadiusFftScan
const iu = await import('../src/algorithm/imageUtils.js');
const { applyCircularMask, savgolSmooth } = iu;
const pp = await import('../src/algorithm/preprocess.js');
const fftMod = await import('../src/algorithm/fft.js');
const { fftMagnitude } = fftMod;

const MIN_TEETH = 10, MAX_TEETH = 65;
const FRACS = [0.88, 0.94, 1.00, 1.06];
const out = (s) => process.stdout.write(s + '\n');

function loadRgba(photo, stamp) {
  const bin = path.join(CACHE_DIR, `${stamp}_${TARGET}.bin`);
  const metaP = path.join(CACHE_DIR, `${stamp}_${TARGET}.meta.json`);
  const srcMtimeMs = fs.statSync(photo).mtimeMs;
  if (fs.existsSync(metaP) && fs.existsSync(bin)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaP, 'utf8'));
      if (m.sourceMtimeMs === srcMtimeMs && m.targetMaxDim === TARGET) {
        const buf = fs.readFileSync(bin);
        const rgba = new Uint8Array(buf.byteLength);
        rgba.set(buf);
        return { rgba, w: m.width, h: m.height };
      }
    } catch { /* fall through */ }
  }
  const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET);
  return { rgba: ds.rgba, w: ds.width, h: ds.height };
}

// Mirror of production fftCountAtRadius scoring, parameterized (n, smoothing).
function ringFft(enhanced, cx, cy, r, width, height, nAngles, halfWin) {
  const ring = T.sampleIntensityRing(enhanced, cx, cy, r, width, height, nAngles);
  let sm;
  if (halfWin > 0) sm = savgolSmooth(ring, halfWin, true);
  else sm = ring;
  let mean = 0;
  for (let i = 0; i < sm.length; i++) mean += sm[i];
  mean /= sm.length;
  const centered = new Array(sm.length);
  for (let i = 0; i < sm.length; i++) centered[i] = sm[i] - mean;
  const mag = fftMagnitude(centered);
  let bestF = MIN_TEETH, bestScore = 0, totalScore = 0;
  for (let f = MIN_TEETH; f <= MAX_TEETH && f < mag.length; f++) {
    let score = mag[f];
    if (2 * f < mag.length) score += 0.5 * mag[2 * f];
    if (3 * f < mag.length) score += 0.25 * mag[3 * f];
    totalScore += score;
    if (score > bestScore) { bestScore = score; bestF = f; }
  }
  const rel = totalScore > 0 ? bestScore / totalScore : 0;
  return { tc: bestF, rel };
}

// rel-weighted vote across radii; returns vote tc, its rel sum, agreement count.
function aggregate(perRadius) {
  const votes = {};
  for (const pr of perRadius) {
    if (!pr || pr.tc <= 0) continue;
    votes[pr.tc] = (votes[pr.tc] || 0) + pr.rel;
  }
  let bestTc = 0, bestVote = 0;
  for (const [tcS, v] of Object.entries(votes)) {
    if (v > bestVote) { bestVote = v; bestTc = Number(tcS); }
  }
  const agree = perRadius.filter((p) => p && p.tc === bestTc).length;
  return { tc: bestTc, vote: Number(bestVote.toFixed(4)), agree };
}

const labeled = [];
for (const f of fs.readdirSync(TRAINING_DIR).sort()) {
  if (!f.endsWith('_meta.json')) continue;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(TRAINING_DIR, f), 'utf8').replace(/[^\x00-\x7F]+/g, '?')); }
  catch { continue; }
  const actual = Number(meta.actual_tooth_count || meta.actualTeethCount || 0);
  if (!actual || actual < 9 || actual > 60) continue;
  const stamp = f.replace('_meta.json', '');
  const photo = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
  if (fs.existsSync(photo)) labeled.push({ stamp, actual, photo });
}
const ANCHORS = [
  { stamp: 'pap1865_captureA_cropped', actual: 20, photo: path.join(ROOT, 'debug-reports', 'pap1862_fp5_b151_session_2026-09-10', 'attachments', 'captureA_898620612_cropped.jpg') },
  { stamp: 'pap1865_captureB_cropped', actual: 20, photo: path.join(ROOT, 'debug-reports', 'pap1862_fp5_b151_session_2026-09-10', 'attachments', 'captureB_898623252_cropped.jpg') },
];
const CORPUS = [...ANCHORS, ...labeled];
out(`[pap1865-probe] corpus=${CORPUS.length} (dense40-60 target) arms=legacy1024/raw2048/tp2048/off±3,6%`);
fs.mkdirSync(DEBUG_DIR, { recursive: true });

const rows = [];
const t0 = Date.now();
for (const item of CORPUS) {
  try {
    const { rgba, w, h } = loadRgba(item.photo, item.stamp);
    applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
    const tPre = Date.now();
    const { gray, enhanced, edges } = pp.JS_BACKEND.run(rgba, w, h);
    const deadline = Date.now() + 45000;
    const budgetState = { hit: false };
    const c = T.findGearCenter(gray, enhanced, edges, w, h, deadline, budgetState);
    const tCenter = Date.now() - tPre;
    const cx = c.cx, cy = c.cy;
    const contourRadius = c.radius || 0;

    // Production multiRadiusFftScan context (aimR mirrors countTeethFromRgba).
    let scan = null;
    try { scan = T.multiRadiusFftScan(enhanced, edges, cx, cy, contourRadius, w, h, 0.5 * Math.min(w, h)); } catch { }

    // Silhouette rim from radial edge-density profile (peakR-independent).
    const halfMin = Math.min(cx, w - cx, cy, h - cy) - 1;
    const maxR = Math.min(halfMin, contourRadius > 20 ? Math.floor(contourRadius * 1.35) : Math.floor(Math.min(h, w) / 3));
    const density = new Float64Array(maxR);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (edges[y * w + x] > 0) {
          const d = Math.round(Math.sqrt((x - cx) ** 2 + (y - cy) ** 2));
          if (d < maxR) density[d]++;
        }
      }
    }
    const dHalf = Math.max(2, Math.floor(maxR / 16));
    const dsm = iu.smoothSignal(density, dHalf);
    const searchLimit = Math.floor(maxR * 0.90);
    let rRim = 0, rRimV = -1;
    for (let r = 1; r < searchLimit; r++) { if (dsm[r] > rRimV) { rRimV = dsm[r]; rRim = r; } }
    // outermost local max >= 0.12*peak (alt rim definition, logged only)
    let rRimOuter = 0;
    const peakThresh = rRimV * 0.12;
    for (let r = 1; r < searchLimit - 1; r++) {
      if (dsm[r] > dsm[r - 1] && dsm[r] > dsm[r + 1] && dsm[r] >= peakThresh) rRimOuter = r;
    }

    const radii = FRACS.map((f) => Math.round(rRim * f)).filter((r) => r >= 10 && r < maxR);
    const tA = Date.now();
    const legacy = radii.map((r) => { try { return T.fftCountAtRadius(enhanced, cx, cy, r, w, h); } catch { return null; } });
    const tLegacy = Date.now() - tA;
    const tB = Date.now();
    const raw2048 = radii.map((r) => { try { return ringFft(enhanced, cx, cy, r, w, h, 2048, 0); } catch { return null; } });
    const tRaw = Date.now() - tB;
    // two-pass: window ≈ 1 tooth period from the RAW estimate (label-free)
    const tp2048 = radii.map((r, i) => {
      try {
        const raw0 = raw2048[i];
        if (!raw0 || raw0.tc < MIN_TEETH) return raw0;
        const hw = Math.max(2, Math.floor(2048 / (4 * raw0.tc)));
        return ringFft(enhanced, cx, cy, r, w, h, 2048, hw);
      } catch { return null; }
    });
    const tTp = Date.now() - tB - tRaw;

    const offRows = [];
    const tC = Date.now();
    for (const pct of [-6, -3, 3, 6]) {
      const dx = Math.round((pct / 100) * rRim);
      const rr2 = radii.slice(1, 3); // 0.94, 1.00
      const per = rr2.map((r) => {
        try {
          const raw0 = ringFft(enhanced, cx + dx, cy, r, w, h, 2048, 0);
          if (raw0.tc < MIN_TEETH) return raw0;
          const hw = Math.max(2, Math.floor(2048 / (4 * raw0.tc)));
          return ringFft(enhanced, cx + dx, cy, r, w, h, 2048, hw);
        } catch { return null; }
      });
      const agg = aggregate(per);
      offRows.push({ pct, tc: agg.tc, agree: agg.agree });
    }
    const tOff = Date.now() - tC;

    const agg = (per) => { const a = aggregate(per); return { tc: a.tc, agree: a.agree, vote: a.vote }; };
    rows.push({
      stamp: item.stamp, actual: item.actual,
      cx, cy, contourRadius, rRim, rRimOuter,
      rimOverContour: Number((rRim / Math.max(1, contourRadius)).toFixed(3)),
      prod: scan ? { peakTc: scan.peakTc, peakRel: Number(scan.peakRel.toFixed(4)), peakR: scan.peakR } : null,
      scanCands: scan ? scan.candResults.map((cr) => [cr.r, cr.tc, Number(cr.rel.toFixed(3))]) : [],
      legacy: { ...agg(legacy), per: legacy.map((p) => p ? [p.tc, Number(p.rel.toFixed(4))] : null), ms: tLegacy },
      raw2048: { ...agg(raw2048), per: raw2048.map((p) => p ? [p.tc, Number(p.rel.toFixed(4))] : null), ms: tRaw },
      tp2048: { ...agg(tp2048), per: tp2048.map((p) => p ? [p.tc, Number(p.rel.toFixed(4))] : null), ms: tTp },
      offsets: offRows,
      centerMs: tCenter,
    });
  } catch (err) {
    rows.push({ stamp: item.stamp, actual: item.actual, error: String(err && err.message || err) });
  }
  if (rows.length % 25 === 0 || rows.length === CORPUS.length) {
    out(`[pap1865-probe] ${rows.length}/${CORPUS.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    try { fs.writeFileSync(path.join(DEBUG_DIR, 'probe_rows.json'), JSON.stringify(rows, null, 1)); } catch { }
  }
}
fs.writeFileSync(path.join(DEBUG_DIR, 'probe_rows.json'), JSON.stringify(rows, null, 1));
out(`[pap1865-probe] done rows=${rows.length} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s -> ${path.join(DEBUG_DIR, 'probe_rows.json')}`);
