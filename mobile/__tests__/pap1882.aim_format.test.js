/**
 * PAP-1882 — WYSIWYG aim format selection.
 *
 * FP5 operator report (b153): the aiming-screen camera differs from the
 * capture camera. Root cause: CameraScreen passed no `format`, so the
 * preview stream's aspect was left to the HAL (commonly 16:9) while the
 * photo is the full 4:3 sensor readout — the on-screen reticle then maps to
 * a different scene region than cropToAimCircle's photo-space crop.
 *
 * These tests pin the selection contract of resolveAimFormat using the REAL
 * vision-camera getCameraFormat scoring on synthetic devices:
 *   - a 4:3-video format must win over a 16:9-video one (aspect parity is
 *     the whole point — preview follows the format's video size);
 *   - among aspect-tied formats, max photo resolution must win;
 *   - guard cases must yield undefined (never throw, never constrain the
 *     session) so devices/mocks without formats keep today's behavior.
 */
// Swap the vision-camera package index (which initializes the native camera
// module at import time) for its real, pure format-scoring implementation —
// same getCameraFormat the app runs, without the native side effect.
jest.mock('react-native-vision-camera', () => ({
  ...jest.requireActual('react-native-vision-camera/lib/module/devices/getCameraFormat'),
}));

import { AIM_FORMAT_FILTERS, resolveAimFormat, aspectLabel } from '../src/camera/aimFormat';

function fmt(videoW, videoH, photoW, photoH, extra = {}) {
  return {
    videoWidth: videoW,
    videoHeight: videoH,
    photoWidth: photoW,
    photoHeight: photoH,
    maxFps: 30,
    minFps: 30,
    supportsPhotoHdr: false,
    supportsVideoHdr: false,
    videoStabilizationModes: [],
    autoFocusSystem: 'contrast-detection',
    ...extra,
  };
}

describe('PAP-1882 resolveAimFormat', () => {
  test('prefers a 4:3 video aspect so the preview matches the 4:3 photo', () => {
    const device = {
      id: 'xiaomi-logical-0',
      formats: [
        // 16:9 video + max photo (what an unpinned HAL preview typically is)
        fmt(1920, 1088, 4000, 3000),
        // 4:3 video + max photo — the WYSIWYG pick
        fmt(1920, 1440, 4000, 3000),
        fmt(1280, 720, 4000, 3000),
      ],
    };
    const format = resolveAimFormat(device);
    expect(format).toBeDefined();
    expect(format.videoWidth).toBe(1920);
    expect(format.videoHeight).toBe(1440);
    expect(format.photoWidth).toBe(4000);
    expect(format.photoHeight).toBe(3000);
  });

  test('keeps maximum photo resolution among aspect-tied formats', () => {
    const device = {
      id: 'device-4x3-only',
      formats: [
        fmt(1600, 1200, 2080, 1560),
        fmt(1600, 1200, 4000, 3000),
      ],
    };
    const format = resolveAimFormat(device);
    expect(format.photoWidth).toBe(4000);
    expect(format.photoHeight).toBe(3000);
    // aspect parity preserved
    expect(format.videoWidth / format.videoHeight).toBeCloseTo(4 / 3, 2);
  });

  test('falls back to closest aspect (16:9) when no 4:3 video size exists — never worse than default', () => {
    const device = {
      id: 'sixteen-by-nine-only',
      formats: [
        fmt(1280, 720, 4000, 3000),
        fmt(1920, 1088, 4000, 3000),
      ],
    };
    const format = resolveAimFormat(device);
    expect(format).toBeDefined();
    expect(format.videoWidth).toBe(1920); // closest to 4:3 by |aspect diff|
    expect(format.photoWidth).toBe(4000);
  });

  test('guard cases return undefined and never throw', () => {
    expect(resolveAimFormat(undefined)).toBeUndefined();
    expect(resolveAimFormat({ id: 'no-formats' })).toBeUndefined();
    expect(resolveAimFormat({ id: 'empty-formats', formats: [] })).toBeUndefined();
  });

  test('filter order: videoAspectRatio outranks photoResolution', () => {
    expect(AIM_FORMAT_FILTERS[0]).toEqual({ videoAspectRatio: 4 / 3 });
    expect(AIM_FORMAT_FILTERS[1]).toEqual({ photoResolution: 'max' });
  });

  test('aspectLabel covers the parity check used in telemetry', () => {
    expect(aspectLabel(4000, 3000)).toBe('4:3');
    expect(aspectLabel(1920, 1440)).toBe('4:3');
    expect(aspectLabel(1920, 1088)).toBe('16:9');
    expect(aspectLabel(3000, 4000)).toBe('4:3'); // portrait photo output
    expect(aspectLabel(0, 0)).toBeNull();
    expect(aspectLabel(undefined, undefined)).toBeNull();
  });
});
