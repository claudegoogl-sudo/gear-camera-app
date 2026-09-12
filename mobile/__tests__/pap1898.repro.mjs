/**
 * PAP-1898 repro — run the 5 audited b153 FP5 crops through the production
 * pipeline (PAP-476 aimCrop conventions: bilinear->900 + 0.49*min mask,
 * countTeethFromRgba parity) and dump center/localization diagnostics.
 *
 * Plain node (PAP-1672 precedent).
 * Usage: node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *          mobile/__tests__/pap1898.repro.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decode: jpegDecode } = require('jpeg-js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EV = path.join(ROOT, 'debug-reports', 'pap1897_fp5_b153_session_2026-09-11');
const TARGET = 900;

const gc = await import('../src/algorithm/gearCounter.js');
const { countTeethFromRgba, bilinearDownsampleRgba, __test } = gc;
const iu = await import('../src/algorithm/imageUtils.js');
const { applyCircularMask } = iu;
const pp = await import('../src/algorithm/preprocess.js');

// Audit truth (crop-fraction, from PAP-1897 annotated-PNG audit).
const TRUTH = {
  f5886a846722: { label: 52, cx: 0.50, cy: 0.50, r: 0.450 },
  af9294fe87f0: { label: 50, cx: 0.50, cy: 0.49, r: 0.435 },
  caa1725c6bae: { label: 42, cx: 0.50, cy: 0.49, r: 0.450 },
  f3a8e88a13d8: { label: 36, cx: 0.50, cy: 0.49, r: 0.400 },
  '92e4b255112c': { label: 24, cx: 0.44, cy: 0.47, r: 0.250 },
};

const out = (s) => process.stdout.write(s + '\n');
const rows = [];

for (const [stamp, truth] of Object.entries(TRUTH)) {
  const photo = path.join(EV, `${stamp}_cropped.jpg`);
  if (!fs.existsSync(photo)) { out(`SKIP ${stamp}`); continue; }
  const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET);
  const { rgba, width: w, height: h } = ds;
  // PAP-476 production mask: center of crop, 0.49*min dim
  applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));

  // End-to-end production-parity
  const t0 = Date.now();
  const res = countTeethFromRgba(rgba, w, h);
  const ms = Date.now() - t0;

  // Center-focused diagnostics (same inputs as production analyzeImage)
  const { gray, enhanced, edges } = pp.preprocess(rgba, w, h);
  const center = __test.findGearCenter(gray, enhanced, edges, w, h, Infinity, { hit: false });

  const tcx = truth.cx * w, tcy = truth.cy * h, tr = truth.r * w;
  const dc = Math.hypot(res.cx - tcx, res.cy - tcy);
  rows.push({
    stamp, label: truth.label,
    tc: res.toothCount, conf: +res.confidence.toFixed(3),
    abstained: res.abstained, method: res.methodUsed,
    detCx: +(res.cx / w).toFixed(3), detCy: +(res.cy / h).toFixed(3),
    detR: +(res.gearR / w).toFixed(3),
    contourR: res.contourRadius,
    errCenterPct: +(100 * dc / w).toFixed(1),
    errRadiusPct: +(100 * Math.abs(res.gearR - tr) / tr).toFixed(1),
    centerMethod: center.method, centerR: center.radius,
    ms,
  });
  out(JSON.stringify(rows[rows.length - 1]));
}

fs.mkdirSync(path.join(ROOT, 'debug-reports', 'pap1898_localization_2026-09-12'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'debug-reports', 'pap1898_localization_2026-09-12', 'repro_rows.json'),
  JSON.stringify(rows, null, 2));
out('DONE');
