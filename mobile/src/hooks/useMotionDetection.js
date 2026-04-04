import { useCallback, useEffect, useRef, useState } from 'react';
import { useSharedValue } from 'react-native-reanimated';
import { useRunOnJS } from 'react-native-worklets-core';
import { Accelerometer } from 'expo-sensors';

let useFrameProcessor;
try {
  ({ useFrameProcessor } = require('react-native-vision-camera'));
} catch {
  useFrameProcessor = null;
}

// ── Tuning constants ────────────────────────────────────────────────────────
const MOTION_THRESHOLD = 8;
const STABILITY_MS = 1000;
const NUM_SAMPLES = 300;
const FRAME_SKIP = 3;
// How long to wait after `enabled` before deciding the frame processor is broken.
const FALLBACK_CHECK_MS = 4000;
// Accelerometer-based fallback: magnitude change threshold to detect motion.
const ACCEL_MOTION_THRESHOLD = 0.05;
// Accelerometer update interval in ms.
const ACCEL_UPDATE_MS = 100;
// ───────────────────────────────────────────────────────────────────────────

/**
 * Hook that uses VisionCamera v4 frame processors to detect whether the
 * gear is moving or stationary.
 *
 * If frame processors are unavailable, OR if toArrayBuffer() fails silently
 * on this device, a timer-based fallback auto-triggers after a short delay.
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

  // ── Fallback detection ─────────────────────────────────────────────────
  // If enabled for FALLBACK_CHECK_MS without receiving any pixel data from
  // the worklet, assume toArrayBuffer() is broken on this device and switch
  // to a simple timer-based trigger.
  useEffect(() => {
    if (!enabled) {
      setUsingFallback(false);
      return;
    }
    frameProcessorActiveRef.current = false;
    setUsingFallback(false);

    const check = setTimeout(() => {
      if (!frameProcessorActiveRef.current) {
        console.warn('[MotionDetection] No frames processed — using timer fallback');
        setUsingFallback(true);
      }
    }, FALLBACK_CHECK_MS);

    return () => clearTimeout(check);
  }, [enabled]);

  // ── Fallback auto-trigger (accelerometer-based) ────────────────────────
  // Instead of blindly firing after a timer, subscribe to the accelerometer
  // and only trigger when the device has been physically stable for STABILITY_MS.
  const accelTimer = useRef(null);
  const lastAccel = useRef(null);

  useEffect(() => {
    if (!usingFallback || !enabled) return;

    Accelerometer.setUpdateInterval(ACCEL_UPDATE_MS);
    const subscription = Accelerometer.addListener(({ x, y, z }) => {
      if (lastAccel.current !== null) {
        // Compare per-axis vector distance, not just magnitude delta.
        // Total magnitude (sqrt(x²+y²+z²)) stays near 1g even during motion,
        // so magnitude-only comparison misses tilts and lateral movement.
        const dx = x - lastAccel.current.x;
        const dy = y - lastAccel.current.y;
        const dz = z - lastAccel.current.z;
        const delta = Math.sqrt(dx * dx + dy * dy + dz * dz);

        if (delta > ACCEL_MOTION_THRESHOLD) {
          // Device is moving — cancel any pending stability trigger.
          if (accelTimer.current) {
            clearTimeout(accelTimer.current);
            accelTimer.current = null;
          }
          setIsStable(false);
        } else if (!accelTimer.current) {
          // Device is still — start stability countdown.
          accelTimer.current = setTimeout(() => {
            accelTimer.current = null;
            setIsStable(true);
            onStable?.();
          }, STABILITY_MS);
        }
      }

      lastAccel.current = { x, y, z };
    });

    return () => {
      subscription.remove();
      if (accelTimer.current) {
        clearTimeout(accelTimer.current);
        accelTimer.current = null;
      }
      lastAccel.current = null;
    };
  }, [usingFallback, enabled, onStable]);

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
    if (accelTimer.current) {
      clearTimeout(accelTimer.current);
      accelTimer.current = null;
    }
    lastAccel.current = null;
    setIsStable(false);
    prevSamples.value = null;
    frameCounter.value = 0;
  }, [clearTimer, prevSamples, frameCounter]);

  return { isStable, frameProcessor, reset, usingFallback };
}
