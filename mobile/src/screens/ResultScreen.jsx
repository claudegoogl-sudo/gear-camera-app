import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
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
import { emitChainringAbstainTelemetry } from '../utils/chainringAbstainTelemetry';

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
  const { photoPath, originalPhotoPath, aimCrop, cameraErrors, cameraEvents, innerContourSuspected, algoDiag } = route.params ?? {};
  const { toothCount, confidence, gearContour, algorithmRuntimeMs, isProcessing, error, reset, chainringRegime, aimR, peakR } = useGearStore();

  // PAP-622: Transform algorithm coordinates (relative to original uncropped
  // photo) into aim-circle-crop space for the overlay.  The displayed photo is
  // now the aim-circle crop (a square), so no cover-mode correction is needed.
  const overlayContour = gearContour && aimCrop
    ? {
        centerX: (gearContour.centerX * aimCrop.fullW - aimCrop.originX) / aimCrop.side,
        centerY: (gearContour.centerY * aimCrop.fullH - aimCrop.originY) / aimCrop.side,
        radius:  gearContour.radius * aimCrop.fullW / aimCrop.side,
      }
    : gearContour;
  const { width } = useWindowDimensions();
  const imageHeight = width;
  const displayedCount = useCountUp(toothCount);

  const confidencePct = confidence != null ? Math.round(confidence * 100) : null;
  const lowConf       = confidence != null && confidence < 0.90;
  const outOfRange    = toothCount != null && (toothCount < 10 || toothCount > 65);
  // PAP-554: UX-level abstain for out-of-supported-range results. Training
  // corpus is 11–28T; ≥35T with low confidence is unreliable (e.g. 51T→19 @
  // 0.46 in b96). Raw toothCount/confidence remain in the debug JSON.
  const outOfSupportedRange = toothCount != null && toothCount >= 35
    && confidence != null && confidence < 0.70;

  // Mount animations
  const panelY    = useSharedValue(60);
  const panelOpac = useSharedValue(0);

  useEffect(() => {
    panelY.value    = withDelay(200, withSpring(0,   { damping: 16 }));
    panelOpac.value = withDelay(200, withTiming(1.0, { duration: 350, easing: Easing.out(Easing.quad) }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // PAP-1536: chainring (30–60T) is descoped from v1.  When the algorithm
  // flags chainring regime, emit a telemetry event (AC4) and show the
  // "Chainring not supported in v1" abstain UX (AC2) instead of the count.
  // Fire once per result via toothCount-keyed effect — re-renders during
  // animation must not re-emit.
  useEffect(() => {
    if (!chainringRegime) return;
    if (toothCount == null) return;
    emitChainringAbstainTelemetry({
      aimR,
      peakR,
      toothCount,
      confidence,
      channels: algoDiag ?? null,
    });
  }, [chainringRegime, toothCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // Low-confidence + out-of-range toasts
  // PAP-1536: suppress generic abstain toasts when chainring regime is the
  // root cause — the dedicated abstain panel above already explains the
  // situation, and the low-conf toast would double-message.
  const [briefToast, setBriefToast] = useState(null);
  useEffect(() => {
    if (chainringRegime) return;
    if (lowConf) {
      setBriefToast('Low confidence — try better lighting or a straighter angle');
      const t = setTimeout(() => setBriefToast(null), 1000);
      return () => clearTimeout(t);
    } else if (outOfRange) {
      showToast('Tooth count outside expected range (10–65T) — verify manually');
    }
  }, [lowConf, outOfRange, chainringRegime]);

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: panelY.value }],
    opacity: panelOpac.value,
  }));

  const [sharing, setSharing] = useState(false);
  const [hasShared, setHasShared] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmedCount, setConfirmedCount] = useState(toothCount ?? 0);
  const [counterText, setCounterText] = useState(String(toothCount ?? 0));
  const counterInputRef = useRef(null);

  // Sync confirmed count when toothCount changes (e.g. on first load).
  useEffect(() => {
    if (toothCount != null) {
      setConfirmedCount(toothCount);
      setCounterText(String(toothCount));
    }
  }, [toothCount]);

  const handleShareDebug = () => {
    setShowConfirmModal(true);
  };

  const handleConfirmShare = async () => {
    setShowConfirmModal(false);
    const actualTeethCount = confirmedCount;
    setSharing(true);
    try {
      await shareDebugReport({ photoPath: originalPhotoPath || photoPath, croppedPhotoPath: originalPhotoPath ? photoPath : null, toothCount, confidence, gearContour, actualTeethCount, algorithmRuntimeMs, aimCrop: aimCrop ?? null, cameraErrors: cameraErrors ?? null, cameraEvents: cameraEvents ?? null, innerContourSuspected: innerContourSuspected ?? false, algoDiag: algoDiag ?? null });

      // Upload training data alongside debug share (fire-and-forget).
      // Use original uncropped photo so training data matches what the algorithm processed.
      uploadTrainingData({ photoPath: originalPhotoPath || photoPath, toothCount, confidence, gearContour, actualTeethCount }).catch(() => {});

      setHasShared(true);
      // Button state change (setHasShared) is sufficient feedback — no toast needed.
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
      <View style={[styles.imageWrap, { width, height: imageHeight, overflow: 'hidden' }]}>
        <View style={{ width, height: imageHeight }}>
          {photoPath ? (
            <Image
              key={photoPath}
              source={{ uri: `file://${photoPath}` }}
              style={{ width, height: imageHeight }}
              resizeMode="contain"
              fadeDuration={0}
            />
          ) : (
            <View style={[styles.placeholder, { width, height: imageHeight }]}>
              <Text style={styles.placeholderText}>Photo unavailable</Text>
            </View>
          )}

          {/* PAP-1536: suppress the tick overlay when chainring abstain
              fires — drawing N ticks over a chainring image while telling
              the user "chainring not supported" sends mixed signals. */}
          {toothCount != null && overlayContour && !chainringRegime && (
            <GearContourOverlay
              width={width}
              height={imageHeight}
              centerX={overlayContour.centerX}
              centerY={overlayContour.centerY}
              radius={overlayContour.radius}
              toothCount={toothCount}
              confidence={confidence ?? 0}
            />
          )}
        </View>

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

        ) : chainringRegime ? (
          // PAP-1536: chainring (30–60T) descoped from v1. Per PAP-1535
          // routing variant (a): show an explicit "not supported" screen
          // instead of a count so the user knows v1 supports cassettes only.
          <View style={styles.chainringAbstainBox} testID="chainring-abstain-panel">
            <Text style={styles.chainringTitle}>Chainring not supported in v1</Text>
            <Text style={styles.chainringBody}>
              This looks like a chainring (the larger gear at the front). v1 of the gear counter supports cassettes (rear gears) only — tooth counts 9–28T.
            </Text>
            <Text style={styles.chainringHint}>
              Try aiming at one of the rear gears, or come back in a future version for chainring support.
            </Text>
          </View>

        ) : toothCount != null ? (
          outOfSupportedRange ? (
            <View style={styles.outOfSupportedBox}>
              <Text style={styles.outOfSupportedTitle}>Out of supported range</Text>
              <Text style={styles.outOfSupportedBody}>
                Reliable detection: 11–28T
              </Text>
              {confidencePct != null && (
                <Text style={styles.outOfSupportedHint}>
                  Raw estimate {toothCount}T @ {confidencePct}% confidence
                </Text>
              )}
            </View>
          ) : (
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
          )

        ) : (
          <Text style={styles.waiting}>
            {isProcessing ? 'Processing…' : 'No result'}
          </Text>
        )}

        <View style={styles.buttonRow}>
          <TouchableOpacity style={styles.resetBtn} onPress={handleReset} activeOpacity={0.8}>
            {/* PAP-1536: relabel Reset → "Try a different gear" when in the
                chainring abstain UX so the CTA matches the abstain copy. */}
            <Text style={styles.resetText}>{chainringRegime ? 'Try a different gear' : 'Reset'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.shareBtn, (sharing || hasShared) && styles.shareBtnDisabled]}
            onPress={handleShareDebug}
            disabled={sharing || hasShared}
            activeOpacity={0.8}
          >
            <Text style={styles.shareText}>{sharing ? 'Sharing…' : hasShared ? 'Shared' : 'Share Debug'}</Text>
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
                onPress={() => {
                  const next = Math.max(1, confirmedCount - 1);
                  setConfirmedCount(next);
                  setCounterText(String(next));
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.counterBtnText}>−</Text>
              </TouchableOpacity>

              <TextInput
                ref={counterInputRef}
                style={styles.counterValue}
                value={counterText}
                onChangeText={(text) => {
                  const cleaned = text.replace(/[^0-9]/g, '');
                  setCounterText(cleaned);
                  const num = parseInt(cleaned, 10);
                  if (!isNaN(num) && num >= 1) setConfirmedCount(num);
                }}
                onFocus={() => {
                  // Select all text once on focus via imperative ref so that
                  // subsequent re-renders (triggered by onChangeText) do not
                  // re-apply the selection and overwrite typed digits.
                  // Avoids the `selectTextOnFocus` prop, which on Android
                  // re-selects on every re-render of a controlled TextInput.
                  const len = counterText.length;
                  if (len > 0) {
                    counterInputRef.current?.setNativeProps({
                      selection: { start: 0, end: len },
                    });
                  }
                }}
                onBlur={() => {
                  if (counterText === '' || parseInt(counterText, 10) < 1) {
                    setConfirmedCount(1);
                    setCounterText('1');
                  }
                }}
                keyboardType="number-pad"
                maxLength={3}
              />

              <TouchableOpacity
                style={styles.counterBtn}
                onPress={() => {
                  const next = confirmedCount + 1;
                  setConfirmedCount(next);
                  setCounterText(String(next));
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.counterBtnText}>+</Text>
              </TouchableOpacity>
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

  outOfSupportedBox: { alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  outOfSupportedTitle: { fontSize: 22, fontWeight: '700', color: '#FF9800', textAlign: 'center' },
  outOfSupportedBody:  { fontSize: 15, color: '#ccc', textAlign: 'center' },
  outOfSupportedHint:  { fontSize: 12, color: '#666', textAlign: 'center', marginTop: 4 },

  // PAP-1536: chainring (30–60T) descope abstain UX.
  chainringAbstainBox: { alignItems: 'center', gap: 10, paddingHorizontal: 16 },
  chainringTitle: { fontSize: 22, fontWeight: '700', color: '#FF9800', textAlign: 'center' },
  chainringBody:  { fontSize: 15, color: '#ddd', textAlign: 'center', lineHeight: 21 },
  chainringHint:  { fontSize: 13, color: '#888', textAlign: 'center', lineHeight: 18, marginTop: 4 },

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
  counterValue: { fontSize: 48, fontWeight: '800', color: '#fff', minWidth: 60, textAlign: 'center', padding: 0, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.25)' },
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
