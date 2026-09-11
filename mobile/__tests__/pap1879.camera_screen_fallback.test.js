/**
 * PAP-1879 — IMU-only honest notice on the camera screen.
 *
 * With a dead frame processor, auto-capture can never fire (every trigger
 * path requires CRES gear detection), but manual capture still works (the
 * photo path is frame-processor-independent). The screen must SAY that
 * instead of leaving the user staring at a silent reticle — the Xiaomi
 * 25113PN0EC user retried four times in 90s and never learned either fact.
 *
 * useMotionDetection is mocked (its death diagnostics are covered by
 * pap1879.motion_diag*.test.js); this test proves the UI contract:
 *   - no panel while the frame processor is considered alive;
 *   - panel (title + manual-capture guidance + Retry camera) when
 *     usingFallback flips on;
 *   - panel hides while the camera session is down;
 *   - Retry remounts the camera and lands an imuOnlyRetry event in the
 *     cameraEvents stream that the debug report shares.
 */
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-intent-launcher', () => ({ startActivityAsync: jest.fn() }));
jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: { JPEG: 'jpeg' } }));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
jest.mock('react-native-vision-camera', () => {
  const React = require('react');
  const propsRef = { current: null };
  const fireInitRef = { current: true };
  const initCountRef = { current: 0 }; // React strips `key` from props — count mounts instead
  const Camera = (props) => {
    propsRef.current = props;
    React.useEffect(() => {
      if (fireInitRef.current) {
        initCountRef.current += 1;
        props.onInitialized?.();
      }
    }, []);
    return null;
  };
  return {
    __cameraProps: propsRef,
    __fireInit: fireInitRef,
    __initCount: initCountRef,
    Camera,
    useCameraDevice: () => ({ id: 'test-device', hasTorch: true, hasFlash: true }),
    useCameraPermission: () => ({ hasPermission: true, requestPermission: jest.fn() }),
  };
});
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const passthrough = (v) => v;
  return {
    __esModule: true,
    default: { View, createAnimatedComponent: (c) => c },
    useAnimatedStyle: () => ({}),
    useSharedValue: (v) => ({ value: v }),
    withSpring: passthrough,
    withRepeat: passthrough,
    withTiming: passthrough,
    cancelAnimation: jest.fn(),
  };
});
jest.mock('../src/components/MotionIndicator', () => {
  const { View } = require('react-native');
  return function MotionIndicator() { return <View testID="motion-indicator" />; };
});
jest.mock('../src/hooks/useMotionDetection', () => ({
  useMotionDetection: jest.fn(),
}));
jest.mock('../src/algorithm/gearCounter', () => ({ countTeeth: jest.fn() }));
jest.mock('../src/buildInfo', () => ({ BUILD_LABEL: 'pap1879-test', BUILD_NUMBER: 999 }));
jest.mock('../src/utils/updateChecker', () => ({
  checkForUpdate: jest.fn(async () => ({ available: false, latestBuild: 999, downloadUrl: '', releaseName: '', allBuilds: [] })),
  fetchAllBuilds: jest.fn(async () => []),
}));
jest.mock('../src/utils/debugShare', () => ({ shareDebugReport: jest.fn(async () => 'https://sentry.example/issues/') }));
jest.mock('../src/utils/chainringAbstainTelemetry', () => ({ emitChainringAbstainTelemetry: jest.fn() }));
jest.mock('../src/sentry', () => ({
  Sentry: { addBreadcrumb: jest.fn(), captureMessage: jest.fn(), withScope: (fn) => fn({ addAttachment: jest.fn(), setTags: jest.fn(), setContext: jest.fn() }) },
  SENTRY_ENABLED: false,
}));

import CameraScreen from '../src/screens/CameraScreen';
import { useMotionDetection } from '../src/hooks/useMotionDetection';
import { shareDebugReport } from '../src/utils/debugShare';
import { __cameraProps as cameraProps, __fireInit as fireInit, __initCount as initCount } from 'react-native-vision-camera';

const nav = { navigate: jest.fn(), addListener: jest.fn(() => jest.fn()) };

function hookReturn(overrides = {}) {
  return {
    isStable: false, gearDetected: false, gearHints: null,
    frameProcessor: undefined, reset: jest.fn(), usingFallback: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  fireInit.current = true;
  useMotionDetection.mockImplementation(() => hookReturn());
});

describe('PAP-1879 IMU-only honest notice', () => {
  test('no panel while the frame processor is alive', () => {
    const { queryByTestId, queryByText } = render(<CameraScreen navigation={nav} route={{ params: {} }} />);
    expect(queryByTestId('imu-only-panel')).toBeNull();
    expect(queryByText('Center gear in the circle')).toBeTruthy();
  });

  test('fallback panel shows manual-capture guidance and Retry, hint updates', () => {
    useMotionDetection.mockImplementation(() => hookReturn({ usingFallback: true }));
    const { getByTestId, queryByText } = render(<CameraScreen navigation={nav} route={{ params: {} }} />);
    expect(getByTestId('imu-only-panel')).toBeTruthy();
    expect(queryByText('Auto-capture unavailable')).toBeTruthy();
    expect(queryByText(/isn't sending camera frames/)).toBeTruthy();
    expect(queryByText(/still count a gear/)).toBeTruthy();
    expect(queryByText('Auto-capture unavailable — tap the capture button manually')).toBeTruthy();
    expect(getByTestId('imu-only-retry')).toBeTruthy();
  });

  test('panel hides while the camera session is down (starting camera)', () => {
    fireInit.current = false;
    useMotionDetection.mockImplementation(() => hookReturn({ usingFallback: true }));
    const { queryByTestId } = render(<CameraScreen navigation={nav} route={{ params: {} }} />);
    expect(queryByTestId('imu-only-panel')).toBeNull();
    fireInit.current = true;
  });

  test('Retry camera remounts the session and lands imuOnlyRetry in the shared event stream', async () => {
    useMotionDetection.mockImplementation(() => hookReturn({ usingFallback: true }));
    const { getByTestId, getByText } = render(<CameraScreen navigation={nav} route={{ params: {} }} />);
    const firstCount = initCount.current; // counter persists across tests — assert the delta

    await act(async () => {
      fireEvent.press(getByTestId('imu-only-retry'));
    });
    expect(initCount.current).toBe(firstCount + 1); // camera remounted (retryKey bump)

    // The retry event must be in the cameraEvents stream that the debug
    // report button shares — that is the stream triage actually reads.
    await act(async () => {
      fireEvent.press(getByText('🐛'));
    });
    await act(async () => {});
    expect(shareDebugReport).toHaveBeenCalled();
    const sharedEvents = shareDebugReport.mock.calls[0][0].cameraEvents;
    expect(sharedEvents.some((e) => e.type === 'imuOnlyRetry')).toBe(true);
  });
});
