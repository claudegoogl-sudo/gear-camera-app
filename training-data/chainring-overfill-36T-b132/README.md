# PAP-1707: Chainring Overfill Edge Case Corpus

## Signature
**Chainring overfills aim circle → detector latches inner ring → undercount with confidence 0**

## Root Cause
When a 36T chainring overfills the 450px aim circle (true radius ≈1.8× reticle), the detector latches onto a concentric inner structure (inner cog at r≈0.15) instead of the tooth tips. This causes:
- Radius measurement ~50% undershoot (370-405px detected vs 794-820px true)
- Undercount follows mechanically from the radius shortfall
- Confidence hits 0

## Archive Contents (2026-08-23)
- **2 miss events** with original + cropped photos and full metadata
  - `ff4aa59f` — 36T→13T, conf=0, 12:53:45 UTC, b132, FP5
  - `c325dbba` — 36T→11T, conf=0, 12:58:57 UTC, b132, FP5

## Key Dimensions
- **Aim circle radius**: 450px (0.255 of crop dimension)
- **True 36T radius**: 794-820px (0.45-0.465 of crop dimension)
- **Detected radius**: 370-405px (0.21-0.23 of crop dimension)
- **Overfill factor**: 1.76-1.82× aim circle
- **Center detection**: CORRECT in both cases — this is NOT a centering failure

## Context
- Same session produced 5 chainring_abstain events (12:43, 12:47×2, 12:58×2)
- The abstain gate caught those sibling attempts; these 2 conf-0 emissions are the leak
- Correct captures in same window (11T✓, 13T✓, 30T✓, 51T✓, 34T✓) all had gear fitting aim circle

## Gate Pricing (if future samples arrive)
Potential abstain gate logic:
```javascript
if (
  chainringRegime &&
  confidence === 0 &&
  (radiusPx / cropDim) < 0.25 &&
  aimCircleFrac === 1
) {
  return { abstain: "chainring_overfill_inner_latch" };
}
```

## Relation to PAP-758 Single-Image-Cue Ladder
- Ladder closed 2026-05-14 pending *new corpus*
- This archive provides that seed data with labeled photos
- **NOT** a proposal to reopen the ladder — archival only

## Source
Events downloaded from Sentry 2026-08-23.
Sentry org: paperclip-0l, project: gear-camera-app
