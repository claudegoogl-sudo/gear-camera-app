import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, withSpring } from 'react-native-reanimated';

/**
 * Small badge shown on the camera screen indicating whether the gear
 * is moving or stable.  Phase 3 will connect this to real motion data;
 * for now it accepts a `stable` prop.
 */
export default function MotionIndicator({ stable }) {
  const dotStyle = useAnimatedStyle(() => ({
    transform: [{ scale: withSpring(stable ? 1.2 : 1.0) }],
  }));

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.dot, stable ? styles.dotStable : styles.dotMoving, dotStyle]} />
      <Text style={styles.label}>{stable ? 'Stable' : 'Moving…'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 8,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  dotMoving: { backgroundColor: '#FF6B35' },
  dotStable: { backgroundColor: '#4CAF50' },
  label: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
