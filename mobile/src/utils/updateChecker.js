/**
 * Update checker — GitHub Releases API integration.
 *
 * Fetches all debug releases and compares their build numbers against the
 * locally-compiled BUILD_NUMBER so the app can prompt users to upgrade.
 */

import { GITHUB_TOKEN, GITHUB_REPO } from '../config';
import { BUILD_NUMBER } from '../buildInfo';

// per_page=100 is GitHub's max for the releases listing endpoint. Without it
// the default of 30 silently truncates older builds, and any release that
// shares its tag commit with a sibling release can be dropped from the
// first-page response (observed for b104, whose tag commit equals b103's).
const RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100`;
const RELEASE_BY_TAG_URL = (tag) =>
  `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${encodeURIComponent(tag)}`;

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

function buildHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  }
  return headers;
}

function releaseToBuild(release) {
  const buildNumber = parseBuildNumber(release.tag_name);
  if (buildNumber === null) return null;
  return {
    buildNumber,
    downloadUrl: findApkUrl(release.assets),
    releaseName: release.name ?? release.tag_name,
    tagName: release.tag_name,
  };
}

/**
 * Probe newer build tags directly. The /releases listing endpoint sometimes
 * omits a freshly-published release when its tag commit is shared with an
 * earlier release (observed: b103 and b104 both pinned to the same commit
 * because the build script tags the remote HEAD that existed when the
 * upload ran). Tag lookup never has this problem, so we walk forward from
 * the highest build number we already saw and probe up to a small budget.
 */
async function probeMissingHeadBuilds(highestKnown) {
  const headers = buildHeaders();
  const found = [];
  let consecutiveMisses = 0;
  const MAX_CONSECUTIVE_MISSES = 2;
  const MAX_PROBES = 6;

  for (let i = 1; i <= MAX_PROBES; i++) {
    const candidate = highestKnown + i;
    try {
      const response = await fetch(RELEASE_BY_TAG_URL(`b${candidate}`), { headers });
      if (response.status === 404) {
        consecutiveMisses++;
        if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES) break;
        continue;
      }
      if (!response.ok) break;
      const release = await response.json();
      const build = releaseToBuild(release);
      if (build) {
        found.push(build);
        consecutiveMisses = 0;
      }
    } catch {
      break;
    }
  }

  return found;
}

/**
 * Fetch all available debug builds from GitHub Releases.
 *
 * @returns {Promise<Array<{ buildNumber: number, downloadUrl: string, releaseName: string, tagName: string }>>}
 */
export async function fetchAllBuilds() {
  const response = await fetch(RELEASES_URL, { headers: buildHeaders() });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub ${response.status}: ${body}`);
  }

  const releases = await response.json();

  const builds = releases.map(releaseToBuild).filter(Boolean);

  const highestKnown = builds.length === 0
    ? Math.max(BUILD_NUMBER, 0)
    : Math.max(BUILD_NUMBER, ...builds.map((b) => b.buildNumber));

  // Probe head-of-list for releases that the listing endpoint silently dropped.
  const probed = await probeMissingHeadBuilds(highestKnown);
  const seen = new Set(builds.map((b) => b.buildNumber));
  for (const b of probed) {
    if (!seen.has(b.buildNumber)) {
      builds.push(b);
      seen.add(b.buildNumber);
    }
  }

  return builds.sort((a, b) => b.buildNumber - a.buildNumber);
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
