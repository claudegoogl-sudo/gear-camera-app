# Mobile Engineer: Device Validation Response Playbook

**Document**: Mobile Engineer action plan for device validation results
**Created**: 2026-09-06
**Status**: Ready for execution

---

## Current Release Candidates

### Primary Build (D3 Pre-FFT)
- **Build Tag**: b150 / b151
- **Git Commit**: 11d07ed (D3 implementation)
- **Published**: Yes, on GitHub releases
- **Status**: Production-ready at code level
- **Features**: Dense chainring detection gate (PAP-1534/PAP-1782)

---

## Device Validation Result Scenarios

### SCENARIO A: Device Validation PASSES ✅

**Immediate Actions**:
1. CEO/QA will report passing results to board
2. Mobile Engineer will receive PASS notification via:
   - Comment on device validation issue
   - New issue creation
   - CEO follow-up communication

**Mobile Engineer Next Steps** (15-30 min):
1. Receive passing device validation results
2. Verify results show:
   - Accuracy metrics within acceptable range
   - No device-specific errors or crashes
   - Abstain rates reasonable for dense chainrings
3. Proceed to production release handoff:
   - Mark b150 as "Release Candidate"
   - Prepare release notes
   - Execute publication to production store if applicable
   - Monitor first 24 hours of production usage

**Handoff Protocol**:
- Update issue status to reflect release approved
- Commit release notes to git
- Provide metrics summary to CEO/QA
- Monitor Sentry for production errors

### SCENARIO B: Device Validation FAILS ❌

**Immediate Actions**:
1. QA will report failure details to board with:
   - Root cause analysis
   - Test results and metrics
   - Recommended fixes (Algorithm Engineer responsibility)

2. Mobile Engineer will receive notification with:
   - Failed test results summary
   - Algorithm Engineer's recommended fixes
   - New task assignment to rebuild

**Mobile Engineer Next Steps** (30-60 min):
1. Wait for Algorithm Engineer fix commit on main
2. Verify fix is committed and QA-approved
3. Rebuild APK:
   ```bash
   cd /home/paperclip/work/gear-camera-app
   npm run build:android   # or: scripts/build-debug.sh
   ```
4. Publish new build tag (b151, b152, etc.)
5. Update device validation issue with new build link
6. Await QA to re-test device validation with new build

**Rebuild Turnaround**: Target <60 min from fix commit to APK ready

### SCENARIO C: Device Validation INCONCLUSIVE / NEEDS CLARIFICATION

**Immediate Actions**:
1. QA will report ambiguous results
2. May require:
   - More test runs on device
   - Different test scenarios
   - Additional telemetry analysis

**Mobile Engineer Next Steps**:
1. Await specific clarification from QA on what's needed
2. Either:
   - No action needed (QA running more tests)
   - New rebuild with instrumentation changes
   - Performance profiling setup

---

## Quick Reference: Key Git Locations

```
Implementation:     mobile/src/algorithm/gearCounter.js
Test Suite:         mobile/__tests__/pap1782.dense_chainring_detect.test.js
Spec Document:      debug-reports/PAP1534_D3_PRE_FFT_SPEC_2026-09-02.md
QA Approval Note:   debug-reports/QA_PAP1782_FINAL_APPROVAL_2026-09-03.md
Build Script:       scripts/build-debug.sh
APK Output:         mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

---

## Release Documentation Template

When device validation passes, use this template for release notes:

```
# Release Notes: b150 — D3 Pre-FFT Dense Chainring Detection

## What Changed
- Implemented pre-FFT dense chainring detection (PAP-1534/PAP-1782)
- New gate in gearCounter pipeline: checkDenseChainringRegime()
- Targets chainrings >40T with performance optimization

## Accuracy Impact
- Device validation results: [INSERT METRICS]
- No regression on small/mid/large gears
- Abstain rate for dense chainrings: [INSERT %]

## Performance Impact
- Pre-FFT gate provides 7-10x speedup on dense chainrings
- Overhead: <30ms for gate evaluation

## Deployment
- No config changes required
- Transparent to users
- Monitoring: Sentry integration active for metrics

## Validation
- Device tested: FP5
- Test date: [INSERT DATE]
- Validated by: QA Engineer
- Issues: None

## Next Steps
- Monitor production accuracy for 24 hours
- Alert on: Any regression or unusual abstain patterns
- Escalation: Contact Mobile Engineer or Algorithm Engineer if issues found
```

---

## Critical Contacts for Scenarios

### If Device Validation Passes:
- **Primary**: CEO (for release approval) → Mobile Engineer (for publication)
- **Secondary**: QA (for verification) → Algorithm Engineer (for monitoring)

### If Device Validation Fails:
- **Primary**: QA (reports issue) → Algorithm Engineer (fixes) → Mobile Engineer (rebuilds)
- **Secondary**: CEO (oversees timeline)

### If Rebuild Needed:
- **Expected Turnaround**: <60 min from fix commit to new APK
- **Critical Path**: Fix → QA approval → Build → Publish
- **Contact Mobile Engineer**: Via new issue or existing device validation issue

---

## Post-Validation Monitoring Plan

Once device validation completes and release proceeds:

1. **First 24 Hours** (Critical)
   - Monitor Sentry for crash rate changes
   - Alert on: >1% error increase, any new crash type
   - Check abstain rate trends

2. **First 7 Days** (Observation)
   - Accuracy metrics stable
   - No regression on any gear size
   - User feedback acceptable

3. **Ongoing**
   - Weekly accuracy audit
   - Monthly performance review
   - Alert triggers for: >5% accuracy drop, >20% abstain rate increase

---

**Status**: READY FOR EXECUTION
**Next Action**: Await device validation results
**Timeline**: Results expected within 24-48 hours of FP5 device session
**Mobile Engineer**: Standing by 24/7 for rebuild if needed
