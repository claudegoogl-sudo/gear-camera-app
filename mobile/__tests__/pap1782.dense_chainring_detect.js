/**
 * PAP-1782: D3 Pre-FFT Dense Chainring Detection Tests
 * 
 * Tests for estimateInnerRadius() and checkDenseChainringRegime() functions.
 * Validates that dense chains (40+T) are correctly detected and abstained on.
 */

const path = require('path');
const fs = require('fs');

// Mock gray image data for testing
function createTestGray(width, height, type) {
  const gray = new Uint8Array(width * height);

  const cx = width / 2;
  const cy = height / 2;

  if (type === 'dense-chain') {
    // Simulate dense chainring: small hub, teeth at outer radius
    // Hub region (0.3*radius): darker texture, high variance
    // Transition zone (0.3-0.5*radius): gradient change
    // Tooth region (0.5+*radius): high variance
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        const hubR = Math.min(cx, cy) * 0.35;
        const toothR = Math.min(cx, cy) * 0.75;

        if (r < hubR) {
          // Hub: darker, some texture
          gray[y * width + x] = 80 + (Math.sin(x / 10) * 10 | 0);
        } else if (r < hubR + 20) {
          // Transition: gradient
          gray[y * width + x] = 120 + ((r - hubR) / 20) * 50;
        } else if (r < toothR) {
          // Mid zone: medium gray
          gray[y * width + x] = 140 + (Math.sin(y / 8) * 15 | 0);
        } else if (r < toothR + 30) {
          // Teeth: high contrast
          gray[y * width + x] = 200 + (Math.sin(x / 5 + y / 5) * 40 | 0);
        } else {
          // Background
          gray[y * width + x] = 50;
        }
      }
    }
  } else if (type === 'small-gear') {
    // Simulate small gear (11-15T): large hub, short teeth
    // Hub region (0.6*radius): darker texture
    // Transition zone: gentle gradient
    // Tooth region: smaller area
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        const hubR = Math.min(cx, cy) * 0.65;
        const toothR = Math.min(cx, cy) * 0.8;

        if (r < hubR) {
          // Hub: much larger
          gray[y * width + x] = 80 + (Math.sin(x / 8) * 10 | 0);
        } else if (r < hubR + 15) {
          // Gentle transition
          gray[y * width + x] = 120 + ((r - hubR) / 15) * 40;
        } else if (r < toothR) {
          // Small tooth region
          gray[y * width + x] = 160 + (Math.sin(y / 6) * 20 | 0);
        } else {
          // Background
          gray[y * width + x] = 50;
        }
      }
    }
  } else if (type === 'mid-gear') {
    // Simulate mid gear (21-30T): balanced hub, medium teeth
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        const hubR = Math.min(cx, cy) * 0.55;
        const toothR = Math.min(cx, cy) * 0.8;

        if (r < hubR) {
          gray[y * width + x] = 80 + (Math.sin(x / 9) * 10 | 0);
        } else if (r < hubR + 18) {
          gray[y * width + x] = 120 + ((r - hubR) / 18) * 45;
        } else if (r < toothR) {
          gray[y * width + x] = 165 + (Math.sin(y / 7) * 18 | 0);
        } else {
          gray[y * width + x] = 50;
        }
      }
    }
  }

  return gray;
}

describe('PAP-1782: D3 Dense Chainring Detection', () => {
  const width = 800;
  const height = 800;
  const cx = width / 2;
  const cy = height / 2;
  const contourRadius = 300;

  test('estimateInnerRadius: dense chainring should return small radius', () => {
    const gray = createTestGray(width, height, 'dense-chain');
    const innerR = estimateInnerRadius(gray, cx, cy, contourRadius, width, height);

    // Dense chains have small hub (fraction ~0.30-0.35)
    const fraction = innerR / contourRadius;
    expect(fraction).toBeLessThan(0.45); // Should be well below 0.50
    expect(innerR).toBeGreaterThan(50); // But still reasonable
  });

  test('estimateInnerRadius: small gear should return large radius', () => {
    const gray = createTestGray(width, height, 'small-gear');
    const innerR = estimateInnerRadius(gray, cx, cy, contourRadius, width, height);

    // Small gears have large hub (fraction ~0.65-0.75)
    const fraction = innerR / contourRadius;
    expect(fraction).toBeGreaterThan(0.55); // Should be above 0.50
    expect(innerR).toBeLessThan(contourRadius); // But not the full contour
  });

  test('estimateInnerRadius: mid gear should return medium radius', () => {
    const gray = createTestGray(width, height, 'mid-gear');
    const innerR = estimateInnerRadius(gray, cx, cy, contourRadius, width, height);

    // Mid gears have balanced hub (fraction ~0.55-0.60)
    const fraction = innerR / contourRadius;
    expect(fraction).toBeGreaterThan(0.45);
    expect(fraction).toBeLessThan(0.70);
  });

  test('checkDenseChainringRegime: detects dense chainring', () => {
    const gray = createTestGray(width, height, 'dense-chain');
    const result = checkDenseChainringRegime(gray, cx, cy, contourRadius, contourRadius, width, height);

    expect(result.isDense).toBe(true);
    expect(result.confidence).toBe(1.0);
    expect(result.fraction).toBeLessThan(0.50);
  });

  test('checkDenseChainringRegime: does NOT detect small gear as dense', () => {
    const gray = createTestGray(width, height, 'small-gear');
    const result = checkDenseChainringRegime(gray, cx, cy, contourRadius, contourRadius, width, height);

    expect(result.isDense).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.fraction).toBeGreaterThan(0.50);
  });

  test('checkDenseChainringRegime: does NOT detect mid gear as dense', () => {
    const gray = createTestGray(width, height, 'mid-gear');
    const result = checkDenseChainringRegime(gray, cx, cy, contourRadius, contourRadius, width, height);

    expect(result.isDense).toBe(false);
    expect(result.confidence).toBe(0);
  });

  test('checkDenseChainringRegime: handles edge case of very small contour', () => {
    const gray = createTestGray(width, height, 'dense-chain');
    const result = checkDenseChainringRegime(gray, cx, cy, 15, 15, width, height);

    // Should not crash and return safe default
    expect(result.isDense).toBe(false);
    expect(result.fraction).toBe(1.0);
  });

  test('timing: estimateInnerRadius completes within 30ms', () => {
    const gray = createTestGray(width, height, 'dense-chain');

    const start = Date.now();
    estimateInnerRadius(gray, cx, cy, contourRadius, width, height);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(30);
  });

  test('timing: checkDenseChainringRegime completes within 30ms', () => {
    const gray = createTestGray(width, height, 'dense-chain');

    const start = Date.now();
    checkDenseChainringRegime(gray, cx, cy, contourRadius, contourRadius, width, height);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(30);
  });
});
