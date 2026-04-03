import { useCallback, useRef, useState } from 'react';
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
// ───────────────────────────────────────────────────────────────────────────

/**
 * Hook that uses VisionCamera v4 frame processors to detect whether the
 * gear is moving or stationary.
 *
 * If frame processors are unavailable (missing worklets-core), this hook
 * returns a no-op frameProcessor so the camera still works for manual capture.
 */
export function useMotionDetection({ onStable, enabled = true }) {
  const [isStable, setIsStable] = useState(false);
  const prevSamples = useSharedValue(null);
  const frameCounter = useSharedValue(0);
  const stabilityTimer = useRef(null);

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

  // Build frame processor only if the hook is available.
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
          } catch {
            return; // toArrayBuffer unavailable on this device/SDK version
          }
          const pixels = new Uint8Array(buffer);
          const total = pixels.length;
          if (total === 0) return;

          const step = Math.floor(total / NUM_SAMPLES);
          const samples = new Array(NUM_SAMPLES);
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
        [enabled, handleMotionUpdate],
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

  return { isStable, frameProcessor, reset };
}
