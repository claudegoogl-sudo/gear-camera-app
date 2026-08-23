/**
 * PAP-1694 AC2 — dump the JS preprocess stage outputs for a corpus sample so
 * the OpenCV side (pap1694_opencv_parity.py, host cv2) can diff against them
 * primitive-by-primitive.
 *
 * Writes raw Uint8 planes to .cache/pap1694-parity/<stamp>.{gray,clahe,blur,canny}.bin
 *
 * Usage: node mobile/__tests__/pap1694.dump-js-stages.mjs [stride]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'training-rgba');
const OUT_DIR = path.join(ROOT, '.cache', 'pap1694-parity');
const TARGET_MAX_DIM = 900;

const { rgbaToGray, clahe, gaussianBlur5x5, cannyEdges } =
  await import('../src/algorithm/imageUtils.js');

fs.mkdirSync(OUT_DIR, { recursive: true });
const stride = Number(process.argv[2] || 20);

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

  const gray = rgbaToGray(rgba, w, h);
  const enhanced = clahe(gray, w, h, 3.0, 8, 8);
  const blurred = gaussianBlur5x5(enhanced, w, h);
  const edges = cannyEdges(blurred, w, h, 50, 150);

  fs.writeFileSync(path.join(OUT_DIR, `${stamp}.rgba.bin`), Buffer.from(rgba));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}.gray.bin`), Buffer.from(gray));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}.clahe.bin`), Buffer.from(enhanced));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}.blur.bin`), Buffer.from(blurred));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}.canny.bin`), Buffer.from(edges));
  index.push({ stamp, w, h });
}
fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 1));
console.log(`dumped ${index.length} images to ${OUT_DIR}`);
