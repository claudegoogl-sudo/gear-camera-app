/**
 * PAP-632 deep diagnostic — traces pre-retry vs post-retry results for XL failures
 * and traces the decision cascade for the 42T case.
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

// We need access to internal functions, so require directly
const gc = require('../src/algorithm/gearCounter');
const { countTeethFromRgba, bilinearDownsampleRgba } = gc;

const DEBUG_DIR = path.resolve(__dirname, '..', '..', 'debug-reports');
const TARGET_MAX_DIM = 900;

const CASES = [
  { stamp: '2026-04-25_08-03-33-119Z', actual: 11, note: 'Small 11T→10T' },
  { stamp: '2026-04-24_10-54-47-201Z', actual: 42, note: 'XL 42T→12T (peakTc=42 correct)' },
  { stamp: '2026-04-25_09-03-08-982Z', actual: 52, note: 'XL 52T→12T (retry regression?)' },
];

// Monkeypatch console.log to capture internal debug output
const logCapture = [];
const origLog = console.log;

for (const c of CASES) {
  const photo = path.join(DEBUG_DIR, 'report_' + c.stamp, 'photo.jpg');
  if (!fs.existsSync(photo)) { origLog(`SKIP ${c.stamp}`); continue; }

  const buf = fs.readFileSync(photo);
  const raw = jpegDecode(buf, { useTArray: true });
  const { rgba, width: w, height: h } = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET_MAX_DIM);

  origLog(`\n${'='.repeat(70)}`);
  origLog(`${c.stamp} — ${c.note}`);
  origLog(`Image: ${w}x${h}, minDim=${Math.min(w, h)}`);
  origLog(`${'='.repeat(70)}`);

  // Capture all internal logs
  logCapture.length = 0;
  console.log = (...args) => { logCapture.push(args.join(' ')); };

  const result = countTeethFromRgba(rgba, w, h);

  console.log = origLog;

  origLog(`\nFinal result:`);
  origLog(`  toothCount=${result.toothCount}  confidence=${result.confidence.toFixed(3)}`);
  origLog(`  gearRadius=${result.gearRadius?.toFixed(4)}  innerContourSuspected=${result.innerContourSuspected}`);
  origLog(`  methodUsed=${result.methodUsed}`);
  origLog(`  peakTc=${result.peakTc} peakRel=${result.peakRel?.toFixed(4)}`);
  origLog(`  fft90tc=${result.fft90tc}`);
  origLog(`  opTc=${result.opTc} opRel=${result.opRel?.toFixed(4)}`);
  origLog(`  bcTc=${result.bcTc} bcPurity=${result.bcPurity?.toFixed(4)} bcPeaks=${result.bcPeaks}`);
  origLog(`  ACTUAL=${c.actual} CORRECT=${result.toothCount === c.actual}`);

  origLog(`\nInternal debug logs (${logCapture.length}):`);
  for (const l of logCapture) {
    origLog(`  >> ${l}`);
  }
}
