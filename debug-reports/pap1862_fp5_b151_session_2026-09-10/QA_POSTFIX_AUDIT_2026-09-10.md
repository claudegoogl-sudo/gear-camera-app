# PAP-1862 — QA post-fix audit at aabd380 (D3 gate disabled) — 2026-09-10

Verdict: **APPROVED.** All 4 review items pass. Corpus re-run (plain-node, PAP-1672
precedent, same mask protocol as the QA sweep) confirms the lever removes the gate's
abstain entirely, recovers +70 correct answers corpus-wide, and quantifies the accepted
dense regression at 16/56 band photos. Build subtask filed for Mobile Engineer; ship
disposition stays with operator card 2b9e1994 (PAP-1671, human_only).

## Review items (AE ask)

1. **Corpus re-run at aabd380** — DONE. 362 labeled photos + 2 anchors through the
   production `countTeethFromRgba` at aabd380, bilinear→900 + 0.49·min(W,H) mask (same
   protocol as threshold_sweep_rows.json; rows joined per stamp). Script
   `mobile/__tests__/pap1862.audit.mjs`, rows `post_fix_corpus_audit_rows.json`, log
   `post_fix_audit.log`. 0 ERROR rows, 0 budgetExhausted.
2. **Anchors** — capture A AND capture B: `toothCount=20, confidence=1.0, method
   bc-consensus+peak`. Matches the QA patched-threshold proof exactly.
3. **Lever code review** — PASS. `D3_DENSE_GATE_ENABLED=false` wraps BOTH the
   `checkDenseChainringRegime` call and the abstain return (zero overhead when off —
   behavior is byte-equivalent to the pre-PAP-1782 pipeline for every photo); gate
   function + `__test` exports intact for probes; no stray `denseCheck` references; the
   abstain tag exists only inside the disabled block; evidence trail in the code comment
   matches the QA numbers (AUC 0.375, 200/284, 0.4377/0.4429, 28.6%). New test asserts
   outcomes per PAP-1686 AC2 (no pap1534 abstain; anchors exact 20) and pins the dense
   regression with a deterministic dense spot-check. Suites: pap1862.d3_gate_disabled +
   gearCounter.test.js = 26/26 green.
4. **Build subtask** — FILED for Mobile Engineer (critical; b151 field regression).

## Corpus results at aabd380 (362 training photos; tol per PAP-760 buckets)

| class | n | correct | abstain | confident-wrong |
|---|---|---|---|---|
| S 9-15T | 136 | 57 (41.9%) | 67 (49.3%) | 12 (8.8%) |
| M 16-20T | 33 | 13 (39.4%) | 17 (51.5%) | 3 (9.1%) |
| L 21-28T | 113 | 21 (18.6%) | 61 (54.0%) | 31 (27.4%) |
| XL 29-60T | 80 | 24 (30.0%) | 34 (42.5%) | 22 (27.5%) |
| ALL | 362 | 115 (31.8%) | 179 (49.4%) | 68 (18.8%) |

`pap1534-d3-dense-chainring-abstain` rows: **0** (was 272-band at gate on).

## Delta vs gate-on (band rows abstained by construction at gate on)

- Gate ON: correct 45/362 (12.4%), abstain 310 (85.6%), confident-wrong 7 (1.9%)
- Gate OFF: correct 115/362 (31.8%), abstain 179 (49.4%), confident-wrong 68 (18.8%)
- **+70 correct**; 135 band rows still abstain via INDEPENDENT pre-existing gates
  (pap632, pap474, pap963, pap963-campa, low-conf-consensus — the D3 gate used to
  shadow these); **+61 confident-wrong**, of which:

### Accepted regression, quantified (dense band, n=56)

- 12/56 (21.4%) now answer CORRECTLY (were abstains)
- 28/56 (50.0%) still abstain via other gates (no behavior change)
- **16/56 (28.6%) confidently-wrong** — reads 10-14T on 42-52T (13 photos), plus
  20/22/31T on 52T (3 photos); conf 0.21-0.66. This is the pre-D3 collapse the gate
  was built to prevent; accepted per aabd380, owned by D-track redesign (must pass the
  same 364-photo QA sweep BEFORE implementation).

### Ordinary band (n=198 training + 2 anchors)

- +53 correct (incl. both device anchors at exact 20/conf 1.0)
- 106 still abstain (pre-existing gates)
- 41 new confident-wrong — the honesty trade-off of removing the gate: wrong answers
  replace abstains on ~21% of the band, while correct answers replace abstains on ~27%.

## Device-verification plan for the build (b152+)

1. Ordinary mid-gear (18-24T) captures MUST count (no `pap1534-d3-dense-chainring-abstain`
   in methodUsed; 20T anchors reproduce tc=20).
2. Dense chainring (40T+) sessions: expect possible confident-low-count readings
   (10-14T) — known accepted regression until D-track; capture algoDiag stageMs per
   PAP-1855 protocol on every timed capture.
3. No PAP-1647 freeze (budget 45000 intact, t2-anchored); budgetExhausted must stay 0.
