/**
 * PAP-971 cache verification harness.
 *
 * Confirms loadOrDecodeRgba acceptance criteria:
 *   1. Second call hits the cache (warm < cold).
 *   2. Cache files (.bin + .meta.json) materialize under .cache/training-rgba/.
 *   3. Source mtime change invalidates the cache (bin re-written).
 *   4. CACHE=off bypasses the cache entirely (no .cache/ written).
 *
 * Run:
 *   HARNESS=pap971.cache npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out } = runner;

describe('PAP-971 RGBA cache', () => {
  jest.setTimeout(5 * 60 * 1000);

  test('cold/warm/invalidate/bypass', () => {
    const all = runner.discoverLabeled();
    expect(all.length).toBeGreaterThanOrEqual(3);
    const sample = all.slice(0, 3);

    function timeIt() {
      const t0 = performance.now();
      for (const { photo, stamp } of sample) {
        const { rgba, w, h } = runner.loadOrDecodeRgba(photo, stamp);
        expect(rgba).toBeInstanceOf(Uint8Array);
        expect(rgba.length).toBe(w * h * 4);
      }
      return performance.now() - t0;
    }

    const cacheDir = runner.CACHE_DIR;
    fs.rmSync(cacheDir, { recursive: true, force: true });
    delete process.env.CACHE;

    const tCold = timeIt();
    const tWarm = timeIt();
    out(`\n[pap971] cold=${tCold.toFixed(1)}ms  warm=${tWarm.toFixed(1)}ms  speedup=${((tCold - tWarm) / tCold * 100).toFixed(1)}%`);
    expect(tWarm).toBeLessThan(tCold);

    // AC: cache files exist
    for (const { stamp } of sample) {
      expect(fs.existsSync(path.join(cacheDir, `${stamp}_900.bin`))).toBe(true);
      expect(fs.existsSync(path.join(cacheDir, `${stamp}_900.meta.json`))).toBe(true);
    }

    // AC: mtime invalidation
    const target = sample[0];
    const newMtime = new Date(Date.now() + 2000);
    fs.utimesSync(target.photo, newMtime, newMtime);
    const binPath = path.join(cacheDir, `${target.stamp}_900.bin`);
    const beforeBin = fs.statSync(binPath).mtimeMs;
    runner.loadOrDecodeRgba(target.photo, target.stamp);
    const afterBin = fs.statSync(binPath).mtimeMs;
    expect(afterBin).toBeGreaterThan(beforeBin);

    // AC: CACHE=off bypasses
    process.env.CACHE = 'off';
    fs.rmSync(cacheDir, { recursive: true, force: true });
    runner.loadOrDecodeRgba(sample[0].photo, sample[0].stamp);
    expect(fs.existsSync(cacheDir)).toBe(false);
    delete process.env.CACHE;
  });
});
