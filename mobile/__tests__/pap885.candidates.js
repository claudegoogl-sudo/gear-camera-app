/**
 * PAP-885 candidate sweep: 5-way-agree override for radial-chainring abstain.
 *
 * Goal: rescue b114 36T (10-19-19, 10-23-07) where radialChainringFires fires
 * (peakR/rOuter disagree at chainring scale) BUT all 5 FFT channels
 * (peakTc, fft90tc, opTc, bcTc, bcPeaks) agree within ±1 at chainring scale —
 * indicating rOuter is locked onto a wrong inner band, not that the tooth
 * count is wrong.  Verify no regression on:
 *   - 305-photo training corpus
 *   - 10 prior XL device targets (b111 + b112)
 *   - 5 b114 XL device targets (this issue)
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap885.candidates npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, DEBUG_DIR } = runner;

const B111_XL = [
  { stamp: 'report_2026-04-29_05-29-04-170Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-31-25-376Z', actual: 42 },
  { stamp: 'report_2026-04-29_05-33-35-933Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-35-33-518Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-37-38-177Z', actual: 52 },
  { stamp: 'report_2026-04-29_05-39-22-521Z', actual: 52 },
];
const B112_XL = [
  { stamp: 'report_2026-04-30_05-32-51-092Z', actual: 42 },
  { stamp: 'report_2026-04-30_05-34-20-458Z', actual: 42 },
  { stamp: 'report_2026-04-30_05-35-59-637Z', actual: 42 },
  { stamp: 'report_2026-04-30_05-37-35-156Z', actual: 42 },
];
const B114_XL = [
  { stamp: 'report_2026-04-30_10-09-03-515Z', actual: 34 },
  { stamp: 'report_2026-04-30_10-14-44-086Z', actual: 34 },
  { stamp: 'report_2026-04-30_10-17-03-115Z', actual: 34 },
  { stamp: 'report_2026-04-30_10-19-19-295Z', actual: 36 },
  { stamp: 'report_2026-04-30_10-23-07-161Z', actual: 36 },
];

// Candidate: 5-way-agree override for radial-chainring abstain.
// When radialChainringFires (rel >= 0.18 AND chainring/ac1 eligible) but all
// 5 FFT channels (peak, fft90, op, bcTc, bcPeaks) are >= 30 AND their
// max-min spread is <= 1, bypass the abstain — bcConsensusBetweenChannels
// at chainring scale strongly indicates rOuter mis-anchored, not tc wrong.
const CANDIDATES = [
  {
    name: '5way-agree-d1-thr30',
    fires: (r) => {
      if (!r.radialChainringFires) return false;
      const ch = [r.peak, r.fft90, r.op, r.bcTc, r.bcPeaks];
      if (ch.some((v) => v < 30)) return false;
      return Math.max(...ch) - Math.min(...ch) <= 1;
    },
  },
  {
    name: '5way-agree-d2-thr30',
    fires: (r) => {
      if (!r.radialChainringFires) return false;
      const ch = [r.peak, r.fft90, r.op, r.bcTc, r.bcPeaks];
      if (ch.some((v) => v < 30)) return false;
      return Math.max(...ch) - Math.min(...ch) <= 2;
    },
  },
  // Tighter variant: same predicate but require methodUsed to be a confident
  // FFT-consensus method (avoid bc-only or fallback paths).
  {
    name: '5way-d1-thr30-fftMethod',
    fires: (r) => {
      if (!r.radialChainringFires) return false;
      const ch = [r.peak, r.fft90, r.op, r.bcTc, r.bcPeaks];
      if (ch.some((v) => v < 30)) return false;
      if (Math.max(...ch) - Math.min(...ch) > 1) return false;
      return r.method === 'bc-consensus+peak'
          || r.method === 'bc-consensus+fft-agree'
          || r.method === 'bc-consensus'
          || r.method === 'fft-agreement'
          || r.method === 'fft-agreement+xl-op-vote-boost';
    },
  },
];

function enrich(r) {
  // Translate runner row fields to the legacy predicate vocabulary and
  // recompute radial-chainring eligibility the same way the outer wrapper
  // in countTeethFromRgba does.
  const peak = r.peakTc || 0;
  const fft90 = r.fft90 || 0;
  const op = r.op || 0;
  const bcTc = r.bcTc || 0;
  const bcPeaks = r.bcPeaks || 0;
  const peakR = r.peakR || 0;
  const rOuter = r.rOuter || 0;
  const gearRadius = r.gearR || 0;
  const rel = (r.raw && r.raw.radialRelDisagree != null) ? r.raw.radialRelDisagree : null;

  const MIN_TEETH = 10;
  const chainring = peak >= 30 || fft90 >= 30 || op >= 30 || bcTc >= 30 || bcPeaks >= 30;
  const ac1Pattern = peak <= MIN_TEETH + 2 && fft90 <= MIN_TEETH + 2 && op <= MIN_TEETH + 2
    && bcTc <= MIN_TEETH + 2 && bcPeaks >= 20 && bcPeaks <= 30;
  const eligible = chainring || ac1Pattern;
  const radialChainringFires =
    eligible && peakR > 0 && rOuter > 0 && Math.abs(peakR - rOuter) / rOuter >= 0.18;

  return Object.assign({}, r, {
    peak, fft90, op, bcTc, bcPeaks,
    peakR, rOuter, gearRadius, rel,
    eligible, radialChainringFires,
    abstainedFromChainring: radialChainringFires && r.innerSus,
    wasConfidentWrong: !r.within1 && r.tc > 0 && r.conf > 0 && !r.innerSus,
    wasConfidentCorrect: r.within1 && r.tc > 0 && r.conf > 0 && !r.innerSus,
  });
}

function fmt(r) {
  return `${r.stamp} cls=${r.klass} actual=${r.actual} tc=${r.tc} ` +
    `conf=${r.conf.toFixed(2)} peak=${r.peak} fft90=${r.fft90} op=${r.op} ` +
    `bc=${r.bcTc}(pk=${r.bcPeaks}) ` +
    `gearR=${r.gearRadius.toFixed(3)} ` +
    `rel=${r.rel != null ? r.rel.toFixed(4) : 'n/a'} ` +
    `chFires=${r.radialChainringFires?'Y':'N'} ` +
    `method=${r.method}`;
}

// For 5-way-agree override: predicate fires when it WOULD bypass the
// chainring abstain.  Outcome buckets:
//   rescueWin    — currently abstained (innerSus), tc would commit ±1 of actual
//   rescueLoss   — currently abstained, tc would commit >1 from actual (new wrong)
//   benignFire   — currently confident (override would change nothing OR keep correct)
//   noopFire     — currently abstained but tc rescue would already be correct
function bucketRescue(rows, cand) {
  const wins = [];
  const losses = [];
  const benign = [];
  const wouldNoop = [];
  for (const r of rows) {
    if (!cand.fires(r)) continue;
    if (r.innerSus && (r.tc > 0)) {
      if (r.within1) wins.push(r);
      else losses.push(r);
    } else if (r.tc > 0 && r.conf > 0) {
      benign.push(r);
    } else {
      wouldNoop.push(r);
    }
  }
  return { wins, losses, benign, wouldNoop };
}

describe('PAP-885 candidate sweep', () => {
  jest.setTimeout(120 * 60 * 1000);
  test('5-way-agree override for radial-chainring abstain', () => {
    out('\n=== PAP-885 5-way-agree override sweep ===');

    const xlOnly = process.env.PAP885_XL_ONLY === '1';

    // Training corpus
    let trainRows = [];
    if (!xlOnly) {
      const { rows: base } = runner.runCorpus({
        targetRange: [9, 60],
        label: 'pap885-train',
        progressEvery: 50,
      });
      trainRows = base.map(enrich);
    }
    out(`\n[Training] ${trainRows.length} photos (9-60T)`);

    // XL device targets
    const allXl = [
      ...B111_XL.map(t => ({ ...t, build: 'b111' })),
      ...B112_XL.map(t => ({ ...t, build: 'b112' })),
      ...B114_XL.map(t => ({ ...t, build: 'b114' })),
    ];
    const xlRows = [];
    for (const t of allXl) {
      const photo = path.join(DEBUG_DIR, t.stamp, 'cropped.jpg');
      if (!fs.existsSync(photo)) { out(`  [missing] ${t.stamp}`); continue; }
      const row = enrich(runner.evalPhoto({
        photo, actual: t.actual, stamp: t.stamp, applyMask: true,
      }));
      row.build = t.build;
      xlRows.push(row);
    }
    out(`\n[XL device] ${xlRows.length} targets`);
    for (const r of xlRows) out(`  build=${r.build} ${fmt(r)}`);

    out('\n--- Eligibility / chainring-abstain rows ---');
    const trainAbstainedChainring = trainRows.filter(r => r.radialChainringFires && r.innerSus);
    const xlAbstainedChainring = xlRows.filter(r => r.radialChainringFires && r.innerSus);
    out(`  training: ${trainAbstainedChainring.length} radial-chainring-abstained rows`);
    out(`  xl:       ${xlAbstainedChainring.length} radial-chainring-abstained rows`);
    if (xlAbstainedChainring.length) {
      out('  (xl detail)');
      for (const r of xlAbstainedChainring) out(`    ${fmt(r)} build=${r.build}`);
    }

    out('\n--- Candidate evaluation: TRAINING corpus ---');
    out('  cand                          fires  wins  losses  benign  noop');
    for (const c of CANDIDATES) {
      const { wins, losses, benign, wouldNoop } = bucketRescue(trainRows, c);
      const fires = wins.length + losses.length + benign.length + wouldNoop.length;
      out(`  ${c.name.padEnd(28)} ${String(fires).padStart(5)} ${String(wins.length).padStart(5)} ${String(losses.length).padStart(7)} ${String(benign.length).padStart(7)} ${String(wouldNoop.length).padStart(5)}`);
      if (losses.length) {
        out(`    LOSS rows under "${c.name}":`);
        for (const r of losses) out('      ' + fmt(r));
      }
      if (wins.length) {
        out(`    WIN rows under "${c.name}":`);
        for (const r of wins) out('      ' + fmt(r));
      }
    }

    out('\n--- Candidate evaluation: XL device targets ---');
    out('  cand                          fires  wins  losses  benign  noop');
    for (const c of CANDIDATES) {
      const { wins, losses, benign, wouldNoop } = bucketRescue(xlRows, c);
      const fires = wins.length + losses.length + benign.length + wouldNoop.length;
      out(`  ${c.name.padEnd(28)} ${String(fires).padStart(5)} ${String(wins.length).padStart(5)} ${String(losses.length).padStart(7)} ${String(benign.length).padStart(7)} ${String(wouldNoop.length).padStart(5)}`);
      if (wins.length || losses.length || benign.length || wouldNoop.length) {
        for (const r of wins)   out(`    [WIN]    ${fmt(r)} build=${r.build}`);
        for (const r of losses) out(`    [LOSS]   ${fmt(r)} build=${r.build}`);
        for (const r of benign) out(`    [BENIGN] ${fmt(r)} build=${r.build}`);
        for (const r of wouldNoop) out(`    [NOOP]   ${fmt(r)} build=${r.build}`);
      }
    }

    expect(xlRows.length).toBeGreaterThan(0);
  });
});
