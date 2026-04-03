import React, { useRef, useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
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
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import MotionIndicator from '../components/MotionIndicator';
import { useMotionDetection } from '../hooks/useMotionDetection';
import useGearStore from '../store/useGearStore';
import { countTeeth } from '../algorithm/gearCounter';
import { BUILD_LABEL, BUILD_NUMBER } from '../buildInfo';
import { checkForUpdate } from '../utils/updateChecker';

export default function CameraScreen({ navigation }) {
  const camera = useRef(null);
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();

  const [isCameraReady, setIsCameraReady] = useState(false);
  const [updateInfo, setUpdateInfo] = useState({ available: false, latestBuild: null, downloadUrl: '' });
  const isFocused = useIsFocused();

  const { setProcessing, setResult, setError, isProcessing, reset: resetStore } = useGearStore();

  const pulseScale = useSharedValue(1);
  const aimOpacity = useSharedValue(0.5);
  const motionResetRef = useRef(null);

  // ── Capture handler ────────────────────────────────────────────────────
  const handleCapture = useCallback(async () => {
    if (!camera.current || isProcessing || !isCameraReady) return;

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
  }, [isCameraReady, isProcessing, navigation, setError, setProcessing, setResult]);

  // ── Motion detection ───────────────────────────────────────────────────
  const { isStable, frameProcessor, reset: motionReset, usingFallback } = useMotionDetection({
    onStable: handleCapture,
    enabled: isFocused && isCameraReady && !isProcessing && hasPermission,
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
      .then((info) => { if (info.available) setUpdateInfo(info); })
      .catch(() => { /* silent — no error toasts */ });
  }, []);

  // ── Download + install handler ─────────────────────────────────────────
  const handleUpdatePress = useCallback(() => {
    if (!updateInfo.available) return;
    Alert.alert(
      'Update available',
      `Build ${updateInfo.latestBuild} is ready (you have build ${BUILD_NUMBER}).`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Download & Install',
          onPress: async () => {
            try {
              const dest = FileSystem.cacheDirectory + `gear-camera-b${updateInfo.latestBuild}.apk`;
              const { uri } = await FileSystem.downloadAsync(updateInfo.downloadUrl, dest);
              await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
                data: uri,
                flags: 1,
                type: 'application/vnd.android.package-archive',
              });
            } catch (e) {
              Alert.alert('Download failed', e.message);
            }
          },
        },
      ],
    );
  }, [updateInfo]);

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
        frameProcessor={isCameraReady ? frameProcessor : undefined}
        onInitialized={() => setIsCameraReady(true)}
        onError={(e) => {
          console.warn('Camera error:', e.message);
          setIsCameraReady(true); // unblock UI even on error
        }}
      />

      {/* Overlay UI — separate from camera so layout can't affect preview */}
      <SafeAreaView style={StyleSheet.absoluteFill} edges={['top', 'bottom']} pointerEvents="box-none">

        {/* Top bar */}
        <View style={styles.topBar}>
          {isCameraReady
            ? <MotionIndicator stable={isStable} />
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
          <Animated.View style={[styles.aimCircle, isStable && styles.aimCircleStable, aimStyle]} />
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

        {/* Bottom controls */}
        <View style={styles.bottomBar}>
          <Text style={styles.hint}>
            {!isCameraReady
              ? 'Starting camera…'
              : isProcessing
              ? 'Processing…'
              : isStable
              ? 'Stable — capturing automatically…'
              : usingFallback
              ? 'Auto-capture in a moment…'
              : 'Hold camera steady over the gear'}
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
