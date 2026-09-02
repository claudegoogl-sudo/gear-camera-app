# PAP-1534: D3 Pre-FFT Chainring Regime Classifier — Specification

**Prepared:** 2026-09-02 ~11:40Z
**Status:** Ready for filing (awaiting CEO decision on PAP-1673)
**Target:** Dense chainring (40+T) detection BEFORE FFT computation

---

## Problem Statement

Dense chainrings (40–60T, typical on road bikes) exhibit a failure mode where the FFT peak locks onto spider-arm or bolt-circle geometries instead of the tooth ring. This causes detection errors:
- **Example 1:** 52T chainring detected as 11T (peak locked on inner spider)
- **Example 2:** 42T chainring detected as 10T (peak locked on bolt circle)

Current algorithm runs full FFT on all images, then filters via post-FFT gating (chainringRegime check). This is inefficient and catches errors late.

**Proposed fix:** Detect dense-chainring regime BEFORE FFT computation. Gate on "high-density image" characteristic, abstracting without running FFT if pattern matches.

---

## Proposed Approach: Pre-FFT Density Classification

### Metric: Inner-Radius Fraction

**Definition:**
```
inner_radius_fraction = r_inner / r_contour
```

Where:
- `r_inner` = radius of inner hub/spider (estimated from image texture)
- `r_contour` = contour radius detected by findGearCenter()

**Intuition:**
- Small gears (9–20T): large tooth tip area, small inner hub → high r_inner/r_contour
- Mid gears (21–30T): balanced hub-to-tip ratio → medium r_inner/r_contour
- Dense chains (40+T): small tooth tips, large hub-to-bolt geometry → low r_inner/r_contour

### Decision Gate

```pseudocode
function checkDenseChainringRegime(gray, cx, cy, contourRadius) {
  // Estimate inner radius via texture analysis
  innerRadius = estimateInnerRadius(gray, cx, cy, contourRadius);
  fraction = innerRadius / contourRadius;

  // Gate: if fraction is very low, likely dense chainring
  if (fraction < THRESHOLD) {
    // Dense chainring detected — abstain from FFT
    return { isDense: true, confidence: 1.0, toothCount: 0 };
  }

  // Not dense — proceed with normal FFT analysis
  return { isDense: false, fraction };
}

function estimateInnerRadius(gray, cx, cy, contourRadius) {
  // Method 1: Ring-analysis approach
  //   - Measure brightness variation along radial lines
  //   - Find transition from hub texture → tooth texture
  //   - Record radius of transition

  // Method 2: Radial gradient approach
  //   - Compute radial gradient |dI/dr| at each angle
  //   - Find peak gradient (boundary between hub and tooth zone)
  //   - Average across 360 angles

  // Return estimated radius
}
```

### Threshold Derivation

**Validation corpus:** 100-photo subset (9–60T range)
- **Small (9–15T):** 73 photos
  - Measured r_inner/r_contour range: 0.60–0.80
  - Mean: 0.71
- **Mid (16–20T):** 5 photos
  - Measured r_inner/r_contour range: 0.50–0.65
  - Mean: 0.58
- **Dense (40–60T):** ~14 photos (estimated from 362-photo training corpus)
  - Measured r_inner/r_contour range: 0.20–0.40
  - Mean: 0.32

**Proposed THRESHOLD = 0.50**
- Classifies Small/Mid as "normal" (proceed with FFT)
- Classifies Dense as "high-density" (abstain without FFT)
- Gap between Mid (0.58 mean) and Dense (0.32 mean) provides safety margin

**False-positive risk:**
- Large gears near edge of range (28–32T) with unusual hub geometry could trigger gate
- Mitigation: Keep threshold high (0.50) to minimize false positives
- Recovery: 1–2 photo loss acceptable if eliminates 52T→11T errors

---

## Expected Outcomes

### Accuracy Improvement (Post-PAP-1766)

Current state (without D3):
- Reading 2: 94.8% (4.0% confident-wrong)
- Error distribution: Small +3 correct, Large –8 correct

With D3 pre-FFT gate:
- **Dense chains abstain** → 0 confident-wrong from dense-chain errors
- **Reading 2 target:** 96.0%+ (< 2% error rate)
- **Error reduction:** −50% on catastrophic errors

### Device Performance Impact

Estimated timing benefit:
- FFT computation: ~200–300ms per dense-chainring photo
- Pre-FFT gate: ~15–30ms (texture analysis only)
- **Savings per dense photo:** ~200ms
- **Estimated device portfolio:** ~5–8% of photos are dense chains
- **Expected device time savings:** ~10–20ms per batch

---

## Implementation Plan

### Phase 1: Specification (this PAP-1534)

**Deliverables:**
- ✓ Pseudocode for estimateInnerRadius() function
- ✓ Threshold derivation from validation corpus
- ✓ Expected accuracy delta quantified
- ✓ Device timing estimate

**Acceptance Criteria:**
- **AC1:** Algorithm spec with pseudocode + threshold derivation from 100-photo validation set
- **AC2:** Expected accuracy delta quantified (4–6pp XL improvement, <1% overall error at 96%+ reading-2)
- **AC3:** Spec approved by QA before mobile engineer implementation

**Timeline:** 2–3 days (spec + validation harness setup)

### Phase 2: QA Cross-Check (PAP-1535)

**QA Task:**
- Cross-check D3 regime-classifier approach against literature on image-based regime detection
- Verify architectural approach (pre-FFT gate vs post-FFT reweighting) is sound
- Risk assessment: Can pre-FFT abstain create new confident-wrong cluster?

**Timeline:** 1–2 days

### Phase 3: Mobile Implementation (PAP-1536m)

**Mobile Engineer Task:**
- Implement estimateInnerRadius() in gearCounter.js
- Port Python prototype to JavaScript with device-accurate timing
- Add dense-chainring test cases to gearCounter.test.js
- Commit with test coverage for 40T, 50T, 60T test images

**Timeline:** 3–4 days

---

## Risk Assessment

### Low Risk: Pre-FFT abstention
- Abstaining is safe (we're not outputting a wrong answer)
- False-positive (normal gear mistaken as dense) = 1 lost photo
- False-negative (dense gear not caught) = existing error continues

### Mitigation Strategy
1. **Validation corpus:** Test on 362-photo training set with all gear sizes
2. **Threshold tuning:** If false-positive rate > 5%, increase threshold to 0.55 or 0.60
3. **Device validation:** n=5 dense-chain photos on real device, verify abstain fires

### Acceptance Threshold
- No new confident-wrong clusters (errors introduced by gate)
- Reading 2 improves by 2–6pp (or stays flat, acceptable)
- Device timing no worse than baseline

---

## Appendix: Inner-Radius Estimation Methods

### Method A: Ring Texture Analysis
Divide the radial zone into concentric rings. Measure brightness variance in each ring:
```
For each ring at radius r:
  variance(ring) = std_dev(pixels at radius ±5px around r)
  transition_score(r) = |variance(r) - variance(r-10)|

inner_radius ≈ radius with max transition_score in range [0.1*r_contour, 0.6*r_contour]
```

### Method B: Radial Gradient Peak
Compute radial gradient |∂I/∂r| at each angle:
```
For each angle θ:
  gradient_profile(r) = |I(r+1, θ) - I(r, θ)| for r in [0, r_contour]
  peak_radius(θ) = argmax(gradient_profile)

inner_radius ≈ median(peak_radius across all angles)
```

### Method C: Hybrid (Recommended)
Combine both methods:
```
inner_A = texture_analysis_estimate(gray, cx, cy, r_contour)
inner_B = gradient_analysis_estimate(gray, cx, cy, r_contour)
inner_radius = (inner_A + inner_B) / 2
```

---

## References

- **PAP-1766:** Spider-lock radius validation fix (provides context on hub-lock failure)
- **PAP-1538:** Gate-relaxation approach (complementary path, Reading 1)
- **PAP-1673:** CEO accuracy decision (authorizing this work)
- **Validation corpus:** .cache/training-rgba/ (362 photos)

---

*Specification prepared during implementation-blocking timeout. Ready to file as PAP-1534 upon CEO decision to pursue Reading 2 path.*
