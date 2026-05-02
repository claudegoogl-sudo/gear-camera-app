/**
 * PAP-1059 AC1 — gate trace for 5 representative XL detected==actual conf=0
 * photos.  Identifies which abstain rule fires on each.  Prints every gate
 * boolean (radius-sanity slate + radial-chainring + bc-isolated) plus the
 * methodUsed tag suffix that countTeethFromRgba emits when it abstains.
 *
 * Run: HARNESS=pap1059.diag npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const path = require('path');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, TRAINING_DIR } = runner;

const MIN_TEETH = 10;

const SEEDS = [
  { stamp: '2026-04-25_07-58-59-154Z', actual: 42 },
  { stamp: '2026-04-25_08-05-45-433Z', actual: 42 },
  { stamp: '2026-04-30_12-31-00-766Z', actual: 50 },
  { stamp: '2026-04-30_12-33-17-234Z', actual: 48 },
  { stamp: '2026-04-30_20-03-52-567Z', actual: 52 },
];

// Replicate every gate from countTeethFromRgba on the row already returned
// by evalPhoto (raw fields surfaced via row.raw + flat fields).
function tracePhoto(row) {
  const r = row.raw;
  const w = row.w;
  const h = row.h;
  const gearRadiusCropSpace = (r.gearRadius != null) ? r.gearRadius : (r.gearR / w);
  const cropNormR = (r.contourRadius || 0) / Math.min(w, h);
  const peakTc   = r.peakTc   || 0;
  const fft90tc  = r.fft90tc  || 0;
  const opTc     = r.opTc     || 0;
  const bcTc     = r.bcTc     || 0;
  const bcPeaks  = r.bcPeaks  || 0;
  const tc       = r.toothCount || 0;
  const conf     = r.confidence || 0;
  const peakR    = r.peakR    || 0;
  const rOuter   = r.rOuter   || 0;

  const tripleAgree =
    peakTc === fft90tc && peakTc === opTc && peakTc === tc && peakTc > MIN_TEETH;
  const bcStrongAgree =
    bcTc === bcPeaks && Math.abs(bcTc - peakTc) > 5 && tc === bcTc && bcTc > MIN_TEETH;

  const upperBoundMismatch = cropNormR < 0.17 && tc >= 9 && tc <= 13;
  const xlCenterCollapse = gearRadiusCropSpace < 0.20 && tc < 30 && conf < 0.40
                           && !tripleAgree && !bcStrongAgree;
  const xlChainringInnerLock =
    gearRadiusCropSpace < 0.365 && tc < 35 && peakR > 0 && rOuter > 0
    && Math.abs(peakR - rOuter) / rOuter < 0.10
    && (peakTc >= 30 || fft90tc >= 30 || opTc >= 30 || bcTc >= 30 || bcPeaks >= 30)
    && !tripleAgree && !bcStrongAgree;
  const campaBoltAbstain =
    tc >= 12 && tc <= 13
    && (fft90tc >= 30 || opTc >= 30 || bcTc >= 30 || bcPeaks >= 30)
    && gearRadiusCropSpace >= 0.365;
  const aimR = 0.5 * Math.min(w, h);
  const aimPriorAbstain = aimR > 0
    && (peakTc >= 30 || fft90tc >= 30 || opTc >= 30 || bcTc >= 30 || bcPeaks >= 30)
    && peakR > 0 && peakR < 0.65 * aimR;

  const sanRadLT13 = gearRadiusCropSpace < 0.13;
  const sanRad15Tc20 = gearRadiusCropSpace < 0.15 && tc >= 20;

  const radiusSanityFires = sanRadLT13 || sanRad15Tc20 || upperBoundMismatch
    || xlCenterCollapse || xlChainringInnerLock || campaBoltAbstain
    || aimPriorAbstain;
  const radiusSanityAbstain = radiusSanityFires && !tripleAgree && !bcStrongAgree;

  const chainringRegime =
    peakTc >= 30 || fft90tc >= 30 || opTc >= 30 || bcTc >= 30 || bcPeaks >= 30;
  const ac1RescuePattern =
    peakTc <= MIN_TEETH + 2 && fft90tc <= MIN_TEETH + 2 && opTc <= MIN_TEETH + 2
    && bcTc <= MIN_TEETH + 2 && bcPeaks >= 20 && bcPeaks <= 30;
  const radialChainringEligible = chainringRegime || ac1RescuePattern;
  const radialChainringFires = radialChainringEligible
    && peakR > 0 && rOuter > 0
    && Math.abs(peakR - rOuter) / rOuter >= 0.18;
  const radialRel = (peakR > 0 && rOuter > 0)
    ? Math.abs(peakR - rOuter) / rOuter : null;

  const methodUsed = String(r.methodUsed || '');
  const bcIsolatedHighDelta = methodUsed.startsWith('bc-consensus')
    && bcTc >= 30 && bcPeaks >= 30
    && peakTc > 0 && fft90tc > 0 && opTc > 0
    && (bcTc - peakTc) >= 10 && (bcTc - fft90tc) >= 10 && (bcTc - opTc) >= 10;

  const fft90OuterRescue = radialChainringFires
    && peakTc === MIN_TEETH && fft90tc >= 30 && opTc > 0
    && Math.abs(fft90tc - 2 * opTc) <= 2 && gearRadiusCropSpace > 0.30;
  const fiveWayAgree = (() => {
    if (!radialChainringFires) return false;
    const ch = [peakTc, fft90tc, opTc, bcTc, bcPeaks];
    if (ch.some((v) => v < 30)) return false;
    return Math.max(...ch) - Math.min(...ch) <= 1;
  })();

  const innerContourSuspected =
    radiusSanityAbstain
    || (radialChainringFires && !fft90OuterRescue && !fiveWayAgree)
    || bcIsolatedHighDelta;

  return {
    gearRadiusCropSpace, cropNormR, peakTc, fft90tc, opTc, bcTc, bcPeaks, tc, conf,
    peakR, rOuter, aimR, peakRoverAimR: aimR > 0 ? peakR / aimR : 0,
    tripleAgree, bcStrongAgree,
    sanRadLT13, sanRad15Tc20, upperBoundMismatch,
    xlCenterCollapse, xlChainringInnerLock, campaBoltAbstain, aimPriorAbstain,
    radiusSanityFires, radiusSanityAbstain,
    chainringRegime, ac1RescuePattern, radialChainringEligible, radialChainringFires,
    radialRel,
    bcIsolatedHighDelta, fft90OuterRescue, fiveWayAgree, innerContourSuspected,
    methodUsed,
  };
}

function dominantGate(t) {
  // Order matches innerContourSuspected wiring; first true wins.
  if (t.sanRadLT13) return 'radius<0.13';
  if (t.sanRad15Tc20) return 'radius<0.15 & tc>=20';
  if (t.upperBoundMismatch) return 'upperBoundMismatch (tc 9-13)';
  if (t.xlCenterCollapse) return 'xlCenterCollapse';
  if (t.xlChainringInnerLock) return 'xlChainringInnerLock (PAP-939)';
  if (t.campaBoltAbstain) return 'campaBoltAbstain (PAP-963)';
  if (t.aimPriorAbstain) return 'aimPriorAbstain (PAP-961)';
  if (t.radialChainringFires && !t.fft90OuterRescue && !t.fiveWayAgree)
    return 'radialChainringFires (PAP-815)';
  if (t.bcIsolatedHighDelta) return 'bcIsolatedHighDelta (PAP-861)';
  return '(none — would commit)';
}

describe('PAP-1059 AC1 — XL high-tooth abstain trace', () => {
  jest.setTimeout(30 * 60 * 1000);
  test('5 seed photos', () => {
    out('\n=== PAP-1059 AC1 — gate trace ===');
    out('');

    const counts = {};
    for (const seed of SEEDS) {
      const photo = path.join(TRAINING_DIR, `${seed.stamp}_photo.jpg`);
      const row = runner.evalPhoto({
        photo, actual: seed.actual, stamp: seed.stamp, applyMask: false,
      });
      const t = tracePhoto(row);
      const gate = dominantGate(t);
      counts[gate] = (counts[gate] || 0) + 1;

      out(`-- ${seed.stamp} actual=${seed.actual} detected=${row.tc} conf=${row.conf.toFixed(3)} --`);
      out(`   w×h=${row.w}×${row.h}  gearRcrop=${t.gearRadiusCropSpace.toFixed(4)}  cropNormR=${t.cropNormR.toFixed(4)}`);
      out(`   peak=${t.peakTc} fft90=${t.fft90tc} op=${t.opTc} bc=${t.bcTc}(pk=${t.bcPeaks})`);
      out(`   peakR=${t.peakR} rOuter=${t.rOuter} aimR=${t.aimR.toFixed(0)} peakR/aimR=${t.peakRoverAimR.toFixed(3)}`);
      out(`   radialRel=${t.radialRel != null ? t.radialRel.toFixed(4) : 'n/a'}  method=${t.methodUsed}`);
      out(`   gates: san<.13=${t.sanRadLT13} san<.15&&tc>=20=${t.sanRad15Tc20} upperB=${t.upperBoundMismatch}`);
      out(`          xlCC=${t.xlCenterCollapse} xlCIL=${t.xlChainringInnerLock} campa=${t.campaBoltAbstain} aimPrior=${t.aimPriorAbstain}`);
      out(`          radialChainring=${t.radialChainringFires} fft90Resc=${t.fft90OuterRescue} 5way=${t.fiveWayAgree} bcIsolated=${t.bcIsolatedHighDelta}`);
      out(`          tripleAgree=${t.tripleAgree} bcStrongAgree=${t.bcStrongAgree}  innerContourSuspected=${t.innerContourSuspected}`);
      out(`   ⇒ DOMINANT GATE: ${gate}`);
      out('');
    }

    out('=== AC1 dominant-gate distribution ===');
    for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      out(`  ${v}/${SEEDS.length}  ${k}`);
    }

    expect(SEEDS.length).toBe(5);
  });
});
