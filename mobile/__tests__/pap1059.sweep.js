/**
 * PAP-1059 AC3 — chainring-tooth-count-confirmed bypass sweep.
 *
 * Predicate under test (additive third bypass alongside tripleAgree /
 * bcStrongAgree):
 *
 *   chainringTcConfirmed :=
 *     toothCount >= 30
 *     AND (
 *       peakTc === toothCount                                             // (A)
 *       OR (bcTc === toothCount AND |bcPeaks - bcTc| <= 1)                // (B)
 *     )
 *
 * (A) catches photos where multi-radius FFT independently locked tc at
 * chainring scale but PAP-961 / PAP-815 zeroed conf because peakR landed
 * inside the aim-circle (compressed) or outside rOuter (over-extended).
 *
 * (B) catches the bc-consensus self-confirmed case (bcTc === bcPeaks ± 1)
 * where peakTc collapsed but bc resolved the outer tooth ring.
 *
 * The proposed predicate from the issue (`tc>=30 && fft90>=tc-1 && bcTc===tc`)
 * does not work — fft90 collapses to MIN_TEETH on all 5 AC1 seed photos.
 * (A)∪(B) covers all 5 seed cases (verified via pap1059.diag.js).
 *
 * Bypass scope: bypasses BOTH radiusSanityAbstain AND radialChainringFires AND
 * bcIsolatedHighDelta — the predicate is so much narrower than each abstain
 * it shouldn't unlock confident-wrong, but the sweep is the proof.
 *
 * Pass criteria:
 *   - Small ≤ 0 LOSS  (tc>=30 floor structurally excludes Small commits)
 *   - Mid   ≤ 0 LOSS  (same)
 *   - Large ≤ 0 LOSS  (`tc>=30` excludes Large 21-28T commits)
 *   - XL  ≥ +20 WIN
 *   - XL    0 LOSS
 *
 * Run: HARNESS=pap1059.sweep npx jest --config mobile/__tests__/.jest.harness.config.js
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const runner = require('./lib/harness-runner');
runner.silenceConsole();
const { out } = runner;

const MIN_TEETH = 10;

function chainringTcConfirmed(r) {
  if (r.tc < 30) return false;
  const a = r.peakTc === r.tc;
  const b = r.bcTc === r.tc && Math.abs(r.bcPeaks - r.bcTc) <= 1;
  return a || b;
}

// Replicate every existing abstain rule that the bypass would override, so we
// only count rows where the bypass is ACTUALLY changing the outcome.
function tracePhoto(r) {
  const tc = r.tc;
  const peakTc = r.peakTc;
  const fft90tc = r.fft90;
  const opTc = r.op;
  const bcTc = r.bcTc;
  const bcPeaks = r.bcPeaks;
  const peakR = r.peakR;
  const rOuter = r.rOuter;
  const conf = r.conf;
  const w = r.w; const h = r.h;
  const gearRadiusCropSpace = r.gearR;
  const cropNormR = (r.raw.contourRadius || 0) / Math.min(w, h);

  const tripleAgree = peakTc === fft90tc && peakTc === opTc
    && peakTc === tc && peakTc > MIN_TEETH;
  const bcStrongAgree = bcTc === bcPeaks && Math.abs(bcTc - peakTc) > 5
    && tc === bcTc && bcTc > MIN_TEETH;

  const upperBoundMismatch = cropNormR < 0.17 && tc >= 9 && tc <= 13;
  const xlCenterCollapse = gearRadiusCropSpace < 0.20 && tc < 30 && conf < 0.40
    && !tripleAgree && !bcStrongAgree;
  const xlChainringInnerLock =
    gearRadiusCropSpace < 0.365 && tc < 35 && peakR > 0 && rOuter > 0
    && Math.abs(peakR - rOuter) / rOuter < 0.10
    && (peakTc >= 30 || fft90tc >= 30 || opTc >= 30 || bcTc >= 30 || bcPeaks >= 30)
    && !tripleAgree && !bcStrongAgree;
  const campaBoltAbstain = tc >= 12 && tc <= 13
    && (fft90tc >= 30 || opTc >= 30 || bcTc >= 30 || bcPeaks >= 30)
    && gearRadiusCropSpace >= 0.365;
  const aimR = 0.5 * Math.min(w, h);
  const aimPriorAbstain = aimR > 0
    && (peakTc >= 30 || fft90tc >= 30 || opTc >= 30 || bcTc >= 30 || bcPeaks >= 30)
    && peakR > 0 && peakR < 0.65 * aimR;
  const radiusSanityFires = gearRadiusCropSpace < 0.13
    || (gearRadiusCropSpace < 0.15 && tc >= 20)
    || upperBoundMismatch || xlCenterCollapse || xlChainringInnerLock
    || campaBoltAbstain || aimPriorAbstain;
  const radiusSanityAbstain = radiusSanityFires && !tripleAgree && !bcStrongAgree;

  const chainringRegime = peakTc >= 30 || fft90tc >= 30 || opTc >= 30
    || bcTc >= 30 || bcPeaks >= 30;
  const ac1RescuePattern =
    peakTc <= MIN_TEETH + 2 && fft90tc <= MIN_TEETH + 2 && opTc <= MIN_TEETH + 2
    && bcTc <= MIN_TEETH + 2 && bcPeaks >= 20 && bcPeaks <= 30;
  const radialChainringEligible = chainringRegime || ac1RescuePattern;
  const radialChainringFires = radialChainringEligible
    && peakR > 0 && rOuter > 0
    && Math.abs(peakR - rOuter) / rOuter >= 0.18;

  const fft90OuterRescue = radialChainringFires
    && peakTc === MIN_TEETH && fft90tc >= 30 && opTc > 0
    && Math.abs(fft90tc - 2 * opTc) <= 2 && gearRadiusCropSpace > 0.30;
  const fiveWayAgree = (() => {
    if (!radialChainringFires) return false;
    const ch = [peakTc, fft90tc, opTc, bcTc, bcPeaks];
    if (ch.some((v) => v < 30)) return false;
    return Math.max(...ch) - Math.min(...ch) <= 1;
  })();

  const m = String(r.method || '');
  const bcIsolatedHighDelta = m.startsWith('bc-consensus')
    && bcTc >= 30 && bcPeaks >= 30
    && peakTc > 0 && fft90tc > 0 && opTc > 0
    && (bcTc - peakTc) >= 10 && (bcTc - fft90tc) >= 10 && (bcTc - opTc) >= 10;

  const innerContourSuspected = radiusSanityAbstain
    || (radialChainringFires && !fft90OuterRescue && !fiveWayAgree)
    || bcIsolatedHighDelta;

  return {
    radiusSanityAbstain,
    radialChainringHits: radialChainringFires && !fft90OuterRescue && !fiveWayAgree,
    bcIsolatedHighDelta,
    innerContourSuspected,
  };
}

describe('PAP-1059 chainringTcConfirmed sweep', () => {
  jest.setTimeout(180 * 60 * 1000);
  test('full 9-60T training corpus + per-class WIN/LOSS', () => {
    out('\n=== PAP-1059 — chainringTcConfirmed bypass sweep ===');
    out('predicate: tc>=30 && (peakTc===tc || (bcTc===tc && |bcPeaks-bcTc|<=1))');

    const { rows } = runner.runCorpus({
      targetRange: [9, 60],
      label: 'pap1059-train',
      progressEvery: 50,
    });
    out(`\n[Training] ${rows.length} photos (9-60T)`);

    const cls = { Small: { wL: 0, wW: 0, fires: 0 },
                  Mid:   { wL: 0, wW: 0, fires: 0 },
                  Large: { wL: 0, wW: 0, fires: 0 },
                  XL:    { wL: 0, wW: 0, fires: 0 } };
    const noopCommit = { Small: 0, Mid: 0, Large: 0, XL: 0 };
    const lossRows = []; const winRows = []; const noopRows = [];

    for (const r of rows) {
      if (!chainringTcConfirmed(r)) continue;

      const t = tracePhoto(r);
      const k = r.klass;
      cls[k].fires++;

      // Bypass only matters if the row is currently zeroed out by an existing
      // abstain — otherwise it's a no-op (would already commit).
      if (!t.innerContourSuspected) { noopCommit[k]++; continue; }

      // Currently abstain → bypass would convert to commit at tc.
      if (r.tc === 0) { noopRows.push({ r, t, why: 'tc=0' }); continue; }
      if (r.within1) { cls[k].wW++; winRows.push({ r, t }); }
      else           { cls[k].wL++; lossRows.push({ r, t }); }
    }

    out('\n=== bypass-eligible rows by class ===');
    for (const k of ['Small', 'Mid', 'Large', 'XL']) {
      out(`  ${k.padEnd(6)} fires=${cls[k].fires}  noopAlreadyCommit=${noopCommit[k]}  WIN=${cls[k].wW}  LOSS=${cls[k].wL}`);
    }

    if (lossRows.length) {
      out('\n=== LOSS rows (bypass converts ABSTAIN → CONFIDENT-WRONG) ===');
      for (const { r, t } of lossRows) {
        out(`  ${r.stamp}  cls=${r.klass}  actual=${r.actual}  tc=${r.tc}  conf=${r.conf.toFixed(2)}  ` +
            `peak=${r.peakTc} fft90=${r.fft90} op=${r.op} bc=${r.bcTc}(pk=${r.bcPeaks})  ` +
            `gateHit=${t.radiusSanityAbstain ? 'rSan' : t.radialChainringHits ? 'radCR' : t.bcIsolatedHighDelta ? 'bcIso' : '?'}  m=${r.method}`);
      }
    }
    if (winRows.length) {
      out('\n=== WIN rows (bypass rescues ABSTAIN → CORRECT) ===');
      for (const { r, t } of winRows) {
        out(`  ${r.stamp}  cls=${r.klass}  actual=${r.actual}  tc=${r.tc}  conf=${r.conf.toFixed(2)}  ` +
            `peak=${r.peakTc} fft90=${r.fft90} op=${r.op} bc=${r.bcTc}(pk=${r.bcPeaks})  ` +
            `gateHit=${t.radiusSanityAbstain ? 'rSan' : t.radialChainringHits ? 'radCR' : t.bcIsolatedHighDelta ? 'bcIso' : '?'}  m=${r.method}`);
      }
    }

    out('\n=== AC3 PASS GATES ===');
    out(`  Small LOSS = 0 : ${cls.Small.wL} → ${cls.Small.wL === 0 ? 'PASS' : 'FAIL'}`);
    out(`  Mid   LOSS = 0 : ${cls.Mid.wL}   → ${cls.Mid.wL   === 0 ? 'PASS' : 'FAIL'}`);
    out(`  Large LOSS = 0 : ${cls.Large.wL} → ${cls.Large.wL === 0 ? 'PASS' : 'FAIL'}`);
    out(`  XL  WIN ≥ +20  : ${cls.XL.wW}    → ${cls.XL.wW    >= 20 ? 'PASS' : 'FAIL'}`);
    out(`  XL  LOSS = 0   : ${cls.XL.wL}    → ${cls.XL.wL    === 0 ? 'PASS' : 'FAIL'}`);
    const ok = cls.Small.wL === 0 && cls.Mid.wL === 0 && cls.Large.wL === 0
      && cls.XL.wW >= 20 && cls.XL.wL === 0;
    out(`  OVERALL        : ${ok ? 'PASS' : 'FAIL'}`);

    expect(rows.length).toBeGreaterThan(0);
  });
});
