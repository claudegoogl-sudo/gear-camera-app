/**
 * PAP-1879 — frame-processor death diagnostics (desktop evidence).
 *
 * On the Xiaomi 25113PN0EC the ONLY trace of a dead frame processor was a
 * console.warn breadcrumb (invisible after app reload). These tests prove
 * the new instrumentation:
 *   - frameProcessorTimeout cameraEvent fires once per activation window,
 *     carrying worklet-side counters that distinguish "worklet never
 *     invoked" (workletRuns=0) from "invoked but bufferless"
 *     (bufferFailures>0 + lastFailure path classification), native plugin
 *     presence, and the negotiated pixelFormat;
 *   - a live processor emits exactly one frameProcessorFirstFrame event
 *     (positive liveness + format proof) and suppresses the timeout;
 *   - the event re-arms per enabled cycle (one per remount — matches the
 *     4-reports-in-90s Xiaomi session).
 *
 * Runs under the jest-expo preset; vision-camera / worklets / reanimated /
 * sensors are mocked. useRunOnJS is a synchronous direct call so worklet →
 * JS callbacks execute inline. The native extractYPlane plugin is PRESENT
 * in this file (import-time state); the plugin-absent variant lives in
 * pap1879.motion_diag_noplugin.test.js.
 */
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';

jest.mock('react-native-vision-camera', () => {
  const state = {
    // present at hook import time — the hook captures this OBJECT, so tests
    // override behavior via state.pluginCall instead of swapping the object.
    plugin: { call: (frame) => state.pluginCall(frame) },
    pluginCall: () => new ArrayBuffer(4),
    defaultPluginCall: () => new ArrayBuffer(4),
    worklet: null,
    throwOnBuild: false,
  };
  return {
    __state: state,
    VisionCameraProxy: { initFrameProcessorPlugin: () => state.plugin },
    useFrameProcessor: (cb) => {
      if (state.throwOnBuild) throw new Error('worklets unavailable');
      state.worklet = cb;
      return { __mockFrameProcessor: true };
    },
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

function yuvFrame(overrides = {}) {
  return {
    pixelFormat: 'yuv',
    width: 8, height: 8, bytesPerRow: 8,
    toArrayBuffer: () => new ArrayBuffer(64),
    ...overrides,
  };
}

describe('PAP-1879 frame-processor death diagnostics', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    vision.__state.throwOnBuild = false;
    vision.__state.pluginCall = vision.__state.defaultPluginCall;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('dead processor: one frameProcessorTimeout with never-invoked diagnostics', () => {
    const onTimeout = jest.fn();
    const onFirstFrame = jest.fn();

    const { result } = renderHook(() =>
      useMotionDetection({ onStable: jest.fn(), enabled: true, onFrameProcessorTimeout: onTimeout, onFirstFrame })
    );

    act(() => { jest.advanceTimersByTime(10001); });

    expect(onTimeout).toHaveBeenCalledTimes(1);
    const payload = onTimeout.mock.calls[0][0];
    expect(payload.frameProcessorAvailable).toBe(true);
    expect(payload.frameProcessorBuilt).toBe(true);
    expect(payload.nativePluginInstalled).toBe(true);
    expect(payload.workletRuns).toBe(0);
    expect(payload.processedFrames).toBe(0);
    expect(payload.bufferFailures).toBe(0);
    expect(payload.lastPixelFormat).toBeNull();
    expect(payload.lastFailure).toBeNull();
    expect(payload.waitedMs).toBeGreaterThanOrEqual(10000);
    expect(onFirstFrame).not.toHaveBeenCalled();
    expect(result.current.usingFallback).toBe(true);
  });

  test('live processor: frameProcessorFirstFrame fires once with format proof, no timeout', () => {
    const onTimeout = jest.fn();
    const onFirstFrame = jest.fn();

    const { result } = renderHook(() =>
      useMotionDetection({ onStable: jest.fn(), enabled: true, onFrameProcessorTimeout: onTimeout, onFirstFrame })
    );

    const worklet = vision.__state.worklet;
    // FRAME_SKIP=3: the first two invocations return before buffer read.
    act(() => { worklet(yuvFrame()); });
    act(() => { worklet(yuvFrame()); });
    act(() => { worklet(yuvFrame()); });

    expect(onFirstFrame).toHaveBeenCalledTimes(1);
    expect(onFirstFrame.mock.calls[0][0]).toMatchObject({
      width: 8, height: 8, bytesPerRow: 8, pixelFormat: 'yuv',
    });
    expect(onFirstFrame.mock.calls[0][0].bufferLength).toBe(4); // plugin buffer

    act(() => { jest.advanceTimersByTime(10001); });
    expect(onTimeout).not.toHaveBeenCalled();
    expect(result.current.usingFallback).toBe(false);
  });

  test('non-yuv frame falls back to toArrayBuffer path and is named in lastFailure', () => {
    const onTimeout = jest.fn();

    renderHook(() =>
      useMotionDetection({ onStable: jest.fn(), enabled: true, onFrameProcessorTimeout: onTimeout, onFirstFrame: jest.fn() })
    );

    const worklet = vision.__state.worklet;
    const rgbFrame = yuvFrame({ pixelFormat: 'rgb', toArrayBuffer: () => null });
    act(() => { worklet(rgbFrame); });
    act(() => { worklet(rgbFrame); });
    act(() => { worklet(rgbFrame); });

    act(() => { jest.advanceTimersByTime(10001); });
    const payload = onTimeout.mock.calls[0][0];
    expect(payload.lastPixelFormat).toBe('rgb');
    expect(payload.lastFailure).toBe('fallback-non-yuv:null');
  });

  test('plugin throw is caught and classified, does not crash the worklet', () => {
    vision.__state.pluginCall = () => { throw new Error('hal layout'); };
    const onTimeout = jest.fn();

    renderHook(() =>
      useMotionDetection({ onStable: jest.fn(), enabled: true, onFrameProcessorTimeout: onTimeout, onFirstFrame: jest.fn() })
    );

    const worklet = vision.__state.worklet;
    act(() => { worklet(yuvFrame()); });
    act(() => { worklet(yuvFrame()); });
    expect(() => act(() => { worklet(yuvFrame()); })).not.toThrow();

    act(() => { jest.advanceTimersByTime(10001); });
    expect(onTimeout.mock.calls[0][0].lastFailure).toBe('plugin:throw');
  });

  test('timeout re-arms per enabled cycle — one event per remount', () => {
    const onTimeout = jest.fn();

    const { rerender } = renderHook(
      ({ enabled }) => useMotionDetection({ onStable: jest.fn(), enabled, onFrameProcessorTimeout: onTimeout, onFirstFrame: jest.fn() }),
      { initialProps: { enabled: true } }
    );

    act(() => { jest.advanceTimersByTime(10001); });
    expect(onTimeout).toHaveBeenCalledTimes(1);

    // Remount cycle: enabled false (camera re-init) then true again.
    rerender({ enabled: false });
    rerender({ enabled: true });
    act(() => { jest.advanceTimersByTime(10001); });
    expect(onTimeout).toHaveBeenCalledTimes(2);
  });

  test('frameProcessorBuilt=false when the processor cannot be built', () => {
    vision.__state.throwOnBuild = true;
    const onTimeout = jest.fn();

    renderHook(() =>
      useMotionDetection({ onStable: jest.fn(), enabled: true, onFrameProcessorTimeout: onTimeout, onFirstFrame: jest.fn() })
    );

    act(() => { jest.advanceTimersByTime(10001); });
    const payload = onTimeout.mock.calls[0][0];
    expect(payload.frameProcessorBuilt).toBe(false);
    expect(payload.frameProcessorAvailable).toBe(true);
    expect(payload.workletRuns).toBe(0);
  });
});
