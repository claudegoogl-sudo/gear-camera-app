/**
 * PAP-1696 — dump the JS radial-FFT sweep's actual DFT inputs/outputs on a
 * corpus sample, so the cv::dft parity harness (pap1696_dft_parity.py) can
 * diff cv::dft against fft.js's fftMagnitude() primitive-by-primitive,
 * mirroring the PAP-1694 preprocess parity template.
 *
 * Signal provenance: real `centered` arrays as fftCountAtRadius() builds them
 * — sampleIntensityRing(enhanced, cx, cy, r, w, h, nAngles) -> savgolSmooth
 * (wrap=true) -> mean-subtract — at nAngles=1024 (the production N_ANGLES,
 * used by every fftMagnitude() call site except traceOuterContour's BC path)
 * and nAngles=4096 (BC_ANGLES, the traceOuterContour path). Both are already
 * powers of two, so fftMagnitude's zero-pad branch never fires in production
 * — every real call is an exact N=1024 or N=4096 DFT.
 *
 * cx/cy use the image-center convention (matches countTeethFromRgba's aimR
 * anchor, PAP-1100) rather than findGearCenter's full candidate search —
 * DFT parity is a linear-transform property independent of which candidate
 * center produced the ring, so this is sufficient for primitive-level parity
 * without pulling in findGearCenter's ~40-line candidate/sweep contract.
 *
 * Writes float64 .bin pairs to .cache/pap1696-parity/<stamp>.r<N>_f<frac>.{centered,mag_js}.bin
 *
 * Usage: node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *          mobile/__tests__/pap1696.dump-fft-js.mjs [stride]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'training-rgba');
const OUT_DIR = path.join(ROOT, '.cache', 'pap1696-parity');
const TARGET_MAX_DIM = 900;

const { preprocess } = await import('../src/algorithm/preprocess.js');
const { savgolSmooth } = await import('../src/algorithm/imageUtils.js');
const { fftMagnitude } = await import('../src/algorithm/fft.js');
const { __test } = await import('../src/algorithm/gearCounter.js');
const { sampleIntensityRing } = __test;

fs.mkdirSync(OUT_DIR, { recursive: true });
const stride = Number(process.argv[2] || 10);

const RADIUS_FRACS = [0.15, 0.25, 0.35, 0.45]; // fraction of min(w,h)/2
const N_CASES = [1024, 4096];

function buildCentered(enhanced, cx, cy, r, w, h, nAngles) {
  const ring = sampleIntensityRing(enhanced, cx, cy, r, w, h, nAngles);
  const halfWin = Math.max(2, Math.floor(nAngles / 90));
  const sm = savgolSmooth(ring, halfWin, true);
  let mean = 0;
  for (let i = 0; i < sm.length; i++) mean += sm[i];
  mean /= sm.length;
  const centered = new Float64Array(sm.length);
  for (let i = 0; i < sm.length; i++) centered[i] = sm[i] - mean;
  return centered;
}

const metas = fs.readdirSync(CACHE_DIR)
  .filter(f => f.endsWith(`_${TARGET_MAX_DIM}.meta.json`))
  .sort()
  .filter((_, i) => i % stride === 0);

const index = [];
for (const metaFile of metas) {
  const m = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, metaFile), 'utf8'));
  const bin = path.join(CACHE_DIR, metaFile.replace('.meta.json', '.bin'));
  if (!fs.existsSync(bin)) continue;
  const buf = fs.readFileSync(bin);
  const rgba = new Uint8Array(buf.byteLength);
  rgba.set(buf);
  const { width: w, height: h } = m;
  const stamp = metaFile.replace(`_${TARGET_MAX_DIM}.meta.json`, '');

  const { enhanced } = preprocess(rgba, w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const rMax = 0.5 * Math.min(w, h);

  for (const frac of RADIUS_FRACS) {
    const r = rMax * frac;
    for (const nAngles of N_CASES) {
      const centered = buildCentered(enhanced, cx, cy, r, w, h, nAngles);
      const magJs = fftMagnitude(Array.from(centered));
      const caseId = `${stamp}.r${nAngles}_f${frac}`;
      fs.writeFileSync(path.join(OUT_DIR, `${caseId}.centered.bin`), Buffer.from(centered.buffer, centered.byteOffset, centered.byteLength));
      fs.writeFileSync(path.join(OUT_DIR, `${caseId}.mag_js.bin`), Buffer.from(magJs.buffer, magJs.byteOffset, magJs.byteLength));
      index.push({ stamp, nAngles, frac, n: centered.length, magLen: magJs.length });
    }
  }
}
fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 1));
console.log(`dumped ${index.length} (image, radius, nAngles) DFT cases to ${OUT_DIR}`);
