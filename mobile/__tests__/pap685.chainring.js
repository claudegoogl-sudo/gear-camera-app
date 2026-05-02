/**
 * PAP-685 chainring edge case — 52T bicycle chainring (b102).
 *
 * 52T is outside the algorithm's 11-28T design range. These 3 reports are
 * tracked to monitor behaviour at the upper edge: ABSTAIN is acceptable;
 * a confident-but-wrong detection is a regression worth flagging.
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap685.chainring npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
const { DEBUG_DIR } = runner;

const CASES = [
  'report_2026-04-27_13-20-54-484Z',
  'report_2026-04-27_13-24-06-421Z',
  'report_2026-04-27_13-27-37-789Z',
];

describe('PAP-685 52T chainring edge case', () => {
  jest.setTimeout(5 * 60 * 1000);

  test('label sanity + abstain-vs-confident-wrong telemetry', () => {
    let abstains = 0;
    let confidentWrong = 0;
    let correct = 0;
    for (const dir of CASES) {
      const reportPath = path.join(DEBUG_DIR, dir, 'report.json');
      if (!fs.existsSync(reportPath)) { process.stdout.write(`SKIP ${dir} (missing)\n`); continue; }
      const meta = JSON.parse(fs.readFileSync(reportPath, 'utf8').replace(/[^\x00-\x7F]+/g, ''));
      const actual = meta.actualTeethCount;
      // Label sanity — these reports must remain labeled 52T for this test to be meaningful.
      expect(actual).toBe(52);

      const photo = path.join(DEBUG_DIR, dir, 'photo.jpg');
      if (!fs.existsSync(photo)) { process.stdout.write(`SKIP ${dir} (no photo)\n`); continue; }
      const row = runner.evalPhoto({ photo, actual, stamp: dir });
      const r = row.raw;

      const abstained = r.confidence === 0 || r.innerContourSuspected;
      const ok = Math.abs(r.toothCount - actual) <= 1;
      let tag;
      if (ok) { correct++; tag = 'OK'; }
      else if (abstained) { abstains++; tag = 'ABSTAIN'; }
      else { confidentWrong++; tag = 'CONFIDENT-WRONG'; }

      process.stdout.write(`  ${dir} actual=${actual} detected=${r.toothCount} ` +
        `conf=${r.confidence.toFixed(3)} method=${r.methodUsed} ` +
        `innerContourSuspected=${r.innerContourSuspected} ${tag}\n`);
    }
    process.stdout.write(`\nPAP-685 52T: correct=${correct} abstain=${abstains} confidentWrong=${confidentWrong}\n`);
  });
});
