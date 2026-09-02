
# PAP-1782: D3 Pre-FFT Dense Chainring Detection — Implementation Plan

## Scope
Implement dense chainring (40+T) detection BEFORE FFT computation to improve accuracy from ~89% to 96%+ by abstaining on images FFT would fail on.

## Algorithm (from PAP-1534 spec)

### Core Metric: Inner-Radius Fraction
```
inner_radius_fraction = r_inner / r_contour
```

- Small gears (9–20T): 0.60–0.80 (mean 0.71)
- Mid gears (16–20T): 0.50–0.65 (mean 0.58)
- Dense chains (40–60T): 0.20–0.40 (mean 0.32)

### Decision Threshold
- THRESHOLD = 0.50
- If inner_radius_fraction < 0.50: Dense chainring detected → abstain + tag
- Otherwise: Proceed with normal FFT analysis

### Inner Radius Estimation
Hybrid approach combining:
1. **Ring Texture Analysis**: Measure brightness variance in concentric rings, find transition peak
2. **Radial Gradient Analysis**: Compute |dI/dr| at each angle, find peak gradient radius

## Implementation Steps

### Step 1: Add estimateInnerRadius() function
Location: gearCounter.js, before analyzeImage()

Inputs: gray (uint8array), cx, cy, contourRadius, width, height
Output: estimated inner radius (pixels)

Approach:
- Divide radial zone into rings [0.1*r_contour, 0.6*r_contour]
- For each ring: compute variance + gradient
- Find transition point with highest combined score
- Return median of several angle samplings

### Step 2: Add checkDenseChainringRegime() function
Location: gearCounter.js, before analyzeImage()

Inputs: gray, cx, cy, contourRadius, gearR, width, height
Output: { isDense: bool, innerRadius: float, fraction: float, confidence: float }

Logic:
1. Call estimateInnerRadius()
2. Compute fraction = innerRadius / contourRadius
3. If fraction < 0.50: isDense = true, confidence = 1.0
4. Else: isDense = false, confidence = 0

### Step 3: Wire into analyzeImage()
Location: After gearR determination, BEFORE calling FFT methods

```javascript
// ── D3 Pre-FFT Dense Chainring Detection ────────────────
const denseCheck = checkDenseChainringRegime(gray, cx, cy, contourRadius, gearR, width, height);
if (denseCheck.isDense) {
  // Dense chainring detected — skip FFT and abstain
  return {
    toothCount: 0, confidence: 0,
    cx, cy, gearR, initialGearR: contourRadius,
    contourRadius, centerResult,
    fft90tc: 0, peakTc: 0, peakRel: 0, peakR: 0, opTc: 0, opRel: 0,
    bcTc: 0, bcPurity: 0, bcPeaks: 0, bcCx: 0, bcCy: 0,
    claheTc: 0, claheConf: 0,
    rOuter: denseCheck.innerRadius,
    methodUsed: 'pap1534-d3-dense-chainring-abstain',
  };
}
```

### Step 4: Add test cases
Location: mobile/__tests__/pap1782.dense_chainring_detect.js

Test data:
- Dense 40T, 50T, 60T photos from corpus (expect abstain, confidence 0)
- Small 11T, 13T photos (expect NOT dense, proceed normally)
- Edge cases (28–32T) (expect NOT dense, slight inner hub → fraction ~0.45–0.55)

## Expected Outcomes

### Accuracy Improvement
- Current: 210/236 correct (89.0%)
- With D3: ~96%+ (2% error rate) via abstaining on dense-chain failures
- Error reduction: −50% on catastrophic errors

### Performance Impact
- Per dense photo: Save ~200–300ms FFT computation
- Device portfolio: ~5–8% of photos are dense chains
- Overall: ~10–20ms savings per batch

## Acceptance Criteria

- AC1: Dense-chainring detection implemented with inner-radius-fraction metric
- AC2: Threshold at 0.50 with test validation on 362-photo corpus
- AC3: Device-accurate timing (pre-FFT gate ≤30ms vs FFT ~200–300ms)
- AC4: Test coverage for 40T/50T/60T dense + 11T/13T small + edge cases
- AC5: No new confident-wrong clusters introduced by gate
- AC6: QA approval of implementation against spec

## Timeline
- Implementation: 2–3 days
- Testing + validation: 1–2 days
- QA review: 1–2 days

## Risks & Mitigations
- Risk: False-positive (normal gear mistaken as dense)
  - Mitigation: High threshold (0.50), test coverage, device validation
- Risk: False-negative (dense not caught, error continues)
  - Mitigation: Acceptable — no new errors introduced
- Recovery: 1–2 photo loss acceptable if eliminates 52T→11T errors
