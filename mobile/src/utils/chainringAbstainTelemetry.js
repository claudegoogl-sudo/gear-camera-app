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

// PAP-1742: module-level last-emitted guard.  The old ResultScreen mount
// effect double-fired per chainring result (re-mount / dep-transition) and
// could pair fresh store fields with the previous photo's route-params
// channels block, inflating abstain counts ~1.67x on device.  Emission now
// happens once per capture in CameraScreen (see PAP-1742 there); this guard
// is the backstop so a duplicate emit for the SAME capture result (double
// capture callback, future call site) can never reach Sentry twice.
let lastEmittedResultId = null;

/**
 * Test hook — clears the dedupe guard so jest cases are independent.
 */
export function resetChainringAbstainDedupe() {
  lastEmittedResultId = null;
}

/**
 * Build the structured payload — exported for unit testing and so debug-share
 * can attach the same object to its report JSON.
 *
 * PAP-1742: `resultId` identifies the capture this payload describes so
 * consumers can dedupe/count per photo; it is additive to schemaVersion 1.
 */
export function buildChainringAbstainPayload({ aimR, peakR, toothCount, confidence, channels, resultId }) {
  const ratio = aimR && aimR > 0 && peakR != null ? peakR / aimR : null;
  return {
    event: 'chainring-abstain',
    schemaVersion: 1,
    resultId: resultId ?? null,
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
  // PAP-1742: at most one event per capture result.  A duplicate call for
  // the same resultId is logged as suppressed (visible in logcat so the
  // backstop firing is observable) but never re-uploaded.
  const resultId = input?.resultId ?? null;
  if (resultId != null && resultId === lastEmittedResultId) {
    console.log('[Telemetry] chainring-abstain duplicate suppressed', JSON.stringify({ event: 'chainring-abstain', resultId }));
    return { deduped: true, resultId };
  }
  if (resultId != null) lastEmittedResultId = resultId;

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
