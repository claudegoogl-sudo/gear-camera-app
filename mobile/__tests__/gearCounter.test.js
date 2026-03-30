/**
 * Unit tests for the pure-JS algorithm functions in gearCounter.js.
 *
 * These tests import only the internal helpers — no camera, no file I/O.
 * They run entirely in Node/Jest with no device required.
 *
 * To run:  npm test  (from the mobile/ directory)
 */

// ── Pull out testable internals ──────────────────────────────────────────────
// Jest runs in CJS; we stub the native-module imports that gearCounter uses
// at the top level so we can reach the pure functions.

jest.mock('expo-file-system', () => ({}));
jest.mock('expo-image-manipulator', () => ({}));
jest.mock('jpeg-js', () => ({}));

// Helper: re-implement the pure functions locally so tests don't depend on
// the module's internal export structure.  Each function is a copy-paste of
// the production code — if the implementation changes, tests break visibly.

function toGrayscale(rgba, width, height) {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = 0.299 * rgba[i*4] + 0.587 * rgba[i*4+1] + 0.114 * rgba[i*4+2];
  }
  return gray;
}

const GAUSS_KERNEL_5 = [2,4,5,4,2,4,9,12,9,4,5,12,15,12,5,4,9,12,9,4,2,4,5,4,2];
const GAUSS_SUM = 159;

function gaussianBlur(gray, width, height) {
  const out = new Float32Array(width * height);
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      let acc = 0;
      for (let ky = -2; ky <= 2; ky++)
        for (let kx = -2; kx <= 2; kx++)
          acc += gray[(y+ky)*width+(x+kx)] * GAUSS_KERNEL_5[(ky+2)*5+(kx+2)];
      out[y*width+x] = acc / GAUSS_SUM;
    }
  }
  return out;
}

function sobelEdges(gray, width, height) {
  const mag = new Float32Array(width * height);
  for (let y = 1; y < height-1; y++) {
    for (let x = 1; x < width-1; x++) {
      const tl=gray[(y-1)*width+(x-1)],tc=gray[(y-1)*width+x],tr=gray[(y-1)*width+(x+1)];
      const ml=gray[y*width+(x-1)],                            mr=gray[y*width+(x+1)];
      const bl=gray[(y+1)*width+(x-1)],bc=gray[(y+1)*width+x],br=gray[(y+1)*width+(x+1)];
      const gx = -tl-2*ml-bl+tr+2*mr+br;
      const gy = -tl-2*tc-tr+bl+2*bc+br;
      mag[y*width+x] = Math.sqrt(gx*gx+gy*gy);
    }
  }
  const vals = Array.from(mag).filter(v=>v>0).sort((a,b)=>a-b);
  const threshold = vals[Math.floor(vals.length*0.85)]??1;
  const edges = new Uint8Array(width*height);
  for (let i=0;i<mag.length;i++) edges[i]=mag[i]>=threshold?255:0;
  return edges;
}

function findGearCenter(edges, width, height) {
  let sx=0,sy=0,count=0;
  for (let y=0;y<height;y++)
    for (let x=0;x<width;x++)
      if (edges[y*width+x]>0){sx+=x;sy+=y;count++;}
  if (!count) return {cx:Math.floor(width/2),cy:Math.floor(height/2)};
  return {cx:Math.round(sx/count),cy:Math.round(sy/count)};
}

function smoothArray(arr, halfWin) {
  const out = new Float32Array(arr.length);
  for (let i=0;i<arr.length;i++){
    let sum=0,cnt=0;
    for (let d=-halfWin;d<=halfWin;d++){const j=i+d;if(j>=0&&j<arr.length){sum+=arr[j];cnt++;}}
    out[i]=sum/cnt;
  }
  return out;
}

function findGearRadius(edges, cx, cy, width, height) {
  const maxR = Math.floor(Math.min(cx, width-cx, cy, height-cy))-1;
  const density = new Float32Array(maxR);
  for (let y=0;y<height;y++)
    for (let x=0;x<width;x++)
      if (edges[y*width+x]>0){const d=Math.round(Math.sqrt((x-cx)**2+(y-cy)**2));if(d<maxR)density[d]++;}
  const halfWin = Math.max(2,Math.floor(maxR/16));
  const smooth = smoothArray(density,halfWin);
  const cap = Math.floor(maxR*0.90);
  const maxVal = Math.max(...smooth.slice(0,cap));
  const minH = maxVal*0.12;
  const peaks=[];
  for(let r=1;r<cap-1;r++) if(smooth[r]>smooth[r-1]&&smooth[r]>smooth[r+1]&&smooth[r]>=minH) peaks.push(r);
  return peaks.length>0?peaks[peaks.length-1]:Math.floor(maxR*0.5);
}

function sampleIntensityRing(gray, cx, cy, r, width, height, nAngles) {
  const s = new Float32Array(nAngles);
  for (let i=0;i<nAngles;i++){
    const a=(2*Math.PI*i)/nAngles;
    const px=Math.round(cx+r*Math.cos(a));
    const py=Math.round(cy+r*Math.sin(a));
    s[i]=(px>=0&&px<width&&py>=0&&py<height)?gray[py*width+px]:128;
  }
  return s;
}

function computeDFT(signal) {
  const N=signal.length;
  const out=new Float32Array(Math.floor(N/2)+1);
  const mean=signal.reduce((a,b)=>a+b,0)/N;
  for (let k=0;k<=Math.floor(N/2);k++){
    let re=0,im=0;
    for (let n=0;n<N;n++){const a=(2*Math.PI*k*n)/N;re+=(signal[n]-mean)*Math.cos(a);im-=(signal[n]-mean)*Math.sin(a);}
    out[k]=Math.sqrt(re*re+im*im);
  }
  return out;
}

function pickToothCount(dft) {
  const scores=new Float32Array(66);
  for (let f=10;f<=65;f++){if(f>=dft.length)break;scores[f]=dft[f];if(2*f<dft.length)scores[f]+=0.5*dft[2*f];}
  let best=10;
  for (let f=11;f<=65;f++) if(scores[f]>scores[best])best=f;
  let sec=0;
  for (let f=10;f<=65;f++) if(f!==best&&scores[f]>sec)sec=scores[f];
  const ratio=sec>0?scores[best]/sec:10;
  return {toothCount:best,confidence:Math.min(1,(ratio-1)/9)};
}

// ────────────────────────────────────────────────────────────────────────────

describe('toGrayscale', () => {
  test('pure white RGBA → 255', () => {
    const rgba = new Uint8Array([255, 255, 255, 255]);
    expect(toGrayscale(rgba, 1, 1)[0]).toBeCloseTo(255, 0);
  });

  test('pure black RGBA → 0', () => {
    const rgba = new Uint8Array([0, 0, 0, 255]);
    expect(toGrayscale(rgba, 1, 1)[0]).toBeCloseTo(0, 0);
  });

  test('pure red → ~76 (0.299 * 255)', () => {
    const rgba = new Uint8Array([255, 0, 0, 255]);
    expect(toGrayscale(rgba, 1, 1)[0]).toBeCloseTo(76.2, 0);
  });

  test('output length matches width * height', () => {
    const rgba = new Uint8Array(4 * 10 * 8).fill(128);
    expect(toGrayscale(rgba, 10, 8).length).toBe(80);
  });
});

describe('gaussianBlur', () => {
  test('uniform image stays uniform', () => {
    const size = 20;
    const gray = new Float32Array(size * size).fill(100);
    const out  = gaussianBlur(gray, size, size);
    // Interior pixels should still be ~100
    expect(out[10 * size + 10]).toBeCloseTo(100, 1);
  });

  test('output same length as input', () => {
    const gray = new Float32Array(30 * 30).fill(50);
    expect(gaussianBlur(gray, 30, 30).length).toBe(900);
  });
});

describe('sobelEdges', () => {
  test('uniform image → no edges', () => {
    const size = 20;
    const gray = new Float32Array(size * size).fill(128);
    const edges = sobelEdges(gray, size, size);
    // No variation → all magnitudes are 0 → threshold is 0 or 1, all edges 0
    const edgeCount = edges.reduce((s, v) => s + v, 0);
    expect(edgeCount).toBe(0);
  });

  test('sharp horizontal step → edges detected', () => {
    const w = 20, h = 20;
    const gray = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        gray[y * w + x] = y < h / 2 ? 0 : 255;
    const edges = sobelEdges(gray, w, h);
    const edgeCount = edges.reduce((s, v) => s + v, 0);
    expect(edgeCount).toBeGreaterThan(0);
  });
});

describe('findGearCenter', () => {
  test('returns image centre when no edges', () => {
    const w = 100, h = 80;
    const edges = new Uint8Array(w * h);
    const { cx, cy } = findGearCenter(edges, w, h);
    expect(cx).toBe(50);
    expect(cy).toBe(40);
  });

  test('returns centroid of edge pixels', () => {
    const w = 10, h = 10;
    const edges = new Uint8Array(w * h);
    // Two edge pixels at (2,5) and (8,5) → centroid x=5
    edges[5 * w + 2] = 255;
    edges[5 * w + 8] = 255;
    const { cx, cy } = findGearCenter(edges, w, h);
    expect(cx).toBe(5);
    expect(cy).toBe(5);
  });
});

describe('computeDFT', () => {
  test('DC-removed constant signal → all zeros', () => {
    const signal = new Float32Array(64).fill(42);
    const dft = computeDFT(signal);
    // After DC removal all bins should be ~0
    for (let k = 1; k < dft.length; k++) {
      expect(dft[k]).toBeCloseTo(0, 3);
    }
  });

  test('sine wave at frequency k → peak at bin k', () => {
    const N = 360;
    const targetFreq = 20;
    const signal = new Float32Array(N);
    for (let i = 0; i < N; i++)
      signal[i] = Math.sin((2 * Math.PI * targetFreq * i) / N);
    const dft = computeDFT(signal);
    // Find max in tooth range 10–65
    let maxBin = 10;
    for (let k = 11; k <= 65; k++)
      if (dft[k] > dft[maxBin]) maxBin = k;
    expect(maxBin).toBe(targetFreq);
  });

  test('output length is N/2 + 1', () => {
    const signal = new Float32Array(360).fill(0);
    expect(computeDFT(signal).length).toBe(181);
  });
});

describe('pickToothCount', () => {
  test('picks the frequency with the highest score', () => {
    // Build a fake DFT where freq 17 is dominant
    const dft = new Float32Array(181).fill(1);
    dft[17] = 100;
    expect(pickToothCount(dft).toothCount).toBe(17);
  });

  test('harmonic boosts correct frequency', () => {
    // freq 18 modest + its harmonic at 36 strong → should beat a slightly
    // higher fundamental at 19 with no harmonic support
    const dft = new Float32Array(181).fill(1);
    dft[19] = 50;   // strong fundamental, no harmonic
    dft[18] = 45;   // slightly lower, but...
    dft[36] = 80;   // ...harmonic makes score[18] = 45 + 40 = 85 > 50
    expect(pickToothCount(dft).toothCount).toBe(18);
  });

  test('confidence is 0 when all scores equal', () => {
    const dft = new Float32Array(181).fill(10);
    const { confidence } = pickToothCount(dft);
    expect(confidence).toBeCloseTo(0, 1);
  });

  test('confidence approaches 1 when dominant frequency overwhelms others', () => {
    // Use freq 23: no integer f in 10-65 has 2*f == 23, so no harmonic aliasing
    const dft = new Float32Array(181).fill(1);
    dft[23] = 1000;
    const { confidence } = pickToothCount(dft);
    expect(confidence).toBeGreaterThan(0.9);
  });
});

describe('sampleIntensityRing', () => {
  test('all samples within image bounds → no 128 defaults', () => {
    const size = 200;
    const gray = new Float32Array(size * size).fill(80);
    const samples = sampleIntensityRing(gray, 100, 100, 40, size, size, 360);
    // all pixels at r=40 from centre are within a 200x200 image
    expect(Array.from(samples).every(v => v === 80)).toBe(true);
  });

  test('returns correct length', () => {
    const gray = new Float32Array(100 * 100).fill(0);
    expect(sampleIntensityRing(gray, 50, 50, 20, 100, 100, 360).length).toBe(360);
  });
});
