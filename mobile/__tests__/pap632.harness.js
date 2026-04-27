/**
 * PAP-632 harness — runs gearCounter on ALL b94-b98 debug report photos
 * and compares against device-reported actuals. Reports accuracy by class.
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

const { countTeethFromRgba, bilinearDownsampleRgba } = require('../src/algorithm/gearCounter');

const DEBUG_DIR = path.resolve(__dirname, '..', '..', 'debug-reports');
const TARGET_MAX_DIM = 900;

function classOf(n) {
  if (n >= 10 && n <= 15) return 'Small';
  if (n >= 16 && n <= 21) return 'Mid';
  if (n >= 22 && n <= 28) return 'Large';
  if (n >= 29) return 'XL';
  return 'other';
}

describe('PAP-632 b94-b98 accuracy', () => {
  jest.setTimeout(20 * 60 * 1000);

  test('report accuracy by class', () => {
    const dirs = fs.readdirSync(DEBUG_DIR).filter(d => d.startsWith('report_')).sort();
    const reports = [];
    for (const dir of dirs) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(DEBUG_DIR, dir, 'report.json'), 'utf8').replace(/[^\x00-\x7F]+/g, ''));
        const buildStr = meta.build || meta.app?.build || '';
        const buildMatch = buildStr.match(/\((\d+)\)/);
        const buildNum = buildMatch ? Number(buildMatch[1]) : 0;
        if (buildNum < 94 || buildNum > 98) continue;
        const actual = meta.result?.actualTeethCount || meta.actualTeethCount;
        if (!actual) continue;
        const stamp = dir.replace('report_', '');
        const photo = path.join(DEBUG_DIR, dir, 'photo.jpg');
        if (!fs.existsSync(photo)) continue;
        reports.push({ stamp, actual: Number(actual), build: buildNum, photo });
      } catch { continue; }
    }

    process.stdout.write(`\n[PAP-632] Running ${reports.length} b94-b98 labeled reports\n`);

    const classes = { Small: { total: 0, correct: 0, abstain: 0, fails: [] },
                      Mid: { total: 0, correct: 0, abstain: 0, fails: [] },
                      Large: { total: 0, correct: 0, abstain: 0, fails: [] },
                      XL: { total: 0, correct: 0, abstain: 0, fails: [] } };

    for (let i = 0; i < reports.length; i++) {
      const { stamp, actual, build, photo } = reports[i];
      const buf = fs.readFileSync(photo);
      const raw = jpegDecode(buf, { useTArray: true });
      const { rgba, width: w, height: h } = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET_MAX_DIM);
      const result = countTeethFromRgba(rgba, w, h);

      const cls = classOf(actual);
      if (!classes[cls]) continue;
      classes[cls].total++;

      // For Small/Mid: exact match. For Large: ±1. For XL: ±1 or abstain (conf=0)
      const isSmallMid = cls === 'Small' || cls === 'Mid';
      const correct = isSmallMid
        ? result.toothCount === actual
        : Math.abs(result.toothCount - actual) <= 1;
      const abstained = result.confidence === 0 || result.innerContourSuspected;

      if (correct) {
        classes[cls].correct++;
      } else if (abstained) {
        classes[cls].abstain++;
      } else {
        classes[cls].fails.push({ stamp, actual, detected: result.toothCount, conf: result.confidence,
          method: result.methodUsed, peakTc: result.peakTc, fft90tc: result.fft90tc, opTc: result.opTc,
          bcTc: result.bcTc, bcPeaks: result.bcPeaks, gearRadius: result.gearRadius });
      }

      const tag = correct ? 'OK' : (abstained ? 'ABSTAIN' : 'FAIL');
      process.stdout.write(`  [${i+1}/${reports.length}] b${build} ${stamp} ${cls} actual=${actual} ` +
        `detected=${result.toothCount} conf=${result.confidence.toFixed(2)} ${tag}\n`);
    }

    process.stdout.write('\n=== PAP-632 Accuracy Matrix (current code vs b94-b98 corpus) ===\n');
    for (const [cls, d] of Object.entries(classes)) {
      if (d.total === 0) continue;
      const pct = (100 * d.correct / d.total).toFixed(0);
      const pctWithAbstain = (100 * (d.correct + d.abstain) / d.total).toFixed(0);
      process.stdout.write(`  ${cls.padEnd(8)} ${d.correct}/${d.total} = ${pct}%` +
        (d.abstain > 0 ? `  (${d.abstain} abstain → ${pctWithAbstain}% incl abstain)` : '') +
        `  fails=${d.fails.length}\n`);
    }

    process.stdout.write('\n=== Failures ===\n');
    for (const [cls, d] of Object.entries(classes)) {
      for (const f of d.fails) {
        process.stdout.write(`  ${cls} ${f.stamp} actual=${f.actual} detected=${f.detected} ` +
          `conf=${f.conf.toFixed(3)} method=${f.method} peak=${f.peakTc} fft90=${f.fft90tc} ` +
          `op=${f.opTc} bc=${f.bcTc} bcPeaks=${f.bcPeaks} gearR=${f.gearRadius?.toFixed(3)}\n`);
      }
    }
  });
});
