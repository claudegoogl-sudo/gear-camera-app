/**
 * PAP-1694 — dump countTeethFromRgba predictions over the cached corpus in a
 * diffable form, so the preprocess-seam refactor can be proven a no-op by
 * running it either side of the change and diffing the two files.
 *
 * Usage: node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *          mobile/__tests__/pap1694.predict-dump.mjs <outfile> [stride]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'training-rgba');
const TARGET_MAX_DIM = 900;

const { countTeethFromRgba } = await import('../src/algorithm/gearCounter.js');

const outFile = process.argv[2];
const stride = Number(process.argv[3] || 8);

const metas = fs.readdirSync(CACHE_DIR)
  .filter(f => f.endsWith(`_${TARGET_MAX_DIM}.meta.json`))
  .sort()
  .filter((_, i) => i % stride === 0);

const lines = [];
for (const metaFile of metas) {
  const m = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, metaFile), 'utf8'));
  const bin = path.join(CACHE_DIR, metaFile.replace('.meta.json', '.bin'));
  if (!fs.existsSync(bin)) continue;
  const buf = fs.readFileSync(bin);
  const rgba = new Uint8Array(buf.byteLength);
  rgba.set(buf);
  const stamp = metaFile.replace(`_${TARGET_MAX_DIM}.meta.json`, '');
  const r = countTeethFromRgba(rgba, m.width, m.height);
  // Deliberately excludes anything time-derived — only algorithmic outputs.
  lines.push([
    stamp,
    r.toothCount,
    (r.confidence ?? 0).toFixed(6),
    r.abstainReason ?? '-',
    r.gearCenter ? `${r.gearCenter.x.toFixed(6)},${r.gearCenter.y.toFixed(6)}` : '-',
    r.gearRadius != null ? r.gearRadius.toFixed(6) : '-',
  ].join('\t'));
}
fs.writeFileSync(outFile, lines.join('\n') + '\n');
console.log(`${lines.length} predictions -> ${outFile}`);
