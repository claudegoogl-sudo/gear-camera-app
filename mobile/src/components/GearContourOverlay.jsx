import React from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Circle, Text as SvgText } from 'react-native-svg';

/**
 * Draws the detected gear outline and tooth-count label on top of the
 * captured image.  Phase 5 will receive real contour points from the
 * algorithm; for now it renders a placeholder circle.
 *
 * Props:
 *   width        — container width (matches image width)
 *   height       — container height
 *   centerX      — gear centre x (normalised 0-1)
 *   centerY      — gear centre y (normalised 0-1)
 *   radius       — gear radius (normalised 0-1, relative to width)
 *   toothCount   — number to display
 *   confidence   — 0.0-1.0, used to pick colour
 */
export default function GearContourOverlay({
  width,
  height,
  centerX = 0.5,
  centerY = 0.5,
  radius = 0.35,
  toothCount,
  confidence = 0,
}) {
  const cx = centerX * width;
  const cy = centerY * height;
  const r = radius * width;

  const strokeColor = confidence >= 0.85 ? '#4CAF50' : '#FF9800';

  return (
    <Svg style={StyleSheet.absoluteFill} width={width} height={height}>
      <Circle
        cx={cx}
        cy={cy}
        r={r}
        stroke={strokeColor}
        strokeWidth={3}
        fill="none"
      />
      {toothCount != null && (
        <SvgText
          x={cx}
          y={cy - r - 14}
          fontSize={28}
          fontWeight="bold"
          fill={strokeColor}
          textAnchor="middle"
        >
          {toothCount}T
        </SvgText>
      )}
    </Svg>
  );
}
