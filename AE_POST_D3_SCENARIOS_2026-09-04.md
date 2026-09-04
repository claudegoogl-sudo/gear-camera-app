# Post-D3 Algorithm Work — Scenarios & Preparation

**Date**: 2026-09-04  
**Status**: Forward planning (waiting on D3 device validation results)  
**Purpose**: Prepare algorithm engineer options for next phase based on D3 outcomes

---

## SCENARIO 1: Device Validation PASSES ✅

### Validation Results
- Dense chainrings (40+T): Consistently abstain (0 false positives)
- Small gears (11-13T): Proceed normally (0 false abstains)
- Mid/Large gears (16-28T): No regression
- Accuracy maintained: ≥89% on answered photos
- No crashes observed
- Timing improvement verified (dense captures faster via early abstain)

### Next Steps
1. **Report to Board** (CEO/Product)
   - Post results to PAP-1800 with metrics triple: (correct, abstain, confident-wrong)
   - Compare against baseline from PAP-1658
   - Recommend release of b151 as stable

2. **Product Decision** (Board)
   - Review D3 impact on Reading 2 accuracy goal (reduce confident errors)
   - Decide: Release b151 as-is, or continue XL improvements
   - If continue: Which XL path next? (See Scenario 2)

3. **Release** (Mobile Engineering)
   - Tag b151 as release candidate
   - Prepare release notes
   - Plan deployment

4. **Algorithm Engineer Capacity**
   - Now available for next accuracy improvements
   - Can work on: Large/XL refinement, speed optimization, new accuracy vectors
   - Can cross-check with QA on next algorithm changes

### Timeline
- Report: 1-2 hours after device validation complete
- Board decision: 24-48 hours (typically)
- Release: Next business day if approved

---

## SCENARIO 2: Partial Pass (Some Issues Found) ⚠️

### Possible Issues
1. **Dense chainring over-abstaining** (D3 false positive)
   - Example: Abstaining on 32T when it should count
   - Cause: `rOuter` threshold too low or cusps-count heuristic too aggressive

2. **Dense chainring under-abstaining** (D3 false negative)
   - Example: 45T passing to FFT instead of abstaining
   - Cause: Threshold too high; inner radius mismatch

3. **Small gear false abstain** (D3 bug)
   - Example: 11T abstaining when shouldn't
   - Cause: Bug in `estimateInnerRadius()` or threshold logic

4. **Performance regression** (D3 too slow)
   - Example: D3 pre-FFT gate takes >100ms
   - Cause: Inner radius calculation slow (contour extraction inefficient)

### Algorithm Engineer Response
1. **Reproduce** issue on host with corpus photos if available
2. **Root cause** analysis:
   - D3 parameter mis-calibration (most likely)
   - Edge case in heuristic (medium likelihood)
   - Fundamental threshold inadequacy (low likelihood)

3. **Fix options**:
   - **Adjust thresholds** (takes 1-2 hours)
     - Re-calibrate cusp-count gate based on measured false positives
     - Re-test on host corpus
     - Re-build APK
     - Re-submit for device validation

   - **Refine heuristic** (takes 4-6 hours)
     - Improve `estimateInnerRadius()` for problem cases
     - Add fallback logic for ambiguous cases
     - Re-test and rebuild

   - **Scope limit** (takes 1 hour)
     - Disable D3 for certain gear size ranges
     - Example: "Only abstract 50T+, skip 30-49T" if 32-40T has issues
     - Conservative but safe

4. **Resubmit**:
   - Commit fix to main
   - Build new APK
   - Re-run device validation (45-60 min)
   - Post results

### Timeline
- Root cause: 30 min
- Fix: 1-6 hours (depends on issue)
- Rebuild: 5 min
- Device re-validation: 1 hour
- Total: 2-8 hours (usually 2-3)

### AE Standby
- Monitor device validation in real-time
- Be ready for same-day resubmission if needed
- Have fix ideas prepared (see Scenario 2 sub-cases below)

---

## SCENARIO 3: Device Validation FAILS ❌

### Major Failure
- Dense chainring crashes on real hardware
- OR D3 abstains on 50% of normal gears (broken)
- OR Performance is worse on device (D3 too slow)

### Algorithm Engineer Investigation
1. **Get detailed device logs** from tester
   - Exception traces if crashes
   - Sentry events if abnormal behavior
   - Photo examples that failed

2. **Analyze root cause**:
   - Host tests pass but device fails → likely camera input format issue
   - Crashes → likely array bounds or null pointer
   - Speed regression → likely inefficient contour extraction on device

3. **Fix strategy**:
   - If format issue: Handle both jpeg and raw camera formats
   - If crashes: Add bounds checking, null guards
   - If speed: Optimize contour algorithm or pre-process
   - **Worst case**: Revert D3, return to baseline

4. **Rebuild and resubmit** OR **escalate to architecture**

### Timeline
- Investigation: 1-2 hours
- Fix: 1-4 hours (or revert: 10 min)
- Resubmit: 1 hour total

---

## SCENARIO 4: Device Validation Unavailable ⏳

### Situation
- Device still not available after 48 hours
- No path forward without hardware

### Algorithm Engineer Options
1. **Release with caveat**: Ship b151 "untested on real hardware, use at own risk"
   - Pros: Get Reading 2 changes to users
   - Cons: May have hardware-specific bugs

2. **Continue without D3**: Revert D3, release b150 as stable
   - Pros: Known-good baseline
   - Cons: No XL accuracy improvements

3. **Scale up corpus testing**: If more host photos available, re-run comprehensive audit
   - Pros: Better confidence than nothing
   - Cons: Won't catch device-specific issues

4. **Escalate device procurement**: Work with CEO to source FP5 or arrange rental

### AE Recommendation
- **Do not ship untested hardware changes to production**
- **Better**: Revert to b150 (known-good) + plan D3 for next release with hardware available
- **Or**: Ship b151 as beta/experimental build for early testers

---

## ALGORITHM ENGINEER PREPARATION

### For Scenario 1 (Passes) — Do Nothing
- Wait for board decision
- Prepare to move to next accuracy improvement

### For Scenario 2 (Issues Found) — Be Ready
**Prepare now:**
1. Load host corpus photos (if available in `training-data/`)
2. Review D3 implementation line-by-line:
   - `estimateInnerRadius()` edge cases
   - `checkDenseChainringRegime()` threshold tuning
   - Integration point error handling
3. Have alternative threshold values ready
4. Prepare reduced scope (e.g., "only 50T+") as fallback
5. Build environment ready to re-build APK in <5 min

**On device failure:**
- Get tester's problematic photo from Sentry
- Reproduce on host if possible
- Fix and re-submit same day if possible

### For Scenario 3 (Major Failure) — Escalate
- Document failure mode thoroughly
- Recommend: Revert D3 to PRE-PAP-1535 state
- Plan: D3 redesign for next release with more testing

### For Scenario 4 (No Device) — Plan B
- Coordinate with CEO on device sourcing
- Prepare b150 (pre-D3) as fallback release
- Defer D3 to next cycle when device available

---

## MEASUREMENT FRAMEWORK

### What to Measure Post-D3-Validation
**AE must ensure QA audits:**
- Triple metrics: correct, abstain, confident-wrong (per gear size)
- Both rates: correct/N and correct/answered
- Identify any regression in Small/Mid buckets
- Measure XL bucket delta (expected: fewer confident-wrong, more abstain)

### Comparison Point
- **Baseline**: PAP-1658 @ `49a7498` (58.0% overall, per-bucket breakdown)
- **Post-D3**: Whatever device validation produces

### Expected Delta (Conservative)
- Small (9-15T): ~0% change (D3 shouldn't fire here)
- Mid (16-20T): ~0-1% change (D3 precision filter only)
- Large (21-28T): ~0-2% change (possible slight gain)
- XL (29-60T): ~5-10% change (shift from confident-wrong to abstain)
  - If Reading 2: This is GOOD (fewer errors)
  - If Reading 1: This is NEUTRAL/BAD (fewer answers)

---

## CONTACTS

- **Algorithm Engineer**: 75b6a90d-1c60-4555-84df-8b185bfcac8a
- **QA Engineer**: a4117872-d796-4e43-ad79-aab12f98d646
- **Mobile Engineer**: (check project roster)
- **CEO/Product**: 8c60510e-09c2-4fcf-b000-ff2e31ed6f04

---

**Purpose**: Forward planning, not blocking work  
**Status**: Ready to execute on any of the 4 scenarios above  
**Last Updated**: 2026-09-04 19:30Z  
