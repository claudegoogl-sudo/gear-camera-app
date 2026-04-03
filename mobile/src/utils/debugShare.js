/**
 * Debug report sharing via GitHub Gist.
 *
 * Bundles the captured photo and algorithm results into a private Gist so
 * the team can review detection failures asynchronously.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { GITHUB_TOKEN } from '../config';

/**
 * Upload a debug report to GitHub Gist.
 *
 * @param {{
 *   photoPath: string|null,
 *   toothCount: number|null,
 *   confidence: number|null,
 *   gearContour: object|null,
 * }} params
 * @returns {Promise<string>} Public HTML URL of the created Gist.
 */
export async function shareDebugReport({ photoPath, toothCount, confidence, gearContour }) {
  const timestamp = new Date().toISOString();

  const report = {
    timestamp,
    app: 'gear-camera',
    result: {
      toothCount,
      confidence: confidence != null ? Math.round(confidence * 10000) / 10000 : null,
      gearContour,
    },
  };

  const files = {
    'gear_debug_report.json': {
      content: JSON.stringify(report, null, 2),
    },
  };

  // Attach photo as base64 text if available.
  if (photoPath) {
    try {
      const cleanPath = photoPath.replace(/^file:\/\//, '');
      const base64 = await FileSystem.readAsStringAsync(cleanPath, {
        encoding: FileSystem.EncodingType.Base64,
      });
      files['photo.jpg.b64'] = {
        content: base64,
      };
    } catch (e) {
      console.warn('[DebugShare] Could not read photo:', e.message);
      files['photo_error.txt'] = { content: `Could not read photo: ${e.message}` };
    }
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  if (GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  }

  const response = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      description: `Gear Camera Debug — ${toothCount ?? '?'}T @ ${timestamp}`,
      public: false,
      files,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.html_url;
}
