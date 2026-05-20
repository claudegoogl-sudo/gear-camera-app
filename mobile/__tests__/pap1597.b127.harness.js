/**
 * PAP-1597 — b127 Sentry device-test corpus (9 events from board, 2026-05-19).
 *
 * Source: 9 `kind=debug_report` Sentry events on release v1.0.0 (127),
 * device 21081111RG. Photos + manifest live under
 * mobile/__tests__/fixtures/b127/.
 *
 * Landing accuracy on b127 (from Sentry tags):
 *   5/9 dead-correct, 4/9 missed
 *   — of the 4 misses, 2 are conf=0 algorithmic abstains and 2 are
 *     confidently-wrong. All 4 are 36T or 52T (chainring class).
 *
 * This harness re-runs the gear counter on HEAD against the same photos so
 * the corpus tracks future algorithm drift. Tolerances follow the
 * harness-runner PAP-760 buckets (XL 29-60T → ±1).
 *
 * Migrated onto the shared runner per PAP-970/PAP-1027.
 *
 * Run:
 *   HARNESS=pap1597.b127 npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');

const FIX_DIR = path.resolve(__dirname, 'fixtures', 'b127');
const MANIFEST = path.join(FIX_DIR, 'manifest.json');
const CSV_OUT = path.join(runner.DEBUG_DIR, 'pap1597_b127_crm_2026-05-20.csv');

describe('PAP-1597 b127 Sentry corpus', () => {
  jest.setTimeout(10 * 60 * 1000);

  test('rerun + CSV write', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    expect(manifest.length).toBe(9);

    const csvRows = [
      'event_short,actualTC,b127_predTC,b127_conf,b127_method,head_tc,head_conf,head_method,head_offBy,head_outcome,runtime_ms',
    ];
    let correct = 0, abstain = 0, confWrong = 0;

    for (const m of manifest) {
      const photo = path.join(FIX_DIR, m.cropped);
      expect(fs.existsSync(photo)).toBe(true);

      const row = runner.evalPhoto({
        photo,
        actual: m.actualTC,
        stamp: `b127_crm_${m.event_short}`,
        applyMask: true,
      });

      let outcome;
      if (row.correct) { correct++; outcome = 'CORRECT'; }
      else if (row.abstain) { abstain++; outcome = 'ABSTAIN'; }
      else { confWrong++; outcome = 'CONFIDENT-WRONG'; }

      const cf = (n) => (typeof n === 'number' ? n.toFixed(4) : '');
      csvRows.push([
        m.event_short,
        m.actualTC,
        m.predTC,
        cf(m.confidence),
        m.methodUsed || '',
        row.tc,
        cf(row.conf),
        row.method,
        row.offBy,
        outcome,
        row.runtime,
      ].join(','));

      process.stdout.write(
        `  ${m.actualTC}T ${m.event_short}: b127→${m.predTC} (conf=${cf(m.confidence)}, ${m.methodUsed || '?'})  HEAD→${row.tc} (conf=${cf(row.conf)}, ${row.method}) ${outcome} ${row.runtime}ms\n`,
      );
    }

    fs.mkdirSync(runner.DEBUG_DIR, { recursive: true });
    fs.writeFileSync(CSV_OUT, csvRows.join('\n') + '\n');
    process.stdout.write(
      `\nPAP-1597 HEAD summary: correct=${correct} abstain=${abstain} confidentWrong=${confWrong}\nCSV: ${CSV_OUT}\n`,
    );
  });
});
