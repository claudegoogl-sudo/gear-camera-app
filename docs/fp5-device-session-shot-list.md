# FP5 Device Session — Batched Shot List

**Total time: ~22 minutes.** One build. Do the steps in order — if you run out of time,
stop after any step and everything already done keeps its full value. Nothing later
invalidates anything earlier.

## The build

**Release b137**, tag `b137`:
https://github.com/claudegoogl-sudo/gear-camera-app/releases/tag/b137
Asset: `gear-camera-release-2026-08-23.01.19-b137.apk`

b137 is the newest build and is a strict superset of every fix below (Sentry DSN guard
since b134, native Sentry init since b135, Sentry double-init removal in b136, the
chainring wall-clock deadline new in b137 itself). One install covers all four steps.

**What b137 cannot evidence:** nothing in this list — it's the latest build, so it
carries every fix this session needs to check. (If you're instead asked to validate an
*older* build like b130/b134/b135 specifically, use that build's own release page —
this list assumes b137.)

Install: uninstall any existing debug/release build of the app first (mixed
debug+release installs on the same device can throw a signature-mismatch error), then
sideload the APK and open it once to let it finish first-launch setup before step 1.

---

## Step 1 — Telemetry liveness (5 min) — do this first, it gates everything else

**Why first:** we have zero device telemetry since 2026-05-04 and don't know if that's
a broken upload pipeline or just nobody shooting photos since the upload mechanism
changed (see "Telemetry conclusion" below). This step settles it before any other
step's data is trustworthy.

**What to do:**
1. Open the app, point it at any gear (doesn't need to be in focus/countable).
2. Take a photo, let it process to the result screen.
3. Tap the debug-share button (small icon near the tooth count — on some builds it's a
   long-press on the count).
4. Type in the actual tooth count if asked, confirm the share.

**Pass looks like:** the share button changes state (fills in / greys out) with no
error popup. That's the *only* on-screen signal — there is no "uploaded!" toast by
design.

**Fail looks like:** an "Upload failed: ..." alert box pops up. Screenshot it.

**Send back:** a screenshot of whichever of the two you saw (success = the button's new
state, failure = the alert text). That single screenshot is enough — we can trace the
rest server-side once we know the client-side attempt succeeded or failed.

---

## Step 2 — Chainring freeze (7 min) — our worst known user-facing defect

**Why:** front chainrings (the big flat gear near the pedals, ≥~24% of the frame width)
previously triggered 70–93 second UI freezes on FP5 — the algorithm has no timeout and
just runs. b137 adds a hard 5-second wall-clock deadline meant to cut that to roughly
10s worst case (bounded overshoot, not millisecond-tight) by abstaining instead of
grinding to completion.

**What to do:**
1. Find a **front chainring** — the largest gear on a bike, mounted near the pedals
   (not a rear cassette gear). Fill as much of the frame as you comfortably can.
2. Take the photo. Start your phone's stopwatch the moment you tap the shutter; stop it
   when the result screen appears (count, or an abstain message).
3. Repeat for 2–3 different chainrings if you have access to more than one bike.

**Pass looks like:** result (a count, or an "unable to determine" abstain) appears
within **~10 seconds**. No indefinite spinner.

**Fail looks like:** the app hangs/freezes for 30+ seconds with no response to touch.

**Send back:** the stopwatch time for each shot, plus whether it returned a count or
abstained. If a shot freezes past 20s, force-close the app and note that as the result
for that shot — don't wait out a suspected regression.

---

## Step 3 — Stage timings / ABI trim (5 min) — settles the 5757ms-vs-977ms gap

**Why:** our desktop corpus audit measures a 5757ms median per photo; a separate
profiler run on the same corpus measures 977ms p50 — a ~6x discrepancy we can't
resolve without a real device data point. This step's numbers feed that reconciliation
directly (Algorithm Engineer side, PAP-1672), not something you'll see resolved
on-screen.

**What to do:**
1. Take 3 photos of **normal-sized gears** (a rear cassette gear, not a chainring —
   chainrings go through Step 2's deadline path and would contaminate this number).
2. Time each one shutter-tap to result-screen the same way as Step 2 (phone
   stopwatch).
3. Debug-share at least one of the three (same steps as Step 1) so the stage-by-stage
   breakdown (`algoDiag.stageMs`) reaches us, not just the total.

**Pass/fail:** there's no pass/fail here — any 3 numbers are useful data. Flag it only
if a shot takes noticeably longer than the others (>2x) for no obvious reason (e.g.
motion blur, refocus hunting).

**Send back:** the 3 stopwatch numbers, and confirmation you debug-shared at least one.

---

## Step 4 — Sentry init ordering (5 min) — crash-reporting correctness

**Why:** b135–b136 changed how/when the native and JS Sentry SDKs initialize on cold
start. We want to confirm the app still starts cleanly and doesn't visibly stall or
crash on launch — the risk case would show up as a slow or hung splash screen.

**What to do:**
1. Fully close the app (swipe away from recents, not just background it).
2. Cold-launch it 3 times in a row, timing shutter-icon-tap-ready each time with your
   stopwatch (i.e. time from tapping the app icon to the camera view being usable).
3. Force a crash if you can trigger one naturally in normal use during this session
   (don't go hunting for one) — otherwise just note "no crash observed."

**Pass looks like:** consistent cold-start time across the 3 launches (no launch
noticeably slower than the others), no visible hang on the splash screen.

**Fail looks like:** one or more launches hangs for several seconds longer than the
others, or the app crashes on launch.

**Send back:** the 3 cold-start stopwatch numbers, and crash/no-crash.

---

## Telemetry conclusion (Part 1a — code-level narrowing done ahead of the session)

**Cannot be fully resolved without this session's Step 1** — but here is what code
review narrows down, and why:

- The on-disk `debug-reports/report_*` folders stop at 2026-05-04. That is **fully
  explained by an architecture change, not a pipeline failure**: `PAP-1543` (commit
  `3e1c90e`, shipped in b125 on 2026-05-16) migrated debug-report delivery from a
  local/GitHub-PAT path to Sentry-only, **twelve days after** the last on-disk report.
  Reports created after the migration were never going to appear on disk regardless of
  whether uploads work — the on-disk silence from May 4–16 predates the very code path
  in question and proves nothing about it.
- The Sentry-side upload path (`mobile/src/utils/debugShare.js`) looks correct on
  inspection: it gates on `SENTRY_ENABLED` (non-empty DSN), tags events
  `kind: debug_report`, attaches photo + cropped photo, and sets `gear`/`camera`
  contexts including `algoDiag`.
- `b133` was confirmed **telemetry-dead** (DSN missing from the bundle — root cause:
  Expo project root is `mobile/`, and a bare `gradlew assembleRelease` never sourced
  repo-root `.env`) and is explicitly marked "DO NOT VALIDATE" on its release page.
  `b134` added `assert_sentry_dsn_bundled` (commit `51a4e99`) to both build scripts,
  refusing to publish an APK whose bundle is missing the DSN — QA cross-checked this
  with fixture APKs (present → pass, absent → refuse) and approved it. Every release
  from b134 through b137 has passed that guard.
- b135 additionally moved native Sentry init before JS load, and b136 removed a
  redundant JS-side re-init (bounded ANR-pattern risk, not a correctness bug) — neither
  change touches the upload path itself.
- **What could not be checked from here:** whether any `debug_report`-tagged event has
  actually landed in the Sentry project since the b125 migration. That requires either
  Sentry dashboard/API access (`$SENTRY_TRIAGE_TOKEN`, referenced in prior QA memory)
  or an operator physically confirming a send — **this sandbox does not have that
  token set**, and no working reference for obtaining it was found in the repo or
  environment. This is the same "no adb/emulator/kvm" capability gap as the rest of
  PAP-1671, applied to Sentry API access instead of device access.

**Conclusion:** the code-level evidence leans toward **(ii) — nobody has shot a photo
since the migration** rather than (i) a broken pipeline, because the guard rails added
since b133 are real and QA-verified, not just claimed. But this is not proof — it's an
absence-of-known-breakage argument, not a positive confirmation. **Step 1 above is the
actual test**; treat its result as authoritative over this paragraph.
