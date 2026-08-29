/**
 * PAP-1665 — updater APK matching.
 *
 * Regression: findApkUrl only accepted gear-camera-debug-*.apk assets, so
 * release builds (gear-camera-release-*.apk, e.g. b143) showed
 * "No APK available" in the in-app updater even though the APK was attached.
 */
import { findApkUrl } from '../src/utils/updateChecker';

describe('findApkUrl accepts debug and release APK assets', () => {
  it('matches debug-named assets', () => {
    const url = findApkUrl([
      { name: 'gear-camera-debug-2026-08-27.16.42-b145.apk', browser_download_url: 'u-debug' },
    ]);
    expect(url).toBe('u-debug');
  });

  it('matches release-named assets (b143 regression)', () => {
    const url = findApkUrl([
      { name: 'gear-camera-release-2026-08-23.23.57-b143.apk', browser_download_url: 'u-release' },
    ]);
    expect(url).toBe('u-release');
  });

  it('ignores non-APK assets, unknown names and missing asset lists', () => {
    expect(findApkUrl([{ name: 'checksums.txt', browser_download_url: 'u' }])).toBe('');
    expect(findApkUrl([{ name: 'gear-camera-source.tar.gz', browser_download_url: 'u' }])).toBe('');
    expect(findApkUrl([{ name: 'gear-camera-release-b143.apk.bak', browser_download_url: 'u' }])).toBe('');
    expect(findApkUrl(null)).toBe('');
    expect(findApkUrl(undefined)).toBe('');
  });
});
