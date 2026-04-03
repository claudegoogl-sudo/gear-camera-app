import { useCallback, useEffect, useRef, useState } from 'react';
import { useSharedValue, runOnJS } from 'react-native-reanimated';

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
// How long to wait in fallback mode before auto-triggering.
const FALLBACK_STABLE_MS = 1500;
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
  const reportFrameError = useCallback((msg) => {
    console.warn('[MotionDetection] Frame processor inactive:', msg);
  }, []);

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

  // ── Fallback auto-trigger ──────────────────────────────────────────────
  useEffect(() => {
    if (!usingFallback || !enabled) return;

    const trigger = setTimeout(() => {
      if (enabled) {
        setIsStable(true);
        onStable?.();
      }
    }, FALLBACK_STABLE_MS);

    return () => clearTimeout(trigger);
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
            runOnJS(reportFrameError)(e?.message ?? 'toArrayBuffer unavailable');
            return;
          }

          // Signal to JS side that the frame processor is working.
          runOnJS(markFrameProcessorActive)();

          const pixels = new Uint8Array(buffer);
          const total = pixels.length;
          if (total === 0) return;

          const step = Math.floor(total / NUM_SAMPLES);
          const samples = new Float32Array(NUM_SAMPLES);
          for (let i = 0; i < NUM_SAMPLES; i++) {
            samples[i] = pixels[i * step] ?? 0;
          }

          if (prevSamples.value !== null) {
            let diff = 0;
            for (let i = 0; i < NUM_SAMPLES; i++) {
              diff += Math.abs(samples[i] - prevSamples.value[i]);
            }
            runOnJS(handleMotionUpdate)(diff / NUM_SAMPLES);
          }

          prevSamples.value = samples;
        },
        [enabled, handleMotionUpdate, markFrameProcessorActive, reportFrameError],
      );
    } catch {
      // Worklets runtime unavailable at this point — fall back to manual capture.
      frameProcessor = undefined;
    }
  }

  const reset = useCallback(() => {
    clearTimer();
    setIsStable(false);
    prevSamples.value = null;
    frameCounter.value = 0;
  }, [clearTimer, prevSamples, frameCounter]);

  return { isStable, frameProcessor, reset, usingFallback };
}
