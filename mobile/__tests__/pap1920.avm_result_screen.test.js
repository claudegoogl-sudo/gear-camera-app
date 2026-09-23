/**
 * PAP-1920 — AVM result-screen collection flow (component-level, AC1 focus).
 *
 * Renders the real ResultScreen with the real zustand store and the real
 * pure AVM module, mocking only avmStore (persistence + battery) and the
 * two upload utils.  Asserts the three collection paths:
 *   - armed + battery OK  → label modal, Send shares with validationSession
 *   - armed + Skip        → shares unlabeled
 *   - battery below floor → NO modal, NO share (captures never blocked)
 *   - dormant             → NO modal, NO share, zero extra UI
 *
 * Runs under the jest-expo preset (react-native mocked by the preset).
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });
jest.mock('expo-battery', () => ({ getBatteryLevelAsync: jest.fn() }), { virtual: true });
jest.mock('../src/utils/debugShare', () => ({ shareDebugReport: jest.fn() }));
jest.mock('../src/utils/trainingDataUpload', () => ({ uploadTrainingData: jest.fn() }));

// Owner-semantics mock (v2 store contract): ONE mutable copy, mutations
// apply the real pure transition to it — mirroring avmStore's single
// in-process owner without the disk layer (covered by
// pap1920.avm_store_race.test.js).
const mockAvmState = { value: null };
jest.mock('../src/utils/avmStore', () => ({
  getAvmState: async () => mockAvmState.value,
  mutateAvmState: async (transition, now = 0) => {
    const prev = mockAvmState.value;
    const out = transition(prev, now);
    const next = out && 'state' in out ? out.state : out;
    mockAvmState.value = next;
    return { prev, next, out };
  },
  getAvmBatteryLevel: async () => mockBattery.value,
}));

import ResultScreen from '../src/screens/ResultScreen';
import useGearStore from '../src/store/useGearStore';
import { shareDebugReport } from '../src/utils/debugShare';
import { uploadTrainingData } from '../src/utils/trainingDataUpload';
import { freshAvmState } from '../src/utils/avm';

const mockBattery = { value: null };

const blankState = {
  toothCount: null, confidence: null, gearContour: null, algorithmRuntimeMs: null,
  innerContourSuspected: false, abstained: false, abstainReason: null,
  chainringRegime: false, aimR: null, peakR: null, methodUsed: null,
  isProcessing: false, error: null,
};

const routeParams = {
  photoPath: '/tmp/photo.jpg',
  originalPhotoPath: '/tmp/photo-full.jpg',
  aimCrop: null,
  cameraErrors: [],
  cameraEvents: [],
  innerContourSuspected: false,
  algoDiag: { resultId: 'cap-test-1' },
};

function renderResult(storeOverrides = {}) {
  useGearStore.setState({ ...blankState, ...storeOverrides });
  return render(
    <ResultScreen
      navigation={{ navigate: jest.fn() }}
      route={{ params: routeParams }}
    />,
  );
}

function armedOpenState() {
  // session 1 open, zero captures yet — first shot of the self-test
  return { ...freshAvmState('v1.0.0 (158) · test', 0), sessionOpen: true };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBattery.value = 0.9;
  mockAvmState.value = armedOpenState();
});

describe('PAP-1920 AVM result-screen flow', () => {
  test('AC1: armed session prompts for the label and auto-shares with validationSession', async () => {
    const { getByTestId, queryByText } = renderResult({ toothCount: 36, confidence: 0.75 });

    // label prompt appears without any operator action beyond the shot
    const input = await waitFor(() => getByTestId('avm-label-input'));
    expect(queryByText('Self-test: how many teeth?')).toBeTruthy();
    // prefilled with the detected count → one-tap confirm
    expect(input.props.value).toBe('36');

    fireEvent.press(getByTestId('avm-send'));

    await waitFor(() => expect(shareDebugReport).toHaveBeenCalledTimes(1));
    const call = shareDebugReport.mock.calls[0][0];
    expect(call.validationSession).toMatchObject({
      appVersion: 'v1.0.0 (158) · test',
      sessionIndex: 0, // PAP-1927: 0-based ordinals (AC2 contract)
      shotIndex: 0,
      label: 36,
      batteryLevel: 0.9,
      schemaVersion: 1,
    });
    expect(call.actualTeethCount).toBe(36);
    expect(uploadTrainingData).toHaveBeenCalledTimes(1);
    // capture budget consumed through the store owner (single copy)
    expect(mockAvmState.value).toMatchObject({ captureCount: 1, sessionIndex: 1 });
    await waitFor(() => expect(queryByText(/sent ✓/)).toBeTruthy());
  });

  test('AC1: Skip still auto-shares, stored unlabeled, no training upload', async () => {
    const { getByTestId } = renderResult({ toothCount: 36, confidence: 0.75 });
    await waitFor(() => getByTestId('avm-skip'));
    fireEvent.press(getByTestId('avm-skip'));

    await waitFor(() => expect(shareDebugReport).toHaveBeenCalledTimes(1));
    const call = shareDebugReport.mock.calls[0][0];
    expect(call.actualTeethCount).toBeNull();
    expect(call.validationSession).toMatchObject({ label: null, shotIndex: 0, sessionIndex: 0 });
    expect(uploadTrainingData).not.toHaveBeenCalled();
  });

  test('AC4: battery below floor → no prompt, no share, captures unaffected', async () => {
    mockBattery.value = 0.2;
    const { queryByTestId, queryByText } = renderResult({ toothCount: 36, confidence: 0.75 });
    // give the async arm/load chain time to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(queryByTestId('avm-label-input')).toBeNull();
    expect(shareDebugReport).not.toHaveBeenCalled();
    expect(mockAvmState.value).toMatchObject({ captureCount: 0 }); // capture NOT counted
    expect(queryByText(/Self-test paused — battery below 25%/)).toBeTruthy();
  });

  test('AC2: dormant mode (capture limit) → zero prompts, zero events, dormancy advisory', async () => {
    mockAvmState.value = { ...armedOpenState(), captureCount: 10, sessionOpen: false };
    const { queryByTestId, queryByText } = renderResult({ toothCount: 36, confidence: 0.75 });
    await new Promise((r) => setTimeout(r, 50));
    expect(queryByTestId('avm-label-input')).toBeNull();
    expect(shareDebugReport).not.toHaveBeenCalled();
    // PAP-1927 dormancy advisory: one line tells the operator collection
    // stopped by design (spec AC2), not by breakage
    expect(queryByText(/Self-test complete/)).toBeTruthy();
  });

  test('abstained capture still collects: prompt prefills empty, Send carries the typed label', async () => {
    const { getByTestId } = renderResult({
      abstained: true, abstainReason: 'pap1872-dense-chainring',
      toothCount: 0, confidence: 0,
    });
    const input = await waitFor(() => getByTestId('avm-label-input'));
    expect(input.props.value).toBe(''); // nothing detected → operator types truth
    fireEvent.changeText(input, '52');
    fireEvent.press(getByTestId('avm-send'));

    await waitFor(() => expect(shareDebugReport).toHaveBeenCalledTimes(1));
    const call = shareDebugReport.mock.calls[0][0];
    expect(call.validationSession).toMatchObject({ label: 52 });
    expect(call.actualTeethCount).toBe(52);
  });
});
