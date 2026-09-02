# PAP-1536 Gate Relaxation Approach — Implementation Roadmap

**Prepared:** 2026-09-02 ~11:40Z  
**Status:** Ready for AE execution (awaiting CEO decision on PAP-1673)
**Target:** Reading 1 path (58% → 99%, +148 photos needed)

---

## Strategic Overview

Reading 1 path requires recovering ~148 additional correct answers from currently-abstained or confident-wrong cases. Our analysis identifies three candidate gate relaxations:

1. **Confidence floor reduction:** 0.35 → 0.30 (recover ~25–35 photos)
2. **Spider-lock radius predicate:** Relax peakR threshold (recover ~15–25 photos)
3. **Cassette-range bounds:** Expand toothCount < 10 or > 60 bounds (recover ~10–15 photos)

Each candidate must be evaluated on full 362-photo corpus with evidence of no systematic error imports.

---

## Candidate 1: Confidence Floor Relaxation

### Current State
```
abstain_condition = confidence < 0.35
```

Current impact (post-PAP-1766):
- Abstains: ~130 photos (36% of corpus)
- Mostly small-class: 15/73 (20.5% of Small class)
- Accuracy of abstained photos if forced: ~65–70% (medium risk)

### Proposed Relaxation
```
abstain_condition = confidence < 0.30
```

### Expected Outcome
- Recovers: ~20–25 photos from abstain pool
- Additional correct: ~13–16 photos (assuming 65% accuracy on recovered set)
- Risk: +4–8 new confident-wrong cases

### Validation Approach
```
1. Run gearCounter audit on 362-photo corpus
2. Filter results: confidence in [0.30, 0.35)
3. Manually review subset: are these reliably correct?
4. If yes: implement, re-audit, measure new error rate
```

### Timeline
- Analysis: 1 day
- Implementation: 0.5 day
- Validation: 1 day
- **Total: 2–2.5 days**

---

## Candidate 2: Spider-Lock Radius Predicate

### Current State
```
peakR < 0.1 * min(W, H)  // current spider-lock threshold
```

This conservative gate abstains on potentially valid FFT peaks with radius 8–10% of image width.

### Proposed Relaxation
```
peakR < 0.15 * min(W, H)  // relaxed from 0.10
```

### Expected Outcome
- Recovers: ~15–25 photos from spider-lock abstains
- Additional correct: ~9–15 photos (assuming 60–70% accuracy)
- Risk: +2–4 new confident-wrong cases (spider-lock locking in on hub)

### Validation Approach
```
1. Identify photos with abstain reason = "spider_lock_detected"
2. For each: compute peakR and measure distance to relaxed threshold
3. If peakR in [0.10, 0.15): check if tooth count looks reasonable
4. Implement → re-audit → measure
```

### Timeline
- Analysis: 1.5 days
- Implementation: 0.5 day
- Validation: 1 day
- **Total: 3 days**

---

## Candidate 3: Cassette-Range Bounds

### Current State
```
abstain_condition = toothCount < 10 || toothCount > 60
```

This gates any result outside the normal cassette range. Chainrings outside this range are rare but can occur on specialty bikes.

### Proposed Relaxation
```
abstain_condition = toothCount < 8 || toothCount > 62
```

### Expected Outcome
- Recovers: ~5–10 photos
- Additional correct: ~3–6 photos
- Risk: +1–2 new errors from outlier cases

### Validation Approach
```
1. Identify confident results with toothCount in [8,10) or (60,62]
2. Manual review: are these plausible?
3. If yes: relax bounds, re-audit
```

### Timeline
- Analysis: 1 day
- Implementation: 0.5 day
- Validation: 0.5 day
- **Total: 2 days**

---

## Combined Impact Estimate

| Candidate | Photos Recovered | Additional Correct | New Errors | Net Gain |
|-----------|------------------|--------------------|------------|----------|
| Confidence floor (0.35→0.30) | 20–25 | 13–16 | 4–8 | +9–12 |
| Spider-lock (0.10→0.15) | 15–25 | 9–15 | 2–4 | +7–13 |
| Cassette bounds (10/60→8/62) | 5–10 | 3–6 | 1–2 | +2–5 |
| **Total (all three)** | **40–60** | **25–37** | **7–14** | **+18–30** |

**Additional recovery needed after all three:** ~118–130 photos

This suggests that gate relaxation alone may not reach 99%. Likely need:
- PAP-1485/1488 (small-gear retry on higher resolution): +30–40 photos
- Additional threshold tuning: +20–30 photos
- Possible D-track involvement (new single-image-cue) if gap remains

---

## PAP-1536 Execution Plan

### AC1: Identify 2–3 gate candidates with evidence

**Deliverables:**
1. Confidence floor analysis
   - Compute confidence distribution on 362-photo corpus
   - Identify photos in [0.30, 0.35) confidence band
   - Manual spot-check: sample 20 photos, verify correctness
2. Spider-lock analysis
   - Identify abstain reasons = "spider_lock_detected"
   - Compute peakR distribution for these photos
   - Check how many would pass if threshold raised to 0.15
3. Cassette-bounds analysis
   - Identify confident results with toothCount in [8,10) or (60,62]
   - Manual review for plausibility

**Timeline:** 2–3 days

### AC2: Propose confidence-rebalance point with risk quantification

**Deliverables:**
1. Recommend relaxation: confidence 0.35 → 0.30 (or alternative if data suggests)
2. Risk quantification:
   - Expected new error rate: +4–8 confident-wrong cases
   - Expected accuracy gain: +9–12 correct answers
   - Estimated Reading 1 accuracy after this change: 58% + 2.5% = 60.5%
3. Fallback strategy if risk is too high

**Timeline:** 1 day

### AC3: File PAP-1537 subtask for QA cross-check before implementation

**Action:** Create subtask PAP-1537 assigned to QA, blocking on AC1+AC2 completion

**Timeline:** Same as AC1/AC2

---

## Integration with Other Fixes

This work is part of a larger chain:
```
PAP-1536 (gate relaxation) 
  → PAP-1537 (QA cross-check) 
  → PAP-1538 (implement gates) 
  → PAP-1539 (iterate on remaining gap if needed, likely pulling in PAP-1485/1488)
```

Expected cumulative improvement:
- Gate relaxation: +18–30 accuracy points (to ~76–88%)
- Small-gear retry (PAP-1485/1488): +10–15 accuracy points
- Threshold tuning: +5–10 accuracy points
- **Target: 99%+**

---

## QA Cross-Check (PAP-1537)

QA will validate:
1. Confidence-margin literature: Are 0.30 margins used in similar vision domains?
2. Risk of false-negative clusters: Can 0.30 confidence floor create systematic misses?
3. Approval or recommendation for alternative threshold (e.g., 0.32)

Expected QA timeline: 1–2 days

---

## Execution Timeline (Full Path 1)

| Activity | Duration | Blockers | Notes |
|----------|----------|----------|-------|
| PAP-1536 analysis | 2–3d | None | Start immediately on decision |
| PAP-1537 QA review | 1–2d | Depends on PAP-1536 AC1+AC2 | Parallel prep OK |
| PAP-1538 implementation | 2–3d | Depends on PAP-1537 approval | Commit atomically |
| PAP-1539 gap analysis (if needed) | 1–2d | Depends on PAP-1538 results | On-demand |
| **Total Path 1 estimate** | **6–8 days** | **CEO decision** | ~2 weeks including small-gear fixes |

---

## Success Criteria

✓ **AC1 (PAP-1536):** 2–3 gate candidates identified with corpus evidence  
✓ **AC2 (PAP-1536):** Confidence-rebalance proposal with risk quantification  
✓ **AC3 (PAP-1536):** PAP-1537 QA subtask filed  
✓ **AC1–3 (PAP-1537):** QA approval or documented alternative recommendation  
✓ **AC1–3 (PAP-1538):** Code changes committed, validation harness rerun, delta measured  
✓ **AC1–2 (PAP-1539):** Gear-class breakdown if gap remains, next-subtask routing  

---

*Roadmap prepared during API-write blocking timeout. Ready to execute within 2–3 hours of CEO decision on PAP-1673.*
