/**
 * PAP-1920: AVM persistence + device wiring — SINGLE IN-PROCESS OWNER.
 *
 * State lives in a small JSON file in the app document directory (no new
 * native storage dependency — expo-file-system is already a dependency).
 * The version key is BUILD_LABEL, so every install/update (debug or
 * release, PAP-1662 Step A included) re-arms the mode automatically.
 *
 * All pure lifecycle logic lives in ./avm.js; this file only loads, saves,
 * and reads the battery level (expo-battery, added for PAP-1920).
 *
 * QA cross-check fix (2026-09-18, v1 FAIL → single writer): there is
 * exactly ONE in-process copy of the state, held here.  Screens never
 * keep a private snapshot — CameraScreen is a stack parent that stays
 * mounted while ResultScreen records captures, so the v1 design (each
 * screen load/transform/save independently) let CameraScreen's AppState
 * handler re-save a stale mount-time copy over ResultScreen's persisted
 * counter increments; the counters oscillated and AVM never disarmed.
 * Both screens now read via getAvmState() and mutate via
 * mutateAvmState(pureTransition), which serializes read → pure
 * transform → persist through one chain.  (QA option (b).)
 */

import * as FileSystem from 'expo-file-system/legacy';
import { getBatteryLevelAsync } from 'expo-battery';
import { BUILD_LABEL } from '../buildInfo';
import { normalizeAvmState, freshAvmState } from './avm';

const STATE_FILE_NAME = 'avm-state.json';

function stateFileUri() {
  const dir = FileSystem.documentDirectory;
  if (!dir) return null;
  return dir + STATE_FILE_NAME;
}

/**
 * Read + normalize the persisted file against the CURRENT build label.
 * Never throws: any read/parse failure yields a fresh armed state.
 * (Private — callers go through getAvmState/mutateAvmState.)
 */
async function readStateFromDisk(now) {
  const uri = stateFileUri();
  if (!uri) return freshAvmState(BUILD_LABEL, now);
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info || !info.exists) return freshAvmState(BUILD_LABEL, now);
    const raw = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    const persisted = JSON.parse(raw);
    return normalizeAvmState(persisted, BUILD_LABEL, now);
  } catch (e) {
    console.warn('[AVM] state load failed, starting fresh:', e?.message);
    return freshAvmState(BUILD_LABEL, now);
  }
}

/**
 * Persist state.  Fire-safe: failures are logged, never surfaced — losing
 * the counter only means re-collecting a session, which is harmless.
 * (Private — persistence happens inside mutateAvmState only.)
 */
async function persistState(state) {
  const uri = stateFileUri();
  if (!uri || !state) return;
  try {
    await FileSystem.writeAsStringAsync(uri, JSON.stringify(state), {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch (e) {
    console.warn('[AVM] state save failed:', e?.message);
  }
}

// ── The single owner ────────────────────────────────────────────────────
let cachedState = null;            // the ONE in-process copy (null = unloaded)
let loadingChain = Promise.resolve();
let writeChain = Promise.resolve(); // serializes mutations

/**
 * Current AVM state.  First call in a process loads from disk once;
 * afterwards the in-memory owner copy is returned.  Read-only — a UI
 * refresh (e.g. CameraScreen re-focus) can call this freely.
 */
export function getAvmState(now = Date.now()) {
  if (cachedState) return Promise.resolve(cachedState);
  loadingChain = loadingChain.then(async () => {
    if (!cachedState) cachedState = await readStateFromDisk(now);
    return cachedState;
  });
  return loadingChain;
}

/**
 * Read → pure transform → persist, through the single owner.  `transition`
 * is one of the pure functions from ./avm.js taking (state, now) and
 * returning either the next state (avmOnAppActive/avmOnAppBackground) or
 * `{ state, shotIndex }` (avmRecordCapture).
 *
 * Mutations are serialized: concurrent callers each see the previous
 * mutation's result, so counters can never be incremented against (or
 * overwritten by) a stale copy.  Resolves `{ prev, next, out }` — `out` is
 * the transition's own return value, `prev`/`next` bracket the change
 * (used for the avmSession opened-new-session cameraEvent).
 */
export function mutateAvmState(transition, now = Date.now()) {
  const run = writeChain.then(async () => {
    const prev = await getAvmState(now);
    const out = transition(prev, now);
    const next = out && typeof out === 'object' && 'state' in out ? out.state : out;
    cachedState = next;
    await persistState(next);
    return { prev, next, out };
  });
  writeChain = run.catch(() => {}); // a failed mutation must not wedge the chain
  return run;
}

/**
 * Battery level as a 0..1 fraction, or null when unreadable
 * (fail-open — see avmShouldCollect).
 */
export async function getAvmBatteryLevel() {
  try {
    const level = await getBatteryLevelAsync();
    if (typeof level !== 'number' || !isFinite(level) || level < 0) return null;
    return Math.min(1, level);
  } catch (e) {
    console.warn('[AVM] battery read failed:', e?.message);
    return null;
  }
}
