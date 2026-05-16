import { registerRootComponent } from 'expo';

// PAP-1543: Sentry.init() must run before any module that may call
// Sentry.captureMessage / addAttachment.  Importing the module triggers init.
import './src/sentry';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
