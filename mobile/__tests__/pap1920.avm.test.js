/**
 * PAP-1920 — Auto-Validation Mode lifecycle (pure state machine, AC2 focus).
 *
 * Spec: docs/QA_AUTO_VALIDATION_MODE_SPEC_2026-09-18.md
 *  - armed on version change, dormant after N=3 capture-bearing sessions
 *    or M=10 completed captures, whichever first
 *  - foreground periods within the resume grace are ONE session
 *  - battery guard below 0.25 skips collection, unknown battery fails open
 *  - guidance hint cycles; validationSession context shape
 */
import {
  AVM_SESSION_LIMIT,
  AVM_CAPTURE_LIMIT,
  AVM_BATTERY_FLOOR,
  AVM_SESSION_RESUME_GRACE_MS,
  freshAvmState,
  normalizeAvmState,
  avmCanArm,
  isAvmCollecting,
  avmOnAppActive,
  avmOnAppBackground,
  avmOpenedNewSession,
  avmRecordCapture,
  avmShouldCollect,
  avmGuidanceHint,
  buildValidationSessionContext,
} from '../src/utils/avm';

const V1 = 'v1.0.0 (157) · 2026-09-12 22:58';
const V2 = 'v1.0.0 (158) · 2026-09-20 10:00';

describe('PAP-1920 AVM state machine', () => {
  test('fresh state is armed and can open a session', () => {
    const s = freshAvmState(V1, 1000);
    expect(avmCanArm(s)).toBe(true);
    expect(isAvmCollecting(s)).toBe(false); // no session open yet
    const open = avmOnAppActive(s, 1000);
    expect(open.sessionOpen).toBe(true);
    expect(isAvmCollecting(open)).toBe(true);
  });

  test('AC2: version change (install/update) re-arms a dormant state', () => {
    let s = freshAvmState(V1, 0);
    // v2: each iteration must start a genuinely NEW session (gap > grace) —
    // the v1 timestamps were within the grace window, so the loop was one
    // multi-capture session that only reached dormancy via the v1
    // increment-per-capture bug.
    for (let i = 0; i < AVM_SESSION_LIMIT; i++) {
      const t = i * (AVM_SESSION_RESUME_GRACE_MS + 10_000);
      s = avmOnAppActive(s, t);
      const rec = avmRecordCapture(s, t + 1);
      s = rec.state;
      s = avmOnAppBackground(s, t + 2);
    }
    expect(s.sessionIndex).toBe(AVM_SESSION_LIMIT);
    expect(avmCanArm(s)).toBe(false); // N sessions consumed
    const reopened = avmOnAppActive(s, 999_999);
    expect(reopened.sessionOpen).toBe(false);

    const afterUpdate = normalizeAvmState(s, V2, 1_000_000);
    expect(afterUpdate.version).toBe(V2);
    expect(afterUpdate.sessionIndex).toBe(0);
    expect(afterUpdate.captureCount).toBe(0);
    expect(avmCanArm(afterUpdate)).toBe(true);
  });

  test('normalize: corrupt/missing blob yields fresh armed state', () => {
    expect(normalizeAvmState(null, V1, 5).version).toBe(V1);
    expect(normalizeAvmState('garbage', V1, 5).captureCount).toBe(0);
    const partial = { version: V1, captureCount: 'x', sessionOpen: 'yes' };
    const n = normalizeAvmState(partial, V1, 5);
    expect(n.captureCount).toBe(0);
    expect(n.sessionOpen).toBe(true); // coerced truthy, limits still apply
  });

  test('a session with ZERO captures does not consume one of the N', () => {
    let s = freshAvmState(V1, 0);
    // three open+background cycles, no captures
    for (let i = 0; i < 5; i++) {
      s = avmOnAppActive(s, i * 100_000);
      s = avmOnAppBackground(s, i * 100_000 + 1);
    }
    expect(s.sessionIndex).toBe(0);
    expect(avmCanArm(s)).toBe(true);
  });

  test('AC2: dormant after exactly N=3 capture-bearing sessions', () => {
    let s = freshAvmState(V1, 0);
    for (let i = 0; i < AVM_SESSION_LIMIT; i++) {
      s = avmOnAppActive(s, i * 100_000); // far past grace → new session
      expect(s.sessionOpen).toBe(true);
      s = avmRecordCapture(s, i * 100_000 + 1).state;
      s = avmOnAppBackground(s, i * 100_000 + 2);
    }
    expect(s.sessionIndex).toBe(AVM_SESSION_LIMIT);
    expect(avmCanArm(s)).toBe(false);
    const next = avmOnAppActive(s, 10_000_000);
    expect(next.sessionOpen).toBe(false); // fully dormant
    expect(isAvmCollecting(next)).toBe(false);
  });

  test('multi-shot session: shot 2 of session 3 still collects', () => {
    let s = freshAvmState(V1, 0);
    for (let i = 0; i < AVM_SESSION_LIMIT - 1; i++) {
      s = avmOnAppActive(s, i * 100_000);
      s = avmRecordCapture(s, i * 100_000 + 1).state;
      s = avmOnAppBackground(s, i * 100_000 + 2);
    }
    s = avmOnAppActive(s, 500_000); // session 3 opens
    const r1 = avmRecordCapture(s, 500_001);
    expect(r1.state.sessionIndex).toBe(AVM_SESSION_LIMIT); // now "spent"
    expect(isAvmCollecting(r1.state)).toBe(true); // but still open
    const r2 = avmRecordCapture(r1.state, 500_002);
    expect(r2.shotIndex).toBe(4);
    expect(isAvmCollecting(r2.state)).toBe(true);
  });

  test('AC2: dormant after M=10 completed captures, mid-session', () => {
    let s = freshAvmState(V1, 0);
    s = avmOnAppActive(s, 0);
    let last;
    for (let i = 1; i <= AVM_CAPTURE_LIMIT; i++) {
      last = avmRecordCapture(s, i);
      s = last.state;
    }
    expect(last.shotIndex).toBe(AVM_CAPTURE_LIMIT);
    expect(s.captureCount).toBe(AVM_CAPTURE_LIMIT);
    expect(s.sessionOpen).toBe(false); // fully dormant immediately
    expect(isAvmCollecting(s)).toBe(false);
    expect(avmShouldCollect(s, 0.99)).toBe(false);
  });

  test('foreground periods within the resume grace are ONE session', () => {
    let s = freshAvmState(V1, 0);
    s = avmOnAppActive(s, 0);
    s = avmRecordCapture(s, 100).state;
    // quick app switch: background + return inside the grace
    s = avmOnAppBackground(s, 5_000);
    const back = avmOnAppActive(s, 5_000 + AVM_SESSION_RESUME_GRACE_MS - 1);
    expect(back.sessionOpen).toBe(true);
    expect(back.sessionIndex).toBe(1); // same session, not a second one
  });

  test('app relaunch after a kill (stale lastSeen) opens a NEW session', () => {
    let s = freshAvmState(V1, 0);
    s = avmOnAppActive(s, 0);
    s = avmRecordCapture(s, 100).state;
    // process killed — no background event; next launch is far later
    const relaunched = avmOnAppActive(s, AVM_SESSION_RESUME_GRACE_MS + 60_000);
    expect(relaunched.sessionOpen).toBe(true);
    expect(relaunched.sessionIndex).toBe(1); // old session implicitly closed
    const rec = avmRecordCapture(relaunched, AVM_SESSION_RESUME_GRACE_MS + 61_000);
    expect(rec.state.sessionIndex).toBe(2); // second capture-bearing session
  });

  test('battery guard: below floor skips collection, at/above collects, unknown fails open', () => {
    const s = { ...freshAvmState(V1, 0), sessionOpen: true };
    expect(avmShouldCollect(s, AVM_BATTERY_FLOOR - 0.01)).toBe(false);
    expect(avmShouldCollect(s, AVM_BATTERY_FLOOR)).toBe(true);
    expect(avmShouldCollect(s, 1)).toBe(true);
    expect(avmShouldCollect(s, null)).toBe(true); // fail open
    expect(avmShouldCollect(s, undefined)).toBe(true);
  });

  test('guidance hint cycles by capture count, null when dormant', () => {
    let s = { ...freshAvmState(V1, 0), sessionOpen: true, captureCount: 0 };
    const h0 = avmGuidanceHint(s);
    expect(h0).toMatch(/small cassette cog/);
    s = { ...s, captureCount: 1 };
    expect(avmGuidanceHint(s)).toMatch(/mid-size cog/);
    s = { ...s, captureCount: 2 };
    expect(avmGuidanceHint(s)).toMatch(/large chainring/);
    s = { ...s, captureCount: AVM_CAPTURE_LIMIT };
    expect(avmGuidanceHint(s)).toBeNull();
    expect(avmGuidanceHint(null)).toBeNull();
  });

  test('validationSession context shape (spec design 4)', () => {
    const s = { ...freshAvmState(V1, 0), sessionOpen: true };
    const ctx = buildValidationSessionContext({ state: s, shotIndex: 4, label: 36, batteryLevel: 0.87 });
    expect(ctx).toEqual({
      appVersion: V1,
      sessionIndex: 0,
      shotIndex: 4,
      shotsRemaining: AVM_CAPTURE_LIMIT - 4,
      label: 36,
      batteryLevel: 0.87,
      schemaVersion: 1,
    });
    const skipped = buildValidationSessionContext({ state: s, shotIndex: 1, label: null, batteryLevel: null });
    expect(skipped.label).toBeNull();
    expect(skipped.batteryLevel).toBeNull();
  });

  test('shotIndex is 1-based and monotonic within a version', () => {
    let s = freshAvmState(V1, 0);
    s = avmOnAppActive(s, 0);
    const r1 = avmRecordCapture(s, 1);
    expect(r1.shotIndex).toBe(1);
    const r2 = avmRecordCapture(r1.state, 2);
    expect(r2.shotIndex).toBe(2);
  });

  test('v2 fix: later captures of the SAME session do not spend another N slot', () => {
    let s = freshAvmState(V1, 0);
    s = avmOnAppActive(s, 0); // session 1 opens
    const r1 = avmRecordCapture(s, 1_000);
    expect(r1.state.sessionIndex).toBe(1); // first capture consumes slot 1
    const r2 = avmRecordCapture(r1.state, 2_000);
    expect(r2.state.sessionIndex).toBe(1); // v1 bug: this was 2
    const r3 = avmRecordCapture(r2.state, 3_000);
    expect(r3.state.sessionIndex).toBe(1); // v1 bug: this was 3
    expect(r3.shotIndex).toBe(3);
    expect(avmCanArm(r3.state)).toBe(true); // sessions 2 and 3 still owed
    // resume within grace: still session 1, still not re-spent
    const bg = avmOnAppBackground(r3.state, 4_000);
    const resumed = avmOnAppActive(bg, 30_000);
    const r4 = avmRecordCapture(resumed, 31_000);
    expect(r4.state.sessionIndex).toBe(1);
    // a NEW session (past grace) is the one that spends slot 2
    const bg2 = avmOnAppBackground(r4.state, 32_000);
    const next = avmOnAppActive(bg2, 32_000 + AVM_SESSION_RESUME_GRACE_MS + 1);
    const r5 = avmRecordCapture(next, 200_000);
    expect(r5.state.sessionIndex).toBe(2);
    expect(r5.shotIndex).toBe(5);
  });

  // ── avmOpenedNewSession (v2: fixes the dead-code avmSession event) ────
  describe('avmOpenedNewSession', () => {
    test('fires on a fresh launch arm', () => {
      const prev = freshAvmState(V1, 0);
      const next = avmOnAppActive(prev, 10);
      expect(avmOpenedNewSession(prev, next)).toBe(true);
    });

    test('does NOT fire on resume within the grace window', () => {
      let s = freshAvmState(V1, 0);
      s = avmOnAppActive(s, 0);
      const bg = avmOnAppBackground(s, 30_000); // glance at Telegram 30s
      const next = avmOnAppActive(bg, 60_000);
      expect(avmOpenedNewSession(bg, next)).toBe(false);
    });

    test('fires on resume PAST the grace window (open-but-stale session)', () => {
      // the v1 dead-code path: sessionOpen stayed true across background,
      // so !prev.sessionOpen never fired again — this must still count
      let s = freshAvmState(V1, 0);
      s = avmOnAppActive(s, 0);
      s = avmRecordCapture(s, 1).state;
      const bg = avmOnAppBackground(s, 5_000);
      const next = avmOnAppActive(bg, 5_000 + AVM_SESSION_RESUME_GRACE_MS + 1);
      expect(next.sessionOpen).toBe(true);       // re-armed as a NEW session
      expect(avmOpenedNewSession(bg, next)).toBe(true);
    });

    test('fires after a killed process resumed stale-open past grace', () => {
      let s = freshAvmState(V1, 0);
      s = avmOnAppActive(s, 0);
      // process killed while open; file still says open at t=0
      const next = avmOnAppActive(s, AVM_SESSION_RESUME_GRACE_MS * 10);
      expect(avmOpenedNewSession(s, next)).toBe(true);
    });

    test('never fires when the mode is dormant', () => {
      let s = freshAvmState(V1, 0);
      for (let i = 0; i < AVM_CAPTURE_LIMIT; i++) {
        s = avmOnAppActive(s, i * 1000);
        s = avmRecordCapture(s, i * 1000 + 1).state;
      }
      expect(s.sessionOpen).toBe(false); // capture limit reached mid-session
      const next = avmOnAppActive(s, 10 * AVM_SESSION_RESUME_GRACE_MS);
      expect(avmOpenedNewSession(s, next)).toBe(false);
    });
  });
});
