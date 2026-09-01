/**
 * PAP-1674: price the PAP-1659 wall-clock deadline gate against the 58.0%
 * (PAP-1658 @ 49a7498) baseline.
 *
 * Same corpus/harness as pap760.audit.js, but dumps a per-photo CSV row
 * (stamp, actual, tc, conf, correct/abstain/confidentWrong, budgetExhausted,
 * algorithmRuntimeMs) so this run can be diffed photo-by-photo against a
 * second run at a different commit (PAP-1674 AC2/AC3).
 *
 * Run:
 *   npx jest --runTestsByPath mobile/__tests__/pap1674.audit.js
 *
 * Output CSV path is controlled by PAP1674_OUT env var so the same script
 * can be run at two different SHAs without overwriting the first result.
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, evalPhoto, discoverLabeled } = runner;

const OUT_FILE = process.env.PAP1674_OUT
  ? path.resolve(process.env.PAP1674_OUT)
  : path.resolve(__dirname, '..', '..', 'debug-reports', 'pap1674_rows.csv');

describe('PAP-1674 wall-clock deadline gate pricing', () => {
  jest.setTimeout(30 * 60 * 1000);

  test('full-corpus per-photo rows with budgetExhausted', () => {
    const all = discoverLabeled({ minActual: 9, maxActual: 60 });
    all.sort((a, b) => (a.stamp < b.stamp ? -1 : 1));
    out(`[pap1674.audit] corpus=${all.length}`);

    const t0 = Date.now();
    const rows = [];
    for (let i = 0; i < all.length; i++) {
      const { photo, actual, stamp } = all[i];
      const r = evalPhoto({ photo, actual, stamp });
      rows.push(r);
      if ((i + 1) % 25 === 0) out(`  [${i + 1}/${all.length}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    const elapsedMs = Date.now() - t0;

    runner.printAuditReport({ rows, elapsedMs, label: 'PAP-1674' });

    const budgetHits = rows.filter(r => r.raw && r.raw.budgetExhausted).length;
    out(`\n[pap1674.audit] budgetExhausted fires: ${budgetHits}/${rows.length}`);
    const rt = rows.map(r => r.raw && r.raw.algorithmRuntimeMs).filter(Number.isFinite).sort((a, b) => a - b);
    if (rt.length) {
      const q = (p) => rt[Math.min(rt.length - 1, Math.floor(p * rt.length))];
      out(`[pap1674.audit] algorithmRuntimeMs p50=${q(0.5)} p90=${q(0.9)} p95=${q(0.95)} p99=${q(0.99)} max=${rt[rt.length - 1]}`);
    }

    const csvLines = ['stamp,actual,bucket,tc,conf,correct,abstain,confidentWrong,offBy,budgetExhausted,algorithmRuntimeMs,runtime,method'];
    for (const r of rows) {
      csvLines.push([
        r.stamp, r.actual, r.bucket, r.tc, r.conf.toFixed(3),
        r.correct ? 1 : 0, r.abstain ? 1 : 0, r.confidentWrong ? 1 : 0, r.offBy,
        (r.raw && r.raw.budgetExhausted) ? 1 : 0,
        (r.raw && r.raw.algorithmRuntimeMs) || '',
        r.runtime, r.method,
      ].join(','));
    }
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, csvLines.join('\n'));
    out(`\nrow-level csv: ${OUT_FILE} (${csvLines.length - 1} rows)`);

    expect(rows.length).toBeGreaterThan(0);
  });
});
