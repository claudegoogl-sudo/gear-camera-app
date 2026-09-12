/**
 * PAP-1898 diagnostic — dump findGearCenter candidate sets for the 5 audited
 * b153 crops. Tells selection failures (correct region in candidate set) from
 * detection failures (absent).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decode: jpegDecode } = require('jpeg-js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EV = path.join(ROOT, 'debug-reports', 'pap1897_fp5_b153_session_2026-09-11');
const OUT = path.join(ROOT, 'debug-reports', 'pap1898_localization_2026-09-12');
const TARGET = 900;

globalThis.__PAP1898_DEBUG = 1;

const gc = await import('../src/algorithm/gearCounter.js');
const { bilinearDownsampleRgba, __test } = gc;
const iu = await import('../src/algorithm/imageUtils.js');
const { applyCircularMask } = iu;
const pp = await import('../src/algorithm/preprocess.js');

const TRUTH = {
  f5886a846722: { label: 52, cx: 0.50, cy: 0.50, r: 0.450 },
  af9294fe87f0: { label: 50, cx: 0.50, cy: 0.49, r: 0.435 },
  caa1725c6bae: { label: 42, cx: 0.50, cy: 0.49, r: 0.450 },
  f3a8e88a13d8: { label: 36, cx: 0.50, cy: 0.49, r: 0.400 },
  '92e4b255112c': { label: 24, cx: 0.44, cy: 0.47, r: 0.250 },
};

const out = (s) => process.stdout.write(s + '\n');
const report = [];

for (const [stamp, truth] of Object.entries(TRUTH)) {
  const photo = path.join(EV, `${stamp}_cropped.jpg`);
  const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET);
  const { rgba, width: w, height: h } = ds;
  applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
  const { gray, enhanced, edges } = pp.preprocess(rgba, w, h);
  globalThis.__PAP1898_LAST = null;
  const center = __test.findGearCenter(gray, enhanced, edges, w, h, Infinity, { hit: false });
  const dbg = globalThis.__PAP1898_LAST;
  const tcx = truth.cx * w, tcy = truth.cy * h, tr = truth.r * w;

  // Score every candidate by distance to truth
  const cands = (dbg?.candidates || []).map(c => ({
    ...c,
    dCenter: +Math.hypot(c.cx - tcx, c.cy - tcy).toFixed(1),
    dR: +Math.round(c.r - tr),
  })).sort((a, b) => a.dCenter - b.dCenter);

  const bestTrue = cands[0] || null;
  report.push({
    stamp, label: truth.label, truth: { cx: tcx, cy: tcy, r: Math.round(tr) },
    picked: { cx: center.cx, cy: center.cy, r: center.radius, method: center.method },
    nCandidates: cands.length,
    closestToTruth: bestTrue,
    // selection failure = a candidate within 5% of true center AND within 15% of true radius exists
    truthAvailable: cands.some(c => c.dCenter < 0.05 * w && Math.abs(c.dR) < 0.15 * tr),
    candidates: cands,
  });
  out(`\n=== ${stamp} ${truth.label}T picked (${center.cx},${center.cy},r${center.radius}) truth (${Math.round(tcx)},${Math.round(tcy)},r${Math.round(tr)}) nCand=${cands.length} truthAvailable=${report[report.length-1].truthAvailable}`);
  for (const c of cands.slice(0, 6)) {
    out(`  cand (${c.cx},${c.cy},r${c.r}) purity=${c.purity} score=${c.score} dCenter=${c.dCenter}px dR=${c.dR}px ${c.selected ? '<-- SELECTED' : ''}`);
  }
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'candidate_dump.json'), JSON.stringify(report, null, 2));
out('\nWROTE ' + path.join(OUT, 'candidate_dump.json'));
