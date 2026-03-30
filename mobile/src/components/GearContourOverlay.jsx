import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Circle, Line, G, Text as SvgText } from 'react-native-svg';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  withTiming,
  withDelay,
  withSpring,
  Easing,
} from 'react-native-reanimated';

const AnimatedG     = Animated.createAnimatedComponent(G);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * SVG overlay drawn on top of the captured photo.
 *
 * Renders:
 *   • Outer gear circle at the detected tooth-tip radius
 *   • N evenly-spaced tick marks — one per detected tooth
 *   • Inner reference ring (gear body boundary, ~80% of outer radius)
 *   • Tooth count label above the gear
 *
 * All coordinates are normalised (0–1 relative to width/height), converted
 * to pixels here so the overlay is resolution-independent.
 *
 * Props:
 *   width, height  — container pixel dimensions
 *   centerX/Y      — normalised gear centre (0–1)
 *   radius         — normalised gear radius (0–1, relative to width)
 *   toothCount     — integer
 *   confidence     — 0.0–1.0
 */
export default function GearContourOverlay({
  width,
  height,
  centerX = 0.5,
  centerY = 0.5,
  radius  = 0.35,
  toothCount,
  confidence = 0,
}) {
  const cx = centerX * width;
  const cy = centerY * height;
  const r  = radius  * width;

  const highConf  = confidence >= 0.85;
  const color     = highConf ? '#4CAF50' : '#FF9800';
  const innerR    = r * 0.78;       // approximate root circle
  const tickOuter = r + 10;
  const tickInner = r - 6;

  // Fade-in animation on mount
  const opacity     = useSharedValue(0);
  const circleScale = useSharedValue(0.6);

  useEffect(() => {
    opacity.value     = withTiming(1,   { duration: 400, easing: Easing.out(Easing.quad) });
    circleScale.value = withSpring(1.0, { damping: 12, stiffness: 120 });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const groupProps = useAnimatedProps(() => ({ opacity: opacity.value }));

  // Build tooth tick lines
  const ticks = [];
  if (toothCount != null && toothCount > 0) {
    for (let i = 0; i < toothCount; i++) {
      const angle  = (2 * Math.PI * i) / toothCount - Math.PI / 2; // start at top
      const cosA   = Math.cos(angle);
      const sinA   = Math.sin(angle);
      ticks.push(
        <Line
          key={i}
          x1={cx + tickInner * cosA}
          y1={cy + tickInner * sinA}
          x2={cx + tickOuter * cosA}
          y2={cy + tickOuter * sinA}
          stroke={color}
          strokeWidth={2.5}
          strokeLinecap="round"
        />,
      );
    }
  }

  return (
    <Svg style={StyleSheet.absoluteFill} width={width} height={height}>
      <AnimatedG animatedProps={groupProps}>
        {/* Inner reference ring */}
        <Circle
          cx={cx}
          cy={cy}
          r={innerR}
          stroke={color}
          strokeWidth={1.5}
          strokeDasharray="6 4"
          fill="none"
          opacity={0.55}
        />

        {/* Outer gear circle */}
        <Circle
          cx={cx}
          cy={cy}
          r={r}
          stroke={color}
          strokeWidth={2.5}
          fill="none"
        />

        {/* Tooth tick marks */}
        {ticks}

        {/* Centre dot */}
        <Circle cx={cx} cy={cy} r={4} fill={color} opacity={0.8} />

        {/* Tooth count label */}
        {toothCount != null && (
          <>
            <Circle
              cx={cx}
              cy={cy - r - 26}
              r={22}
              fill="rgba(0,0,0,0.65)"
            />
            <SvgText
              x={cx}
              y={cy - r - 19}
              fontSize={20}
              fontWeight="bold"
              fill={color}
              textAnchor="middle"
            >
              {toothCount}
            </SvgText>
            <SvgText
              x={cx}
              y={cy - r - 6}
              fontSize={9}
              fill={color}
              textAnchor="middle"
              opacity={0.85}
            >
              TEETH
            </SvgText>
          </>
        )}
      </AnimatedG>
    </Svg>
  );
}
