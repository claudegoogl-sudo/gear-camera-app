/**
 * Dynamic Expo config (PAP-1653).
 *
 * `app.json` stays the source of truth for all static config; Expo loads it
 * first and hands it to this function as `config`. This file exists only to
 * inject values that must be read from the environment at prebuild time —
 * specifically the Sentry DSN, which cannot live in static JSON.
 *
 * Why the Sentry plugin is wired here rather than in app.json's `plugins`:
 *
 *   - `useNativeInit` makes the plugin insert `RNSentrySDK.init(this)` into
 *     MainApplication.onCreate, so the native SDK starts before the JS bundle
 *     loads. Without it the native layer is only configured once JS reaches
 *     `Sentry.init` in src/sentry.js, leaving JVM/NDK crashes and ANRs during
 *     startup with no telemetry path.
 *
 *   - `options` is written to `mobile/sentry.options.json` at prebuild time and
 *     copied into `assets/sentry.options.json` by sentry.gradle at build time.
 *     That asset is what `RNSentrySDK.init` reads, and it is what the
 *     `assert_sentry_native_configured` guard in scripts/build-*.sh asserts on —
 *     the native counterpart to the existing JS-bundle DSN check.
 *
 * Note: adding `io.sentry.dsn` meta-data to AndroidManifest.xml — the approach
 * PAP-1653 originally proposed — does nothing here. @sentry/react-native ships
 * `io.sentry.auto-init=false` in its own manifest, so sentry-android's
 * SentryInitProvider skips auto-init regardless of any DSN meta-data.
 */

const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN || '';

module.exports = ({ config }) => ({
  ...config,
  plugins: [
    ...(config.plugins ?? []),
    [
      '@sentry/react-native/expo',
      {
        organization: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        useNativeInit: true,
        options: {
          dsn: SENTRY_DSN,
          // Kept in sync with src/sentry.js — the native SDK reads these
          // before JS runs and now OWNS native init: as of PAP-1662,
          // src/sentry.js passes `autoInitializeNativeSdk: false` in release
          // builds, so it no longer re-inits native with the JS values.
          //
          // `release`/`dist` are deliberately absent here: prebuild cannot know
          // the build number. scripts/lib/sentry-options.sh stamps them into
          // the generated mobile/sentry.options.json on every build, before
          // sentry.gradle copies it into assets/.
          tracesSampleRate: 0,
          enableAutoSessionTracking: false,
        },
      },
    ],
  ],
});
