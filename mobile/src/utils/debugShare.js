/**
 * Debug report sharing via GitHub Issues.
 *
 * Bundles the captured photo and algorithm results into a GitHub Issue so
 * the team can review detection failures asynchronously.
 */

import { Share } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { GITHUB_TOKEN, GITHUB_REPO } from '../config';
import { BUILD_LABEL } from '../buildInfo';

const ISSUES_URL = `https://api.github.com/repos/${GITHUB_REPO}/issues`;

/**
 * Upload a debug report as a GitHub Issue.
 *
 * @param {{
 *   photoPath: string|null,
 *   toothCount: number|null,
 *   confidence: number|null,
 *   gearContour: object|null,
 * }} params
 * @returns {Promise<string>} HTML URL of the created Issue.
 */
export async function shareDebugReport({ photoPath, toothCount, confidence, gearContour }) {
  const timestamp = new Date().toISOString();

  const report = {
    timestamp,
    app: 'gear-camera',
    build: BUILD_LABEL,
    result: {
      toothCount,
      confidence: confidence != null ? Math.round(confidence * 10000) / 10000 : null,
      gearContour,
    },
  };

  // No GitHub token — fall back to native share sheet with the JSON text.
  if (!GITHUB_TOKEN) {
    await Share.share({
      message: JSON.stringify(report, null, 2),
      title: 'Gear Camera Debug Report',
    });
    return null;
  }

  // Build issue body with debug report JSON.
  const reportJson = JSON.stringify(report, null, 2);
  let issueBody = `## Gear Camera Debug Report\n\n**Build:** ${BUILD_LABEL}\n**Timestamp:** ${timestamp}\n\n### Detection Result\n\n\`\`\`json\n${reportJson}\n\`\`\`\n`;

  // Attach photo as base64 if available.
  if (photoPath) {
    try {
      const cleanPath = photoPath.replace(/^file:\/\//, '');
      const base64 = await FileSystem.readAsStringAsync(cleanPath, {
        encoding: FileSystem.EncodingType.Base64,
      });
      issueBody += `\n### Photo (base64)\n\n<details>\n<summary>Expand to view raw base64</summary>\n\n\`\`\`\n${base64}\n\`\`\`\n\n</details>\n`;
    } catch (e) {
      console.warn('[DebugShare] Could not read photo:', e.message);
      issueBody += `\n### Photo\n\nCould not read photo: ${e.message}\n`;
    }
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${GITHUB_TOKEN}`,
  };

  const response = await fetch(ISSUES_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: `Debug Report — ${toothCount ?? '?'}T @ ${timestamp}`,
      body: issueBody,
      labels: ['debug-report'],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub ${response.status}: ${body}`);
  }

  const data = await response.json();
  return data.html_url;
}
