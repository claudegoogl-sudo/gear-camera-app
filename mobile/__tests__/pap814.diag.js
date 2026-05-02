/**
 * PAP-814 — XL op-vote-boost threshold sweep.
 *
 * Sweeps the proposed predicate
 *
 *   methodUsed === 'fft-agreement'
 *     && peakTc === fft90tc
 *     && peakTc >= 30
 *     && opTc === peakTc + 1
 *     && opRel >= THRESH
 *   -> finalTc = opTc
 *
 * across:
 *   - the full 9-60T training corpus (pap796 pattern)
 *   - the two device 42T XL targets (cropped.jpg) from PAP-810
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap814.diag npx jest --config mobile/__tests__/.jest.harness.config.js
 */

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, DEBUG_DIR } = runner;

const MIN_TEETH = 10;
const THRESHOLDS = [0.04, 0.06, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25];

const XL_TARGETS = [
  { stamp: 'report_2026-04-29_05-29-04-170Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-31-25-376Z', actual: 42 },
];

function predicateFires(r, T) {
  if ((r.method || '') !== 'fft-agreement') return false;
  if (!(r.peakTc >= 30)) return false;
  if (r.peakTc !== r.fft90) return false;
  if (r.op !== r.peakTc + 1) return false;
  if (!((r.raw && r.raw.opRel ? r.raw.opRel : 0) >= T)) return false;
  return true;
}

describe('PAP-814 op-vote-boost threshold sweep', () => {
  jest.setTimeout(60 * 60 * 1000);

  test('measure XL op-vote-boost across 9-60T corpus + 42T XL targets', () => {
    // Training corpus via runCorpus.
    const { rows: train, elapsedMs } = runner.runCorpus({
      targetRange: [9, 60],
      label: 'pap814-train',
    });

    // Device-faithful XL targets via evalPhoto on cropped.jpg.
    const xlRows = [];
    for (const t of XL_TARGETS) {
      const cropped = path.join(DEBUG_DIR, t.stamp, 'cropped.jpg');
      if (!fs.existsSync(cropped)) {
        out(`  [pap814] WARN missing cropped.jpg for ${t.stamp}`);
        continue;
      }
      const row = runner.evalPhoto({
        photo: cropped, actual: t.actual, stamp: t.stamp, applyMask: true,
      });
      xlRows.push(Object.assign({}, row, { source: 'xl-cropped' }));
    }
    const baseRows = train.map((r) => Object.assign({}, r, { source: 'train' })).concat(xlRows);

    // Pull opRel into the top-level row for predicate use.
    const rows = baseRows.map((r) => Object.assign({}, r, {
      opRel: (r.raw && r.raw.opRel) ? r.raw.opRel : 0,
    }));

    out(`\n[pap814] inspecting ${rows.length} photos (training + XL cropped)`);

    const fmt = (r) => `${r.stamp}  src=${r.source} cls=${r.klass} actual=${r.actual} ` +
      `tc=${r.tc} conf=${r.conf.toFixed(2)} peak=${r.peakTc} fft90=${r.fft90} ` +
      `op=${r.op} opRel=${r.opRel.toFixed(3)} bcTc=${r.bcTc} bcPk=${r.bcPeaks} ` +
      `gR=${r.gearR.toFixed(3)} innerSus=${r.innerSus} method=${r.method}`;

    out('\n=== PAP-814 op-vote-boost cross-check ===');
    out(`Corpus: ${rows.length} photos.  Wall: ${(elapsedMs / 1000).toFixed(0)}s`);

    // --- 1. Predicate-eligible rows ---
    out('\n-- Predicate-eligible rows (method=fft-agreement, peak===fft90, peak>=30, op===peak+1) --');
    const eligible = rows.filter(r =>
      r.method === 'fft-agreement' &&
      r.peakTc === r.fft90 &&
      r.peakTc >= 30 &&
      r.op === r.peakTc + 1
    );
    out(`(${eligible.length} eligible rows)`);
    for (const r of eligible) out('  ' + fmt(r));

    // --- 2. Threshold sweep ---
    out('\n-- Threshold sweep --');
    out('thresh | fires | wins(off±1 better) | losses(off worse) | net | by_class W/L');
    const klasses = ['Small', 'Mid', 'Large', 'XL'];
    for (const T of THRESHOLDS) {
      let fires = 0, wins = 0, losses = 0;
      const cw = { Small: [0,0], Mid: [0,0], Large: [0,0], XL: [0,0] };
      for (const r of rows) {
        if (!predicateFires(r, T)) continue;
        fires++;
        const baselineOff = Math.abs(r.tc - r.actual);
        const newOff = Math.abs(r.op - r.actual);
        if (newOff < baselineOff) { wins++; cw[r.klass][0]++; }
        else if (newOff > baselineOff) { losses++; cw[r.klass][1]++; }
      }
      const cwStr = klasses.map(k => `${k} ${cw[k][0]}/${cw[k][1]}`).join('  ');
      out(`  ${T.toFixed(3)} | ${String(fires).padStart(5)} | ${String(wins).padStart(18)} | ` +
          `${String(losses).padStart(17)} | ${String(wins-losses).padStart(3)} | ${cwStr}`);
    }

    // --- 3. Detailed dump for representative T ---
    for (const T of [0.04, 0.10]) {
      out(`\n-- Predicate fires at THRESH=${T.toFixed(3)} --`);
      const fired = rows.filter(r => predicateFires(r, T));
      if (fired.length === 0) out('  (none)');
      for (const r of fired) {
        const newOff = r.op - r.actual;
        const baseOff = r.tc - r.actual;
        const verdict = Math.abs(newOff) < Math.abs(baseOff) ? 'WIN' :
                        Math.abs(newOff) > Math.abs(baseOff) ? 'LOSS' : 'NEUTRAL';
        out(`  [${verdict}] base=${baseOff>=0?'+':''}${baseOff} new=${newOff>=0?'+':''}${newOff}  ` + fmt(r));
      }
    }

    // --- 4. Confident-wrong baseline (informational) ---
    out('\n-- Confident-wrong baseline rows (off>1, conf>0, !innerSus) --');
    const wrongRows = rows.filter(r => Math.abs(r.tc - r.actual) > 1 && r.conf > 0 && !r.innerSus);
    out(`(${wrongRows.length} rows)`);
    for (const r of wrongRows) out('  ' + fmt(r));

    expect(rows.length).toBeGreaterThan(0);
  });
});
