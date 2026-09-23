// PAP-1930 corpus gate: apply the PRODUCTION decideDenseGateOutcome to QA's
// 364-row gate export (pap1872_gate_export_2026-09-12) and verify the
// PAP-1929-approved numbers reproduce with the shipped code path.
// Gate fire is taken from the recorded production gateRule (the export run
// called the real call site, incl. flags this offline replay cannot recompute);
// the decision itself is the shipped function — no reimplementation.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { __test } = require('../../mobile/src/algorithm/gearCounter.js');
const rows = require('../pap1872_gate_export_2026-09-12/gate_corpus_rows_export.json');

const gated = rows.filter((r) => r.gateRule && r.abstained);
const isDense = (r) => r.actual >= 40 && r.actual <= 60;
const dense = gated.filter(isDense);
const ord = gated.filter((r) => !isDense(r));

const apply = (r) => {
  const g = { fires: true, rule: r.gateRule };
  const o = __test.decideDenseGateOutcome(g, r.bcPeaks, 'baseline');
  return o; // null cannot happen (fires=true)
};

// P1 — dense rescue (bars: fires >= 10, net >= +8, wrong <= 2)
const p1Rows = dense.map((r) => ({ r, o: apply(r) }));
const p1Fires = p1Rows.filter((x) => x.o.override);
const p1Exact = p1Fires.filter((x) => x.o.toothCount === x.r.actual);
const p1Near = p1Fires.filter((x) => Math.abs(x.o.toothCount - x.r.actual) <= 1);
const p1Wrong = p1Fires.filter((x) => Math.abs(x.o.toothCount - x.r.actual) > 1);
// net is defined below with QA's pm1 definition

// naive contrast (probe-8 baseline): commit preGateTc on the same universe
const naiveFires = dense;
const naiveWrong = naiveFires.filter((r) => Math.abs(r.preGateTc - r.actual) > 1);

// P2 — ordinary no-harm
const p2Rows = ord.map((r) => ({ r, o: apply(r) }));
const p2Fires = p2Rows.filter((x) => x.o.override);

// regression guard: every gated row that does NOT commit keeps the honest abstain
const keptAbstain = p1Rows.concat(p2Rows).filter((x) => !x.o.override);
const abstainIntact = keptAbstain.every((x) => x.o.abstained && x.o.toothCount === 0 && x.o.confidence === 0);

// QA's published definitions (9da450d / probe 8): "exact" = |commit-label| <= 1,
// "wrong" = |commit-label| > 1, net = exact - wrong.
const net = p1Near.length - p1Wrong.length;
// Hard parity with QA 9da450d results.json (regression tripwire):
const parity = {
  p1_fires_17: p1Fires.length === 17,
  p1_exact_pm1_17: p1Near.length === 17,
  p1_wrong_gt1_0: p1Wrong.length === 0,
  p2_commits_0: p2Fires.length === 0,
  naive_preGateTc_wrong_15: naiveWrong.length === 15,
};
const out = {
  task: 'PAP-1930', stamp: '2026-09-23',
  input: 'debug-reports/pap1872_gate_export_2026-09-12/gate_corpus_rows_export.json (QA lane 15d433d, n=364)',
  decisionFn: 'mobile/src/algorithm/gearCounter.js __test.decideDenseGateOutcome (production)',
  p1_dense: {
    universe: dense.length,
    fires: p1Fires.length,
    strictly_exact: p1Exact.length,
    exact_pm1: p1Near.length,
    wrong_gt1: p1Wrong.length,
    net,
    bars: { fires_min_10: p1Fires.length >= 10, net_min_8: net >= 8, wrong_max_2: p1Wrong.length <= 2 },
    committed_rows: p1Fires.map((x) => ({ stamp: x.r.stamp, actual: x.r.actual, bcPeaks: x.r.bcPeaks, gateRule: x.r.gateRule })),
  },
  naive_preGateTc_contrast: { fires: naiveFires.length, wrong_gt1: naiveWrong.length },
  p2_ordinary: { universe: ord.length, fires: p2Fires.length, commits: p2Fires.length },
  honest_abstain_intact: abstainIntact,
  parity_with_qa_9da450d: parity,
  parity_all_green: Object.values(parity).every(Boolean),
};
console.log(JSON.stringify(out, null, 2));
