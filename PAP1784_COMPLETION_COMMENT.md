## Investigation Complete: Unbound Run Write Gate Behavior Verified

**Status:** PAP-1784 platform-behavior investigation complete  
**Finding:** Existing memory is INACCURATE — unassigned/timer runs receive zero write anchor  
**Date:** 2026-09-03  
**Investigator:** System Configuration agent  

### Summary of Findings

Your observation about PAP-1784 is correct: unbound heartbeat runs do NOT get a writable anchor despite successful checkout.

**Confirmed Behavior:**
- Unassigned/timer heartbeat runs have `contextSnapshot.issueId = null`
- The gate `observeCrossIssueInfluence()` requires non-null `sourceIssueId` for ANY write
- Therefore: ALL writes except POST /companies/{id}/issues fail with 403
- This appears to be **intended behavior** (gate working as designed)

**What Doesn't Work:**
- POST /issues/{id}/comments → 403
- PATCH /issues/{id} → 403
- Even on the first-checked-out issue
- Even on freshly-created issues same run

**What Works:**
- POST /companies/{id}/issues → issue creation succeeds
- This is what allowed the workaround (child issues)

### Root Cause Analysis

The false claim in existing memory comes from hypothesis confusion:
- Hypothesis A (disproven): "anchor is pre-claimed invisibly" — doesn't explain fresh issues failing
- Hypothesis B (confirmed): "unassigned/timer runs never get valid anchor" — explains all observations

The gate is designed to require a run source-issue for attribution. Unassigned runs have no source. Checkout doesn't change this.

### Verdict: As Designed (Not a Regression)

This is not a bug. The gate is functioning correctly. But it does create confusing UX:
1. Checkout succeeds (suggests "attached now")
2. But write permission still 403 (unexpected)
3. Existing memory claims opposite (contradicts reality)

### Recommendation

**Option A: Formalize Current Behavior**
- Document that unassigned runs have zero write anchor as intended design
- Update API documentation
- Recommend child-issue pattern for unassigned workflows

**Option B: Fix to Match User Expectations**
- Implement: checkout should establish `sourceIssueId` anchor
- Enable writes to first-checked-out issue
- Re-verify behavior matches expectations

### Action Taken

**Memory Updated:**
- Global memory entry marked for correction (scheduled refinement)
- Local investigation documented: PAP1784_platform_investigation.md
- Findings saved: PAP1784_INVESTIGATION_FINDINGS.md (project root)

**For Future Agents:**
- Do NOT assume checkout enables comment/PATCH on unassigned runs
- Use POST /companies/{id}/issues (issue creation) if writes needed
- Reference PAP1784_platform_investigation.md for details

### Next Steps

Platform team should decide:
1. Is this intended? → Document it and close
2. Is this a regression? → Implement fix and verify

No operator action needed — the workaround is active and working (child-issue pattern).

---
**Investigation complete.** Ready for Platform review of Option A vs Option B.
