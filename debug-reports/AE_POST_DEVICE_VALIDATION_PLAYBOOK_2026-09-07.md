# Algorithm Engineer Post-Device-Validation Playbook

**Prepared**: 2026-09-07  
**Purpose**: Guide Algorithm Engineer response to device validation results

---

## SCENARIO 1: Device Validation PASSES ✅

### What This Means
All test criteria met:
- Dense chainrings (40T+) correctly trigger abstention
- Small gears (11T/13T) proceed to FFT normally
- No false positives or regressions
- Performance within budget
- Sentry telemetry correctly tagged

### Actions

**Immediate (within 1 hour):**
1. ✅ AE reviews validation report in QA comment
2. ✅ AE confirms all metrics align with specification
3. ✅ AE posts approval comment on PAP-1782
   - Summary: "Device validation PASS confirmed. All metrics within spec."
   - Specific metrics reviewed (abstain rate ≥90%, accuracy unchanged, etc.)

**Release Path:**
1. Mobile Engineer builds production APK
2. Release checklist execution
3. Production release (no algorithm changes needed)

**Post-Release:**
1. Monitor Sentry telemetry for D3 detection rates
2. Verify dense chainring abstention rates in production
3. Document actual device behavior vs. lab predictions
4. Prepare for PAP-1535 follow-up (D-track features)

---

## SCENARIO 2: Device Validation FAILS — Threshold Tuning Needed

### What This Means
Dense chain detection threshold (0.50) needs adjustment. Example:
- Threshold too high: Missing some dense chains (false FFT attempts)
- Threshold too low: Over-abstaining on normal gears (false abstentions)

### Actions

**AE Decision Point**: Can threshold be adjusted without re-implementation?

**Path A: Simple Parameter Tuning** (< 1 hour)
1. QA provides: Which chains missed/over-abstained, innerRadius/contourRadius values
2. AE proposes new threshold with rationale
3. QA cross-checks math and proposals against device data
4. If approved: AE updates threshold in gearCounter.js (line ~2372)
5. Rebuild APK (b151a)
6. QA re-validates on device

**Path B: Algorithm Refinement** (3-4 hours)
1. QA describes pattern: Which gear sizes failed, what the innerRadius fractions were
2. AE reviews gradient+variance scoring algorithm
3. Possible fixes:
   - Adjust radial gradient weighting (currently 0.6)
   - Adjust variance weighting (currently 0.4)
   - Refine inner radius search bounds (currently 0.1 to 0.6 of contourRadius)
4. QA cross-check on algorithm change
5. Implement, rebuild, re-validate

### Threshold Tuning Checklist
- [ ] Understand QA's failure data (exact gears, their innerRadius/contourRadius values)
- [ ] Verify current threshold 0.50 logic with data
- [ ] Identify pattern: systematic bias or edge case?
- [ ] Propose new threshold with at least 2 data points supporting it
- [ ] Verify no false positives on normal gears
- [ ] Submit to QA for cross-check
- [ ] Wait for approval before rebuild
- [ ] Once approved, update line 2372 in gearCounter.js
- [ ] Commit with message: "AE: Adjust D3 threshold from 0.50 to [new value] per device data"
- [ ] Notify QA for rebuild + re-validation

### Example Threshold Adjustment
```javascript
// gearCounter.js line 2372 (current):
const THRESHOLD = 0.50;

// Updated example (if data suggests 0.45 is better):
const THRESHOLD = 0.45;

// Must add comment:
// PAP-1782 device validation refined: 0.50 → 0.45
// Rationale: Device data showed innerRadius/contourRadius = 0.48 on 50T chainring
// Previous threshold missed this; lowering catches dense at <0.45 boundary.
```

---

## SCENARIO 3: Device Validation FAILS — Edge Case Found

### What This Means
Implementation is mostly correct, but fails on specific edge case. Example:
- Very small dense chainrings (35T on small bike) over-abstaining
- Very large gears (54T+ road bike) not detected as dense
- Specific gear types (e.g., cassette vs. chainring geometry differences)

### Actions

**AE Investigation** (30 min):
1. QA provides: Exact gear that failed (tooth count, photo, expected behavior)
2. AE examines innerRadius estimation on that specific case
3. Understand: Is it a pre-FFT prediction error or a measurement error?

**Path A: Add Validation Heuristic** (< 1 hour)
```javascript
// Example: Some 35T chainrings are sparse (not dense)
// Add a minimum gear size check:

if (estimatedTeethCount > 0 && estimatedTeethCount < 40) {
  // Small gear under 40T: don't classify as dense even if fraction is low
  return { isDense: false, ... };
}
```

**Path B: Refine Gradient Scoring** (2-3 hours)
- Current: Gradient + Variance at 0.6 + 0.4 weighting
- May need: Per-radius adaptive weighting or local curvature analysis

**Path C: Multi-Point Threshold** (3-4 hours)
```javascript
// Instead of single threshold 0.50:
if (fraction < 0.40) return { isDense: true };    // Definitely dense
if (fraction > 0.65) return { isDense: false };   // Definitely not dense
// 0.40-0.65: Use secondary criterion (e.g., gradient variance, peakR analysis)
```

---

## SCENARIO 4: Device Validation FAILS — Performance Issue

### What This Means
D3 pre-FFT check is taking too long on device. Example:
- Threshold: <30ms overhead
- Actual: 80-150ms (device is much slower than desktop)

### Actions

**AE Analysis** (30 min):
1. QA provides: Actual timing on device (e.g., "estimateInnerRadius: 120ms")
2. AE profiles desktop implementation to understand bottleneck
3. Likely culprits:
   - Radial gradient scanning (8 angles × 20 radii = 160 samples)
   - Variance neighborhood computation
   - Median calculation

**Optimization Options**:

**Option 1: Reduce sampling** (< 1 hour)
```javascript
// Current: 8 angles, 20 radii
// Optimized: 4 angles, 10 radii
const angleCount = 4;  // was 8
const step = Math.max(2, Math.floor((rMax - rMin) / 10));  // was 20
```

**Option 2: Early termination** (1-2 hours)
```javascript
// If 3 consecutive angles give strong consensus,
// skip remaining angles
if (consecutiveAgreement > 2 && confidence > 0.9) {
  break;  // Don't scan all 8 angles
}
```

**Option 3: Vectorize computation** (3-4 hours)
- Use ImageData parallel processing if available
- Batch radial samples

**Approval Path**:
1. Propose optimization with rationale
2. Estimate new performance: ~15-20ms
3. QA cross-check: Does optimization change detection accuracy?
4. Implement and re-validate

---

## SCENARIO 5: Device Validation FAILS — Regression Found

### What This Means
D3 pre-FFT accidentally makes accuracy WORSE on some gears. Example:
- Small gears now mostly abstaining (false over-activation)
- Confidence of FFT results degraded

### Actions

**AE Diagnosis** (30 min):
1. QA provides: Which gears regressed, how much abstention increased
2. AE checks: Is it truly a D3 bug or a test plan issue?
   - Verification: Test b150 without D3 on same device
   - If accuracy was already bad: Not D3's fault
   - If accuracy was good: D3 caused regression

**Quick Debug**:
```javascript
// Temporarily disable D3 to verify:
// if (denseCheck.isDense) {
//   return { /* abstain */ };
// }
// If accuracy returns to normal without D3, the gate is too aggressive.
```

**If D3 is Confirmed Cause**:
1. Review innerRadius estimation on regressed gears
2. Likely issue: Threshold is catching normal gears as "dense"
3. Fix: Lower threshold AND/OR refine gradient scoring
4. Re-validate per SCENARIO 2 path

---

## SCENARIO 6: Device Validation INCOMPLETE — Hardware Issues

### What This Means
Device validation cannot be completed because of device/test setup issues:
- Device crashed during testing
- Sentry not properly configured
- Photos not clear enough to judge
- Device ran out of storage

### Actions

1. ✅ AE acknowledges constraint (not an algorithm issue)
2. ✅ AE offers to support retry when device is ready
3. ✅ Coordinate with QA/device owner on timeline

**No algorithm changes needed** unless QA discovers a legitimate defect.

---

## DECISION TREE

```
Device Validation Result?
│
├─ PASS ✅
│  └─ Action: Post approval, proceed to release
│
├─ FAIL: Threshold
│  └─ Action: Adjust threshold (SCENARIO 2), re-validate
│
├─ FAIL: Edge Case
│  └─ Action: Add validation (SCENARIO 3), re-validate
│
├─ FAIL: Performance
│  └─ Action: Optimize sampling (SCENARIO 4), re-validate
│
├─ FAIL: Regression
│  └─ Action: Debug + adjust (SCENARIO 5), re-validate
│
└─ INCOMPLETE: Hardware Issue
   └─ Action: Support retry, no algorithm changes
```

---

## GENERAL PRINCIPLES

1. **No algorithm changes without QA cross-check**
   - All threshold/logic changes require QA review before commit
   - Justified by device data, not gut feeling

2. **Iterative validation**
   - Each fix → rebuild b151b (or b151c, etc.) → re-validate
   - Don't batch multiple changes into one rebuild

3. **Keep changes minimal**
   - Prefer threshold tuning over algorithm redesign
   - If redesign needed, it's a follow-up ticket, not blocking release

4. **Document justification**
   - Every code change includes comment explaining device data that drove it
   - Example: "PAP-1782 device data: 50T chainring had fraction=0.48, threshold lowered to 0.45"

5. **Escalate early**
   - If fix takes >4 hours, propose escalation to CEO rather than burning time
   - D3 is one component; if it doesn't work, other options exist

---

## COMMUNICATION TEMPLATE

When posting results to board:

### For PASS:
```
✅ Device Validation PASSED

AE Confirmation:
- Reviewed QA results on {date}
- All validation criteria met:
  * Dense chainrings (40T+): {n}/{total} correctly abstained
  * Small gears (11T/13T): {accuracy}% accuracy, {abstain_rate}% false abstention
  * Performance: {actual_time}ms (budget {budget}ms)
  * Telemetry: methodUsed tag correctly applied

Ready for production release.
```

### For FAIL + FIX:
```
❌ Device Validation FAILED: {Issue Type}

AE Analysis:
- Issue: {What went wrong}
- Root cause: {Why it happened}
- Fix: {Proposed solution}
- Cross-check: Ready for QA review

Rebuild plan: b151a with [specific change], re-validate {day/time}
```

---

## FILES TO REFERENCE

- Implementation: `mobile/src/algorithm/gearCounter.js` (lines 2281-2460)
- Tests: `mobile/__tests__/pap1782.dense_chainring_detect.test.js`
- Plan: `DEVICE_VALIDATION_PLAN_B150.md`
- Results: Check PAP-1782 comments from QA

---

**Prepared by**: Algorithm Engineer (2026-09-07)  
**Status**: READY FOR DEVICE VALIDATION RESULTS

