import React, { useRef, useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Linking,
  Platform,
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
  const [updateInfo, setUpdateInfo] = useState({ available: false, latestBuild: null, downloadUrl: '', allBuilds: [] });
  // Declared before handleCapture so the capture guard can read it.
  const [downloading, setDownloading] = useState(false);
  const isFocused = useIsFocused();

  const { setProcessing, setResult, setError, isProcessing, reset: resetStore } = useGearStore();

  const pulseScale = useSharedValue(1);
  const aimOpacity = useSharedValue(0.5);
  const motionResetRef = useRef(null);

  // ── Capture handler ────────────────────────────────────────────────────
  const handleCapture = useCallback(async () => {
    // Guard against capturing while a download is in progress — navigating
    // away mid-download would interrupt the in-flight FileSystem.downloadAsync.
    if (!camera.current || isProcessing || !isCameraReady || downloading) return;

    motionResetRef.current?.();
    setProcessing(true);

    try {
      const photo = await camera.current.takePhoto({
        flash: 'on',
        qualityPrioritization: 'quality',
      });

      const result = await countTeeth(`file://${photo.path}`);

      setResult({
        toothCount:  result.toothCount,
        confidence:  result.confidence,
        gearContour: {
          centerX: result.gearCenter.x,
          centerY: result.gearCenter.y,
          radius:  result.gearRadius,
        },
      });

      navigation.navigate('Result', { photoPath: photo.path });
    } catch (e) {
      setError(e.message);
      Alert.alert('Processing failed', e.message);
      setProcessing(false);
      motionResetRef.current?.();
    }
  }, [isCameraReady, isProcessing, downloading, navigation, setError, setProcessing, setResult]);

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
      setIsCameraReady(false);
    });
    return unsub;
  }, [navigation, resetStore, motionReset]);

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
        const fileName = build.downloadUrl.split('/').pop() || `build-${build.buildNumber}.apk`;
        const destUri = FileSystem.cacheDirectory + fileName;
        const { uri, status } = await FileSystem.downloadAsync(build.downloadUrl, destUri);
        if (status !== 200) {
          throw new Error(`Download failed (HTTP ${status})`);
        }
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

    const buttons = builds.map((b) => ({
      text: `${b.releaseName} (build ${b.buildNumber})${b.buildNumber === BUILD_NUMBER ? ' · current' : b.buildNumber > BUILD_NUMBER ? ' · newer' : ' · older'}`,
      onPress: () => downloadAndInstall(b),
    }));
    buttons.push({ text: 'Cancel', style: 'cancel' });

    Alert.alert('Available test builds', `You have build ${BUILD_NUMBER}.`, buttons);
  }, [updateInfo, downloadAndInstall]);

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

  const captureDisabled = isProcessing || !isCameraReady;

  return (
    <View style={styles.container}>
      {/* Full-screen camera preview — no frame processor until camera is ready */}
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        photo={true}
        pixelFormat="rgb"
        torch={isCameraReady && !isProcessing ? 'on' : 'off'}
        frameProcessor={
          // Pass frameProcessor only when fully enabled so the worklet never
          // runs with a stale closure.  This is what makes CRES reliable:
          // the worklet is undefined (not called at all) rather than
          // checking a captured-at-creation-time `enabled` flag.
          isFocused && isCameraReady && !isProcessing && !downloading
            ? frameProcessor
            : undefined
        }
        onInitialized={() => setIsCameraReady(true)}
        onError={(e) => {
          console.warn('Camera error:', e.message);
          // If the wide-angle device errored and we haven't already fallen back,
          // switch to the main camera.  Only bother when they are different
          // devices (different ids); if they are the same there is nothing to
          // fall back to.
          if (
            !wideAngleFailedRef.current &&
            wideAngleDevice?.id &&
            mainDevice?.id &&
            wideAngleDevice.id !== mainDevice.id
          ) {
            console.warn('Camera: wide-angle failed, falling back to main camera');
            wideAngleFailedRef.current = true;
            setWideAngleFailed(true);
            setIsCameraReady(false); // hold UI locked until main camera initialises
          } else {
            setIsCameraReady(true); // unblock UI even on error
          }
        }}
      />

      {/* Overlay UI — separate from camera so layout can't affect preview */}
      <SafeAreaView style={StyleSheet.absoluteFill} edges={['top', 'bottom']} pointerEvents="box-none">

        {/* Top bar */}
        <View style={styles.topBar}>
          {isCameraReady
            ? <MotionIndicator stable={isStable} gearDetected={gearDetected} />
            : <Text style={styles.initText}>Starting camera…</Text>
          }
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
              <Text style={styles.processingHint}>This takes about 1–2 seconds</Text>
            </View>
          </View>
        )}

        {/* Download overlay */}
        {downloading && (
          <View style={styles.processingOverlay}>
            <View style={styles.processingCard}>
              <Text style={styles.processingTitle}>Downloading APK…</Text>
            </View>
          </View>
        )}

        {/* Bottom controls */}
        <View style={styles.bottomBar}>
          <Text style={styles.hint}>
            {!isCameraReady
              ? 'Starting camera…'
              : isProcessing
              ? 'Processing…'
              : isStable
              ? 'Stable — capturing automatically…'
              : !gearDetected
              ? 'Center gear in the circle'
              : 'Gear found — hold steady…'}
          </Text>

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
    </View>
  );
}

const AIM_SIZE = 240;

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
    color: 'rgba(255,255,255,0.2)',
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
  processingHint:  { color: 'rgba(255,255,255,0.55)', fontSize: 13 },
});
