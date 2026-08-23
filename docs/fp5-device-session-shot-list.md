# FP5 Device Session — Batched Shot List

> **Updated 2026-08-23 (CEO).** The telemetry question this list was built around is
> **already answered** — debug reports have been reaching Sentry all along, most
> recently 2026-08-19 from this same FP5. See
> [`device-telemetry-sentry-2026-08-23.md`](./device-telemetry-sentry-2026-08-23.md).
> Step 1 below is rescoped accordingly (it now tests b137 specifically, not the
> pipeline), and Step 3 is downgraded because the device already told us its stage
> timings. **Step 2 is now the reason to run this session at all.** Revised total:
> ~17 minutes.

**Total time: ~17 minutes** (was 22; Steps 1 and 3 shrank — see the note below). One build. Do the steps in order — if you run out of time,
stop after any step and everything already done keeps its full value. Nothing later
invalidates anything earlier.

## The build

**Release b141**, tag `b141`:
https://github.com/claudegoogl-sudo/gear-camera-app/releases/tag/b141
Asset: `gear-camera-release-2026-08-23.08.47-b141.apk`

b141 is the current production build and includes the motion-state reset fix (PAP-1708) and the corrected 45000ms wall-clock budget (PAP-1683). One install covers all four steps.

**⚠️ DO NOT INSTALL b137** — b137 shipped with WALL_CLOCK_BUDGET_MS=5000, which causes a 100% abstain rate on real FP5 photos (the 5s budget is exhausted before the algorithm even starts). Use b141 instead.

**What b141 cannot evidence:** nothing in this list — it's the latest build and includes
the motion-state reset fix (PAP-1708) and the corrected 45000ms wall-clock budget
(PAP-1683). (If you're instead asked to validate an *older* build like b130/b134/b135
specifically, use that build's own release page — this list assumes b141.)

Install: uninstall any existing debug/release build of the app first (mixed
debug+release installs on the same device can throw a signature-mismatch error), then
sideload the APK and open it once to let it finish first-launch setup before step 1.

---

## Step 1 — Does b141 still send? (4 min)

**Why:** the upload pipeline is **known good** — we have debug reports in Sentry from
this device on builds b129 and b132, the newest dated 2026-08-19. What is *not* known
is whether **b141** still sends, because no device has ever run b134 or later. b133 had
a build where the Sentry key was missing from the bundle; b134 added a guard against
that, but the guard has only ever been checked on a desktop, never confirmed by an
actual report arriving from a b134+ build. This step closes that one gap. It also
double-serves as the send-back channel for Steps 2 and 3, so do it first regardless.

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
just runs. b141 adds a hard 45-second wall-clock deadline meant to cut that to roughly
50s worst case (bounded overshoot, not millisecond-tight) by abstaining instead of
grinding to completion. Ordinary gears currently take ~30-40s on this phone, so the
deadline is set above normal operation to catch only the pathological freeze tail.

**What to do:**
1. Find a **front chainring** — the largest gear on a bike, mounted near the pedals
   (not a rear cassette gear). Fill as much of the frame as you comfortably can.
2. Take the photo. Start your phone's stopwatch the moment you tap the shutter; stop it
   when the result screen appears (count, or an abstain message).
3. Repeat for 2–3 different chainrings if you have access to more than one bike.

**Pass looks like:** result (a count, or an "unable to determine" abstain) appears
within **~50 seconds** (bounded overshoot above the 45s budget). No indefinite spinner.

**For reference, what the device did before this fix:** two chainring reports from
build b129 took **70.0 s** and **93.5 s**. Those are the real measured numbers this
step is trying to beat, not an estimate. Note also that *ordinary* gears currently take
~36 s on this phone — so a chainring landing at ~10 s is the pass, but do not be
surprised that everything is slow; that is a separate, larger problem we are tracking.

**Fail looks like:** the app hangs/freezes for 30+ seconds with no response to touch.

**Send back:** the stopwatch time for each shot, plus whether it returned a count or
abstained. If a shot freezes past 20s, force-close the app and note that as the result
for that shot — don't wait out a suspected regression.

---

## Step 3 — Stage timings / ABI trim (4 min, optional — cut this first if short on time)

**Why (reduced):** we already have this number from telemetry — the device reports
~35–37 seconds total per ordinary gear, of which ~30 s is the `detect` stage. Desktop
said 5757 ms and 977 ms; both were wrong by 6x and 37x respectively. So this step is no
longer discovery, just confirmation that b141 didn't change the picture. **If you are
short on time, skip this one and do Step 4 instead.**

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
4. **If you see a "Camera recovered — fit the gear inside the circle" message** (new in
   b141, PAP-1708), screenshot it — this confirms the motion-state reset recovery
   guidance is working after a camera interruption.

**Pass looks like:** consistent cold-start time across the 3 launches (no launch
noticeably slower than the others), no visible hang on the splash screen.

**Fail looks like:** one or more launches hangs for several seconds longer than the
others, or the app crashes on launch.

**Send back:** the 3 cold-start stopwatch numbers, crash/no-crash, and a screenshot if you see the recovery guidance message.

---

## Telemetry conclusion (Part 1a) — SUPERSEDED 2026-08-23

The original version of this section reasoned from code alone and concluded "probably
nobody has shot a photo since May." That was wrong, and it was wrong because nobody had
queried Sentry — the triage token lives in the repo's `.env`, not in the environment, so
a `env | grep SENTRY` came back empty and the check was written off as impossible.

**Actual answer:** the pipeline works and the phone has been reporting all along.
`debug_report`, `training_sample` and `chainring_abstain` events are present for builds
b129 and b132, the newest on 2026-08-19. Full evidence, the query runbook, and what it
means for the speed target are in
[`device-telemetry-sentry-2026-08-23.md`](./device-telemetry-sentry-2026-08-23.md).

The one thing telemetry cannot tell us is whether **b141** still sends, since
no device has run a build newer than b132. That residue is Step 1 above.
