/**
 * PAP-632 mid-gear regression check — verify Fix C doesn't regress 16-21T detections.
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap632.mid npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out } = runner;

describe('PAP-632 mid regression', () => {
  jest.setTimeout(20 * 60 * 1000);

  test('16-21T accuracy', () => {
    const { rows } = runner.runCorpus({
      targetRange: [16, 21],
      label: 'pap632-mid',
    });

    out(`\n[Mid] Running ${rows.length} mid-gear (16-21T) training photos`);
    let correct = 0, abstain = 0, fail = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const ok = Math.abs(r.tc - r.actual) <= 1;
      const ab = r.conf === 0;
      if (ok) correct++;
      else if (ab) abstain++;
      else fail++;
      const tag = ok ? 'OK' : (ab ? 'ABSTAIN' : 'FAIL');
      if (!ok) {
        out(`  [${i+1}/${rows.length}] ${r.stamp} actual=${r.actual} detected=${r.tc} ` +
          `conf=${r.conf.toFixed(2)} method=${r.method} peak=${r.peakTc} ` +
          `fft90=${r.fft90} op=${r.op} ${tag}`);
      }
    }
    out(`\nMid: ${correct}/${rows.length} correct (±1), ${abstain} abstain, ${fail} fail`);
  });
});
