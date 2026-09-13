/**
 * PAP-1905 QA confirmation — run the 2 newly-surfaced 09-11 FP5 session
 * captures (17:30:05Z b152 c671d3ed, 17:32:05Z b153 655a2754) through the
 * HEAD (b157-candidate tree) production pipeline. Same conventions as
 * pap1900.session_check.mjs (bilinear->900, 0.49*min circular mask,
 * countTeethFromRgba gate ACTIVE). No thresholds changed; outcome rows only.
 *
 * Usage: node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *          mobile/__tests__/pap1905.session_confirm.mjs
 * Rows -> debug-reports/pap1905_qa_confirmation_rows_2026-09-13.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decode: jpegDecode } = require('jpeg-js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TARGET = 900;
const SRC = path.join(ROOT, 'debug-reports/pap1905_qa_confirmation_2026-09-13');

const gc = await import('../src/algorithm/gearCounter.js');
const { countTeethFromRgba, bilinearDownsampleRgba } = gc;
const iu = await import('../src/algorithm/imageUtils.js');
const { applyCircularMask } = iu;

const EXPECT = [
  { stamp: 'c671d3ed1236', actual: 50, b15x: { tc: 24, conf: 0.5325, method: 'fft-agreement' },
    note: 'CORRECT localization (center ~4px off, radius brackets tips); silent miscount via fft-agreement' },
  { stamp: '655a27541335', actual: 52, b15x: { tc: 20, conf: 0, method: 'fft90-fallback+large-op-override' },
    note: 'latched contour (0.66x radius, ~155px wrong-center); conf-0 silent via large-op-override' },
];

const out = (s) => process.stdout.write(s + '\n');
const rows = [];
for (const e of EXPECT) {
  const photo = path.join(SRC, `${e.stamp}_cropped.jpg`);
  const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET);
  applyCircularMask(ds.rgba, ds.width, ds.height, (ds.width - 1) / 2, (ds.height - 1) / 2, 0.49 * Math.min(ds.width, ds.height));
  const t0 = Date.now();
  const r = countTeethFromRgba(ds.rgba, ds.width, ds.height);
  const runtime = Date.now() - t0;
  const row = {
    stamp: e.stamp, actual: e.actual,
    b152b153: e.b15x,
    head: {
      tc: r.toothCount || 0,
      conf: Number((r.confidence || 0).toFixed(3)),
      abstained: !!r.abstained,
      abstainReason: r.abstainReason ?? null,
      gateRule: r.abstainGateRule ?? null,
      innerContourSuspected: r.innerContourSuspected ?? null,
      preGateTc: r.abstainPreGateTc ?? null,
      preGateConf: r.abstainPreGateConf ?? null,
      method: r.methodUsed || '?',
      peakTc: r.peakTc ?? null, fft90tc: r.fft90tc ?? null, opTc: r.opTc ?? null,
      bcTc: r.bcTc ?? null, bcPeaks: r.bcPeaks ?? null,
      contourRadius: r.contourRadius ?? null,
      peakR: r.peakR ?? null, rOuter: r.rOuter ?? null,
    },
    runtime, note: e.note,
  };
  rows.push(row);
  const h = row.head;
  out(`${e.stamp} actual=${e.actual} b15x(tc=${e.b15x.tc}@${e.b15x.conf} ${e.b15x.method}) -> HEAD tc=${h.tc} conf=${h.conf} abstained=${h.abstained} gate=${h.gateRule} reason=${h.abstainReason} method=${h.method} preGate=${h.preGateTc}@${h.preGateConf} contourR=${h.contourRadius} (${runtime}ms)`);
}
fs.writeFileSync(path.join(ROOT, 'debug-reports', 'pap1905_qa_confirmation_rows_2026-09-13.json'), JSON.stringify(rows, null, 2));
out('rows -> debug-reports/pap1905_qa_confirmation_rows_2026-09-13.json');
