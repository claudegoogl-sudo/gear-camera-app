/**
 * PAP-632 regression check — run the 4 large-gear training photos that showed
 * detected=0 in validation to verify these are pre-existing abstains, not new regressions.
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap632.regression npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
const { TRAINING_DIR } = runner;

const ABSTAIN_CASES = [
  '2026-04-19_15-36-36-632Z',
  '2026-04-19_18-56-13-322Z',
  '2026-04-20_16-35-00-142Z',
  '2026-04-22_07-01-01-985Z',
];

describe('PAP-632 regression', () => {
  jest.setTimeout(5 * 60 * 1000);

  test('check abstain sources', () => {
    for (const stamp of ABSTAIN_CASES) {
      const photo = path.join(TRAINING_DIR, stamp + '_photo.jpg');
      if (!fs.existsSync(photo)) { process.stdout.write(`SKIP ${stamp}\n`); continue; }
      const metaFile = path.join(TRAINING_DIR, stamp + '_meta.json');
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8').replace(/[^\x00-\x7F]+/g, ''));
      const actual = meta.actual_tooth_count || meta.actualTeethCount;
      const row = runner.evalPhoto({ photo, actual, stamp });
      const r = row.raw;
      process.stdout.write(`${stamp} actual=${actual} detected=${r.toothCount} conf=${r.confidence.toFixed(3)} ` +
        `method=${r.methodUsed} innerContourSuspected=${r.innerContourSuspected} ` +
        `peak=${r.peakTc} fft90=${r.fft90tc} gearR=${r.gearRadius?.toFixed(3)}\n`);
    }
  });
});
