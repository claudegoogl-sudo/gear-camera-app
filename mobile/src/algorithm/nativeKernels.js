/**
 * PAP-1694 (option A) — the native C++ preprocess backend.
 *
 * Why our own kernels instead of react-native-fast-opencv's primitives: that
 * binding exposes no CLAHE at all, and its `cv::Canny` is a different algorithm
 * from ours (IoU 0.437 against the JS edge map, 1.84x as many edge pixels).
 * `edges` feeds the whole detect stage, so adopting OpenCV's would be an
 * accuracy change requiring a corpus re-baseline — the thing AC5 forbids and
 * PAP-1583/PAP-1616 showed to be expensive.  See ./nativePreprocess.js for the
 * measurements and docs/pap1694-native-kernels.md for the writeup.
 *
 * So mobile/cpp/gear_kernels.cpp is a line-by-line port of the four functions
 * in ./imageUtils.js, verified byte-identical on all 431 cached corpus images
 * by __tests__/pap1694.native-parity.mjs.  Parity is a build-time invariant
 * here, not a runtime hope.
 *
 * Wiring: mobile/plugins/withGearKernelsPlugin.js compiles the C++ into
 * libgearkernels.so and registers a `GearKernels` native module whose
 * `install()` sets `globalThis.__gearKernels` via JSI.  Everything below is
 * defensive about that global being absent — Expo Go, jest, the plain-node
 * corpus harnesses and any build where the .so failed to load all have to keep
 * working on the JS backend.
 */
import { setPreprocessBackend } from './preprocess';

// Must match gearkernels::kSemanticsVersion in mobile/cpp/gear_kernels.h.
// Bumped whenever a kernel's output could change; a mismatch means the JS and
// the .so disagree about what `preprocess` means, so we refuse the native path
// rather than silently produce a different edge map.
export const EXPECTED_SEMANTICS_VERSION = 1;

export const NATIVE_BACKEND = {
  name: 'native-cpp',
  run(rgba, width, height) {
    const api = globalThis.__gearKernels;
    if (!api) throw new Error('__gearKernels is not installed');
    // The JSI side takes the backing ArrayBuffer plus the view's offset, so a
    // subarray view (which is what the aim-crop path produces) is passed
    // without a copy.
    const out = api.preprocess(rgba.buffer, rgba.byteOffset || 0, width, height);
    return {
      gray: new Uint8Array(out.gray),
      enhanced: new Uint8Array(out.enhanced),
      blurred: new Uint8Array(out.blurred),
      edges: new Uint8Array(out.edges),
    };
  },
};

let result = null;

/**
 * Install the native backend, once.  Never throws: every failure path leaves
 * the pure-JS backend active and returns a reason for the telemetry.
 *
 * @returns {{installed: boolean, backend: string, reason?: string}}
 */
export function installNativeKernels() {
  if (result) return result;

  const fail = (reason) => {
    result = { installed: false, backend: 'js', reason };
    return result;
  };

  try {
    if (!globalThis.__gearKernels) {
      // The module only exists in a native build produced with
      // withGearKernelsPlugin; asking for it elsewhere must not throw.
      // eslint-disable-next-line global-require
      const { NativeModules } = require('react-native');
      const mod = NativeModules && NativeModules.GearKernels;
      if (!mod || typeof mod.install !== 'function') {
        return fail('GearKernels native module is not linked');
      }
      if (mod.install() !== true) {
        return fail('GearKernels.install() declined (see logcat)');
      }
    }

    const api = globalThis.__gearKernels;
    if (!api || typeof api.preprocess !== 'function') {
      return fail('install() succeeded but __gearKernels.preprocess is missing');
    }
    if (api.version !== EXPECTED_SEMANTICS_VERSION) {
      return fail(
        `kernel semantics version mismatch: native=${api.version} ` +
        `js expects=${EXPECTED_SEMANTICS_VERSION}`);
    }

    setPreprocessBackend(NATIVE_BACKEND);
    result = { installed: true, backend: NATIVE_BACKEND.name };
    return result;
  } catch (err) {
    return fail(`threw during install: ${err && err.message}`);
  }
}

/** Test seam — forget the memoised result so a test can install again. */
export function resetNativeKernelsForTest() {
  result = null;
}
