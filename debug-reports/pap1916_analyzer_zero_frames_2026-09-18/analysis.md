# PAP-1916 — FP5 analyzer zero-frames (b157): findings (Mobile, 2026-09-18)

Code head at analysis: `c3a9e02` (zero code past b157 `84a340f`).
Raw evidence: `evidence.json` in this directory (Sentry-pulled, agent-read).

## Verdict

1. **The PAP-1882 format-selection path cannot leave the frame analyzer unsubscribed** —
   structural (code) + telemetry proof, see §2.
2. **The symptom is NOT new-in-b157**: the identical zero-frames-at-session-start failure
   occurred 3x on **b153** on the same FP5 / same user (09-11 breadcrumbs), with an
   analyzer-ALIVE session in the same burst. The "b153 shows no such marker" premise in the
   ticket is an artifact of the `frameProcessorTimeout` marker first shipping in b154
   (`3571f78`); the console string quoted in this ticket — `[MotionDetection] No frames
   processed — IMU-only mode` — fired repeatedly on b153 (17:32:17.97, 17:35:04.29,
   17:36:01.53), and session 17:38:18.2 shows `[FrameDiag] 640x480` at +0.36s + `CRES #1..7`.
3. No code change (single occurrence, per action 2). Escalation triggers unchanged.
   Recovery path that works today: leave + re-enter the camera screen (fresh session);
   b153 17:38 proves cross-session recovery. In-session recovery never fired in any dead
   session of either build.

## 1. The b157 occurrence — full timeout payload (Sentry ace8f58c cameraEvents)

The ticket quoted waitedMs/workletRuns/processedFrames only. The full event also carries:

- `frameProcessorAvailable: true`, `frameProcessorBuilt: true`, `nativePluginInstalled: true`
  → JS side loaded, `useFrameProcessor` built the processor, extractYPlane native plugin registered.
- `bufferFailures: 0`, `lastFailure: null`, `lastPixelFormat: null`
  → the worklet was **never invoked** — it did not even see a frame's pixelFormat.
  (workletRunCount increments BEFORE the enabled gate, so any delivered frame would count.)
- `retryKey: 0`, `cameraErrors: []` for the whole session → CameraX never errored.
- No `frameProcessorFirstFrame` ever → analyzer stayed dead the entire session
  (through last capture 09:20:51).
- Session context: app cold start 09:20:02; camera gen-1 ready ~09:20:05.8;
  **activity destroyed+recreated TWICE** 09:20:12.72–13.18 (CONFIGURATION_CHANGED +
  LOCALE_CHANGED); the dead session is gen-2 (initialized 09:20:13.883, `alreadyReady:false`).

So: frames reached neither the worklet nor the buffer-extraction stage, while preview
streamed, 3 photos captured (aspectParity TRUE x3) and photo-path detection completed.
A busy JS thread is ruled out (workletRunCount increments on the worklet thread, not JS).

## 2. Can format selection unsubscribe the analyzer? No.

- Analyzer membership in the CameraX session is decided by `enableFrameProcessor`
  (derived from the `frameProcessor` prop) — `CameraView.kt update()` (config.frameProcessor
  Enabled/Disabled). `format` only feeds ResolutionSelectors
  (`CameraSession+Configuration.kt` §1 Preview / §2 Photo / §3 Video / §4 Frame Processor).
- `forSize()` is a **soft** sort (`ResolutionSelector+forSize.kt`): orders supported sizes by
  aspect+pixel proximity, never empties the candidate set. It cannot unbind a stream.
- CameraX **accepted** the combination: `onInitialized` fires after `bindToLifecycle`
  including `frameProcessorOutput`; an unsupported combination throws → `onError`.
  `cameraErrors` stayed empty all session.
- The QA-flagged size coupling (analysis = format.videoSize, up to ~9x pixels) **did not
  engage on FP5**: resolved `aimFormat.videoSize = 640x480` == the no-format CameraX
  default actually negotiated on b153 (`[FrameDiag] width=640 height=480`).
  b157 `initialized`: `analysisWidth/Height 640/480, analysisTarget format.videoSize`.
- Why 640x480: `AIM_FORMAT_FILTERS` pins `videoAspectRatio 4/3` (prio 2) and
  `photoResolution max` (prio 1) but has **no videoResolution filter** — among formats tied
  on (video aspect, photo pixels) the first in device order wins → smallest 4:3 video size.
  Net effect on FP5: preview+video+analysis all pinned 640x480 (three identical-size
  streams) + photo 4096x3072. NOTE: the coupling stays armed for devices whose format lists
  order differently (a larger 4:3 video would raise the analysis stream); the
  `analysisTarget` telemetry exists precisely to watch that.

## 3. Open hypotheses (both pre-existing, build-independent)

- **H1 — OEM HAL delivery stall**: the Xiaomi HAL intermittently delivers zero frames to
  the ImageAnalysis stream at session start while preview/photo continue. Matches b153+b157.
- **H2 — session-churn JSI binding race**: `onViewReady → VisionCameraProxy.setFrameProcessor`
  posts to the UI thread and resolves the view (`findCameraViewById`); `Camera.tsx`
  rebinds only on frameProcessor identity change, and our fp identity is stable — a missed
  binding at session start never heals within the session and yields exactly
  `workletRuns=0` with zero cameraErrors. The 09-18 dead session is the only one preceded
  by a double activity recreation; b153's dead sessions followed camera-screen remounts —
  session churn in both cases.
- Not discriminable with current telemetry: `workletRunCount` is the only probe on the
  delivery path; no native `analyze()` counter is exported (fps collector is fps-graph-only).

## 4. On recurrence — collect before app reload

`adb logcat -s CameraSession VisionCameraProxy CameraView` around session start:
- `Creating YUV Frame Processor output...` + `Binding N use-cases...` present, no analyze → H1.
- `Finding view N... Couldn't find view` / no `setFrameProcessor` binding → H2.
Plus a debug share (cameraEvents already carry the counters since b154).
