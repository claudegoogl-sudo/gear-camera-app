/**
 * PAP-1604 — backfill probe (AC2/AC4 evidence).
 *
 * Pairs training-data stamps with debug-reports/report_* directories that have
 * cropped.jpg + photo.jpg + report.json (with aimCrop). Runs the algorithm at
 * HEAD on each pair under two pipelines:
 *
 *   - "full"    : training-data/<stamp>_photo.jpg → bilinear→900 → NO mask
 *                 (the current harness-runner default)
 *   - "cropped" : debug-reports/report_<dr>/cropped.jpg → bilinear→900 →
 *                 0.49·min(W,H) circular mask  (device-truthful path)
 *
 * Read-only. Emits a CSV to debug-reports/ for QA cross-check + AC4 cross-walk.
 *
 * NOTE: this is a *probe*, not a harness-runner mode. Production migration to
 * geometry='cropped' is gated on QA verdict on PAP-1607.
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode } = require('jpeg-js');
const runner = require('./lib/harness-runner');
runner.silenceConsole();

const { countTeethFromRgba, bilinearDownsampleRgba } = require('../src/algorithm/gearCounter');
const { applyCircularMask } = require('../src/algorithm/imageUtils');

const TD = path.resolve(__dirname, '..', '..', 'training-data');
const DR = path.resolve(__dirname, '..', '..', 'debug-reports');
const OUT = path.resolve(__dirname, '..', '..', 'debug-reports', 'pap1604_backfill_probe_2026-05-20.csv');
const TARGET = 900;

function toMs(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  if (!m) return null;
  const [_, Y, Mo, D, H, Mi, S, Ms] = m;
  return Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S, +Ms);
}

function discoverBackfillPairs() {
  // Collect debug-reports/report_* dirs that have the full triplet.
  const drDirs = [];
  for (const d of fs.readdirSync(DR).sort()) {
    if (!d.startsWith('report_')) continue;
    const p = path.join(DR, d);
    const files = new Set(fs.readdirSync(p));
    if (files.has('cropped.jpg') && files.has('photo.jpg') && files.has('report.json')) {
      const stamp = d.replace('report_', '');
      const ms = toMs(stamp);
      if (ms != null) drDirs.push({ dir: d, stamp, ms });
    }
  }
  drDirs.sort((a, b) => a.ms - b.ms);

  // Index training-data stamps.
  const tdStamps = [];
  for (const f of fs.readdirSync(TD).sort()) {
    const m = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}Z)_meta\.json$/.exec(f);
    if (!m) continue;
    const stamp = m[1];
    const ms = toMs(stamp);
    if (ms != null) tdStamps.push({ stamp, ms });
  }
  tdStamps.sort((a, b) => a.ms - b.ms);
  const tdKeys = tdStamps.map((x) => x.ms);

  // For each DR-w-triplet, find closest training-data stamp within ≤60s.
  const pairs = [];
  for (const dr of drDirs) {
    // Binary search.
    let lo = 0, hi = tdKeys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tdKeys[mid] < dr.ms) lo = mid + 1; else hi = mid;
    }
    let best = null;
    for (const i of [lo - 1, lo]) {
      if (i < 0 || i >= tdStamps.length) continue;
      const d = Math.abs(tdStamps[i].ms - dr.ms);
      if (best == null || d < best.d) best = { td: tdStamps[i], d };
    }
    if (best && best.d <= 60_000) {
      pairs.push({ dr, td: best.td, deltaMs: best.d });
    }
  }
  return pairs;
}

function readActual(stamp) {
  const p = path.join(TD, `${stamp}_meta.json`);
  try {
    const raw = fs.readFileSync(p, 'utf8').replace(/[^\x00-\x7F]+/g, '?');
    const m = JSON.parse(raw);
    return Number(m.actual_tooth_count || m.actualTeethCount || 0) || 0;
  } catch { return 0; }
}

function decodeDown(filePath) {
  const raw = decode(fs.readFileSync(filePath), { useTArray: true });
  return bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET);
}

function runAlgo(rgba, w, h) {
  try {
    const r = countTeethFromRgba(rgba, w, h);
    return {
      tc: r.toothCount || 0,
      conf: r.confidence || 0,
      method: r.methodUsed || '?',
      peakR: r.peakR || 0,
      rOuter: r.rOuter || 0,
    };
  } catch (e) { return { tc: 0, conf: 0, method: 'ERR', peakR: 0, rOuter: 0 }; }
}

function classOf(a) {
  if (a <= 13) return 'Small';
  if (a <= 20) return 'Mid';
  if (a <= 28) return 'Large';
  return 'XL';
}

describe('PAP-1604 backfill probe', () => {
  jest.setTimeout(60 * 60 * 1000);
  test('full-frame vs cropped+aimCrop on backfilled stamps', () => {
    const pairs = discoverBackfillPairs();
    process.stdout.write(`Backfill pairs: ${pairs.length}\n`);

    const rows = [
      'tdStamp,drDir,deltaMs,actual,klass,build,fullTC,fullConf,fullMethod,fullPeakR,fullROuter,crmTC,crmConf,crmMethod,crmPeakR,crmROuter,aimCircleFrac,sameTC,fullCorrect,crmCorrect',
    ];
    const tally = {
      Small: { n: 0, fullC: 0, crmC: 0, flip: 0 },
      Mid:   { n: 0, fullC: 0, crmC: 0, flip: 0 },
      Large: { n: 0, fullC: 0, crmC: 0, flip: 0 },
      XL:    { n: 0, fullC: 0, crmC: 0, flip: 0 },
    };

    let i = 0;
    for (const p of pairs) {
      i++;
      const actual = readActual(p.td.stamp);
      if (actual <= 0) continue;
      const klass = classOf(actual);
      // PAP-1604 A6 + board feedback (feedback_zero_tolerance_no_softening):
      // report strict tol=0. Off-by-one is structural, not a pass.
      const tol = 0;

      // FULL pipeline: training-data/_photo.jpg → bilinear→900 → no mask
      const fullPath = path.join(TD, `${p.td.stamp}_photo.jpg`);
      if (!fs.existsSync(fullPath)) continue;
      const dF = decodeDown(fullPath);
      const aF = runAlgo(dF.rgba, dF.width, dF.height);

      // CROPPED pipeline: debug-reports/<dr>/cropped.jpg → bilinear→900 →
      // 0.49·min(W,H) circular mask  (device-truthful)
      const crPath = path.join(DR, `report_${p.dr.stamp}`, 'cropped.jpg');
      const dC = decodeDown(crPath);
      const maskR = 0.49 * Math.min(dC.width, dC.height);
      applyCircularMask(dC.rgba, dC.width, dC.height, (dC.width - 1) / 2, (dC.height - 1) / 2, maskR);
      const aC = runAlgo(dC.rgba, dC.width, dC.height);

      let aimCircleFrac = '?';
      let build = '?';
      try {
        const rep = JSON.parse(fs.readFileSync(path.join(DR, `report_${p.dr.stamp}`, 'report.json'), 'utf8').replace(/[^\x00-\x7F]+/g, '?'));
        aimCircleFrac = rep.aimCrop?.aimCircleFrac;
        const bm = /\((\d+)\)/.exec(rep.build || '');
        build = bm ? bm[1] : '?';
      } catch {}

      const fullCorrect = aF.tc > 0 && aF.conf > 0 && Math.abs(aF.tc - actual) <= tol ? 'Y' : 'N';
      const crmCorrect = aC.tc > 0 && aC.conf > 0 && Math.abs(aC.tc - actual) <= tol ? 'Y' : 'N';
      const sameTC = aF.tc === aC.tc ? 'Y' : 'N';

      rows.push([
        p.td.stamp, `report_${p.dr.stamp}`, p.deltaMs, actual, klass, build,
        aF.tc, aF.conf.toFixed(3), aF.method, aF.peakR, aF.rOuter,
        aC.tc, aC.conf.toFixed(3), aC.method, aC.peakR, aC.rOuter,
        aimCircleFrac, sameTC, fullCorrect, crmCorrect,
      ].join(','));

      const T = tally[klass];
      T.n++;
      if (fullCorrect === 'Y') T.fullC++;
      if (crmCorrect === 'Y') T.crmC++;
      if (fullCorrect !== crmCorrect) T.flip++;

      if (i % 10 === 0) process.stdout.write(`  [${i}/${pairs.length}]\n`);
    }

    fs.writeFileSync(OUT, rows.join('\n') + '\n');
    process.stdout.write(`\nCSV: ${OUT}\n\n`);
    process.stdout.write('Class    N   full-correct  cropped-correct  flip\n');
    for (const k of ['Small', 'Mid', 'Large', 'XL']) {
      const T = tally[k];
      const pf = T.n ? (100 * T.fullC / T.n).toFixed(1) : '-';
      const pc = T.n ? (100 * T.crmC / T.n).toFixed(1) : '-';
      const pflip = T.n ? (100 * T.flip / T.n).toFixed(1) : '-';
      process.stdout.write(`${k.padEnd(7)}  ${String(T.n).padStart(3)}   ${String(T.fullC).padStart(3)} (${pf}%)    ${String(T.crmC).padStart(3)} (${pc}%)       ${String(T.flip).padStart(3)} (${pflip}%)\n`);
    }
  });
});
