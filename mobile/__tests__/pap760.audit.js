/**
 * PAP-760 baseline accuracy audit.
 *
 * Reports per-class accuracy on the full 9-60T training corpus in the four
 * board-defined buckets:
 *   Small  9-15T  (exact)
 *   Mid    16-20T (exact)
 *   Large  21-28T (±1)
 *   XL     29-60T (±1)
 *
 * Migrated to mobile/__tests__/lib/harness-runner.js (PAP-970). The full
 * audit runs every labeled image, so this harness pins SCOPE=full regardless
 * of the env default.
 *
 * Run:
 *   npx jest --runTestsByPath mobile/__tests__/pap760.audit.js
 *   SCOPE=full HARNESS=pap760.audit npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const runner = require('./lib/harness-runner');
runner.silenceConsole();

describe('PAP-760 baseline accuracy audit', () => {
  jest.setTimeout(30 * 60 * 1000);

  test('per-class accuracy on full training-data corpus', () => {
    const { rows, elapsedMs } = runner.runCorpus({
      // The audit must always cover the full corpus; user-supplied SCOPE is
      // intentionally ignored here.
      scope: 'full',
      label: 'pap760',
    });
    runner.printAuditReport({ rows, elapsedMs, label: 'PAP-760' });
    expect(rows.length).toBeGreaterThan(0);
  });
});
