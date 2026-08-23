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
 *   1b. RETRY DIRECT CHECKPOINT — the AC1 gap flagged in QA's PAP-1659
 *      follow-up review: retryNearCenter() had no internal checkpoint, so an
 *      already-in-flight budget could still be blown by its own ~2000-call
 *      coarse-to-fine fftPurityCheck search once entered. Same technique as
 *      check 1, applied directly to retryNearCenter() with an expired
 *      deadline — it must return almost immediately and set budgetState.hit
 *      instead of running the full coarse+fine sweep.
 *
 *   2. SIMULATED ORDINARY-DEVICE (AC1) — monkey-patch the global Date.now()
 *      clock so it reports elapsed time inflated by a device-realistic
 *      multiplier (~30x: corpus plain-node median 1167ms vs the PAP-1677
 *      device median ~36s ≈ 31x — per the PAP-1689 CEO ruling, §5). Run
 *      countTeethFromRgba() through the *public* entry point on the eight
 *      slowest corpus photos from this session's pap1659_pre snapshot
 *      (including two flagged-method matches: fft-agreement, retry-bc-
 *      consensus+fft-agree). Asserts a non-zero toothCount and that the
 *      base pass was never hard-truncated — PAP-1689 rejected "fix D"
 *      (never abstain on a completed base pass) as a companion change, so
 *      the only thing keeping AC1 honest is the budget value itself
 *      (45000ms) being sized correctly, not a fallback behavior.
 *
 *   3. SIMULATED HIGH-MULTIPLIER (telemetry check, NOT AC3 evidence) — same
 *      technique at ~70x. None of these 8 corpus photos are the actual
 *      PAP-1647 chainring-freeze cases (those are pathologically slow even
 *      on desktop; this list is just the slowest *ordinary* photos), so
 *      even at 70-80x none of them make findGearCenter's own sweep hit its
 *      internal checkpoint — only the optional retry/hi-res-retry gates
 *      fire, correctly preserving a real non-zero count with a telemetry
 *      suffix. This check exists to show that mechanism holds at a higher
 *      multiplier too. It is NOT the evidence for AC3 (the freeze bound):
 *      that's checks 1/1b (the checkpoint fires and returns almost
 *      immediately, deterministically, regardless of multiplier) plus real
 *      device stageMs — per PAP-1689 §5's evidence rule, a desktop corpus
 *      sweep at any multiplier can't price a runtime-triggered gate on its
 *      own.
 *
 * Because the algorithm's internal `deadline` is computed from Date.now()
 * at call time, the checkpoints see the same inflated clock a real slow
 * device would produce — this is the same technique used to test any
 * wall-clock timeout without the real slow hardware in hand.
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
const BUDGET_MS = 45000; // PAP-1686/1688 CEO ruling — must match WALL_CLOCK_BUDGET_MS in gearCounter.js

const gc = await import('../src/algorithm/gearCounter.js');
const { __test, countTeethFromRgba, bilinearDownsampleRgba } = gc;
const { rgbaToGray, clahe, cannyEdges, gaussianBlur5x5, findGearCenter, retryNearCenter } = __test;

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

// ── Check 1b: retryNearCenter direct checkpoint (AC1 follow-up gap) ────────
function checkRetryDirectCheckpoint(stamp) {
  const { rgba, w, h } = loadRgba(stamp);
  const gray = rgbaToGray(rgba, w, h);
  const enhanced = clahe(gray, w, h, 3.0, 8, 8);
  const blurred = gaussianBlur5x5(enhanced, w, h);
  const edges = cannyEdges(blurred, w, h, 50, 150);
  const imgCx = Math.floor(w / 2);
  const imgCy = Math.floor(h / 2);

  const t0 = Date.now();
  retryNearCenter(gray, enhanced, edges, w, h, imgCx, imgCy, 0); // no deadline = Infinity
  const baselineMs = Date.now() - t0;

  const budgetState = { hit: false };
  const t1 = Date.now();
  retryNearCenter(gray, enhanced, edges, w, h, imgCx, imgCy, 0, Date.now() - 1, budgetState);
  const truncatedMs = Date.now() - t1;

  const ok = truncatedMs < baselineMs && budgetState.hit === true;
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

function runSimulated(stamp, factor) {
  const { rgba, w, h } = loadRgba(stamp);
  const realT0 = Date.now();
  let r;
  withInflatedClock(factor, () => {
    r = countTeethFromRgba(rgba, w, h);
  });
  const realElapsed = Date.now() - realT0;
  const simulatedElapsed = realElapsed * factor;
  // exact 'pap1659-budget-exhausted' methodUsed = analyzeImage's early
  // return = findGearCenter itself was truncated = no center to report =
  // the hard-abstain PAP-1683 found firing on 100% of real device photos.
  // A '<method>+pap1659-budget-exhausted' suffix = the base pass DID
  // complete and only later optional work (e.g. a retry gate) was skipped
  // for budget — telemetry only, toothCount is still whatever the base
  // pass found.
  const basePassTruncated = r.methodUsed === 'pap1659-budget-exhausted';
  return { r, realElapsed, simulatedElapsed, basePassTruncated };
}

// PAP-1689 CEO ruling §5, AC1: at a device-realistic multiplier (~30x —
// corpus plain-node median 1167ms vs the PAP-1677 device median ~36s ≈
// 31x), all 8 photos must return toothCount > 0 and must not have hit the
// hard-abstain path. PAP-1689 rejected "fix D" as a companion change, so
// this is pure evidence that 45000ms (fix A) is sized correctly on its
// own — there is no fallback behavior papering over a bad value here.
function checkOrdinaryDevice(stamp, actual, factor) {
  const { r, realElapsed, simulatedElapsed, basePassTruncated } = runSimulated(stamp, factor);
  const ok = !basePassTruncated && r.toothCount > 0;
  out(
    `  ${stamp} (actual=${actual}T, ${factor}x clock, AC1): real=${realElapsed}ms ` +
    `simulated=${Math.round(simulatedElapsed)}ms (${(simulatedElapsed / BUDGET_MS).toFixed(1)}x budget) ` +
    `tc=${r.toothCount} conf=${r.confidence.toFixed(2)} ` +
    `method=${r.methodUsed} budgetExhausted=${r.budgetExhausted} -> ${ok ? 'PASS' : 'FAIL'}`,
  );
  return ok;
}

// Higher-multiplier telemetry check (NOT PAP-1689 §5 AC3 evidence — see
// file header). At 70x, none of these 8 (ordinary, not chainring-freeze)
// photos make findGearCenter's own sweep hit its internal checkpoint; only
// the optional retry/hi-res-retry gates fire. This asserts that mechanism
// still preserves a real, non-zero count under a telemetry suffix rather
// than silently degrading — it does not assert the hard-abstain path
// itself stays bounded, because these photos never reach it. That's what
// checks 1/1b are for.
function checkHighMultiplierTelemetry(stamp, actual, factor) {
  const { r, realElapsed, simulatedElapsed, basePassTruncated } = runSimulated(stamp, factor);
  const ok = !basePassTruncated && (!r.budgetExhausted || r.toothCount > 0);
  out(
    `  ${stamp} (actual=${actual}T, ${factor}x clock, telemetry): real=${realElapsed}ms ` +
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

out('\n=== PAP-1659 AC1: retryNearCenter direct checkpoint (deadline already expired) ===');
for (const [stamp] of SLOWEST) allOk = checkRetryDirectCheckpoint(stamp) && allOk;

out('\n=== PAP-1689 AC1: simulated ordinary device (30x clock, device-realistic) ===');
for (const [stamp, actual] of SLOWEST) allOk = checkOrdinaryDevice(stamp, actual, 30) && allOk;

out('\n=== telemetry check only, NOT AC3 evidence (70x clock — see file header) ===');
for (const [stamp, actual] of SLOWEST) allOk = checkHighMultiplierTelemetry(stamp, actual, 70) && allOk;

out(`\n${allOk ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`);
process.exitCode = allOk ? 0 : 1;
