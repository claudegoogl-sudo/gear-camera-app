# Device Validation Plan — dense-abstain build (b153+; supersedes the b152 gate-off plan)

**Build**: dense-abstain build from PAP-1872 (Mobile Engineer, todo, high) — release tag TBD (b153+)
**Decision source**: operator card v4 `cefe13ee` (2026-09-11 11:05Z): Q1 = A2 short recurring cadence, Q2 = **go-abstain (dense-abstain honest-UX)**
**Supersedes**: the b152 gate-off framing previously in this file (PAP-1862 "confident-wrong accepted" stance is superseded by go-abstain)
**Session vehicle**: PAP-1800 (this issue). One session also clears PAP-1662 release-build validation (`372d2acf`).
**Hardware required**: FP5 with Sentry access
**Status**: plan final on desktop; execution waits on (1) PAP-1872 build, (2) FP5 session (operator todo list on PAP-1671, pids raise first)

---

## Why expectations changed (b152 → abstain build)

- PAP-1862 disabled the PAP-1534 D3 gate because it abstained 70.4% of ordinary 20T-class
  gears (unshippable FP). b152 = gate-off (`ccc70e6`); dense confident-wrong was ACCEPTED there.
- Operator decision `cefe13ee` supersedes that acceptance: dense 40-60T goes from
  wrong-answers to honest-abstain ("cannot count"). PAP-1872 recalibrates the existing
  `checkDenseChainringRegime()` + `estimateInnerRadius()` path (method tag
  `pap1534-d3-dense-chainring-abstain` or its successor).
- Capture-side rescue is dead: 1500/2048px probe NEGATIVE (PAP-1869, QA-validated at
  `bdf4c2e` — deficit is optical, not sampling). Focus/exposure is the only surviving
  capture-side idea → Phase 6 below, NON-GATING.
- Evidence base for the two dense subclasses (per-size expectations): 50T =
  present-but-misselected (signal 6/7, production lands 2/7); 52T = signal-absent
  (2/22 anywhere in scan). Both must abstain honestly; per-size abstain rates reported.

## Test Setup

1. **Install APK** from the PAP-1872 release when published. Clear app data first:
   `adb shell pm clear com.example.gearapp` (or equivalent).
2. **Verify Sentry connection** (Settings → About; device model in dashboard).
3. **Test data**:
   - Ordinary: 18T, 20T, 24T (b151 bug class — highest priority) + 11T, 13T lockrings
   - Dense: 40T, 42T, 45T, 50T, 52T, 60T (42/50/52 priority per subclass evidence)
   - Lighting: bright, dim, shadows; rotated/misaligned; over/under-exposed

## Pre-flight desktop check (QA, before the device session)

Once PAP-1872 lands on main, run the 364-photo plain-node corpus audit at that commit
(PAP-1862/PAP-1869 methodology) BEFORE booking device time:
- dense 40-60T honest-abstain ≥ 90% and ordinary false-abstain < 5% host-side.
- 20T-class anchors still return tc=20 conf>0 at the new commit.
Device session only proceeds if the host audit passes.

## Validation Checklist

### Phase 1: Ordinary mid-gear (18T, 20T, 24T) — STANDING (the b151 bug class)
- [ ] 3-5 captures each; MUST return correct toothCount (tc=20, confidence > 0)
- [ ] methodUsed = normal counting path — ANY abstain tag on ordinary gears = FAIL
- [ ] False-abstain rate across all ordinary captures: target < 5%

**Expected**: correct counts; `toothCount=0` here = **FAIL** (b151 bug regression).

### Phase 2: Small gears (11T, 13T) — STANDING
- [ ] 3 captures each; normal FFT path, correct counts, no abstains

### Phase 3: Dense chainrings (40-60T) — INVERTED (go-abstain)
- [ ] 3-5 captures each of 40 / 42 / 45 / 50 / 52 / 60T
- [ ] MUST abstain honestly: confidence = 0 / "cannot count" result
      (`pap1534-d3-dense-chainring-abstain` or successor tag)
- [ ] **Target: abstain on ≥ 90% of dense captures** (report per-size rate)
- [ ] **Confident-wrong toothCount on dense = FAIL** (supersedes the PAP-1862
      accepted-regression stance; operator decision `cefe13ee`)
- [ ] Record any confident-wrong count + capture for AE (regression evidence)

### Phase 4: Timing / telemetry — STANDING
- [ ] algoDiag `stageMs` present on every capture (feeds the PAP-1688 n>=10 budget
      re-derivation trigger and the ~37x Hermes-gap investigation)
- [ ] Wall clock within the 45s budget (PAP-1688); `budgetExhausted` = 0
- [ ] Device detect p50 ~29s is the known baseline — NOT a failure
- [ ] No timing regression vs b152 on ordinary gears

### Phase 5: Error handling — STANDING
- [ ] Overexposed, underexposed, rotated/misaligned: no crashes, no ANRs, graceful fallback

### Phase 6: Focus/exposure capture A/B — NON-GATING experiment block
The one surviving capture-side idea after the 1500px negative (PAP-1869). Dense targets only.
- [ ] Arm A (default): 3-5 captures per dense size, stock focus/exposure
- [ ] Arm B (assisted): same targets, manual focus-lock + exposure-lock (tap-to-focus on
      rim, locked exposure) — cadence sessions are where photon-level levers get answered
- [ ] Record per arm: honest-abstain / confident-wrong / correct + `stageMs`
- [ ] Does NOT gate the build verdict; results feed the next PAP-1671 card decision only

### Phase 7: Sentry release-build validation (PAP-1665) — needs a RELEASE-variant APK
PAP-1662 removed the JS-side native re-init in release builds only (`__DEV__` keeps it
alive in debug by design), so items 1–2 are only observable on a release APK. The next
session build must include one (`scripts/build-release.sh`), not only `build-debug.sh`
— b145/b151/b152 were all debug APKs. Install the release APK for at least the first
cold start of the session.

Host-side items already CLOSED 2026-09-11 — do NOT re-check on device:
- Asset sanity: shipped b143 (release) and b152 (debug) APKs both package
  `assets/sentry.options.json` with DSN + `release: "v1.0.0 (N) · <date>"` + `dist: "N"`.
- Attribution: all Sentry releases `v1.0.0 (125…152) · <date>` are stamped; live
  JS-origin event `60ec20d9` (b152): release `v1.0.0 (152) · 2026-09-10 14:52`,
  dist `152`, 33 breadcrumbs preserved; fallback release `com.gearcounter.app@1.0.0+1`
  does not exist (zero events ever).

On-device (this session, release APK):
- [ ] Single native init per cold start: exactly one native-origin init/session per
      launch; no Hub/`AsyncHttpTransport` close+reopen right after the JS bundle loads
- [ ] JS capture works without the native re-init: a JS-origin event (e.g. a Phase 3
      dense honest-abstain debug_report) with readable breadcrumbs — camera.*/algo.*
      categories present, cf. event `60ec20d9` format
- [ ] Event groups under this build's stamped release/dist — record both values

## Pass Criteria

✅ **PASS if ALL of**:
- Ordinary 9-39T: correct on ≥ 90%; 20T-class returns tc=20 exact; false-abstain < 5%
- Dense 40-60T: honest abstain ≥ 90%; ZERO confident-wrong results tolerated (any = FAIL + AE ping)
- `stageMs` present on all captures; all < 45s wall clock; no crash/ANR
- Phase 6 A/B recorded (non-gating)

Phase 7 is **PAP-1665-scoped and does not gate the PAP-1800 verdict**, but if no
release-variant APK is available and it is skipped, the session report must say so
explicitly (PAP-1665 then stays blocked with items 1–2 open).

## Reporting

Post results to PAP-1800 (session vehicle); Phase 7 results also to PAP-1665.
Blockers: PAP-1872 (build — Mobile Engineer),
FP5 session scheduling (Operator via PAP-1671 todo list, pids raise first).
