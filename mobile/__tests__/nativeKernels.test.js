/**
 * PAP-1694 (option A) — the JS half of the native-kernel install path.
 *
 * The C++ half is proven byte-identical by pap1694.native-parity.mjs over the
 * whole corpus; what needs covering here is that every way the native side can
 * be absent or wrong leaves the pure-JS backend in charge.  A build where the
 * .so is missing must still count teeth, and a build where the .so disagrees
 * with the JS about kernel semantics must NOT be allowed to run — silently
 * producing a different edge map is exactly the failure AC5 exists to prevent.
 */
jest.mock('react-native', () => ({ NativeModules: {} }), { virtual: true });

const {
  installNativeKernels,
  resetNativeKernelsForTest,
  NATIVE_BACKEND,
  EXPECTED_SEMANTICS_VERSION,
} = require('../src/algorithm/nativeKernels');
const {
  getPreprocessBackendName,
  setPreprocessBackend,
  preprocess,
} = require('../src/algorithm/preprocess');
const { NativeModules } = require('react-native');

function fakeGlobal(version, impl) {
  globalThis.__gearKernels = {
    version,
    preprocess: impl || ((buffer, offset, w, h) => {
      const len = w * h;
      return {
        gray: new ArrayBuffer(len),
        enhanced: new ArrayBuffer(len),
        blurred: new ArrayBuffer(len),
        edges: new ArrayBuffer(len),
      };
    }),
  };
}

beforeEach(() => {
  resetNativeKernelsForTest();
  setPreprocessBackend(null);
  delete globalThis.__gearKernels;
  delete NativeModules.GearKernels;
});

afterAll(() => {
  setPreprocessBackend(null);
  delete globalThis.__gearKernels;
});

describe('installNativeKernels', () => {
  test('no native module linked -> stays on JS, does not throw', () => {
    const r = installNativeKernels();
    expect(r.installed).toBe(false);
    expect(r.reason).toMatch(/not linked/);
    expect(getPreprocessBackendName()).toBe('js');
  });

  test('install() returning false -> stays on JS', () => {
    NativeModules.GearKernels = { install: () => false };
    const r = installNativeKernels();
    expect(r.installed).toBe(false);
    expect(getPreprocessBackendName()).toBe('js');
  });

  test('install() throwing -> stays on JS', () => {
    NativeModules.GearKernels = { install: () => { throw new Error('boom'); } };
    const r = installNativeKernels();
    expect(r.installed).toBe(false);
    expect(r.reason).toMatch(/boom/);
    expect(getPreprocessBackendName()).toBe('js');
  });

  test('semantics-version mismatch is refused, not tolerated', () => {
    NativeModules.GearKernels = {
      install: () => { fakeGlobal(EXPECTED_SEMANTICS_VERSION + 1); return true; },
    };
    const r = installNativeKernels();
    expect(r.installed).toBe(false);
    expect(r.reason).toMatch(/version mismatch/);
    expect(getPreprocessBackendName()).toBe('js');
  });

  test('happy path installs the native backend', () => {
    NativeModules.GearKernels = {
      install: () => { fakeGlobal(EXPECTED_SEMANTICS_VERSION); return true; },
    };
    const r = installNativeKernels();
    expect(r.installed).toBe(true);
    expect(getPreprocessBackendName()).toBe('native-cpp');
  });

  test('already-installed global short-circuits the native module', () => {
    fakeGlobal(EXPECTED_SEMANTICS_VERSION);
    const r = installNativeKernels();
    expect(r.installed).toBe(true);
    expect(getPreprocessBackendName()).toBe('native-cpp');
  });

  test('result is memoised', () => {
    let calls = 0;
    NativeModules.GearKernels = {
      install: () => { calls++; fakeGlobal(EXPECTED_SEMANTICS_VERSION); return true; },
    };
    installNativeKernels();
    installNativeKernels();
    expect(calls).toBe(1);
  });
});

describe('NATIVE_BACKEND', () => {
  test('passes the view offset through and wraps the returned buffers', () => {
    const seen = [];
    fakeGlobal(EXPECTED_SEMANTICS_VERSION, (buffer, offset, w, h) => {
      seen.push({ byteLength: buffer.byteLength, offset, w, h });
      const len = w * h;
      const mk = (fill) => {
        const a = new Uint8Array(len).fill(fill);
        return a.buffer;
      };
      return { gray: mk(1), enhanced: mk(2), blurred: mk(3), edges: mk(4) };
    });

    const backing = new Uint8Array(8 + 2 * 3 * 4);
    const view = backing.subarray(8);
    const out = NATIVE_BACKEND.run(view, 2, 3);

    expect(seen).toEqual([{ byteLength: backing.byteLength, offset: 8, w: 2, h: 3 }]);
    expect(Array.from(out.gray)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(out.edges).toBeInstanceOf(Uint8Array);
    expect(out.edges[0]).toBe(4);
  });

  test('a throwing native backend degrades the seam to JS', () => {
    fakeGlobal(EXPECTED_SEMANTICS_VERSION, () => { throw new Error('jsi blew up'); });
    NativeModules.GearKernels = { install: () => true };
    expect(installNativeKernels().installed).toBe(true);

    const w = 8, h = 8;
    const rgba = new Uint8Array(w * h * 4).fill(120);
    const out = preprocess(rgba, w, h);

    expect(out.backend).toBe('js-fallback');
    expect(out.edges).toHaveLength(w * h);
    expect(getPreprocessBackendName()).toBe('js');
  });
});
