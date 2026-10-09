import { pap1955BudgetHubStar } from '../src/algorithm/gearCounter';

describe('PAP-1955 budget-exhausted hub-star tag', () => {
  test('028b3b48 shape (34T, budget-exhausted, radius 0.092) is tagged', () => {
    expect(pap1955BudgetHubStar('pap1659-budget-exhausted', 0, 0.092 * 900, 900)).toBe(true);
  });
  test('does not fire on committed counts, large contours, or non-budget paths', () => {
    expect(pap1955BudgetHubStar('pap1659-budget-exhausted', 34, 0.092 * 900, 900)).toBe(false);
    expect(pap1955BudgetHubStar('pap1659-budget-exhausted', 0, 0.26 * 900, 900)).toBe(false);
    expect(pap1955BudgetHubStar('bc-consensus', 0, 0.092 * 900, 900)).toBe(false);
    expect(pap1955BudgetHubStar('pap1659-budget-exhausted', 0, 0, 900)).toBe(false);
  });
});
