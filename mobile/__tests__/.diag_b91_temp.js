const fs = require('fs');
const path = require('path');
const { decode: jpegDecode } = require('jpeg-js');

// mock expo modules
require.cache[require.resolve('jpeg-js')]; // ensure loaded
process.env.JEST_WORKER_ID = '1';

const REPO_ROOT = '/home/paperclip/.paperclip/instances/default/projects/2a07d193-9a49-4cbd-ab0b-486be0ae801b/gear-camera-app';
const REPORTS = path.join(REPO_ROOT, 'debug-reports');
const TARGET = 900;

function bilinearResize(rgba, w, h, targetMaxDim) {
  const max = Math.max(w, h);
  if (max <= targetMaxDim) return { rgba, w, h };
  const scale = targetMaxDim / max;
  const nw = Math.round(w * scale), nh = Math.round(h * scale);
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = (y + 0.5) * h / nh - 0.5;
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(h - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < nw; x++) {
      const sx = (x + 0.5) * w / nw - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(w - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const i00 = (y0*w+x0)*4, i01 = (y0*w+x1)*4, i10 = (y1*w+x0)*4, i11 = (y1*w+x1)*4;
      const io = (y*nw+x)*4;
      for (let c = 0; c < 4; c++) {
        const v = (rgba[i00+c]*(1-fx)+rgba[i01+c]*fx)*(1-fy)
                + (rgba[i10+c]*(1-fx)+rgba[i11+c]*fx)*fy;
        out[io+c] = Math.round(v);
      }
    }
  }
  return { rgba: out, w: nw, h: nh };
}

// Mock expo modules via Module._load hook
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
  if (request === 'expo-file-system/legacy' || request === 'expo-image-manipulator') {
    return require.resolve(path.join(__dirname, 'empty.js'));
  }
  return origResolve.call(this, request, parent, ...rest);
};
fs.writeFileSync('/tmp/empty.js', 'module.exports = {};');
const emptyPath = '/tmp/empty.js';
Module._resolveFilename = function(request, parent, ...rest) {
  if (request === 'expo-file-system/legacy' || request === 'expo-image-manipulator') {
    return emptyPath;
  }
  return origResolve.call(this, request, parent, ...rest);
};

const { countTeethFromRgba } = require(path.join(REPO_ROOT, 'mobile/src/algorithm/gearCounter.js'));

const targets = [
  '2026-04-23_07-06-17-440Z', // 28T hit
  '2026-04-23_07-08-24-015Z', // 28T MISS
  '2026-04-23_07-10-54-790Z', // 28T hit
  '2026-04-23_07-13-03-212Z', // 24T hit
  '2026-04-23_07-14-56-462Z', // 24T MISS
  '2026-04-23_07-16-35-259Z', // 24T hit
];

for (const stamp of targets) {
  const meta = JSON.parse(fs.readFileSync(path.join(REPORTS, 'report_' + stamp, 'report.json'),'utf8').replace(/[^\x00-\x7F]+/g, '?'));
  const actual = meta.actualTeethCount;
  const buf = fs.readFileSync(path.join(REPORTS, 'report_' + stamp, 'photo.jpg'));
  const raw = jpegDecode(buf, { useTArray: true });
  const { rgba, w, h } = bilinearResize(raw.data, raw.width, raw.height, TARGET);
  const t0 = Date.now();
  const out = countTeethFromRgba(rgba, w, h);
  const hit = out.toothCount === actual;
  console.log(`${hit?'HIT ':'MISS'} ${stamp} actual=${actual} now=${out.toothCount}T(${(out.confidence*100).toFixed(0)}%) ctr=(${out.gearCenter.x.toFixed(2)},${out.gearCenter.y.toFixed(2)}) r=${(out.gearRadius*100).toFixed(1)}% via=${out.methodUsed} peak=${out.peakTc}(${(out.peakRel||0).toFixed(3)}) fft90=${out.fft90tc} bc=${out.bcTc}(pur=${(out.bcPurity||0).toFixed(3)},peaks=${out.bcPeaks}) op=${out.opTc}(${(out.opRel||0).toFixed(3)}) t=${Date.now()-t0}ms`);
}
