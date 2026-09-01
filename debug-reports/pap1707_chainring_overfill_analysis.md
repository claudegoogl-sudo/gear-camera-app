# PAP-1707: Chainring Overfill Edge Case Analysis

## Event Summary
- **Date**: 2026-08-07 12:53-12:58 UTC
- **Build**: b132
- **Device**: FP5
- **Session**: Same session produced 7 events (2 misses, 5 abstains)

## Event Details

### Miss 1: ff4aa59f
- **Timestamp**: 2026-08-07 12:53:45 UTC
- **Actual**: 36T chainring
- **Predicted**: 13T (confidence 0)
- **Camera error**: `policyRestricted` present
- **Center detection**: CORRECT ((0.483,0.383) vs true (0.48,0.38))
- **Radius detection**: ~50% too small (405px vs true ~794-820px on 1764×1764 crop)

### Miss 2: c325dbba
- **Timestamp**: 2026-08-07 12:58:57 UTC
- **Actual**: 36T chainring
- **Predicted**: 11T (confidence 0)
- **Camera error**: `policyRestricted` present
- **Center detection**: CORRECT ((0.479,0.401) exact)
- **Radius detection**: ~50% too small (370px vs true ~794-820px)

## Signature Analysis

### Root Cause Chain
1. **36T chainring overfills aim circle**: True radius ≈ 1.8× the 450px reticle radius
2. **Detector latches inner structure**: Inner cog (r≈0.15) and bolt holes visible
3. **Radius measurement ~50% undershoot**: Detected 370-405px vs true 794-820px
4. **Undercount follows mechanically**: Smaller radius → fewer teeth counted
5. **Confidence 0**: Algorithm's internal certainty metric hits zero

### Key Dimensions (on 1764×1764 aim-crop)
- **Aim circle radius**: 450px (0.255 of crop dimension)
- **True 36T radius**: 794-820px (0.45-0.465 of crop dimension)
- **Detected radius**: 370-405px (0.21-0.23 of crop dimension)
- **Overfill factor**: 1.76-1.82× aim circle

### Camera Context
- Both events have `policyRestricted` camera error
- Sibling attempts (5 abstains) were caught by the abstain gate
- Correct captures in same window (11T✓, 13T✓, 30T✓, 51T✓, 34T✓) all had gear fitting aim circle

## Archiving Requirements

### Photos to Archive (as corpus samples)
1. **ff4aa59f58234c25a6fd9a2451ff4315** - 36T→13T, conf=0
2. **c325dbba2f874926b7ae36215dd932d9** - 36T→11T, conf=0
3. **5 chainring_abstain crops** from same session (12:43, 12:47×2, 12:58×2)

### Archive Structure
```
training-data/chainring-overfill-36T-b132/
├── misses/
│   ├── ff4aa59f_36T_to_13T_conf0.json
│   ├── ff4aa59f_36T_to_13T_conf0.png (aim-crop with contour overlay)
│   ├── c325dbba_36T_to_11T_conf0.json
│   └── c325dbba_36T_to_11T_conf0.png (aim-crop with contour overlay)
└── abstains/
    ├── session_20260807_12:43_abstain.json
    ├── session_20260807_12:47_abstain_1.json
    ├── session_20260807_12:47_abstain_2.json
    ├── session_20260807_12:58_abstain_1.json
    └── session_20260807_12:58_abstain_2.json
```

### Metadata for Each Sample
- Event ID (full 32-char hex)
- Timestamp (UTC)
- Build number (b132)
- Device (FP5)
- Actual gear (36T)
- Predicted gear (13T or 11T)
- Confidence (0)
- Camera error status (policyRestricted)
- Detected center (x, y) vs true center
- Detected radius vs true radius
- aim-crop dimensions (1764×1764)

## Gate Pricing Requirements

If more samples arrive with this signature, a gate could check:

1. **Radius-to-crop ratio**: Detected radius / crop dimension < 0.25
   - Current samples: 0.21-0.23 (below threshold)
   - Normal gears: 0.10-0.50 range

2. **aimCircleFrac trigger**: aimCircleFrac = 1 (measured mode)
   - Current samples: Both have aimCircleFrac=1 (from "measured: true" in aimCrop)
   - Combined with large radius, indicates overflow

3. **Chainring regime flag**: chainringRegime = true
   - Current samples: Both in chainring regime
   - But inner-ring latch defeats the intended protection

4. **Confidence floor**: confidence = 0
   - Current samples: Both exactly 0
   - High-confidence misses are different category

### Proposed Gate Logic (if needed)
```javascript
// Pseudocode for potential abstain gate
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

- **Status**: Ladder closed 2026-05-14 pending *new corpus*
- **This case**: Exactly the seed data requested — overfilled reticle signature with labeled photos
- **Do NOT treat as**: Proposal to reopen the ladder
- **Purpose**: Archive only; if more samples accumulate, then revisit

## Notes
- Center detection was CORRECT in both cases — this is NOT a centering failure
- The abstain gate caught 5 sibling attempts; these 2 are the leak (PAP-1673 territory)
- Same-session correct captures confirm the gear fitting aim circle is the discriminant
