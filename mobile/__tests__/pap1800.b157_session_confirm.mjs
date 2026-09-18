/**
 * PAP-1800 — b157 first session capture (2026-09-18 09:20-09:22Z, dist 157 =
 * 84a340f): fresh-crop desktop reproduction of the device-committed read
 * (36T @0.7535 via peak). Same conventions as pap1900.session_check /
 * pap1905.session_confirm (bilinear->900, 0.49*min circular mask, gate ACTIVE).
 * The device crop is 1764x1764 (device-computed); fresh harness input is NOT
 * the deployment input (PAP-1599-class caveat) — row is a reproducibility
 * record, not a device-behavior prediction.
 *
 * Rows -> debug-reports/pap1800_b157_session_rows_2026-09-18.json
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
const SRC = path.join(ROOT, 'debug-reports/pap1800_b157_session_2026-09-18');

const gc = await import('../src/algorithm/gearCounter.js');
const { countTeethFromRgba, bilinearDownsampleRgba } = gc;
const iu = await import('../src/algorithm/imageUtils.js');
const { applyCircularMask } = iu;

const out = (s) => process.stdout.write(s + '\n');
const photo = path.join(SRC, 'cropped.jpg');
const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET);
applyCircularMask(ds.rgba, ds.width, ds.height, (ds.width - 1) / 2, (ds.height - 1) / 2, 0.49 * Math.min(ds.width, ds.height));
const t0 = Date.now();
const r = countTeethFromRgba(ds.rgba, ds.width, ds.height);
const runtime = Date.now() - t0;
const row = {
  capture: 'ace8f58c (b157, 2026-09-18T09:21Z, FP5, user b0fd948a)',
  device: { tc: 36, conf: 0.7535, abstained: false, method: 'peak',
            channels: 'fft90=36 multiR=36(rel .163) outer=36(rel .071) bc=36(pur .199,peaks 24) clahe=35',
            stageMs: { load: 3537, preprocess: 283, detect: 25075, methods: 51, total: 28946 },
            budgetExhausted: false, preprocessBackend: 'native-cpp' },
  headFreshCrop: {
    tc: r.toothCount || 0,
    conf: Number((r.confidence || 0).toFixed(3)),
    abstained: !!r.abstained,
    abstainReason: r.abstainReason ?? null,
    gateRule: r.abstainGateRule ?? null,
    method: r.methodUsed || '?',
    peakTc: r.peakTc ?? null, fft90tc: r.fft90tc ?? null, opTc: r.opTc ?? null,
    bcTc: r.bcTc ?? null, bcPeaks: r.bcPeaks ?? null,
    contourRadius: r.contourRadius ?? null,
    peakR: r.peakR ?? null, rOuter: r.rOuter ?? null,
    chainringRegime: r.chainringRegime ?? null,
    preGateTc: r.abstainPreGateTc ?? null, preGateConf: r.abstainPreGateConf ?? null,
  },
  runtime,
  labelConfirmed: false,
  note: 'label 36T unconfirmed (operator/USB or CEO vision audit); b153 same-class event f3a8e88a read 36->11 (bc-consensus budget-exhausted) — same-gear fix data point if label holds',
};
fs.writeFileSync(path.join(ROOT, 'debug-reports', 'pap1800_b157_session_rows_2026-09-18.json'), JSON.stringify(row, null, 2));
const h = row.headFreshCrop;
out(`device: 36T@0.7535 peak | HEAD-fresh-crop: tc=${h.tc} conf=${h.conf} abstained=${h.abstained} method=${h.method} gate=${h.gateRule} bc=${h.bcTc}(peaks=${h.bcPeaks}) fft90=${h.fft90tc} contourR=${h.contourRadius} regime=${h.chainringRegime} (${runtime}ms)`);
out('rows -> debug-reports/pap1800_b157_session_rows_2026-09-18.json');
