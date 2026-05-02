/**
 * PAP-939 b116 XL diagnostic — replay the 8 b116 XL device captures through
 * countTeethFromRgba and dump every per-method value, abstain-gate state, and
 * candidate-predicate state so we can pick a clean abstain rule.
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap939.diag npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, DEBUG_DIR } = runner;

const B116_XL = [
  { stamp: 'report_2026-05-01_08-22-10-875Z', actual: 52, label: '52T-CW-13' },
  { stamp: 'report_2026-05-01_08-24-01-784Z', actual: 52, label: '52T-abstain' },
  { stamp: 'report_2026-05-01_08-26-34-045Z', actual: 52, label: '52T-CW-32' },
  { stamp: 'report_2026-05-01_08-28-32-755Z', actual: 50, label: '50T-abstain' },
  { stamp: 'report_2026-05-01_08-30-59-457Z', actual: 50, label: '50T-abstain' },
  { stamp: 'report_2026-05-01_09-03-58-615Z', actual: 48, label: '48T-correct' },
  { stamp: 'report_2026-05-01_09-07-06-225Z', actual: 42, label: '42T-correct' },
  { stamp: 'report_2026-05-01_09-09-19-262Z', actual: 36, label: '36T-abstain' },
];

describe('PAP-939 b116 XL diagnostic', () => {
  jest.setTimeout(20 * 60 * 1000);
  test('replay b116 XL captures', () => {
    out('\n=== PAP-939 b116 XL diagnostic ===');
    const rows = [];
    for (const t of B116_XL) {
      const photo = path.join(DEBUG_DIR, t.stamp, 'cropped.jpg');
      if (!fs.existsSync(photo)) { out(`  [missing] ${t.stamp}`); continue; }
      const row = runner.evalPhoto({
        photo, actual: t.actual, stamp: t.stamp, applyMask: true,
      });
      const r = row.raw;
      rows.push({
        stamp: row.stamp,
        actual: row.actual,
        w: row.w, h: row.h,
        tc: row.tc,
        conf: row.conf,
        innerSus: row.innerSus,
        method: row.method,
        gearR: row.gearR,
        peakTc: row.peakTc,
        fft90: row.fft90,
        op: row.op,
        bcTc: row.bcTc,
        bcPeaks: row.bcPeaks,
        peakR: row.peakR,
        rOuter: row.rOuter,
        radialRel: r.radialRelDisagree,
        label: t.label,
      });
    }

    out('\n--- per-row ---');
    for (const r of rows) {
      out(`${r.stamp.replace('report_2026-05-01_','')} ${r.label}`);
      out(`  actual=${r.actual} tc=${r.tc} conf=${r.conf.toFixed(3)} method=${r.method} innerSus=${r.innerSus}`);
      out(`  peakTc=${r.peakTc} fft90=${r.fft90} op=${r.op} bcTc=${r.bcTc} bcPk=${r.bcPeaks}`);
      out(`  gearR=${r.gearR.toFixed(3)} peakR=${r.peakR} rOuter=${r.rOuter} ` +
          `radialRel=${r.radialRel == null ? 'null' : r.radialRel.toFixed(3)} ` +
          `crop=${r.w}x${r.h}`);
    }

    out('\n--- candidate predicates (harness/crop-space gearR) ---');
    const chReg = (r) => r.peakTc >= 30 || r.fft90 >= 30 || r.op >= 30
      || r.bcTc >= 30 || r.bcPeaks >= 30;
    const cands = [
      ['existing PAP-889 (gR<0.20 tc<30 conf<0.40)', (r) =>
        r.gearR < 0.20 && r.tc < 30 && r.conf < 0.40],
      ['Cand-1 (device 0.22): gR<0.365 tc<35 conf<0.55', (r) =>
        r.gearR < 0.365 && r.tc < 35 && r.conf < 0.55],
      ['Cand-2 (device 0.22): gR<0.365 tc<35 chainringRegime', (r) =>
        r.gearR < 0.365 && r.tc < 35 && chReg(r)],
      ['Cand-3: gR<0.365 + dual-inner-lock (|peakR-rOuter|/rOuter<0.10) + chReg', (r) =>
        r.gearR < 0.365 && r.peakR > 0 && r.rOuter > 0 &&
        Math.abs(r.peakR - r.rOuter) / r.rOuter < 0.10 && chReg(r)],
      ['Cand-4: gR<0.365 + tc<35 + chReg + (peakR/min<0.40 OR conf<0.55)', (r) =>
        r.gearR < 0.365 && r.tc < 35 && chReg(r) &&
        ((r.peakR / Math.min(r.w, r.h)) < 0.40 || r.conf < 0.55)],
      ['Cand-5: gR<0.365 + tc<35 + chReg + bcPeaks differs from bcTc by >5', (r) =>
        r.gearR < 0.365 && r.tc < 35 && chReg(r) && r.bcTc > 0 && r.bcPeaks > 0 &&
        Math.abs(r.bcTc - r.bcPeaks) > 5],
      ['Cand-6: gR<0.365 + tc<35 + (any chainring channel >=30 AND tc < that channel - 10)', (r) => {
        if (r.gearR >= 0.365 || r.tc >= 35) return false;
        const ch = [r.peakTc, r.fft90, r.op, r.bcTc, r.bcPeaks];
        return ch.some((v) => v >= 30 && (v - r.tc) >= 10);
      }],
      ['Cand-7: gR<0.365 + tc<35 + (peakR<350 in 900-px crop) + chReg', (r) =>
        r.gearR < 0.365 && r.tc < 35 && r.peakR > 0 && r.peakR < 350 && chReg(r)],
    ];

    for (const [name, fn] of cands) {
      out(`\n${name}`);
      let win = 0, loss = 0, noop = 0, pass = 0;
      const decisions = [];
      for (const r of rows) {
        const fires = fn(r);
        const correct = r.tc === r.actual;
        const alreadyAbstain = r.conf === 0 || r.innerSus;
        let verdict;
        if (!fires) verdict = 'PASS';
        else if (alreadyAbstain) verdict = 'NOOP';
        else if (correct) verdict = 'LOSS';
        else verdict = 'WIN';
        if (verdict === 'WIN') win++;
        else if (verdict === 'LOSS') loss++;
        else if (verdict === 'NOOP') noop++;
        else pass++;
        decisions.push(`  ${r.stamp.slice(-22, -5)} ${r.label} tc=${r.tc} conf=${r.conf.toFixed(2)} → ${verdict}`);
      }
      out(`  WIN=${win} LOSS=${loss} NOOP=${noop} PASS=${pass}`);
      for (const d of decisions) out(d);
    }

    expect(rows.length).toBe(B116_XL.length);
  });
});
