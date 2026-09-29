// PAP-1939: post-capture screenshot for preview/UI misalignment analysis.
//
// Fired right after takePhoto resolves. Fire-and-forget: the capture path
// never awaits this promise, so gear detection latency is unchanged. The
// promise resolves to { screenPath, previewPath, errors } and is consumed only
// by the debug share (Sentry attachments screen.jpg / preview.jpg).
//
// - screen.jpg  = react-native-view-shot captureScreen(): whole window (UI,
//   aim circle, overlays, buttons). On Android the camera SurfaceView may
//   render black here — that is why preview.jpg exists.
// - preview.jpg = vision-camera takeSnapshot(): the preview frame itself.
// Files live in cacheDirectory/pap1939/ (OS-evictable, no storage growth
// concern); only the latest KEEP_MAX pairs are kept.
import { captureScreen } from 'react-native-view-shot';
import * as FileSystem from 'expo-file-system/legacy';

export const SCREENSHOT_ENABLED = true; // debug/telemetry flag
const KEEP_MAX = 10;
const DIR = () => `${FileSystem.cacheDirectory}pap1939/`;

async function move(src, name) {
  const from = src.startsWith('file://') ? src : `file://${src}`;
  const to = DIR() + name;
  await FileSystem.moveAsync({ from, to });
  return to;
}

async function prune() {
  try {
    const names = (await FileSystem.readDirectoryAsync(DIR())).sort();
    const excess = names.length - KEEP_MAX * 2;
    for (let i = 0; i < excess; i++) {
      await FileSystem.deleteAsync(DIR() + names[i], { idempotent: true });
    }
  } catch (e) { /* best effort */ }
}

export function startPostCaptureScreenshot(cameraRef) {
  if (!SCREENSHOT_ENABLED) return null;
  const id = `shot-${Date.now().toString(36)}`;
  const errors = [];
  const run = async () => {
    await FileSystem.makeDirectoryAsync(DIR(), { intermediates: true }).catch(() => {});
    const [screenPath, previewPath] = await Promise.all([
      captureScreen({ format: 'jpg', quality: 0.8 })
        .then((uri) => move(uri, `${id}-screen.jpg`))
        .catch((e) => { errors.push(`screen: ${e?.message}`); return null; }),
      (cameraRef?.current?.takeSnapshot
        ? cameraRef.current.takeSnapshot({ quality: 80 })
        : Promise.reject(new Error('takeSnapshot unavailable')))
        .then((snap) => move(snap.path, `${id}-preview.jpg`))
        .catch((e) => { errors.push(`preview: ${e?.message}`); return null; }),
    ]);
    prune();
    return { id, screenPath, previewPath, errors };
  };
  // Never rejects.
  return run().catch((e) => ({ id, screenPath: null, previewPath: null, errors: [String(e?.message)] }));
}

// resultId -> promise registry (route params must stay serializable).
const registry = new Map();
export function registerScreenshot(resultId, promise) {
  if (!resultId || !promise) return;
  registry.set(resultId, promise);
  while (registry.size > KEEP_MAX) registry.delete(registry.keys().next().value);
}
/** Resolves to { screenPath, previewPath, errors } or null; waits <= timeoutMs. */
export async function getScreenshot(resultId, timeoutMs = 3000) {
  const p = registry.get(resultId);
  if (!p) return null;
  return Promise.race([p, new Promise((r) => setTimeout(() => r(null), timeoutMs))]);
}
