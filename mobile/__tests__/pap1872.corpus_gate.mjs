/**
 * PAP-1872 — corpus gate proof (AC1/AC2), plain-node, pap1862.audit.mjs
 * conventions (bilinear->900 + 0.49*min(W,H) circular mask).
 *
 * Re-runs the FULL production countTeethFromRgba with the PAP-1872
 * dense-chainring honest-abstain gate ACTIVE over every labeled photo
 * (9-60T) + the two captured 20T anchors, then asserts:
 *
 *   AC1  dense 40-60T abstain rate >= 90%
 *   AC2  ordinary 9-28T newly-abstained < 5% of the class,
 *        0 correctness regressions (no row correct at baseline abstained),
 *        20T-class anchors still return tc=20 (b151 abstain bug stays dead)
 *
 * Baseline = committed pap1862 post-fix audit rows
 * (debug-reports/pap1862_fp5_b151_session_2026-09-10/
 *  post_fix_corpus_audit_rows.json at aabd380, gate off).
 *
 * Rows  -> debug-reports/pap1872_dense_abstain_2026-09-11/gate_corpus_rows.json
 * Sum   -> debug-reports/pap1872_dense_abstain_2026-09-11/gate_summary.json
 *
 * Usage: node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *          mobile/__tests__/pap1872.corpus_gate.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decode: jpegDecode } = require('jpeg-js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TRAINING_DIR = path.join(ROOT, 'training-data');
const OUT_DIR = path.join(ROOT, 'debug-reports', 'pap1872_dense_abstain_2026-09-11');
const BASE_DIR = path.join(ROOT, 'debug-reports', 'pap1862_fp5_b151_session_2026-09-10');
const CACHE_DIR = path.join(ROOT, '.cache', 'training-rgba');
const TARGET = 900;

const gc = await import('../src/algorithm/gearCounter.js');
const { countTeethFromRgba, bilinearDownsampleRgba } = gc;
const iu = await import('../src/algorithm/imageUtils.js');
const { applyCircularMask } = iu;

const out = (s) => process.stdout.write(s + '\n');

function loadRgba(photo, stamp) {
  const bin = path.join(CACHE_DIR, `${stamp}_${TARGET}.bin`);
  const metaP = path.join(CACHE_DIR, `${stamp}_${TARGET}.meta.json`);
  const srcMtimeMs = fs.statSync(photo).mtimeMs;
  if (fs.existsSync(metaP) && fs.existsSync(bin)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaP, 'utf8'));
      if (m.sourceMtimeMs === srcMtimeMs && m.targetMaxDim === TARGET) {
        const buf = fs.readFileSync(bin);
        const rgba = new Uint8Array(buf.byteLength);
        rgba.set(buf);
        return { rgba, w: m.width, h: m.height };
      }
    } catch { /* fall through */ }
  }
  const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET);
  return { rgba: ds.rgba, w: ds.width, h: ds.height };
}

const ANCHORS = [
  { stamp: 'pap1862_captureA_cropped', actual: 20, file: path.join(BASE_DIR, 'attachments', 'captureA_898620612_cropped.jpg') },
  { stamp: 'pap1862_captureB_cropped', actual: 20, file: path.join(BASE_DIR, 'attachments', 'captureB_898623252_cropped.jpg') },
];

const labeled = [];
for (const f of fs.readdirSync(TRAINING_DIR).sort()) {
  if (!f.endsWith('_meta.json')) continue;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(TRAINING_DIR, f), 'utf8').replace(/[^\x00-\x7F]+/g, '?'));
  } catch { continue; }
  const actual = Number(meta.actual_tooth_count || meta.actualTeethCount || 0);
  if (!actual || actual < 9 || actual > 60) continue;
  const stamp = f.replace('_meta.json', '');
  const photo = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
  if (fs.existsSync(photo)) labeled.push({ stamp, actual, photo });
}

const baseline = new Map(
  JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'post_fix_corpus_audit_rows.json'), 'utf8'))
    .map((r) => [r.stamp, r])
);

const cls = (a) => (a <= 14 ? 'S(9-14)' : a <= 19 ? 'M(15-19)' : a <= 28 ? 'L(20-28)' : a <= 39 ? 'C(29-39)' : 'D(40-60)');

out(`[pap1872-gate] corpus=${labeled.length} + anchors=${ANCHORS.length} with gate ACTIVE`);
const rows = [];
const t0 = Date.now();
for (const item of [...ANCHORS, ...labeled]) {
  const { rgba, w, h } = loadRgba(item.photo || item.file, item.stamp);
  applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
  const f0 = Date.now();
  let r;
  try { r = countTeethFromRgba(rgba, w, h); }
  catch (err) { r = { toothCount: 0, confidence: 0, methodUsed: 'ERROR:' + err.message, budgetExhausted: false }; }
  const runtime = Date.now() - f0;
  const base = baseline.get(item.stamp) || {};
  rows.push({
    stamp: item.stamp, actual: item.actual, cls: cls(item.actual),
    tc: r.toothCount || 0,
    conf: Number((r.confidence || 0).toFixed(3)),
    method: r.methodUsed || '?',
    abstained: !!r.abstained,
    abstainReason: r.abstainReason ?? null,
    gateRule: (r.methodUsed || '').includes('pap1872-dense-chainring-abstain')
      ? (r.methodUsed.split('+pap1872-dense-chainring-abstain')[0] || '') && null || 'fired'
      : null,
    baselineTc: base.tc ?? null,
    baselineConf: base.conf ?? null,
    baselineAbstain: base.tc === 0 || base.conf === 0,
    runtime,
  });
  if (rows.length % 50 === 0 || rows.length === labeled.length + ANCHORS.length) {
    out(`[pap1872-gate] ${rows.length}/${labeled.length + ANCHORS.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  if (rows.length % 100 === 0) {
    try { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(path.join(OUT_DIR, 'gate_corpus_rows.json'), JSON.stringify(rows, null, 1)); } catch { }
  }
}

// ── Aggregate + assert ─────────────────────────────────────────────────
const abstainNow = (r) => r.tc === 0 || r.conf === 0;
const dense = rows.filter((r) => r.cls === 'D(40-60)');
const ord = rows.filter((r) => ['S(9-14)', 'M(15-19)', 'L(20-28)'].includes(r.cls));
const camp = rows.filter((r) => r.cls === 'C(29-39)');

const denseAbstain = dense.filter(abstainNow);
const newOrdAbstains = ord.filter((r) => !r.baselineAbstain && abstainNow(r));
const regressions = ord.filter((r) => !r.baselineAbstain && abstainNow(r) && r.baselineTc === r.actual);
const anchorsOk = ANCHORS.every((a) => {
  const r = rows.find((x) => x.stamp === a.stamp);
  return r && r.tc === 20 && !r.abstained;
});
const gateTags = rows.filter((r) => (r.method || '').includes('pap1872-dense-chainring-abstain'));

const summary = {
  at: new Date().toISOString(),
  corpus: rows.length,
  AC1_dense: {
    n: dense.length,
    abstained: denseAbstain.length,
    rate: Number((denseAbstain.length / dense.length).toFixed(4)),
    target: '>=0.90',
    pass: denseAbstain.length / dense.length >= 0.90,
  },
  AC2_ordinary: {
    n: ord.length,
    newlyAbstained: newOrdAbstains.length,
    newlyAbstainedRate: Number((newOrdAbstains.length / ord.length).toFixed(4)),
    target: '<0.05',
    pass: newOrdAbstains.length / ord.length < 0.05,
    correctnessRegressions: regressions.length,
    regressionsPass: regressions.length === 0,
    anchorsReturn20: anchorsOk,
  },
  C_29_39: {
    n: camp.length,
    newlyAbstained: camp.filter((r) => !r.baselineAbstain && abstainNow(r)).length,
  },
  gateFiresTotal: gateTags.length,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'gate_corpus_rows.json'), JSON.stringify(rows, null, 1));
fs.writeFileSync(path.join(OUT_DIR, 'gate_summary.json'), JSON.stringify(summary, null, 1));

out('[pap1872-gate] SUMMARY ' + JSON.stringify(summary, null, 1));
const allPass = summary.AC1_dense.pass && summary.AC2_ordinary.pass
  && summary.AC2_ordinary.regressionsPass && summary.AC2_ordinary.anchorsReturn20;
out(`[pap1872-gate] ${allPass ? 'ALL AC PASS' : 'AC FAILURE'}`);
if (!allPass) process.exit(1);
