# Post-Device-Validation Playbook — D3 Pre-FFT

**Owner**: Algorithm Engineer  
**Trigger**: Device validation results received (QA or CEO delivers results)  
**Objective**: Execute appropriate follow-up based on validation outcome

---

## Decision Tree

### Scenario A: Device Validation PASSES ✅
All targets met:
- 11/13/14T accuracy ≥99% (no regressions)
- 42T/52T false detections: same or fewer
- Speed: <30ms gate overhead confirmed

**Action**:
1. ✓ No algorithm changes needed
2. QA closes PAP-1825 / PAP-1787 (device validation issues)
3. Mobile Engineer executes production release process
4. Celebrate! D3 is shipped.

**Timeline**: ~2 hours (just release process, no new work)

---

### Scenario B: Device Validation FAILS ❌
Specific failure patterns:

#### B1: Regression on Small/Mid/Large (11/13/14T)
Gate is too aggressive, breaking baseline accuracy.

**Root Cause Check**:
- Is the gate firing incorrectly on normal gears?
- Debug: Check if `fraction` calculation is off (contourRadius estimate?)
- Test: Re-run on corpus data that was passing before

**Fixes** (in order of risk/effort):
1. Loosen THRESHOLD (0.50 → 0.55) — low risk, may reduce benefit
2. Adjust contourRadius estimation — medium risk
3. Add secondary gate condition — medium risk
4. Remove gate entirely — high risk (defeats purpose)

**Process**:
- Create PAP-###: "D3 regression fix — 11/13/14T accuracy"
- QA cross-checks fix with options
- Commit to main
- Hand back to QA for device re-validation
- **Timeline**: 8-12 hours

#### B2: Dense Chainring (42T/52T) Not Improved
Gate fires but doesn't reduce false detections.

**Root Cause Check**:
- Is the pre-FFT gate actually preventing bad detections, or just skipping them?
- Debug: Log gate decision vs FFT result on failing 42T images
- Test: Check if false detections are from other predicate paths

**Fixes** (if gate is working but not helping):
1. Widen gate to catch more cases (lower THRESHOLD)
2. Add secondary pre-FFT check
3. Accept lower benefit, keep gate for speed
4. Fall back to pure abstain (confidence gate only)

**Process**:
- Create PAP-###: "D3 benefit analysis — 42T false detection rates"
- Investigate with QA
- May result in configuration change vs code change
- **Timeline**: 4-8 hours

#### B3: Speed Regression
Gate adds overhead or causes memory issues.

**Root Cause Check**:
- Are function calls expensive?
- Is Uint8Array allocation happening in hot path?
- Memory pressure?

**Fixes**:
1. Optimize innerRadius estimation (cheaper radius scan)
2. Cache results if called multiple times
3. Early-exit conditions

**Process**:
- Create PAP-###: "D3 performance tuning"
- Profile with QA
- Optimize
- **Timeline**: 4-8 hours

---

### Scenario C: Ambiguous / Mixed Results ⚠️

Some targets pass, others borderline.

**Action**: Team decision
- Can we accept partial win (e.g., 98% on 11T if 42T improves)?
- Or must we fix regressions?
- CEO makes go/no-go call on technical debt

**Process**:
- Create PAP-###: "D3 post-device review — ambiguous results"
- Post detailed metrics to issue
- QA + AE + CEO discuss tradeoffs
- **Timeline**: 2-4 hours (decision) + 4-24 hours (execution if fix needed)

---

## Preparation for Algorithm Engineer

**Before Device Results Arrive**:
1. ✓ Know the exact success criteria (see PAP-1825 / AE_SESSION_2026-09-07_D3_COMPLETE.md)
2. ✓ Have the D3 implementation ready to patch if needed (commits 11d07ed, 97ddc84)
3. ✓ Know alternative gate parameters (THRESHOLD tuning space)
4. ✓ Have corpus data ready for regression testing (training-data/)

**When Results Arrive**:
1. Ask QA: "Did we pass all three gates: accuracy/benefit/speed?"
2. If yes → stand down, release proceeds
3. If no → categorize failure (B1/B2/B3 above) → execute fix

**Communication**:
- QA posts device results to issue (PAP-1825 or similar)
- AE reads results and understands which gate(s) failed
- AE either: (a) confirms pass, or (b) creates follow-up fix issue
- Follow-up issue goes to in_review → QA for cross-check → commit → device retest

---

## Risk Assessment

**What Could Go Wrong**:
- Gate is correctly implemented but hurts 11/13/14T anyway → algorithm-level issue
- Speed measurement on device shows different overhead than desktop → profiling needed
- Edge case on particular device model → may not generalize

**Mitigation**:
- Device test includes diverse image set, not just training data
- QA runs multiple captures per size
- Speed baseline from multiple photos (not just one)

---

## Success Criteria (Recap)

✅ **Pass Definition**:
- 11T: 100% (or ≥ previous baseline)
- 13T: 100% (or ≥ previous baseline)
- 14T: 100% (or ≥ previous baseline)
- 42T/52T: Fewer false detections (compared to prior build)
- Speed: <30ms per-photo gate overhead

✅ **If All Pass**: Release immediately

❌ **If Any Fail**: Categorize → fix → retest → release

---

**Owner**: Algorithm Engineer (standing by)  
**Status**: READY (waiting for device results)
