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
  isProcessing: false,    // true while algorithm is running
  error: null,            // string | null

  // Actions
  setProcessing: (value) => set({ isProcessing: value, error: null }),

  setResult: ({ toothCount, confidence, gearContour, algorithmRuntimeMs, innerContourSuspected }) =>
    set({ toothCount, confidence, gearContour, algorithmRuntimeMs, innerContourSuspected: innerContourSuspected ?? false, isProcessing: false, error: null }),

  setError: (message) =>
    set({ error: message, isProcessing: false }),

  reset: () =>
    set({ toothCount: null, confidence: null, gearContour: null, algorithmRuntimeMs: null, innerContourSuspected: false, isProcessing: false, error: null }),
}));

export default useGearStore;
