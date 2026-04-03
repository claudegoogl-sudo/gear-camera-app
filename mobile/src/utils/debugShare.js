/**
 * Debug report sharing via GitHub Contents API.
 *
 * Uploads the captured photo and algorithm results to a `debug-reports/`
 * folder in the GitHub repo so the team can review detection data.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { GITHUB_TOKEN, GITHUB_REPO } from '../config';
import { BUILD_LABEL } from '../buildInfo';

const CONTENTS_URL = `https://api.github.com/repos/${GITHUB_REPO}/contents`;

function makeSlug(timestamp) {
  return timestamp.replace(/[:.]/g, '-').replace('T', '_');
}

/**
 * Verify that a file exists on GitHub after upload.
 * Fetches the file via the Contents API and checks for a 200 response.
 */
async function verifyUpload(gitPath, headers) {
  const verifyRes = await fetch(`${CONTENTS_URL}/${gitPath}`, {
    method: 'GET',
    headers,
  });
  if (!verifyRes.ok) {
    throw new Error(
      `Upload verification failed for ${gitPath}: GitHub returned ${verifyRes.status}`,
    );
  }
}

/**
 * Upload a debug report to the `debug-reports/` folder in the GitHub repo.
 *
 * @param {{
 *   photoPath: string|null,
 *   toothCount: number|null,
 *   confidence: number|null,
 *   gearContour: object|null,
 * }} params
 * @returns {Promise<string>} URL of the uploaded report file on GitHub.
 */
export async function shareDebugReport({ photoPath, toothCount, confidence, gearContour }) {
  if (!GITHUB_TOKEN) {
    throw new Error('GitHub token not configured — cannot upload debug report.');
  }

  const timestamp = new Date().toISOString();
  const slug = makeSlug(timestamp);

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

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${GITHUB_TOKEN}`,
  };

  // Upload photo if available.
  let photoGitPath = null;
  if (photoPath) {
    try {
      const cleanPath = photoPath.replace(/^file:\/\//, '');
      const base64 = await FileSystem.readAsStringAsync(cleanPath, {
        encoding: FileSystem.EncodingType.Base64,
      });
      photoGitPath = `debug-reports/${slug}_photo.jpg`;
      const photoRes = await fetch(`${CONTENTS_URL}/${photoGitPath}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: `debug-report: photo ${slug}`,
          content: base64,
        }),
      });
      if (!photoRes.ok) {
        const body = await photoRes.text();
        console.warn(`[DebugShare] Photo upload failed: ${photoRes.status} ${body}`);
        photoGitPath = null;
      } else {
        await verifyUpload(photoGitPath, headers);
      }
    } catch (e) {
      console.warn('[DebugShare] Could not read/upload/verify photo:', e.message);
      photoGitPath = null;
    }
  }

  // Add photo path reference to report if uploaded.
  if (photoGitPath) {
    report.photoFile = photoGitPath;
  }

  // Upload the JSON report.
  const reportPath = `debug-reports/${slug}_report.json`;
  const reportContent = btoa(JSON.stringify(report, null, 2));
  const reportRes = await fetch(`${CONTENTS_URL}/${reportPath}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: `debug-report: ${toothCount ?? '?'}T @ ${timestamp}`,
      content: reportContent,
    }),
  });

  if (!reportRes.ok) {
    const body = await reportRes.text();
    throw new Error(`GitHub ${reportRes.status}: ${body}`);
  }

  // Verify report file is available after upload.
  await verifyUpload(reportPath, headers);

  const data = await reportRes.json();
  return data.content.html_url;
}
