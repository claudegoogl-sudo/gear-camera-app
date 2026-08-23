/**
 * PAP-1696 — the JS half of the native `cv::dft` fft-backend install path.
 *
 * The DFT-core parity claim itself (cv::dft agrees with our radix-2 butterfly
 * to float machine precision) is proven on the real corpus by
 * docs/pap1696-detect-fft-dft-parity.md / mobile/__tests__/pap1696_dft_parity.py
 * (QA-confirmed on PAP-1698) — that needs real OpenCV and isn't repeatable
 * here. What this file covers instead:
 *
 *  1. every way the native module can be absent throws at require() time
 *     (unlike GearKernels' NativeModules check, react-native-fast-opencv
 *     throws from its own index.js when unlinked) and that leaves the JS
 *     fft backend in charge, exactly like nativeKernels.test.js proves for
 *     preprocess.
 *  2. the Mat/dft/split/magnitude orchestration in nativeFft.js — packing the
 *     signal into a Mat, reading DFT_COMPLEX_OUTPUT back out, slicing to the
 *     N/2+1 half-spectrum, degrading to JS on a throwing backend — is wired
 *     correctly, using a fake OpenCV that computes a real (naive O(n^2)) DFT
 *     so the end-to-end numeric result is checked against fftMagnitudeJs
 *     rather than just shape-asserted.
 */
function naiveDft(re, N) {
  // A reference DFT independent of fft.js's own radix-2 implementation, so
  // this test doesn't just check the code against itself.
  const outRe = new Float64Array(N);
  const outIm = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let sr = 0, si = 0;
    for (let n = 0; n < N; n++) {
      const angle = (-2 * Math.PI * k * n) / N;
      sr += re[n] * Math.cos(angle);
      si += re[n] * Math.sin(angle);
    }
    outRe[k] = sr;
    outIm[k] = si;
  }
  return { re: outRe, im: outIm };
}

/** A fake react-native-fast-opencv whose dft/split/magnitude actually compute real values. */
function makeFakeOpenCVModule() {
  const releaseCalls = [];
  const Mat = {
    createFromBuffer: (type, rows, cols, channels, buffer) => ({
      __mat: true, type, rows, cols, channels,
      data: Float64Array.from(buffer),
      release: () => releaseCalls.push('mat'),
    }),
    create: (rows, cols, dataType) => ({
      __mat: true, rows, cols, dataType, data: null,
      release: () => releaseCalls.push('mat'),
    }),
  };
  const MatVector = {
    create: () => {
      const items = [];
      return {
        __vec: true,
        push: (m) => items.push(m),
        get: (i) => items[i],
        get length() { return items.length; },
        release: () => releaseCalls.push('vec'),
      };
    },
  };
  const OpenCV = {
    Mat,
    MatVector,
    dft: (src, dst) => {
      const N = src.rows * src.cols;
      const { re, im } = naiveDft(src.data, N);
      // Interleaved real/imag, matching DFT_COMPLEX_OUTPUT's 2-channel layout.
      const interleaved = new Float64Array(N * 2);
      for (let i = 0; i < N; i++) {
        interleaved[2 * i] = re[i];
        interleaved[2 * i + 1] = im[i];
      }
      dst.rows = N; dst.cols = 1; dst.channels = 2;
      dst.data = interleaved;
    },
    split: (src, dstVector) => {
      const N = src.rows;
      const reData = new Float64Array(N);
      const imData = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        reData[i] = src.data[2 * i];
        imData[i] = src.data[2 * i + 1];
      }
      dstVector.push({ __mat: true, rows: N, cols: 1, channels: 1, data: reData, release: () => releaseCalls.push('mat') });
      dstVector.push({ __mat: true, rows: N, cols: 1, channels: 1, data: imData, release: () => releaseCalls.push('mat') });
    },
    magnitude: (x, y, out) => {
      const N = x.rows;
      const data = new Float64Array(N);
      for (let i = 0; i < N; i++) data[i] = Math.sqrt(x.data[i] ** 2 + y.data[i] ** 2);
      out.rows = N; out.cols = 1; out.channels = 1;
      out.data = data;
      out.toBuffer = (t) => {
        if (t !== 'float32') throw new Error(`unexpected toBuffer type ${t}`);
        return { cols: 1, rows: N, channels: 1, buffer: Float32Array.from(data) };
      };
    },
  };
  return {
    module: { OpenCV, DftFlags: { DFT_COMPLEX_OUTPUT: 16 }, DataTypes: { CV_32FC1: 5, CV_32FC2: 13 } },
    releaseCalls,
  };
}

/**
 * Loads fresh instances of both fft.js and nativeFft.js from the same reset
 * module registry (so nativeFft's internal `import './fft'` resolves to the
 * exact fft.js instance this helper returns — jest.isolateModules would give
 * each require() call in this file its own sandboxed registry instead, which
 * would silently desync the two and make every backend-name assertion below
 * check a stale module), with the given react-native-fast-opencv mock (or a
 * thrown error, simulating "not linked").
 */
function freshModules(mockModuleOrThrow) {
  jest.resetModules();
  jest.doMock('react-native-fast-opencv', () => {
    if (mockModuleOrThrow instanceof Error) throw mockModuleOrThrow;
    return mockModuleOrThrow;
  }, { virtual: true });
  // eslint-disable-next-line global-require
  const fft = require('../src/algorithm/fft');
  // eslint-disable-next-line global-require
  const nativeFft = require('../src/algorithm/nativeFft');
  return { fft, nativeFft };
}

describe('installNativeFft', () => {
  test('module not linked (throws at require) -> stays on JS, does not throw', () => {
    const { fft, nativeFft } = freshModules(new Error("doesn't seem to be linked"));
    const r = nativeFft.installNativeFft();
    expect(r.installed).toBe(false);
    expect(r.reason).toMatch(/threw during install/);
    expect(fft.getFftBackendName()).toBe('js');
  });

  test('OpenCV.dft missing -> stays on JS', () => {
    const { module } = makeFakeOpenCVModule();
    delete module.OpenCV.dft;
    const { fft, nativeFft } = freshModules(module);
    const r = nativeFft.installNativeFft();
    expect(r.installed).toBe(false);
    expect(r.reason).toMatch(/dft is not available/);
    expect(fft.getFftBackendName()).toBe('js');
  });

  test('happy path installs the native backend', () => {
    const { module } = makeFakeOpenCVModule();
    const { fft, nativeFft } = freshModules(module);
    const r = nativeFft.installNativeFft();
    expect(r.installed).toBe(true);
    expect(fft.getFftBackendName()).toBe('native-cv-dft');
  });

  test('result is memoised', () => {
    const { module } = makeFakeOpenCVModule();
    const { fft, nativeFft } = freshModules(module);
    nativeFft.installNativeFft();
    nativeFft.installNativeFft();
    expect(fft.getFftBackendName()).toBe('native-cv-dft');
  });
});

describe('NATIVE_FFT_BACKEND.magnitude', () => {
  test('matches fftMagnitudeJs for a power-of-two signal', () => {
    const { module, releaseCalls } = makeFakeOpenCVModule();
    const { fft, nativeFft } = freshModules(module);

    const N = 64;
    const signal = Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * 5 * i) / N) + 0.3 * i);

    const native = nativeFft.NATIVE_FFT_BACKEND.magnitude(signal);
    const js = fft.fftMagnitudeJs(signal);

    expect(native).toHaveLength(js.length);
    for (let k = 0; k < js.length; k++) {
      expect(native[k]).toBeCloseTo(js[k], 3);
    }
    // src/dst/planes(x2)/mag all released.
    expect(releaseCalls.length).toBeGreaterThanOrEqual(4);
  });

  test('pads a non-power-of-two signal the same way fftMagnitudeJs does', () => {
    const { module } = makeFakeOpenCVModule();
    const { fft, nativeFft } = freshModules(module);

    const signal = [1, 2, 3, 4, 5]; // pads to N=8
    const native = nativeFft.NATIVE_FFT_BACKEND.magnitude(signal);
    const js = fft.fftMagnitudeJs(signal);

    expect(native).toHaveLength(js.length);
    expect(native).toHaveLength(5); // N/2+1 = 8/2+1
    for (let k = 0; k < js.length; k++) {
      expect(native[k]).toBeCloseTo(js[k], 3);
    }
  });

  test('a throwing native backend degrades fftMagnitude() to JS, once', () => {
    const { module } = makeFakeOpenCVModule();
    module.OpenCV.dft = () => { throw new Error('jsi blew up'); };
    const { fft, nativeFft } = freshModules(module);

    expect(nativeFft.installNativeFft().installed).toBe(true);
    expect(fft.getFftBackendName()).toBe('native-cv-dft');

    const signal = [1, 2, 3, 4];
    const out = fft.fftMagnitude(signal);

    expect(out).toEqual(fft.fftMagnitudeJs(signal));
    expect(fft.getFftBackendName()).toBe('js');
  });
});
