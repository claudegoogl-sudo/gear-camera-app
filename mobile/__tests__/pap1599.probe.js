/**
 * PAP-1599 — diagnostic probe (AC2): compare full-photo (current harness) vs
 * cropped+aim-mask (device-equivalent) on the b127 corpus. Read-only — emits
 * a CSV to debug-reports/, no production code changes.
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
const OUT = path.resolve(__dirname, '..', '..', 'debug-reports', 'pap1599_probe_2026-05-20.csv');

function runOn(rgba, w, h) {
  try {
    const t0 = Date.now();
    const r = countTeethFromRgba(rgba, w, h);
    const ms = Date.now() - t0;
    return {
      tc: r.toothCount || 0,
      conf: r.confidence || 0,
      method: r.methodUsed || '?',
      peakR: r.peakR || 0,
      rOuter: r.rOuter || 0,
      gearR: r.gearR || 0,
      peakTc: r.peakTc || 0,
      fft90: r.fft90tc || 0,
      bcTc: r.bcTc || 0,
      ms,
    };
  } catch (e) { return { error: e.message, tc:0, conf:0, method:'ERR', peakR:0, rOuter:0, gearR:0, peakTc:0, fft90:0, bcTc:0, ms:0 }; }
}

function decodeAndDown(p) {
  const raw = decode(fs.readFileSync(p), { useTArray: true });
  return bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET);
}

describe('PAP-1599 probe', () => {
  jest.setTimeout(10 * 60 * 1000);
  test('full-photo vs cropped+mask', () => {
    const rows = [
      'event,actual,devicePred,deviceMethod,deviceConf,fullTC,fullConf,fullMethod,fullPeakR,fullROuter,fullGearR,fullPeakTc,fullFft90,fullBcTc,fullW,fullH,fullMs,crmTC,crmConf,crmMethod,crmPeakR,crmROuter,crmGearR,crmPeakTc,crmFft90,crmBcTc,crmW,crmH,crmMs,deviceMatchFull,deviceMatchCrm',
    ];
    for (const m of MANIFEST) {
      const photo = path.join(FIX, m.photo);
      const cropped = path.join(FIX, m.cropped);
      const fullD = decodeAndDown(photo);
      const a = runOn(fullD.rgba, fullD.width, fullD.height);
      const crD = decodeAndDown(cropped);
      const maskR = 0.49 * Math.min(crD.width, crD.height);
      applyCircularMask(crD.rgba, crD.width, crD.height, (crD.width-1)/2, (crD.height-1)/2, maskR);
      const b = runOn(crD.rgba, crD.width, crD.height);
      const devTc = Number(m.predTC);
      const matchFull = (a.tc === devTc && Math.abs((a.conf||0) - (Number(m.confidence)||0)) < 0.05) ? 'Y' : 'N';
      const matchCrm  = (b.tc === devTc && Math.abs((b.conf||0) - (Number(m.confidence)||0)) < 0.05) ? 'Y' : 'N';
      rows.push([
        m.event_short, m.actualTC, m.predTC, m.methodUsed, (Number(m.confidence)||0).toFixed(3),
        a.tc, a.conf.toFixed(3), a.method, a.peakR, a.rOuter, a.gearR, a.peakTc, a.fft90, a.bcTc, fullD.width, fullD.height, a.ms,
        b.tc, b.conf.toFixed(3), b.method, b.peakR, b.rOuter, b.gearR, b.peakTc, b.fft90, b.bcTc, crD.width, crD.height, b.ms,
        matchFull, matchCrm,
      ].join(','));
      process.stdout.write(`${m.actualTC}T ${m.event_short}: device→${m.predTC}/${m.methodUsed}/${(Number(m.confidence)||0).toFixed(2)}  full→${a.tc}/${a.method}/${a.conf.toFixed(2)} [${matchFull}]  crm→${b.tc}/${b.method}/${b.conf.toFixed(2)} [${matchCrm}]\n`);
    }
    fs.writeFileSync(OUT, rows.join('\n') + '\n');
    process.stdout.write(`CSV: ${OUT}\n`);
  });
});
