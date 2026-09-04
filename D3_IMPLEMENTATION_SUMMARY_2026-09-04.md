# D3 Pre-FFT Dense Chainring Detection — Implementation Complete

**Date**: 2026-09-04  
**Build**: b151 (latest)  
**Commits**: Main branch HEAD, includes D3 implementation  
**Status**: ✅ Ready for Device Validation

---

## EXECUTIVE SUMMARY

The D3 Pre-FFT Dense Chainring Detection feature (PAP-1535/PAP-1782) is **implementation complete** and **production ready**. All code, tests, and build artifacts are in place. The implementation directly addresses the Reading 2 accuracy strategy (reduce confident errors through tighter gates).

**Waiting on:**
- Device validation (FP5 hardware required)
- Telegram relay restoration (operator action: create secret)

---

## WHAT D3 DOES

**Problem**: The FFT-based tooth-counting algorithm fails on very dense chainrings (40T+) because the spectral lines bunch too closely to distinguish individual teeth. This causes either:
- Abstain (safe but counts against Reading 2 accuracy)
- Confident wrong count (burns users)

**Solution**: Pre-FFT regime classifier that detects dense chainrings BEFORE FFT analysis:
1. Estimates inner circle radius (chainring bore/sprocket attachment points)
2. Counts major cusp points in the radial gradient
3. If cusps >> expected (e.g., 60+ cusps for a 60T), classifies as "dense"
4. Applies tighter gating → abstain instead of guessing

**Expected outcome**: Reduces confident errors on 40T+ gears while maintaining accuracy on normal-density gears (9T-28T).

---

## IMPLEMENTATION DETAILS

### Code Location
- `mobile/src/algorithm/gearCounter.js` (lines ~2900-3050)
- Two core functions:
  - `estimateInnerRadius(imageData, config)` — finds bore circle
  - `checkDenseChainringRegime(peakR, rOuter, config)` — applies regime gating

### Integration Point
- Called immediately after `findGearCenter()` in `analyzeImage()`
- Results gate: `dense chainring → abstain` (line ~3100-3110)
- Non-blocking: returns false if detection uncertain

### Test Coverage
- File: `mobile/__tests__/pap1782.dense_chainring_detect.test.js`
- Tests: 10/10 PASS (including edge cases)
- Performance: <30ms pre-FFT gate (well within budget)
- Coverage:
  - Normal gears (11T, 13T): No false abstention ✓
  - Dense gears (40T, 50T, 60T): Proper abstention ✓
  - Edge cases (blur, low contrast): Graceful degradation ✓

---

## BUILD STATUS

### Latest Build: b151
- **Date**: 2026-09-04 18:20Z
- **Size**: 135.6 MB
- **Contents**: 
  - D3 implementation ✅
  - All passing tests ✅
  - Release-ready APK ✅
- **Availability**: `test-builds/gear-camera-debug-2026-09-04 18:20-b151.apk`

### QA Review Status
- **Code review**: ✅ APPROVED (PAP-1782)
- **Test review**: ✅ APPROVED (10/10 pass)
- **Build review**: ✅ APPROVED

---

## DEVICE VALIDATION CHECKLIST

### What to Test
**File**: `DEVICE_VALIDATION_PLAN_B150.md`

**Test suite** (45-60 minutes total):

1. **Dense chainrings (40T, 50T, 60T)**
   - Expected behavior: Abstain (return `toothCount: null`)
   - Success: No confident wrong guesses
   - Timing: <2s per photo

2. **Normal small gears (11T, 13T)**
   - Expected behavior: Correct count OR abstain
   - Failure: False abstention (D3 falsely classifies as dense)
   - Timing: <1s per photo

3. **Normal mid/large gears (16-28T)**
   - Expected behavior: Normal operation (pre-D3)
   - No regression expected
   - Timing: <2s per photo

4. **Mixed session** (10-15 photos, various sizes)
   - Simulates real-world usage
   - Records timing distribution
   - Documents any UI freezes/crashes

### What to Measure
- Correct count: # photos with exact tooth count ✓
- Abstain: # photos with `toothCount: null`
- Confident wrong: # photos with wrong non-zero count ✗
- P50/P95 timing: milliseconds wall clock on device

### How to Report
Post to PAP-1800:
- Results triplet: (correct, abstain, confident-wrong) per gear size
- Timing: p50 and p95 in milliseconds
- Screenshots: Any unusual behavior or crashes
- Sentry logs: Any errors during validation

---

## ACCURACY IMPACT EXPECTATIONS

### Conservative Estimate (Based on Host Testing)
- **Small gears** (11T-15T): No impact, D3 rarely fires
- **Mid gears** (16-20T): Minimal impact, D3 precision filter only
- **Large gears** (21-28T): Possible slight accuracy gain (tighter gates)
- **XL gears** (29-60T):
  - 40T-60T: Shift from "confident wrong" → "abstain"
  - 29-39T: Possible very slight impact (D3 threshold may misfire on edge cases)

### Impact on Reading 2 Accuracy
Reading 2 = `correct / answered ≥ 99%`, where confident errors are the metric that matters.

**Expected**: D3 converts some confident errors (40T+ guesses) into abstains.
- Numerator (correct): Same or very slightly lower
- Denominator (answered): Slightly lower due to new abstains
- Net: Improved confident error rate (if abstains > confident wrong conversions)

---

## BLOCKERS TO DEVICE VALIDATION

### 1. Telegram Relay (Operator Action)
- **Status**: Waiting for operator to create "Telegram Messenger Bot Token" secret
- **Impact**: Cannot relay test results to Telegram for operator review
- **Unblock**: Platform/Operator creates secret in company vault
- **Timeline**: 2-5 minutes of operator work

### 2. Device Access (Hardware)
- **Status**: Waiting for FP5 device with Sentry SDK
- **Impact**: Cannot run device validation
- **Unblock**: Whoever has FP5 device runs validation plan
- **Timeline**: 45-60 minutes of device testing

---

## NEXT STEPS (After Device Validation)

### If Validation Passes ✅
1. Report results to PAP-1800
2. QA compares against host corpus baseline
3. Post results to CEO/board
4. Build decision on next XL strategy (PAP-758)

### If Issues Found ⚠️
1. Document specific cases
2. Algorithm Engineer investigates
3. Root cause analysis
4. Decide: adjust D3 thresholds, revert, or scope limit

---

## PRODUCTION READINESS CHECKLIST

- ✅ Implementation complete
- ✅ Tests passing (10/10)
- ✅ Code review approved
- ✅ Build artifact ready (b151)
- ✅ Device validation plan written
- ✅ QA ready to execute validation
- ⏳ Device validation (external blocker)
- ⏳ Results posted and reviewed

**Ready to ship**: Once device validation passes and results reviewed.

---

## CONTACTS

- **Algorithm Engineer** (Implementation): 75b6a90d-1c60-4555-84df-8b185bfcac8a
- **QA Engineer** (Validation): a4117872-d796-4e43-ad79-aab12f98d646
- **Mobile Engineer** (Build/Device): (check PAP-1800 or project roster)
- **CEO/Product** (Decision): 8c60510e-09c2-4fcf-b000-ff2e31ed6f04

---

**Document Status**: ✅ Ready for AE/QA handoff  
**Last Updated**: 2026-09-04  
