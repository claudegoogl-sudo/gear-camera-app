/**
 * PAP-1694 AC2 (option A) — byte-parity of the native C++ preprocess kernels
 * against the JS implementation, over the cached corpus.
 *
 * The whole point of option A is that parity is closed by construction: the
 * C++ in mobile/cpp/gear_kernels.cpp is a line-by-line port of
 * src/algorithm/imageUtils.js, so every stage output must match to the byte.
 * Anything short of zero differing bytes is a bug in the port, not a
 * "documented delta" — a non-identical edge map would force the corpus
 * re-baseline that AC5 exists to prevent (see PAP-1583/PAP-1616).
 *
 * The CLI shares the exact translation unit the Android build compiles, so a
 * pass here is evidence about kernel *semantics*.  It is host g++ / x86-64,
 * not NDK / arm64 — the toolchain-level check is a separate on-device step.
 *
 * Usage: node mobile/__tests__/pap1694.native-parity.mjs [stride] [--bench]
 *
 * PAP1694_STD / PAP1694_OPT override the language standard and optimisation
 * level the CLI is built at (defaults c++17 / -O2).  They exist because the
 * Android target is built at c++20 and, in release, -O3: `-std=c++20 -O3`
 * has to be shown to produce the same bytes as the c++17/-O2 build this
 * harness has always used, or the parity claim only covers a toolchain
 * configuration the app does not ship.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(HERE, '..');
const ROOT = path.resolve(MOBILE, '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'training-rgba');
const TARGET_MAX_DIM = 900;

const stride = Number(process.argv[2] || 1);
const bench = process.argv.includes('--bench');

// ── Build the CLI from the same sources the NDK compiles ────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pap1694-parity-'));
const cli = path.join(tmp, 'parity_cli');
// -ffp-contract=off is load-bearing: FMA contraction would fuse a*b+c in the
// CLAHE bilinear sum and change the rounding, breaking parity for reasons that
// have nothing to do with the port.  android/app/CMakeLists mirrors this flag.
const STD = process.env.PAP1694_STD || 'c++17';
const OPT = process.env.PAP1694_OPT || 'O2';
execFileSync('g++', [
  `-std=${STD}`, `-${OPT}`, '-ffp-contract=off', '-o', cli,
  path.join(MOBILE, 'cpp', 'gear_kernels.cpp'),
  path.join(MOBILE, 'cpp', 'tools', 'parity_cli.cpp'),
], { stdio: 'inherit' });

const { rgbaToGray, clahe, gaussianBlur5x5, cannyEdges } =
  await import('../src/algorithm/imageUtils.js');

const metas = fs.readdirSync(CACHE_DIR)
  .filter(f => f.endsWith(`_${TARGET_MAX_DIM}.meta.json`))
  .sort()
  .filter((_, i) => i % stride === 0);

const STAGES = ['gray', 'clahe', 'blur', 'canny'];
const rows = [];
let firstMismatch = null;

for (const metaFile of metas) {
  const m = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, metaFile), 'utf8'));
  const binPath = path.join(CACHE_DIR, metaFile.replace('.meta.json', '.bin'));
  if (!fs.existsSync(binPath)) continue;
  const buf = fs.readFileSync(binPath);
  const rgba = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const { width: w, height: h } = m;
  const stamp = metaFile.replace(`_${TARGET_MAX_DIM}.meta.json`, '');

  const tJs0 = process.hrtime.bigint();
  const js = {};
  js.gray  = rgbaToGray(rgba, w, h);
  js.clahe = clahe(js.gray, w, h, 3.0, 8, 8);
  js.blur  = gaussianBlur5x5(js.clahe, w, h);
  js.canny = cannyEdges(js.blur, w, h, 50, 150);
  const tJs = Number(process.hrtime.bigint() - tJs0) / 1e6;

  const prefix = path.join(tmp, stamp);
  const args = [binPath, String(w), String(h), prefix];
  if (bench) args.push('--bench', '3');
  const out = execFileSync(cli, args, { encoding: 'utf8' });
  const nativeTimes = bench ? JSON.parse(out) : null;

  const row = { stamp, w, h, tJs, diff: {}, ok: true };
  if (nativeTimes) row.native = nativeTimes;
  for (const stage of STAGES) {
    const got = fs.readFileSync(`${prefix}.${stage}.bin`);
    const want = Buffer.from(js[stage].buffer, js[stage].byteOffset, js[stage].byteLength);
    let differing = 0, maxAbs = 0, firstIdx = -1;
    for (let i = 0; i < want.length; i++) {
      const d = Math.abs(got[i] - want[i]);
      if (d !== 0) {
        differing++;
        if (d > maxAbs) maxAbs = d;
        if (firstIdx < 0) firstIdx = i;
      }
    }
    row.diff[stage] = { differing, maxAbs, pct: (differing / want.length) * 100 };
    if (differing !== 0) {
      row.ok = false;
      if (!firstMismatch) {
        firstMismatch = { stamp, stage, firstIdx, got: got[firstIdx], want: want[firstIdx],
                          x: firstIdx % w, y: Math.floor(firstIdx / w) };
      }
    }
    fs.rmSync(`${prefix}.${stage}.bin`);
  }
  rows.push(row);
  process.stdout.write(row.ok ? '.' : 'X');
}
process.stdout.write('\n');
fs.rmSync(tmp, { recursive: true, force: true });

const failed = rows.filter(r => !r.ok);
const summary = {
  ticket: 'PAP-1694',
  what: 'native C++ preprocess kernels vs JS, byte parity',
  targetMaxDim: TARGET_MAX_DIM,
  stride,
  images: rows.length,
  imagesByteIdentical: rows.length - failed.length,
  allIdentical: failed.length === 0,
  firstMismatch,
  host: {
    node: process.version,
    gpp: execFileSync('g++', ['--version'], { encoding: 'utf8' }).split('\n')[0],
    std: STD,
    opt: OPT,
  },
  rows,
};
if (bench) {
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const jsTotal = sum(rows.map(r => r.tJs));
  const nativeTotal = sum(rows.map(r => r.native.total));
  summary.hostSpeed = {
    jsMeanMs: jsTotal / rows.length,
    nativeMeanMs: nativeTotal / rows.length,
    speedup: jsTotal / nativeTotal,
    perStage: Object.fromEntries(['tGray', 'tClahe', 'tBlur', 'tCanny'].map(k => [
      k, sum(rows.map(r => r.native[k])) / rows.length,
    ])),
  };
}

// Suffixed by toolchain config so a second run at a different std/opt is kept
// beside the first rather than overwriting the evidence for it.
const suffix = (STD === 'c++17' && OPT === 'O2') ? '' : `_${STD.replace('+', 'x').replace('+', 'x')}_${OPT}`;
const outPath = path.join(ROOT, 'debug-reports', `pap1694_native_parity${suffix}.json`);
fs.writeFileSync(outPath, JSON.stringify(summary, null, 1));
console.log(`images=${rows.length} byte-identical=${summary.imagesByteIdentical} ` +
            `allIdentical=${summary.allIdentical}`);
if (firstMismatch) console.log('first mismatch:', JSON.stringify(firstMismatch));
if (summary.hostSpeed) {
  console.log(`host js=${summary.hostSpeed.jsMeanMs.toFixed(1)}ms ` +
              `native=${summary.hostSpeed.nativeMeanMs.toFixed(2)}ms ` +
              `speedup=${summary.hostSpeed.speedup.toFixed(1)}x`);
  console.log('native per stage ms:', JSON.stringify(summary.hostSpeed.perStage));
}
console.log(`wrote ${outPath}`);
process.exit(summary.allIdentical ? 0 : 1);
