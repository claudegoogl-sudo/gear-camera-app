/**
 * PAP-1696 — the native `cv::dft` backend for fftMagnitude() (./fft.js).
 *
 * Why this is safe to route through react-native-fast-opencv when preprocess
 * (PAP-1694) was not: CLAHE/Canny are heuristics with implementation-specific
 * conventions (the binding's cv::Canny scored IoU 0.437 against ours), but a
 * DFT is a single well-defined linear transform — any correct implementation
 * of it must agree with any other up to floating-point rounding. Measured
 * over 120 real corpus-derived radial-ring signals: max relative error 3.4e-14
 * at float64, 1.8e-7 at float32 (both at the format's machine-epsilon floor),
 * zero peak-bin (tooth-count-decisive) mismatches at either precision. Full
 * writeup: docs/pap1696-detect-fft-dft-parity.md, QA-confirmed on PAP-1698.
 *
 * Every production call site (gearCounter.js) samples at a fixed
 * already-power-of-two N (256, 1024 or 4096), so the pad-to-next-power-of-two
 * path below is dead in practice — kept only so this backend has the same
 * contract as fftMagnitudeJs for an arbitrary-length input.
 *
 * Wiring mirrors nativeKernels.js with one difference that matters:
 * react-native-fast-opencv throws at `require()` time (not just at use time)
 * when its native module isn't linked (Expo Go, jest, the plain-node harnesses
 * in __tests__) — see its lib/module/index.js. So the require() itself has to
 * live inside the try/catch, not just the calls that follow it.
 */
import { setFftBackend } from './fft';

let cached = null;

function loadOpenCV() {
  if (!cached) {
    // eslint-disable-next-line global-require
    const opencv = require('react-native-fast-opencv');
    cached = {
      OpenCV: opencv.OpenCV,
      DftFlags: opencv.DftFlags,
      DataTypes: opencv.DataTypes,
    };
  }
  return cached;
}

export const NATIVE_FFT_BACKEND = {
  name: 'native-cv-dft',
  magnitude(signal) {
    const { OpenCV, DftFlags, DataTypes } = loadOpenCV();

    let N = 1;
    while (N < signal.length) N <<= 1;

    const padded = new Float32Array(N);
    for (let i = 0; i < signal.length; i++) padded[i] = signal[i];

    // Nx1, single channel: OpenCV treats a Mat with either dimension 1 as a
    // 1D signal for dft's purposes.
    const src = OpenCV.Mat.createFromBuffer('float32', N, 1, 1, padded);
    // dft/split/magnitude all auto-(re)allocate their dst — these are
    // placeholders, not pre-sized outputs.
    const dst = OpenCV.Mat.create(1, 1, DataTypes.CV_32FC1);
    const planes = OpenCV.MatVector.create();
    const mag = OpenCV.Mat.create(1, 1, DataTypes.CV_32FC1);
    try {
      // DFT_COMPLEX_OUTPUT: dst becomes Nx1 CV_32FC2 (real, imag) even
      // though src is purely real — matches fftMagnitudeJs's re[]/im[] pair.
      OpenCV.dft(src, dst, DftFlags.DFT_COMPLEX_OUTPUT, 0);
      OpenCV.split(dst, planes);
      OpenCV.magnitude(planes.get(0), planes.get(1), mag);

      const { buffer } = mag.toBuffer('float32');
      // fftMagnitudeJs only returns bins 0..N/2 (a real signal's spectrum is
      // symmetric, so the upper half is redundant) — slice to match.
      const half = (N >>> 1) + 1;
      const out = new Float64Array(half);
      for (let k = 0; k < half; k++) out[k] = buffer[k];
      return out;
    } finally {
      src.release();
      dst.release();
      planes.release();
      mag.release();
    }
  },
};

let result = null;

/**
 * Install the native fft backend, once. Never throws: every failure path
 * leaves the pure-JS backend active and returns a reason for telemetry.
 *
 * @returns {{installed: boolean, backend: string, reason?: string}}
 */
export function installNativeFft() {
  if (result) return result;

  const fail = (reason) => {
    result = { installed: false, backend: 'js', reason };
    return result;
  };

  try {
    const { OpenCV } = loadOpenCV();
    if (!OpenCV || typeof OpenCV.dft !== 'function') {
      return fail('OpenCV.dft is not available on the fast-opencv binding');
    }
    setFftBackend(NATIVE_FFT_BACKEND);
    result = { installed: true, backend: NATIVE_FFT_BACKEND.name };
    return result;
  } catch (err) {
    return fail(`threw during install: ${err && err.message}`);
  }
}

/** Test seam — forget the memoised result so a test can install again. */
export function resetNativeFftForTest() {
  result = null;
  cached = null;
}
