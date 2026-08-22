# Product targets — the bar for "publishable"

**Source of truth: [PAP-758](/PAP/issues/PAP-758) (board-set).** Every agent works toward these.
If a change moves one of these numbers, say so in the ticket. If a change trades one
against another, say that too — the trade is a CEO call, not an engineering one.

| # | Target | Bar | Where it stands | Last measured |
|---|---|---|---|---|
| 1 | **Gear range** | 9T–60T counted, not just abstained | 11–28T solid; 29–60T (chainring) unresolved | PAP-1591 raised the v1 floor to **11–60T** (board, 2026-05-19) |
| 2 | **Accuracy** | **>99%** exact tooth count | **50.8%** (181/356) — and that number is stale | PAP-1052, 2026-05-02, HEAD `141cffb` |
| 3 | **Speed** | **≤5s hard, 1–2s goal**, per count | Host p50 **2.28s** pre-optimisation; on-device **70–93s** on chainring retry paths | PAP-1639 profile (host) / PAP-1647 (FP5, n=2) |

## What each target actually means

**1. Range.** "Supported" means we return a correct count, not that we abstain safely.
An abstain is a non-answer; it is not a partial credit. The single-image-cue ladder for
30–60T discrimination is empirically exhausted (PAP-1532; QA-endorsed on PAP-1527/1528),
so the next XL move is a product decision, currently open with the board on PAP-758.

**2. Accuracy.** Exact match against the labelled corpus, reported per bucket
(Small 9–15T / Mid 16–20T / Large 21–28T / XL 29–60T) plus total, using
`mobile/__tests__/pap760.audit.js` on the shared harness runner. Two numbers matter and
must be reported separately:
- **correct** — committed and right,
- **confidently wrong** — committed and wrong. This is the one that burns users.
Abstains are a third bucket and are *not* correct.

**3. Speed.** Wall clock from shutter to answer, on a real handset, not host wall time.
Host harness timings are a proxy for ranking optimisations, never a claim about the
device. A count that takes 70s is a defect at any accuracy.

## Standing rules that follow from these

- **No accuracy claim without a corpus number** at a named commit. "Should improve X" is
  a hypothesis; the audit table is the evidence.
- **No accuracy win is free if it costs time.** Retry/consensus paths are the current
  worst offender (PAP-1647). Any proposal that re-runs the pipeline N times must state
  its worst-case wall clock on device.
- **Full-corpus audits go stale.** Re-audit at HEAD after any cluster of
  accuracy-relevant commits; do not quote a months-old table as current.
- **Abstain is a floor, not a finish.** Shipping an abstain closes a *confidently-wrong*
  defect. It does not advance target 1 or 2.

_Maintained by the CEO. Last reviewed 2026-08-22 against HEAD `5c80b48` (b135)._
