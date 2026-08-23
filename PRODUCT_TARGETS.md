# Product targets — the bar for "publishable"

**Source of truth: [PAP-758](/PAP/issues/PAP-758) (board-set).** Every agent works toward these.
If a change moves one of these numbers, say so in the ticket. If a change trades one
against another, say that too — the trade is a CEO call, not an engineering one.

| # | Target | Bar | Where it stands | Last measured |
|---|---|---|---|---|
| 1 | **Gear range** | 9T–60T counted, not just abstained | 11–20T usable; 21–60T is the gap. 52T is **1/22 = 4.5%** — the top of the declared range does not work | PAP-1658, 2026-08-22 |
| 2 | **Accuracy** | **>99%** exact tooth count — *denominator pending board ruling, see [PAP-1673](/PAP/issues/PAP-1673)* | **58.0%** of all photos (210/362) — or **89.0%** of answers given (210/236). 126 abstains (34.8%), 26 confidently wrong (7.2%) | PAP-1658, 2026-08-22, HEAD `49a7498` |
| 3 | **Speed** | **≤5s hard, 1–2s goal**, per count | **~36.7s p50 on real hardware (n=7, self-selected), ~7.3× over the hard target.** The prior "6× disagreement" (5757ms audit vs 977ms profiler) was not two competing measurements — the 5757ms run was measured while the host was running two concurrent Android builds and other jest sweeps; isolated runs agree at ~980ms regardless of jest/node. `detect` is ~80% of runtime on both device and desktop (same proportional shape); even a 0ms `detect` leaves ~6.8s on-device (load+preprocess), already over budget — no `detect`-only fix reaches 5s | PAP-1682, 2026-08-23 (device: PAP-1677 Sentry pull, FP5) |

## Current accuracy, per bucket — PAP-1658 @ `49a7498`, 2026-08-22

| Bucket | Tol | N | Correct | Acc% | Abstain | Conf-wrong |
|---|---|---|---|---|---|---|
| Small 9–15T | exact | 136 | 102 | 75.0% | 31 | 3 |
| Mid 16–20T | exact | 33 | 27 | 81.8% | 5 | 1 |
| Large 21–28T | ±1 | 113 | 51 | 45.1% | 52 | 10 |
| XL 29–60T | ±1 | 80 | 30 | 37.5% | 38 | 12 |
| **TOTAL** | | **362** | **210** | **58.0%** | **126** | **26** |

**Distance to target 2 is 148 photos.** We need 358/362; we have 210. Over the 3.5 months
since PAP-1052 (181/356 = 50.8% @ `141cffb`) we moved **+7.2pp**, and effectively all of it
is one commit's XL gain (PAP-1554). Large + XL are 53% of the corpus at ~41% combined —
they are the binding constraint, and both trip the harness's own `<50% — likely regression` warning.

## What each target actually means

**1. Range.** "Supported" means we return a correct count, not that we abstain safely.
An abstain is a non-answer for *range* purposes: a size we only ever decline on is not
supported, under either reading of target 2. The single-image-cue ladder for
30–60T discrimination is empirically exhausted (PAP-1532; QA-endorsed on PAP-1527/1528),
so the next XL move is a product decision, currently open with the board on PAP-758.

**2. Accuracy.** Exact match against the labelled corpus, reported per bucket
(Small 9–15T / Mid 16–20T / Large 21–28T / XL 29–60T) plus total, using
`mobile/__tests__/pap760.audit.js` on the shared harness runner. Three numbers matter and
must be reported separately:
- **correct** — committed and right,
- **confidently wrong** — committed and wrong. This is the one that burns users,
- **abstain** — refused to answer. Not correct. Today this is our *dominant* failure
  mode: we decline on a third of all inputs.

**3. Speed.** Wall clock from shutter to answer, on a real handset, not host wall time.
Host harness timings are a proxy for ranking optimisations, never a claim about the
device. A count that takes 70s is a defect at any accuracy.

## Measurement convention — report the triple, not a rate (CEO, 2026-08-23)

The **>99%** bar has two readings and the board has not yet picked one
([PAP-1673](/PAP/issues/PAP-1673), interaction open):

| Reading | Formula | Today | The programme it implies |
|---|---|---|---|
| **1 — of all photos** | 210/362 | **58.0%** | Abstain is failure. Loosen gates, answer more photos. Distance: +148 photos. |
| **2 — of answers given** | 210/236 | **89.0%** | Abstain is free; only confident wrongness counts. Tighten gates. Distance: conf-wrong **11.0% of answers** (26/236) → <1%, an **11× reduction**. |

**Watch the denominator on the error rate too.** 26 confident errors is **7.2% of photos**
but **11.0% of answers**. Reading 2 scores correctness against answers, so it must score
errors against answers: the bar is 11.0% → <1%, i.e. **at most 2 confident errors in the
whole corpus**. Quoting 7.2% inside a Reading-2 argument understates the job.

**Both readings are one predicate with one free variable.** Write the test as
`correct ÷ answered ≥ 99%` **AND** `answered ÷ total ≥ F`. Reading 1 is `F = 100%`
(abstaining banned); Reading 2 is `F = 0%` (abstaining unlimited); tiered is the board's
number. Today **F = 65.2%** (236/362). Both endpoints are unusable in isolation — at
`F = 0%` an app that answers only the ten easiest photos scores 100%, and at `F = 100%`
the app is required to bluff on a photo too blurred to count. The likely answer is
interior, so **the open question is a single number, not a philosophy**.

These are **opposite instructions to the same engineers**, so until the ruling lands:

- **Every corpus audit reports the triple** — `correct` / `abstain` / `confidently-wrong`,
  per bucket and total. This is already the PAP-1052 schema; keep it.
- **Quote both derived rates** whenever you quote a headline: `correct/N` *and*
  `correct/(N − abstain)`. One number alone silently picks a reading.
- **No ticket may assert that an abstain-shifting change "helped" or "hurt" accuracy.**
  State the triple delta. PAP-1659's wall-clock deadline gate is the live case: under
  Reading 1 its delta is **≤ 0 by construction** (it converts slow answers into abstains,
  so it can remove correct answers and never create one); under Reading 2 the sign is
  **genuinely open** and plausibly positive, since the answers it discards are the slow
  low-confidence ones likeliest to be wrong. Same commit, opposite verdicts — which is
  why the audit ([PAP-1674](/PAP/issues/PAP-1674)) reports the triple and both rates and
  names which reading its recommendation rests on.
- The triple is reading-agnostic — both rates fall out of it. **Nothing about
  measurement is blocked by the ruling; only prioritisation is.**

## Standing rules that follow from these

- **No accuracy claim without a corpus number** at a named commit. "Should improve X" is
  a hypothesis; the audit table is the evidence.
- **Claimed per-commit deltas do not sum.** PAP-1658 AC4: six commits each claimed a gain;
  the measured total is fully explained by one of them. Overlapping gates double-count.
  Treat any "claimed effect" table as directional only — never add tickets together.
- **A change to *when we abstain* is accuracy-relevant.** Deadline gates, confidence gates
  and sanity gates all convert correct answers into non-answers. They must be re-audited,
  not asserted neutral (PAP-1659 is the open case).
- **No accuracy win is free if it costs time**, and no speed win is free if it costs
  answers. Any proposal that re-runs the pipeline N times must state its worst-case wall
  clock on device; any proposal that bounds wall clock must state its abstain cost in pp.
- **Full-corpus audits go stale.** Re-audit at HEAD after any cluster of
  accuracy-relevant commits; do not quote a months-old table as current.
- **Abstain is a floor, not a finish — for target 1.** Shipping an abstain closes a
  *confidently-wrong* defect and does not advance target 1 (range). Whether it advances
  or damages **target 2** depends on the denominator the board picks in PAP-1673; until
  that lands, do not claim either sign. Report the triple and let the ruling do the
  arithmetic.

_Maintained by the CEO. Last reviewed 2026-08-23 against the PAP-1658 audit at `49a7498`._
_Known gap: HEAD has since moved to `768d877`; PAP-1659's wall-clock deadline gate landed
after the audited SHA and is not priced into the 58.0% figure — re-audit tracked on PAP-1675,
pricing on PAP-1674._
_Known open decision: the target-2 denominator (PAP-1673). Both rates are quoted above on
purpose; do not collapse them to one until the board rules._
