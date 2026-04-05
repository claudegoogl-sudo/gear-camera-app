import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  Modal,
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
import { shareDebugReport } from '../utils/debugShare';
import { uploadTrainingData } from '../utils/trainingDataUpload';

function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.LONG);
  } else {
    Alert.alert('', message);
  }
}

function showError(message) {
  Alert.alert('Error', message);
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
 * Result screen — shows the detected tooth count with animated overlays.
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
  const lowConf       = confidence != null && confidence < 0.90;
  const outOfRange    = toothCount != null && (toothCount < 10 || toothCount > 65);

  // Mount animations
  const panelY    = useSharedValue(60);
  const panelOpac = useSharedValue(0);

  useEffect(() => {
    panelY.value    = withDelay(200, withSpring(0,   { damping: 16 }));
    panelOpac.value = withDelay(200, withTiming(1.0, { duration: 350, easing: Easing.out(Easing.quad) }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Low-confidence + out-of-range toasts
  const [briefToast, setBriefToast] = useState(null);
  useEffect(() => {
    if (lowConf) {
      setBriefToast('Low confidence — try better lighting or a straighter angle');
      const t = setTimeout(() => setBriefToast(null), 1000);
      return () => clearTimeout(t);
    } else if (outOfRange) {
      showToast('Tooth count outside expected range (10–65T) — verify manually');
    }
  }, [lowConf, outOfRange]);

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: panelY.value }],
    opacity: panelOpac.value,
  }));

  const [sharing, setSharing] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmedCount, setConfirmedCount] = useState(toothCount ?? 0);

  // Sync confirmed count when toothCount changes (e.g. on first load).
  useEffect(() => {
    if (toothCount != null) setConfirmedCount(toothCount);
  }, [toothCount]);

  const handleShareDebug = () => {
    setShowConfirmModal(true);
  };

  const handleConfirmShare = async () => {
    setShowConfirmModal(false);
    const actualTeethCount = confirmedCount !== toothCount ? confirmedCount : null;
    setSharing(true);
    try {
      await shareDebugReport({ photoPath, toothCount, confidence, gearContour, actualTeethCount });

      // Upload training data alongside debug share (fire-and-forget).
      uploadTrainingData({ photoPath, toothCount, confidence, gearContour }).catch(() => {});

      showToast('Debug report uploaded to GitHub');
    } catch (e) {
      showError(`Upload failed: ${e.message}`);
    } finally {
      setSharing(false);
    }
  };

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

        <View style={styles.buttonRow}>
          <TouchableOpacity style={styles.resetBtn} onPress={handleReset} activeOpacity={0.8}>
            <Text style={styles.resetText}>Reset</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.shareBtn, sharing && styles.shareBtnDisabled]}
            onPress={handleShareDebug}
            disabled={sharing}
            activeOpacity={0.8}
          >
            <Text style={styles.shareText}>{sharing ? 'Sharing…' : 'Share Debug'}</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>

      {/* ── Tooth count confirmation modal ──────────────────────── */}
      <Modal
        visible={showConfirmModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowConfirmModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Confirm tooth count</Text>

            <View style={styles.counterRow}>
              <TouchableOpacity
                style={styles.counterBtn}
                onPress={() => setConfirmedCount(c => Math.max(1, c - 1))}
                activeOpacity={0.7}
              >
                <Text style={styles.counterBtnText}>−</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.counterBtn}
                onPress={() => setConfirmedCount(c => c + 1)}
                activeOpacity={0.7}
              >
                <Text style={styles.counterBtnText}>+</Text>
              </TouchableOpacity>

              <Text style={styles.counterValue}>{confirmedCount}</Text>
              <Text style={styles.counterUnit}>T</Text>
            </View>

            {confirmedCount !== toothCount && (
              <Text style={styles.modalHint}>
                Detected {toothCount}T — corrected to {confirmedCount}T
              </Text>
            )}

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setShowConfirmModal(false)}
                activeOpacity={0.8}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalCommitBtn}
                onPress={handleConfirmShare}
                activeOpacity={0.8}
              >
                <Text style={styles.modalCommitText}>Commit</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Brief toast (1 s) ────────────────────────────────────── */}
      {briefToast && (
        <View style={styles.briefToast}>
          <Text style={styles.briefToastText}>{briefToast}</Text>
        </View>
      )}

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

  buttonRow: {
    marginTop: 18,
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },

  resetBtn: {
    backgroundColor: '#fff',
    paddingHorizontal: 36,
    paddingVertical: 15,
    borderRadius: 34,
  },
  resetText: { fontSize: 17, fontWeight: '700', color: '#0e0e0e' },

  shareBtn: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    paddingHorizontal: 22,
    paddingVertical: 15,
    borderRadius: 34,
  },
  shareBtnDisabled: { opacity: 0.45 },
  shareText: { fontSize: 15, fontWeight: '600', color: '#ddd' },

  // Confirmation modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCard: {
    backgroundColor: '#1c1c1e',
    borderRadius: 18,
    paddingVertical: 28,
    paddingHorizontal: 32,
    alignItems: 'center',
    width: 280,
  },
  modalTitle: { fontSize: 16, fontWeight: '600', color: '#aaa', marginBottom: 20 },
  counterRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  counterBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  counterBtnText: { fontSize: 24, fontWeight: '700', color: '#fff', lineHeight: 26 },
  counterValue: { fontSize: 48, fontWeight: '800', color: '#fff', minWidth: 60, textAlign: 'center' },
  counterUnit: { fontSize: 22, fontWeight: '700', color: '#888' },
  modalHint: { fontSize: 12, color: '#FF9800', marginTop: 10, textAlign: 'center' },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 24 },
  modalCancelBtn: {
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  modalCancelText: { fontSize: 15, fontWeight: '600', color: '#888' },
  modalCommitBtn: {
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: '#4CAF50',
  },
  modalCommitText: { fontSize: 15, fontWeight: '700', color: '#fff' },

  briefToast: {
    position: 'absolute',
    bottom: 48,
    left: 24,
    right: 24,
    backgroundColor: 'rgba(0,0,0,0.82)',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  briefToastText: { color: '#fff', fontSize: 13, fontWeight: '500', textAlign: 'center' },
});
