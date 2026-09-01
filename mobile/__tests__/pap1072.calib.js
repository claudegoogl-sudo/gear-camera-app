/**
 * PAP-1072 calibration diagnostic.
 *
 * Goal: determine whether any FFT-channel-independent signal (peakR/aimR,
 * gR-absolute, contourR/aimR, rOuter/aimR, |bc-center − img-center|/aimR)
 * has enough separation between true cog (≤28T) and true chainring (≥30T)
 * to satisfy AC1 (≥80% chainring fire rate at 0 Small/Mid/Large losses).
 *
 * Stratified sample: SAMPLE_PER_ACTUAL photos per actual tooth-count value,
 * deterministically by stamp-sort. Default 5; override via env.
 *
 * Run: SAMPLE_PER_ACTUAL=5 HARNESS=pap1072.calib npx jest \
 *   --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, evalPhoto, discoverLabeled } = runner;

const SAMPLE_PER_ACTUAL = Number(process.env.SAMPLE_PER_ACTUAL || 5);

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

describe('PAP-1072 chainring-prior calibration', () => {
  jest.setTimeout(4 * 60 * 60 * 1000);

  test('measure candidate signals on stratified sample', () => {
    const all = discoverLabeled({ minActual: 9, maxActual: 60 });
    // Group by actual tooth count
    const byActual = new Map();
    for (const p of all) {
      const arr = byActual.get(p.actual) || [];
      arr.push(p);
      byActual.set(p.actual, arr);
    }
    // Stratified sample
    const selected = [];
    for (const [actual, arr] of byActual) {
      const sorted = [...arr].sort((a,b) => a.stamp < b.stamp ? -1 : 1);
      // Take evenly spaced indices to get diversity, capped at SAMPLE_PER_ACTUAL
      const n = Math.min(SAMPLE_PER_ACTUAL, sorted.length);
      for (let i = 0; i < n; i++) {
        const idx = Math.floor(i * sorted.length / n);
        selected.push(sorted[idx]);
      }
    }
    selected.sort((a,b) => a.stamp < b.stamp ? -1 : 1);
    out(`[pap1072.calib] sample=${selected.length} (target ${SAMPLE_PER_ACTUAL}/actual)`);
    out(`[pap1072.calib] actuals: ${[...byActual.keys()].sort((a,b)=>a-b).map(a=>`${a}T(${Math.min(SAMPLE_PER_ACTUAL,byActual.get(a).length)})`).join(' ')}`);

    const t0 = Date.now();
    const rows = [];
    for (let i = 0; i < selected.length; i++) {
      const { photo, actual, stamp } = selected[i];
      const r = evalPhoto({ photo, actual, stamp });
      rows.push(r);
      if ((i+1) % 10 === 0) out(`  [${i+1}/${selected.length}] ${((Date.now()-t0)/1000).toFixed(0)}s`);
    }

    // Bucket by class
    const byClass = { Small: [], Mid: [], Large: [], XL: [] };
    for (const r of rows) {
      const cls = classOfActual(r.actual);
      const w = r.w, h = r.h;
      const minDim = Math.min(w, h);
      const aimR = 0.5 * minDim;
      const peakR = r.peakR || 0;
      const rOuter = r.rOuter || 0;
      const contourR = r.raw.contourRadius || 0;
      const bcCx = r.raw.bcCx || 0;
      const bcCy = r.raw.bcCy || 0;
      const cx = (w - 1) / 2;
      const cy = (h - 1) / 2;
      const bcDist = (bcCx > 0 || bcCy > 0)
        ? Math.sqrt((bcCx - cx) ** 2 + (bcCy - cy) ** 2)
        : 0;

      byClass[cls].push({
        actual: r.actual,
        stamp: r.stamp,
        peakR_aim: aimR > 0 ? peakR / aimR : 0,
        peakR_px: peakR,
        gearR: r.gearR,
        contourR_aim: aimR > 0 ? contourR / aimR : 0,
        rOuter_aim: aimR > 0 ? rOuter / aimR : 0,
        bcDist_aim: aimR > 0 ? bcDist / aimR : 0,
        peakR_rOuter: rOuter > 0 ? peakR / rOuter : 0,
        aimR,
        minDim,
        peakTc: r.peakTc,
        bcTc: r.bcTc,
        fft90: r.fft90,
        opTc: r.op,
        bcPeaks: r.bcPeaks,
        tc: r.tc,
        conf: r.conf,
        innerSus: r.innerSus,
      });
    }

    out('\n=== PAP-1072 candidate-signal quantiles (stratified sample) ===');
    out('class    N    signal             p05    p10    p25    p50    p75    p90    p95');
    const sigs = ['peakR_aim','gearR','contourR_aim','rOuter_aim','bcDist_aim','peakR_rOuter','peakR_px','minDim','aimR'];
    for (const cls of ['Small','Mid','Large','XL']) {
      const arr = byClass[cls];
      out(`-- ${cls} (n=${arr.length}) --`);
      for (const sig of sigs) {
        const vs = arr.map((r) => r[sig]).filter((v) => Number.isFinite(v) && v >= 0).sort((a,b)=>a-b);
        out(`${cls.padEnd(6)} ${String(arr.length).padStart(3)}  ${sig.padEnd(16)}  ${fmt(quantile(vs,0.05))} ${fmt(quantile(vs,0.10))} ${fmt(quantile(vs,0.25))} ${fmt(quantile(vs,0.50))} ${fmt(quantile(vs,0.75))} ${fmt(quantile(vs,0.90))} ${fmt(quantile(vs,0.95))}`);
      }
    }

    const cogs = [...byClass.Small, ...byClass.Mid, ...byClass.Large];
    const rings = byClass.XL;
    out(`\n=== Cog (n=${cogs.length}) vs Chainring (n=${rings.length}) ===`);
    out('signal             COG p10  p25  p50  p75  p90 | RING p10  p25  p50  p75  p90');
    for (const sig of sigs) {
      const cV = cogs.map(r=>r[sig]).filter(v=>Number.isFinite(v)&&v>=0).sort((a,b)=>a-b);
      const rV = rings.map(r=>r[sig]).filter(v=>Number.isFinite(v)&&v>=0).sort((a,b)=>a-b);
      out(`${sig.padEnd(16)}  ${fmt(quantile(cV,0.10))} ${fmt(quantile(cV,0.25))} ${fmt(quantile(cV,0.50))} ${fmt(quantile(cV,0.75))} ${fmt(quantile(cV,0.90))} | ${fmt(quantile(rV,0.10))} ${fmt(quantile(rV,0.25))} ${fmt(quantile(rV,0.50))} ${fmt(quantile(rV,0.75))} ${fmt(quantile(rV,0.90))}`);
    }

    out('\n=== Threshold-sweep: signal >= T fires "chainring" ===');
    out('direction  signal             T       cogCap  ring%   cog%   S%   M%   L%   XL%');
    function sweep(sig, dir, maxCogRate) {
      const ring = rings.map(r=>r[sig]).filter(Number.isFinite).sort((a,b)=>a-b);
      if (!ring.length) return null;
      let best = null;
      for (let q=0; q<=99; q++) {
        const T = ring[Math.floor(q/100*(ring.length-1))];
        const cogFire = cogs.filter(r=>dir==='high'?r[sig]>=T:r[sig]<=T).length / Math.max(1, cogs.length);
        if (cogFire > maxCogRate) continue;
        const ringFire = rings.filter(r=>dir==='high'?r[sig]>=T:r[sig]<=T).length / Math.max(1, rings.length);
        if (!best || ringFire > best.ringFire) best = { T, ringFire, cogFire };
      }
      return best;
    }
    for (const dir of ['high','low']) {
      for (const sig of sigs) {
        for (const cogCap of [0.00, 0.02, 0.05]) {
          const f = sweep(sig, dir, cogCap);
          if (!f) continue;
          const test = (r) => dir==='high' ? r[sig]>=f.T : r[sig]<=f.T;
          const rate = (arr) => arr.length ? arr.filter(test).length/arr.length : 0;
          out(`${dir.padEnd(8)} ${sig.padEnd(16)}  T=${f.T.toFixed(3).padStart(6)} cog<=${cogCap.toFixed(2)}  ring%=${(f.ringFire*100).toFixed(1).padStart(5)}  cog%=${(f.cogFire*100).toFixed(1).padStart(4)}  S%=${(rate(byClass.Small)*100).toFixed(0).padStart(3)} M%=${(rate(byClass.Mid)*100).toFixed(0).padStart(3)} L%=${(rate(byClass.Large)*100).toFixed(0).padStart(3)} XL%=${(rate(byClass.XL)*100).toFixed(0).padStart(3)}`);
        }
      }
    }

    // Spot 11T conf=0 cluster (PAP-1060 stamps) to see what each signal would say
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
    const cluster = [...byClass.Small].filter(r => PAP1060_STAMPS.has(r.stamp));
    if (cluster.length) {
      out(`\n=== PAP-1060 11T conf=0 cluster signals (n=${cluster.length}/${PAP1060_STAMPS.size}) ===`);
      out('stamp                            peakR/aim  gearR  rOuter/aim  contourR/aim  peakR/rOuter');
      for (const r of cluster) {
        out(`${r.stamp}  ${r.peakR_aim.toFixed(3).padStart(6)}     ${r.gearR.toFixed(3).padStart(5)}  ${r.rOuter_aim.toFixed(3).padStart(6)}      ${r.contourR_aim.toFixed(3).padStart(6)}        ${r.peakR_rOuter.toFixed(3).padStart(6)}`);
      }
    }

    // CSV
    const csvLines = ['class,actual,stamp,peakR_aim,gearR,contourR_aim,rOuter_aim,bcDist_aim,peakR_rOuter,minDim,aimR,peakTc,bcTc,fft90,opTc,bcPeaks,tc,conf,innerSus'];
    for (const cls of ['Small','Mid','Large','XL']) {
      for (const r of byClass[cls]) {
        csvLines.push([cls, r.actual, r.stamp,
          r.peakR_aim.toFixed(4), r.gearR.toFixed(4), r.contourR_aim.toFixed(4),
          r.rOuter_aim.toFixed(4), r.bcDist_aim.toFixed(4), r.peakR_rOuter.toFixed(4),
          r.minDim, r.aimR.toFixed(0),
          r.peakTc, r.bcTc, r.fft90, r.opTc, r.bcPeaks, r.tc, r.conf.toFixed(3), r.innerSus].join(','));
      }
    }
    const outFile = path.resolve(__dirname, '..', '..', 'debug-reports', 'pap1072_calib_rows_2026-05-02.csv');
    fs.writeFileSync(outFile, csvLines.join('\n'));
    out(`\nrow-level csv: ${outFile}  (${csvLines.length-1} rows)`);

    expect(rows.length).toBeGreaterThan(0);
  });
});
