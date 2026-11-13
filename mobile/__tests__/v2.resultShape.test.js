/**
 * The v2 photo entry must hand the screens the same result shape as the legacy counter.
 */
import { toLegacyResult } from '../src/algorithm/gearCounterV2Photo';
import { abstainGuidance } from '../src/utils/abstainGuidance';

const timing = { load: 100, total: 180 };

test('answer: centre and radius are fractions of the original photo', () => {
  const v2 = { toothCount: 42, rawCount: 42, confidence: 0.97, abstainReason: null, gearCenter: { x: 512, y: 256 }, gearRadius: 256, diag: {}, stageMs: { total: 80 } };
  const aimCrop = { originX: 500, originY: 1000, side: 2000, fullW: 3000, fullH: 4000 };
  const r = toLegacyResult(v2, 1024, 1024, aimCrop, timing);
  expect(r.toothCount).toBe(42);
  expect(r.abstained).toBe(false);
  expect(r.abstainReason).toBeNull();
  expect(r.gearCenter.x).toBeCloseTo((500 + 0.5 * 2000) / 3000);
  expect(r.gearCenter.y).toBeCloseTo((1000 + 0.25 * 2000) / 4000);
  expect(r.gearRadius).toBeCloseTo((0.25 * 2000) / 3000);
  expect(r.algorithmRuntimeMs).toBe(180);
  expect(r.stageMs.load).toBe(100);
});

test('abstain: no number, no overlay, reason with v2- prefix and a user hint', () => {
  const v2 = { toothCount: 0, rawCount: 33, confidence: 0, abstainReason: 'cut-off', gearCenter: { x: 10, y: 10 }, gearRadius: 400, diag: {}, stageMs: {} };
  const r = toLegacyResult(v2, 1024, 1024, null, timing);
  expect(r.toothCount).toBe(0);
  expect(r.confidence).toBe(0);
  expect(r.abstained).toBe(true);
  expect(r.gearCenter).toBeNull();
  expect(r.abstainReason).toBe('v2-cut-off');
  expect(abstainGuidance(r.abstainReason).hint).toMatch(/whole gear/);
  expect(abstainGuidance('pap1872-dense-chainring')).toBeNull();
});
