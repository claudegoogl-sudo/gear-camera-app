/**
 * Training data upload via GitHub Contents API.
 *
 * Uploads captured photos and gear detection metadata to a `training-data/`
 * folder in the GitHub repo for use as CV training data.
 *
 * Runs as fire-and-forget after each capture — failures are logged but
 * never surface to the user or block the UI.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { GITHUB_TOKEN, GITHUB_REPO } from '../config';
import { BUILD_LABEL } from '../buildInfo';

const CONTENTS_URL = `https://api.github.com/repos/${GITHUB_REPO}/contents`;

const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  Authorization: `Bearer ${GITHUB_TOKEN}`,
};

function makeSlug(timestamp) {
  return timestamp.replace(/[:.]/g, '-').replace('T', '_');
}

/**
 * Upload a captured photo and its detection metadata to `training-data/`.
 *
 * @param {{
 *   photoPath: string,
 *   toothCount: number|null,
 *   confidence: number|null,
 *   gearContour: {centerX: number, centerY: number, radius: number}|null,
 * }} params
 */
export async function uploadTrainingData({ photoPath, toothCount, confidence, gearContour }) {
  if (!GITHUB_TOKEN || !photoPath) return;

  const timestamp = new Date().toISOString();
  const slug = makeSlug(timestamp);

  try {
    // Read the photo as base64.
    const cleanPath = photoPath.replace(/^file:\/\//, '');
    const base64 = await FileSystem.readAsStringAsync(cleanPath, {
      encoding: FileSystem.EncodingType.Base64,
    });

    // Check approximate file size (base64 is ~4/3 of original).
    // GitHub Contents API limit is 100 MB; reject anything over 50 MB to be safe.
    const approxBytes = (base64.length * 3) / 4;
    if (approxBytes > 50 * 1024 * 1024) {
      console.warn('[TrainingData] Photo too large, skipping upload:', approxBytes, 'bytes');
      return;
    }

    // Upload photo.
    const photoGitPath = `training-data/${slug}_photo.jpg`;
    const photoRes = await fetch(`${CONTENTS_URL}/${photoGitPath}`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: `training-data: photo ${slug}`,
        content: base64,
      }),
    });

    if (!photoRes.ok) {
      const body = await photoRes.text();
      console.warn('[TrainingData] Photo upload failed:', photoRes.status, body);
      return;
    }

    // Upload metadata JSON alongside the photo.
    const metadata = {
      timestamp,
      build: BUILD_LABEL,
      photoFile: photoGitPath,
      result: {
        toothCount,
        confidence: confidence != null ? Math.round(confidence * 10000) / 10000 : null,
        gearContour,
      },
    };

    const metaGitPath = `training-data/${slug}_meta.json`;
    const metaRes = await fetch(`${CONTENTS_URL}/${metaGitPath}`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: `training-data: meta ${toothCount ?? '?'}T @ ${timestamp}`,
        content: btoa(JSON.stringify(metadata, null, 2)),
      }),
    });

    if (!metaRes.ok) {
      const body = await metaRes.text();
      console.warn('[TrainingData] Metadata upload failed:', metaRes.status, body);
      return;
    }

    console.log('[TrainingData] Uploaded:', photoGitPath);
  } catch (e) {
    console.warn('[TrainingData] Upload error (non-fatal):', e.message);
  }
}
