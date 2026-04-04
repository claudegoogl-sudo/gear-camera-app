/**
 * Update checker — GitHub Releases API integration.
 *
 * Fetches all debug releases and compares their build numbers against the
 * locally-compiled BUILD_NUMBER so the app can prompt users to upgrade.
 */

import { GITHUB_TOKEN, GITHUB_REPO } from '../config';
import { BUILD_NUMBER } from '../buildInfo';

const RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases`;

/**
 * Extract the integer build number from a release tag.
 * Tags follow patterns: "b17", "debug-build-YYYY-MM-DD-bN", or "v1.0.0-b3"
 *
 * @param {string} tag  e.g. "b17" or "debug-build-2026-04-03-b6"
 * @returns {number|null}
 */
function parseBuildNumber(tag) {
  // Match tags like "b17", "debug-build-2026-04-03-b6", or "v1.0.0-b3"
  const match = tag.match(/\bb(\d+)$/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Find the APK download URL in a release's assets.
 * Accepts both naming patterns:
 *   gear-camera-debug-bN.apk
 *   gear-camera-debug-YYYY-MM-DD*-bN.apk
 *
 * @param {Array} assets
 * @returns {string}
 */
function findApkUrl(assets) {
  const asset = (assets ?? []).find((a) => /gear-camera-debug.*\.apk$/.test(a.name));
  return asset?.browser_download_url ?? '';
}

/**
 * Fetch all available debug builds from GitHub Releases.
 *
 * @returns {Promise<Array<{ buildNumber: number, downloadUrl: string, releaseName: string, tagName: string }>>}
 */
export async function fetchAllBuilds() {
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

  const releases = await response.json();

  return releases
    .map((release) => {
      const buildNumber = parseBuildNumber(release.tag_name);
      if (buildNumber === null) return null;
      return {
        buildNumber,
        downloadUrl: findApkUrl(release.assets),
        releaseName: release.name ?? release.tag_name,
        tagName: release.tag_name,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.buildNumber - a.buildNumber);
}

/**
 * Check whether a newer debug build is available on GitHub Releases.
 *
 * @returns {Promise<{ available: boolean, latestBuild: number, downloadUrl: string, releaseName: string, allBuilds: Array }>}
 */
export async function checkForUpdate() {
  const builds = await fetchAllBuilds();

  if (builds.length === 0) {
    return { available: false, latestBuild: BUILD_NUMBER, downloadUrl: '', releaseName: '', allBuilds: [] };
  }

  const latest = builds[0];
  const newerBuilds = builds.filter((b) => b.buildNumber > BUILD_NUMBER);

  return {
    available: newerBuilds.length > 0,
    latestBuild: latest.buildNumber,
    downloadUrl: latest.downloadUrl,
    releaseName: latest.releaseName,
    allBuilds: builds,
  };
}
