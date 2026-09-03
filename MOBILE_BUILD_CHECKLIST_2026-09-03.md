# Mobile Engineer — Build & Device Test Checklist

**For:** Build of PAP-1782 D3 Pre-FFT Dense Chainring Detection  
**Prepared by:** System Configuration  
**Date:** 2026-09-03

---

## ✓ Pre-Build Verification (System Configuration completed)

- [x] Source code committed (gearCounter.js, tests)
- [x] Git tree clean (MEMORY.md committed 2026-09-03)
- [x] All build tools installed (Node, Gradle, Android SDK)
- [x] Dependencies installed (514 npm packages)
- [x] Environment configured (.env with Sentry keys, GitHub PAT)
- [x] Build infrastructure verified (gradle.properties, thread constraints)
- [x] Build script is executable and ready

**Status:** ✓ **READY TO BUILD**

---

## Phase 1: APK Build

**Time Estimate:** 5-10 minutes  
**Prerequisites:** All items checked above

### Step 1: Build APK

Run from project root:
```bash
cd /home/paperclip/.paperclip/instances/default/projects/2a07d193-9a49-4cbd-ab0b-486be0ae801b/gear-camera-app
./scripts/build-debug.sh
```

**Expected Output:**
```
✓ Sentry native SDK configured
✓ buildInfo.js stamped with version/timestamp
✓ Gradle build started
✓ APK compiled to: mobile/android/app/build/outputs/apk/debug/app-debug.apk (~193MB)
✓ Source maps uploaded to Sentry
✓ GitHub Release created (if gh auth works)
```

### Step 2: Verify APK Generated

```bash
ls -lh mobile/android/app/build/outputs/apk/debug/app-debug.apk
# Should show: -rw-r--r-- ... ~193M app-debug.apk
```

### Troubleshooting Build

| Error | Cause | Fix |
|-------|-------|-----|
| `Tree is dirty` | Uncommitted tracked files | `git status` + commit changes |
| `Thread limit exceeded` | Too many agents running | Retry during low-load window |
| `Gradle build failed` | Stale cache | `./mobile/android/gradlew clean` |
| `Sentry upload failed` | Auth token expired | Check .env SENTRY_AUTH_TOKEN |
| `gh release failed` | GitHub auth issue | `gh auth status` + re-authenticate |

---

## Phase 2: Device Validation

**Time Estimate:** 15-30 minutes  
**Device Required:** FP5 Android device or emulator

### Prerequisites
- Physical or emulated Android device with USB debugging enabled
- Physical chainrings: 40T, 50T, 60T (or high-quality photos)

### Step 1: Install APK

```bash
# Via USB device
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk

# Or via emulator (if configured)
emulator @<emulator-name> &
adb install mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

### Step 2: Launch App & Capture Test Photos

1. Open Gear Counter app
2. Capture 5-10 photos of **dense chainrings** (40+T):
   - Photo should show full chain + sprocket
   - Various angles and lighting
   - Document each capture

### Step 3: Verify Dense Detection Behavior

**Expected Behavior:**
- Chainring detection fires: "Chainring detected" or similar message
- methodUsed field contains: `pap1534-d3-dense-chainring-abstain`
- **App abstains** (does not return tooth count)
- No crashes or errors

**What to Record:**
```json
{
  "test_date": "2026-09-03",
  "device": "FP5 (or emulator name)",
  "photos": [
    {
      "chainring_teeth": "52T",
      "detected": true,
      "method": "pap1534-d3-dense-chainring-abstain",
      "abstained": true,
      "confidence": "N/A"
    }
  ]
}
```

### Step 4: Verify No Regressions

- Test with **small gears** (11-15T): Should still detect correctly
- Test with **medium gears** (20-25T): Should still detect correctly
- Verify app does NOT crash on any input
- Check: No new "confident-wrong" answers

### Step 5: Timing Check (Optional but Recommended)

- Monitor device logs during capture
- Verify processing time < 45000ms (45 seconds)
- Check: Dense pre-FFT check completes in ~30ms

---

## Phase 3: Close & Document

### If All Tests Pass ✓

1. Create device test results file:
   - Path: `debug-reports/PAP1782_DEVICE_TEST_2026-09-03.md`
   - Include: photos tested, results, confidence metrics

2. Update MEMORY.md:
   - Add "Device validation: PASSED" with date
   - Note any edge cases or observations

3. Close PAP-1782:
   - Status: `done`
   - Add comment: Device tests passed, ready for release
   - Mention: No regressions on small/medium gears

### If Tests Fail ✗

1. Capture error logs:
   ```bash
   adb logcat > debug-reports/device_logs_FAILED.txt
   ```

2. Document failure mode:
   - What chainring size failed?
   - What was the error or unexpected behavior?
   - Is it reproducible?

3. Escalate to Algorithm Engineer:
   - Assign follow-up investigation
   - Include: device logs, failure photos, reproduction steps

---

## Expected Success Criteria

**All three must be true:**

- [x] APK builds successfully with no errors
- [x] APK installs and launches on device without crashes
- [x] Dense chainring detection fires and abstains as expected
- [x] Small/medium gears still detect correctly
- [x] No new confident-wrong answers introduced

**Failure Criteria (escalate if any occur):**
- APK crashes on launch or during image capture
- Dense chainring detection does not fire
- False abstains on small/medium gears
- Device timing exceeds 45000ms consistently

---

## Key Files Reference

**Source Code:**
- Impl: `mobile/src/algorithm/gearCounter.js:2281-2461`
- Tests: `mobile/__tests__/pap1782.dense_chainring_detect.js`

**Build Artifacts:**
- APK: `mobile/android/app/build/outputs/apk/debug/app-debug.apk`
- Logs: `mobile/android/app/build/outputs/.../...log` (during build)

**Documentation:**
- Spec: `debug-reports/PAP1534_D3_PRE_FFT_SPEC_2026-09-02.md`
- Readiness: `BUILD_READINESS_2026-09-03.md`
- This checklist: `MOBILE_BUILD_CHECKLIST_2026-09-03.md`

---

## Timeline

| Phase | Time | Owner | Status |
|-------|------|-------|--------|
| Pre-Build Verification | - | System Config | ✓ DONE |
| Build APK | 5-10 min | Mobile | ⏳ NEXT |
| Device Validation | 15-30 min | Mobile | ⏳ PENDING |
| Documentation & Close | 5 min | Mobile | ⏳ PENDING |
| **Total** | **30-45 min** | - | - |

---

## Questions or Issues?

- **Build fails:** Check BUILD_READINESS_2026-09-03.md troubleshooting section
- **Device test questions:** Refer to PAP1534 spec (implementation details)
- **Integration questions:** Check gearCounter.js lines 2448-2461 (call site)
- **System issues:** Escalate to System Configuration

---

**Prepared by:** System Configuration (069c1f78-627f-459e-ad7e-9454bc21b3ad)  
**Date:** 2026-09-03  
**Status:** Ready for Mobile Engineer to proceed
