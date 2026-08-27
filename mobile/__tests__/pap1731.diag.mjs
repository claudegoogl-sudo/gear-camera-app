/**
 * PAP-1731 — bc-fft 32T cassette undercount (b142 device session), replay.
 *
 * Replays the two Sentry aim-crops from the 2026-08-26T12:28-12:30Z operator
 * FP5 session through the exact device pipeline:
 *   cropped.jpg (1764) -> bilinearDownsampleRgba(900) -> applyCircularMask
 *   -> countTeethFromRgba   [aimR = 0.5*min = 450, mask 0.49*min = 441]
 *
 * Prints every arbitration-relevant internal (peakTc/fft90tc/opTc/bcTc/
 * bcPeaks/bcPurity/fftConf/innerBoreSuspect/centerDisagree-equivalents) so
 * the bc-fft-vs-peak divergence is attributable to a channel, not guessed.
 *
 * Usage:
 *   node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *     mobile/__tests__/pap1731.diag.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decode: jpegDecode } = require('jpeg-js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'pap1731');

const algo = await import('../src/algorithm/gearCounter.js');
const { countTeethFromRgba, bilinearDownsampleRgba } = algo;
const { applyCircularMask } = await import('../src/algorithm/imageUtils.js');

const ROWS = [
  { tag: 'MISS 93a89a7c', file: 'miss_93a89a7c_cropped.jpg', device: { tc: 10, conf: 0.7174, method: 'bc-fft' } },
  { tag: 'HIT  3274b2b2', file: 'hit_3274b2b2_cropped.jpg', device: { tc: 32, conf: 0.7543, method: 'peak' } },
];

function loadDeviceRgba(file) {
  const raw = jpegDecode(fs.readFileSync(path.join(FIX, file)), { useTArray: true });
  const { rgba, width, height } = bilinearDownsampleRgba(raw.data, raw.width, raw.height, 900);
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
  applyCircularMask(rgba, width, height, cx, cy, 0.49 * Math.min(width, height));
  return { rgba, width, height };
}

// Expected replay outcomes.  Before PAP-1731's fix the miss replayed the
// device's wrong answer (10 @ 0.7174 bc-fft); after the bc-fft lobe-harmonic
// rescue it must read 32 via the rescue method, and the hit must stay on the
// unchanged peak path.  Exit non-zero on any mismatch.
const EXPECT = [
  { tc: 32, method: 'bc-fft+peak-lobe-rescue' },
  { tc: 32, method: 'peak' },
];
const replayResults = [];

for (const row of ROWS) {
  const { rgba, width, height } = loadDeviceRgba(row.file);
  const t0 = Date.now();
  const r = countTeethFromRgba(rgba, width, height);
  replayResults.push(r);
  const ms = Date.now() - t0;
  console.log('\n=====', row.tag, `(${row.file}) ${ms}ms`);
  console.log('  device :', JSON.stringify(row.device));
  console.log('  replay : tc=%s conf=%s method=%s innerSus=%s aimR=%s peakR=%s rOuter=%s',
    r.toothCount, r.confidence, r.methodUsed, r.innerContourSuspected, r.aimR, r.peakR, r.rOuter);
  console.log('  stageMs:', JSON.stringify(r.stageMs));
  // full internals are not on the countTeeth result — re-run analyzeImage
  // directly with the same inputs to dump the arbitration inputs.
  const { preprocess } = await import('../src/algorithm/preprocess.js');
  const pre = preprocess(rgba, width, height);
  const a = algo.__test.analyzeImage(pre.gray, pre.enhanced, pre.edges, width, height, 450, Date.now() + 45000, { hit: false });
  console.log('  analyzeImage internals:');
  for (const k of ['peakTc','peakRel','peakR','fft90tc','opTc','opRel','bcTc','bcPurity','bcPeaks','bcCx','bcCy','claheTc','claheConf','rOuter']) {
    console.log('   ', k, '=', a[k]);
  }
  console.log('    cx,cy =', a.cx.toFixed(1), a.cy.toFixed(1), ' contourRadius =', a.contourRadius, ' gearR =', a.gearR);
  const fftConf = Math.min(1, Math.max(0, ((a.peakRel > 0 ? a.peakRel : a.opRel) - 0.05) / 0.15));
  console.log('    fftConf =', fftConf.toFixed(3),
    ' innerBoreSuspect =', a.contourRadius > 40 && a.peakR > 0 && a.peakR < a.contourRadius * 0.55);
  const minDim = Math.min(width, height);
  console.log('    centerDisagree =', a.bcCx > 0 && a.bcCy > 0 &&
    Math.sqrt((a.bcCx - a.cx) ** 2 + (a.bcCy - a.cy) ** 2) > minDim * 0.10,
    `(bcC=(${a.bcCx?.toFixed(0)},${a.bcCy?.toFixed(0)}) vs c=(${a.cx.toFixed(0)},${a.cy.toFixed(0)}), thr=${(minDim*0.10).toFixed(0)})`);
}

// ── assertions ──────────────────────────────────────────────────────────────
let allOk = true;
for (let i = 0; i < ROWS.length; i++) {
  const exp = EXPECT[i];
  const r = replayResults[i];
  const m = r.methodUsed === exp.method || r.methodUsed === 'retry-' + exp.method;
  const ok = (r.toothCount === exp.tc) && m && !r.innerContourSuspected;
  allOk = allOk && ok;
  console.log(`  CHECK ${ok ? 'PASS' : 'FAIL'} ${ROWS[i].tag}: tc=${r.toothCount} (want ${exp.tc}) method=${r.methodUsed} (want ${exp.method}) conf=${r.confidence.toFixed(3)}`);
}
if (!allOk) {
  console.log('\nPAP-1731 REPLAY: FAIL');
  process.exit(1);
}
console.log('\nPAP-1731 REPLAY: ALL CHECKS PASSED');
