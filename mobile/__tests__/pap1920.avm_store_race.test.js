/**
 * PAP-1920 v2 — REGRESSION TEST for the QA cross-check blocking finding:
 * the cross-screen stale-write race (two writers, one file).
 *
 * v1 bug (QA verdict 7f5d1dc7): CameraScreen stays mounted under the
 * Result screen (plain stack), loaded AVM state once at mount, and its
 * AppState handler re-saved that stale in-memory copy on every
 * background/active transition — rolling back ResultScreen's persisted
 * captureCount/sessionIndex increments.  With Telegram between shots the
 * counters oscillated at 1 and AVM never disarmed (AC2 violated).
 *
 * This suite runs the REAL avmStore module (only the file system and
 * battery natives are mocked with an in-memory implementation) and drives
 * record-capture → background → active through the shared persistence
 * path, asserting the counters survive.  It also covers serialization of
 * concurrent mutations and hand-off across a simulated process restart.
 */
import {
  avmOnAppActive,
  avmOnAppBackground,
  avmRecordCapture,
  avmCanArm,
  isAvmCollecting,
  freshAvmState,
  AVM_CAPTURE_LIMIT,
  AVM_SESSION_LIMIT,
  AVM_SESSION_RESUME_GRACE_MS,
} from '../src/utils/avm';

// In-memory FS shared by every (re-)instantiation of the store module —
// survives jest.resetModules() so a "process restart" sees the same disk.
const mockFs = { files: {} };
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: '/docs/',
  EncodingType: { UTF8: 'utf8' },
  getInfoAsync: async (uri) => ({ exists: !!mockFs.files[uri] }),
  readAsStringAsync: async (uri) => {
    if (!(uri in mockFs.files)) throw new Error('ENOENT');
    return mockFs.files[uri];
  },
  writeAsStringAsync: async (uri, data) => { mockFs.files[uri] = data; },
}), { virtual: true });

const mockBattery = { level: 0.9 };
jest.mock('expo-battery', () => ({
  getBatteryLevelAsync: async () => mockBattery.level,
}), { virtual: true });

const STATE_URI = '/docs/avm-state.json';

function readDiskState() {
  return JSON.parse(mockFs.files[STATE_URI]);
}

/** Fresh store module instance (single-owner cache reset). */
function freshStore() {
  jest.resetModules();
  mockBattery.level = 0.9;
  let store;
  jest.isolateModules(() => {
    store = require('../src/utils/avmStore');
  });
  return store;
}

describe('PAP-1920 v2: single-owner store — no stale-write race', () => {
  beforeEach(() => {
    mockFs.files = {};
  });

  test('QA failure sequence: record → background → active does NOT roll back counters', async () => {
    const store = freshStore();
    // CameraScreen mount: arm session 1
    await store.mutateAvmState(avmOnAppActive, 1_000);
    // ResultScreen: capture 1 completes (writes {cc:1, si:1} through the store)
    const r1 = await store.mutateAvmState(avmRecordCapture, 2_000);
    expect(r1.out.shotIndex).toBe(0); // PAP-1927: 0-based ordinal
    // operator backgrounds to Telegram and returns (on EITHER screen)
    await store.mutateAvmState(avmOnAppBackground, 3_000);
    await store.mutateAvmState(avmOnAppActive, 30_000); // within grace
    // v1 rolled the file back to the mount-time {cc:0, si:0} here
    expect(await store.getAvmState()).toMatchObject({ captureCount: 1, sessionIndex: 1 });
    expect(readDiskState()).toMatchObject({ captureCount: 1, sessionIndex: 1 });
    // capture 2 must be shot ordinal 1, not 0 again
    const r2 = await store.mutateAvmState(avmRecordCapture, 31_000);
    expect(r2.out.shotIndex).toBe(1);
    expect(readDiskState()).toMatchObject({ captureCount: 2, sessionIndex: 1 });
  });

  test('concurrent record + background + active mutations serialize consistently', async () => {
    const store = freshStore();
    await store.mutateAvmState(avmOnAppActive, 1_000);
    // fire all three at once — the store must serialize read→transform→persist
    const [rec, bg, act] = await Promise.all([
      store.mutateAvmState(avmRecordCapture, 2_000),
      store.mutateAvmState(avmOnAppBackground, 2_500),
      store.mutateAvmState(avmOnAppActive, 3_000),
    ]);
    expect(rec.out.shotIndex).toBe(0);
    const s = await store.getAvmState();
    expect(s.captureCount).toBe(1);          // incremented exactly once
    expect(s.sessionIndex).toBe(1);
    expect(Number.isFinite(s.lastSeenTs)).toBe(true);
    expect(readDiskState()).toMatchObject({ captureCount: 1, sessionIndex: 1 });
    expect(bg.next.captureCount).toBeLessThanOrEqual(1);
    expect(act.next.captureCount).toBe(1);
  });

  test('state survives a simulated process restart (kill + relaunch)', async () => {
    let store = freshStore();
    await store.mutateAvmState(avmOnAppActive, 1_000);
    await store.mutateAvmState(avmRecordCapture, 2_000);
    // process dies; the in-memory owner is gone, the file remains
    store = freshStore();
    const after = await store.getAvmState(10 * AVM_SESSION_RESUME_GRACE_MS);
    expect(after).toMatchObject({ captureCount: 1, sessionIndex: 1 });
    // relaunch past grace opens a NEW session; counters keep counting up
    const { next } = await store.mutateAvmState(avmOnAppActive, 10 * AVM_SESSION_RESUME_GRACE_MS + 1);
    expect(next.sessionIndex).toBe(1); // still 1 until this session's first capture
    const r = await store.mutateAvmState(avmRecordCapture, 10 * AVM_SESSION_RESUME_GRACE_MS + 2);
    expect(r.out.shotIndex).toBe(1);
    expect(r.out.sessionIndex).toBe(1); // 0-based ordinal of session 2
    expect(r.next.sessionIndex).toBe(2);
  });

  test('full lifecycle through the store: dormant after 3 capture-bearing sessions', async () => {
    const store = freshStore();
    let t = 0;
    for (let session = 1; session <= AVM_SESSION_LIMIT; session++) {
      t += AVM_SESSION_RESUME_GRACE_MS + 1; // each session starts past grace
      await store.mutateAvmState(avmOnAppActive, t);
      await store.mutateAvmState(avmRecordCapture, t + 1);
      t += 1;
    }
    const s = await store.getAvmState();
    expect(s).toMatchObject({ captureCount: AVM_SESSION_LIMIT, sessionIndex: AVM_SESSION_LIMIT });
    expect(avmCanArm(s)).toBe(false);       // AC2: never re-arms without a version change
    // further foreground transitions stay dormant; captures stop counting
    const { next } = await store.mutateAvmState(avmOnAppActive, t + AVM_SESSION_RESUME_GRACE_MS + 1);
    expect(next.sessionOpen).toBe(false);
    expect(isAvmCollecting(next)).toBe(false);
    const idle = readDiskState();
    expect(idle.captureCount).toBe(AVM_SESSION_LIMIT);
  });

  test('AC2: 10-capture limit ends the session mid-flight through the store', async () => {
    const store = freshStore();
    await store.mutateAvmState(avmOnAppActive, 1_000);
    for (let i = 1; i < AVM_CAPTURE_LIMIT; i++) {
      const r = await store.mutateAvmState(avmRecordCapture, 1_000 + i);
      expect(r.next.sessionOpen).toBe(true);
      expect(r.out.shotIndex).toBe(i - 1); // 0-based
    }
    const last = await store.mutateAvmState(avmRecordCapture, 2_000);
    expect(last.out.shotIndex).toBe(AVM_CAPTURE_LIMIT - 1);
    expect(last.next.sessionOpen).toBe(false);      // fully dormant from here
    expect(isAvmCollecting(last.next)).toBe(false);
    expect(readDiskState()).toMatchObject({ captureCount: AVM_CAPTURE_LIMIT, sessionIndex: 1 });
    // a background/active cycle after dormancy must not resurrect or corrupt
    await store.mutateAvmState(avmOnAppBackground, 3_000);
    const { next } = await store.mutateAvmState(avmOnAppActive, 4_000);
    expect(next).toMatchObject({ captureCount: AVM_CAPTURE_LIMIT, sessionIndex: 1, sessionOpen: false });
  });

  test('corrupt persisted file still yields a fresh armed state through the owner', async () => {
    mockFs.files[STATE_URI] = '{not json';
    const store = freshStore();
    const s = await store.getAvmState(5_000);
    expect(s).toMatchObject(freshAvmState(s.version, 5_000));
    expect(avmCanArm(s)).toBe(true);
  });
});
