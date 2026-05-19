import { create } from 'zustand';

/**
 * Global app state — kept minimal for Phase 2 scaffold.
 * Phases 3-4 will add motion detection state and processing status.
 */
const useGearStore = create((set) => ({
  // Result of the last tooth-count run
  toothCount: null,       // number | null
  confidence: null,       // 0.0 – 1.0 | null
  gearContour: null,      // array of {x,y} points for SVG overlay | null
  algorithmRuntimeMs: null, // number | null — total algorithm execution time
  innerContourSuspected: false, // PAP-553: radius-sanity abstain flag
  // PAP-1591 (revokes PAP-1536 UX descope): chainring-scale signal flag from
  // the algorithm (any of peakTc/fft90tc/opTc/bcTc/bcPeaks >= 30).  No
  // longer gates UX — v1 surfaces the tooth count across the full 11–60T
  // range.  Kept on the result so ResultScreen can fire the Sentry
  // chainring-regime telemetry event (used by the cassette-FP work under
  // PAP-1538).
  chainringRegime: false,
  // PAP-1536: aim-circle prior reading + chosen-radius for telemetry payload.
  aimR: null,
  peakR: null,
  // PAP-1538: enriched methodUsed tag from countTeeth.  Carried through
  // the store for debug-share / algoDiag consumers; no longer read by the
  // result-screen UX gate (PAP-1591 revoked the chainring abstain panel).
  methodUsed: null,
  isProcessing: false,    // true while algorithm is running
  error: null,            // string | null

  // Actions
  setProcessing: (value) => set({ isProcessing: value, error: null }),

  setResult: ({ toothCount, confidence, gearContour, algorithmRuntimeMs, innerContourSuspected, chainringRegime, aimR, peakR, methodUsed }) =>
    set({
      toothCount,
      confidence,
      gearContour,
      algorithmRuntimeMs,
      innerContourSuspected: innerContourSuspected ?? false,
      chainringRegime: chainringRegime ?? false,
      aimR: aimR ?? null,
      peakR: peakR ?? null,
      methodUsed: methodUsed ?? null,
      isProcessing: false,
      error: null,
    }),

  setError: (message) =>
    set({ error: message, isProcessing: false }),

  reset: () =>
    set({ toothCount: null, confidence: null, gearContour: null, algorithmRuntimeMs: null, innerContourSuspected: false, chainringRegime: false, aimR: null, peakR: null, methodUsed: null, isProcessing: false, error: null }),
}));

export default useGearStore;
