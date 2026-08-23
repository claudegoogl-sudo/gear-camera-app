/**
 * PAP-1672 AC1/AC2 — host speed reconciliation, jest side.
 *
 * Mirrors pap1672.speed.mjs exactly: same corpus discovery, same RGBA cache
 * (via harness-runner's loadOrDecodeRgba), same single call to
 * countTeethFromRgba(), same timer boundary (decode excluded, one call
 * timed). The only variable between the two files is babel-jest vs plain
 * node. Reads budgetExhausted straight off the algorithm's own return value
 * (PAP-1659) rather than re-timing internals.
 *
 * Run:
 *   HARNESS=pap1672.speed SCOPE=full STRIDE=<n> LABEL=<label> \
 *     npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();

const { countTeethFromRgba } = require('../src/algorithm/gearCounter');

const PAP760_BUCKETS = runner.PAP760_BUCKETS;
const bucketOf = runner.bucketOf;
const DEBUG_DIR = runner.DEBUG_DIR;

const label = process.env.LABEL || 'run';
const stride = Number(process.env.STRIDE || 1);
const snapPath = path.join(DEBUG_DIR, `pap1672_speed_jest_${label}.json`);

const quantile = (sorted, q) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;

function statsFor(rows, pick) {
  const v = rows.map(pick).sort((x, y) => x - y);
  const sum = v.reduce((x, y) => x + y, 0);
  return { p50: quantile(v, 0.5), p95: quantile(v, 0.95), max: v[v.length - 1] || 0, sum };
}

describe('PAP-1672 jest-side speed probe', () => {
  jest.setTimeout(3 * 60 * 60 * 1000);

  test('per-photo runtime + stageMs + budgetExhausted, same boundary as node side', () => {
    const { selected } = runner.selectCorpus({ scope: 'full' });
    const labeled = stride > 1 ? selected.filter((_, i) => i % stride === 0) : selected;
    process.stdout.write(`[pap1672-jest] measure label=${label} photos=${labeled.length} stride=${stride}\n`);

    const rows = [];
    const t0 = Date.now();
    for (let i = 0; i < labeled.length; i++) {
      const { photo, actual, stamp } = labeled[i];
      const { rgba, w, h } = runner.loadOrDecodeRgba(photo, stamp);
      const f0 = Date.now();
      let r;
      try { r = countTeethFromRgba(rgba, w, h); }
      catch (err) { r = { toothCount: 0, confidence: 0, error: err.message, budgetExhausted: false, methodUsed: 'ERROR' }; }
      const runtime = Date.now() - f0;
      rows.push({
        stamp, actual, w, h, runtime,
        budgetExhausted: !!r.budgetExhausted,
        methodUsed: r.methodUsed || '?',
        tc: r.toothCount || 0,
      });
      if ((i + 1) % 25 === 0) {
        process.stdout.write(`  [${i + 1}/${labeled.length}] ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
      }
    }
    const elapsedMs = Date.now() - t0;
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(snapPath, JSON.stringify({ label, elapsedMs, env: 'jest', rows }));

    process.stdout.write(`\n=== PAP-1672 jest-side speed [${label}] ===\n`);
    process.stdout.write(`Corpus: ${rows.length} photos   Wall: ${(elapsedMs / 1000).toFixed(1)}s\n`);
    const budgetHits = rows.filter((r) => r.budgetExhausted).length;
    process.stdout.write(`Budget-exhausted (pap1659-budget-exhausted): ${budgetHits}/${rows.length} (${((100 * budgetHits) / rows.length).toFixed(1)}%)\n`);
    const s = statsFor(rows, (r) => r.runtime);
    process.stdout.write(`total          p50=${s.p50}  p95=${s.p95}  max=${s.max}\n`);
    process.stdout.write('\nPer-bucket total runtime (matches PAP-760 buckets):\n');
    for (const bk of PAP760_BUCKETS) {
      const bucketRows = rows.filter((r) => bucketOf(r.actual)?.name === bk.name);
      if (!bucketRows.length) continue;
      const s = statsFor(bucketRows, (r) => r.runtime);
      const hits = bucketRows.filter((r) => r.budgetExhausted).length;
      process.stdout.write(`${bk.name}  N=${String(bucketRows.length).padStart(3)}  p50=${String(s.p50).padStart(5)}  p95=${String(s.p95).padStart(5)}  max=${String(s.max).padStart(5)}  budgetHit=${hits}\n`);
    }
    process.stdout.write(`\n[pap1672-jest] snapshot -> ${snapPath}\n`);

    expect(rows.length).toBeGreaterThan(0);
  });
});
