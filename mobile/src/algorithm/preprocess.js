/**
 * PAP-1694 — the `preprocess` stage seam.
 *
 * `countTeeth` (device) and `countTeethFromRgba` (harness) both used to inline
 * the same four calls:
 *
 *   rgbaToGray -> clahe(3.0, 8, 8) -> gaussianBlur5x5 -> cannyEdges(50, 150)
 *
 * They now both route through `preprocess()`, so an alternative backend (the
 * native OpenCV one in ./nativePreprocess, or an injected one in a host
 * harness) can be swapped in at a single point without touching the pipeline.
 *
 * The default backend is the pure-JS one and is byte-identical to the inlined
 * code it replaced — installing this seam is a no-op for behaviour.
 *
 * A backend is `{ name, run(rgba, width, height) -> { gray, enhanced, blurred,
 * edges } }`. It MUST return all four planes: `analyzeImage` consumes `gray`,
 * `enhanced` and `edges`, and `blurred` is kept because it is the documented
 * input to `edges` and the parity harness diffs it.
 */
import {
  rgbaToGray,
  clahe,
  gaussianBlur5x5,
  cannyEdges,
} from './imageUtils';

export const JS_BACKEND = {
  name: 'js',
  run(rgba, width, height) {
    const gray     = rgbaToGray(rgba, width, height);
    const enhanced = clahe(gray, width, height, 3.0, 8, 8);
    const blurred  = gaussianBlur5x5(enhanced, width, height);
    const edges    = cannyEdges(blurred, width, height, 50, 150);
    return { gray, enhanced, blurred, edges };
  },
};

let activeBackend = JS_BACKEND;

/**
 * Swap the preprocess backend.  Pass null/undefined to restore the pure-JS
 * default.  Returns the backend that was previously active so callers can
 * restore it (harnesses do this between corpus runs).
 */
export function setPreprocessBackend(backend) {
  const prev = activeBackend;
  activeBackend = backend || JS_BACKEND;
  return prev;
}

export function getPreprocessBackendName() {
  return activeBackend.name;
}

/**
 * Run the preprocess stage.  Falls back to the JS backend — for this call and
 * every subsequent one — if a non-default backend throws, so a native-module
 * failure on device degrades to the current behaviour instead of failing the
 * capture.
 */
export function preprocess(rgba, width, height) {
  const backend = activeBackend;
  if (backend === JS_BACKEND) {
    return { ...JS_BACKEND.run(rgba, width, height), backend: 'js' };
  }
  try {
    const out = backend.run(rgba, width, height);
    return { ...out, backend: backend.name };
  } catch (err) {
    console.warn(
      `[preprocess] backend "${backend.name}" failed, falling back to JS for ` +
      `the rest of this session: ${err && err.message}`);
    activeBackend = JS_BACKEND;
    return { ...JS_BACKEND.run(rgba, width, height), backend: 'js-fallback' };
  }
}
