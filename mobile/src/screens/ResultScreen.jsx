import React, { useEffect } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  useWindowDimensions,
  ToastAndroid,
  Platform,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import GearContourOverlay from '../components/GearContourOverlay';
import useGearStore from '../store/useGearStore';

/** Cross-platform brief notification */
function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.LONG);
  } else {
    Alert.alert('', message);
  }
}

/**
 * Phase 4: displays real tooth count + confidence from the algorithm,
 * with the gear-contour SVG overlay positioned using normalised coordinates.
 */
export default function ResultScreen({ navigation, route }) {
  const { photoPath } = route.params ?? {};
  const { toothCount, confidence, gearContour, isProcessing, error, reset } = useGearStore();
  const { width } = useWindowDimensions();
  const imageHeight = width;   // 1:1 square display crop

  // Low-confidence toast (spec §5c)
  useEffect(() => {
    if (confidence != null && confidence < 0.85) {
      showToast('Low confidence — try better lighting or a straighter angle');
    }
  }, [confidence]);

  const handleReset = () => {
    reset();
    navigation.navigate('Camera');
  };

  const confidencePct   = confidence != null ? Math.round(confidence * 100) : null;
  const lowConfidence   = confidence != null && confidence < 0.85;
  const outOfRange      = toothCount != null && (toothCount < 10 || toothCount > 65);

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

        {toothCount != null && gearContour && (
          <GearContourOverlay
            width={width}
            height={imageHeight}
            centerX={gearContour.centerX}
            centerY={gearContour.centerY}
            radius={gearContour.radius}
            toothCount={toothCount}
            confidence={confidence ?? 0}
          />
        )}

        {isProcessing && (
          <View style={styles.processingOverlay}>
            <Text style={styles.processingText}>Counting teeth…</Text>
          </View>
        )}
      </View>

      {/* Result panel */}
      <View style={styles.resultPanel}>
        {error ? (
          <>
            <Text style={styles.errorText}>{error}</Text>
            <Text style={styles.errorSub}>Position the gear in the centre and try again</Text>
          </>
        ) : toothCount != null ? (
          <>
            <Text style={styles.toothCount}>{toothCount}</Text>
            <Text style={styles.toothLabel}>teeth detected</Text>

            {confidencePct != null && (
              <Text style={[styles.confidence, lowConfidence && styles.confidenceLow]}>
                {lowConfidence
                  ? `Low confidence (${confidencePct}%)`
                  : `Confidence ${confidencePct}%`}
              </Text>
            )}

            {outOfRange && (
              <Text style={styles.outOfRange}>
                Outside expected range (10–65T) — verify manually
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
    gap: 6,
  },

  toothCount: {
    fontSize: 80,
    fontWeight: '800',
    color: '#fff',
    lineHeight: 88,
  },
  toothLabel: { fontSize: 20, color: '#aaa', fontWeight: '500' },

  confidence:    { fontSize: 14, color: '#4CAF50', marginTop: 4 },
  confidenceLow: { color: '#FF9800' },

  outOfRange: { fontSize: 13, color: '#FF5722', textAlign: 'center', marginTop: 4 },

  errorText:  { fontSize: 15, color: '#f44336', textAlign: 'center' },
  errorSub:   { fontSize: 13, color: '#888',    textAlign: 'center' },
  waitingText:{ fontSize: 16, color: '#666' },

  resetButton: {
    marginTop: 20,
    backgroundColor: '#fff',
    paddingHorizontal: 48,
    paddingVertical: 14,
    borderRadius: 32,
  },
  resetButtonText: { fontSize: 17, fontWeight: '700', color: '#111' },
});
