import { useCallback, useEffect, useRef, useState } from 'react';
import { useSharedValue } from 'react-native-reanimated';
import { useRunOnJS } from 'react-native-worklets-core';
import { Accelerometer, Gyroscope } from 'expo-sensors';
import { detectGearPresenceRGBA } from '../algorithm/gearDetector';

let useFrameProcessor;
try {
  ({ useFrameProcessor } = require('react-native-vision-camera'));
} catch {
  useFrameProcessor = null;
}

// ── Tuning constants ────────────────────────────────────────────────────────
// Frame-processor pixel-diff motion detection
const MOTION_THRESHOLD = 8;
const STABILITY_MS = 1000;
const NUM_SAMPLES = 300;
const FRAME_SKIP = 3;
// Gear detection (CRES) — run every Nth frame (heavier than pixel-diff)
const GEAR_DETECT_SKIP = 5;
// Gear detection hysteresis — tolerate brief CRES flickers without resetting
// stability timers.  At ~500 ms between CRES checks, 3 misses ≈ 1.5 s of
// no-gear before we clear the detection flag.
const GEAR_LOST_THRESHOLD = 3;
// IMU-based stillness detection (accelerometer + gyroscope)
const ACCEL_MOTION_THRESHOLD = 0.05;
const GYRO_MOTION_THRESHOLD = 0.12; // rad/s — rotation rate indicating motion
const IMU_UPDATE_MS = 100;
const IMU_STILLNESS_MS = 800; // shorter than old 4s — capture when user stops moving
const IMU_STILLNESS_FALLBACK_MS = 2000; // longer period for IMU-only mode (no CRES gate)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Hook that detects whether the device is stable enough for auto-capture.
 *
 * Three parallel detection paths run simultaneously:
 *   1. VisionCamera frame processor — pixel-diff motion detection
 *   2. IMU sensors (accelerometer + gyroscope) — physical stillness detection
 *   3. CRES gear shape pre-recognition — detects gear presence in frame
 *
 * Trigger logic: gear must be detected AND (IMU stable OR pixel stable).
 * If the gear disappears while stable, stability timers reset.
 *
 * Gear detection also produces approximate center/radius hints that
 * can speed up the main tooth-counting algorithm.
 */
export function useMotionDetection({ onStable, enabled = true }) {
  const [isStable, setIsStable] = useState(false);
  const [gearDetected, setGearDetected] = useState(false);
  const [gearHints, setGearHints] = useState(null);
  const prevSamples = useSharedValue(null);
  const frameCounter = useSharedValue(0);
  const gearDetectCounter = useSharedValue(0);
  const stabilityTimer = useRef(null);
  const gearWasDetectedRef = useRef(false);
  const gearLostCountRef = useRef(0);
  const imuTimer = useRef(null);
  const lastAccel = useRef(null);
  const latestGyro = useRef({ x: 0, y: 0, z: 0 });

  // Tracks whether the worklet has ever successfully read pixel data.
  const frameProcessorActiveRef = useRef(false);
  const usingFallbackRef = useRef(false);
  const [usingFallback, setUsingFallback] = useState(false);

  const clearTimer = useCallback(() => {
    if (stabilityTimer.current) {
      clearTimeout(stabilityTimer.current);
      stabilityTimer.current = null;
    }
  }, []);

  const handleMotionUpdate = useCallback(
    (meanDiff) => {
      const moving = meanDiff > MOTION_THRESHOLD;

      if (moving) {
        clearTimer();
        setIsStable(false);
      } else {
        if (!stabilityTimer.current) {
          stabilityTimer.current = setTimeout(() => {
            stabilityTimer.current = null;
            // Only trigger capture if a gear is detected in frame
            if (gearWasDetectedRef.current) {
              setIsStable(true);
              onStable?.();
            }
          }, STABILITY_MS);
        }
      }
    },
    [clearTimer, onStable],
  );

  // Called from worklet once with first-frame diagnostics
  const handleFrameDiag = useCallback((w, h, bytesPerRow, bufLen) => {
    console.log(
      `[FrameDiag] width=${w} height=${h} bytesPerRow=${bytesPerRow} ` +
      `bufLen=${bufLen} computedBpp=${(bufLen / (w * h)).toFixed(2)}`
    );
  }, []);
  const handleFrameDiagJS = useRunOnJS(handleFrameDiag, [handleFrameDiag]);
  const diagLogged = useSharedValue(false);

  // Called from worklet with gear detection result
  const cresLogCountRef = useRef(0);
  const handleGearDetection = useCallback(
    (detected, score, approxCenterX, approxCenterY, approxRadius, diag) => {
      // Diagnostic logging — first 10 results then every 10th
      cresLogCountRef.current += 1;
      const n = cresLogCountRef.current;
      if (n <= 10 || n % 10 === 0) {
        const d = diag || {};
        console.log(
          `[CRES #${n}] detected=${detected} score=${score?.toFixed(3)} ` +
          `bpp=${d.bpp} stride=${d.stride} var=${d.peakVariance?.toFixed(0)} donut=${d.donutRatio?.toFixed(2)} ` +
          `period=${d.periodicityRel?.toFixed(3)} freq=${d.peakFreq}`
        );
      }

      if (detected) {
        gearLostCountRef.current = 0;
        gearWasDetectedRef.current = true;
        setGearDetected(true);
        setGearHints({ centerX: approxCenterX, centerY: approxCenterY, radius: approxRadius, score });
      } else {
        gearLostCountRef.current += 1;

        // Hysteresis: tolerate brief CRES flickers. Only clear detection
        // state after GEAR_LOST_THRESHOLD consecutive misses (~1.5 s).
        if (gearLostCountRef.current >= GEAR_LOST_THRESHOLD) {
          const wasDetected = gearWasDetectedRef.current;
          gearWasDetectedRef.current = false;
          setGearDetected(false);
          setGearHints(null);

          if (wasDetected) {
            clearTimer();
            if (imuTimer.current) {
              clearTimeout(imuTimer.current);
              imuTimer.current = null;
            }
            setIsStable(false);
          }
        }
        // Under threshold: keep gearWasDetectedRef true so stability
        // timers continue through brief detection gaps.
      }
    },
    [clearTimer],
  );

  // Called from worklet when a buffer was read successfully — proves the
  // frame processor is alive on this device.
  const markFrameProcessorActive = useCallback(() => {
    frameProcessorActiveRef.current = true;
  }, []);

  // Called from worklet when toArrayBuffer() threw — logged once.
  // No arguments: passing strings through runOnJS triggers the broken
  // makeShareableCloneOnUIRecursiveLEGACY → _createSerializableString path.
  const reportFrameError = useCallback(() => {
    console.warn('[MotionDetection] Frame processor inactive: toArrayBuffer unavailable');
  }, []);

  // Worklet-safe JS callbacks for use inside the VisionCamera frame processor.
  // useRunOnJS (worklets-core) schedules via the worklets-core runtime;
  // reanimated's runOnJS calls scheduleOnJS which is not defined in that context.
  const handleMotionUpdateJS = useRunOnJS(handleMotionUpdate, [handleMotionUpdate]);
  const handleGearDetectionJS = useRunOnJS(handleGearDetection, [handleGearDetection]);
  const markFrameProcessorActiveJS = useRunOnJS(markFrameProcessorActive, [markFrameProcessorActive]);
  const reportFrameErrorJS = useRunOnJS(reportFrameError, [reportFrameError]);

  // ── Frame-processor availability tracking ───────────────────────────────
  // Track whether the frame processor is alive. If it never fires, set
  // usingFallback for UI purposes (IMU always runs regardless).
  useEffect(() => {
    if (!enabled) {
      usingFallbackRef.current = !useFrameProcessor;
      setUsingFallback(!useFrameProcessor);
      return;
    }
    frameProcessorActiveRef.current = false;
    usingFallbackRef.current = !useFrameProcessor;
    setUsingFallback(!useFrameProcessor);

    // Give the frame processor a brief window to prove it works.
    const check = setTimeout(() => {
      if (!frameProcessorActiveRef.current) {
        console.warn('[MotionDetection] No frames processed — IMU-only mode');
        usingFallbackRef.current = true;
        setUsingFallback(true);
      }
    }, 1500);

    return () => clearTimeout(check);
  }, [enabled]);

  // ── IMU-based capture trigger (accelerometer + gyroscope) ──────────────
  // Runs in parallel with the frame processor from the start. Triggers
  // capture when the device has been physically still for IMU_STILLNESS_MS.
  // This replaces the old 4s timer gate — no blind waiting.
  useEffect(() => {
    if (!enabled) return;

    Accelerometer.setUpdateInterval(IMU_UPDATE_MS);
    Gyroscope.setUpdateInterval(IMU_UPDATE_MS);

    const accelSub = Accelerometer.addListener(({ x, y, z }) => {
      const gyro = latestGyro.current;
      const gyroRate = Math.sqrt(gyro.x * gyro.x + gyro.y * gyro.y + gyro.z * gyro.z);

      if (lastAccel.current !== null) {
        const dx = x - lastAccel.current.x;
        const dy = y - lastAccel.current.y;
        const dz = z - lastAccel.current.z;
        const accelDelta = Math.sqrt(dx * dx + dy * dy + dz * dz);

        const isMoving = accelDelta > ACCEL_MOTION_THRESHOLD || gyroRate > GYRO_MOTION_THRESHOLD;

        if (isMoving) {
          // Device is moving — cancel any pending stability trigger.
          if (imuTimer.current) {
            clearTimeout(imuTimer.current);
            imuTimer.current = null;
          }
          setIsStable(false);
        } else if (!imuTimer.current) {
          // Device is still — start stillness countdown.
          // In fallback (IMU-only) mode use a longer window and skip CRES gate.
          const fallback = usingFallbackRef.current;
          const stillnessMs = fallback ? IMU_STILLNESS_FALLBACK_MS : IMU_STILLNESS_MS;
          imuTimer.current = setTimeout(() => {
            imuTimer.current = null;
            if (gearWasDetectedRef.current || fallback) {
              setIsStable(true);
              onStable?.();
            }
          }, stillnessMs);
        }
      }

      lastAccel.current = { x, y, z };
    });

    const gyroSub = Gyroscope.addListener(({ x, y, z }) => {
      latestGyro.current = { x, y, z };
    });

    return () => {
      accelSub.remove();
      gyroSub.remove();
      if (imuTimer.current) {
        clearTimeout(imuTimer.current);
        imuTimer.current = null;
      }
      lastAccel.current = null;
      latestGyro.current = { x: 0, y: 0, z: 0 };
    };
  }, [enabled, onStable]);

  // ── Build frame processor ──────────────────────────────────────────────
  let frameProcessor = undefined;
  if (useFrameProcessor) {
    try {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      frameProcessor = useFrameProcessor(
        (frame) => {
          'worklet';
          if (!enabled) return;

          frameCounter.value += 1;
          if (frameCounter.value % FRAME_SKIP !== 0) return;

          let buffer;
          try {
            buffer = frame.toArrayBuffer();
          } catch (e) {
            reportFrameErrorJS();
            return;
          }

          // Signal to JS side that the frame processor is working.
          markFrameProcessorActiveJS();

          const pixels = new Uint8Array(buffer);
          const total = pixels.length;
          if (total === 0) return;

          // Log first-frame diagnostics (once) to aid on-device debugging.
          if (!diagLogged.value) {
            diagLogged.value = true;
            handleFrameDiagJS(frame.width, frame.height, frame.bytesPerRow, total);
          }

          // ── Pixel-diff motion detection ─────────────────────────────────
          const step = Math.floor(total / NUM_SAMPLES);
          // Use a plain Array — Float32Array triggers the broken legacy
          // makeShareableCloneOnUIRecursiveLEGACY serialization path when
          // assigned to a shared value.
          const samples = new Array(NUM_SAMPLES);
          for (let i = 0; i < NUM_SAMPLES; i++) {
            samples[i] = pixels[i * step] ?? 0;
          }

          if (prevSamples.value !== null) {
            let diff = 0;
            for (let i = 0; i < NUM_SAMPLES; i++) {
              diff += Math.abs(samples[i] - prevSamples.value[i]);
            }
            handleMotionUpdateJS(diff / NUM_SAMPLES);
          }

          prevSamples.value = samples;

          // ── CRES gear detection (every GEAR_DETECT_SKIP-th processed frame)
          gearDetectCounter.value += 1;
          if (gearDetectCounter.value % GEAR_DETECT_SKIP === 0) {
            const w = frame.width;
            const h = frame.height;
            if (w > 0 && h > 0) {
              try {
                const result = detectGearPresenceRGBA(pixels, w, h, frame.bytesPerRow);
                handleGearDetectionJS(
                  result.detected, result.score,
                  result.approxCenterX, result.approxCenterY,
                  result.approxRadius,
                  result._diag,
                );
              } catch (_e) {
                // CRES threw — report but don't crash the frame processor
                reportFrameErrorJS();
              }
            }
          }
        },
        [enabled, handleMotionUpdateJS, handleGearDetectionJS, markFrameProcessorActiveJS, reportFrameErrorJS, handleFrameDiagJS],
      );
    } catch {
      // Worklets runtime unavailable at this point — fall back to manual capture.
      frameProcessor = undefined;
    }
  }

  const reset = useCallback(() => {
    clearTimer();
    if (imuTimer.current) {
      clearTimeout(imuTimer.current);
      imuTimer.current = null;
    }
    lastAccel.current = null;
    latestGyro.current = { x: 0, y: 0, z: 0 };
    gearWasDetectedRef.current = false;
    gearLostCountRef.current = 0;
    setIsStable(false);
    setGearDetected(false);
    setGearHints(null);
    prevSamples.value = null;
    frameCounter.value = 0;
    gearDetectCounter.value = 0;
    diagLogged.value = false;
  }, [clearTimer, prevSamples, frameCounter, gearDetectCounter, diagLogged]);

  return { isStable, gearDetected, gearHints, frameProcessor, reset, usingFallback };
}
