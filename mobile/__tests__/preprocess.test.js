/**
 * PAP-1694 — the preprocess backend seam.
 *
 * The load-bearing property is that installing the seam changed nothing: the
 * default backend must produce exactly what the four inlined calls produced.
 * The rest covers the swap and the degrade-to-JS path, since a native-module
 * failure on device must not fail the capture.
 */
const {
  preprocess,
  setPreprocessBackend,
  getPreprocessBackendName,
  JS_BACKEND,
} = require('../src/algorithm/preprocess');
const {
  rgbaToGray, clahe, gaussianBlur5x5, cannyEdges,
} = require('../src/algorithm/imageUtils');
const {
  isNativeOpenCVAvailable, nativeOpenCVLoadError, createNativePreprocessBackend,
} = require('../src/algorithm/nativePreprocess');

// A small synthetic frame with real structure — a bright disc on a white
// field, so CLAHE and Canny both have something to act on.
function makeFrame(w, h) {
  const rgba = new Uint8Array(w * h * 4);
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = (x - cx) ** 2 + (y - cy) ** 2 < r * r;
      const v = inside ? 40 + ((x * 7 + y * 13) % 60) : 230;
      const j = (y * w + x) * 4;
      rgba[j] = v; rgba[j + 1] = v; rgba[j + 2] = v; rgba[j + 3] = 255;
    }
  }
  return rgba;
}

const W = 96, H = 72;

afterEach(() => setPreprocessBackend(null));

describe('preprocess seam', () => {
  test('defaults to the JS backend', () => {
    expect(getPreprocessBackendName()).toBe('js');
  });

  test('JS backend output is identical to the inlined four calls', () => {
    const rgba = makeFrame(W, H);
    const gray = rgbaToGray(rgba, W, H);
    const enhanced = clahe(gray, W, H, 3.0, 8, 8);
    const blurred = gaussianBlur5x5(enhanced, W, H);
    const edges = cannyEdges(blurred, W, H, 50, 150);

    const out = preprocess(rgba, W, H);
    expect(out.backend).toBe('js');
    expect(Array.from(out.gray)).toEqual(Array.from(gray));
    expect(Array.from(out.enhanced)).toEqual(Array.from(enhanced));
    expect(Array.from(out.blurred)).toEqual(Array.from(blurred));
    expect(Array.from(out.edges)).toEqual(Array.from(edges));
  });

  test('an installed backend is used and reports its name', () => {
    const marker = new Uint8Array(W * H);
    setPreprocessBackend({
      name: 'stub',
      run: () => ({ gray: marker, enhanced: marker, blurred: marker, edges: marker }),
    });
    const out = preprocess(makeFrame(W, H), W, H);
    expect(out.backend).toBe('stub');
    expect(out.gray).toBe(marker);
  });

  test('setPreprocessBackend(null) restores the JS default', () => {
    setPreprocessBackend({ name: 'stub', run: () => ({}) });
    expect(getPreprocessBackendName()).toBe('stub');
    setPreprocessBackend(null);
    expect(getPreprocessBackendName()).toBe('js');
  });

  test('a throwing backend degrades to JS for this call and stays there', () => {
    const rgba = makeFrame(W, H);
    const expected = JS_BACKEND.run(rgba, W, H);
    setPreprocessBackend({
      name: 'exploding',
      run: () => { throw new Error('native module went away'); },
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const out = preprocess(rgba, W, H);
    expect(out.backend).toBe('js-fallback');
    expect(Array.from(out.edges)).toEqual(Array.from(expected.edges));
    expect(warn).toHaveBeenCalled();

    // and the broken backend is not retried on the next photo
    expect(getPreprocessBackendName()).toBe('js');
    expect(preprocess(rgba, W, H).backend).toBe('js');
    warn.mockRestore();
  });
});

describe('native OpenCV backend', () => {
  // There is no native binary under jest, so this asserts the *absence* path:
  // importing must not throw, and the backend must decline to build rather
  // than blowing up. react-native-fast-opencv's own entry point throws at
  // import time when unlinked, which is exactly what this guards against.
  test('reports unavailable instead of throwing when unlinked', () => {
    expect(isNativeOpenCVAvailable()).toBe(false);
    expect(typeof nativeOpenCVLoadError()).toBe('string');
    expect(createNativePreprocessBackend()).toBeNull();
  });
});
