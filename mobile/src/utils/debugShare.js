/**
 * Debug report sharing via GitHub Contents API.
 *
 * Uploads the captured photo and algorithm results to a `debug-reports/`
 * folder in the GitHub repo so the team can review detection data.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { GITHUB_TOKEN, GITHUB_REPO } from '../config';
import { BUILD_LABEL } from '../buildInfo';
import { makeSlug } from './timestamp';

const CONTENTS_URL = `https://api.github.com/repos/${GITHUB_REPO}/contents`;

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
 *   actualTeethCount: number|null,
 * }} params
 * @returns {Promise<string>} URL of the uploaded report file on GitHub.
 */
export async function shareDebugReport({ photoPath, toothCount, confidence, gearContour, actualTeethCount }) {
  if (!GITHUB_TOKEN) {
    throw new Error('GitHub token not configured — cannot upload debug report.');
  }

  // Pre-flight: verify the token is still valid before uploading.
  const authCheck = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
    },
  });
  if (authCheck.status === 401 || authCheck.status === 403) {
    throw new Error(
      'GitHub token is expired or revoked — update EXPO_PUBLIC_GITHUB_TOKEN in .env.',
    );
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

  if (actualTeethCount != null) {
    report.actualTeethCount = actualTeethCount;
  }

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
      // Ensure file:// URI — expo-file-system/legacy requires it.
      const fileUri = photoPath.startsWith('file://') ? photoPath : `file://${photoPath}`;
      const fileInfo = await FileSystem.getInfoAsync(fileUri);
      if (!fileInfo.exists) {
        console.warn(`[DebugShare] Photo file not found at: ${fileUri}`);
      } else {
        console.log(`[DebugShare] Reading photo: ${fileUri} (${fileInfo.size} bytes)`);
        const base64 = await FileSystem.readAsStringAsync(fileUri, {
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
          console.warn(
            `[DebugShare] Photo upload failed (${photoRes.status}): path=${fileUri} size=${fileInfo.size} body=${body}`,
          );
          photoGitPath = null;
        } else {
          await verifyUpload(photoGitPath, headers);
        }
      }
    } catch (e) {
      console.warn(`[DebugShare] Could not read/upload/verify photo (path=${photoPath}):`, e.message);
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
    if (reportRes.status === 401 || reportRes.status === 403) {
      throw new Error('GitHub token expired or revoked — update EXPO_PUBLIC_GITHUB_TOKEN in .env.');
    }
    throw new Error(`GitHub ${reportRes.status}: ${body}`);
  }

  // Verify report file is available after upload.
  await verifyUpload(reportPath, headers);

  const data = await reportRes.json();
  return data.content.html_url;
}
