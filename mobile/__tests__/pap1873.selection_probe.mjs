// PAP-1873 heartbeat-1 probe: outer-band selection for the present-but-misselected
// dense subclass (50T/48T), pre-registered on PAP-1873 comment 487bd571 BEFORE running.
//
// Rule (fixed, no tuning): among production scanCands [radius, tc, rel] with radius in
// [1.00, 1.10] x contourRadius, select max rel (ties -> larger radius); accept its tc
// iff rel >= 0.04 (census floor), else fall back to production peakTc unchanged.
//
// Pre-registered pass criteria (ALL must hold):
//   P1 dense 40-60T exact >= 17/64  (>= +3 vs production 14/64, same-scan basis)
//   P2 50T exact >= 4/7             (production 2/7)
//   P3 ordinary 9-39T exact >= 177/300 (no worse than -2 vs production 179/300)
//
// Data: committed pass-1 rows (production scanCands), no recomputation.
// Run: node mobile/__tests__/pap1873.selection_probe.mjs
import fs from 'node:fs';

const SRC = 'debug-reports/pap1865_mechanism_probe_2026-09-10/probe_rows.json';
const OUT = 'debug-reports/pap1873_selection_probe_2026-09-11';
const BAND_LO = 1.00, BAND_HI = 1.10, REL_FLOOR = 0.04;

const rows = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const out = [];
let dense = { n: 0, prodExact: 0, probeExact: 0, rescues: 0, regressions: 0 };
let ord   = { n: 0, prodExact: 0, probeExact: 0, rescues: 0, regressions: 0 };
const byLabel = {};

for (const r of rows) {
  const lo = BAND_LO * r.contourRadius, hi = BAND_HI * r.contourRadius;
  let best = null;
  for (const [rad, tc, rel] of r.scanCands) {
    if (rad < lo || rad > hi) continue;
    if (!best || rel > best.rel || (rel === best.rel && rad > best.rad)) best = { rad, tc, rel };
  }
  const probeTc = (best && best.rel >= REL_FLOOR) ? best.tc : r.prod.peakTc;
  const probeExact = probeTc === r.actual;
  const prodExact = r.prod.peakTc === r.actual;
  const isDense = r.actual >= 40 && r.actual <= 60;
  const bucket = isDense ? dense : ord;
  bucket.n++;
  bucket.prodExact += prodExact ? 1 : 0;
  bucket.probeExact += probeExact ? 1 : 0;
  if (!prodExact && probeExact) bucket.rescues++;
  if (prodExact && !probeExact) bucket.regressions++;
  if (isDense) {
    byLabel[r.actual] ??= { n: 0, prodExact: 0, probeExact: 0, rescues: 0, regressions: 0 };
    const L = byLabel[r.actual];
    L.n++; L.prodExact += prodExact ? 1 : 0; L.probeExact += probeExact ? 1 : 0;
    if (!prodExact && probeExact) L.rescues++;
    if (prodExact && !probeExact) L.regressions++;
  }
  out.push({
    stamp: r.stamp, actual: r.actual, contourRadius: r.contourRadius,
    prodTc: r.prod.peakTc, prodRel: r.prod.peakRel, prodR: r.prod.peakR,
    bandBest: best, probeTc, probeExact, prodExact,
  });
}

const p1 = dense.probeExact >= 17;
const p2 = (byLabel[50]?.probeExact ?? 0) >= 4;
const p3 = ord.probeExact >= 177;
const summary = {
  prereg: 'PAP-1873 comment 487bd571 (2026-09-11T11:28Z)',
  rule: { band: [BAND_LO, BAND_HI], relFloor: REL_FLOOR, tieBreak: 'larger radius', fallback: 'production peakTc' },
  dense, ordinary: ord, byLabel,
  criteria: { P1_dense_ge_17_of_64: { pass: p1, got: dense.probeExact },
              P2_50T_ge_4_of_7: { pass: p2, got: byLabel[50]?.probeExact ?? 0 },
              P3_ordinary_ge_177_of_300: { pass: p3, got: ord.probeExact } },
  verdict: p1 && p2 && p3 ? 'POSITIVE (queue AC2 QA cross-check)' : 'NEGATIVE (record and close this lever)',
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/selection_rows.json`, JSON.stringify(out, null, 1));
fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
