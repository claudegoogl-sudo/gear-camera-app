import { registerRootComponent } from 'expo';

// PAP-1543: Sentry.init() must run before any module that may call
// Sentry.captureMessage / addAttachment.  Importing the module triggers init.
import './src/sentry';

// PAP-1694: install the native C++ preprocess kernels onto the JS runtime, if
// this build has them.  Byte-identical to the JS backend by construction
// (mobile/cpp/gear_kernels.cpp is a line-by-line port, verified over the whole
// corpus), so this is a speed change only.  It is a no-op in Expo Go and on any
// build where libgearkernels.so is missing — countTeeth stays on the JS path.
import { installNativeKernels } from './src/algorithm/nativeKernels';
installNativeKernels();

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
