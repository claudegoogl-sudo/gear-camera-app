# PAP-1708: policyRetry re-acquire analysis (b132 wrong-counts ff4aa59f / c325dbba)

Evidence: Sentry debug_report events (dumped as `pap1708_ff4aa59f_sentry.json`,
`pap1708_c325dbba_sentry.json` next to this file). Fix: commit 7cb304f.

## Ask 1 — does framing guidance / zoom state survive camera re-init?

**Zoom/FOV: ruled out.** `<Camera>` never receives a `zoom` prop, and both
events re-acquired the *same* device (id "0", `selectedWideAngle: true`)
before and after the retry — no FOV change is possible across the remount.

**Guidance text: derived, re-shows automatically** — but it was irrelevant,
because the real survivor was the **auto-capture trigger state** in
`useMotionDetection`:

- `reset()` only ran on navigation focus and at capture start — never on
  session loss (policy error / policyRetry / wide→main fallback).
- `lastMotionTimeRef` went stale for the whole restriction window
  (37 s in ff4aa59f, 60 s in c325dbba) → `stillnessMs` was enormous → the
  CRES-primary trigger (`stillnessMs >= 300ms`) passed on the **first**
  CRES-positive frame after re-acquire.
- `cresConsecutiveHitsRef` also survived (already ≥3 mid-aim), so the
  consecutive-hit bypass path passed instantly too.
- Result: auto-capture fired while the operator was still re-framing.
  Captures landed **4.0 s / 8.4 s after camera re-initialization**, with the
  36T chainring overfilling the reticle (~1.8×) → detector latched the inner
  ring → 13T / 11T at conf 0 (PAP-1707 signature).

### Timeline (ff4aa59f)
```
12:45:28.6  initialized (retryKey 0, wide-angle, device 0)
12:45:41.3  error system/camera-is-restricted        ← mid-aim, 13s after init
12:45:41.4  torch drops off
             … 37s gap, no appState events logged …
12:46:18.3  appState active + policyRetry (retryKey 1)
12:46:18.8  initialized (retryKey 1, same device 0)
12:46:22.9  capture                                   ← 4.0s after re-init
```
c325dbba identical shape: error 6.6s after init, 60s gap, capture 8.4s after
re-init.

## Ask 2 — what triggers policyRestricted on FP5?

`system/camera-is-restricted` maps from CameraX
`CameraState onError(ERROR_CAMERA_DISABLED)` (vision-camera
`StateError+toCameraError.kt`) — an OS-level camera disable. App
backgrounding produces `ERROR_CAMERA_IN_USE` (`system/camera-in-use`), a
different code, so backgrounding alone is **not** this error.

Plausible FP5 causes: the Android 12+ global **Camera-access privacy toggle**
(Quick Settings / Settings→Privacy), keyguard/MDM policy. The b132 telemetry
**cannot distinguish them retroactively**: the AppState listener previously
attached only *after* `isPolicyRestricted` flipped true, so any pre-error
background transition is unrecorded. Notably both events show **zero**
appState events between error and recovery, i.e. no logged backgrounding
while restricted — consistent with a quick-settings shade interaction, but
the pre-error window is blind. Fix instruments all AppState transitions so
the next occurrence is answerable.

Surfacing: previously "Camera blocked by OS — unlock your phone" (assumed
keyguard). Now names both remedies: "Camera disabled by OS — re-enable
camera access (Quick Settings privacy toggle) or unlock, then tap Retry".

## Fix (7cb304f)

1. `motionStateReset` on every `isCameraReady` true→false transition —
   covers policy error, policyRetry (AppState + button),
   postPolicyAutoRetry, wide→main fallback (the latter also clears stale
   cross-lens `prevSamples`). Post-recovery captures now require fresh CRES
   detection + stillness, identical to a fresh session.
2. `recoveryGuidance` — "Camera recovered — fit the gear inside the circle"
   shown 6s once the re-acquired camera is ready (`recoveryGuidanceShown`
   breadcrumb).
3. Global AppState logging (deduped against the restricted listener).
4. Updated policy-restricted hint/top-bar strings.

## QA device checks (next build)

1. Trigger a policy restriction mid-aim (Quick Settings camera toggle off→on,
   or lock/unlock): expect `error` → `appState(active)` → `policyRetry` →
   `motionStateReset` → `initialized` → `recoveryGuidanceShown` in
   cameraEvents, and NO auto-capture until a fresh CRES detection + ~1.5s
   stillness.
2. Confirm the recovery hint text shows for ~6s after the preview returns.
3. Algorithm-side overfill behavior unchanged (PAP-1707 scope).
