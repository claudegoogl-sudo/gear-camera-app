/**
 * Sentry initialisation (PAP-1543 / PAP-1463).
 *
 * Replaces the legacy embedded-GitHub-PAT upload path used by
 * debugShare.js, trainingDataUpload.js, and chainringAbstainTelemetry.js.
 *
 * DSN is public and baked at build time via EXPO_PUBLIC_SENTRY_DSN.
 * Auth-token / source-map upload happens out-of-band in
 * scripts/build-debug.sh.
 *
 * Imported once at the top of mobile/index.js so init runs before the
 * React tree mounts and any util module is loaded.
 */

import * as Sentry from '@sentry/react-native';
import { BUILD_LABEL } from './buildInfo';

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN || '';

if (DSN) {
  Sentry.init({
    dsn: DSN,
    release: BUILD_LABEL,
    // Debug reports don't need perf traces — keep the free-tier quota for
    // error events + attachments.
    tracesSampleRate: 0,
    // 20 MB ceiling sits comfortably above any single photo we attach.
    maxAttachmentSize: 20 * 1024 * 1024,
    // Avoid the SDK's default global handler swallowing dev-only React errors;
    // we already surface those through the existing error boundary / Alerts.
    enableNativeCrashHandling: true,
    enableAutoSessionTracking: false,
  });
} else if (__DEV__) {
  // eslint-disable-next-line no-console
  console.warn('[Sentry] EXPO_PUBLIC_SENTRY_DSN not set — uploads will no-op.');
}

export { Sentry };
export const SENTRY_ENABLED = Boolean(DSN);
