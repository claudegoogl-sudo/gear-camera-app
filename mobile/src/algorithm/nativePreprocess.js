/**
 * PAP-1694 — native-OpenCV backend for the `preprocess` stage.
 *
 * Backed by react-native-fast-opencv 1.0.1 (JSI + C++, bundles
 * org.opencv:opencv:4.12.0).  JSI means no bridge serialisation: the RGBA
 * Uint8Array is copied straight into a cv::Mat in C++ and each op is a direct
 * synchronous call.
 *
 * ── Which primitives are actually ported, and why not all four ──────────────
 *
 * Measured against the current JS implementations on a 22-image sample of the
 * 900px corpus (host cv2 4.13.0 standing in for the on-device 4.12.0 — same
 * algorithms and defaults; see debug-reports/pap1694_opencv_parity.json and
 * docs/pap1694-opencv-preprocess-port.md):
 *
 *   rgbaToGray      -> cv::cvtColor(COLOR_RGBA2GRAY)   mean|Δ|=0.00, max|Δ|<1
 *                      byte-exact in practice.  PORTED.
 *   gaussianBlur5x5 -> cv::GaussianBlur((5,5), 0, BORDER_REPLICATE)
 *                      mean|Δ|=0.92, max|Δ|=2.  OpenCV picks the identical
 *                      [1,4,6,4,1]/16 kernel from its small-kernel table for
 *                      ksize=5/sigma=0, so the only difference is rounding
 *                      (OpenCV rounds, the JS truncates with `|0`).  PORTED.
 *   clahe           -> NOT AVAILABLE.  react-native-fast-opencv 1.0.1 does not
 *                      bind cv::createCLAHE or even equalizeHist (see the
 *                      dispatch table in cpp/FOCV_Function.cpp).  Stays JS.
 *   cannyEdges      -> cv::Canny is bound but is NOT equivalent: IoU with the
 *                      JS edge map is 0.437 and OpenCV emits 1.84x as many
 *                      edge pixels (3.13% vs 1.70% of the frame).  The JS
 *                      implementation caps hysteresis at 20 raster passes
 *                      (PAP-309, deliberately, for mobile cost) while OpenCV
 *                      propagates connectivity to completion, and quantises
 *                      NMS to 4 directions where OpenCV interpolates.  The
 *                      binding also hardcodes L2gradient=false (no aperture /
 *                      L2 argument is forwarded), which is the *worse*-matching
 *                      of the two variants — IoU drops to 0.312.
 *                      Stays JS by default; opt in with mode 'opencv-canny'.
 *
 * `edges` feeds the whole detect stage (centre, radius, contour and one count
 * method), so swapping in an edge map that shares 44% of its pixels with the
 * current one is an accuracy change, not an optimisation.  That is why the
 * default mode is 'safe' and why this backend is not installed unless a caller
 * asks for it.
 */

// Resolved lazily and defensively: react-native-fast-opencv's entry point runs
// `globalThis.__loadOpenCV()` at import time and throws if the native module
// is not linked, which would take down jest, the plain-node corpus harnesses
// and Expo Go alike.
let cv = null;
let loadState = 'unloaded'; // 'unloaded' | 'ready' | 'unavailable'
let loadError = null;

function loadOpenCV() {
  if (loadState !== 'unloaded') return cv;
  try {
    // eslint-disable-next-line global-require
    const mod = require('react-native-fast-opencv');
    if (!mod || !mod.OpenCV || !mod.Mat) {
      throw new Error('module loaded but OpenCV/Mat bindings are missing');
    }
    cv = mod;
    loadState = 'ready';
  } catch (err) {
    loadError = err;
    loadState = 'unavailable';
    cv = null;
  }
  return cv;
}

/** True when the native OpenCV bindings are present in this binary. */
export function isNativeOpenCVAvailable() {
  return loadOpenCV() !== null;
}

/** Why the native bindings are unavailable, or null when they are available. */
export function nativeOpenCVLoadError() {
  loadOpenCV();
  return loadError ? String(loadError.message || loadError) : null;
}

// OpenCV constants, inlined so this module does not have to import (and
// therefore load) react-native-fast-opencv just to read an enum.
const COLOR_RGBA2GRAY = 11;
const CV_8U = 0;
const BORDER_REPLICATE = 1;

/**
 * Build a preprocess backend that runs part of the stage through native
 * OpenCV.  Returns null when the native module is not linked.
 *
 * @param {object} [opts]
 * @param {'safe'|'opencv-canny'} [opts.mode='safe']
 *   'safe'          — gray + blur native, clahe + canny in JS.  Output matches
 *                     the JS pipeline to within the documented <=2 LSB blur
 *                     rounding delta.
 *   'opencv-canny'  — additionally replaces cannyEdges with cv::Canny.  Faster
 *                     but produces a materially different edge map; do not
 *                     enable without re-baselining accuracy (PAP-1658).
 */
export function createNativePreprocessBackend(opts) {
  const ocv = loadOpenCV();
  if (!ocv) return null;

  const mode = (opts && opts.mode) || 'safe';
  const { OpenCV, Mat, Size } = ocv;

  // Imported here rather than at module scope so that a bundle which never
  // installs this backend does not pull the JS primitives in twice.
  // eslint-disable-next-line global-require
  const { clahe, cannyEdges } = require('./imageUtils');

  return {
    name: `native-opencv-${mode}`,
    run(rgba, width, height) {
      const created = [];
      const track = (m) => { created.push(m); return m; };
      try {
        const src  = track(Mat.createFromBuffer('uint8', height, width, 4, rgba));
        const gray = track(Mat.create(height, width, CV_8U));
        OpenCV.cvtColor(src, gray, COLOR_RGBA2GRAY);
        const grayBuf = gray.toBuffer('uint8').buffer;

        // CLAHE has no binding in 1.0.1 — this is the JS implementation and
        // is bit-identical to the current pipeline.
        const enhanced = clahe(grayBuf, width, height, 3.0, 8, 8);

        const enhMat = track(Mat.createFromBuffer('uint8', height, width, 1, enhanced));
        const blurMat = track(Mat.create(height, width, CV_8U));
        const ksize = track(Size.create(5, 5));
        // sigmaX = sigmaY = 0 makes OpenCV derive sigma from ksize, which for
        // ksize=5 selects its small-kernel table entry [1,4,6,4,1]/16 — the
        // same kernel gaussianBlur5x5 hardcodes.  BORDER_REPLICATE matches the
        // JS clamp-to-edge; OpenCV would otherwise default to REFLECT_101.
        OpenCV.GaussianBlur(enhMat, blurMat, ksize, 0, 0, BORDER_REPLICATE);
        const blurred = blurMat.toBuffer('uint8').buffer;

        let edges;
        if (mode === 'opencv-canny') {
          const edgeMat = track(Mat.create(height, width, CV_8U));
          OpenCV.Canny(blurMat, edgeMat, 50, 150);
          edges = edgeMat.toBuffer('uint8').buffer;
        } else {
          edges = cannyEdges(blurred, width, height, 50, 150);
        }

        return { gray: grayBuf, enhanced, blurred, edges };
      } finally {
        // Mats are C++-owned; without release() they only go away when the JS
        // object is collected, which on a per-photo path is a leak worth
        // avoiding.  Releasing here is safe: Mat.toBuffer allocates a fresh JS
        // TypedArray and memcpys mat.data into it (MatDelegate.cpp, the
        // `updateUnsafe` calls), so the planes we return do not alias the Mat.
        for (const m of created) {
          try { m.release(); } catch (_) { /* already released */ }
        }
      }
    },
  };
}

/**
 * Convenience: build the backend and install it, returning the backend name on
 * success or null if the native module is unavailable.  Callers own the
 * decision — nothing in the app installs this automatically yet.
 */
export function installNativePreprocess(setPreprocessBackend, opts) {
  const backend = createNativePreprocessBackend(opts);
  if (!backend) return null;
  setPreprocessBackend(backend);
  return backend.name;
}

// Note: unused in 'safe'/'opencv-canny' but kept adjacent to the port so the
// AC4 detect work has a reference — the binding does expose dft,
// getOptimalDFTSize, mulSpectrums, magnitude, cartToPolar and warpPolar, which
// is what the radial-FFT sweep needs.
export const DETECT_STAGE_AVAILABLE_PRIMITIVES = Object.freeze([
  'dft', 'idft', 'getOptimalDFTSize', 'mulSpectrums', 'magnitude',
  'cartToPolar', 'phase', 'warpPolar', 'resize', 'minMaxLoc',
]);
