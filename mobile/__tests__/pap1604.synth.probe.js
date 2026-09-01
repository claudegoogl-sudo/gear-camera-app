/**
 * PAP-1604 — synthesis probe (AC2): does a synthesized device-truthful crop
 * (full _photo.jpg → cover-crop at fixed photo-fractional aim center + sideFrac →
 * downsample 900 → 0.49·min(W,H) circular mask) reproduce device outcomes
 * vs the current full-frame harness pipeline?
 *
 * Read-only — emits a CSV to debug-reports/. No production code changes.
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

const FIX = path.resolve(__dirname, 'fixtures', 'b127');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf8'));
const TARGET = 900;
const OUT = path.resolve(__dirname, '..', '..', 'debug-reports', 'pap1604_synth_probe_2026-05-20.csv');

// Per-build crop side fraction (side / fullW for 3:4 portrait photo from the
// Xiaomi capture device). Derived empirically from b127 sentry fixtures
// (aimCrop.side / aimCrop.fullW = 0.602 for b≥107; aimCrop.side / aimCrop.fullW
// is ~0.692 for b95..b106 per CameraScreen.jsx PAP-672/738 history).
function sideFracForBuild(build) {
  if (build >= 107) return 0.602;
  if (build >= 95) return 0.692;
  return null; // pre-PAP-672 geometry unknown
}

// Aim center in fractional photo coords for the Xiaomi 21081111RG portrait
// capture (sw≈393, sh≈786 logical with status/top bars; the aim circle is
// centered ON the camera-preview region of the screen, not screen midpoint).
// Empirically constant across all 9 b127 sentry events.
const AIM_CX_FRAC = 0.500;
const AIM_CY_FRAC = 0.416;

function cropRgba(rgba, w, h, ox, oy, side) {
  const out = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    const srcRow = (oy + y) * w * 4;
    const dstRow = y * side * 4;
    out.set(rgba.subarray(srcRow + ox * 4, srcRow + (ox + side) * 4), dstRow);
  }
  return out;
}

function synthDeviceCrop(photoPath, build) {
  const raw = decode(fs.readFileSync(photoPath), { useTArray: true });
  const fullW = raw.width;
  const fullH = raw.height;
  const sf = sideFracForBuild(build) || 0.602;
  const side = Math.round(sf * fullW);
  const cx = Math.round(AIM_CX_FRAC * fullW);
  const cy = Math.round(AIM_CY_FRAC * fullH);
  let ox = Math.max(0, Math.min(fullW - side, cx - Math.floor(side / 2)));
  let oy = Math.max(0, Math.min(fullH - side, cy - Math.floor(side / 2)));
  const cropped = cropRgba(raw.data, fullW, fullH, ox, oy, side);
  const ds = bilinearDownsampleRgba(cropped, side, side, TARGET);
  const maskR = 0.49 * Math.min(ds.width, ds.height);
  applyCircularMask(ds.rgba, ds.width, ds.height, (ds.width - 1) / 2, (ds.height - 1) / 2, maskR);
  return { rgba: ds.rgba, w: ds.width, h: ds.height, side, ox, oy };
}

function runAlgo(rgba, w, h) {
  try {
    const r = countTeethFromRgba(rgba, w, h);
    return {
      tc: r.toothCount || 0,
      conf: r.confidence || 0,
      method: r.methodUsed || '?',
    };
  } catch (e) { return { tc: 0, conf: 0, method: 'ERR' }; }
}

describe('PAP-1604 synth probe', () => {
  jest.setTimeout(10 * 60 * 1000);
  test('synth-crop vs sentry-crop vs device', () => {
    const rows = [
      'event,actual,devicePred,deviceConf,synthTC,synthConf,synthMethod,sentryTC,sentryConf,sentryMethod,matchDev_synth,matchDev_sentry,matchSentry_synth',
    ];
    for (const m of MANIFEST) {
      const photo = path.join(FIX, m.photo);
      const cropped = path.join(FIX, m.cropped);
      const buildM = /\((\d+)\)/.exec(m.release || '');
      const build = buildM ? Number(buildM[1]) : 127;

      // Synth: derive cropped from full photo.
      const syn = synthDeviceCrop(photo, build);
      const aSyn = runAlgo(syn.rgba, syn.w, syn.h);

      // Sentry: use the device-captured cropped.jpg with same mask.
      const cd = decode(fs.readFileSync(cropped), { useTArray: true });
      const ds = bilinearDownsampleRgba(cd.data, cd.width, cd.height, TARGET);
      const maskR = 0.49 * Math.min(ds.width, ds.height);
      applyCircularMask(ds.rgba, ds.width, ds.height, (ds.width - 1) / 2, (ds.height - 1) / 2, maskR);
      const aSen = runAlgo(ds.rgba, ds.width, ds.height);

      const devTc = Number(m.predTC);
      const devCf = Number(m.confidence) || 0;
      const matchDS = (aSyn.tc === devTc && Math.abs(aSyn.conf - devCf) < 0.05) ? 'Y' : 'N';
      const matchDC = (aSen.tc === devTc && Math.abs(aSen.conf - devCf) < 0.05) ? 'Y' : 'N';
      const matchSC = (aSyn.tc === aSen.tc && Math.abs(aSyn.conf - aSen.conf) < 0.05) ? 'Y' : 'N';
      rows.push([
        m.event_short, m.actualTC, m.predTC, devCf.toFixed(3),
        aSyn.tc, aSyn.conf.toFixed(3), aSyn.method,
        aSen.tc, aSen.conf.toFixed(3), aSen.method,
        matchDS, matchDC, matchSC,
      ].join(','));
      process.stdout.write(
        `${m.actualTC}T ${m.event_short}: dev→${m.predTC}/${devCf.toFixed(2)}  synth→${aSyn.tc}/${aSyn.conf.toFixed(2)} [${matchDS}]  sentry→${aSen.tc}/${aSen.conf.toFixed(2)} [${matchDC}]  synth≈sentry [${matchSC}]\n`,
      );
    }
    fs.writeFileSync(OUT, rows.join('\n') + '\n');
    process.stdout.write(`CSV: ${OUT}\n`);
  });
});
