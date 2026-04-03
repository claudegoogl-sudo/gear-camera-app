/**
 * Update checker — GitHub Releases API integration.
 *
 * Fetches the latest debug release and compares its build number against the
 * locally-compiled BUILD_NUMBER so the app can prompt users to upgrade.
 */

import { GITHUB_TOKEN } from '../config';
import { BUILD_NUMBER } from '../buildInfo';

const RELEASES_URL =
  'https://api.github.com/repos/claudegoogl-sudo/gear-camera-app/releases/latest';

/**
 * Extract the integer build number from a release tag.
 * Tags follow the pattern: debug-build-YYYY-MM-DD-bN
 *
 * @param {string} tag  e.g. "debug-build-2026-04-03-b6"
 * @returns {number|null}
 */
function parseBuildNumber(tag) {
  const match = tag.match(/-b(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Check whether a newer debug build is available on GitHub Releases.
 *
 * @returns {Promise<{ available: boolean, latestBuild: number, downloadUrl: string, releaseName: string }>}
 */
export async function checkForUpdate() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  if (GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  }

  const response = await fetch(RELEASES_URL, { headers });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub ${response.status}: ${body}`);
  }

  const release = await response.json();

  const latestBuild = parseBuildNumber(release.tag_name);
  if (latestBuild === null) {
    throw new Error(`Unrecognised release tag format: ${release.tag_name}`);
  }

  const apkAsset = (release.assets ?? []).find((a) =>
    /^gear-camera-debug-b\d+\.apk$/.test(a.name)
  );

  return {
    available: latestBuild > BUILD_NUMBER,
    latestBuild,
    downloadUrl: apkAsset?.browser_download_url ?? '',
    releaseName: release.name ?? release.tag_name,
  };
}
