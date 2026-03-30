import React, { useRef, useCallback, useEffect } from 'react';
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

/**
 * Phase 3: live camera feed with real motion detection.
 *
 * Flow:
 *   1. Live feed displayed continuously.
 *   2. Frame processor measures per-frame pixel diff (~10 fps).
 *   3. When diff < threshold for 1.5 s → gear is "stable" → auto-capture.
 *   4. Photo + path passed to ResultScreen (algorithm called in Phase 4).
 *
 * Manual capture button remains for override / testing.
 */
export default function CameraScreen({ navigation }) {
  const camera = useRef(null);
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();

  const { setProcessing, setError, isProcessing, reset: resetStore } = useGearStore();

  // Animated pulse on the aim circle when stable
  const pulseScale = useSharedValue(1);
  const aimOpacity = useSharedValue(0.5);

  // ── Capture handler (shared by auto and manual) ────────────────────────
  const handleCapture = useCallback(async () => {
    if (!camera.current || isProcessing) return;

    motionReset();   // stop motion detection while we process
    setProcessing(true);

    try {
      const photo = await camera.current.takePhoto({
        flash: 'on',
        qualityPrioritization: 'quality',
      });

      // Phase 4 will call the tooth-counting algorithm here before navigating.
      navigation.navigate('Result', { photoPath: photo.path });
    } catch (e) {
      setError(e.message);
      Alert.alert('Capture failed', e.message);
      motionReset();
    }
  }, [isProcessing, navigation, setError, setProcessing]); // motionReset added below

  // ── Motion detection ───────────────────────────────────────────────────
  const { isStable, frameProcessor, reset: motionReset } = useMotionDetection({
    onStable: handleCapture,
    enabled: !isProcessing && hasPermission,
  });

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

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Full-screen live feed */}
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={!isProcessing}
        photo={true}
        frameProcessor={frameProcessor}
        fps={30}
      />

      {/* Top bar — motion status */}
      <View style={styles.topBar}>
        <MotionIndicator stable={isStable} />
      </View>

      {/* Aim guide — pulses green when stable */}
      <View style={styles.aimGuide} pointerEvents="none">
        <Animated.View style={[styles.aimCircle, isStable && styles.aimCircleStable, aimStyle]} />
      </View>

      {/* Bottom controls */}
      <View style={styles.bottomBar}>
        <Text style={styles.hint}>
          {isProcessing
            ? 'Processing…'
            : isStable
            ? 'Stable — capturing automatically…'
            : 'Hold camera steady over the gear'}
        </Text>

        {/* Manual capture — always available as fallback */}
        <TouchableOpacity
          style={[styles.captureButton, isProcessing && styles.captureButtonDisabled]}
          onPress={handleCapture}
          disabled={isProcessing}
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
});
