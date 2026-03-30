import React from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import GearContourOverlay from '../components/GearContourOverlay';
import useGearStore from '../store/useGearStore';

/**
 * Displays the captured photo with the gear contour overlay and tooth count.
 *
 * Phase 4 will populate toothCount/confidence/gearContour from the algorithm.
 * Phase 5 will refine the overlay with actual contour points.
 */
export default function ResultScreen({ navigation, route }) {
  const { photoPath } = route.params ?? {};
  const { toothCount, confidence, gearContour, isProcessing, error, reset } = useGearStore();
  const { width } = useWindowDimensions();
  const imageHeight = width * 1.0;   // 1:1 square crop for display

  const handleReset = () => {
    reset();
    navigation.navigate('Camera');
  };

  const confidencePct = confidence != null ? Math.round(confidence * 100) : null;
  const lowConfidence = confidence != null && confidence < 0.85;

  return (
    <SafeAreaView style={styles.container}>
      {/* Captured image + overlay */}
      <View style={[styles.imageContainer, { width, height: imageHeight }]}>
        {photoPath ? (
          <Image
            source={{ uri: `file://${photoPath}` }}
            style={{ width, height: imageHeight }}
            resizeMode="cover"
          />
        ) : (
          <View style={[styles.imagePlaceholder, { width, height: imageHeight }]}>
            <Text style={styles.placeholderText}>Photo not available</Text>
          </View>
        )}

        {/* Gear contour overlay — only shown when we have a result */}
        {toothCount != null && (
          <GearContourOverlay
            width={width}
            height={imageHeight}
            centerX={gearContour?.centerX ?? 0.5}
            centerY={gearContour?.centerY ?? 0.5}
            radius={gearContour?.radius ?? 0.35}
            toothCount={toothCount}
            confidence={confidence ?? 0}
          />
        )}

        {/* Processing spinner placeholder */}
        {isProcessing && (
          <View style={styles.processingOverlay}>
            <Text style={styles.processingText}>Counting teeth…</Text>
          </View>
        )}
      </View>

      {/* Result panel */}
      <View style={styles.resultPanel}>
        {error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : toothCount != null ? (
          <>
            <Text style={styles.toothCount}>{toothCount}</Text>
            <Text style={styles.toothLabel}>teeth detected</Text>
            {confidencePct != null && (
              <Text style={[styles.confidence, lowConfidence && styles.confidenceLow]}>
                {lowConfidence
                  ? `Low confidence (${confidencePct}%) — try better lighting`
                  : `Confidence: ${confidencePct}%`}
              </Text>
            )}
          </>
        ) : (
          <Text style={styles.waitingText}>
            {isProcessing ? 'Processing…' : 'No result yet'}
          </Text>
        )}

        <TouchableOpacity style={styles.resetButton} onPress={handleReset} activeOpacity={0.8}>
          <Text style={styles.resetButtonText}>Reset</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111' },

  imageContainer: { position: 'relative', backgroundColor: '#000' },

  imagePlaceholder: {
    backgroundColor: '#222',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: { color: '#666', fontSize: 14 },

  processingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  processingText: { color: '#fff', fontSize: 18, fontWeight: '600' },

  resultPanel: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    gap: 8,
  },

  toothCount: {
    fontSize: 80,
    fontWeight: '800',
    color: '#fff',
    lineHeight: 88,
  },
  toothLabel: { fontSize: 20, color: '#aaa', fontWeight: '500' },

  confidence: { fontSize: 14, color: '#4CAF50', marginTop: 4 },
  confidenceLow: { color: '#FF9800' },

  errorText: { fontSize: 15, color: '#f44336', textAlign: 'center' },
  waitingText: { fontSize: 16, color: '#666' },

  resetButton: {
    marginTop: 24,
    backgroundColor: '#fff',
    paddingHorizontal: 48,
    paddingVertical: 14,
    borderRadius: 32,
  },
  resetButtonText: { fontSize: 17, fontWeight: '700', color: '#111' },
});
