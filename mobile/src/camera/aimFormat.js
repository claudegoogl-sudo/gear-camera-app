import { getCameraFormat } from 'react-native-vision-camera';

/**
 * PAP-1882 — WYSIWYG aim: pin the preview stream's aspect to the photo's.
 *
 * FP5 operator report on b153: "the camera used for the aiming screen and the
 * camera that actually takes the foto are still different and it is very hard
 * to aim like that."
 *
 * Root cause (code-verified against vision-camera 4.7.3):
 * - CameraScreen never passes a `format`, so vision-camera lets CameraX/HAL
 *   pick the Preview stream resolution independently of ImageCapture. On many
 *   OEM HALs (Xiaomi logical multi-cameras included) the default preview is
 *   16:9 while the photo is the full 4:3 sensor readout.
 * - CameraSession+Configuration.kt only targets the Preview at a format's
 *   video size when a `format` prop is present ("Preview will follow video
 *   size as its size & aspect ratio, or photo- if video is disabled").
 * - cropToAimCircle (CameraScreen) maps the on-screen reticle into photo
 *   space assuming the preview displays the PHOTO cover-fit. With a 16:9
 *   preview under a 20:9 screen that assumption breaks by ~2.4x in scene
 *   scale: the gear the user centers in the reticle lands at a very
 *   different size/offset in the photo — aim becomes guesswork and big gears
 *   clipped at crop edges read as failures at every size.
 *
 * Fix: select an explicit format whose VIDEO (→ preview) aspect is 4:3 — the
 * photo aspect — while keeping the photo at maximum resolution. The preview
 * then displays the same scene slice the photo (and therefore the analysis
 * crop) contains, on every device that exposes a 4:3 video size. Devices
 * without any 4:3 video size fall back to the closest aspect (16:9), i.e.
 * today's behavior — strictly no worse.
 *
 * Scope guards:
 * - ImageAnalysis (frame processor / CRES) configuration is independent of
 *   `format` in vision-camera — auto-capture behavior is unchanged.
 * - Photo resolution: `photoResolution: 'max'` keeps the full-res capture the
 *   algorithm pipeline expects; crop geometry is resolution-relative and
 *   adapts automatically.
 * - Filter priority: getCameraFormat scores filters additively in priority
 *   order — aspect parity (priority 2) always outranks photo resolution
 *   (priority 1), so WYSIWYG never trades away for resolution.
 */
export const AIM_FORMAT_FILTERS = [
  { videoAspectRatio: 4 / 3 }, // preview follows video size ⇒ parity with the 4:3 photo
  { photoResolution: 'max' }, // keep full-res capture for the algorithm
];

/**
 * Resolve the aim-WYSIWYG format for a device, or undefined when the device
 * cannot (yet) provide formats. Never throws — a scoring failure must not
 * take down the camera screen; the session then runs with the library
 * default (previous behavior).
 *
 * @param {import('react-native-vision-camera').CameraDevice} [device]
 * @returns {import('react-native-vision-camera').CameraDeviceFormat|undefined}
 */
export function resolveAimFormat(device) {
  if (!device || !Array.isArray(device.formats) || device.formats.length === 0) {
    return undefined;
  }
  try {
    return getCameraFormat(device, AIM_FORMAT_FILTERS) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Compact orientation-agnostic aspect string for telemetry events
 *  ("4:3", "16:9", "1.56:1"). Portrait and landscape of the same sensor
 *  shape classify identically — the telemetry parity check compares shape,
 *  not orientation (photo output is portrait via outputOrientation="preview",
 *  video/preview sizes are landscape-native). */
export function aspectLabel(width, height) {
  if (!width || !height) return null;
  const ratio = Math.max(width, height) / Math.min(width, height);
  const known = [
    [4 / 3, '4:3'],
    [16 / 9, '16:9'],
    [1, '1:1'],
    [21 / 9, '21:9'],
  ];
  for (const [value, label] of known) {
    if (Math.abs(ratio - value) < 0.02) return label;
  }
  return `${ratio.toFixed(2)}:1`;
}
