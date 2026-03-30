import React, { useRef, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { useCameraDevice, Camera } from 'react-native-vision-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import MotionIndicator from '../components/MotionIndicator';
import useGearStore from '../store/useGearStore';

/**
 * Phase 2 scaffold — live camera feed with UI chrome.
 *
 * Phase 3 will add frame-by-frame motion detection.
 * Phase 4 will add auto-capture + algorithm processing.
 *
 * For now the "Capture" button is manual so the algorithm can be tested
 * end-to-end before motion detection is wired in.
 */
export default function CameraScreen({ navigation }) {
  const camera = useRef(null);
  const device = useCameraDevice('back');
  const { setProcessing, setResult, setError, isProcessing } = useGearStore();

  // Phase 3 will compute this from frame diffs
  const [isStable, setIsStable] = useState(false);

  const handleCapture = useCallback(async () => {
    if (!camera.current || isProcessing) return;

    try {
      setProcessing(true);

      const photo = await camera.current.takePhoto({
        flash: 'on',
        qualityPrioritization: 'quality',
      });

      // Phase 4: pass photo.path to the tooth-counting algorithm.
      // For now, navigate to ResultScreen with a placeholder result.
      setResult({
        toothCount: null,   // replaced in Phase 4
        confidence: null,
        gearContour: null,
      });

      navigation.navigate('Result', { photoPath: photo.path });
    } catch (e) {
      setError(e.message);
      Alert.alert('Capture failed', e.message);
    }
  }, [isProcessing, navigation, setError, setProcessing, setResult]);

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
        isActive={true}
        photo={true}
      />

      {/* Top bar — motion indicator */}
      <View style={styles.topBar}>
        <MotionIndicator stable={isStable} />
      </View>

      {/* Aim guide — helps user centre the gear */}
      <View style={styles.aimGuide} pointerEvents="none">
        <View style={styles.aimCircle} />
      </View>

      {/* Bottom controls */}
      <View style={styles.bottomBar}>
        <Text style={styles.hint}>
          {isStable
            ? 'Gear stable — capturing…'
            : 'Hold camera steady over gear'}
        </Text>

        <TouchableOpacity
          style={[styles.captureButton, isProcessing && styles.captureButtonDisabled]}
          onPress={handleCapture}
          disabled={isProcessing}
          activeOpacity={0.8}
        >
          <View style={styles.captureButtonInner} />
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const AIM_SIZE = 240;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },

  noCamera: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  noCameraText: { color: '#fff', fontSize: 16 },

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
    borderStyle: 'dashed',
  },

  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingBottom: 40,
    paddingHorizontal: 24,
    alignItems: 'center',
    gap: 20,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },

  hint: {
    color: 'rgba(255,255,255,0.85)',
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
  captureButtonDisabled: { opacity: 0.4 },
  captureButtonInner: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#fff',
  },
});
