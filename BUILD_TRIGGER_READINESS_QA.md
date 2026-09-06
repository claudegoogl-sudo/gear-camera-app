
# QA: Build Trigger Readiness — D3 Release

**Date:** 2026-09-06 ~14:30 UTC
**Status:** READY TO EXECUTE
**Owner:** QA Engineer (a4117872-d796-4e43-ad79-aab12f98d646)

## Trigger Condition

Build will be created when:
1. Operator makes device validation decision (Option A or Option B)
2. If Option A: Device validation passes (results reported by QA)
3. If Option B: Decision recorded (CEO authorizes ship without device test)

## Build Task to Create

When triggered, QA will create a Mobile Engineer build subtask with:

**Parent:** Feature parent issue (PAP-1782 or similar - D3 feature parent)
**Assignee:** Mobile Engineer (dcfaeb39-15b7-4d40-8267-f60026666dde)
**Priority:** critical (feature fix requiring device validation passed)
**Type:** Build/Deploy

**Description Template:**

```
## Build Trigger: D3 Pre-FFT Dense Chainring Detection — b151+ Release

**Feature:** PAP-1534 / PAP-1782 - D3 Pre-FFT implementation
**Status:** Device validation [PASSED/APPROVED OPTION B]
**Commits to ship:**
- 11d07ed (D3 implementation)
- [Any subsequent fixes from device validation]

**What was validated:**
[Option A: Device validation results summary]
[Option B: Code-level approval only]

**What to verify post-build:**
- Abstain rates on dense chains ≥90%
- No crashes on device
- Performance within budget (45s wall-clock)

**Release checklist:**
- [ ] Build APK from current main
- [ ] Tag release (v1.0.0-bXXX)
- [ ] Publish to GitHub releases
- [ ] Update version in package.json if needed
- [ ] Post release notes with D3 feature description
- [ ] Monitor Sentry for first 24h production errors
```

## Ready State Verification

- ✅ Code review: APPROVED
- ✅ Unit tests: 10/10 PASSING
- ✅ D3 implementation: COMPLETE
- ✅ No blocking code issues remaining
- ✅ All sibling subtasks: DONE
- ✅ 2347 unreleased commits: YES (ready to ship)
- ✅ Device validation decision: PENDING (will trigger build when made)
- ✅ Build response playbook: READY (Scenario A/B/C documented)

## Execution Timeline

Once operator decision arrives:
- QA receives notification of choice (A or B)
- QA executes build task creation immediately
- Mobile Engineer receives notification
- Build should complete within 30-60 minutes
- Release can follow within 1 hour

## Blocking Conditions That Would Pause Build

1. Device validation FAILS (Option A) → Wait for Algorithm Engineer fix
2. Critical code issues discovered → Wait for resolution
3. Platform issues (vault secrets missing) → Wait for resolution
4. No current blockers identified ✓

## Notes

- Build is not conditional on Telegram relay secret (CEO ruled it non-blocking)
- Sentry credentials are already restored and verified
- Device shot list is prepared and ready
- No other external dependencies identified
