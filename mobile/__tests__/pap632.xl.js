/**
 * PAP-632 XL training validation — runs gearCounter on all XL (29T+) training photos.
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970/PAP-1027).
 *
 * Run: HARNESS=pap632.xl npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out } = runner;

describe('PAP-632 XL training', () => {
  jest.setTimeout(10 * 60 * 1000);

  test('XL (29T+) accuracy', () => {
    const { rows } = runner.runCorpus({
      targetRange: [29, 60],
      label: 'pap632-xl',
    });

    out(`\n[XL] Running ${rows.length} XL training photos`);
    let correct = 0, abstain = 0, fail = 0;
    for (const r of rows) {
      const ok = Math.abs(r.tc - r.actual) <= 1;
      const ab = r.conf === 0 || r.innerSus;
      if (ok) correct++;
      else if (ab) abstain++;
      else fail++;
      out(`  ${r.stamp} actual=${r.actual} detected=${r.tc} conf=${r.conf.toFixed(2)} ` +
        `method=${r.method} ${ok ? 'OK' : (ab ? 'ABSTAIN' : 'FAIL')}`);
    }
    out(`\nXL: ${correct}/${rows.length} correct, ${abstain} abstain, ${fail} fail`);
    out(`XL (incl abstain): ${correct + abstain}/${rows.length} = ${(100*(correct+abstain)/Math.max(1,rows.length)).toFixed(0)}%`);
  });
});
