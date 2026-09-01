/**
 * PAP-1078 Option 1 — annular dark-fill predicate calibration.
 *
 * QA cross-check: PAP-1079 verdict in PAP-1081.
 *
 * Hypothesis: chainrings carry visible spider arms / dark fill between bolt
 * holes; small/mid/large cogs have higher-contrast tooth band only. So in an
 * annular ROI inside the (possibly aliased) tooth ring and outside the bolt
 * circle, chainrings should show MORE intensity variation (CV / IQR /
 * bimodality) than cogs.
 *
 * Per QA verdict (PAP-1081):
 *   - Compute ALL THREE signals per row:
 *       A = std / max(mean, 1)               (CV)
 *       B = (p75 - p25) / max(p50, 1)        (normalised IQR)
 *       C = (p90 - p10) / max(p50, 1)        (bimodality)
 *   - Sweep BOTH band ranges side-by-side:
 *       narrow:  [0.55, 0.90] · peakR
 *       tight:   [0.60, 0.85] · peakR
 *   - Anchor on (bcCx, bcCy) when set, else image center.
 *   - Measure on RAW RGBA from loadOrDecodeRgba (NEVER post-CLAHE).
 *   - Print PAP-1060 11T-conf=0 cluster trace for every (band, signal, T)
 *     candidate so any cluster row that would fire is visible as structural
 *     AC2 LOSS even when currently abstaining.
 *   - Per-actual-class quantile blocks (Small/Mid/Large/XL × A/B/C × 2 bands).
 *
 * Run:
 *   SAMPLE_PER_ACTUAL=4 HARNESS=pap1078.dark npx jest \
 *     --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, evalPhoto, loadOrDecodeRgba, discoverLabeled } = runner;

const SAMPLE_PER_ACTUAL = Number(process.env.SAMPLE_PER_ACTUAL || 4);

const BANDS = [
  { name: 'narrow', lo: 0.55, hi: 0.90 },
  { name: 'tight', lo: 0.60, hi: 0.85 },
];
const SIGNALS = ['cv', 'iqr', 'bim'];

// Stamps for the PAP-1060 11T-conf=0 cluster (canonical AC2-risk subset).
const PAP1060_STAMPS = new Set([
  '2026-04-05_08-32-48-875Z',
  '2026-04-05_08-33-27-869Z',
  '2026-04-05_08-34-06-051Z',
  '2026-04-05_14-40-38-072Z',
  '2026-04-05_20-05-36-867Z',
  '2026-04-06_10-01-25-781Z',
  '2026-04-19_11-32-11-962Z',
  '2026-04-19_11-33-29-608Z',
  '2026-04-21_19-02-17-555Z',
  '2026-04-22_18-55-06-131Z',
  '2026-04-25_08-03-37-711Z',
]);

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

function fmt(x) {
  if (!Number.isFinite(x)) return '   -  ';
  return x.toFixed(3).padStart(6);
}

function classOfActual(a) {
  if (a <= 13) return 'Small';
  if (a <= 20) return 'Mid';
  if (a <= 28) return 'Large';
  return 'XL';
}

/**
 * Single pass over the bounding square of the OUTER band; bin every pixel into
 * whichever band(s) it falls in. Returns { narrow: [Y...], tight: [Y...] }.
 */
function annularLuminances({ rgba, w, h, cx, cy, peakR }) {
  const result = {};
  const bands = BANDS.map((b) => ({
    name: b.name,
    rLo2: (b.lo * peakR) ** 2,
    rHi2: (b.hi * peakR) ** 2,
    arr: [],
  }));
  const outerR = Math.max(...BANDS.map((b) => b.hi * peakR));
  const x0 = Math.max(0, Math.floor(cx - outerR));
  const x1 = Math.min(w - 1, Math.ceil(cx + outerR));
  const y0 = Math.max(0, Math.floor(cy - outerR));
  const y1 = Math.min(h - 1, Math.ceil(cy + outerR));
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const dy2 = dy * dy;
    const rowOffset = y * w * 4;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const r2 = dx * dx + dy2;
      // Skip pixels outside every band (cheap early exit).
      let touches = false;
      for (const b of bands) {
        if (r2 >= b.rLo2 && r2 <= b.rHi2) { touches = true; break; }
      }
      if (!touches) continue;
      const i = rowOffset + x * 4;
      const Y = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      for (const b of bands) {
        if (r2 >= b.rLo2 && r2 <= b.rHi2) b.arr.push(Y);
      }
    }
  }
  for (const b of bands) result[b.name] = b.arr;
  return result;
}

function statsOf(values) {
  if (!values.length) return { n: 0, mean: NaN, std: NaN, p10: NaN, p25: NaN, p50: NaN, p75: NaN, p90: NaN, cv: NaN, iqr: NaN, bim: NaN };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) * (v - mean);
  const std = Math.sqrt(sq / values.length);
  const sorted = values.slice().sort((a, b) => a - b);
  const p10 = quantile(sorted, 0.10);
  const p25 = quantile(sorted, 0.25);
  const p50 = quantile(sorted, 0.50);
  const p75 = quantile(sorted, 0.75);
  const p90 = quantile(sorted, 0.90);
  const denom = Math.max(p50, 1);
  return {
    n: values.length,
    mean, std, p10, p25, p50, p75, p90,
    cv: std / Math.max(mean, 1),
    iqr: (p75 - p25) / denom,
    bim: (p90 - p10) / denom,
  };
}

describe('PAP-1078 annular dark-fill calibration', () => {
  jest.setTimeout(4 * 60 * 60 * 1000);

  test('measure A/B/C signals × 2 bands on stratified sample', () => {
    const all = discoverLabeled({ minActual: 9, maxActual: 60 });
    const byActual = new Map();
    for (const p of all) {
      const arr = byActual.get(p.actual) || [];
      arr.push(p);
      byActual.set(p.actual, arr);
    }
    const selected = [];
    for (const [, arr] of byActual) {
      const sorted = [...arr].sort((a, b) => (a.stamp < b.stamp ? -1 : 1));
      const n = Math.min(SAMPLE_PER_ACTUAL, sorted.length);
      for (let i = 0; i < n; i++) {
        const idx = Math.floor((i * sorted.length) / n);
        selected.push(sorted[idx]);
      }
    }
    selected.sort((a, b) => (a.stamp < b.stamp ? -1 : 1));
    out(`[pap1078.dark] sample=${selected.length} (target ${SAMPLE_PER_ACTUAL}/actual)`);
    out(`[pap1078.dark] actuals: ${[...byActual.keys()].sort((a, b) => a - b).map((a) => `${a}T(${Math.min(SAMPLE_PER_ACTUAL, byActual.get(a).length)})`).join(' ')}`);

    const t0 = Date.now();
    const rows = [];
    for (let i = 0; i < selected.length; i++) {
      const { photo, actual, stamp } = selected[i];
      const r = evalPhoto({ photo, actual, stamp });
      const { rgba, w, h } = loadOrDecodeRgba(photo, stamp);
      const peakR = r.peakR || 0;
      const bcCx = r.raw.bcCx || 0;
      const bcCy = r.raw.bcCy || 0;
      const cx = (bcCx > 0 || bcCy > 0) ? bcCx : (w - 1) / 2;
      const cy = (bcCx > 0 || bcCy > 0) ? bcCy : (h - 1) / 2;

      let band = { narrow: [], tight: [] };
      if (peakR > 4) {
        band = annularLuminances({ rgba, w, h, cx, cy, peakR });
      }
      const sNarrow = statsOf(band.narrow);
      const sTight = statsOf(band.tight);

      rows.push({
        actual,
        stamp,
        klass: classOfActual(actual),
        w, h,
        peakR,
        bcCx, bcCy,
        anchorCx: cx,
        anchorCy: cy,
        narrow: sNarrow,
        tight: sTight,
        peakTc: r.peakTc,
        bcTc: r.bcTc,
        fft90: r.fft90,
        opTc: r.op,
        bcPeaks: r.bcPeaks,
        tc: r.tc,
        conf: r.conf,
        innerSus: r.innerSus,
        gearR: r.gearR,
      });

      if ((i + 1) % 10 === 0) {
        out(`  [${i + 1}/${selected.length}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    }

    const byClass = { Small: [], Mid: [], Large: [], XL: [] };
    for (const r of rows) byClass[r.klass].push(r);

    out('\n=== PAP-1078 annular signals — quantiles per class ===');
    for (const band of BANDS) {
      out(`\n-- band=${band.name} [${band.lo}, ${band.hi}]·peakR --`);
      out('class    N    signal     p05    p10    p25    p50    p75    p90    p95');
      for (const cls of ['Small', 'Mid', 'Large', 'XL']) {
        const arr = byClass[cls];
        for (const sig of SIGNALS) {
          const vs = arr.map((r) => r[band.name][sig]).filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
          out(`${cls.padEnd(6)} ${String(arr.length).padStart(3)}  ${sig.padEnd(8)}  ${fmt(quantile(vs, 0.05))} ${fmt(quantile(vs, 0.10))} ${fmt(quantile(vs, 0.25))} ${fmt(quantile(vs, 0.50))} ${fmt(quantile(vs, 0.75))} ${fmt(quantile(vs, 0.90))} ${fmt(quantile(vs, 0.95))}`);
        }
      }
    }

    const cogs = [...byClass.Small, ...byClass.Mid, ...byClass.Large];
    const rings = byClass.XL;
    out(`\n=== Cog (n=${cogs.length}) vs Chainring (n=${rings.length}) ===`);
    for (const band of BANDS) {
      out(`-- band=${band.name} --`);
      out('signal   COG p10  p25  p50  p75  p90 | RING p10  p25  p50  p75  p90');
      for (const sig of SIGNALS) {
        const cV = cogs.map((r) => r[band.name][sig]).filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
        const rV = rings.map((r) => r[band.name][sig]).filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
        out(`${sig.padEnd(8)} ${fmt(quantile(cV, 0.10))} ${fmt(quantile(cV, 0.25))} ${fmt(quantile(cV, 0.50))} ${fmt(quantile(cV, 0.75))} ${fmt(quantile(cV, 0.90))} | ${fmt(quantile(rV, 0.10))} ${fmt(quantile(rV, 0.25))} ${fmt(quantile(rV, 0.50))} ${fmt(quantile(rV, 0.75))} ${fmt(quantile(rV, 0.90))}`);
      }
    }

    out('\n=== Threshold sweep: signal >= T fires "chainring" (high direction only) ===');
    out('band     signal   T       cogCap  ring%   cog%   S%   M%   L%   XL%');
    const candidates = [];
    function sweep(band, sig, maxCogRate) {
      const ring = rings.map((r) => r[band.name][sig]).filter(Number.isFinite).sort((a, b) => a - b);
      if (!ring.length) return null;
      let best = null;
      for (let q = 0; q <= 99; q++) {
        const T = ring[Math.floor((q / 100) * (ring.length - 1))];
        const cogFire = cogs.filter((r) => r[band.name][sig] >= T).length / Math.max(1, cogs.length);
        if (cogFire > maxCogRate) continue;
        const ringFire = rings.filter((r) => r[band.name][sig] >= T).length / Math.max(1, rings.length);
        if (!best || ringFire > best.ringFire) best = { T, ringFire, cogFire };
      }
      return best;
    }
    for (const band of BANDS) {
      for (const sig of SIGNALS) {
        for (const cogCap of [0.00, 0.02, 0.05]) {
          const f = sweep(band, sig, cogCap);
          if (!f) continue;
          const test = (r) => r[band.name][sig] >= f.T;
          const rate = (arr) => (arr.length ? arr.filter(test).length / arr.length : 0);
          out(`${band.name.padEnd(7)} ${sig.padEnd(8)} T=${f.T.toFixed(3).padStart(6)} cog<=${cogCap.toFixed(2)}  ring%=${(f.ringFire * 100).toFixed(1).padStart(5)}  cog%=${(f.cogFire * 100).toFixed(1).padStart(4)}  S%=${(rate(byClass.Small) * 100).toFixed(0).padStart(3)} M%=${(rate(byClass.Mid) * 100).toFixed(0).padStart(3)} L%=${(rate(byClass.Large) * 100).toFixed(0).padStart(3)} XL%=${(rate(byClass.XL) * 100).toFixed(0).padStart(3)}`);
          if (cogCap === 0.00) candidates.push({ band: band.name, sig, T: f.T, ringFire: f.ringFire });
        }
      }
    }

    // PAP-1060 11T-conf=0 cluster trace per QA AC2 gate
    const cluster = rows.filter((r) => PAP1060_STAMPS.has(r.stamp));
    out(`\n=== PAP-1060 11T-conf=0 cluster trace (n=${cluster.length}/${PAP1060_STAMPS.size} present in stratified sample) ===`);
    if (cluster.length) {
      out('stamp                            actual  detected  conf   peakR  ' + BANDS.map((b) => SIGNALS.map((s) => `${b.name[0]}${s}`).join(' ')).join('  '));
      for (const r of cluster) {
        const sigStr = BANDS.map((b) => SIGNALS.map((s) => fmt(r[b.name][s])).join(' ')).join('  ');
        out(`${r.stamp}  ${String(r.actual).padStart(2)}T    ${String(r.tc).padStart(2)}T      ${r.conf.toFixed(3)}  ${String(r.peakR).padStart(5)}  ${sigStr}`);
      }
      // Per-candidate trace: which cluster rows would fire each candidate predicate
      out('\n--- per-candidate cluster fire trace (any FIRE on a cluster row = structural AC2 LOSS) ---');
      for (const c of candidates) {
        const fired = cluster.filter((r) => r[c.band][c.sig] >= c.T);
        out(`  cand band=${c.band} sig=${c.sig} T=${c.T.toFixed(3)} ring%=${(c.ringFire * 100).toFixed(1)}  cluster_fire=${fired.length}/${cluster.length}` + (fired.length ? `  STAMPS=[${fired.map((r) => r.stamp).join(',')}]` : ''));
      }
    } else {
      out('  (no cluster stamps present in stratified sample at SAMPLE_PER_ACTUAL=' + SAMPLE_PER_ACTUAL + '; predicate fire on these rows still requires full pap760 sweep before merge)');
    }

    // CSV
    const csvHeader = ['class', 'actual', 'stamp', 'peakR', 'bcCx', 'bcCy', 'anchorCx', 'anchorCy', 'tc', 'conf', 'innerSus'];
    for (const b of BANDS) for (const s of SIGNALS) csvHeader.push(`${b.name}_${s}`);
    for (const b of BANDS) csvHeader.push(`${b.name}_n`);
    const csvLines = [csvHeader.join(',')];
    for (const cls of ['Small', 'Mid', 'Large', 'XL']) {
      for (const r of byClass[cls]) {
        const cells = [cls, r.actual, r.stamp, r.peakR, r.bcCx, r.bcCy, r.anchorCx.toFixed(1), r.anchorCy.toFixed(1), r.tc, r.conf.toFixed(3), r.innerSus];
        for (const b of BANDS) for (const s of SIGNALS) cells.push(Number.isFinite(r[b.name][s]) ? r[b.name][s].toFixed(4) : '');
        for (const b of BANDS) cells.push(r[b.name].n);
        csvLines.push(cells.join(','));
      }
    }
    const outFile = path.resolve(__dirname, '..', '..', 'debug-reports', 'pap1078_dark_rows_2026-05-03.csv');
    fs.writeFileSync(outFile, csvLines.join('\n'));
    out(`\nrow-level csv: ${outFile}  (${csvLines.length - 1} rows)`);

    expect(rows.length).toBeGreaterThan(0);
  });
});
