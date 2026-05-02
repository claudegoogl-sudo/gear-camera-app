/**
 * PAP-833 corpus sweep — 5-way [20-25] agreement override (XL chainring AC2).
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap833.sweep npx jest --config mobile/__tests__/.jest.harness.config.js
 */

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, DEBUG_DIR } = runner;

const LO = 20;
const HI = 25;

const XL_TARGETS = [
  { stamp: 'report_2026-04-29_05-29-04-170Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-31-25-376Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-33-35-933Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-35-33-518Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-37-38-177Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-39-22-521Z', actual: 52 },
];

function enrich(r) {
  const channels = [r.peakTc, r.fft90, r.op, r.bcTc, r.bcPeaks];
  const counts = {};
  for (const v of channels) counts[v] = (counts[v] || 0) + 1;
  let modeVal = null, modeN = 0;
  for (const k of Object.keys(counts)) {
    const v = Number(k);
    if (counts[k] > modeN) { modeN = counts[k]; modeVal = v; }
  }
  const all5Eq = modeN === 5;
  const inRange = modeVal != null && modeVal >= LO && modeVal <= HI;
  const rel = (r.raw && r.raw.radialRelDisagree != null) ? r.raw.radialRelDisagree : null;
  return Object.assign({}, r, { modeVal, modeN, all5Eq, inRange, rel });
}

function fmt(r) {
  return `${r.stamp} cls=${r.klass} actual=${r.actual} tc=${r.tc} ` +
    `conf=${r.conf.toFixed(2)} peak=${r.peakTc} fft90=${r.fft90} op=${r.op} ` +
    `bc=${r.bcTc}(pk=${r.bcPeaks}) ` +
    `mode=${r.modeVal}×${r.modeN} ` +
    `peakR=${r.peakR} rOuter=${r.rOuter} ` +
    `rel=${r.rel != null ? r.rel.toFixed(4) : 'n/a'} ` +
    `innerSus=${r.innerSus} method=${r.method}`;
}

describe('PAP-833 5-way [20-25] sweep', () => {
  jest.setTimeout(60 * 60 * 1000);

  test('enumerate AC2-shape rows on training + XL device corpus', () => {
    out(`\n=== PAP-833 5-way ${LO}-${HI} agreement sweep ===`);

    const { rows: base } = runner.runCorpus({
      targetRange: [9, 60],
      label: 'pap833',
    });
    const rows = base.map(enrich);
    out(`\n[Part 1] Training corpus: ${rows.length} photos`);

    const all5InRange = rows.filter(r => r.all5Eq && r.inRange);
    const four5InRange = rows.filter(r => !r.all5Eq && r.modeN === 4 && r.inRange);
    const three5InRange = rows.filter(r => !r.all5Eq && r.modeN === 3 && r.inRange);

    out(`\n-- 5-way [${LO}-${HI}] agreement rows (strict AC2 pattern) --`);
    out(`  total=${all5InRange.length}`);
    if (all5InRange.length === 0) out('  (none)');
    for (const r of all5InRange) out('  ' + fmt(r));

    function classifyOverrideOutcome(r) {
      if (r.actual >= 30) return 'CHAINRING-WIN';
      if (r.actual >= LO - 1 && r.actual <= HI + 1) return 'TRUE-RANGE-LOSS';
      return 'AMBIGUOUS';
    }

    out('\n-- Strict pattern outcome under hypothetical override --');
    const tally = { 'CHAINRING-WIN': 0, 'TRUE-RANGE-LOSS': 0, 'AMBIGUOUS': 0 };
    for (const r of all5InRange) {
      const tag = classifyOverrideOutcome(r);
      tally[tag]++;
      out(`  [${tag}] ${fmt(r)}`);
    }
    out(`  tally: ${JSON.stringify(tally)}`);

    out(`\n-- 4-of-5 [${LO}-${HI}] agreement rows --`);
    out(`  total=${four5InRange.length}`);
    for (const r of four5InRange) out('  ' + fmt(r));

    out(`\n-- 3-of-5 [${LO}-${HI}] agreement rows --`);
    out(`  total=${three5InRange.length}`);
    for (const r of three5InRange) out('  ' + fmt(r));

    out(`\n-- Actual-label histogram for rows with mode ∈ [${LO},${HI}] (any agreement count) --`);
    const inRangeAny = rows.filter(r => r.inRange && r.modeVal != null);
    const histByActual = {};
    for (const r of inRangeAny) {
      histByActual[r.actual] = (histByActual[r.actual] || 0) + 1;
    }
    const ks = Object.keys(histByActual).map(Number).sort((a, b) => a - b);
    for (const k of ks) out(`  actual=${k}: ${histByActual[k]} rows`);

    out(`\n-- modeVal histogram across full corpus (modeN ≥ 3) --`);
    const histMode = {};
    for (const r of rows.filter(x => x.modeN >= 3)) {
      histMode[r.modeVal] = (histMode[r.modeVal] || 0) + 1;
    }
    const km = Object.keys(histMode).map(Number).sort((a, b) => a - b);
    for (const k of km) out(`  mode=${k}: ${histMode[k]} rows`);

    out('\n[Part 2] XL device targets (cropped.jpg)');
    for (const t of XL_TARGETS) {
      const photo = path.join(DEBUG_DIR, t.stamp, 'cropped.jpg');
      if (!fs.existsSync(photo)) {
        out(`  [MISSING] ${t.stamp}`);
        continue;
      }
      const row = enrich(runner.evalPhoto({
        photo, actual: t.actual, stamp: t.stamp, applyMask: true,
      }));
      out('  ' + fmt(row));
    }

    expect(rows.length).toBeGreaterThan(0);
  });
});
