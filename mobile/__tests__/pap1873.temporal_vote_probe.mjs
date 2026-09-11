// PAP-1873 heartbeat-2 probe: temporal consensus across repeat captures.
// Preregistered on PAP-1873 comment 43b25c09 (2026-09-11T11:38Z) BEFORE running.
// Wording correction (disclosed in results): prereg T2 as literally written
// ("majority wrong flips to voted-correct") is unsatisfiable under the fixed
// strict-majority rule; the intended criterion from the prereg motivation is
// implemented: >=1 dense cluster with a CORRECT strict majority that contains
// >=1 independently-wrong member frame (proves noise-breaking, not reinforcement).
//
// Rule (fixed): clusters = same actual label, consecutive stamps, gap <= 180s,
// size >= 2. Per-frame tc = prod.peakTc. Strict majority (> n/2) -> all frames
// take it; otherwise all frames abstain (tc=0).
//
// Pass criteria (ALL must hold): T1 dense frame net >= +3 of 32 dense frames;
// T2' >=1 dense correct-majority cluster rescuing a wrong member; T3 ordinary net >= 0.
// Run: node mobile/__tests__/pap1873.temporal_vote_probe.mjs
import fs from 'node:fs';

const SRC = 'debug-reports/pap1865_mechanism_probe_2026-09-10/probe_rows.json';
const OUT = 'debug-reports/pap1873_temporal_vote_2026-09-11';
const GAP_S = 180;

const rows = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const ts = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d+)Z$/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7].padEnd(3, '0').slice(0, 3)) : null;
};

const byActual = new Map();
for (const r of rows) {
  const t = ts(r.stamp);
  if (t == null) continue; // synthetic rows
  if (!byActual.has(r.actual)) byActual.set(r.actual, []);
  byActual.get(r.actual).push({ t, stamp: r.stamp, prodTc: r.prod.peakTc, actual: r.actual });
}

const clusters = [];
for (const items of byActual.values()) {
  items.sort((a, b) => a.t - b.t);
  let cur = [items[0]];
  for (const it of items.slice(1)) {
    if (it.t - cur[cur.length - 1].t <= GAP_S * 1000) cur.push(it);
    else { if (cur.length >= 2) clusters.push(cur); cur = [it]; }
  }
  if (cur.length >= 2) clusters.push(cur);
}

const majority = (tcs) => {
  const counts = new Map();
  for (const tc of tcs) counts.set(tc, (counts.get(tc) ?? 0) + 1);
  let best = null, bestN = 0;
  for (const [tc, n] of counts) if (n > bestN) { best = tc; bestN = n; }
  return bestN > tcs.length / 2 ? { tc: best, n: bestN } : null;
};

const summarize = (cls, tag) => {
  let frames = 0, beforeExact = 0, afterExact = 0, rescues = 0, regressions = 0, abstains = 0;
  const detail = [];
  for (const c of cls) {
    const tcs = c.map((f) => f.prodTc);
    const maj = majority(tcs);
    const voted = maj ? maj.tc : 0;
    let resc = 0, reg = 0;
    for (const f of c) {
      frames++;
      const b = f.prodTc === f.actual, a = voted === f.actual;
      beforeExact += b; afterExact += a;
      if (!b && a) { rescues++; resc++; }
      if (b && !a) { regressions++; reg++; }
      if (voted === 0) abstains++;
    }
    detail.push({
      actual: c[0].actual, n: c.length, stamps: c.map((f) => f.stamp),
      perFrameTc: tcs, voted, majorityN: maj ? maj.n : 0,
      clusterBeforeExact: c.filter((f) => f.prodTc === f.actual).length,
      clusterAfterExact: voted === c[0].actual ? c.length : 0,
      rescuesInCluster: resc, regressionsInCluster: reg,
      correctMajorityRescuesWrongMember: !!(maj && maj.tc === c[0].actual && resc > 0),
    });
  }
  return { tag, clusters: cls.length, frames, beforeExact, afterExact, rescues, regressions,
           net: rescues - regressions, abstainFrames: abstains, detail };
};

const isDense = (a) => a >= 40 && a <= 60;
const all = summarize(clusters, 'all');
const dense = summarize(clusters.filter((c) => isDense(c[0].actual)), 'dense');
const ord = summarize(clusters.filter((c) => !isDense(c[0].actual)), 'ordinary');
const t2prime = dense.detail.filter((d) => d.correctMajorityRescuesWrongMember).length;

const summary = {
  prereg: 'PAP-1873 comment 43b25c09; T2 wording correction disclosed (implemented as intended-in-motivation T2\')',
  rule: { gapSeconds: GAP_S, minCluster: 2, perFrame: 'prod.peakTc', vote: 'strict majority else abstain(0)' },
  dense: { ...dense, detail: undefined }, ordinary: { ...ord, detail: undefined },
  t2prime_correctMajorityRescuingWrongMemberClusters: t2prime,
  criteria: {
    T1_dense_net_ge_3: { pass: dense.net >= 3, got: dense.net },
    T2prime_ge_1_independence_cluster: { pass: t2prime >= 1, got: t2prime },
    T3_ordinary_net_ge_0: { pass: ord.net >= 0, got: ord.net },
  },
  verdict: dense.net >= 3 && t2prime >= 1 && ord.net >= 0
    ? 'POSITIVE (queue AC2 QA cross-check + Phase 6b burst protocol)'
    : 'NEGATIVE (close temporal-consensus lever on this corpus basis)',
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/vote_rows.json`, JSON.stringify({ all: all.detail, dense: dense.detail, ordinary: ord.detail }, null, 1));
fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
