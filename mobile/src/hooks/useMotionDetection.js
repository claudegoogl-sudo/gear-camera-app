import { useCallback, useRef, useState } from 'react';
import { useSharedValue, runOnJS } from 'react-native-reanimated';
import { useFrameProcessor } from 'react-native-vision-camera';

// ── Tuning constants ────────────────────────────────────────────────────────
// Mean per-sample pixel difference that counts as "motion".
// Lower → more sensitive.  8 works well for typical workshop lighting.
const MOTION_THRESHOLD = 8;

// How long the gear must be still (ms) before onStable fires.
const STABILITY_MS = 500;

// Number of evenly-spaced pixel samples taken per frame.
// Fewer = faster but less accurate; 300 is a good balance.
const NUM_SAMPLES = 300;

// Only process every Nth frame to keep CPU usage low (~30fps ÷ 3 = 10fps).
const FRAME_SKIP = 3;
// ───────────────────────────────────────────────────────────────────────────

/**
 * Hook that uses VisionCamera v4 frame processors to detect whether the
 * gear is moving or stationary.
 *
 * Usage:
 *   const { isStable, frameProcessor } = useMotionDetection({
 *     onStable: handleCapture,
 *     enabled: !isProcessing,
 *   });
 *
 * Returns:
 *   isStable        — boolean, true when gear has been still for STABILITY_MS
 *   frameProcessor  — pass directly to <Camera frameProcessor={...} />
 */
export function useMotionDetection({ onStable, enabled = true }) {
  const [isStable, setIsStable] = useState(false);

  // Shared values live on the worklet thread — no JS round-trip needed.
  const prevSamples = useSharedValue(null);
  const frameCounter = useSharedValue(0);

  // Stability timer runs on the JS thread.
  const stabilityTimer = useRef(null);

  const clearTimer = useCallback(() => {
    if (stabilityTimer.current) {
      clearTimeout(stabilityTimer.current);
      stabilityTimer.current = null;
    }
  }, []);

  // Called from worklet via runOnJS on every processed frame.
  const handleMotionUpdate = useCallback(
    (meanDiff) => {
      const moving = meanDiff > MOTION_THRESHOLD;

      if (moving) {
        clearTimer();
        setIsStable(false);
      } else {
        // Start timer only if one isn't already running.
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

  const frameProcessor = useFrameProcessor(
    (frame) => {
      'worklet';
      if (!enabled) return;

      // Skip frames to reduce CPU load.
      frameCounter.value += 1;
      if (frameCounter.value % FRAME_SKIP !== 0) return;

      // Get raw pixel bytes.  We sample evenly across the whole buffer so
      // the result is format-agnostic (YUV, RGB, BGRA — we only need change).
      const buffer = frame.toArrayBuffer();
      const pixels = new Uint8Array(buffer);
      const total = pixels.length;
      if (total === 0) return;

      const step = Math.floor(total / NUM_SAMPLES);
      const samples = new Array(NUM_SAMPLES);
      for (let i = 0; i < NUM_SAMPLES; i++) {
        samples[i] = pixels[i * step] ?? 0;
      }

      // Compare with previous frame.
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

  // Expose a reset so CameraScreen can clear stable state after capture.
  const reset = useCallback(() => {
    clearTimer();
    setIsStable(false);
    prevSamples.value = null;
    frameCounter.value = 0;
  }, [clearTimer, prevSamples, frameCounter]);

  return { isStable, frameProcessor, reset };
}
