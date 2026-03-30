import React, { useEffect, useState, useRef } from 'react';
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
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withDelay,
  Easing,
} from 'react-native-reanimated';
import GearContourOverlay from '../components/GearContourOverlay';
import useGearStore from '../store/useGearStore';

function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.LONG);
  } else {
    Alert.alert('', message);
  }
}

/**
 * Counts up from 0 to target over ~700ms once target is set.
 */
function useCountUp(target) {
  const [displayed, setDisplayed] = useState(0);
  const raf = useRef(null);

  useEffect(() => {
    if (target == null) { setDisplayed(0); return; }
    const start = performance.now();
    const duration = 700;

    const step = (now) => {
      const t = Math.min((now - start) / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayed(Math.round(eased * target));
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [target]);

  return displayed;
}

/**
 * Phase 5: polished result UI.
 *
 *   • Count-up animation on the tooth number
 *   • Gear contour overlay fades in with tick marks at each tooth
 *   • Confidence badge colour-codes green / orange
 *   • Out-of-range and low-confidence toasts
 *   • Reset button slides up on mount
 */
export default function ResultScreen({ navigation, route }) {
  const { photoPath } = route.params ?? {};
  const { toothCount, confidence, gearContour, isProcessing, error, reset } = useGearStore();
  const { width } = useWindowDimensions();
  const imageHeight = width;

  const displayedCount = useCountUp(toothCount);

  const confidencePct = confidence != null ? Math.round(confidence * 100) : null;
  const lowConf       = confidence != null && confidence < 0.85;
  const outOfRange    = toothCount != null && (toothCount < 10 || toothCount > 65);

  // Mount animations
  const panelY    = useSharedValue(60);
  const panelOpac = useSharedValue(0);

  useEffect(() => {
    panelY.value    = withDelay(200, withSpring(0,   { damping: 16 }));
    panelOpac.value = withDelay(200, withTiming(1.0, { duration: 350, easing: Easing.out(Easing.quad) }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Low-confidence + out-of-range toasts
  useEffect(() => {
    if (lowConf)     showToast('Low confidence — try better lighting or a straighter angle');
    else if (outOfRange) showToast('Tooth count outside expected range (10–65T) — verify manually');
  }, [lowConf, outOfRange]);

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: panelY.value }],
    opacity: panelOpac.value,
  }));

  const handleReset = () => {
    reset();
    navigation.navigate('Camera');
  };

  return (
    <SafeAreaView style={styles.container}>

      {/* ── Photo + overlay ───────────────────────────────────────── */}
      <View style={[styles.imageWrap, { width, height: imageHeight }]}>
        {photoPath ? (
          <Image
            source={{ uri: `file://${photoPath}` }}
            style={{ width, height: imageHeight }}
            resizeMode="cover"
          />
        ) : (
          <View style={[styles.placeholder, { width, height: imageHeight }]}>
            <Text style={styles.placeholderText}>Photo unavailable</Text>
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

      {/* ── Result panel ──────────────────────────────────────────── */}
      <Animated.View style={[styles.panel, panelStyle]}>

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>Detection failed</Text>
            <Text style={styles.errorBody}>{error}</Text>
            <Text style={styles.errorHint}>Centre the gear and try again in good lighting.</Text>
          </View>

        ) : toothCount != null ? (
          <>
            {/* Big number */}
            <View style={styles.countRow}>
              <Text style={styles.countNumber}>{displayedCount}</Text>
              <Text style={styles.countUnit}>T</Text>
            </View>
            <Text style={styles.countLabel}>teeth detected</Text>

            {/* Confidence badge */}
            {confidencePct != null && (
              <View style={[styles.badge, lowConf ? styles.badgeLow : styles.badgeGood]}>
                <Text style={styles.badgeText}>
                  {lowConf ? `Low confidence  ${confidencePct}%` : `Confidence  ${confidencePct}%`}
                </Text>
              </View>
            )}

            {outOfRange && (
              <Text style={styles.outOfRange}>Outside expected range — verify manually</Text>
            )}
          </>

        ) : (
          <Text style={styles.waiting}>
            {isProcessing ? 'Processing…' : 'No result'}
          </Text>
        )}

        <TouchableOpacity style={styles.resetBtn} onPress={handleReset} activeOpacity={0.8}>
          <Text style={styles.resetText}>Reset</Text>
        </TouchableOpacity>
      </Animated.View>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e0e0e' },

  imageWrap: { position: 'relative', backgroundColor: '#000' },

  placeholder: { backgroundColor: '#1a1a1a', justifyContent: 'center', alignItems: 'center' },
  placeholderText: { color: '#555', fontSize: 14 },

  processingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  processingText: { color: '#fff', fontSize: 18, fontWeight: '600', letterSpacing: 0.3 },

  panel: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    gap: 8,
  },

  countRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 4 },
  countNumber: {
    fontSize: 88,
    fontWeight: '800',
    color: '#fff',
    lineHeight: 96,
    letterSpacing: -2,
  },
  countUnit: { fontSize: 28, fontWeight: '700', color: '#aaa', marginBottom: 12 },
  countLabel: { fontSize: 16, color: '#666', fontWeight: '500', marginTop: -4 },

  badge: {
    marginTop: 10,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 20,
  },
  badgeGood: { backgroundColor: 'rgba(76,175,80,0.18)' },
  badgeLow:  { backgroundColor: 'rgba(255,152,0,0.18)' },
  badgeText: { fontSize: 13, fontWeight: '600', color: '#ccc' },

  outOfRange: { fontSize: 12, color: '#FF5722', textAlign: 'center' },

  errorBox:  { alignItems: 'center', gap: 6 },
  errorTitle:{ fontSize: 17, fontWeight: '700', color: '#f44336' },
  errorBody: { fontSize: 14, color: '#bbb', textAlign: 'center' },
  errorHint: { fontSize: 12, color: '#666', textAlign: 'center' },

  waiting: { fontSize: 16, color: '#555' },

  resetBtn: {
    marginTop: 18,
    backgroundColor: '#fff',
    paddingHorizontal: 52,
    paddingVertical: 15,
    borderRadius: 34,
  },
  resetText: { fontSize: 17, fontWeight: '700', color: '#0e0e0e' },
});
