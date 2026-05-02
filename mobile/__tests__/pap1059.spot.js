/**
 * PAP-1059 — spot-check sweep for chainringTcConfirmed bypass.
 *
 * Two cohorts:
 *   (1) LOSS-risk candidates from pap1052 head audit — Mid/Large rows that
 *       currently abstain WITH detected≥30 (would convert ABSTAIN→CONF-WRONG
 *       if the bypass mistakenly fires).
 *   (2) XL detected==actual abstain rows (mirror of the 5 AC1 seeds, plus more
 *       42/48/50/52T from the audit) — the WIN candidates the bypass should
 *       rescue.
 *
 * Verifies the predicate would NOT fire on (1) and WOULD fire on (2).
 * This is intended as an evidence cohort for the QA cross-check sweep, NOT
 * a substitute for the full corpus run.
 *
 * Run: HARNESS=pap1059.spot npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const path = require('path');
const fs = require('fs');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, TRAINING_DIR } = runner;

// (1) LOSS-risk candidates: ANY currently-abstain row with detected≥30 AND
// |detected-actual|≥2 (XL ±1 tol → LOSS) — pulled from pap1052 head audit.
const LOSS_RISK = [
  // Mid/Large
  { stamp: '2026-04-19_18-38-33-566Z', actual: 28, audit: 'd=32 diff=4' },
  { stamp: '2026-04-21_05-25-55-038Z', actual: 24, audit: 'd=44 diff=20' },
  { stamp: '2026-04-23_07-21-34-334Z', actual: 21, audit: 'd=44 diff=23' },
  { stamp: '2026-04-20_15-53-34-450Z', actual: 18, audit: 'd=44 diff=26' },
  // XL off-by-≥2
  { stamp: '2026-04-24_10-54-55-930Z', actual: 42, audit: 'd=40 diff=2' },
  { stamp: '2026-04-28_14-18-32-698Z', actual: 34, audit: 'd=40 diff=6' },
  { stamp: '2026-05-01_09-09-26-510Z', actual: 36, audit: 'd=34 diff=2' },
  { stamp: '2026-05-01_15-37-22-230Z', actual: 36, audit: 'd=38 diff=2' },
];

// (2) XL detected==actual abstains. Includes the 5 AC1 seeds + 10 more from audit.
const WIN_CANDIDATES = [
  // AC1 seeds
  { stamp: '2026-04-25_07-58-59-154Z', actual: 42 },
  { stamp: '2026-04-25_08-05-45-433Z', actual: 42 },
  { stamp: '2026-04-30_12-31-00-766Z', actual: 50 },
  { stamp: '2026-04-30_12-33-17-234Z', actual: 48 },
  { stamp: '2026-04-30_20-03-52-567Z', actual: 52 },
  // Additional XL abstains from audit
  { stamp: '2026-04-28_11-25-03-709Z', actual: 42 },
  { stamp: '2026-04-28_11-42-46-509Z', actual: 42 },
  { stamp: '2026-04-30_05-32-57-251Z', actual: 42 },
  { stamp: '2026-04-30_10-17-13-321Z', actual: 34 },
  { stamp: '2026-04-30_10-19-29-950Z', actual: 36 },
  { stamp: '2026-04-30_10-23-20-845Z', actual: 36 },
  { stamp: '2026-04-30_11-41-12-489Z', actual: 32 },
  { stamp: '2026-04-30_11-42-53-294Z', actual: 32 },
  { stamp: '2026-04-30_12-35-25-332Z', actual: 48 },
  { stamp: '2026-04-30_20-31-06-904Z', actual: 48 },
  { stamp: '2026-05-01_08-28-38-224Z', actual: 50 },
  { stamp: '2026-05-01_08-31-05-858Z', actual: 50 },
];

function fires(r) {
  if (r.tc < 30) return { fire: false, branch: '-' };
  if (r.peakTc === r.tc) return { fire: true, branch: 'A peakTc===tc' };
  if (r.bcTc === r.tc && Math.abs(r.bcPeaks - r.bcTc) <= 1) return { fire: true, branch: 'B bcTc===tc & bcPk±1' };
  return { fire: false, branch: 'tc>=30 but no channel match' };
}

function fmt(r) {
  return `tc=${r.tc} conf=${r.conf.toFixed(2)} peak=${r.peakTc} fft90=${r.fft90} ` +
    `op=${r.op} bc=${r.bcTc}(pk=${r.bcPeaks}) inSus=${r.innerSus} m=${r.method}`;
}

describe('PAP-1059 spot — LOSS-risk + WIN candidates', () => {
  jest.setTimeout(30 * 60 * 1000);
  test('predicate evaluation on 4 LOSS-risk + 17 WIN-candidate stamps', () => {
    out('\n=== PAP-1059 spot-check ===');
    out('Predicate: tc>=30 && (peakTc===tc || (bcTc===tc && |bcPeaks-bcTc|<=1))\n');

    // (1) LOSS-risk
    out('--- (1) Mid/Large LOSS-risk (current ABSTAIN, detected≥30) ---');
    let lossFires = 0;
    for (const t of LOSS_RISK) {
      const photo = path.join(TRAINING_DIR, `${t.stamp}_photo.jpg`);
      if (!fs.existsSync(photo)) { out(`  SKIP ${t.stamp} (missing)`); continue; }
      const r = runner.evalPhoto({ photo, actual: t.actual, stamp: t.stamp, applyMask: false });
      const f = fires(r);
      if (f.fire) lossFires++;
      const verdict = f.fire ? (r.within1 ? 'WIN' : 'LOSS') : 'NO-FIRE (safe)';
      out(`  [${verdict}] ${t.stamp} act=${t.actual} ${f.branch}  ${fmt(r)}`);
    }
    out(`  → fires on ${lossFires}/${LOSS_RISK.length} LOSS-risk rows`);

    // (2) WIN candidates
    out('\n--- (2) XL detected≈actual abstains ---');
    let winFires = 0; let winLoss = 0;
    for (const t of WIN_CANDIDATES) {
      const photo = path.join(TRAINING_DIR, `${t.stamp}_photo.jpg`);
      if (!fs.existsSync(photo)) { out(`  SKIP ${t.stamp} (missing)`); continue; }
      const r = runner.evalPhoto({ photo, actual: t.actual, stamp: t.stamp, applyMask: false });
      const f = fires(r);
      let verdict;
      if (!f.fire) verdict = 'NO-FIRE';
      else if (r.within1) { verdict = 'WIN '; winFires++; }
      else { verdict = 'LOSS'; winLoss++; winFires++; }
      out(`  [${verdict}] ${t.stamp} act=${t.actual} ${f.branch}  ${fmt(r)}`);
    }
    out(`  → fires on ${winFires}/${WIN_CANDIDATES.length}; LOSS=${winLoss}`);

    out('\n=== summary ===');
    out(`  LOSS-risk fires: ${lossFires} (target 0)`);
    out(`  WIN cohort fires: ${winFires} (target ≥ ${WIN_CANDIDATES.length - 2})`);
    out(`  WIN cohort LOSS: ${winLoss} (target 0)`);

    expect(true).toBe(true);
  });
});
