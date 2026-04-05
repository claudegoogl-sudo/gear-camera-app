import { useCallback, useEffect, useRef, useState } from 'react';
import { useSharedValue } from 'react-native-reanimated';
import { useRunOnJS } from 'react-native-worklets-core';
import { Accelerometer, Gyroscope } from 'expo-sensors';

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
// IMU-based stillness detection (accelerometer + gyroscope)
const ACCEL_MOTION_THRESHOLD = 0.05;
const GYRO_MOTION_THRESHOLD = 0.12; // rad/s — rotation rate indicating motion
const IMU_UPDATE_MS = 100;
const IMU_STILLNESS_MS = 800; // shorter than old 4s — capture when user stops moving
// ───────────────────────────────────────────────────────────────────────────

/**
 * Hook that detects whether the device is stable enough for auto-capture.
 *
 * Two parallel detection paths run simultaneously:
 *   1. VisionCamera frame processor — pixel-diff motion detection
 *   2. IMU sensors (accelerometer + gyroscope) — physical stillness detection
 *
 * Either path detecting stability triggers the onStable callback.
 * The IMU path starts immediately (no timer gate), so capture responds to
 * physical stillness within ~800ms of the user holding the device still.
 */
export function useMotionDetection({ onStable, enabled = true }) {
  const [isStable, setIsStable] = useState(false);
  const prevSamples = useSharedValue(null);
  const frameCounter = useSharedValue(0);
  const stabilityTimer = useRef(null);

  // Tracks whether the worklet has ever successfully read pixel data.
  const frameProcessorActiveRef = useRef(false);
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
            setIsStable(true);
            onStable?.();
          }, STABILITY_MS);
        }
      }
    },
    [clearTimer, onStable],
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
  const markFrameProcessorActiveJS = useRunOnJS(markFrameProcessorActive, [markFrameProcessorActive]);
  const reportFrameErrorJS = useRunOnJS(reportFrameError, [reportFrameError]);

  // ── Frame-processor availability tracking ───────────────────────────────
  // Track whether the frame processor is alive. If it never fires, set
  // usingFallback for UI purposes (IMU always runs regardless).
  useEffect(() => {
    if (!enabled) {
      setUsingFallback(!useFrameProcessor);
      return;
    }
    frameProcessorActiveRef.current = false;
    setUsingFallback(!useFrameProcessor);

    // Give the frame processor a brief window to prove it works.
    const check = setTimeout(() => {
      if (!frameProcessorActiveRef.current) {
        console.warn('[MotionDetection] No frames processed — IMU-only mode');
        setUsingFallback(true);
      }
    }, 1500);

    return () => clearTimeout(check);
  }, [enabled]);

  // ── IMU-based capture trigger (accelerometer + gyroscope) ──────────────
  // Runs in parallel with the frame processor from the start. Triggers
  // capture when the device has been physically still for IMU_STILLNESS_MS.
  // This replaces the old 4s timer gate — no blind waiting.
  const imuTimer = useRef(null);
  const lastAccel = useRef(null);
  const latestGyro = useRef({ x: 0, y: 0, z: 0 });

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
          imuTimer.current = setTimeout(() => {
            imuTimer.current = null;
            setIsStable(true);
            onStable?.();
          }, IMU_STILLNESS_MS);
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
        },
        [enabled, handleMotionUpdateJS, markFrameProcessorActiveJS, reportFrameErrorJS],
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
    setIsStable(false);
    prevSamples.value = null;
    frameCounter.value = 0;
  }, [clearTimer, prevSamples, frameCounter]);

  return { isStable, frameProcessor, reset, usingFallback };
}
