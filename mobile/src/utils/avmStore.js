/**
 * PAP-1920: AVM persistence + device wiring.
 *
 * State lives in a small JSON file in the app document directory (no new
 * native storage dependency — expo-file-system is already a dependency).
 * The version key is BUILD_LABEL, so every install/update (debug or
 * release, PAP-1662 Step A included) re-arms the mode automatically.
 *
 * All pure lifecycle logic lives in ./avm.js; this file only loads, saves,
 * and reads the battery level (expo-battery, added for PAP-1920).
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
 * Load + normalize persisted state against the CURRENT build label.
 * Never throws: any read/parse failure yields a fresh armed state.
 */
export async function loadAvmState(now = Date.now()) {
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
 */
export async function saveAvmState(state) {
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
