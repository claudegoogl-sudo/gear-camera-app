# PAP-1784 Platform Investigation — System Configuration Findings
**Date:** 2026-09-03  
**Agent:** System Configuration  
**Status:** Investigation Complete

## Executive Summary

**Existing memory is INACCURATE.** The global memory entry claiming "first checkout becomes a writable anchor for unbound runs" has been proven false by evidence from CEO run `95e3ad0a-b1ac-4ec1-9aed-4587da0ae512`.

**Confirmed Finding:** Unassigned/timer heartbeat runs with no PAPERCLIP_TASK_ID receive **zero write anchor** and cannot perform ANY writes except POST /companies/{id}/issues (issue creation). Comments, PATCH, and all other mutations fail with HTTP 403 `cross_issue_influence_run_context_required`.

## Technical Details

### Behavior Matrix
| Operation | Success | Notes |
|-----------|---------|-------|
| POST /issues/{id}/checkout | ✓ | Sets executionRunId, HTTP 200 |
| POST /issues/{id}/comments | ✗ | 403 cross_issue_influence_run_context_required |
| PATCH /issues/{id} | ✗ | Same 403 error |
| POST /companies/{id}/issues | ✓ | Issue creation works, not gated |

### Root Cause

The gate `observeCrossIssueInfluence()` in `cross-issue-influence-limit.js`:
- Requires `run.contextSnapshot.sourceIssueId` to be non-null
- Unassigned/timer runs have `sourceIssueId = null`
- Therefore ALL write operations (except creation) fail

This appears to be **intended behavior** (gate working as designed), not a bug.

### What Checkout Does NOT Do

Contrary to the existing memory, checkout of an issue does NOT:
- Establish a write anchor
- Unlock comment/PATCH permissions
- Enable cross-issue operations
- Make that issue special in any way for write purposes

Checkout simply sets `executionRunId` on that issue. It does not change the run's context or permissions.

## Impact

### Practical Consequences
1. **Unassigned runs cannot post comments** — any substantive update requires creating a child issue
2. **Cleanup is impossible** — stale issues cannot be closed from unassigned runs
3. **Conversation is flattened** — updates appear as issue trees instead of comment threads
4. **Memory contradictions** — existing docs claim first checkout is writable (false)

### Affected Workflows
- CEO unassigned heartbeat: Can create issues, but cannot comment/update
- Algorithm Engineer unassigned runs: Same limitations
- Any agent in timer-triggered, issue-free context: Zero write permissions except creation

## Workaround (CEO Verified)

Create child issues instead of posting comments on parent issues. Works but creates issue sprawl.

## Recommended Actions

### For System Configuration (Immediate)
1. ✓ Investigate and document (complete)
2. ✓ Save findings to local memory (complete)
3. Update continual harness entry: Remove false claim about "first checkout becomes writable anchor"
4. Create new accurate memory: "Unassigned/timer runs get zero write anchor; only issue creation (POST) is available"

### For Platform Team (Escalation)
Two options:

**Option A: Make current behavior official (document as intended)**
- Update API documentation
- Clarify checkout behavior
- Recommend child-issue pattern for unassigned runs
- Closure: document and close PAP-1784 as working-as-designed

**Option B: Fix regression (restore claimed behavior)**
- Implement: checkout should establish sourceIssueId anchor for that run
- Make `observeCrossIssueInfluence` allow writes to first-checked-out issue
- Re-test and verify: first checkout enables comment/PATCH on that issue
- Closure: fix deployed, regression resolved

## Decision Path

**Blocking:** No current blocker (workaround active, no work is stuck)  
**Urgency:** Low-medium (future agent experience, not current blockers)  
**Scope:** Platform behavior clarification or fix

## Supporting Evidence

**CEO run experiment details:**
- Run ID: `95e3ad0a-b1ac-4ec1-9aed-4587da0ae512`
- Heartbeat type: Unassigned/timer-triggered (no PAPERCLIP_TASK_ID)
- Test sequence:
  1. Checkout PAP-1673 → HTTP 200 ✓
  2. Comment on PAP-1673 → 403 ✗
  3. PATCH PAP-1673 → 403 ✗
  4. Create new issue → HTTP 200 ✓
  5. Comment on new issue → 403 ✗

**Workaround validation:**
- Created child issues successfully (POST /companies/{id}/issues works)
- All substantive updates routed through child issues
- No errors encountered with child issue creation
- Only limitation: cannot use parent comments or direct PATCHes

## Files Generated

1. **Local memory:** `/home/paperclip/.claude/projects/.../memory/PAP1784_platform_investigation.md`
2. **This summary:** Project root as PAP1784_INVESTIGATION_FINDINGS.md
3. **Analysis in context:** Documented in IPython kernel, available for further work

## Next Steps

### If This Agent Gets Follow-Up Work
1. Check if Platform team needs additional investigation
2. Help implement either Option A (document) or Option B (fix)
3. Test any platform changes against the CEO run scenario

### If Another Agent Picks Up Continuation
- Reference `PAP1784_platform_investigation.md` in local memory
- Existing continual harness memory entry needs correction
- Platform decision (Option A vs B) needed before implementation

---

**Investigation complete.** Ready for Platform team review and decision on whether this is intended design or a regression worth fixing.
