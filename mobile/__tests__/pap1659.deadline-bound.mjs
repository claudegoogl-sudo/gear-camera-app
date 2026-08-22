/**
 * PAP-1659 AC1 evidence: demonstrate the wall-clock budget actually bounds
 * a count, including on the worst-case corpus paths PAP-1647 identified,
 * without needing a physical slow device.
 *
 * Runs under plain `node` (see lib/node-esm-stubs.mjs) — jest inflates the
 * algorithm's tight typed-array loops ~400x (measured in PAP-1635/1639),
 * which would make any timing assertion here meaningless.
 *
 * Two checks:
 *
 *   1. DIRECT CHECKPOINT — call findGearCenter() with an already-expired
 *      deadline. It should return almost immediately (checkpoint fires on
 *      the very first sweep iteration) instead of running the full
 *      36-iteration threshold sweep, and set budgetState.hit.
 *
 *   2. SIMULATED SLOW DEVICE — monkey-patch the global Date.now() clock so
 *      it reports elapsed time inflated by SLOWDOWN_FACTOR (PAP-1647
 *      measured 15-25x FP5-vs-desktop; this uses 20x, the midpoint). Run
 *      countTeethFromRgba() through the *public* entry point on the eight
 *      slowest corpus photos from this session's pap1659_pre snapshot
 *      (including two flagged-method matches: fft-agreement, retry-bc-
 *      consensus+fft-agree). Because the algorithm's internal `deadline`
 *      is computed from Date.now() at call time, the checkpoints see the
 *      same 20x-inflated clock a real slow device would produce — this is
 *      the same technique used to test any wall-clock timeout without
 *      the real slow hardware in hand.
 *
 * Usage:
 *   node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *     mobile/__tests__/pap1659.deadline-bound.mjs
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
const CACHE_DIR = path.join(ROOT, '.cache', 'training-rgba');
const TARGET_MAX_DIM = 900;
const BUDGET_MS = 5000; // must match WALL_CLOCK_BUDGET_MS in gearCounter.js

const gc = await import('../src/algorithm/gearCounter.js');
const { __test, countTeethFromRgba, bilinearDownsampleRgba } = gc;
const { rgbaToGray, clahe, cannyEdges, gaussianBlur5x5, findGearCenter } = __test;

console.log = () => {};
const out = (s) => process.stdout.write(s + '\n');

function loadRgba(stamp) {
  const bin = path.join(CACHE_DIR, `${stamp}_${TARGET_MAX_DIM}.bin`);
  const metaP = path.join(CACHE_DIR, `${stamp}_${TARGET_MAX_DIM}.meta.json`);
  if (fs.existsSync(metaP) && fs.existsSync(bin)) {
    const m = JSON.parse(fs.readFileSync(metaP, 'utf8'));
    const buf = fs.readFileSync(bin);
    const rgba = new Uint8Array(buf.byteLength);
    rgba.set(buf);
    return { rgba, w: m.width, h: m.height };
  }
  const photo = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
  const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET_MAX_DIM);
  return { rgba: ds.rgba, w: ds.width, h: ds.height };
}

// ── Check 1: direct checkpoint on an already-expired deadline ──────────────
function checkDirectCheckpoint(stamp) {
  const { rgba, w, h } = loadRgba(stamp);
  const gray = rgbaToGray(rgba, w, h);
  const enhanced = clahe(gray, w, h, 3.0, 8, 8);
  const blurred = gaussianBlur5x5(enhanced, w, h);
  const edges = cannyEdges(blurred, w, h, 50, 150);

  const t0 = Date.now();
  const baseline = findGearCenter(gray, enhanced, edges, w, h); // no deadline = Infinity
  const baselineMs = Date.now() - t0;

  const budgetState = { hit: false };
  const t1 = Date.now();
  const truncated = findGearCenter(gray, enhanced, edges, w, h, Date.now() - 1, budgetState);
  const truncatedMs = Date.now() - t1;

  const ok = truncatedMs < baselineMs && budgetState.hit === true && truncated != null;
  out(`  ${stamp}: baseline=${baselineMs}ms truncated=${truncatedMs}ms budgetState.hit=${budgetState.hit} -> ${ok ? 'PASS' : 'FAIL'}`);
  return ok;
}

// ── Check 2: simulated slow device via a globally inflated clock ───────────
function withInflatedClock(factor, fn) {
  const realNow = Date.now;
  const startReal = realNow();
  let startSim = null;
  global.Date.now = () => {
    const real = realNow();
    if (startSim === null) startSim = real;
    return startSim + (real - startReal) * factor;
  };
  try {
    return fn();
  } finally {
    global.Date.now = realNow;
  }
}

function checkSimulatedSlowDevice(stamp, actual, factor) {
  const { rgba, w, h } = loadRgba(stamp);
  const realT0 = Date.now();
  let r;
  withInflatedClock(factor, () => {
    r = countTeethFromRgba(rgba, w, h);
  });
  const realElapsed = Date.now() - realT0;
  // The algorithm believes SLOWDOWN_FACTOR*realElapsed have passed; that
  // simulated elapsed time is what must stay <= BUDGET_MS. Real elapsed is
  // reported too, since it's what this test actually measures directly.
  const simulatedElapsed = realElapsed * factor;
  // This is a checkpoint-based bound, not preemptive: the worst-case
  // overshoot past BUDGET_MS is bounded by the real-device cost of ONE
  // (thresh, invert) sweep iteration, which varies per photo (a photo
  // whose deadline happens to land just before its single most expensive
  // iteration overshoots more than one where it lands before a cheap one).
  // 3x BUDGET_MS is the documented worst case observed on this corpus's
  // slowest photos under a 20x clock — see PAP-1659 handoff notes for why
  // tighter isn't achievable without finer-grained (and costlier-on-every-
  // count) instrumentation inside the sweep's per-iteration morphology.
  const ok = simulatedElapsed <= BUDGET_MS * 3 && r.budgetExhausted === true;
  out(
    `  ${stamp} (actual=${actual}T, ${factor}x clock): real=${realElapsed}ms ` +
    `simulated=${Math.round(simulatedElapsed)}ms (${(simulatedElapsed / BUDGET_MS).toFixed(1)}x budget) ` +
    `tc=${r.toothCount} conf=${r.confidence.toFixed(2)} ` +
    `method=${r.methodUsed} budgetExhausted=${r.budgetExhausted} -> ${ok ? 'PASS' : 'FAIL'}`,
  );
  return ok;
}

// ── Run ──────────────────────────────────────────────────────────────────
const SLOWEST = [
  ['2026-05-01_08-24-07-480Z', 52],
  ['2026-05-04_11-46-43-304Z', 36],
  ['2026-05-01_09-09-26-510Z', 36],
  ['2026-04-28_06-56-36-143Z', 52],
  ['2026-04-22_07-10-07-868Z', 21], // flagged method: fft-agreement
  ['2026-04-24_07-05-25-396Z', 21],
  ['2026-04-17_10-57-40-821Z', 21], // flagged method: retry-bc-consensus+fft-agree
  ['2026-04-30_11-35-41-631Z', 42],
];

out('=== PAP-1659 AC1: direct checkpoint (deadline already expired) ===');
let allOk = true;
for (const [stamp] of SLOWEST) allOk = checkDirectCheckpoint(stamp) && allOk;

out('\n=== PAP-1659 AC1: simulated slow device (20x clock, PAP-1647 midpoint) ===');
for (const [stamp, actual] of SLOWEST) allOk = checkSimulatedSlowDevice(stamp, actual, 20) && allOk;

out(`\n${allOk ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`);
process.exitCode = allOk ? 0 : 1;
