/**
 * Debug report sharing via GitHub Contents API.
 *
 * Uploads a report folder to `debug-reports/report_<timestamp>/` containing:
 *   - photo.jpg       (original uncropped photo)
 *   - cropped.jpg     (aim-circle crop sent to algorithm)
 *   - report.json     (metadata + results)
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
 *   croppedPhotoPath: string|null,
 *   toothCount: number|null,
 *   confidence: number|null,
 *   gearContour: object|null,
 *   actualTeethCount: number|null,
 *   cameraErrors: Array<{timestamp: string, message: string, deviceId: string|null, wideAngleFallback: boolean}>|null,
 *   cameraEvents: Array<object>|null,
 *   cameraHasError: boolean|null,
 *   isCameraReady: boolean|null,
 *   isFocused: boolean|null,
 *   retryKey: number|null,
 *   algorithmRuntimeMs: number|null,
 *   aimCrop: object|null,
 *   policyRetryCount: number|null,
 * }} params
 * @returns {Promise<string>} URL of the uploaded report folder on GitHub.
 */
export async function shareDebugReport({ photoPath, croppedPhotoPath, toothCount, confidence, gearContour, actualTeethCount, algorithmRuntimeMs, aimCrop, cameraErrors, cameraEvents, cameraHasError, isCameraReady, isFocused, retryKey, policyRetryCount, innerContourSuspected }) {
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
      ...(innerContourSuspected != null ? { innerContourSuspected } : {}),
    },
    ...(algorithmRuntimeMs != null ? { algorithmRuntimeMs } : {}),
    ...(aimCrop != null ? { aimCrop } : {}),
    actualTeethCount: actualTeethCount ?? toothCount,
    cameraErrors: cameraErrors ?? [],
    cameraEvents: cameraEvents ?? [],
    ...(cameraHasError != null ? { cameraHasError } : {}),
    ...(isCameraReady != null ? { isCameraReady } : {}),
    ...(isFocused != null ? { isFocused } : {}),
    ...(retryKey != null ? { retryKey } : {}),
    ...(policyRetryCount != null ? { policyRetryCount } : {}),
  };

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${GITHUB_TOKEN}`,
  };

  const folder = `debug-reports/report_${slug}`;

  // Helper: read a local photo file as base64 and upload to the folder.
  async function uploadPhoto(localPath, filename) {
    if (!localPath) return null;
    try {
      const fileUri = localPath.startsWith('file://') ? localPath : `file://${localPath}`;
      const fileInfo = await FileSystem.getInfoAsync(fileUri);
      if (!fileInfo.exists) {
        console.warn(`[DebugShare] Photo file not found at: ${fileUri}`);
        return null;
      }
      console.log(`[DebugShare] Reading ${filename}: ${fileUri} (${fileInfo.size} bytes)`);
      const base64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const gitPath = `${folder}/${filename}`;
      const res = await fetch(`${CONTENTS_URL}/${gitPath}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: `debug-report: ${filename} ${slug}`,
          content: base64,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.warn(
          `[DebugShare] ${filename} upload failed (${res.status}): path=${fileUri} size=${fileInfo.size} body=${body}`,
        );
        return null;
      }
      await verifyUpload(gitPath, headers);
      return gitPath;
    } catch (e) {
      console.warn(`[DebugShare] Could not read/upload/verify ${filename} (path=${localPath}):`, e.message);
      return null;
    }
  }

  // Upload original photo.
  const photoGitPath = await uploadPhoto(photoPath, 'photo.jpg');
  if (photoGitPath) {
    report.photoFile = photoGitPath;
  }

  // Upload cropped photo (the image sent to the algorithm).
  const croppedGitPath = await uploadPhoto(croppedPhotoPath, 'cropped.jpg');
  if (croppedGitPath) {
    report.croppedPhotoFile = croppedGitPath;
  }

  // Upload the JSON report.
  const reportPath = `${folder}/report.json`;
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
