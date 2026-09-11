/**
 * PAP-1879 — death diagnostics, native-plugin-absent variant.
 *
 * The hook reads VisionCameraProxy.initFrameProcessorPlugin('extractYPlane')
 * at import time, so the "native plugin never registered" case needs its own
 * module state: this file boots the hook with the plugin ABSENT. That is the
 * suspected Xiaomi 25113PN0EC failure class — with no plugin, every yuv frame
 * falls into the toArrayBuffer() path that is documented broken for YUV on
 * Android (returns null forever), producing exactly the observed
 * "zero frames processed" with zero throws.
 */
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';

jest.mock('react-native-vision-camera', () => {
  const state = {
    plugin: undefined, // initFrameProcessorPlugin returned nothing
    worklet: null,
  };
  return {
    __state: state,
    VisionCameraProxy: { initFrameProcessorPlugin: () => state.plugin },
    useFrameProcessor: (cb) => { state.worklet = cb; return { __mockFrameProcessor: true }; },
  };
});
jest.mock('react-native-worklets-core', () => ({
  useRunOnJS: (cb) => (...args) => cb(...args),
}));
jest.mock('react-native-reanimated', () => ({
  useSharedValue: (v) => ({ value: v }),
}));
jest.mock('expo-sensors', () => ({
  Accelerometer: { setUpdateInterval: jest.fn(), addListener: jest.fn(() => ({ remove: jest.fn() })) },
  Gyroscope: { setUpdateInterval: jest.fn(), addListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock('../src/algorithm/gearDetector', () => ({
  detectGearPresenceRGBA: () => ({ detected: false, score: 0, approxCenterX: 0, approxCenterY: 0, approxRadius: 0, _diag: null }),
}));

const vision = require('react-native-vision-camera');
import { useMotionDetection } from '../src/hooks/useMotionDetection';

describe('PAP-1879 death diagnostics — native plugin absent', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('yuv frames without the plugin: buffer failures classified as fallback-no-plugin', () => {
    const onTimeout = jest.fn();

    renderHook(() =>
      useMotionDetection({ onStable: jest.fn(), enabled: true, onFrameProcessorTimeout: onTimeout, onFirstFrame: jest.fn() })
    );

    const worklet = vision.__state.worklet;
    const deadFrame = {
      pixelFormat: 'yuv', width: 8, height: 8, bytesPerRow: 8,
      toArrayBuffer: () => null, // YUV toArrayBuffer is broken on Android
    };
    act(() => { worklet(deadFrame); });
    act(() => { worklet(deadFrame); });
    act(() => { worklet(deadFrame); });

    act(() => { jest.advanceTimersByTime(10001); });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    const payload = onTimeout.mock.calls[0][0];
    expect(payload.nativePluginInstalled).toBe(false);
    expect(payload.workletRuns).toBe(3);
    // only every 3rd invocation reaches buffer extraction (FRAME_SKIP)
    expect(payload.bufferFailures).toBe(1);
    expect(payload.lastFailure).toBe('fallback-no-plugin:null');
    expect(payload.lastPixelFormat).toBe('yuv');
  });
});
