/**
 * PAP-861 candidate predicate sweep.
 *
 * Goal: prevent the b112 42T 05-37-35 confident-wrong (tc=39 conf=0.27) WITHOUT
 * regressing the existing 305-photo training corpus or the 6 XL device targets.
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap861.candidates npx jest --config mobile/__tests__/.jest.harness.config.js
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

const MIN_TEETH = 10;

const CANDIDATES = [
  {
    name: 'rel-threshold-0.16',
    fires: (r) => r.eligible && r.rel != null && r.rel >= 0.16,
  },
  {
    name: 'rel-threshold-0.14',
    fires: (r) => r.eligible && r.rel != null && r.rel >= 0.14,
  },
  {
    name: 'rel-threshold-0.13',
    fires: (r) => r.eligible && r.rel != null && r.rel >= 0.13,
  },
  {
    name: 'bc-isolated-d8',
    fires: (r) =>
      r.method === 'bc-consensus'
      && r.bcTc >= 30 && r.bcPeaks >= 30
      && r.peakTc > 0 && r.fft90 > 0 && r.op > 0
      && (r.bcTc - r.peakTc) >= 8
      && (r.bcTc - r.fft90) >= 8
      && (r.bcTc - r.op) >= 8,
  },
  {
    name: 'bc-isolated-d10',
    fires: (r) =>
      r.method === 'bc-consensus'
      && r.bcTc >= 30 && r.bcPeaks >= 30
      && r.peakTc > 0 && r.fft90 > 0 && r.op > 0
      && (r.bcTc - r.peakTc) >= 10
      && (r.bcTc - r.fft90) >= 10
      && (r.bcTc - r.op) >= 10,
  },
  {
    name: 'bc-isolated-d12',
    fires: (r) =>
      r.method === 'bc-consensus'
      && r.bcTc >= 30 && r.bcPeaks >= 30
      && r.peakTc > 0 && r.fft90 > 0 && r.op > 0
      && (r.bcTc - r.peakTc) >= 12
      && (r.bcTc - r.fft90) >= 12
      && (r.bcTc - r.op) >= 12,
  },
  {
    name: 'bc-d10 OR rel-0.14',
    fires: (r) =>
      (r.method === 'bc-consensus'
        && r.bcTc >= 30 && r.bcPeaks >= 30
        && r.peakTc > 0 && r.fft90 > 0 && r.op > 0
        && (r.bcTc - r.peakTc) >= 10
        && (r.bcTc - r.fft90) >= 10
        && (r.bcTc - r.op) >= 10)
      || (r.eligible && r.rel != null && r.rel >= 0.14),
  },
];

const RESCUE_CANDIDATES = [
  {
    name: 'pap868-rescue-A',
    fires: (r) =>
      r.peakTc === MIN_TEETH
      && r.fft90 >= 30
      && r.gearR > 0.30,
    rescue: (r) => r.fft90,
  },
  {
    name: 'pap868-rescue-E',
    fires: (r) =>
      r.peakTc === MIN_TEETH
      && r.fft90 >= 30
      && r.op > 0
      && Math.abs(r.fft90 - 2 * r.op) <= 2
      && r.gearR > 0.30
      && r.innerSus
      && r.rel != null && r.rel >= 0.18,
    rescue: (r) => r.fft90,
  },
  {
    name: 'pap868-rescue-AE',
    fires: (r) => {
      const aFires = r.peakTc === MIN_TEETH && r.fft90 >= 30 && r.gearR > 0.30;
      const eFires = r.peakTc === MIN_TEETH && r.fft90 >= 30 && r.op > 0
        && Math.abs(r.fft90 - 2 * r.op) <= 2 && r.gearR > 0.30
        && r.innerSus && r.rel != null && r.rel >= 0.18;
      return aFires || eFires;
    },
    rescue: (r) => r.fft90,
  },
];

function enrich(r) {
  const rel = (r.raw && r.raw.radialRelDisagree != null) ? r.raw.radialRelDisagree : null;
  const chainring = r.peakTc >= 30 || r.fft90 >= 30 || r.op >= 30 || r.bcTc >= 30 || r.bcPeaks >= 30;
  const ac1Pattern = r.peakTc <= MIN_TEETH + 2 && r.fft90 <= MIN_TEETH + 2 && r.op <= MIN_TEETH + 2
    && r.bcTc <= MIN_TEETH + 2 && r.bcPeaks >= 20 && r.bcPeaks <= 30;
  const eligible = chainring || ac1Pattern;
  const abstained = r.tc === 0 && r.conf === 0;
  const outerForcedZero = r.tc > 0 && r.conf === 0 && r.innerSus;
  return Object.assign({}, r, {
    rel, eligible, abstained, outerForcedZero,
    wasConfidentWrong: !r.within1 && r.tc > 0 && r.conf > 0 && !r.innerSus,
    wasConfidentCorrect: r.within1 && r.tc > 0 && r.conf > 0 && !r.innerSus,
  });
}

function fmt(r) {
  return `${r.stamp} cls=${r.klass} actual=${r.actual} tc=${r.tc} ` +
    `conf=${r.conf.toFixed(2)} peak=${r.peakTc} fft90=${r.fft90} op=${r.op} ` +
    `bc=${r.bcTc}(pk=${r.bcPeaks}) ` +
    `gearR=${r.gearR.toFixed(3)} ` +
    `rel=${r.rel != null ? r.rel.toFixed(4) : 'n/a'} ` +
    `method=${r.method}`;
}

function bucketRescue(rows, cand) {
  const wins = [], newWrongs = [], confChk = [], noopFires = [];
  for (const r of rows) {
    if (!cand.fires(r)) continue;
    const rescuedTc = cand.rescue(r);
    const within1 = Math.abs(rescuedTc - r.actual) <= 1;
    if (r.wasConfidentCorrect || r.wasConfidentWrong) {
      confChk.push({ ...r, rescuedTc, within1 });
    } else if (r.abstained || r.outerForcedZero) {
      if (within1) wins.push({ ...r, rescuedTc });
      else newWrongs.push({ ...r, rescuedTc });
    } else {
      noopFires.push({ ...r, rescuedTc, within1 });
    }
  }
  return { wins, newWrongs, confChk, noopFires };
}

describe('PAP-861 candidate predicate sweep', () => {
  jest.setTimeout(120 * 60 * 1000);
  test('evaluate candidates on training + b111 + b112 XL targets', () => {
    out('\n=== PAP-861 candidate predicate sweep ===');

    const xlOnly = process.env.PAP871_XL_ONLY === '1';
    let trainRows = [];
    if (!xlOnly) {
      const { rows } = runner.runCorpus({
        targetRange: [9, 60],
        label: 'pap861-train',
        progressEvery: 50,
      });
      trainRows = rows.map(enrich);
    }
    out(`\n[Training] ${trainRows.length} photos (9-60T)`);

    const xlRows = [];
    const allXl = [...B111_XL.map(t => ({ ...t, build: 'b111' })), ...B112_XL.map(t => ({ ...t, build: 'b112' }))];
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

    out('\n--- Candidate evaluation: TRAINING corpus ---');
    out('  cand                       fires  wins  losses  neutral');
    for (const c of CANDIDATES) {
      const fires = trainRows.filter(c.fires);
      const wins = fires.filter(r => r.wasConfidentWrong);
      const losses = fires.filter(r => r.wasConfidentCorrect);
      const neutral = fires.filter(r => !r.wasConfidentWrong && !r.wasConfidentCorrect);
      out(`  ${c.name.padEnd(26)} ${String(fires.length).padStart(5)} ${String(wins.length).padStart(5)} ${String(losses.length).padStart(7)} ${String(neutral.length).padStart(8)}`);
    }
    for (const c of CANDIDATES) {
      const fires = trainRows.filter(c.fires);
      const losses = fires.filter(r => r.wasConfidentCorrect);
      if (losses.length === 0) continue;
      out(`\n  LOSS rows under "${c.name}":`);
      for (const r of losses) out('    ' + fmt(r));
    }
    out('\n  Wins under each candidate:');
    for (const c of CANDIDATES) {
      const wins = trainRows.filter(c.fires).filter(r => r.wasConfidentWrong);
      if (wins.length === 0) continue;
      out(`\n  WIN rows under "${c.name}":`);
      for (const r of wins) out('    ' + fmt(r));
    }

    out('\n--- Candidate evaluation: XL device targets (b111+b112) ---');
    out('  cand                       fires  wins  losses');
    for (const c of CANDIDATES) {
      const fires = xlRows.filter(c.fires);
      const wins = fires.filter(r => r.wasConfidentWrong);
      const losses = fires.filter(r => r.wasConfidentCorrect);
      out(`  ${c.name.padEnd(26)} ${String(fires.length).padStart(5)} ${String(wins.length).padStart(5)} ${String(losses.length).padStart(7)}`);
    }
    for (const c of CANDIDATES) {
      const fires = xlRows.filter(c.fires);
      if (fires.length === 0) continue;
      out(`\n  XL fires under "${c.name}":`);
      for (const r of fires) {
        const tag = r.wasConfidentWrong ? 'WIN' : (r.wasConfidentCorrect ? 'LOSS' : 'neutral');
        out(`    [${tag}] ${fmt(r)}`);
      }
    }

    out('\n=== PAP-871 rescue-candidate sweep (Options A / E / A+E) ===');
    out('\n--- Rescue evaluation: TRAINING corpus (305-photo target) ---');
    out('  cand                  wins  newWrongs  confChk  noopFires');
    const trainRescueResults = {};
    for (const c of RESCUE_CANDIDATES) {
      const { wins, newWrongs, confChk, noopFires } = bucketRescue(trainRows, c);
      trainRescueResults[c.name] = { wins, newWrongs, confChk, noopFires };
      out(`  ${c.name.padEnd(20)} ${String(wins.length).padStart(5)} ${String(newWrongs.length).padStart(10)} ${String(confChk.length).padStart(8)} ${String(noopFires.length).padStart(10)}`);
    }
    for (const c of RESCUE_CANDIDATES) {
      const { wins, newWrongs, confChk } = trainRescueResults[c.name];
      if (wins.length > 0) {
        out(`\n  WIN rows under "${c.name}" (rescue lands within ±1 of actual):`);
        for (const r of wins) out(`    rescuedTc=${r.rescuedTc} ${fmt(r)}`);
      }
      if (newWrongs.length > 0) {
        out(`\n  NEW-WRONG rows under "${c.name}" (rescue would commit non-truth):`);
        for (const r of newWrongs) out(`    rescuedTc=${r.rescuedTc} ${fmt(r)}`);
      }
      if (confChk.length > 0) {
        out(`\n  CONF-CHECK rows under "${c.name}" (predicate fires on currently-confident — won't actually run in production):`);
        for (const r of confChk) out(`    rescuedTc=${r.rescuedTc} within1=${r.within1} ${fmt(r)}`);
      }
    }

    out('\n--- Rescue evaluation: XL device targets (b111 + b112, 10 frames) ---');
    out('  cand                  wins  newWrongs  confChk  noopFires');
    const xlRescueResults = {};
    for (const c of RESCUE_CANDIDATES) {
      const { wins, newWrongs, confChk, noopFires } = bucketRescue(xlRows, c);
      xlRescueResults[c.name] = { wins, newWrongs, confChk, noopFires };
      out(`  ${c.name.padEnd(20)} ${String(wins.length).padStart(5)} ${String(newWrongs.length).padStart(10)} ${String(confChk.length).padStart(8)} ${String(noopFires.length).padStart(10)}`);
    }
    for (const c of RESCUE_CANDIDATES) {
      const { wins, newWrongs, confChk, noopFires } = xlRescueResults[c.name];
      if (wins.length + newWrongs.length + confChk.length + noopFires.length === 0) continue;
      out(`\n  Rescue events under "${c.name}":`);
      for (const r of wins) out(`    [WIN]      rescuedTc=${r.rescuedTc} build=${r.build} ${fmt(r)}`);
      for (const r of newWrongs) out(`    [NEWWRONG] rescuedTc=${r.rescuedTc} build=${r.build} ${fmt(r)}`);
      for (const r of confChk) out(`    [CONFCHK]  rescuedTc=${r.rescuedTc} within1=${r.within1} build=${r.build} ${fmt(r)}`);
      for (const r of noopFires) out(`    [NOOP]     rescuedTc=${r.rescuedTc} within1=${r.within1} build=${r.build} ${fmt(r)}`);
    }

    expect(xlRows.length).toBeGreaterThan(0);
  });
});
