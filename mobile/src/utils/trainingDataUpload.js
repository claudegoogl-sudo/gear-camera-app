/**
 * Training-sample upload via Sentry (PAP-1543 / PAP-1463).
 *
 * Mirrors debugShare but emits a `training_sample` event with a distinct
 * `kind` tag so the triage routine can filter the two streams apart.
 * Fire-and-forget — failures are logged and never block the UI.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { Sentry, SENTRY_ENABLED } from '../sentry';
import { BUILD_LABEL } from '../buildInfo';

/**
 * @param {{
 *   photoPath: string,
 *   toothCount: number|null,
 *   confidence: number|null,
 *   gearContour: {centerX: number, centerY: number, radius: number}|null,
 *   actualTeethCount: number|null,
 * }} params
 */
export async function uploadTrainingData({ photoPath, toothCount, confidence, gearContour, actualTeethCount }) {
  if (!SENTRY_ENABLED || !photoPath) return;

  try {
    const fileUri = photoPath.startsWith('file://') ? photoPath : `file://${photoPath}`;
    const fileInfo = await FileSystem.getInfoAsync(fileUri);
    if (!fileInfo.exists) {
      console.warn('[TrainingData] Photo not found:', fileUri);
      return;
    }
    // 20MB matches Sentry init's maxAttachmentSize ceiling — skip oversized
    // captures rather than have the SDK silently drop the attachment.
    if (fileInfo.size > 20 * 1024 * 1024) {
      console.warn('[TrainingData] Photo too large, skipping upload:', fileInfo.size, 'bytes');
      return;
    }

    const base64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    Sentry.withScope((scope) => {
      scope.addAttachment({
        filename: 'photo.jpg',
        data: bytes,
        contentType: 'image/jpeg',
      });
      scope.setTags({
        kind: 'training_sample',
        buildLabel: BUILD_LABEL,
        ...(toothCount != null ? { toothCount: String(toothCount) } : {}),
        ...(actualTeethCount != null ? { actualTeethCount: String(actualTeethCount) } : {}),
      });
      scope.setContext('gear', {
        toothCount: toothCount ?? null,
        confidence: confidence != null ? Math.round(confidence * 10000) / 10000 : null,
        gearContour: gearContour ?? null,
        actualTeethCount: actualTeethCount ?? toothCount ?? null,
      });
      Sentry.captureMessage('training_sample', 'info');
    });
  } catch (e) {
    console.warn('[TrainingData] Upload error (non-fatal):', e.message);
  }
}
