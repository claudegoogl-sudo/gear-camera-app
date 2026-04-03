# Test Builds

Debug APK builds are versioned and timestamped. Filename format: `gear-camera-debug-YYYY-MM-DD-b<build>.apk`.
Large files (>100MB) are uploaded as GitHub Release assets; smaller ones are committed directly.

| Timestamp | File | Build | Download |
|-----------|------|-------|----------|
| 2026-04-03 19:39 | gear-camera-debug-2026-04-03 19:39-b4.apk (186MB) | b4 | local |
| 2026-04-03 18:50 | gear-camera-debug-2026-04-03 18:50-b3.apk (186MB) | b3 | local |
| 2026-04-03 18:28 | gear-camera-debug-b2.apk (186MB) | b2 | [Download](https://github.com/claudegoogl-sudo/gear-camera-app/releases/download/debug-build-2026-04-03-b2/gear-camera-debug-b2.apk) |
| 2026-04-03 | gear-camera-debug-2026-04-03.apk (184MB) — JS bundled | b0 (pre-versioning) | [Download](https://github.com/claudegoogl-sudo/gear-camera-app/releases/download/debug-build-2026-04-03/gear-camera-debug-2026-04-03.apk) |

## Build Script

Run from the repo root:

```bash
./scripts/build-debug.sh
```

This will:
1. Increment the build number in `mobile/src/buildInfo.js`
2. Run `./gradlew assembleDebug`
3. Copy the APK to `test-builds/` with a timestamped + build-numbered filename
4. Append a row to this table

## Build Method

Built with `./gradlew assembleDebug` (bare Gradle) using Android SDK at `/home/paperclip/android-sdk`.
