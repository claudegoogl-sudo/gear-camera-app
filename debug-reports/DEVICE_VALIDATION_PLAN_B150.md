# DEVICE VALIDATION PLAN — D3 Pre-FFT Dense Chainring Detection (b150)

**Build**: b150 (gear-camera-debug-2026-09-03 05:51)  
**Feature**: PAP-1534 — D3 dense chainring pre-FFT detection  
**Duration**: ~45-60 minutes  
**Requirements**: FP5 Android device with Sentry integration  

---

## VALIDATION OBJECTIVES

1. **Abstention Accuracy**: Dense chainring (40T+) detection correctly triggers pre-FFT abstention
2. **Non-Dense Pass-Through**: Small/medium gears (11T-30T) NOT flagged as dense, proceed normally to FFT
3. **Performance**: Pre-FFT gate overhead ≤30ms on real hardware
4. **Telemetry**: Sentry correctly reports `methodUsed='pap1534-d3-dense-chainring-abstain'` when abstaining
5. **No Regressions**: All previously-working gear sizes still detected correctly

---

## PRE-VALIDATION CHECKLIST

- [ ] FP5 device has Android 10+ installed
- [ ] Sentry SDK integrated and running (verify via App settings → About → Version shows Sentry DSN)
- [ ] Camera permissions granted in app
- [ ] Sufficient storage (>100MB free)
- [ ] Gear camera app b150 installed
- [ ] Physical test gears available (or high-quality test photos)

---

## TEST CASES

### GROUP A: Dense Chainrings (Expected: ABSTAIN)

| Gear | Type | Expected | Method Tag |
|------|------|----------|-----------|
| 40T | Chainring (dense) | ABSTAIN | pap1534-d3-dense-chainring-abstain |
| 50T | Chainring (dense) | ABSTAIN | pap1534-d3-dense-chainring-abstain |
| 52T | Chainring (dense) | ABSTAIN | pap1534-d3-dense-chainring-abstain |

**Instructions**:
1. Open camera, aim at 40T chainring
2. Trigger capture (auto or manual)
3. In results screen, check: `methodUsed` tag should be `pap1534-d3-dense-chainring-abstain`
4. Verify: toothCount = 0, confidence = 0 (marked as abstained, not detected)
5. Repeat for 50T and 52T

**Pass Criteria**: All 3 cases show correct abstain tag

---

### GROUP B: Small Gears (Expected: FFT DETECTION)

| Gear | Type | Expected Behavior | Method Tag |
|------|------|-------------------|-----------|
| 11T | Cassette | Detect via FFT | (any non-abstain method) |
| 13T | Cassette | Detect via FFT | (any non-abstain method) |
| 14T | Cassette | Detect via FFT | (any non-abstain method) |
| 15T | Cassette | Detect via FFT | (any non-abstain method) |

**Instructions**:
1. For each gear size, capture ~2-3 clear photos
2. In results, verify: `toothCount` matches physical gear (±1 acceptable)
3. Verify: `methodUsed` does NOT contain 'abstain'
4. All must proceed to FFT normally (no premature abstention)

**Pass Criteria**: ≥80% of captures correctly identify tooth count, zero false abstentions

---

### GROUP C: Mid-Range Gears (Expected: FFT DETECTION)

| Gear | Type | Expected |
|------|------|----------|
| 16T | Cassette | Detect (not dense) |
| 20T | Cassette | Detect (not dense) |
| 28T | Cassette | Detect (not dense) |

**Instructions**: Same as Group B  
**Pass Criteria**: ≥80% accuracy, no false abstentions

---

### GROUP D: Boundary Case (42T — Decision Boundary)

| Gear | Type | Status |
|------|------|--------|
| 42T | Chainring | Monitor (threshold = 0.50, 42T is borderline) |

**Instructions**:
1. Capture 3-4 images of 42T chainring
2. Note if abstains or proceeds to FFT
3. Either outcome is acceptable (document actual behavior)
4. If inconsistent between photos, that's a failure (threshold should be stable)

**Pass Criteria**: Consistent behavior across multiple captures

---

## TELEMETRY VERIFICATION

**In Sentry dashboard** (after validation session):

1. Navigate to `Issues` → filter by session
2. Verify events show:
   - `methodUsed='pap1534-d3-dense-chainring-abstain'` (for dense gears)
   - Various FFT methods (for small/mid gears)
   - No error/crash events

**Required Evidence**:
- Screenshots of Sentry dashboard showing successful abstain events
- Screenshot of final detection count breakdown

---

## PERFORMANCE VALIDATION

**Objective**: Confirm pre-FFT gate overhead ≤30ms

**How to measure**:
1. In debug reports (after capturing test images), check timestamps
2. Look for `preFFTGateMs` or similar timing field
3. Record 5-10 dense chainring captures, average the overhead

**Pass Criteria**: 
- 90% of dense captures: preFFTGate ≤30ms
- No captures exceed 100ms

---

## FAILURE MODES & RECOVERY

### If Dense Chainring NOT Abstaining
- **Symptom**: 52T chainring detected as 11T, confidence high
- **Cause**: Threshold may be too high (fraction > 0.50 when should be < 0.50)
- **Recovery**: AE can adjust threshold parameter (`denseChainringThreshold` in gearCounter.js:2367) and rebuild

### If Small Gears Falsely Abstaining
- **Symptom**: 11T/13T images get methodUsed='pap1534-d3-dense-chainring-abstain'
- **Cause**: Threshold may be too low (incorrectly flagging small gears)
- **Recovery**: AE adjusts threshold and rebuilds

### If Sentry Not Reporting
- **Symptom**: No telemetry in Sentry dashboard despite captures
- **Cause**: Sentry integration issue, not D3 code issue
- **Recovery**: Check app settings → Sentry DSN, reinstall app with correct DSN

---

## SUCCESS CRITERIA — DEVICE VALIDATION PASS

All of the following must be true:

✅ **Dense chainrings (40T+)**: All 3 test cases abstain correctly  
✅ **Small gears (11T-15T)**: ≥80% detection accuracy, zero false abstentions  
✅ **Mid-range (16T-28T)**: ≥80% accuracy, zero false abstentions  
✅ **Boundary (42T)**: Consistent behavior across captures  
✅ **Performance**: 90% of dense captures ≤30ms overhead  
✅ **Telemetry**: Sentry correctly reports abstain events  
✅ **No regressions**: All other gears work as before  

**Overall Pass**: 6/7 criteria met → READY FOR RELEASE

---

## DEVICE VALIDATION FAILURE RECOVERY

If validation FAILS on any criteria:

1. **Document failure clearly** (which test case, what expected vs actual)
2. **Capture debug report** from failing capture
3. **Post findings to PAP-1782** (device validation task)
4. **Algorithm Engineer adjusts parameters** (typically threshold tuning, ~30 min)
5. **Mobile Engineer rebuilds APK** (5-10 min)
6. **Re-validate on FP5** (~30 min for critical cases only)

**Timeline if failure/fix/revalidate**: +2 hours total

---

## RELEASE READINESS

**Upon passing device validation**:

1. Mobile Engineer posts "DEVICE VALIDATION PASSED" on PAP-1782
2. Build b150 is APPROVED FOR RELEASE
3. Mobile Engineer can immediately ship to production via GitHub Releases (already published)
4. QA can announce release to users

**Release does NOT require**:
- Telegram relay (bonus for notifications, not gate)
- Additional code changes (b150 is final)
- Re-testing on desktop (device validation is sufficient)

---

## CONTACTS & ESCALATION

- **Mobile Engineer** (dcfaeb39): Build/rebuild support, Sentry configuration
- **Algorithm Engineer** (75b6a90d): Threshold parameter adjustment if needed
- **QA Engineer** (a4117872): Device access coordinator, final sign-off

**If stuck**: Comment on PAP-1782 or contact Mobile Engineer directly

---

**Plan created**: 2026-09-06  
**Validation target**: b150 APK  
**Expected completion**: Within 1 hour of FP5 device access
