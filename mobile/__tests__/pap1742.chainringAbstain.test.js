/**
 * PAP-1742: chainring_abstain telemetry must fire exactly once per
 * chainring-regime result, and `channels` must always describe the SAME
 * result as toothCount/confidence.
 *
 * Replays the b142 device session (2026-08-26T12:28-12:30Z) where 5 events
 * were emitted for 3 photos, some pairing photo N's confidence with photo
 * N-1's algoDiag channels block.  The emission now happens once at capture
 * completion in CameraScreen.handleCapture (same scope that builds
 * result + algoDiagBlock), with a resultId-keyed dedupe backstop here.
 */

// The real ../src/sentry imports @sentry/react-native (native module) —
// stub it; SENTRY_ENABLED=false keeps the emitter off the Sentry path so
// these tests assert on payloads + console telemetry lines only.
jest.mock('../src/sentry', () => ({
  Sentry: {
    withScope: (fn) => fn({ setTags: () => {}, setContext: () => {} }),
    captureMessage: jest.fn(),
  },
  SENTRY_ENABLED: false,
}));

const {
  emitChainringAbstainTelemetry,
  buildChainringAbstainPayload,
  resetChainringAbstainDedupe,
} = require('../src/utils/chainringAbstainTelemetry');

/** Mirrors CameraScreen.handleCapture's PAP-1742 emission (chainring regime only). */
function emitForCapture(result, algoDiagBlock) {
  if (!result.chainringRegime) return { skipped: 'not-chainring-regime' };
  return emitChainringAbstainTelemetry({
    aimR: result.aimR ?? null,
    peakR: result.peakR ?? null,
    toothCount: result.toothCount,
    confidence: result.confidence,
    channels: algoDiagBlock,
    resultId: algoDiagBlock.resultId,
  });
}

function algoDiagBlockFor(captureId, methodUsed) {
  return {
    resultId: captureId,
    peakR: 276,
    rOuter: 268,
    radialRelDisagree: 0.042,
    chainringRegime: true,
    aimR: 210,
    methodUsed,
    stageMs: { preprocess: 40, detect: 25000 },
    budgetExhausted: false,
  };
}

let logSpy;
beforeEach(() => {
  resetChainringAbstainDedupe();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
});

const telemetryLines = () =>
  logSpy.mock.calls.filter((c) => String(c[0]).startsWith('[Telemetry] chainring-abstain'));

const emittedLines = () =>
  telemetryLines().filter((c) => c[0] === '[Telemetry] chainring-abstain');

describe('PAP-1742 AC1: one event per chainring-regime result (b142 replay)', () => {
  test('3 consecutive distinct chainring results emit exactly 3 events', () => {
    // b142 session: tc 10 (photo #1), tc 10 (photo #2), tc 32 (photo #3) —
    // two of them share a toothCount, so keying on toothCount alone must fail.
    const captures = [
      { resultId: 'cap-a-1', tc: 10, conf: 0.8526, method: 'bc-consensus' },
      { resultId: 'cap-a-2', tc: 10, conf: 0.7174, method: 'bc-fft' },
      { resultId: 'cap-a-3', tc: 32, conf: 0.7543, method: 'bc-consensus' },
    ];
    const results = captures.map((c) => emitForCapture(
      { chainringRegime: true, toothCount: c.tc, confidence: c.conf, aimR: 210, peakR: 276 },
      algoDiagBlockFor(c.resultId, c.method)
    ));

    expect(results.filter((r) => r && !r.deduped && !r.skipped)).toHaveLength(3);
    expect(emittedLines()).toHaveLength(3);
  });

  test('a duplicate emission for the SAME capture (old double-fire) is suppressed', () => {
    const block = algoDiagBlockFor('cap-a-1', 'bc-consensus');
    const result = { chainringRegime: true, toothCount: 10, confidence: 0.85, aimR: 210, peakR: 276 };

    const first = emitForCapture(result, block);
    const second = emitForCapture(result, block); // effect re-fire / double capture

    expect(first.deduped).toBeUndefined();
    expect(second.deduped).toBe(true);
    expect(emittedLines()).toHaveLength(1);
    expect(telemetryLines().some((c) => c[0].includes('duplicate suppressed'))).toBe(true);
  });

  test('suppression does not stick: the NEXT distinct capture still emits', () => {
    const result = { chainringRegime: true, toothCount: 10, confidence: 0.85, aimR: 210, peakR: 276 };
    emitForCapture(result, algoDiagBlockFor('cap-a-1', 'bc-consensus'));
    emitForCapture(result, algoDiagBlockFor('cap-a-1', 'bc-consensus')); // suppressed

    const next = emitForCapture(result, algoDiagBlockFor('cap-a-2', 'bc-fft'));

    expect(next.deduped).toBeUndefined();
    expect(emittedLines()).toHaveLength(2);
  });

  test('non-chainring results do not emit (CameraScreen guard)', () => {
    const out = emitForCapture({ chainringRegime: false, toothCount: 10, confidence: 0.9 }, algoDiagBlockFor('cap-a-9', 'optC'));
    expect(out.skipped).toBe('not-chainring-regime');
    expect(telemetryLines()).toHaveLength(0);
  });
});

describe('PAP-1742 AC2: channels always match toothCount/confidence of the same result', () => {
  test('each event carries its own capture channels block — never the previous photo block', () => {
    const b142 = [
      { resultId: 'cap-b-1', tc: 10, conf: 0.8526, method: 'bc-consensus' }, // photo #1 (fresh)
      { resultId: 'cap-b-2', tc: 10, conf: 0.7174, method: 'bc-fft' },       // photo #2
      { resultId: 'cap-b-3', tc: 32, conf: 0.7543, method: 'bc-consensus' }, // photo #3
    ];
    const blocks = b142.map((c) => algoDiagBlockFor(c.resultId, c.method));

    b142.forEach((c, i) =>
      emitForCapture({ chainringRegime: true, toothCount: c.tc, confidence: c.conf, aimR: 210, peakR: 276 }, blocks[i])
    );

    const payloads = emittedLines().map((c) => JSON.parse(c[1]));
    expect(payloads).toHaveLength(3);
    payloads.forEach((p, i) => {
      expect(p.detection.channels.resultId).toBe(b142[i].resultId);
      expect(p.detection.channels.methodUsed).toBe(b142[i].method);
      expect(p.detection.toothCount).toBe(b142[i].tc);
      expect(p.detection.confidence).toBe(b142[i].conf);
      expect(p.resultId).toBe(b142[i].resultId);
    });
  });

  test('duplicate suppressed event cannot smuggle a stale channels block upstream', () => {
    const staleBlock = algoDiagBlockFor('cap-c-1', 'bc-consensus');
    const result = { chainringRegime: true, toothCount: 10, confidence: 0.85, aimR: 210, peakR: 276 };
    emitForCapture(result, staleBlock);

    // Old bug shape: re-fire with a DIFFERENT channels object but the same
    // resultId (e.g. re-mount reading updated params).  Must not emit.
    const mixedBlock = { ...staleBlock, methodUsed: 'bc-fft' };
    const second = emitForCapture(result, mixedBlock);

    expect(second.deduped).toBe(true);
    expect(emittedLines()).toHaveLength(1);
    expect(JSON.parse(emittedLines()[0][1]).detection.channels.methodUsed).toBe('bc-consensus');
  });
});

describe('PAP-1742 AC3: single-result payload shape unchanged (schemaVersion 1 + resultId)', () => {
  test('payload keeps the PAP-1536/1543 field layout', () => {
    const block = algoDiagBlockFor('cap-d-1', 'bc-consensus');
    const payload = buildChainringAbstainPayload({
      aimR: 210,
      peakR: 276,
      toothCount: 32,
      confidence: 0.7543,
      channels: block,
      resultId: 'cap-d-1',
    });

    expect(payload.event).toBe('chainring-abstain');
    expect(payload.schemaVersion).toBe(1);
    expect(payload.regime).toBe('chainring');
    expect(payload.build).toEqual(expect.any(String));
    expect(payload.timestamp).toEqual(expect.any(String));
    expect(payload.aimCirclePrior).toEqual({ aimR: 210, peakR: 276, ratio: 1.3143 });
    expect(payload.detection.toothCount).toBe(32);
    expect(payload.detection.confidence).toBe(0.7543);
    expect(payload.detection.channels).toBe(block);
    // PAP-1742 addition:
    expect(payload.resultId).toBe('cap-d-1');
  });
});
