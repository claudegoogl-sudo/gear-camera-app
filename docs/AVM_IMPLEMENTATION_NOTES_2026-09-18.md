# AVM implementation notes (PAP-1920) — Mobile Engineer, 2026-09-18

Spec: `docs/QA_AUTO_VALIDATION_MODE_SPEC_2026-09-18.md` (QA). This note records
the implementation decisions and tradeoffs for the QA cross-check. Tests:
`mobile/__tests__/pap1920.avm.test.js` (13) + `pap1920.avm_result_screen.test.js` (5).

## Files

| File | Change |
|---|---|
| `src/utils/avm.js` | NEW — pure lifecycle state machine (no RN imports, fully unit-tested) |
| `src/utils/avmStore.js` | NEW — JSON-file persistence (`avm-state.json`, documentDirectory) + battery read |
| `src/screens/CameraScreen.jsx` | +arming effect (mount + AppState), +guidance banner, +`avmSession` cameraEvent. Capture/detection path untouched |
| `src/screens/ResultScreen.jsx` | +label prompt modal, +auto-share, +status line. Manual share path untouched |
| `src/utils/debugShare.js` | +optional `validationSession` param → `contexts.validationSession` + `validation=avm` tag (additive) |
| `package.json` | +`expo-battery@~10.0.8` (SDK-54-pinned via `expo install`; autolinks at next gradle build, no permission needed on Android) |

**AC3 proof:** `git diff` shows zero hunks in `src/algorithm/**`, `src/hooks/**`,
or `handleCapture`/`handleCancel` — 293 insertions, 0 deletions, all in the
files above. algoSha-relevant code is byte-identical.

## Semantics chosen (spec ambiguities resolved)

1. **"Detection session" = a foreground period that produces ≥1 completed
   capture.** Opening the app without shooting never burns one of the N=3
   (`sessionIndex` increments on the session's first completed capture only).
   Otherwise three idle opens would silently disarm the mode.
2. **Foreground periods separated by <90s are one session** (Telegram-glance
   protection). A killed process (no background event) resumes stale, so the
   next launch opens a fresh session — conservative, keeps operator burden low.
3. **Dormancy boundary:** the OPEN session keeps collecting until it ends
   (background/kill) even after its first capture marks `sessionIndex=3`;
   dormancy applies to arming the NEXT session. Exception: the 10-capture
   limit ends the session immediately (mid-session dormancy).
4. **Version key = `BUILD_LABEL`** (version + build number + date), so every
   install/update re-arms — including RELEASE builds (Step A) and same-code
   rebuilds. This matches "app update re-arms" (AC2) at build granularity.
5. **Completed capture = ResultScreen mount** (= `countTeeth` produced a
   result, abstains included). Cancels/no-detections/errors stay on the camera
   screen and never count — the b157 cancel pattern (2 cancels, 1 event) maps
   to exactly 1 counted capture.
6. **Label prefill:** detected count when ≥1 (one-tap confirm); abstains start
   empty (operator types the truth — the most valuable label in the corpus).
   Skip → sample auto-shared unlabeled (`label:null`), no training upload.
7. **Battery guard fails OPEN on unreadable battery** (null level): the guard
   protects a dying phone, unknown ≠ low, and Sentry's native device context
   still records the true level for post-hoc filtering. Floor = 0.25.

## Observability added

- `contexts.validationSession` on every auto-share: `{appVersion,
  sessionIndex, shotIndex, shotsRemaining, label, batteryLevel, schemaVersion}`.
- Tag `validation=avm` distinguishes auto-shares from manual operator shares
  in Sentry search without context parsing.
- `cameraEvents` gains `avmSession` entries (session open / resumed-as-new)
  so debug shares prove arming state at capture time.

## Risks / tradeoffs for QA attention

- **expo-battery is a new native module** — first gradle build after this
  commit links it; a build failure there is the likeliest integration risk
  (low: SDK-pinned via `expo install`, no config plugin, no permissions).
- **Session counting is foreground-period-based**, not calendar-day: an
  operator who shoots across 3 short sittings consumes the 3 sessions even if
  all within one morning. Spec's "first few sessions" intent is preserved.
- **AVM prompt timing:** fires on Result mount, after the ~29s pipeline —
  same moment the manual Share Debug button appears today. One prompt per
  completed capture, never on cancels.
- **Doctest gap:** the CameraScreen banner has no dedicated component test
  (pure module + ResultScreen flow are covered); banner is cosmetic, gates
  nothing — any failure mode is invisible-hint, not lost data.
- **State file is per-install** (documentDirectory): uninstall/reinstall and
  `adb clear data` both re-arm. Dev reloads keep counters (same BUILD_LABEL).

## What QA should validate before triggering the build

1. Cross-check the semantics above against the spec (esp. #1, #3, #7).
2. `npx jest` green at the commit (155 pre-existing + 18 new; pap1881 flake
   note applies — green standalone).
3. AC3: `git diff <release-commit>..<this-commit> -- mobile/src/algorithm mobile/src/hooks` is empty.
4. Build b158; on device: fresh install → banner visible, shoot → prompt →
   label tap → auto-share lands with `validationSession` context + tag; 10th
   capture or 3rd capture-bearing session → mode dormant (no banner/prompt);
   app update (new BUILD_LABEL) → re-armed.
