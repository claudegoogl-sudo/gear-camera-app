/**
 * PAP-1865 mechanism probe, pass 2 — TRUE silhouette anchor.
 * Pass 1 (pap1865.mechanism_probe.mjs) showed the density-argmax rim anchor
 * locks onto inner rings on hard dense photos (rRim/contour down to 0.32), so
 * pass 1 never tested the teeth annulus there. Pass 2 derives rSil by walking
 * INWARD from the mask boundary per angle: everything beyond the gear is
 * masked black, so the first edge pixel found is the gear silhouette (tooth
 * tip). rSil = median across angles; cannot lock onto the bolt circle by
 * construction. Then the same arms as pass 1 at fracs of rSil:
 *   legacy1024 (production fftCountAtRadius) / raw2048 / tp2048 / offsets.
 *
 * Plain node. Usage:
 *   node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *          mobile/__tests__/pap1865.mechanism_probe2.mjs
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
const T = gc.__test;
const iu = await import('../src/algorithm/imageUtils.js');
const { applyCircularMask, savgolSmooth } = iu;
const pp = await import('../src/algorithm/preprocess.js');
const { fftMagnitude } = await import('../src/algorithm/fft.js');

const MIN_TEETH = 10, MAX_TEETH = 65;
const FRACS = [0.85, 0.90, 0.95, 1.00, 1.04];
const N_WALK = 360;
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

// Outermost-edge walk from the mask boundary inward, per angle.
function silhouetteWalk(edges, cx, cy, maxR, width, height) {
  const radii = new Int32Array(N_WALK);
  const cosA = new Float64Array(N_WALK), sinA = new Float64Array(N_WALK);
  for (let i = 0; i < N_WALK; i++) {
    const a = (2 * Math.PI * i) / N_WALK;
    cosA[i] = Math.cos(a); sinA[i] = Math.sin(a);
  }
  let found = 0;
  for (let r = maxR - 2; r >= 10 && found < N_WALK; r--) {
    for (let i = 0; i < N_WALK; i++) {
      if (radii[i] > 0) continue;
      const px = Math.min(Math.max(Math.round(cx + r * cosA[i]), 0), width - 1);
      const py = Math.min(Math.max(Math.round(cy + r * sinA[i]), 0), height - 1);
      if (edges[py * width + px] > 0) { radii[i] = r; found++; }
    }
  }
  const vals = [];
  for (let i = 0; i < N_WALK; i++) if (radii[i] > 0) vals.push(radii[i]);
  if (vals.length < N_WALK * 0.3) return { rSil: 0, coverage: vals.length / N_WALK, coherence: 0, radii };
  vals.sort((a, b) => a - b);
  const med = vals[Math.floor(vals.length / 2)];
  let near = 0;
  for (const v of vals) if (Math.abs(v - med) <= 6) near++;
  return { rSil: med, coverage: vals.length / N_WALK, coherence: near / vals.length, radii };
}

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
const agg = (per) => { const a = aggregate(per); return { tc: a.tc, agree: a.agree, vote: a.vote }; };

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
const CORPUS = labeled; // anchors already covered in pass 1
out(`[pap1865-probe2] corpus=${CORPUS.length} anchor=silhouette-walk(rSil=median outermost edge from mask)`);
fs.mkdirSync(DEBUG_DIR, { recursive: true });

const rows = [];
const t0 = Date.now();
for (const item of CORPUS) {
  try {
    const { rgba, w, h } = loadRgba(item.photo, item.stamp);
    applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
    const { gray, enhanced, edges } = pp.JS_BACKEND.run(rgba, w, h);
    const c = T.findGearCenter(gray, enhanced, edges, w, h, Date.now() + 45000, { hit: false });
    const cx = c.cx, cy = c.cy, contourRadius = c.radius || 0;
    const halfMin = Math.min(cx, w - cx, cy, h - cy) - 1;
    const maxR = halfMin;
    const walk = silhouetteWalk(edges, cx, cy, maxR, w, h);
    const rSil = walk.rSil;
    if (rSil <= 0) {
      rows.push({ stamp: item.stamp, actual: item.actual, coverage: walk.coverage, rSil: 0, skip: true });
      continue;
    }
    const radii = FRACS.map((f) => Math.round(rSil * f)).filter((r) => r >= 10 && r < maxR - 2);
    const legacy = radii.map((r) => { try { return T.fftCountAtRadius(enhanced, cx, cy, r, w, h); } catch { return null; } });
    const raw2048 = radii.map((r) => { try { return ringFft(enhanced, cx, cy, r, w, h, 2048, 0); } catch { return null; } });
    const tp2048 = radii.map((r, i) => {
      try {
        const raw0 = raw2048[i];
        if (!raw0 || raw0.tc < MIN_TEETH) return raw0;
        const hw = Math.max(2, Math.floor(2048 / (4 * raw0.tc)));
        return ringFft(enhanced, cx, cy, r, w, h, 2048, hw);
      } catch { return null; }
    });
    const offRows = [];
    for (const pct of [-6, -3, 3, 6]) {
      const dx = Math.round((pct / 100) * rSil);
      const per = [0.90, 0.95].map((fr) => {
        const r = Math.round(rSil * fr);
        try {
          const raw0 = ringFft(enhanced, cx + dx, cy, r, w, h, 2048, 0);
          if (raw0.tc < MIN_TEETH) return raw0;
          const hw = Math.max(2, Math.floor(2048 / (4 * raw0.tc)));
          return ringFft(enhanced, cx + dx, cy, r, w, h, 2048, hw);
        } catch { return null; }
      });
      const a = aggregate(per);
      offRows.push({ pct, tc: a.tc, agree: a.agree });
    }
    rows.push({
      stamp: item.stamp, actual: item.actual,
      contourRadius, rSil, silOverContour: Number((rSil / Math.max(1, contourRadius)).toFixed(3)),
      coverage: Number(walk.coverage.toFixed(3)), coherence: Number(walk.coherence.toFixed(3)),
      legacy: { ...agg(legacy), per: legacy.map((p) => p ? [p.tc, Number(p.rel.toFixed(4))] : null) },
      raw2048: { ...agg(raw2048), per: raw2048.map((p) => p ? [p.tc, Number(p.rel.toFixed(4))] : null) },
      tp2048: { ...agg(tp2048), per: tp2048.map((p) => p ? [p.tc, Number(p.rel.toFixed(4))] : null) },
      offsets: offRows,
    });
  } catch (err) {
    rows.push({ stamp: item.stamp, actual: item.actual, error: String(err && err.message || err) });
  }
  if (rows.length % 25 === 0 || rows.length === CORPUS.length) {
    out(`[pap1865-probe2] ${rows.length}/${CORPUS.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    try { fs.writeFileSync(path.join(DEBUG_DIR, 'probe2_rows.json'), JSON.stringify(rows, null, 1)); } catch { }
  }
}
fs.writeFileSync(path.join(DEBUG_DIR, 'probe2_rows.json'), JSON.stringify(rows, null, 1));
out(`[pap1865-probe2] done rows=${rows.length} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`);
