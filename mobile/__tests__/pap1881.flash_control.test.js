/**
 * PAP-1881 — user-facing flash control on the camera screen.
 *
 * FP5 operator (b153): "the app still lacks a working button to control the
 * flash".  Before PAP-1881 the aim torch and the capture flash were
 * hard-wired always-on (PAP-1551/1596 auto behavior) with no UI; this test
 * pins the new contract:
 *   - a ⚡ flash toggle (testID flash-toggle) renders once a device with a
 *     light unit exists, ON by default (identical behavior to b153);
 *   - the toggle drives the aim-time `torch` prop on <Camera> off and on;
 *   - the toggle drives the capture-time takePhoto `flash` argument;
 *   - both flips land `flashControlToggled` in the shared cameraEvents
 *     stream the debug report exposes, and the capture event records the
 *     user-selected `flashMode` next to the resolved prop.
 */
import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-intent-launcher', () => ({ startActivityAsync: jest.fn() }));
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn(async () => ({ uri: 'file:///tmp/crop.jpg', width: 1000, height: 2000 })),
  SaveFormat: { JPEG: 'jpeg' },
}));

// Mutable per-test device: useCameraDevice returns it for both the
// wide-angle and the main selector.
const deviceRef = { current: { id: 'device-0', hasTorch: true, hasFlash: true } };

jest.mock('react-native-vision-camera', () => {
  const React = require('react');
  const propsRef = { current: null };
  const fireInitRef = { current: true };
  const takePhotoRef = { current: jest.fn(async () => ({ path: '/tmp/photo.jpg', width: 3000, height: 4000 })) };
  const Camera = React.forwardRef((props, ref) => {
    propsRef.current = props;
    React.useImperativeHandle(ref, () => ({ takePhoto: takePhotoRef.current }), []);
    React.useEffect(() => {
      if (fireInitRef.current) props.onInitialized?.();
    }, []);
    return null;
  });
  return {
    __cameraProps: propsRef,
    __fireInit: fireInitRef,
    __takePhoto: takePhotoRef,
    Camera,
    useCameraDevice: () => deviceRef.current,
    useCameraPermission: () => ({ hasPermission: true, requestPermission: jest.fn() }),
  };
});

jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');
  // Animated.View hosts the aim-circle ref the capture path measures via
  // measureInWindow.  Under jest the native measure callback never fires,
  // which would hang handleCapture between takePhoto and the crop — give
  // the instance a deterministic synchronous measurement instead.
  const MeasureableView = React.forwardRef((props, ref) => {
    const setRef = (node) => {
      if (node) node.measureInWindow = (cb) => cb(10, 10, 100, 100);
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    };
    return React.createElement(View, { ...props, ref: setRef });
  });
  const passthrough = (v) => v;
  return {
    __esModule: true,
    default: { View: MeasureableView, createAnimatedComponent: (c) => c },
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
jest.mock('../src/buildInfo', () => ({ BUILD_LABEL: 'pap1881-test', BUILD_NUMBER: 999 }));
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
import { countTeeth } from '../src/algorithm/gearCounter';
import { shareDebugReport } from '../src/utils/debugShare';
import {
  __cameraProps as cameraProps,
  __fireInit as fireInit,
  __takePhoto as takePhotoRef,
} from 'react-native-vision-camera';

const nav = { navigate: jest.fn(), addListener: jest.fn(() => jest.fn()) };

function hookReturn(overrides = {}) {
  return {
    isStable: false, gearDetected: false, gearHints: null,
    frameProcessor: undefined, reset: jest.fn(), usingFallback: false,
    ...overrides,
  };
}

// The PAP-1596 aim-torch cycle engages ~50ms after onInitialized.  Real
// timers; 120ms comfortably clears it without flaking.
async function settlePastTorchCycle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 120));
  });
}

// Press the 🐛 debug button and return the cameraEvents array that was
// handed to shareDebugReport — the same stream triage reads on device.
async function sharedCameraEvents(getByText) {
  await act(async () => { fireEvent.press(getByText('🐛')); });
  await act(async () => {});
  expect(shareDebugReport).toHaveBeenCalled();
  return shareDebugReport.mock.calls[shareDebugReport.mock.calls.length - 1][0].cameraEvents;
}

beforeEach(() => {
  jest.clearAllMocks();
  fireInit.current = true;
  deviceRef.current = { id: 'device-0', hasTorch: true, hasFlash: true };
  useMotionDetection.mockImplementation(() => hookReturn());
});

describe('PAP-1881 flash control', () => {
  test('toggle renders ON by default and the aim torch engages after the cycle', async () => {
    const { getByTestId } = render(<CameraScreen navigation={nav} route={{ params: {} }} />);
    await settlePastTorchCycle();
    expect(getByTestId('flash-toggle')).toBeTruthy();
    expect(cameraProps.current.torch).toBe('on');
  });

  test('toggle drives the aim torch off and back on, landing flashControlToggled events', async () => {
    const { getByTestId, getByText } = render(<CameraScreen navigation={nav} route={{ params: {} }} />);
    await settlePastTorchCycle();
    expect(cameraProps.current.torch).toBe('on');

    await act(async () => { fireEvent.press(getByTestId('flash-toggle')); });
    expect(cameraProps.current.torch).toBe('off');
    await act(async () => { fireEvent.press(getByTestId('flash-toggle')); });
    expect(cameraProps.current.torch).toBe('on');
    await act(async () => { fireEvent.press(getByTestId('flash-toggle')); }); // end OFF

    const events = await sharedCameraEvents(getByText);
    const toggles = events.filter((e) => e.type === 'flashControlToggled').map((e) => e.mode);
    expect(toggles).toEqual(['off', 'on', 'off']);
  });

  test('capture passes flash per the user selection (on by default, off after toggle)', async () => {
    // countTeeth -> null is the "no gear detected" path: the screen resets
    // processing/preview itself and stays on the camera, exactly the
    // operator flow under test (the success path intentionally keeps
    // isProcessing and hands control to the Result screen).
    countTeeth.mockResolvedValue(null);
    const { getByTestId, getByText } = render(<CameraScreen navigation={nav} route={{ params: {} }} />);
    await settlePastTorchCycle();

    await act(async () => { fireEvent.press(getByTestId('capture-button')); });
    expect(takePhotoRef.current.mock.calls.length).toBe(1);
    expect(takePhotoRef.current.mock.calls[0][0].flash).toBe('on');

    await act(async () => { fireEvent.press(getByTestId('flash-toggle')); }); // OFF
    await act(async () => { fireEvent.press(getByTestId('capture-button')); });
    expect(takePhotoRef.current.mock.calls.length).toBe(2);
    expect(takePhotoRef.current.mock.calls[1][0].flash).toBe('off');

    // The capture event records the user-selected mode next to the resolved
    // prop (flashMode 'off' vs flash 'off' vs torchProp) — the fields QA
    // correlates on b154 debug shares.
    const events = await sharedCameraEvents(getByText);
    const captures = events.filter((e) => e.type === 'capture');
    expect(captures.length).toBe(2);
    expect(captures[0].flashMode).toBe('on');
    expect(captures[1].flashMode).toBe('off');
    expect(captures[1].torchProp).toBe('off');
  });

  test('toggle is hidden when the selected device has no light unit at all', async () => {
    deviceRef.current = { id: 'device-dark', hasTorch: false, hasFlash: false };
    const { queryByTestId } = render(<CameraScreen navigation={nav} route={{ params: {} }} />);
    await settlePastTorchCycle();
    expect(queryByTestId('flash-toggle')).toBeNull();
  });
});
