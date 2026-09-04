# Device Validation Plan: b150 D3 Pre-FFT Implementation

**Build**: b150  
**Feature**: PAP-1535 D3 Pre-FFT Dense Chainring Detection  
**Status**: Code-complete, Ready for device validation  
**Hardware Required**: FP5 with Sentry access  

---

## Test Objective

Verify that D3 pre-FFT dense chainring detection works correctly on real FP5 hardware with production camera output (JPEG-compressed images).

## Test Setup

1. **Install APK**
   - Release: https://github.com/claudegoogl-sudo/gear-camera-app/releases/tag/b150
   - Size: ~135 MB
   - Clear app data before first install: `adb shell pm clear com.example.gearapp` (or equivalent)

2. **Verify Sentry Connection**
   - Open app → Settings → About
   - Confirm Sentry integration is active (check logs)
   - Device model should appear in Sentry dashboard

3. **Test Data**
   - Prepare test photos: chainrings in sizes 40T, 50T, 60T (dense chainrings)
   - Prepare test photos: small gears 11T, 13T (should NOT trigger abstain)
   - Prepare test photos: mid gears 16-28T (should proceed normally)
   - Lighting: Various (bright, dim, shadows)

## Validation Checklist

### Phase 1: Dense Chainring Detection (40T, 50T, 60T)
- [ ] Capture 3-5 photos of 40T chainring
- [ ] Verify in Sentry: `methodUsed === 'pap1534-d3-dense-chainring-abstain'`
- [ ] Verify: No counting error (accuracy shown as abstained, not wrong count)
- [ ] Repeat for 50T and 60T

**Expected Result**: All dense chainring photos show abstain, not false detections

### Phase 2: Small Gear Non-Detection (11T, 13T)
- [ ] Capture 3 photos of 11T lockring
- [ ] Verify in Sentry: `methodUsed !== 'pap1534-d3-dense-chainring-abstain'`
- [ ] Verify: Proceed to FFT normally
- [ ] Repeat for 13T

**Expected Result**: Small gears NOT triggering abstain (avoid false positive)

### Phase 3: Mid-Range Normal Detection (16-28T)
- [ ] Capture 2-3 photos of 18T, 24T chainrings
- [ ] Verify: Proceed to FFT (methodUsed should be standard FFT-based result)
- [ ] Verify: Accuracy remains ≥89% on answered photos

**Expected Result**: Mid-range gears proceed through normal FFT pipeline

### Phase 4: Timing Validation
- [ ] Monitor Sentry for `stageMs` metric
- [ ] Compare dense chainring captures vs small/mid gears
- [ ] Verify: Dense chainring captures faster due to early abstain

**Expected Result**: Dense chainring abstain captures ~200-300ms faster than FFT

### Phase 5: Error Handling
- [ ] Test with overexposed photo (blown-out highlights)
- [ ] Test with underexposed photo (dark/noisy)
- [ ] Test with rotated/misaligned chainring
- [ ] Verify: No crashes, graceful fallback to FFT or error state

**Expected Result**: Robust handling, no ANRs, no crashes

## Pass Criteria

✅ **PASS if**:
- Dense chainrings (40+T) consistently show abstain (0 false detections)
- Small gears (11-13T) proceed normally (0 false abstains)
- Mid gears (16-28T) maintain ≥89% accuracy
- No crashes or ANRs observed
- Timing improvements verified on Sentry

❌ **FAIL if**:
- Dense chainring false positive abstain rate > 5%
- Small gear false negative abstain rate > 0% (all should proceed)
- Accuracy regresses below 89%
- Any crashes or ANRs
- Timing doesn't improve (indicates gate isn't firing)

## Sentry Monitoring

Post-test, check Sentry dashboard for:
1. Release: `v1.0.0 (150)`
2. Filter: Events from this test session
3. Verify: `methodUsed` tags are present
4. Check: `innerRadiusRatio` values (should be <0.50 for dense chains)

## Reporting

Post results as comment on device validation task with:
- Number of photos tested per category
- Pass/fail status for each validation phase
- Notable observations or edge cases
- Sentry event samples (if any failures)
- Recommendation: Ship b150 or request fixes

---

**Estimated Duration**: 45-60 minutes with device and photos available  
**Last Updated**: 2026-09-04  
**Assigned To**: Person with FP5 hardware access  

