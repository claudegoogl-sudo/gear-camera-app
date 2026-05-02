/**
 * PAP-1060 11T over-abstain diagnostic.  AC1 trace: the 11 photos in the
 * pap1052 cluster where detected==actual==11 yet conf=0.  Replay each via
 * countTeethFromRgba and report (a) which radius-sanity branch fires and
 * (b) why no override (tripleAgree / bcStrongAgree) rescued it.
 *
 * Run: HARNESS=pap1060.diag npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const path = require('path');
const fs = require('fs');
const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out, TRAINING_DIR } = runner;

const STAMPS = [
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
];

const MIN_TEETH = 10;

describe('PAP-1060 11T over-abstain diagnostic', () => {
  jest.setTimeout(20 * 60 * 1000);
  test('replay 11 photos, dump gate state', () => {
    out('\n=== PAP-1060 11T over-abstain trace ===');
    const rows = [];
    for (const stamp of STAMPS) {
      const photo = path.join(TRAINING_DIR, `${stamp}_photo.jpg`);
      if (!fs.existsSync(photo)) { out(`  [missing] ${stamp}`); continue; }
      const row = runner.evalPhoto({ photo, actual: 11, stamp });
      rows.push(row);
    }

    out('\n--- per-row state ---');
    for (const r of rows) {
      const raw = r.raw;
      const cropNormR = (raw.contourRadius || 0) / Math.min(r.w, r.h);
      const tripleAgree =
        raw.peakTc === raw.fft90tc && raw.peakTc === raw.opTc &&
        raw.peakTc === raw.toothCount && raw.peakTc > MIN_TEETH;
      const bcStrong =
        raw.bcTc === raw.bcPeaks && Math.abs(raw.bcTc - raw.peakTc) > 5 &&
        raw.toothCount === raw.bcTc && raw.bcTc > MIN_TEETH;
      const upperBound = cropNormR < 0.17 && raw.toothCount >= 9 && raw.toothCount <= 13;
      const radiusSmall = r.gearR < 0.13;
      const aimR = 0.5 * Math.min(r.w, r.h);
      const aimPriorAbstain =
        aimR > 0 &&
        (raw.peakTc >= 30 || raw.fft90tc >= 30 || raw.opTc >= 30 ||
         raw.bcTc >= 30 || raw.bcPeaks >= 30) &&
        raw.peakR > 0 && raw.peakR < 0.65 * aimR;
      out(`${r.stamp}  ${r.w}x${r.h}`);
      out(`  tc=${r.tc} conf=${r.conf.toFixed(3)} method=${r.method} innerSus=${r.innerSus}`);
      out(`  peakTc=${r.peakTc} fft90=${r.fft90} op=${r.op} bcTc=${r.bcTc} bcPk=${r.bcPeaks}`);
      out(`  gearR=${r.gearR.toFixed(4)} contourR=${(raw.contourRadius || 0).toFixed(1)} ` +
          `cropNormR=${cropNormR.toFixed(4)} peakR=${raw.peakR} rOuter=${raw.rOuter} ` +
          `radialRel=${raw.radialRelDisagree == null ? 'null' : raw.radialRelDisagree.toFixed(3)}`);
      out(`  GATES: gR<0.13=${radiusSmall} upperBound=${upperBound} ` +
          `aimPrior=${aimPriorAbstain} | tripleAgree=${tripleAgree} bcStrong=${bcStrong}`);
    }

    out('\n--- summary ---');
    let upperFired = 0, smallFired = 0, aimFired = 0, tripleSavedBy = 0;
    for (const r of rows) {
      const raw = r.raw;
      const cropNormR = (raw.contourRadius || 0) / Math.min(r.w, r.h);
      if (cropNormR < 0.17 && raw.toothCount >= 9 && raw.toothCount <= 13) upperFired++;
      if (r.gearR < 0.13) smallFired++;
      const aimR = 0.5 * Math.min(r.w, r.h);
      if (aimR > 0 && (raw.peakTc >= 30 || raw.fft90tc >= 30 || raw.opTc >= 30 ||
          raw.bcTc >= 30 || raw.bcPeaks >= 30) &&
          raw.peakR > 0 && raw.peakR < 0.65 * aimR) aimFired++;
      const tripleAgree =
        raw.peakTc === raw.fft90tc && raw.peakTc === raw.opTc &&
        raw.peakTc === raw.toothCount && raw.peakTc > MIN_TEETH;
      if (tripleAgree) tripleSavedBy++;
    }
    out(`upperBound fired: ${upperFired}/${rows.length}`);
    out(`gR<0.13 fired:    ${smallFired}/${rows.length}`);
    out(`aimPrior fired:   ${aimFired}/${rows.length}`);
    out(`tripleAgree set:  ${tripleSavedBy}/${rows.length}`);

    expect(rows.length).toBe(STAMPS.length);
  });
});
