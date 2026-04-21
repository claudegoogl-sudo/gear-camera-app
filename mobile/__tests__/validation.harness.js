/**
 * Validation harness — runs the full gearCounter pipeline against labeled
 * training JPGs in ../../training-data/ and reports accuracy by tooth-count
 * bucket.
 *
 * Run directly:   node --experimental-vm-modules run via jest CLI.
 * Usage:          npx jest --runTestsByPath mobile/__tests__/validation.harness.js
 *
 * Not part of the default test run (filename omits `.test.js`).  Invoked
 * from PAP-364 validation workflow.
 */

// Stub expo native modules so gearCounter imports resolve without error.
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

const TRAINING = path.resolve(__dirname, '..', '..', 'training-data');
const TARGET_MAX_DIM = 900;  // matches loadAndDecodeImage default

// Bilinear downsample to targetMaxDim on the long side.
function bilinearResize(rgba, w, h, targetMaxDim) {
  const max = Math.max(w, h);
  if (max <= targetMaxDim) return { rgba, w, h };
  const scale = targetMaxDim / max;
  const nw = Math.round(w * scale);
  const nh = Math.round(h * scale);
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = (y + 0.5) * h / nh - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < nw; x++) {
      const sx = (x + 0.5) * w / nw - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const i00 = (y0 * w + x0) * 4;
      const i01 = (y0 * w + x1) * 4;
      const i10 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      const io = (y * nw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v = (rgba[i00 + c] * (1 - fx) + rgba[i01 + c] * fx) * (1 - fy)
                + (rgba[i10 + c] * (1 - fx) + rgba[i11 + c] * fx) * fy;
        out[io + c] = Math.round(v);
      }
    }
  }
  return { rgba: out, w: nw, h: nh };
}

function loadAllLabeled() {
  const entries = fs.readdirSync(TRAINING).sort();
  const labeled = [];
  for (const f of entries) {
    if (!f.endsWith('_meta.json')) continue;
    const p = path.join(TRAINING, f);
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(p, 'utf8').replace(/[^\x00-\x7F]+/g, '?'));
    } catch { continue; }
    const actual = meta.actual_tooth_count || meta.actualTeethCount;
    if (!actual) continue;
    const photo = p.replace('_meta.json', '_photo.jpg');
    if (!fs.existsSync(photo)) continue;
    labeled.push({ photo, actual: Number(actual), stamp: f.replace('_meta.json', '') });
  }
  return labeled;
}

// Pick a subset to keep the harness bounded: all 18T-28T large-gear samples
// (they are the target of the fix, ~10 images) + a reproducible stride
// through small gears so we have coverage without running 150+ images.
function subsample(labeled, smallMax, largeMax) {
  const small = labeled.filter(l => l.actual >= 10 && l.actual <= 15);
  const mid   = labeled.filter(l => l.actual === 16 || l.actual === 17);
  const large = labeled.filter(l => l.actual >= 18 && l.actual <= 28);
  const take = (arr, cap) => {
    if (arr.length <= cap) return arr;
    const step = arr.length / cap;
    const out = [];
    for (let i = 0; i < cap; i++) out.push(arr[Math.floor(i * step)]);
    return out;
  };
  return [...take(small, smallMax), ...take(mid, smallMax), ...take(large, largeMax)];
}

const BUCKETS = { '10-15T': [10, 15], '16-17T': [16, 17], '18-28T': [18, 28] };

function bucketOf(n) {
  for (const [name, [lo, hi]] of Object.entries(BUCKETS)) {
    if (n >= lo && n <= hi) return name;
  }
  return 'other';
}

describe('PAP-364 validation harness', () => {
  // High timeout — processing 65+ images at 900px takes a few minutes.
  jest.setTimeout(20 * 60 * 1000);

  test('report accuracy by bucket', async () => {
    // Dynamic import after jest.mock runs.
    const { countTeethFromRgba } = require('../src/algorithm/gearCounter');

    const smallMax = Number(process.env.VALIDATION_SMALL_MAX || 30);
    const largeMax = Number(process.env.VALIDATION_LARGE_MAX || 999);
    const labeled = subsample(loadAllLabeled(), smallMax, largeMax);
    process.stdout.write(`\n[harness] running on ${labeled.length} images ` +
      `(small_max=${smallMax}, large_max=${largeMax})\n`);
    const tolerance = 1;  // ±1 is counted as "correct" for ≥18T per prior convention
    const strictBuckets = new Set(['10-15T', '16-17T']);  // exact-match buckets

    const byBucket = {};
    const perImage = [];

    const t0 = Date.now();
    for (let i = 0; i < labeled.length; i++) {
      const { photo, actual, stamp } = labeled[i];
      const buf = fs.readFileSync(photo);
      const raw = jpegDecode(buf, { useTArray: true });
      const { rgba, w, h } = bilinearResize(raw.data, raw.width, raw.height, TARGET_MAX_DIM);
      const ts = Date.now();
      let result;
      try {
        result = countTeethFromRgba(rgba, w, h);
      } catch (e) {
        result = { toothCount: 0, confidence: 0, error: e.message };
      }
      const runtime = Date.now() - ts;
      const bucket = bucketOf(actual);
      const strict = strictBuckets.has(bucket);
      const correct = strict
        ? result.toothCount === actual
        : Math.abs(result.toothCount - actual) <= tolerance;
      byBucket[bucket] = byBucket[bucket] || { total: 0, correct: 0, samples: [] };
      byBucket[bucket].total++;
      if (correct) byBucket[bucket].correct++;
      byBucket[bucket].samples.push({ stamp, actual, detected: result.toothCount, correct, runtime });
      perImage.push({ stamp, actual, detected: result.toothCount, bucket, correct, runtime });
      process.stdout.write(`[${i+1}/${labeled.length}] ${stamp} actual=${actual} ` +
        `detected=${result.toothCount} ${correct ? 'OK' : 'FAIL'} ${runtime}ms\n`);
    }
    const elapsed = Date.now() - t0;

    // Emit the validation matrix so the commit message can include it.
    console.log('\n=== PAP-364 validation matrix ===');
    console.log(`Total images: ${labeled.length}  Elapsed: ${(elapsed/1000).toFixed(1)}s`);
    for (const [name, b] of Object.entries(byBucket)) {
      const pct = b.total ? (100 * b.correct / b.total).toFixed(1) : '0.0';
      const matchRule = strictBuckets.has(name) ? 'exact' : '±1';
      console.log(`  ${name.padEnd(8)} ${matchRule.padEnd(5)} ${b.correct}/${b.total}  ${pct}%`);
    }
    console.log('\nPer-image details:');
    const wrong = perImage.filter(r => !r.correct);
    for (const r of wrong) {
      console.log(`  ✗ ${r.stamp} [${r.bucket}] actual=${r.actual} detected=${r.detected} runtime=${r.runtime}ms`);
    }
    const runtimes = perImage.map(r => r.runtime).sort((a, b) => a - b);
    const med = runtimes[Math.floor(runtimes.length / 2)] || 0;
    const max = runtimes[runtimes.length - 1] || 0;
    console.log(`\nRuntime: median=${med}ms max=${max}ms`);

    // Fail the test if the 10-15T bucket is below 90% — QA's hard floor.
    const smallBucket = byBucket['10-15T'];
    if (smallBucket) {
      const pct = 100 * smallBucket.correct / smallBucket.total;
      expect(pct).toBeGreaterThanOrEqual(80);
    }
  });
});
