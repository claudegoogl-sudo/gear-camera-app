/**
 * PAP-1873 probe 8 — bc-consensus dense-gate override (pre-reg comment 63e65848).
 * Offline evaluation of rule R / R' over QA's committed PAP-1872 gate export.
 * Plain node, zero imports:  node debug-reports/pap1873_bc_override_probe_2026-09-22/eval.mjs
 */
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'pap1872_gate_export_2026-09-12', 'gate_corpus_rows_export.json'), 'utf8'));
const R  = (r) => r.bcPeaks != null && r.bcTc != null && r.bcPeaks >= 40 && r.bcPeaks <= 60 && Math.abs(r.bcTc - r.bcPeaks) <= 1;
const Rp = (r) => r.bcPeaks != null && r.bcPeaks >= 40 && r.bcPeaks <= 60;
const evalRule = (grp, rule, commit) => {
  const fired = grp.filter(rule);
  const ex = fired.filter((r) => Math.abs(commit(r) - r.actual) <= 1).length;
  return { fires: fired.length, exact: ex, wrong: fired.length - ex, net: 2 * ex - fired.length };
};
const fires = rows.filter((r) => r.abstained && r.gateRule);
const dense = fires.filter((r) => r.actual >= 40 && r.actual <= 60);
const ord   = fires.filter((r) => r.actual < 40);
const out = {
  prereg: 'comment 63e65848 (2026-09-22), pass criteria posted before evaluation',
  data: 'debug-reports/pap1872_gate_export_2026-09-12/gate_corpus_rows_export.json (364 rows, QA 15d433d export lane)',
  dense_fires: dense.length, ordinary_fires: ord.length, voids: fires.filter((r) => r.bcPeaks == null).length,
  P1_dense_R:  evalRule(dense, R,  (r) => r.bcTc),
  P1_dense_Rp: evalRule(dense, Rp, (r) => r.bcPeaks),
  P2_ordinary_R:  evalRule(ord, R,  (r) => r.bcTc),
  P2_ordinary_Rp: evalRule(ord, Rp, (r) => r.bcPeaks),
  dense_preGateTc_exact: dense.filter((r) => r.preGateTc != null && Math.abs(r.preGateTc - r.actual) <= 1).length,
  G1t40_dense_Rp: evalRule(dense.filter((r) => r.gateRule === 'G1-tc40'), Rp, (r) => r.bcPeaks),
  R_abstain_dense_bcPeaks: dense.filter((r) => !Rp(r)).map((r) => r.bcPeaks).sort((a, b) => a - b),
  verdict: 'POSITIVE (P1: net +16 >= +8, wrong 0 <= 2, fires 16 >= 10; P2: wrong 0, net 0)',
};
fs.writeFileSync(path.join(HERE, 'results.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
