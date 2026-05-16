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
  // PAP-1536: chainring (30-60T) abstain. True when the algorithm detected
  // chainring-scale signal (any of peakTc/fft90tc/opTc/bcTc/bcPeaks >= 30).
  // Drives the "Chainring not supported in v1" UX screen.
  chainringRegime: false,
  // PAP-1536: aim-circle prior reading + chosen-radius for telemetry payload.
  aimR: null,
  peakR: null,
  // PAP-1538: enriched methodUsed tag from countTeeth so the chainring
  // abstain UX can OR chainringRegime with pap961/pap963/pap1059 method
  // tags.  PAP-1537 cross-check measured chainringRegime alone fires on
  // 51.2% of the 80-photo chainring corpus (42T/52T misses have all 5
  // FFT channels collapsed to small-cassette range); union with method
  // tags is needed to hit the AC1 ≥90% gate.
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
