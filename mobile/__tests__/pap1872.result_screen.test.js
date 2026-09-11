/**
 * PAP-1872 — honest-abstain result screen (AC3, desktop evidence).
 *
 * Renders the real ResultScreen with the real zustand store in both states
 * and asserts the abstain treatment: guidance panel with retry help, NO
 * tooth number, NO contour overlay. AC3's on-device screenshot lands with
 * QA's device validation of the published build; this is the component-level
 * proof that the abstain outcome surfaces as "cannot count", not an error
 * and not a number.
 *
 * Runs under the jest-expo preset (react-native mocked by the preset).
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });
jest.mock('../src/utils/debugShare', () => ({ shareDebugReport: jest.fn() }));
jest.mock('../src/utils/trainingDataUpload', () => ({ uploadTrainingData: jest.fn() }));

import ResultScreen from '../src/screens/ResultScreen';
import useGearStore from '../src/store/useGearStore';

const blankState = {
  toothCount: null, confidence: null, gearContour: null, algorithmRuntimeMs: null,
  innerContourSuspected: false, abstained: false, abstainReason: null,
  chainringRegime: false, aimR: null, peakR: null, methodUsed: null,
  isProcessing: false, error: null,
};

const navNavigate = jest.fn();

function renderStore(state) {
  navNavigate.mockClear();
  useGearStore.setState({ ...blankState, ...state });
  return render(<ResultScreen navigation={{ navigate: navNavigate }} route={{ params: {} }} />);
}

describe('PAP-1872 honest-abstain result screen', () => {
  test('abstained result shows the cannot-count panel, no tooth number, no overlay', () => {
    const { queryByText, queryByTestId } = renderStore({
      abstained: true, abstainReason: 'pap1872-dense-chainring',
      toothCount: 0, confidence: 0,
    });
    expect(queryByText("Can't count this gear")).toBeTruthy();
    expect(queryByText(/dense chainring/)).toBeTruthy();
    expect(queryByText('Try again')).toBeTruthy();
    // honest outcome: no count display, no confidence badge
    expect(queryByText('teeth detected')).toBeNull();
    expect(queryByText(/Confidence/)).toBeNull();
    // no gear contour overlay on an abstain
    expect(queryByTestId('gear-contour-overlay')).toBeNull();
  });

  test('Try again returns to the camera screen', () => {
    const { getByTestId } = renderStore({
      abstained: true, abstainReason: 'pap1872-dense-chainring',
      toothCount: 0, confidence: 0,
    });
    fireEvent.press(getByTestId('abstain-retry'));
    expect(navNavigate).toHaveBeenCalledWith('Camera');
  });

  test('normal result still shows the tooth count', () => {
    const { queryByText } = renderStore({ toothCount: 20, confidence: 1.0 });
    expect(queryByText('teeth detected')).toBeTruthy();
    expect(queryByText("Can't count this gear")).toBeNull();
  });

  test('abstain does not trigger the low-confidence toast', () => {
    const { queryByText } = renderStore({
      abstained: true, abstainReason: 'pap1872-dense-chainring',
      toothCount: 0, confidence: 0,
    });
    expect(queryByText(/Low confidence/)).toBeNull();
  });
});
