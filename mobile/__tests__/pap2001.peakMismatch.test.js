import { pap2001PeakMismatchAbstain } from '../src/algorithm/gearCounter';
test('P2 abstains when peakTc != tc', () => {
  expect(pap2001PeakMismatchAbstain(false, 20, 18)).toBe(true);
  expect(pap2001PeakMismatchAbstain(false, 20, 20)).toBe(false);
  expect(pap2001PeakMismatchAbstain(true, 20, 18)).toBe(false);
  expect(pap2001PeakMismatchAbstain(false, 0, 18)).toBe(false);
});
