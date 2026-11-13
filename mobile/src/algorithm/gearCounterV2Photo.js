/**
 * Photo entry point for gear counter v2: JPEG file -> RGBA -> countTeethV2 -> the result shape the screens use.
 *
 * The caller passes a crop that shows the WHOLE gear with margin (CameraScreen: aim circle + padding,
 * resized natively to V2_INPUT_SIDE). No circular mask is applied: masking at the aim circle cut the
 * tooth tips whenever the user filled the circle with the gear.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { decode as jpegDecode } from 'jpeg-js';
import { bilinearDownsampleRgba } from './gearCounter';
import { countTeethV2 } from './gearCounterV2';

/** Long side of the frame handed to countTeethV2 (measured: 1024 px keeps 52T chainrings countable). */
export const V2_INPUT_SIDE = 1024;

/** Map a countTeethV2 result (pixels of the analysed frame) to the legacy result shape (fractions of the photo). */
export function toLegacyResult(v2, width, height, aimCrop, timing) {
  const abstained = v2.toothCount === 0;
  let gearCenter = null, gearRadius = null;
  if (v2.gearCenter) {
    gearCenter = { x: v2.gearCenter.x / width, y: v2.gearCenter.y / height };
    gearRadius = v2.gearRadius / width;
    if (aimCrop) {
      const { originX, originY, side, fullW, fullH } = aimCrop;
      gearCenter = { x: (originX + gearCenter.x * side) / fullW, y: (originY + gearCenter.y * side) / fullH };
      gearRadius = (gearRadius * side) / fullW;
    }
  }
  return {
    toothCount: v2.toothCount,
    confidence: v2.confidence,
    gearCenter: abstained ? null : gearCenter,
    gearRadius: abstained ? null : gearRadius,
    abstained,
    abstainReason: abstained ? `v2-${v2.abstainReason}` : null,
    methodUsed: 'v2',
    rawCount: v2.rawCount,
    v2Diag: v2.diag,
    algorithmRuntimeMs: timing.total,
    stageMs: { load: timing.load, ...v2.stageMs, total: timing.total, px: width * height },
  };
}

export async function countTeethV2FromPhoto(photoUri, signal, opts) {
  const t0 = Date.now();
  const base64 = await FileSystem.readAsStringAsync(photoUri, { encoding: FileSystem.EncodingType.Base64 });
  const binary = atob(base64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  const full = jpegDecode(buf, { useTArray: true });
  const { rgba, width, height } = bilinearDownsampleRgba(full.data, full.width, full.height, V2_INPUT_SIDE);
  const t1 = Date.now();
  // let a pending cancel press through before the count starts
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (signal?.aborted) throw new DOMException('Processing cancelled', 'AbortError');
  const v2 = countTeethV2(rgba, width, height);
  return toLegacyResult(v2, width, height, opts && opts.aimCrop ? opts.aimCrop : null, { load: t1 - t0, total: Date.now() - t0 });
}
