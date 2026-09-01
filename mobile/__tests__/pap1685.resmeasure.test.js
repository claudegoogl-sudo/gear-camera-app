/**
 * PAP-1693 Option 4 measurement — accuracy vs TARGET_MAX_DIM on the large-gear
 * (18-28T) bucket, the bucket PAP-339 previously found regresses hardest when
 * resolution drops (750px caused b75-b79's 80%->14-20% crash, partly
 * attributed to under-resolved contours at 21/24/28T).
 *
 * Throwaway measurement script, not part of the committed test suite.
 */

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

const TRAINING = path.resolve(__dirname, '..', '..', 'training-data');
const RESDIM = Number(process.env.RESDIM || 900);
const SAMPLE_PER_TC = Number(process.env.SAMPLE_PER_TC || 4);

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

describe('PAP-1693 resolution measurement', () => {
  jest.setTimeout(20 * 60 * 1000);

  test(`accuracy at TARGET_MAX_DIM=${RESDIM}`, async () => {
    const { countTeethFromRgba, bilinearDownsampleRgba } = require('../src/algorithm/gearCounter');

    const all = loadAllLabeled().filter(l => l.actual >= 18 && l.actual <= 28);
    const byTc = {};
    for (const l of all) (byTc[l.actual] = byTc[l.actual] || []).push(l);
    const sample = [];
    for (const tc of Object.keys(byTc)) {
      const arr = byTc[tc];
      const step = Math.max(1, Math.floor(arr.length / SAMPLE_PER_TC));
      for (let i = 0; i < arr.length && sample.filter(s => s.actual === Number(tc)).length < SAMPLE_PER_TC; i += step) {
        sample.push(arr[i]);
      }
    }
    process.stdout.write(`\n[resmeasure dim=${RESDIM}] running on ${sample.length} large-gear images\n`);

    let correct = 0;
    const runtimes = [];
    const wrong = [];
    for (const { photo, actual, stamp } of sample) {
      const buf = fs.readFileSync(photo);
      const raw = jpegDecode(buf, { useTArray: true });
      const { rgba, width: w, height: h } = bilinearDownsampleRgba(raw.data, raw.width, raw.height, RESDIM);
      const t0 = Date.now();
      let result;
      try {
        result = countTeethFromRgba(rgba, w, h);
      } catch (e) {
        result = { toothCount: 0, confidence: 0, error: e.message };
      }
      const runtime = Date.now() - t0;
      runtimes.push(runtime);
      const ok = Math.abs(result.toothCount - actual) <= 1;
      if (ok) correct++; else wrong.push({ stamp, actual, detected: result.toothCount, runtime });
      process.stdout.write(`  ${stamp} actual=${actual} detected=${result.toothCount} ${ok ? 'OK' : 'FAIL'} ${runtime}ms\n`);
    }
    runtimes.sort((a, b) => a - b);
    const med = runtimes[Math.floor(runtimes.length / 2)] || 0;
    console.log(`\n=== RESDIM=${RESDIM} summary ===`);
    console.log(`accuracy(±1): ${correct}/${sample.length} = ${(100 * correct / sample.length).toFixed(1)}%`);
    console.log(`median runtime: ${med}ms`);
    console.log('wrong:', JSON.stringify(wrong, null, 2));
    expect(true).toBe(true);
  });
});
