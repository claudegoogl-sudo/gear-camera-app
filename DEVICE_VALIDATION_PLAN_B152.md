# Device Validation Plan: b152 — D3 dense gate disabled (post-PAP-1862)

**Build**: b152 (commit `ccc70e6`; includes `aabd380` — `D3_DENSE_GATE_ENABLED=false`)
**Supersedes**: DEVICE_VALIDATION_PLAN_B150.md and the b151 expectations in PAP-1800
**Status**: Ready for device validation; execution blocked only on FP5 access (PAP-1671)
**Hardware required**: FP5 with Sentry access
**Release**: https://github.com/claudegoogl-sudo/gear-camera-app/releases/tag/b152

---

## Why b152, not b150/b151

PAP-1862 evidence (364-photo host sweep, run at `ccc70e6`): the D3 pre-FFT abstain gate
ate **70.4% of ordinary 20T-class gears** at the FP<5% criterion and could not be
threshold-tuned (class medians interleave, AUC 0.375). QA approved disabling the gate on
main; b152 ships `D3_DENSE_GATE_ENABLED=false` (`mobile/src/algorithm/gearCounter.js:2477`).

Expectations INVERT vs the original b151 plan:

- **b151 bug**: ordinary 20T photos abstained (toothCount 0). **b152 must return tc=20.**
- **Dense 40-60T**: abstain no longer expected. Photos fall through to normal counting;
  confident-wrong counts there are the documented ACCEPTED regression (16/56 host corpus,
  PAP-1862), owned by the D-track redesign — **not a b152 failure**.

## Test Setup

1. **Install APK**
   - Release: https://github.com/claudegoogl-sudo/gear-camera-app/releases/tag/b152
   - Size: ~135 MB
   - Clear app data before first install: `adb shell pm clear com.example.gearapp` (or equivalent)
2. **Verify Sentry Connection**
   - Open app → Settings → About; confirm Sentry integration active; device model in dashboard.
3. **Test Data**
   - Mid gears 18T / 20T / 24T (the b151 regression class — highest priority)
   - Small gears 11T, 13T lockrings
   - Dense chainrings 40T, 50T, 60T
   - Lighting: bright, dim, shadows; plus rotated/misaligned and over/under-exposed

## Validation Checklist

### Phase 1: Ordinary mid-gear recovery (18T, 20T, 24T) — the b152 fix
- [ ] Capture 3-5 photos of a 20T-class gear
- [ ] MUST return correct toothCount (e.g. tc=20, confidence > 0)
- [ ] methodUsed is a normal counting path — NOT `pap1534-d3-abstain`
- [ ] Repeat for 18T and 24T

**Expected Result**: Correct counts on mid gears. `toothCount=0` abstain here = **FAIL**
(this is exactly the b151 bug b152 fixes; host anchors at `ccc70e6` return tc=20 conf=1.0).

### Phase 2: Small gears (11T, 13T) — unchanged
- [ ] Capture 3 photos of 11T and 13T lockrings
- [ ] Normal FFT path, no abstain, correct counts

**Expected Result**: No false abstains; correct counts.

### Phase 3: Dense chainrings (40T, 50T, 60T) — expectations inverted
- [ ] Capture 3-5 photos each of 40T / 50T / 60T
- [ ] Do NOT expect `pap1534-d3-abstain`; photos fall through to normal counting
- [ ] Record returned counts and correctness (for the D-track baseline), but
      confident-wrong results are the ACCEPTED regression (16/56, PAP-1862) — not a failure
- [ ] FAIL only on: crash, ANR, >45s hang, or an actual `pap1534-d3-abstain` result

**Expected Result**: No abstains anywhere (gate must be inert on-device; any
`pap1534-d3-abstain` result is an anomaly — report to Algorithm Engineer immediately).

### Phase 4: Timing / telemetry
- [ ] algoDiag `stageMs` telemetry present on every capture
- [ ] Wall clock within the 45s budget (PAP-1688); `budgetExhausted` = 0
- [ ] Device detect p50 ~29s is the known baseline — NOT a failure
- [ ] No timing regression vs b151 on mid gears (gate-off adds ~0 overhead)

### Phase 5: Error handling — unchanged
- [ ] Overexposed, underexposed, rotated/misaligned
- [ ] No crashes, no ANRs, graceful fallback or error state

## Optional gate probe (host only, no device)

`checkDenseChainringRegime` remains exported and intact for probes. The pipeline abstain
is disabled by the constant only. Restore = flip `D3_DENSE_GATE_ENABLED` to `true`
(`gearCounter.js:2477`).

## Pass Criteria

✅ **PASS if**:
- Mid gears 18-24T return correct toothCount on ≥90% of captures; ZERO abstains
- Small gears 11-13T: normal FFT counts; ZERO abstains
- Dense 40-60T: no crashes; ZERO `pap1534-d3-abstain` results (wrong dense counts logged, accepted)
- `stageMs` present on all captures; all captures < 45s wall clock; no ANR/crash

## Reporting

Post results to PAP-1800. Blocker PAP-1671 (FP5 access capability gap) stands; unblock
owner = Operator via PAP-1671.
