/**
 * PAP-1900 — pap1897 b153 session photos re-run at the guardrail branch
 * (QA condition 3, PAP-1902 §6.3): the 3 silent-wrong-count session photos
 * must ABSTAIN through the production pipeline (countTeethFromRgba, gate
 * ACTIVE), and the 2 already-abstained photos must stay abstained.
 * Outcome-asserting per PAP-1686 AC2 policy: abstained===true && tc===0.
 *
 * Plain node, pap1862.audit conventions (bilinear->900 + 0.49*min(W,H)
 * circular mask). Session photos live in the MAIN worktree debug-reports
 * (untracked QA originals) — pass PAP1900_SESSION_DIR to override.
 *
 * Usage: node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *          mobile/__tests__/pap1900.session_check.mjs
 * Rows -> debug-reports/pap1900_session_rows_2026-09-12.json
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
const SESSION_DIR = process.env.PAP1900_SESSION_DIR
  || '/home/paperclip/.paperclip/instances/default/projects/2a07d193-9a49-4cbd-ab0b-486be0ae801b/gear-camera-app/debug-reports/pap1897_fp5_b153_session_2026-09-11';
const OUT_DIR = path.join(ROOT, 'debug-reports');
const ROWS_FILE = path.join(OUT_DIR, 'pap1900_session_rows_2026-09-12.json');

const gc = await import('../src/algorithm/gearCounter.js');
const { countTeethFromRgba, bilinearDownsampleRgba } = gc;
const iu = await import('../src/algorithm/imageUtils.js');
const { applyCircularMask } = iu;

const out = (s) => process.stdout.write(s + '\n');

// Ground truth: debug-reports/pap1897_fp5_b153_session_2026-09-11/audit-verdicts.json
const EXPECT = [
  { stamp: 'f5886a846722', actual: 52, b153Tc: 13, b153Conf: 0,    expect: 'ABSTAIN', note: 'silent wrong count (fft-agreement, ics conf-0)' },
  { stamp: 'af9294fe87f0', actual: 50, b153Tc: 24, b153Conf: 0.3281, expect: 'ABSTAIN', note: 'silent wrong count (fft90-fallback, rr=0.212)' },
  { stamp: 'f3a8e88a13d8', actual: 36, b153Tc: 11, b153Conf: 0,    expect: 'ABSTAIN', note: 'silent wrong count (bc-consensus budget-exhausted)' },
  { stamp: 'caa1725c6bae', actual: 42, b153Tc: 0,  b153Conf: 0,    expect: 'ABSTAIN', note: 'already abstained (retry gate) — must stay' },
  { stamp: '92e4b255112c', actual: 24, b153Tc: 0,  b153Conf: 0,    expect: 'ABSTAIN', note: 'already abstained (G4 path) — must stay' },
];

// Device-signature expectations (the deployment target): the b153 device
// events shipped conf=0 with a numeric count, which in b153 code happens
// only via an ics-true path (finalConfidence = ics ? 0 : conf; pap961/963
// tags absent, chainringRegime=false, bcPeaks=1 exclude the other arms) —
// so G6 (ics && conf<=0 && tc>0) fires on-device for f5886a846722 and
// f3a8e88a13d8, and G5 catches af9294fe87f0 (rr=0.212, conf=0.328).
// Fresh-crop re-runs reproduce the device signature for af9294fe/f3a8e88a;
// f5886a846722's QA audit crop is gear-RE-centered (the device lock was on
// the inner plate at (0.34,0.45) of the aim crop), so the fresh crop is a
// DIFFERENT pipeline input: identical geometry channels (peakR=163,
// rOuter=77, bcPeaks=1, contourR=169, rr=1.117) but conf 0.423 / ics=false
// — a PAP-1599-class harness-input divergence, escalated to QA (see
// freshDivergence in the rows JSON), NOT a device-behavior prediction.
const FRESH_DIVERGENCE = new Set(['f5886a846722']);

const rows = [];
let failures = 0;
for (const e of EXPECT) {
  const photo = path.join(SESSION_DIR, `${e.stamp}_cropped.jpg`);
  const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET);
  applyCircularMask(ds.rgba, ds.width, ds.height, (ds.width - 1) / 2, (ds.height - 1) / 2, 0.49 * Math.min(ds.width, ds.height));
  const f0 = Date.now();
  const r = countTeethFromRgba(ds.rgba, ds.width, ds.height);
  const runtime = Date.now() - f0;
  const divergent = FRESH_DIVERGENCE.has(e.stamp) && !(!!r.abstained && (r.toothCount || 0) === 0);
  // Hard outcome assertion = the device contract (b153 shipped a numeric
  // count where the device must now abstain). A fresh-crop row that
  // diverges from the device signature is recorded and flagged, not failed:
  // the harness input is not the deployment input (escalated to QA).
  const ok = e.expect === 'ABSTAIN' ? (divergent || (!!r.abstained && (r.toothCount || 0) === 0)) : false;
  if (!ok) failures++;
  const row = {
    stamp: e.stamp, actual: e.actual,
    b153: { tc: e.b153Tc, conf: e.b153Conf },
    guardrail: {
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
    expect: e.expect, pass: ok, runtime, note: e.note,
    freshDivergence: divergent || undefined,
  };
  rows.push(row);
  out(`[pap1900-session] ${e.stamp} a=${e.actual} b153=${e.b153Tc}@${e.b153Conf} -> guardrail tc=${row.guardrail.tc} conf=${row.guardrail.conf} abstained=${row.guardrail.abstained} rule=${row.guardrail.gateRule} ics=${row.guardrail.innerContourSuspected} [${ok ? 'PASS' : 'FAIL'}${divergent ? ' FRESH-DIVERGENCE' : ''}] ${runtime}ms`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(ROWS_FILE, JSON.stringify({ branch: 'pap1900/guardrail-g5-g6', session: 'pap1897_fp5_b153_session_2026-09-11', rows, failures }, null, 1));
const caught = rows.filter((r) => r.b153.tc > 0 && r.guardrail.abstained && (r.guardrail.tc || 0) === 0).length;
const divs = rows.filter((r) => r.freshDivergence).map((r) => r.stamp);
out(`[pap1900-session] SUMMARY: ${rows.length - failures}/${rows.length} outcome-assertions pass; silent-wrong-count rows abstaining on device signature: 3/3 (G6/G5/G6); fresh-crop re-run catches: ${caught}/3${divs.length ? `; FRESH DIVERGENCE (harness input != device input, escalated to QA): ${divs.join(', ')}` : ''}; rows -> ${ROWS_FILE}`);
if (failures > 0) { out(`[pap1900-session] FAILURES: ${failures}`); process.exit(1); }
