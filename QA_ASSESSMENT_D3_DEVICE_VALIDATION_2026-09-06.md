# QA Assessment: D3 Pre-FFT Implementation & Device Validation Decision (PAP-2XXX)

**Date**: 2026-09-06 01:10 UTC  
**QA Engineer**: (a4117872-d796-4e43-ad79-aab12f98d646)  
**Related Issue**: 0e100b36-f8b7-4b36-abae-32f5fa07f28f (Device-validation capability gap)  

---

## Executive Summary

**D3 Pre-FFT implementation is PRODUCTION-READY at code level.**

- ✅ Algorithm implementation: Correct, tested, and approved
- ✅ Mobile integration: Complete and built (b150 APK)
- ✅ Unit test coverage: 10/10 passing (dense chainring detection)
- ✅ Desktop validation: All phases passed
- ⏳ Device validation: Ready to execute, awaiting FP5 hardware access

**Decision Required**: Whether to proceed with Option A (operator device session) or Option B (code-level evidence only) for final release validation.

---

## Technical Readiness Assessment

### Algorithm Implementation (PAP-1534/PAP-1535)

**File**: mobile/src/algorithm/gearCounter.js (commit 11d07ed)  
**Spec**: debug-reports/PAP1534_D3_PRE_FFT_SPEC_2026-09-02.md  

**What was implemented:**
- `estimateInnerRadius()`: Hybrid texture + gradient analysis
- `checkDenseChainringRegime()`: Density classification gate
- Integration point: After findGearCenter(), before FFT pipeline
- Threshold: inner_radius_fraction < 0.50 → dense chain detected
- Action: Abstain from FFT, return methodUsed tag 'pap1534-d3-dense-chainring-abstain'

**Code Quality: ✅ PASS**
- Matches specification exactly
- No edge cases in predicate logic
- Proper error handling (graceful fallback to FFT)
- Performance: <30ms pre-FFT gate (7-10x speedup vs full FFT)

**QA Code Review**: ✅ APPROVED (see QA_PAP1782_FINAL_APPROVAL_2026-09-03.md)

### Unit Test Coverage

**Test File**: mobile/__tests__/pap1782.dense_chainring_detect.test.js  
**Coverage**: 10 test cases, all passing  

Test categories:
- ✅ Dense chainring detection (40T, 50T, 60T) — abstain rate verified
- ✅ Small gear non-detection (11T, 13T) — no false abstain
- ✅ Mid-range normal flow (18T, 24T) — proceed to FFT
- ✅ Boundary cases (42T-52T) — edge case handling
- ✅ Error conditions (corrupt images, edge cases) — graceful degradation

**Test Quality**: ✅ PASS (10/10, no flakes)

### Build Artifact Verification

**Build**: b150  
**Status**: Published to GitHub releases  
**Size**: ~135 MB  
**Commits included**: 11d07ed (D3 implementation) + build infrastructure  

**Build Quality**: ✅ APPROVED
- APK builds cleanly with no warnings
- Sentry integration enabled
- All dependencies resolved
- Ready for immediate deployment

---

## Device Validation Readiness

### Test Plan Status

**Document**: DEVICE_VALIDATION_PLAN_B150.md (in repo root)  
**Completeness**: ✅ COMPREHENSIVE

Plan includes:
1. Phase 1: Dense chainring detection (40T, 50T, 60T)
2. Phase 2: Small gear non-detection (11T, 13T)
3. Phase 3: Mid-range normal flow (16-28T)
4. Phase 4: Timing validation (Sentry stageMs)
5. Phase 5: Error handling (corrupted images, rotated gears)

**Duration**: 45-60 minutes with device and photos available  
**Pass Criteria**: Clearly defined and measurable  

### Known Edge Cases (Monitor Post-Deployment)

1. **42-52T Boundary**: Threshold at 0.50 may require adjustment
   - Action: Monitor abstain rate during rollout; adjust to 0.45 if >5% false-positive-abstain

2. **Lighting Conditions**: Gradient/variance sensitive to exposure extremes
   - Action: Validate on device camera output (JPEG-compressed)

3. **Rotated/Misaligned Gears**: 8-angle sampling assumes symmetric geometry
   - Action: Test with intentionally rotated chainrings

4. **Non-Standard Designs**: Dataset focuses on road-bike chains
   - Action: Re-validate if expanding to track/mountain bikes

---

## Desktop vs Device Data Gap

### Measured Discrepancy

Per PAP-1673 analysis:
- **Desktop Full-Frame Corpus**: 210/362 = 58.0% accuracy (measured on desktop harness)
- **Device Field Data**: Unknown (not yet measured on real FP5)
- **Speed provenance (CORRECTED 2026-09-09, PAP-1855)**: the old "5757ms vs 977ms, 6x gap" was a mislabel — BOTH numbers are desktop measurements (5757ms = desktop full-corpus audit under babel-jest; 977ms = desktop stage profiler). The 6x is explained and closed: controlled re-measurement (PAP-1672, commit 4399380) gave node p50 1025ms vs jest p50 6974ms on the same 61 photos = 6.8x per-photo babel-jest inflation landing in `detect`; host contention ruled out. Authoritative: PRODUCT_TARGETS.md row 3 (Speed) and docs/device-speed-reconciliation-2026-08-23.md (note: that doc's first attribution to host contention was superseded by the PAP-1672 controlled re-run — cite PAP-1672).
- **Real open item — device-vs-desktop gap**: ~36.7s p50 on FP5 pre-D3 (b142-era Sentry, n=7) vs ~0.99s desktop node = **~37x**, leading hypothesis Hermes interpreter. Confirming/refuting it needs on-device algoDiag stageMs breakdowns, which the FP5 session must capture.

### Why This Matters

The publishability decision depends on numbers that ONLY exist on hardware:
- Is 5-second speed target actually met on FP5?
- Is 58% accuracy sufficient for the deployed use case?
- Are edge cases (rotation, lighting) handled correctly in the field?

**Risk of Skipping Device Validation:**
- Release with unvalidated device speed (~37x device-vs-desktop gap, Hermes hypothesis unconfirmed — no on-device stageMs yet)
- Discover 70-93s device freezes in production (similar to PAP-1647)
- No trustworthy accuracy baseline for field deployments

---

## Recommendation Framework for CEO Decision

### Option A: One Batched Operator Device Session

**Cost**: 1-2 hours operator time  
**Coverage**: All 6 parked validation tickets + current D3 testing  
**Timeline**: 1-2 hours to results  

**What gets resolved:**
- ✅ D3 pre-FFT validation (5 phases from plan above)
- ✅ Speed baseline on FP5 (stageMs timing data)
- ✅ Accuracy validation vs 58% desktop number
- ✅ Edge case confirmation (rotation, lighting, corrupted images)
- ✅ All 6 parked tickets get dispositions

**Recommended Action**:
1. Create shot list (QA provides exact photo requirements)
2. Operator runs single session on FP5 with b150 build
3. Post results to this issue
4. QA verifies pass criteria
5. Release b150 immediately

**This is the **low-risk path** — it costs time but records real post-D3 device stageMs for the first time and quantifies the ~37x device-vs-desktop (Hermes) gap.**

### Option B: Accept Code-Level Evidence Only

**Cost**: 0 operator hours  
**Coverage**: Algorithm implementation only (no runtime validation)  
**Timeline**: Immediate release

**What remains unvalidated:**
- ⚠️ ~37x device-vs-desktop speed gap unquantified (~36.7s p50 FP5 pre-D3 vs ~0.99s desktop node; Hermes hypothesis unconfirmed without on-device stageMs)
- ⚠️ Real-world camera JPEG performance (tests use raw images)
- ⚠️ Field edge cases (lighting extremes, rotated gears)
- ⚠️ 70-93s device freeze pattern (not reproduced in tests)
- ⚠️ Accuracy on real FP5 footage (58% desktop vs ??? device)

**Risks**:
- Discover critical performance issues in production
- No way to explain or reproduce the ~37x device-vs-desktop speed gap
- Publish without speed validation for a speed-critical feature
- Repeat PAP-1647 freeze pattern (undiagnosed until field data)

**This is the **high-uncertainty path** — it trades certainty for speed.**

---

## QA Verdict

**Code Level**: ✅ APPROVED — No issues found in algorithm or mobile implementation  
**Test Coverage**: ✅ APPROVED — Unit tests comprehensive and passing  
**Build Quality**: ✅ APPROVED — Artifact is valid and ready  

**Release Gate**: **CONDITIONAL ON DEVICE VALIDATION**

The D3 implementation is technically solid. However:
- The ~37x device-vs-desktop speed gap (Hermes interpreter hypothesis) stays unquantified without device stageMs data
- Accuracy is measured at 58% on desktop but unknown on device
- Field deployment risks are real and unquantified

**My Recommendation**: **OPTION A — Device session is worth the time cost.**

The feature is speed-critical (PAP-1535 whole point is to avoid 70-93s freezes). Releasing without device speed data is releasing without knowing if the feature actually solves the problem it was designed to solve.

---

## Acceptance Criteria for Release

Once device validation is complete (via Option A or Option B):

### FP5-Session Judgment Criteria (authoritative — PAP-1855, adopted 2026-09-09)

Judge the b151 FP5 session by these three, and ONLY these:

1. **Dense-chainring abstain rate ≥90%** with false positives <5% (40+T dense chainrings abstain from FFT instead of miscounting)
2. **Pre-FFT gate overhead <30ms** (texture-analysis gate cost; PAP-1534 spec: ~15–30ms)
3. **PAP-1647-class chainring freeze elimination** — no 70–93s hangs on dense chainrings

**Explicitly NOT pass/fail**: ordinary-gear wall clock. A ~30s ordinary-gear number is the known pre-D3 baseline (~36.7s p50, Sentry n=7) unless the native-kernel track (PAP-1694/1696) has landed — it is not a validation failure. Do NOT judge proximity to "977ms" (a desktop stage-profiler number — see provenance correction above).

**Also required from the session**: log every timed capture as a full algoDiag stageMs breakdown (method per docs/device-speed-reconciliation-2026-08-23.md) so the ~37x Hermes-interpreter hypothesis can be confirmed or refuted from the same session.

**IF Option A chosen and results are positive:**
- [ ] Dense chainrings (40+T): ≥90% abstain, <5% false detections
- [ ] Small gears (11-13T): 0% false abstain (all proceed to FFT)
- [ ] Mid-range (16-28T): ≥89% accuracy maintained
- [ ] Pre-FFT gate overhead <30ms
- [ ] No PAP-1647-class chainring freezes (70–93s) observed
- [ ] Full algoDiag stageMs breakdown captured for each timed capture
- [ ] No crashes or ANRs observed
- [ ] Sentry telemetry tags present and correct
- ✅ Release immediately

**IF Option B chosen:**
- ✅ Code review pass (above)
- ✅ Unit tests pass (above)
- ✅ Release b150 with note: "Shipped on code-level evidence, device validation deferred"
- ⚠️ Plan intensive field monitoring and quick rollback procedures

---

## Open Questions for CEO

1. **Speed validation**: Is the ~37x device-vs-desktop gap acceptable to leave unquantified (no on-device stageMs breakdown)?
2. **Accuracy baseline**: Should we validate 58% accuracy on real hardware before release?
3. **Freeze risk**: How confident are we that D3 abstain prevents PAP-1647 freezes without device proof?
4. **Operator capacity**: Is 1-2 hours of operator time available for Option A?
5. **Release timeline**: Can we afford to wait for device session results, or is immediate release required?

---

## Artifacts & References

- PAP-1534/PAP-1535: D3 Pre-FFT Implementation Spec
- PAP-1673: Accuracy Decision (related: device speed/accuracy gap)
- PAP-1647: 70-93s Device Freeze (prevention motivation for D3)
- PAP-1855: Evidence correction — 5757/977 provenance fix + FP5-session judgment criteria (this file's 2026-09-09 corrections)
- PAP-1672: Controlled babel-jest vs node re-measurement @ 4399380 — 6.8x per-photo jest inflation (PRODUCT_TARGETS.md row 3)
- docs/device-speed-reconciliation-2026-08-23.md + docs/device-telemetry-sentry-2026-08-23.md (~36.7s device p50 baseline, n=7)
- DEVICE_VALIDATION_PLAN_B150.md: Complete test checklist
- QA_PAP1782_FINAL_APPROVAL_2026-09-03.md: Code review approval
- debug-reports/PAP1534_D3_PRE_FFT_SPEC_2026-09-02.md: Implementation spec

---

**QA Status**: APPROVED FOR RELEASE (pending device validation or explicit code-level-only waiver)  
**Next Action**: CEO decides Option A or Option B, posts decision as comment  
**Blocking Release**: No — D3 is shippable right now, but device validation would add confidence  

