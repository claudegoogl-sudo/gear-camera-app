import React, { useRef, useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
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

export default function CameraScreen({ navigation }) {
  const camera = useRef(null);
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();

  // Track whether the camera has finished initializing
  const [isCameraReady, setIsCameraReady] = useState(false);

  const { setProcessing, setResult, setError, isProcessing, reset: resetStore } = useGearStore();

  // Animated pulse on the aim circle when stable
  const pulseScale = useSharedValue(1);
  const aimOpacity = useSharedValue(0.5);

  // Use a ref for motionReset so handleCapture can call it without a
  // circular hook dependency.
  const motionResetRef = useRef(null);

  // ── Capture handler (shared by auto and manual) ────────────────────────
  const handleCapture = useCallback(async () => {
    if (!camera.current || isProcessing || !isCameraReady) return;

    motionResetRef.current?.();   // pause motion detection while processing
    setProcessing(true);

    try {
      const photo = await camera.current.takePhoto({
        flash: 'on',
        qualityPrioritization: 'quality',
      });

      // Run the tooth-counting algorithm on the captured photo.
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
  // Only enable after camera is initialized, not before.
  const { isStable, frameProcessor, reset: motionReset } = useMotionDetection({
    onStable: handleCapture,
    enabled: isCameraReady && !isProcessing && hasPermission,
  });

  // Keep ref in sync so handleCapture can call motionReset safely.
  useEffect(() => {
    motionResetRef.current = motionReset;
  }, [motionReset]);

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

  // Reset store when screen comes back into focus after a result
  useEffect(() => {
    const unsub = navigation.addListener('focus', () => {
      resetStore();
      motionReset();
      setIsCameraReady(false); // camera will re-init
    });
    return unsub;
  }, [navigation, resetStore, motionReset]);

  // ── Permission gate ────────────────────────────────────────────────────
  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

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
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Full-screen live feed */}
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        photo={true}
        frameProcessor={frameProcessor}
        fps={30}
        onInitialized={() => setIsCameraReady(true)}
        onError={(e) => console.warn('Camera error:', e.message)}
      />

      {/* Top bar — motion status */}
      <View style={styles.topBar}>
        {isCameraReady
          ? <MotionIndicator stable={isStable} />
          : <Text style={styles.initText}>Initializing camera…</Text>
        }
      </View>

      {/* Aim guide — pulses green when stable */}
      <View style={styles.aimGuide} pointerEvents="none">
        <Animated.View style={[styles.aimCircle, isStable && styles.aimCircleStable, aimStyle]} />
      </View>

      {/* Processing overlay — shown while algorithm runs */}
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
            : 'Hold camera steady over the gear'}
        </Text>

        {/* Manual capture — always available as fallback */}
        <TouchableOpacity
          style={[styles.captureButton, captureDisabled && styles.captureButtonDisabled]}
          onPress={handleCapture}
          disabled={captureDisabled}
          activeOpacity={0.8}
        >
          <View style={styles.captureButtonInner} />
        </TouchableOpacity>

        <Text style={styles.manualLabel}>tap to capture manually</Text>
      </View>
    </SafeAreaView>
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
    position: 'absolute',
    top: 60,
    left: 0,
    right: 0,
    alignItems: 'center',
  },

  initText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
  },

  aimGuide: {
    ...StyleSheet.absoluteFillObject,
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
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: 36,
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
  processingTitle: { color: '#fff',              fontSize: 20, fontWeight: '700' },
  processingHint:  { color: 'rgba(255,255,255,0.55)', fontSize: 13 },
});
