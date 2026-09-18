/**
 * PAP-1920: Auto-Validation Mode (AVM) — integrated first-N-sessions
 * validation state machine (PURE, no React Native imports).
 *
 * Spec: docs/QA_AUTO_VALIDATION_MODE_SPEC_2026-09-18.md (QA, PAP-1800 HB49).
 *
 * The operator's NORMAL use of a freshly-installed release IS the validation
 * session: the app arms itself for the first N capture-bearing sessions after
 * each version change (BUILD_LABEL is the version key — every install or
 * update re-arms), collects a label per completed capture, and auto-shares
 * the debug report.  After N sessions or M completed captures, whichever
 * comes first, the mode goes fully dormant until the next version change.
 *
 * This module is deliberately free of React Native / Expo imports so the
 * whole lifecycle is unit-testable under plain jest (see
 * __tests__/pap1920.avm.test.js).  Persistence + battery wiring live in
 * avmStore.js; UI wiring in CameraScreen.jsx (arming, guidance banner) and
 * ResultScreen.jsx (label prompt, auto-share).
 *
 * Detection path is UNTOUCHED by design (spec: "zero detection-path diff") —
 * nothing in src/algorithm or handleCapture's counting flow may depend on
 * this module.
 */

/** Max capture-bearing sessions per version (spec design 1). */
export const AVM_SESSION_LIMIT = 3;
/** Max completed captures per version (spec design 1). */
export const AVM_CAPTURE_LIMIT = 10;
/** Skip auto-collect below this battery fraction (spec design 6). */
export const AVM_BATTERY_FLOOR = 0.25;
/**
 * Foreground periods separated by less than this gap are ONE session
 * (operator glancing at Telegram mid-session must not burn a session).
 * App-relaunch after a kill lands here too: lastSeenTs is only written
 * while the app lives, so a killed process resumes "stale" and the next
 * launch opens a fresh session.
 */
export const AVM_SESSION_RESUME_GRACE_MS = 90 * 1000;

/**
 * Fresh state for a version.  `sessionIndex` counts sessions that produced
 * at least one completed capture (a "detection session" in the spec) —
 * opening the app without shooting never consumes one of the N.
 */
export function freshAvmState(version, now = 0) {
  return {
    version,
    sessionIndex: 0,
    captureCount: 0,
    sessionOpen: false,
    sessionCounted: false,
    lastSeenTs: now,
  };
}

/**
 * Normalize a persisted blob against the CURRENT version key.
 * Version mismatch (install/update) → fresh state (re-arm).
 * Missing/corrupt blob → fresh state.  Unknown extra fields are preserved
 * so a downgrade can keep counting forward-compatible state files.
 */
export function normalizeAvmState(persisted, currentVersion, now = 0) {
  if (!persisted || typeof persisted !== 'object') {
    return freshAvmState(currentVersion, now);
  }
  if (persisted.version !== currentVersion) {
    return freshAvmState(currentVersion, now);
  }
  const num = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);
  return {
    ...persisted,
    version: currentVersion,
    sessionIndex: num(persisted.sessionIndex),
    captureCount: num(persisted.captureCount),
    sessionOpen: !!persisted.sessionOpen,
    sessionCounted: !!persisted.sessionCounted,
    lastSeenTs: num(persisted.lastSeenTs),
  };
}

/**
 * A new session may be armed while both limits are unspent.
 * (The currently-open session keeps collecting even after its first capture
 * marks sessionIndex === AVM_SESSION_LIMIT — dormancy applies to the NEXT
 * arm, so shot 2 of session 3 is still collected.)
 */
export function avmCanArm(state) {
  return state.sessionIndex < AVM_SESSION_LIMIT && state.captureCount < AVM_CAPTURE_LIMIT;
}

/**
 * The current foreground session is collecting telemetry.
 * Null-safe for the pre-load render tick.
 */
export function isAvmCollecting(state) {
  if (!state || !state.sessionOpen) return false;
  return state.captureCount < AVM_CAPTURE_LIMIT;
}

/**
 * Foreground transition (app launch, return from background).
 * - Dormant state stays dormant (no re-arm without a version change).
 * - An open session within the resume grace continues (same session).
 * - Anything older opens a NEW session — armed only if limits allow.
 */
export function avmOnAppActive(state, now) {
  if (!avmCanArm(state)) {
    return { ...state, sessionOpen: false, sessionCounted: false, lastSeenTs: now };
  }
  if (state.sessionOpen && now - state.lastSeenTs <= AVM_SESSION_RESUME_GRACE_MS) {
    return { ...state, lastSeenTs: now };
  }
  // A NEW session opens (launch, or return past the grace window): the
  // session slot is unspent until its FIRST completed capture.
  return { ...state, sessionOpen: true, sessionCounted: false, lastSeenTs: now };
}

/**
 * Background transition — lazy close: keep resume info, let the next
 * avmOnAppActive decide same-session vs new-session via the grace window.
 */
export function avmOnAppBackground(state, now) {
  return { ...state, lastSeenTs: now };
}

/**
 * Did this active-transition OPEN a session — app launch, or a return to
 * foreground past the resume grace?  For the avmSession cameraEvent:
 * `!prev.sessionOpen` alone is dead code after the first open, because
 * backgrounding only lazily closes (sessionOpen stays true), so this
 * predicate also fires when an open-but-stale session (gap > grace,
 * including a killed process) starts a NEW session.
 * `next.lastSeenTs` is the transition timestamp avmOnAppActive just wrote.
 */
export function avmOpenedNewSession(prev, next) {
  if (!next || !next.sessionOpen) return false;
  if (!prev || !prev.sessionOpen) return true;
  return next.lastSeenTs - prev.lastSeenTs > AVM_SESSION_RESUME_GRACE_MS;
}

/**
 * A capture completed (a result screen is being shown).
 * Increments captureCount; the FIRST capture of an open session also marks
 * the session as consumed (sessionIndex++) — later captures of the SAME
 * session must not spend another of the N slots (v2 fix found by the
 * store-race regression test: the v1 form incremented on every capture, so
 * one 3-shot session exhausted the whole N=3 budget).  Hitting the capture
 * limit ends the session immediately — the mode is fully dormant from
 * here (AC2).
 *
 * Returns { state, shotIndex } where shotIndex is the 1-based index of this
 * capture within the version (used for the validationSession context tag).
 */
export function avmRecordCapture(state, now) {
  const captureCount = state.captureCount + 1;
  const firstOfSession = state.sessionOpen && !state.sessionCounted;
  const sessionIndex = firstOfSession
    ? Math.min(AVM_SESSION_LIMIT, state.sessionIndex + 1)
    : state.sessionIndex;
  const sessionOpen = state.sessionOpen && captureCount < AVM_CAPTURE_LIMIT;
  return {
    state: {
      ...state,
      captureCount,
      sessionIndex,
      sessionCounted: state.sessionCounted || firstOfSession,
      sessionOpen,
      lastSeenTs: now,
    },
    shotIndex: captureCount,
  };
}

/**
 * Should this completed capture be collected (label prompt + auto-share)?
 * Battery guard (spec design 6): below AVM_BATTERY_FLOOR skip BOTH the
 * prompt and the auto-share — captures themselves are never blocked.
 * Unknown battery level (read failure) fails OPEN: the guard protects
 * against a dying phone, and Sentry's native device context still records
 * the true level for post-hoc filtering.
 */
export function avmShouldCollect(state, batteryLevel) {
  if (!isAvmCollecting(state)) return false;
  if (batteryLevel == null) return true;
  return batteryLevel >= AVM_BATTERY_FLOOR;
}

/**
 * Soft guidance hint (spec design 5) — cycles through class targets so the
 * first-N-sessions naturally spread over gear classes.  ANY capture still
 * counts; the hint steers, never gates.
 */
const AVM_HINTS = [
  'Self-test active — any gear counts, small cassette cog is a great start',
  'Self-test active — next: a mid-size cog in good light',
  'Self-test active — next: a large chainring filling the circle',
  'Self-test active — a re-shoot of the same gear also counts',
];

export function avmGuidanceHint(state) {
  if (!isAvmCollecting(state)) return null;
  const i = Math.min(state.captureCount, AVM_HINTS.length - 1);
  return AVM_HINTS[i % AVM_HINTS.length];
}

/**
 * Build the `validationSession` context block attached to auto-shared
 * debug reports (spec design 4).  Pure — unit-testable.
 */
export function buildValidationSessionContext({ state, shotIndex, label, batteryLevel }) {
  return {
    appVersion: state.version,
    sessionIndex: state.sessionIndex,
    shotIndex,
    shotsRemaining: Math.max(0, AVM_CAPTURE_LIMIT - shotIndex),
    label: label ?? null,
    batteryLevel: batteryLevel ?? null,
    schemaVersion: 1,
  };
}
