/**
 * PAP-1536: chainring (30–60T) abstain telemetry.
 *
 * Emits a structured event each time the v1 UX shows the "Chainring not
 * supported" screen.  Used to size v2 chainring demand and to validate the
 * AC1 ≥ 90% trigger rate against the 80 chainring training photos.
 *
 * PAP-1543: pipeline migrated from GitHub Contents API → Sentry.
 * Console logging always fires so the event is also captured in the local
 * debug-share JSON / adb logcat even when Sentry is disabled.
 */

import { Sentry, SENTRY_ENABLED } from '../sentry';
import { BUILD_LABEL } from '../buildInfo';

/**
 * Build the structured payload — exported for unit testing and so debug-share
 * can attach the same object to its report JSON.
 */
export function buildChainringAbstainPayload({ aimR, peakR, toothCount, confidence, channels }) {
  const ratio = aimR && aimR > 0 && peakR != null ? peakR / aimR : null;
  return {
    event: 'chainring-abstain',
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    build: BUILD_LABEL,
    regime: 'chainring',
    aimCirclePrior: {
      aimR: aimR ?? null,
      peakR: peakR ?? null,
      ratio: ratio != null ? Math.round(ratio * 10000) / 10000 : null,
    },
    detection: {
      toothCount: toothCount ?? null,
      confidence: confidence != null ? Math.round(confidence * 10000) / 10000 : null,
      channels: channels ?? null,
    },
  };
}

/**
 * Fire-and-forget chainring abstain telemetry upload.  Returns the payload
 * so callers can include it in local debug reports regardless of upload
 * outcome.
 */
export function emitChainringAbstainTelemetry(input) {
  const payload = buildChainringAbstainPayload(input);
  // Structured console log is the primary capture channel — picked up by
  // debug-share and visible in `adb logcat` for ad-hoc validation.
  console.log('[Telemetry] chainring-abstain', JSON.stringify(payload));

  if (!SENTRY_ENABLED) return payload;

  try {
    Sentry.withScope((scope) => {
      scope.setTags({
        kind: 'chainring_abstain',
        buildLabel: BUILD_LABEL,
        regime: 'chainring',
      });
      scope.setContext('chainring_abstain', payload);
      Sentry.captureMessage('chainring_abstain', 'info');
    });
  } catch (e) {
    console.warn('[Telemetry] chainring-abstain upload error (non-fatal):', e.message);
  }

  return payload;
}
