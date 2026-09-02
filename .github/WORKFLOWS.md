# CI/CD Setup — GitHub Actions

## Workflows

### 1. CI Workflow (.github/workflows/ci.yml)
**Trigger:** Push to main/develop, Pull Requests

**Steps:**
1. Checkout code
2. Setup Node.js 18.x
3. Install dependencies (npm ci)
4. Run tests (npm test)
5. Run linter (npm run lint, optional)

**Status:** ✓ Automated testing on all commits and PRs

### 2. Build Workflow (.github/workflows/build.yml)
**Trigger:** Manual workflow dispatch (GitHub UI)

**Parameters:**
- `build_type`: Choose "debug" or "release"

**Steps:**
1. Checkout code
2. Setup JDK 11 (for Gradle/Android builds)
3. Setup Node.js 18.x
4. Install dependencies
5. Run build script (./scripts/build-debug.sh or ./scripts/build-release.sh)
6. Upload APK artifacts (30-day retention)

**Status:** ✓ Manual APK building with artifact storage

## How to Use

### Run Tests on Every Push
✓ Automatic - no configuration needed

### Manually Build APK
1. Go to GitHub repo → Actions tab
2. Select "Build & Release APK" workflow
3. Click "Run workflow"
4. Choose build type (debug/release)
5. Click green "Run workflow" button
6. Wait for job to complete
7. Download APK from artifacts

## Requirements Met
- ✓ Automated testing on commits
- ✓ Manual APK builds with artifact storage
- ✓ Sentry integration (via existing scripts, requires SENTRY_AUTH_TOKEN secret)
- ✓ GitHub release publishing (via existing scripts, requires GITHUB_TOKEN)

## Next Steps (Optional Enhancements)
- [ ] Add GitHub secret configuration guide
- [ ] Add linter/prettier configuration
- [ ] Add automated release creation on version bumps
- [ ] Add Android emulator tests
- [ ] Add code coverage reporting

## Notes
- Build scripts require operator-side secrets (GITHUB_TOKEN, SENTRY_AUTH_TOKEN)
- See scripts/build-debug.sh and scripts/build-release.sh for environment variables
- APK artifacts retained for 30 days
