/**
 * Shared timestamp utilities for debug reports and training data uploads.
 */

/**
 * Convert an ISO timestamp into a filesystem-safe slug.
 * e.g. "2026-04-04T18:49:37.462Z" → "2026-04-04_18-49-37-462Z"
 */
export function makeSlug(timestamp) {
  return timestamp.replace(/[:.]/g, '-').replace('T', '_');
}
