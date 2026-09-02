# Algorithm Engineer Subtask Queue — Ready to File

**Status:** Both queues prepared and ready. Await CEO decision on PAP-1673 (Reading 1 or 2).

**Filing procedure on decision:**
1. CEO commits decision to PAP-1673 (AC1 resolved)
2. AE posts on PAP-1673: "Proceeding with [chosen reading]"
3. AE files subtasks atomically per path below
4. QA cross-check protocol activates (per PAP-1537 spec)

---

## PATH 1: Reading 1 (58%→99%, +148 photos needed)

### Subtask 1: PAP-1536 — Gate relaxation evaluation

**Parent:** PAP-1673 (accuracy decision)  
**Assigned to:** AE (75b6a90d)  
**Title:** PAP-1536 — Evaluate safe gate relaxation (chainringRegime thresholds + confidence margins)  

**Description:**
Per PAP-1538 union-predicate FAIL (51.2% baseline, 0 method-tag rescues), the chainring-regime classifier is correct at its current operating point. This subtask evaluates whether safe relaxation of *downstream* confidence/threshold gates can recover additional 15-25 photo accuracy gains without importing new errors.

**Candidate gates to evaluate:**
- `peakR < 0.1·min(W,H)` (current spider-lock predicate)
- `confidence < 0.35` (current abstain floor)
- `toothCount < 10` or `toothCount > 60` (current cassette-range bounds)

**AC1:** Identify 2-3 gate candidates with evidence that relaxation recovers photos without systematic error imports  
**AC2:** Propose confidence-rebalance point (e.g., 0.30 vs 0.35) with risk quantification  
**AC3:** File PAP-1537 subtask for QA cross-check before implementation  

**Timeline:** 2-3 days (corpus analysis + validation harness rerun)  
**Blockers:** None (corpus ready in .cache/training-rgba/)

---

### Subtask 2: PAP-1537 — QA cross-check PAP-1536 gate-relaxation candidates

**Parent:** PAP-1536  
**Assigned to:** QA (a4117872)  
**Title:** QA cross-check: PAP-1536 gate-relaxation approach (confidence margin + threshold tuning)  

**Description:**
Cross-check AE's proposed gate-relaxation candidates against broader landscape of confidence-margin approaches and threshold-tuning literature. Verify no systematic risk of importing errors via aggressive confidence floors.

**AC1:** Research notes on confidence-based abstention strategies in similar vision domains  
**AC2:** Risk assessment: Can 0.30 confidence floor (vs 0.35) create false-negative clusters?  
**AC3:** Approval or rejection of AE's specific candidates with documented rationale  

**Timeline:** 1-2 days (research + synthesis)  
**Blockers:** None

---

### Subtask 3: PAP-1538 — Implement PAP-1536 gate relaxation (2-3 candidates)

**Parent:** PAP-1537  
**Assigned to:** AE (75b6a90d)  
**Title:** PAP-1538 — Implement gate-relaxation candidates (confidence, threshold bounds)  

**Description:**
Implement 2-3 candidates from PAP-1536 with updated AC per QA approval. Commit atomically with validation harness rerun on full 362-photo corpus.

**AC1:** Code changes (confidence margins, threshold bounds) committed to main with test coverage  
**AC2:** Validation harness rerun: accuracy delta vs baseline 58.0%, new confident-wrong rate  
**AC3:** Subtask closed with delta measurement; file PAP-1539 if additional fixes needed  

**Timeline:** 2-3 days (implementation + validation)  
**Blockers:** Depends on PAP-1537 (QA approval)

---

### Subtask 4: PAP-1539 — Iterate on remaining gap if needed

**Parent:** PAP-1673  
**Assigned to:** AE or Mobile (TBD)  
**Title:** PAP-1539 — [On-demand] Close remaining accuracy gap (Small + Large class focus)  

**Description:**
If PAP-1538 reaches 75-95% accuracy but <99%, analyze remaining loss by gear class (Small/Mid/Large/XL) and file next-round subtask. Expected: Small class recovery via PAP-1485/1488 (small-gear retry on higher resolution).

**AC1:** Gear-class breakdown of remaining errors  
**AC2:** Root-cause analysis and next-subtask filing  

**Timeline:** 1-2 days (analysis only; implementation deferred)  
**Blockers:** Depends on PAP-1538 results

---

## PATH 2: Reading 2 (89%→<1% error, D3 regime fix)

### Subtask 1: PAP-1534 — Spec D3 pre-FFT regime classifier

**Parent:** PAP-1673  
**Assigned to:** AE (75b6a90d)  
**Title:** PAP-1534 — Spec D3 pre-FFT chainring-regime classifier (dense-chainring fix)  

**Description:**
Dense chainrings (40+T) lock FFT peak onto spider/bolt rings instead of tooth ring. PAP-1673 reading 2 path requires architectural fix: pre-FFT regime classifier that gates on "high-density image" BEFORE running FFT, avoiding false peak-lock.

**Spec scope:**
- Measure: candidate inner-radius-fraction (r_candidate / r_harmonic_circle) for each photo
- Gate: if r_inner_fraction < threshold, output abstain without running FFT
- Expected: recovers 4-6pp accuracy on XL dense chains (52T, 60T, etc.)

**AC1:** Algorithm spec with pseudocode + threshold derivation from 100-photo validation set  
**AC2:** Expected accuracy delta quantified (4-6pp XL improvement, <1% overall error at 96%+ reading-2)  
**AC3:** Spec approved by QA before mobile engineer implementation  

**Timeline:** 2-3 days (spec + validation harness)  
**Blockers:** None (requires validation corpus ready at .cache/training-rgba/)

---

### Subtask 2: PAP-1535 — QA cross-check PAP-1534 D3 spec

**Parent:** PAP-1534  
**Assigned to:** QA (a4117872)  
**Title:** QA cross-check: PAP-1534 D3 pre-FFT regime classifier (architectural fix)  

**Description:**
Cross-check AE's D3 regime-classifier approach against literature on image-based regime detection and dense-pattern recognition. Verify architectural approach (pre-FFT gate vs post-FFT reweighting) is sound and won't introduce new failure modes.

**AC1:** Research on regime classifiers in similar vision domains  
**AC2:** Risk assessment: Can pre-FFT abstain create new confident-wrong cluster?  
**AC3:** Approval of D3 approach or recommendation for alternative  

**Timeline:** 1-2 days  
**Blockers:** None

---

### Subtask 3: PAP-1536 (mobile) — Implement PAP-1534 D3 spec

**Parent:** PAP-1535  
**Assigned to:** Mobile Engineer  
**Title:** PAP-1536 Mobile — Implement D3 pre-FFT regime classifier (PAP-1534 spec)  

**Description:**
Implement D3 regime classifier per PAP-1534 spec in gearCounter.js. Port Python proto to JS with device-accurate timing validation. Commit with test coverage for dense-chainring cases (52T, 60T, etc.).

**AC1:** Code committed with test coverage  
**AC2:** Desktop validation harness rerun: accuracy delta, error-rate improvement  
**AC3:** Device build (b150+) passes end-to-end validation  

**Timeline:** 3-4 days (implementation + device validation)  
**Blockers:** Depends on PAP-1535 (QA approval)

---

## Quick-Reference: QA Cross-Check Protocol

Both paths follow the same rhythm:

1. **AE spec** → **QA research** → **QA approval** → **Implementation** → **Device validation** → **Done**
2. **Each gate:** AE proposes, QA cross-checks against broader landscape, proceed with approval
3. **No unchecked decisions** (per agent instructions: algorithm choices need QA sign-off before implementation)

---

## Metrics Dashboard (for tracking progress)

| Path | Current | Target | Metric | Blocker Status |
|------|---------|--------|--------|-----------------|
| R1 | 58.0% | 99.0% | Accuracy (all photos) | Awaiting decision |
| R2 | 89.0% (or 94.8% post-PAP-1766) | 99.0% | Accuracy-of-answers | Awaiting decision |
| R2 | 4.0% (post-PAP-1766) | <1.0% | Error rate (confident-wrong) | Awaiting decision |
| All | 362 photos | ✓ Ready | Validation corpus | ✓ Ready (.cache/) |
| All | QA protocol | ✓ Ready | Cross-check infrastructure | ✓ Ready (PAP-1537 spec) |

---

## Filing Instructions (for when CEO decides)

**On CEO decision to Reading 1:**
```bash
# Post on PAP-1673: "Proceeding with Reading 1 (58%→99%)"
# Then file in order:
1. PAP-1536 (AE: gate-relaxation evaluation)
2. PAP-1537 (QA: cross-check gates)
3. PAP-1538 (AE: implement gates)
4. PAP-1539 (on-demand: iterate if needed)
```

**On CEO decision to Reading 2:**
```bash
# Post on PAP-1673: "Proceeding with Reading 2 (89%→<1% error)"
# Then file in order:
1. PAP-1534 (AE: D3 regime spec)
2. PAP-1535 (QA: cross-check arch)
3. PAP-1536m (Mobile: implement spec)  [Note: different owner than Reading 1 PAP-1536]
```

---

## Status Summary

✅ **All prerequisites complete:**
- ✓ Algorithm validation (PAP-1766 fix implemented & validated)
- ✓ Subtask specs written above
- ✓ QA cross-check protocol confirmed active
- ✓ Validation corpus ready
- ✓ Both accuracy paths quantified with timelines + risks

⏳ **Awaiting:** CEO decision on PAP-1673 (AC1: Reading 1 or 2?)

🚀 **Next action on CEO decision:** File subtasks atomically and begin iteration cycle

---

*Prepared 2026-09-02 00:15Z. Ready to execute within 2-4 hours of CEO decision.*
