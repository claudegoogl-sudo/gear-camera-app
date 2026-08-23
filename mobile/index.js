import { registerRootComponent } from 'expo';

// PAP-1543: Sentry.init() must run before any module that may call
// Sentry.captureMessage / addAttachment.  Importing the module triggers init.
import { Sentry } from './src/sentry';

// PAP-1694: install the native C++ preprocess kernels onto the JS runtime, if
// this build has them.  Byte-identical to the JS backend by construction
// (mobile/cpp/gear_kernels.cpp is a line-by-line port, verified over the whole
// corpus), so this is a speed change only.  It is a no-op in Expo Go and on any
// build where libgearkernels.so is missing — countTeeth stays on the JS path.
import { installNativeKernels } from './src/algorithm/nativeKernels';
reportNativeKernelInstall(installNativeKernels());

// PAP-1696: install the native `cv::dft` backend for fftMagnitude(), if this
// build has react-native-fast-opencv linked. Unlike the kernels above, this
// swap carries no accuracy risk (docs/pap1696-detect-fft-dft-parity.md,
// QA-confirmed on PAP-1698) — it is a speed change only, and installNativeFft
// never throws: a build without the binding stays on the JS FFT.
import { installNativeFft } from './src/algorithm/nativeFft';
reportNativeFftInstall(installNativeFft());

function reportNativeFftInstall(r) {
  try {
    Sentry.setTag('fft_backend', r.backend);
    Sentry.addBreadcrumb({
      category: 'algo.nativeFft',
      level: r.installed ? 'info' : 'warning',
      message: r.installed
        ? 'native cv::dft fft backend installed'
        : `native fft backend unavailable — staying on JS: ${r.reason}`,
      data: { backend: r.backend, reason: r.reason ?? null },
    });
  } catch {
    // no-op: Sentry may be uninitialised (no DSN) or absent (Expo Go).
  }
}

// PAP-1700 (QA fast-follow): the downgrade above is deliberately silent so a
// build without the .so still counts teeth — but silent on the device meant
// silent in the telemetry too, and `stageMs.preprocessBackend === 'js'` alone
// never says *why*.  A tag makes the backend a queryable dimension over all
// events (so AC3's device numbers can be split by backend without opening each
// report), and the breadcrumb carries the reason string on any event that
// follows.  Wrapped because telemetry must never be the thing that stops the
// app from starting.
function reportNativeKernelInstall(r) {
  try {
    Sentry.setTag('preprocess_backend', r.backend);
    Sentry.addBreadcrumb({
      category: 'algo.nativeKernels',
      level: r.installed ? 'info' : 'warning',
      message: r.installed
        ? 'native C++ preprocess kernels installed'
        : `native preprocess kernels unavailable — staying on JS: ${r.reason}`,
      data: { backend: r.backend, reason: r.reason ?? null },
    });
  } catch {
    // no-op: Sentry may be uninitialised (no DSN) or absent (Expo Go).
  }
}

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
