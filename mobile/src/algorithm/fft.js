/**
 * Minimal radix-2 FFT for real-valued signals.
 * Only computes the magnitude spectrum — all we need for tooth counting.
 *
 * PAP-1696 — this file is the same kind of backend seam PAP-1694 built for
 * `preprocess` (./preprocess.js): the pure-JS radix-2 DIT butterfly below is
 * the default, and ./nativeFft.js can swap in a `cv::dft`-backed one. Unlike
 * preprocess's CLAHE/Canny, the swap carries no accuracy risk — `cv::dft` and
 * this butterfly are both exact implementations of the same linear transform,
 * so they agree to float rounding by construction. See
 * docs/pap1696-detect-fft-dft-parity.md (QA-confirmed on PAP-1698) for the
 * 120-signal corpus measurement this claim rests on.
 */

/**
 * Compute |FFT| magnitudes for a real-valued signal, pure-JS radix-2 DIT.
 * The input is zero-padded to the next power of two.
 *
 * @param {number[]} signal - real-valued samples (any length)
 * @returns {Float64Array} magnitude spectrum (length = N/2 + 1)
 */
export function fftMagnitudeJs(signal) {
  // Pad to next power of two
  let N = 1;
  while (N < signal.length) N <<= 1;

  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < signal.length; i++) re[i] = signal[i];

  _fftInPlace(re, im, N);

  // Return magnitudes for frequencies 0 … N/2
  const half = (N >>> 1) + 1;
  const mag = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }
  return mag;
}

export const JS_BACKEND = { name: 'js', magnitude: fftMagnitudeJs };

let activeBackend = JS_BACKEND;

/**
 * Swap the fftMagnitude backend. Pass null/undefined to restore the pure-JS
 * default. Returns the backend that was previously active so callers (tests,
 * harnesses) can restore it.
 */
export function setFftBackend(backend) {
  const prev = activeBackend;
  activeBackend = backend || JS_BACKEND;
  return prev;
}

export function getFftBackendName() {
  return activeBackend.name;
}

/**
 * Compute |FFT| magnitudes for a real-valued signal via the active backend.
 * Falls back to the JS backend — for this call and every subsequent one — if
 * a non-default backend throws, mirroring preprocess()'s degrade-to-JS
 * contract (a native-module failure on device must not fail the capture).
 *
 * @param {number[]} signal - real-valued samples (any length)
 * @returns {Float64Array} magnitude spectrum (length = N/2 + 1)
 */
export function fftMagnitude(signal) {
  const backend = activeBackend;
  if (backend === JS_BACKEND) return JS_BACKEND.magnitude(signal);
  try {
    return backend.magnitude(signal);
  } catch (err) {
    console.warn(
      `[fftMagnitude] backend "${backend.name}" failed, falling back to JS ` +
      `for the rest of this session: ${err && err.message}`);
    activeBackend = JS_BACKEND;
    return JS_BACKEND.magnitude(signal);
  }
}

/**
 * In-place Cooley-Tukey radix-2 DIT FFT.
 * @param {Float64Array} re - real parts (length must be power of 2)
 * @param {Float64Array} im - imaginary parts
 * @param {number} N
 */
function _fftInPlace(re, im, N) {
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // Butterfly stages
  for (let size = 2; size <= N; size <<= 1) {
    const halfSize = size >>> 1;
    const angle = (-2 * Math.PI) / size;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);

    for (let i = 0; i < N; i += size) {
      let curRe = 1;
      let curIm = 0;

      for (let j = 0; j < halfSize; j++) {
        const a = i + j;
        const b = a + halfSize;

        const tRe = curRe * re[b] - curIm * im[b];
        const tIm = curRe * im[b] + curIm * re[b];

        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;

        const nextRe = curRe * wRe - curIm * wIm;
        const nextIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
        curIm = nextIm;
      }
    }
  }
}
