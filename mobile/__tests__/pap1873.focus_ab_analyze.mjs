// PAP-1873 focus/exposure A/B — post-session analysis (protocol v2, 87c846f).
// Implements the QA-endorsed G1/G2/G3 endpoints EXACTLY as pre-registered
// (v1 prereg stands; v2 = procedure only). Run this ONCE on the session dir
// after an A/B session; its output is the verdict — no discretionary steps.
//
// Session dir layout (protocol v2):
//   debug-reports/pap1873_focusAB_<date>/MANIFEST.csv
//   header: file,target,pair,arm,order,lockSuccess,nativeName
//   + renamed jpgs {target}T_p{pair:02d}_{arm}_{order}.jpg
//
// Endpoints:
//   G1 manipulation check: rim-annulus Laplacian-variance sharpness on the
//      900px masked crop, annulus [0.85,1.05]x contourRadius; PASS iff
//      B>A on >=60% of valid pairs. Pixels touching a masked-out (zero)
//      neighbor are excluded (arm-symmetric).
//   G2 primary census: +-1-correct frequency anywhere in the production
//      multiRadiusFftScan candResults, rel>=0.04 (PAP-1865 convention);
//      net = absent(A)->present(B) minus present(A)->absent(B) across
//      52T/50T/48T pairs; PASS iff net >= +2.
//   G3 guard: production countTeethFromRgba output per photo; confident-wrong
//      = returned tc != target AND tc != 0; PASS iff wrong(B) <= wrong(A) on
//      dense-class pairs.
// Decision rule: G1 fail -> VOID; G1 pass + G2 fail -> NEGATIVE (lever closed);
// G1+G2+G3 pass -> POSITIVE (queue AC2 QA cross-check).
//
// Usage:
//   node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
//        mobile/__tests__/pap1873.focus_ab_analyze.mjs <sessionDir> [--selftest]
// --selftest fabricates a fake session from training-data photos (mechanics
// check ONLY — its numbers are never a measurement).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decode: jpegDecode } = require('jpeg-js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(path.join(HERE, '..', '..'));
const gc = await import(path.join(HERE, '..', 'src', 'algorithm', 'gearCounter.js').replace('file://', ''));
const iu = await import(path.join(HERE, '..', 'src', 'algorithm', 'imageUtils.js').replace('file://', ''));
const pp = await import(path.join(HERE, '..', 'src', 'algorithm', 'preprocess.js').replace('file://', ''));
const { countTeethFromRgba, bilinearDownsampleRgba } = gc;
const { applyCircularMask } = iu;
const T = gc.__test;

const TARGET_PX = 900, CENSUS_REL = 0.04, G1_LO = 0.85, G1_HI = 1.05, G1_MIN_PX = 500;
const out = (s) => process.stdout.write(s + '\n');

function load900(photoPath) {
  const raw = jpegDecode(fs.readFileSync(photoPath), { useTArray: true });
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET_PX);
  return { rgba: ds.rgba, w: ds.width, h: ds.height };
}

function annulusSharpness(gray, cx, cy, r0, r1, w, h) {
  const vals = [];
  const y0 = Math.max(1, Math.floor(cy - r1)), y1 = Math.min(h - 2, Math.ceil(cy + r1));
  const x0 = Math.max(1, Math.floor(cx - r1)), x1 = Math.min(w - 2, Math.ceil(cx + r1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy);
      if (r < r0 || r > r1) continue;
      const i = y * w + x, g = gray[i];
      const nb = [gray[i - w], gray[i + w], gray[i - 1], gray[i + 1]];
      if (g <= 0 || nb.some((v) => v <= 0)) continue; // exclude mask-boundary pixels
      vals.push(4 * g - nb[0] - nb[1] - nb[2] - nb[3]);
    }
  }
  if (vals.length < G1_MIN_PX) return { sharp: null, n: vals.length };
  let mean = 0; for (const v of vals) mean += v; mean /= vals.length;
  let m2 = 0; for (const v of vals) m2 += (v - mean) * (v - mean);
  return { sharp: m2 / vals.length, n: vals.length };
}

function analyzePhoto(photoPath) {
  const { rgba, w, h } = load900(photoPath);
  applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
  const { gray, enhanced, edges } = pp.JS_BACKEND.run(rgba, w, h);
  const deadline = Date.now() + 45000;
  const budgetState = { hit: false };
  const c = T.findGearCenter(gray, enhanced, edges, w, h, deadline, budgetState);
  const cx = c.cx, cy = c.cy, rC = c.radius || 0;
  let scan = null;
  try { scan = T.multiRadiusFftScan(enhanced, edges, cx, cy, rC, w, h, 0.5 * Math.min(w, h)); } catch { }
  const prodTc = countTeethFromRgba(rgba, w, h).toothCount; // abstains return 0 (pap1872 gate)
  const { sharp, n } = annulusSharpness(gray, cx, cy, G1_LO * rC, G1_HI * rC, w, h);
  return { cx, cy, contourRadius: rC, sharp, sharpPx: n,
           prodTc, peakTc: scan ? scan.peakTc : null,
           cands: scan ? scan.candResults.map((cr) => [cr.r, cr.tc, Number(cr.rel.toFixed(3))]) : [] };
}

function censusPresent(cands, target) {
  return cands.some(([, tc, rel]) => Math.abs(tc - target) <= 1 && rel >= CENSUS_REL);
}

function parseManifest(dir) {
  const lines = fs.readFileSync(path.join(dir, 'MANIFEST.csv'), 'utf8').split(/\r?\n/).filter(Boolean);
  const hdr = lines[0].split(',');
  return lines.slice(1).map((l) => {
    const cols = l.split(',');
    const o = {}; hdr.forEach((k, i) => { o[k.trim()] = (cols[i] ?? '').trim(); });
    return o;
  });
}

function runSession(dir) {
  const rows = parseManifest(dir);
  const byPair = new Map();
  for (const r of rows) {
    const key = `${r.target}#${r.pair}`;
    if (!byPair.has(key)) byPair.set(key, { target: Number(r.target), pair: r.pair, arms: {} });
    byPair.get(key).arms[r.arm] = r;
  }
  const pairs = [], excluded = [];
  for (const [key, p] of byPair) {
    const a = p.arms.A, b = p.arms.B;
    if (!a || !b) { excluded.push({ key, reason: 'missing arm' }); continue; }
    if (String(b.lockSuccess).toLowerCase() !== 'true') { excluded.push({ key, reason: 'lock fail (should have been discarded per v2)' }); continue; }
    pairs.push(p);
  }
  out(`[pap1873-focusab] pairs=${pairs.length} excluded=${excluded.length}`);
  const detail = [];
  let g1Pairs = 0, g1Bgreater = 0, g2flips = 0, g2eligible = 0;
  let g3wrongA = 0, g3wrongB = 0;
  for (const p of pairs) {
    const A = analyzePhoto(path.join(dir, p.arms.A.file));
    const B = analyzePhoto(path.join(dir, p.arms.B.file));
    const presentA = censusPresent(A.cands, p.target);
    const presentB = censusPresent(B.cands, p.target);
    const flip = (presentB ? 1 : 0) - (presentA ? 1 : 0);
    if ([48, 50, 52].includes(p.target)) { g2eligible++; g2flips += flip; }
    const wrongA = A.prodTc !== p.target && A.prodTc !== 0;
    const wrongB = B.prodTc !== p.target && B.prodTc !== 0;
    if (p.target >= 40 && p.target <= 60) { g3wrongA += wrongA ? 1 : 0; g3wrongB += wrongB ? 1 : 0; }
    if (A.sharp != null && B.sharp != null) { g1Pairs++; if (B.sharp > A.sharp) g1Bgreater++; }
    detail.push({ target: p.target, pair: p.pair,
      A: { ...A, present: presentA, wrong: wrongA }, B: { ...B, present: presentB, wrong: wrongB },
      flip, g1PairValid: A.sharp != null && B.sharp != null });
  }
  const g1Pass = g1Pairs > 0 && g1Bgreater / g1Pairs >= 0.6;
  const g2Pass = g2flips >= 2;
  const g3Pass = g3wrongB <= g3wrongA;
  let verdict;
  if (!g1Pass) verdict = 'VOID (manipulation check failed — assisted arm did not change photons; fix procedure, retry once next session)';
  else if (!g2Pass) verdict = 'NEGATIVE (lever CLOSED as negative — same disposition as 1500px; record on PAP-1873 + next card input)';
  else if (!g3Pass) verdict = 'NEGATIVE-guard (census moved but confident-wrong increased — lever closed per guard)';
  else verdict = 'POSITIVE (census-validated — queue AC2 QA cross-check before any operator card)';
  const summary = { protocol: 'v2 (87c846f); endpoints = v1 prereg (6ec8c1a), QA-endorsed 81f30f90',
    g1: { pass: g1Pass, bGreater: g1Bgreater, validPairs: g1Pairs, frac: g1Pairs ? +(g1Bgreater / g1Pairs).toFixed(3) : null },
    g2: { pass: g2Pass, netFlips: g2flips, eligiblePairs: g2eligible },
    g3: { pass: g3Pass, wrongA: g3wrongA, wrongB: g3wrongB },
    excluded, verdict };
  fs.writeFileSync(path.join(dir, 'ab_summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(dir, 'ab_pair_rows.json'), JSON.stringify(detail, null, 1));
  out(JSON.stringify(summary, null, 2));
  return summary;
}

// --- selftest: fabricate pairs from training-data photos (mechanics ONLY) ---
async function selftest() {
  const dir = path.join(ROOT, 'debug-reports', 'pap1873_focusAB_selftest');
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const td = path.join(ROOT, 'training-data');
  const stamps = fs.readdirSync(td).filter((f) => f.endsWith('_meta.json')).sort();
  const picks = [];
  for (const want of [50, 50, 52]) {
    for (const f of stamps) {
      const st = f.replace('_meta.json', '');
      if (picks.includes(st)) continue; // distinct stamps per arm
      try { const m = JSON.parse(fs.readFileSync(path.join(td, f), 'utf8').replace(/[^\x00-\x7F]+/g, '?'));
        if (Number(m.actual_tooth_count || m.actualTeethCount || 0) === want && fs.existsSync(path.join(td, f.replace('_meta.json', '_photo.jpg')))) { picks.push(st); break; } } catch { }
    }
  }
  const manifest = ['file,target,pair,arm,order,lockSuccess,nativeName'];
  picks.forEach((st, i) => {
    const target = [50, 50, 52][i];
    manifest.push(`${target}T_p01_${i % 2 ? 'B' : 'A'}_1.jpg,${target},01,${i % 2 ? 'B' : 'A'},1,true,${st}_photo.jpg`);
    fs.copyFileSync(path.join(td, `${st}_photo.jpg`), path.join(dir, `${target}T_p01_${i % 2 ? 'B' : 'A'}_1.jpg`));
  });
  fs.writeFileSync(path.join(dir, 'MANIFEST.csv'), manifest.join('\n') + '\n');
  out(`[selftest] fabricated session dir ${dir} (mechanics check only, NOT a measurement)`);
  return runSession(dir);
}

const arg = process.argv[2];
if (!arg) { out('usage: pap1873.focus_ab_analyze.mjs <sessionDir> | --selftest'); process.exit(1); }
if (arg === '--selftest') await selftest(); else runSession(path.resolve(arg));
