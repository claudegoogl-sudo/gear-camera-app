/**
 * App configuration.
 *
 * GITHUB_TOKEN: Personal Access Token with `repo` scope.
 * Used for uploading debug reports as GitHub Issues and checking for updates.
 * Set via EXPO_PUBLIC_GITHUB_TOKEN in .env (not committed to source).
 *
 * Create a token at: https://github.com/settings/tokens/new
 * Required scope: repo
 */
export const GITHUB_TOKEN = process.env.EXPO_PUBLIC_GITHUB_TOKEN || '';
export const GITHUB_REPO = 'claudegoogl-sudo/gear-camera-app';
