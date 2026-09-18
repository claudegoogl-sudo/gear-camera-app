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


## v2 — QA cross-check fixes (2026-09-18, verdict 7f5d1dc7: FAIL → fixed)

**1. BLOCKING race fixed with QA's option (b) — single in-process owner.**
`avmStore.js` now holds the ONE copy of AVM state. New API:
- `getAvmState(now)` — read through the owner (loads disk once per process).
- `mutateAvmState(transition, now)` — serialized read → pure transform →
  persist; returns `{prev, next, out}`. `loadAvmState`/`saveAvmState` are
  GONE from the public surface (stale import would fail loudly).

CameraScreen (stack parent, never remounts under Result) no longer keeps a
private snapshot: mount-arm and AppState transitions go through
`mutateAvmState`, and its old `avmStateRef` mirror is deleted. ResultScreen
reads `getAvmState` and increments via `mutateAvmState(avmRecordCapture)`.
The v1 failure mode (CameraScreen re-saving a stale mount-time copy over
ResultScreen's persisted counters on every background/active cycle) is
structurally impossible now — there is no second copy anywhere.

**2. SECOND bug found by the required regression test (spec AC2 conformance):
session slots were consumed per CAPTURE, not per session.** v1
`avmRecordCapture` incremented `sessionIndex` on every capture while open,
so one 3-shot session exhausted the whole N=3 budget — sessions 2 and 3
would never collect. Fixed with a `sessionCounted` flag on the state
(spent on the first capture of a session, reset when `avmOnAppActive`
opens a new session past the grace window; `normalizeAvmState` coerces it,
so v1 state files parse — worst case one already-counted session counts
once more; no v1 file can exist in the field since b158 never shipped).
The v1 pure test "AC2: version change re-arms" only passed because its
timestamps were within the grace window — it was ONE multi-capture
session reaching dormancy via this bug; it now uses >grace gaps.

**3. QA non-blocking notes applied:**
- `avmSession` "resumed-as-new" event was dead code (`!prev.sessionOpen`
  never fires after the first open because background is a lazy close).
  New pure predicate `avmOpenedNewSession(prev, next)` fires on open OR
  resume-past-grace (incl. killed-process relaunch with a stale-open file).
- ResultScreen imports `AVM_BATTERY_FLOOR` instead of hardcoding 0.25.
- Counted ≠ shared: `captureCount` increments BEFORE the label prompt
  resolves — a process kill (or unmount mid-async) leaves the capture
  counted but the sample unshared. **QA scoring should use SHARED samples
  as the denominator** (tag `validation=avm`).

**4. One addition beyond the QA ask (flagged for review):** CameraScreen
re-syncs its banner projection on navigation focus via a read-only
`getAvmState()` — after the budget's final capture, the banner now hides
on return to the camera instead of lingering until the next AppState
event. Read-only; no write path added.

**Tests:** `pap1920.avm_store_race.test.js` (NEW, 6) — real avmStore with
an in-memory FS: the exact QA failure sequence (record → background →
active → counters survive, shotIndex monotonic), concurrent-mutation
serialization, simulated process restart, 3-session dormancy, 10-capture
mid-session dormancy, corrupt-file fail-safe. `pap1920.avm.test.js` grows
to 20 (session-slot fix + `avmOpenedNewSession` ×5). Result-screen suite
(5) now mocks the owner contract. Full suite green at the v2 commit
(exit 0; pap1862 sweep rows=364).
