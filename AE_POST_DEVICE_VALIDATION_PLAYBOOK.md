# Algorithm Engineer Post-Device-Validation Playbook

**Purpose**: Prepare AE for all possible outcomes of device validation (PAP-1800)

---

## SCENARIO 1: Device Validation PASSES ✅

### Expected Outcome
- Dense chains (40+T): Abstain fires correctly (≥90%)
- Small gears (11-13T): Proceed normally (0% false abstentions)
- Mid gears (16-28T): Maintain ≥89% accuracy
- No crashes or errors
- Timing improvements measured on Sentry

### AE Actions
1. **Monitor Sentry** - Track abstain rates post-release
   - Watch for: Abstain rate drift over first 100 users
   - Alert if: Abstain < 85% or > 95% on dense chains
   - Timeline: First 24 hours post-release

2. **Approve for Production**
   - Post comment on PAP-1800: "Device validation passed, approved for production release"
   - Notify Product/CEO: Ready to ship b151
   - Update release notes with feature description

3. **Setup Post-Release Monitoring**
   - Create Sentry dashboard with: abstain rate, accuracy by gear size, error rate
   - Set alerts: Accuracy < 88% (threshold drift)
   - Monitor: methodUsed distribution (verify pap1534-d3-dense-chainring-abstain fires correctly)

4. **Plan Follow-Up Work** (if time permits)
   - Review: What's the next accuracy target? (Reading 1 vs other improvements?)
   - Analyze: Can we improve abstain accuracy on edge cases?
   - Document: D3 success metrics for future reference

**Timeline**: 2-4 hours active work, then ongoing monitoring

---

## SCENARIO 2: Device Validation FINDS MINOR ISSUES ⚠️

### Example Issues
- Abstain rate lower than expected (70-80% instead of 90%+)
- False positive abstentions on mid gears (rare cases)
- Timing not as good as predicted
- Edge cases (rotated gears, lighting) not handled well

### AE Actions
1. **Investigate** (1-2 hours)
   - Review Sentry data from QA test session
   - Identify which photos caused issues
   - Analyze: Is it threshold too loose/tight? Algorithm misclassifying?
   - Check: Is it camera calibration issue or algorithm issue?

2. **Propose Fix** (30-60 minutes)
   - Option A: Adjust threshold (innerRadius ratio: 0.45-0.55 range)
   - Option B: Refine radius estimation (e.g., use more angle samples)
   - Option C: Add special case handler for edge cases
   - Recommend: Smallest change that fixes the issue

3. **Implement & Test** (1-2 hours)
   - Make code change to gearCounter.js
   - Add test case for the reported issue
   - Run full test suite (verify no regressions)
   - Build new APK (b152)

4. **Request Re-Test** (30 minutes)
   - Post on PAP-1800: "Applied fix X, requesting re-test on QA device"
   - Explain change: What's different, why it helps
   - Provide: New APK build (b152)

5. **Follow Outcome**
   - If passes: Proceed to Scenario 1 (Production approval)
   - If still fails: Repeat investigation → propose → implement (2nd iteration)

**Timeline**: 2-8 hours total (includes re-test)

---

## SCENARIO 3: Device Validation FINDS MAJOR ISSUE 🔴

### Example Issues
- Abstain fire rate only 40-50% on dense chains (algorithm fundamentally wrong)
- False positive abstentions 20%+ on small gears (catches correct gears)
- Crashes or ANRs during testing
- Timing doesn't improve (pre-FFT doesn't fire)

### AE Actions
1. **Root Cause Analysis** (2-4 hours)
   - Review all Sentry events from test
   - Examine photos that triggered issues
   - Analyze failure pattern: Is it specific gear sizes? Lighting? Camera angle?
   - Check: Is innerRadius estimation broken? Is threshold wrong?
   - Hypothesis: Is the algorithm design fundamentally flawed?

2. **Decide: Fix or Revert?** (1 hour)
   - If fixable with parameter tuning: Go to Scenario 2 (iterate)
   - If requires algorithm redesign: Recommend reverting to b150 (pre-D3)
   - Post analysis on PAP-1800: "Findings and recommendation"

3. **If Reverting**
   - Revert commit 11d07ed from main (or tag b150 as release candidate)
   - Post comment: "D3 approach not viable, reverting to b150 baseline"
   - Escalate to CEO: "D3 approach failed device validation, need decision on next path"
   - Notify: Mobile Engineer, Product team

4. **If Redesigning Required**
   - This becomes new algorithm work (different project)
   - Cannot release b151 (D3 version)
   - Timeline extends by 1-2 weeks for new approach
   - Document lessons learned for next attempt

**Timeline**: 2-4 hours analysis + decision, then either escalate or iterate

---

## SCENARIO 4: NO DEVICE AVAILABLE 🔲

### What Happens
- Can't test on FP5
- Device validation (PAP-1800) blocked indefinitely
- b151 remains production-ready but unvalidated

### AE Actions
1. **Assess Risk**
   - Can we deploy unvalidated? (Risk assessment)
   - Options: Limited release (internal testing), defer release, find alternate device
   - Post on PAP-1800: "Device unavailable, escalating options"

2. **Limited Release Option** (if approved)
   - Release to QA team only (internal testing)
   - Release to beta testers (limited audience)
   - Collect data on abstain rates from users
   - Decision: Full release after X days of data

3. **Alternate Device Option** (if available)
   - Simulator validation (not ideal, but shows correctness)
   - Different Android device (not ideal, camera may differ)
   - Temporary device loan (reach out to partner)

4. **Escalate to CEO**
   - Post: "Device validation blocked, requesting guidance on release strategy"
   - Provide risk assessment and options
   - Await decision

**Timeline**: 1 hour assessment + decision, then either limited release or escalate

---

## DECISION TREE

```
Device validation starts (PAP-1800)
│
├─→ Passes ✅ → Scenario 1 (Approve & monitor)
│   └→ Setup production monitoring, watch for issues
│   └→ Document success, analyze metrics
│
├─→ Minor issues ⚠️ → Scenario 2 (Fix & re-test)
│   ├→ Fix passes → Scenario 1 (Release)
│   └→ Fix fails → Repeat or go to Scenario 3
│
├─→ Major issue 🔴 → Scenario 3 (Revert or redesign)
│   ├→ Revert → Escalate to CEO for next path
│   └→ Redesign → New algorithm project (1-2 weeks)
│
└─→ No device 🔲 → Scenario 4 (Limited release or defer)
    ├→ Limited release → Collect user data
    └→ Defer → Await device access
```

---

## AE MONITORING CHECKLIST (All Scenarios)

### During Device Testing
- [ ] Monitor Sentry for events (real-time if possible)
- [ ] Watch for: Crashes, ANRs, unusual error patterns
- [ ] Track: Abstract rates by photo, methodUsed distribution
- [ ] Note: Any photos that behave unexpectedly

### If Issues Arise
- [ ] Request sample photos from QA
- [ ] Reproduce on host using same photos
- [ ] Analyze: Algorithm correctness vs threshold vs camera
- [ ] Prepare: One or more fix options

### Post-Release (Scenario 1)
- [ ] Setup Sentry dashboard with D3-specific metrics
- [ ] Set alerts: Accuracy, abstain rate, error rate
- [ ] Daily check first week: Any unusual patterns?
- [ ] Weekly check after: Trend analysis
- [ ] Monthly check: Long-term stability

---

## COMMUNICATION TEMPLATE

### If Issues Found
```
Post on PAP-1800:

"Device validation issue detected:

**Problem**: [Abstain rate 60% vs expected 90%]

**Analysis**:
- [Sample photos show algorithm fires on X but not Y]
- [Likely cause: threshold too tight]

**Proposed Fix**:
- [Adjust innerRadius threshold from 0.50 to 0.48]
- [Rationale: Tighter detection without false positives]

**Next Steps**:
- Requesting re-test with b152 (fixed build)
- Timeline: New APK uploaded, ready when you are

**If this doesn't work**: [Have backup plan documented]
```
```

### If Passes
```
Post on PAP-1800:

"Device validation PASSED ✅

**Results**:
- Dense chains (40+T): Abstain 91% (target: ≥90%) ✓
- Small gears (11-13T): Proceed 100% (target: >95%) ✓
- Mid gears (16-28T): Accuracy 91% (target: ≥89%) ✓
- Timing: [X]ms faster with D3 abstain ✓
- No crashes or errors ✓

**Recommendation**: Approved for production release

**Next**: Monitoring setup and release coordination
```
```

---

## TIMELINE SUMMARY

| Scenario | Analysis | Fix | Re-Test | Total |
|----------|----------|-----|---------|-------|
| **Passes** | - | - | - | ~0.5h (post comment) |
| **Minor issue** | 1-2h | 1h | 1h | 3-4 hours |
| **Major issue** | 2-4h | varies | varies | 4+ hours or escalate |
| **No device** | 1h | - | - | Escalate or limited release |

---

## ESCALATION THRESHOLDS

**When to Escalate to CEO**:
- Device validation can't proceed (hardware unavailable)
- Major redesign needed (algorithm fundamentally broken)
- Release decision needed (go/no-go after validation)
- Risk assessment needed (deploy unvalidated?)

**Escalation Message**: 
- State problem clearly
- Provide analysis and data
- Offer 2-3 options with pros/cons
- Request decision and next steps

---

## AE DEPENDENCIES FOR SUCCESS

**Success requires**:
1. ✅ Device validation results posted to PAP-1800
2. ✅ Sample photos available if issues arise
3. ✅ Access to Sentry for monitoring
4. ✅ Ability to build and publish new APKs if needed
5. ✅ Access to re-test loop if fixes needed

**If any dependency missing**: Escalate to CEO with details

---

**Document Purpose**: Ensure AE is prepared for all outcomes
**Created**: 2026-09-05 (before device validation starts)
**Status**: Ready for use
**Next Review**: After device validation completes and results are available

