/**
 * Debug report upload via Sentry (PAP-1543 / PAP-1463).
 *
 * Sends a `debug_report` message event with the full gear/camera metadata
 * as contexts/tags and attaches the original + cropped photos as binary
 * attachments.  Replaces the previous GitHub Contents-API upload path —
 * the embedded PAT model was rejected as not publishable.
 *
 * Returns the Sentry issue-search URL so callers can surface it in a
 * success toast (the existing callers discard it, but it stays available
 * for future UI use).
 */

import * as FileSystem from 'expo-file-system/legacy';
import { Sentry, SENTRY_ENABLED } from '../sentry';
import { BUILD_LABEL } from '../buildInfo';

const SENTRY_ORG_SLUG = 'paperclip-0l';

/**
 * Read a local photo into a Uint8Array suitable for Sentry attachment.
 * Returns null if the file is missing or unreadable — callers continue
 * uploading the event without the attachment.
 */
async function readPhotoBytes(localPath, label) {
  if (!localPath) return null;
  try {
    const fileUri = localPath.startsWith('file://') ? localPath : `file://${localPath}`;
    const fileInfo = await FileSystem.getInfoAsync(fileUri);
    if (!fileInfo.exists) {
      console.warn(`[DebugShare] ${label} not found at: ${fileUri}`);
      return null;
    }
    const base64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch (e) {
    console.warn(`[DebugShare] Could not read ${label} (path=${localPath}):`, e.message);
    return null;
  }
}

/**
 * Upload a debug report to Sentry.
 *
 * @param {{
 *   photoPath: string|null,
 *   croppedPhotoPath: string|null,
 *   toothCount: number|null,
 *   confidence: number|null,
 *   gearContour: object|null,
 *   actualTeethCount: number|null,
 *   cameraErrors: Array<object>|null,
 *   cameraEvents: Array<object>|null,
 *   cameraHasError: boolean|null,
 *   isCameraReady: boolean|null,
 *   isFocused: boolean|null,
 *   retryKey: number|null,
 *   algorithmRuntimeMs: number|null,
 *   aimCrop: object|null,
 *   policyRetryCount: number|null,
 *   innerContourSuspected: boolean|null,
 *   algoDiag: object|null,
 * }} params
 * @returns {Promise<string>} Sentry issue-search URL filtered to this event.
 */
export async function shareDebugReport({
  photoPath,
  croppedPhotoPath,
  toothCount,
  confidence,
  gearContour,
  actualTeethCount,
  algorithmRuntimeMs,
  aimCrop,
  cameraErrors,
  cameraEvents,
  cameraHasError,
  isCameraReady,
  isFocused,
  retryKey,
  policyRetryCount,
  innerContourSuspected,
  algoDiag,
}) {
  if (!SENTRY_ENABLED) {
    throw new Error('Sentry DSN not configured — cannot upload debug report.');
  }

  const photoBytes = await readPhotoBytes(photoPath, 'photo.jpg');
  const croppedBytes = await readPhotoBytes(croppedPhotoPath, 'cropped.jpg');

  // Use withScope so attachments + contexts are isolated to this event.
  let eventId = '';
  Sentry.withScope((scope) => {
    if (photoBytes) {
      scope.addAttachment({
        filename: 'photo.jpg',
        data: photoBytes,
        contentType: 'image/jpeg',
      });
    }
    if (croppedBytes) {
      scope.addAttachment({
        filename: 'cropped.jpg',
        data: croppedBytes,
        contentType: 'image/jpeg',
      });
    }
    scope.setTags({
      kind: 'debug_report',
      buildLabel: BUILD_LABEL,
      ...(toothCount != null ? { toothCount: String(toothCount) } : {}),
      ...(actualTeethCount != null ? { actualTeethCount: String(actualTeethCount) } : {}),
    });
    scope.setContext('gear', {
      toothCount: toothCount ?? null,
      confidence: confidence != null ? Math.round(confidence * 10000) / 10000 : null,
      actualTeethCount: actualTeethCount ?? toothCount ?? null,
      gearContour: gearContour ?? null,
      aimCrop: aimCrop ?? null,
      algorithmRuntimeMs: algorithmRuntimeMs ?? null,
      policyRetryCount: policyRetryCount ?? null,
      innerContourSuspected: innerContourSuspected ?? null,
      algoDiag: algoDiag ?? null,
    });
    scope.setContext('camera', {
      cameraErrors: cameraErrors ?? [],
      cameraEvents: cameraEvents ?? [],
      cameraHasError: cameraHasError ?? null,
      isCameraReady: isCameraReady ?? null,
      isFocused: isFocused ?? null,
      retryKey: retryKey ?? null,
    });
    eventId = Sentry.captureMessage('debug_report', 'info');
  });

  return `https://${SENTRY_ORG_SLUG}.sentry.io/issues/?query=event.id%3A${eventId}`;
}
