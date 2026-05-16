/**
 * PAP-1536: chainring (30–60T) abstain telemetry.
 *
 * Emits a structured event each time the v1 UX shows the "Chainring not
 * supported" screen.  Used to size v2 chainring demand and to validate the
 * AC1 ≥ 90% trigger rate against the 80 chainring training photos.
 *
 * Pipeline mirrors `trainingDataUpload`: fire-and-forget POST to a
 * `telemetry-data/chainring-abstain/` folder via the GitHub Contents API.
 * Failures never surface to the user or block UI.  Console logging always
 * fires so the event is captured in the local debug-share JSON even when
 * the GitHub token is absent / expired.
 */

import { GITHUB_TOKEN, GITHUB_REPO } from '../config';
import { BUILD_LABEL } from '../buildInfo';
import { makeSlug } from './timestamp';

const CONTENTS_URL = `https://api.github.com/repos/${GITHUB_REPO}/contents`;

const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  Authorization: `Bearer ${GITHUB_TOKEN}`,
};

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

  if (!GITHUB_TOKEN) return payload;

  const slug = makeSlug(payload.timestamp);
  const gitPath = `telemetry-data/chainring-abstain/${slug}.json`;
  // Wrap in async IIFE so failures stay non-fatal and don't bubble up to
  // the React render path that called us.
  (async () => {
    try {
      const res = await fetch(`${CONTENTS_URL}/${gitPath}`, {
        method: 'PUT',
        headers: HEADERS,
        body: JSON.stringify({
          message: `telemetry: chainring-abstain ${slug}`,
          content: btoa(JSON.stringify(payload, null, 2)),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.warn('[Telemetry] chainring-abstain upload failed:', res.status, body);
      }
    } catch (e) {
      console.warn('[Telemetry] chainring-abstain upload error (non-fatal):', e.message);
    }
  })();

  return payload;
}
