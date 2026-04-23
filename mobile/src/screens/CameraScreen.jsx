import React, { useRef, useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Linking,
  Platform,
  ToastAndroid,
  AppState,
  Modal,
  FlatList,
  Dimensions,
  Image,
} from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import * as FileSystem from 'expo-file-system/legacy';
import { useIsFocused } from '@react-navigation/native';
import { useCameraDevice, Camera, useCameraPermission } from 'react-native-vision-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withRepeat,
  withTiming,
  cancelAnimation,
} from 'react-native-reanimated';
import MotionIndicator from '../components/MotionIndicator';
import { useMotionDetection } from '../hooks/useMotionDetection';
import useGearStore from '../store/useGearStore';
import { countTeeth } from '../algorithm/gearCounter';
import { BUILD_LABEL, BUILD_NUMBER } from '../buildInfo';
import { checkForUpdate, fetchAllBuilds } from '../utils/updateChecker';
import { shareDebugReport } from '../utils/debugShare';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

// PAP-476: aim-circle reticle now ≈ full screen width.  Computed from
// Dimensions at module load (camera screen is portrait-locked elsewhere in
// the app, so a static value is correct).  0.95 of the shorter dimension
// matches the board ask "nearly full screen width".
const _win = Dimensions.get('window');
const AIM_SIZE = Math.floor(0.95 * Math.min(_win.width, _win.height));
// Aim-circle fraction relative to the visible-region's shorter dimension.
// Used by `cropToAimCircle` to compute the photo-space crop side length.
const AIM_CIRCLE_FRAC = 0.95;
// On-screen processed-frame thumbnail size (shown in the processing card).
const PROCESSED_THUMB_SIZE = 160;

/** PAP-476: crop a photo to the bounding square of the aim circle.
 *  The aim circle on screen has diameter `AIM_CIRCLE_FRAC * min(sw, sh)` and
 *  is centered on the visible (cover-mode) region.  In photo coordinates this
 *  maps to a centered square of side `AIM_CIRCLE_FRAC * min(visW, visH)`.
 *  The cropped square is what the tooth-count algorithm runs on; the
 *  algorithm then applies a circular white mask inside, so only the
 *  inscribed circle (the on-screen aim circle) is processed.
 *  Returns { path, aimCrop } where aimCrop has the offsets/sizes needed to
 *  translate algorithm-space gear-center coords back to original-photo
 *  fractional coords (consumed by ResultScreen's overlay math). */
async function cropToAimCircle(photoPath) {
  const { width: sw, height: sh } = Dimensions.get('window');
  const photoUri = `file://${photoPath}`;
  const info = await manipulateAsync(photoUri, [], {});
  const scale = Math.max(sw / info.width, sh / info.height);
  const visW = sw / scale;
  const visH = sh / scale;
  const minVis = Math.min(visW, visH);
  // Square side = aim-circle diameter in photo coords.  Clamp so the crop
  // never extends beyond the photo (defensive — should not happen for the
  // covered visible region).
  const side = Math.min(
    Math.round(AIM_CIRCLE_FRAC * minVis),
    info.width,
    info.height,
  );
  const originX = Math.max(0, Math.round((info.width - side) / 2));
  const originY = Math.max(0, Math.round((info.height - side) / 2));
  const cropped = await manipulateAsync(
    photoUri,
    [{ crop: { originX, originY, width: side, height: side } }],
    { compress: 0.92, format: SaveFormat.JPEG },
  );
  return {
    path: cropped.uri.replace(/^file:\/\//, ''),
    aimCrop: { originX, originY, side, fullW: info.width, fullH: info.height },
  };
}

/** Crop a photo to the area visible in the full-screen camera preview (cover mode).
 *  Returns { path, crop } where crop contains the parameters needed to transform
 *  algorithm coordinates (relative to the original photo) into cropped-photo space. */
async function cropToPreview(photoPath) {
  try {
    const { width: sw, height: sh } = Dimensions.get('window');
    const photoUri = `file://${photoPath}`;
    const info = await manipulateAsync(photoUri, [], {});
    const scale = Math.max(sw / info.width, sh / info.height);
    const visW = Math.round(sw / scale);
    const visH = Math.round(sh / scale);
    if (Math.abs(info.width - visW) < 2 && Math.abs(info.height - visH) < 2) {
      return { path: photoPath, crop: null };
    }
    const originX = Math.round((info.width - visW) / 2);
    const originY = Math.round((info.height - visH) / 2);
    const cropped = await manipulateAsync(
      photoUri,
      [{ crop: { originX, originY, width: visW, height: visH } }],
      { compress: 0.92, format: SaveFormat.JPEG },
    );
    return {
      path: cropped.uri.replace(/^file:\/\//, ''),
      crop: { originX, originY, fullW: info.width, fullH: info.height, visW, visH },
    };
  } catch {
    return { path: photoPath, crop: null };
  }
}

export default function CameraScreen({ navigation }) {
  const camera = useRef(null);
  // Prefer wide-angle lens during aiming — keeps the gear in frame without
  // requiring the user to hold the phone far away.  The algorithm crops and
  // scales internally, so capturing wide is fine.
  // Fall back to the standard back camera if the wide-angle device fires an
  // error at runtime.  Android OEM Camera2 metadata is unreliable — some
  // ultra-wide lenses report photoWidth > 0 in their formats yet still fail
  // when VisionCamera tries to configure a photo session.  A static formats
  // pre-check is therefore insufficient; we detect failure via onError and
  // switch devices dynamically (once, guarded by a ref to avoid loops).
  const wideAngleDevice = useCameraDevice('back', { physicalDevices: ['wide-angle-camera'] });
  const mainDevice = useCameraDevice('back');
  const [wideAngleFailed, setWideAngleFailed] = useState(false);
  const wideAngleFailedRef = useRef(false);
  const device = (!wideAngleFailed && wideAngleDevice) ? wideAngleDevice : mainDevice;
  const { hasPermission, requestPermission } = useCameraPermission();

  const [isCameraReady, setIsCameraReady] = useState(false);
  const isCameraReadyRef = useRef(false);
  // Pause the live preview once we have a captured photo. Keeps the sensor
  // from burning battery while the algorithm is counting teeth and while the
  // Result screen is showing. Resumes on focus (Reset button navigates here).
  const [previewPaused, setPreviewPaused] = useState(false);
  const [updateInfo, setUpdateInfo] = useState({ available: false, latestBuild: null, downloadUrl: '', allBuilds: [] });
  // Declared before handleCapture so the capture guard can read it.
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const isFocused = useIsFocused();

  const { setProcessing, setResult, setError, isProcessing, reset: resetStore } = useGearStore();

  const cameraErrorsRef = useRef([]);
  const cameraEventsRef = useRef([]);
  const [cameraHasError, setCameraHasError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [sharingDebug, setSharingDebug] = useState(false);
  const [isPolicyRestricted, setIsPolicyRestricted] = useState(false);
  const [showBuildPicker, setShowBuildPicker] = useState(false);
  const [pickerBuilds, setPickerBuilds] = useState([]);
  const policyRetryCountRef = useRef(0);
  // PAP-476: URI of the aim-circle-cropped photo, displayed as a circular
  // thumbnail in the processing card so the user can verify what the
  // algorithm sees during counting.  Cleared on reset / failure / cancel.
  const [processedThumbUri, setProcessedThumbUri] = useState(null);

  const pulseScale = useSharedValue(1);
  const aimOpacity = useSharedValue(0.5);
  const motionResetRef = useRef(null);
  const captureGenRef = useRef(0);
  const abortRef = useRef(null);

  // ── Capture handler ────────────────────────────────────────────────────
  const handleCapture = useCallback(async () => {
    // Guard against capturing while a download is in progress — navigating
    // away mid-download would interrupt the in-flight FileSystem.downloadAsync.
    if (!camera.current || isProcessing || !isCameraReadyRef.current || downloading || !isFocused) return;

    const gen = ++captureGenRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    motionResetRef.current?.();
    setProcessing(true);

    try {
      const photo = await camera.current.takePhoto({
        flash: device?.hasFlash ? 'on' : 'off',
        qualityPrioritization: 'quality',
      });

      // Pause the live preview now that the frame is in-hand — the algorithm
      // runs on the saved file, so the sensor can go idle during counting
      // and while the Result screen is shown.
      setPreviewPaused(true);

      // PAP-476: pre-crop the photo to the aim-circle bounding square so the
      // algorithm only processes pixels inside the on-screen reticle.  Show
      // the cropped image as the processing-card thumbnail (the algorithm
      // also applies a circular white mask inside this square so the four
      // corners are ignored — visualized via the circular border-radius on
      // the thumbnail).  cropToPreview runs in parallel for ResultScreen
      // display.
      const aim = await cropToAimCircle(photo.path);
      if (gen !== captureGenRef.current) return; // cancelled or superseded
      setProcessedThumbUri(`file://${aim.path}`);

      const [cropResult, result] = await Promise.all([
        cropToPreview(photo.path),
        countTeeth(`file://${aim.path}`, ac.signal, { aimCrop: aim.aimCrop }),
      ]);
      const displayPath = cropResult.path;
      const cropParams = cropResult.crop;

      if (gen !== captureGenRef.current) return; // cancelled or superseded

      if (!result) {
        cameraEventsRef.current.push({ type: 'noDetection', ts: new Date().toISOString(), reason: 'countTeeth returned null' });
        setProcessing(false);
        setPreviewPaused(false); // stay on camera — resume live preview
        setProcessedThumbUri(null);
        motionResetRef.current?.();
        if (Platform.OS === 'android') {
          ToastAndroid.show('No gear detected — try again', ToastAndroid.SHORT);
        }
        return;
      }

      setResult({
        toothCount:  result.toothCount,
        confidence:  result.confidence,
        gearContour: {
          centerX: result.gearCenter.x,
          centerY: result.gearCenter.y,
          radius:  result.gearRadius,
        },
        algorithmRuntimeMs: result.algorithmRuntimeMs,
      });

      navigation.navigate('Result', {
        photoPath: displayPath,
        originalPhotoPath: photo.path,
        cropParams,
        cameraErrors: cameraErrorsRef.current,
        cameraEvents: cameraEventsRef.current,
      });
    } catch (e) {
      if (gen !== captureGenRef.current) return; // cancelled or superseded
      if (e.name === 'AbortError') return; // user pressed cancel
      cameraErrorsRef.current.push({ type: 'processingError', ts: new Date().toISOString(), message: e.message, stack: e.stack });
      setError(e.message);
      Alert.alert('Processing failed', e.message);
      setProcessing(false);
      setPreviewPaused(false); // resume live preview after failure
      setProcessedThumbUri(null);
      motionResetRef.current?.();
    }
  }, [isProcessing, downloading, isFocused, navigation, setError, setProcessing, setResult]);

  const handleCancel = useCallback(() => {
    captureGenRef.current++;
    abortRef.current?.abort();
    setProcessing(false);
    setPreviewPaused(false); // resume live preview after cancel
    setProcessedThumbUri(null);
    motionResetRef.current?.();
  }, [setProcessing]);

  // ── Motion detection ───────────────────────────────────────────────────
  // Disabled during download to prevent auto-trigger from navigating away
  // mid-flight and interrupting the in-progress FileSystem.downloadAsync.
  const { isStable, gearDetected, frameProcessor, reset: motionReset, usingFallback } = useMotionDetection({
    onStable: handleCapture,
    enabled: isFocused && isCameraReady && !isProcessing && !downloading && hasPermission,
  });

  useEffect(() => { motionResetRef.current = motionReset; }, [motionReset]);

  // Pulse aim circle when stable
  useEffect(() => {
    if (isStable) {
      pulseScale.value = withRepeat(withSpring(1.08, { damping: 4 }), -1, true);
      aimOpacity.value = withTiming(1.0, { duration: 300 });
    } else {
      cancelAnimation(pulseScale);
      pulseScale.value = withSpring(1.0);
      aimOpacity.value = withTiming(0.5, { duration: 300 });
    }
  }, [isStable, aimOpacity, pulseScale]);

  // Reset on focus
  useEffect(() => {
    const unsub = navigation.addListener('focus', () => {
      resetStore();
      motionReset();
      isCameraReadyRef.current = false;
      setIsCameraReady(false);
      setCameraHasError(false);
      setIsPolicyRestricted(false);
      policyRetryCountRef.current = 0;
      setPreviewPaused(false); // resume live preview (e.g. Reset from Result)
    });
    return unsub;
  }, [navigation, resetStore, motionReset]);

  // AppState-triggered retry for policy-restricted camera.
  // When the OS blocks the camera (screen lock / device policy), we subscribe
  // to AppState so the retry fires only when the user actually returns to the
  // app after unlocking — instead of a blind timer that fires too early.
  useEffect(() => {
    if (!isPolicyRestricted) return;
    let settleTimer = null;
    const sub = AppState.addEventListener('change', (nextState) => {
      cameraEventsRef.current.push({ type: 'appState', ts: new Date().toISOString(), nextState, isPolicyRestricted: true });
      if (nextState === 'active') {
        cameraEventsRef.current.push({ type: 'policyRetry', ts: new Date().toISOString(), retryKey: retryKey + 1, policyRetryCount: policyRetryCountRef.current, trigger: 'appState' });
        setCameraHasError(false);
        // Delay remount to let camera hardware settle after OS releases it.
        // setIsPolicyRestricted(false) must be inside the timeout — calling it
        // here would trigger effect cleanup and cancel the settle timer.
        settleTimer = setTimeout(() => {
          setIsPolicyRestricted(false);
          policyRetryCountRef.current = 0;
          isCameraReadyRef.current = false;
          setIsCameraReady(false);
          setRetryKey((k) => k + 1);
        }, 400);
      }
    });
    return () => { sub.remove(); if (settleTimer) clearTimeout(settleTimer); };
  }, [isPolicyRestricted]);

  // ── Permission gate ────────────────────────────────────────────────────
  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  // ── Update check on mount ──────────────────────────────────────────────
  useEffect(() => {
    checkForUpdate()
      .then((info) => setUpdateInfo(info))
      .catch(() => { /* silent — no error toasts */ });
  }, []);

  // ── Download + install a specific build ───────────────────────────────
  const downloadAndInstall = useCallback(async (build) => {
    if (!build.downloadUrl) {
      Alert.alert('No APK available', 'This release has no downloadable APK.');
      return;
    }
    if (Platform.OS === 'android') {
      try {
        setDownloading(true);
        setDownloadProgress(0);
        const fileName = build.downloadUrl.split('/').pop() || `build-${build.buildNumber}.apk`;
        const destUri = FileSystem.cacheDirectory + fileName;
        const downloadResumable = FileSystem.createDownloadResumable(
          build.downloadUrl,
          destUri,
          {},
          ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
            if (totalBytesExpectedToWrite > 0) {
              setDownloadProgress(totalBytesWritten / totalBytesExpectedToWrite);
            }
          },
        );
        const result = await downloadResumable.downloadAsync();
        if (!result || result.status !== 200) {
          throw new Error(`Download failed (HTTP ${result?.status ?? 'unknown'})`);
        }
        const uri = result.uri;
        const contentUri = await FileSystem.getContentUriAsync(uri);
        // Use ACTION_INSTALL_PACKAGE instead of ACTION_VIEW so the Android
        // Package Installer is the exclusive handler.  ACTION_VIEW with the
        // APK MIME type can be intercepted by Chrome on some devices.
        await IntentLauncher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', {
          data: contentUri,
          flags: 268435457, // FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK
        });
      } catch (e) {
        Alert.alert('Download failed', e.message);
      } finally {
        setDownloading(false);
      }
    } else {
      try {
        await Linking.openURL(build.downloadUrl);
      } catch (e) {
        Alert.alert('Download failed', e.message);
      }
    }
  }, []);

  // ── Download icon handler — show list of available builds ──────────────
  const handleUpdatePress = useCallback(async () => {
    let builds = updateInfo.allBuilds;

    // If we haven't loaded the full list yet, fetch it now.
    if (!builds || builds.length === 0) {
      try {
        builds = await fetchAllBuilds();
      } catch (e) {
        Alert.alert('Could not load builds', e.message);
        return;
      }
    }

    if (!builds || builds.length === 0) {
      Alert.alert('No builds found', 'No test builds are available on GitHub Releases.');
      return;
    }

    setPickerBuilds(builds);
    setShowBuildPicker(true);
  }, [updateInfo]);

  // ── Debug report from camera screen ────────────────────────────────
  const handleDebugReport = useCallback(async () => {
    setSharingDebug(true);
    try {
      await shareDebugReport({
        photoPath: null,
        toothCount: null,
        confidence: null,
        gearContour: null,
        actualTeethCount: null,
        cameraErrors: cameraErrorsRef.current,
        cameraEvents: cameraEventsRef.current,
        cameraHasError,
        isCameraReady,
        isFocused,
        retryKey,
        policyRetryCount: policyRetryCountRef.current,
      });
      // Button state change (setSharingDebug) is sufficient feedback — no toast needed.
    } catch (e) {
      Alert.alert('Debug report failed', e.message);
    } finally {
      setSharingDebug(false);
    }
  }, [cameraHasError, isCameraReady, isFocused, retryKey]);

  const aimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
    opacity: aimOpacity.value,
  }));

  if (!hasPermission) {
    return (
      <View style={styles.noCamera}>
        <Text style={styles.noCameraText}>Camera permission required</Text>
        <TouchableOpacity style={styles.permButton} onPress={requestPermission}>
          <Text style={styles.permButtonText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.noCamera}>
        <Text style={styles.noCameraText}>No camera available</Text>
      </View>
    );
  }

  const captureDisabled = isProcessing || !isCameraReady || !isFocused;

  return (
    <View style={styles.container}>
      {/* Full-screen camera preview — frameProcessor always attached; worklet
           self-gates via enabledSV shared value to avoid session reconfiguration */}
      <Camera
        key={retryKey}
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={isFocused && !previewPaused}
        photo={true}
        video={true}
        pixelFormat="yuv"
        torch={device?.hasTorch ? 'on' : 'off'}
        frameProcessor={frameProcessor}
        onInitialized={() => {
          cameraEventsRef.current.push({ type: 'initialized', ts: new Date().toISOString(), retryKey, deviceId: device?.id ?? null, alreadyReady: isCameraReadyRef.current, hasTorch: !!device?.hasTorch, hasFlash: !!device?.hasFlash });
          // Guard against spurious duplicate onInitialized from VisionCamera.
          // All state updates are inside the guard to avoid re-renders that
          // would recreate the frameProcessor reference and trigger another
          // session reconfiguration cycle.
          if (!isCameraReadyRef.current) {
            isCameraReadyRef.current = true;
            setIsCameraReady(true);
            // Clear any lingering error state — the camera recovered.
            setCameraHasError(false);
            setIsPolicyRestricted(false);
          }
        }}
        onError={(e) => {
          console.warn('Camera error:', e.message);
          const isPolicyError = e.code === 'system/camera-is-restricted';
          const isFlashError = e.code === 'device/flash-not-available';
          const isWideAngleFallback =
            !wideAngleFailedRef.current &&
            wideAngleDevice?.id &&
            mainDevice?.id &&
            wideAngleDevice.id !== mainDevice.id;
          cameraErrorsRef.current.push({
            timestamp: new Date().toISOString(),
            message: e.message,
            deviceId: device?.id ?? null,
            wideAngleFallback: !!isWideAngleFallback,
            policyRestricted: isPolicyError,
            flashError: isFlashError,
          });
          cameraEventsRef.current.push({
            type: 'error',
            ts: new Date().toISOString(),
            code: e.code ?? null,
            message: e.message,
            policyRestricted: isPolicyError,
            flashError: isFlashError,
            wideAngleFallback: !!isWideAngleFallback,
            retryKey,
            policyRetryCount: policyRetryCountRef.current,
          });
          // Flash-unavailable is non-fatal — camera can still work without torch.
          if (isFlashError) {
            console.warn('Camera: flash not available on this device, continuing without torch');
            return;
          }
          // If the wide-angle device errored and we haven't already fallen back,
          // switch to the main camera.  Only bother when they are different
          // devices (different ids); if they are the same there is nothing to
          // fall back to.
          if (isWideAngleFallback) {
            console.warn('Camera: wide-angle failed, falling back to main camera');
            isCameraReadyRef.current = false;
            wideAngleFailedRef.current = true;
            setWideAngleFailed(true);
            setIsCameraReady(false); // hold UI locked until main camera initialises
          } else if (isPolicyError && policyRetryCountRef.current < 1) {
            // OS-level camera restriction (screen-lock / keyguard / device policy).
            // AppState listener auto-retries when the user returns to the app.
            console.warn('Camera: device-policy restriction detected, will retry on AppState active');
            isCameraReadyRef.current = false;
            setIsCameraReady(false);
            setIsPolicyRestricted(true);
            setCameraHasError(true);
            policyRetryCountRef.current += 1;
          } else if (!isPolicyError && policyRetryCountRef.current > 0) {
            // Non-policy config error right after a policy retry — the camera
            // hardware wasn't ready yet.  Auto-retry once with a delay.
            console.warn('Camera: post-policy config error, auto-retrying after delay');
            cameraEventsRef.current.push({ type: 'postPolicyAutoRetry', ts: new Date().toISOString(), retryKey: retryKey + 1, policyRetryCount: policyRetryCountRef.current });
            isCameraReadyRef.current = false;
            setIsCameraReady(false);
            policyRetryCountRef.current = 0;
            setTimeout(() => {
              setRetryKey((k) => k + 1);
            }, 500);
          } else {
            isCameraReadyRef.current = false;
            setIsCameraReady(false); // keep UI locked — camera session is broken
            if (isPolicyError) setIsPolicyRestricted(true);
            setCameraHasError(true);
          }
        }}
      />

      {/* Overlay UI — separate from camera so layout can't affect preview */}
      <SafeAreaView style={StyleSheet.absoluteFill} edges={['top', 'bottom']} pointerEvents="box-none">

        {/* Top bar */}
        <View style={styles.topBar}>
          {isCameraReady
            ? <MotionIndicator stable={isStable} gearDetected={gearDetected} />
            : <Text style={styles.initText}>{cameraHasError ? (isPolicyRestricted ? 'Camera blocked by OS' : 'Camera error') : 'Starting camera…'}</Text>
          }
          <TouchableOpacity
            style={styles.debugIcon}
            onPress={handleDebugReport}
            disabled={sharingDebug}
            activeOpacity={0.7}
          >
            <Text style={styles.debugIconText}>{sharingDebug ? '…' : '🐛'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.updateIcon, updateInfo.available && styles.updateIconActive]}
            onPress={handleUpdatePress}
            activeOpacity={0.7}
          >
            <Text style={[styles.updateIconText, updateInfo.available && styles.updateIconTextActive]}>⬇</Text>
          </TouchableOpacity>
        </View>

        {/* Aim circle */}
        <View style={styles.aimGuide} pointerEvents="none">
          <Animated.View style={[styles.aimCircle, gearDetected && !isStable && styles.aimCircleGear, isStable && styles.aimCircleStable, aimStyle]} />
        </View>

        {/* Processing overlay */}
        {isProcessing && (
          <View style={styles.processingOverlay}>
            <View style={styles.processingCard}>
              <Text style={styles.processingTitle}>Counting teeth…</Text>
              {/* PAP-476: live preview of the exact image fed to the algorithm.
                  The square crop matches cropToAimCircle's output and the
                  circular border-radius visualises the white mask applied
                  inside countTeeth (corners are ignored by the detector). */}
              {processedThumbUri && (
                <View style={styles.processedThumbWrap}>
                  <Image
                    source={{ uri: processedThumbUri }}
                    style={styles.processedThumbImg}
                    resizeMode="cover"
                  />
                </View>
              )}
              <Text style={styles.processingHint}>This takes about 1–2 seconds</Text>
              <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel} activeOpacity={0.8}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Download overlay */}
        {downloading && (
          <View style={styles.processingOverlay}>
            <View style={styles.processingCard}>
              <Text style={styles.processingTitle}>Downloading APK…</Text>
              <View style={styles.progressBarTrack}>
                <View style={[styles.progressBarFill, { width: `${Math.round(downloadProgress * 100)}%` }]} />
              </View>
              <Text style={styles.processingHint}>{Math.round(downloadProgress * 100)}%</Text>
            </View>
          </View>
        )}

        {/* Bottom controls */}
        <View style={styles.bottomBar}>
          <Text style={styles.hint}>
            {cameraHasError
              ? (isPolicyRestricted
                ? 'Camera blocked by OS — unlock your phone'
                : 'Camera error — tap Retry below')
              : !isCameraReady
              ? 'Starting camera…'
              : isProcessing
              ? 'Processing…'
              : isStable
              ? 'Stable — capturing automatically…'
              : !gearDetected
              ? 'Center gear in the circle'
              : 'Gear found — hold steady…'}
          </Text>

          {cameraHasError && (
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => {
                cameraEventsRef.current.push({ type: 'retryButton', ts: new Date().toISOString(), isPolicyRestricted, retryKey });
                setCameraHasError(false);
                if (isPolicyRestricted) {
                  cameraEventsRef.current.push({ type: 'policyRetry', ts: new Date().toISOString(), retryKey: retryKey + 1, policyRetryCount: policyRetryCountRef.current, trigger: 'button' });
                  // User explicitly tapped Retry after (presumably) unlocking.
                  // Immediate remount — no delay needed.
                  isCameraReadyRef.current = false;
                  setIsCameraReady(false);
                  setIsPolicyRestricted(false);
                  policyRetryCountRef.current = 0;
                  setRetryKey((k) => k + 1);
                } else {
                  isCameraReadyRef.current = false;
                  setIsCameraReady(false);
                  setRetryKey((k) => k + 1);
                }
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.retryButtonText}>Retry Camera</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[styles.captureButton, captureDisabled && styles.captureButtonDisabled]}
            onPress={handleCapture}
            disabled={captureDisabled}
            activeOpacity={0.8}
          >
            <View style={styles.captureButtonInner} />
          </TouchableOpacity>

          <Text style={styles.manualLabel}>tap to capture manually</Text>
          <Text style={styles.buildLabel}>{BUILD_LABEL}</Text>
        </View>

      </SafeAreaView>

      {/* Build picker modal */}
      <Modal
        visible={showBuildPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowBuildPicker(false)}
      >
        <View style={styles.pickerOverlay}>
          <View style={styles.pickerSheet}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>Available test builds</Text>
              <TouchableOpacity
                style={styles.pickerClose}
                onPress={() => setShowBuildPicker(false)}
                activeOpacity={0.7}
              >
                <Text style={styles.pickerCloseText}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.pickerSubtitle}>You have build {BUILD_NUMBER}.</Text>
            <FlatList
              data={pickerBuilds}
              keyExtractor={(item) => String(item.buildNumber)}
              style={styles.pickerList}
              renderItem={({ item }) => {
                const tag = item.buildNumber === BUILD_NUMBER
                  ? ' · current'
                  : item.buildNumber > BUILD_NUMBER
                  ? ' · newer'
                  : ' · older';
                return (
                  <TouchableOpacity
                    style={styles.pickerItem}
                    onPress={() => {
                      setShowBuildPicker(false);
                      downloadAndInstall(item);
                    }}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.pickerItemText}>
                      {item.releaseName} (build {item.buildNumber}){tag}
                    </Text>
                  </TouchableOpacity>
                );
              }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },

  noCamera: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000', gap: 16 },
  noCameraText: { color: '#fff', fontSize: 16 },
  permButton: { backgroundColor: '#fff', paddingHorizontal: 24, paddingVertical: 10, borderRadius: 20 },
  permButtonText: { fontSize: 15, fontWeight: '600', color: '#111' },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 12,
    paddingHorizontal: 16,
  },

  debugIcon: {
    position: 'absolute',
    right: 56,
    top: 12,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  debugIconText: {
    fontSize: 16,
  },

  updateIcon: {
    position: 'absolute',
    right: 16,
    top: 12,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  updateIconActive: {
    backgroundColor: '#4CAF50',
  },
  updateIconText: {
    fontSize: 16,
    color: 'rgba(255,255,255,0.45)',
  },
  updateIconTextActive: {
    color: '#fff',
  },

  initText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
  },

  aimGuide: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  aimCircle: {
    width: AIM_SIZE,
    height: AIM_SIZE,
    borderRadius: AIM_SIZE / 2,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  aimCircleGear: {
    borderColor: '#FFD600',
    borderWidth: 3,
  },
  aimCircleStable: {
    borderColor: '#4CAF50',
    borderWidth: 3,
  },

  bottomBar: {
    paddingBottom: 12,
    paddingHorizontal: 24,
    alignItems: 'center',
    gap: 16,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },

  hint: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 15,
    textAlign: 'center',
  },

  captureButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  captureButtonDisabled: { opacity: 0.35 },
  captureButtonInner: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#fff',
  },

  manualLabel: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 12,
  },

  buildLabel: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 10,
    letterSpacing: 0.3,
  },

  processingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  processingCard: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 20,
    paddingHorizontal: 36,
    paddingVertical: 24,
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  processingTitle: { color: '#fff', fontSize: 20, fontWeight: '700' },
  processedThumbWrap: {
    width: PROCESSED_THUMB_SIZE,
    height: PROCESSED_THUMB_SIZE,
    borderRadius: PROCESSED_THUMB_SIZE / 2,
    overflow: 'hidden',
    marginTop: 8,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
    backgroundColor: '#fff',
  },
  processedThumbImg: {
    width: '100%',
    height: '100%',
  },
  progressBarTrack: {
    width: '100%',
    height: 6,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#4CAF50',
    borderRadius: 3,
  },
  processingHint:  { color: 'rgba(255,255,255,0.55)', fontSize: 13 },
  cancelBtn: {
    marginTop: 16,
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 28,
    paddingVertical: 10,
    borderRadius: 20,
  },
  cancelBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  retryButton: {
    backgroundColor: '#fff',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 24,
  },
  retryButtonText: {
    color: '#111',
    fontSize: 15,
    fontWeight: '600',
  },

  pickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingBottom: 32,
    maxHeight: '70%',
  },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 4,
  },
  pickerTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  pickerClose: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pickerCloseText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  pickerSubtitle: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  pickerList: {
    paddingHorizontal: 12,
  },
  pickerItem: {
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  pickerItemText: {
    color: '#fff',
    fontSize: 15,
  },
});
