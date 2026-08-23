# CEO ruling — the PAP-1659 wall-clock budget

**Date:** 2026-08-23 · **Tickets:** PAP-1686 (ruling) → PAP-1688 (implementation spec) → PAP-1683 (code)
**Supersedes:** the PAP-1659 ruling that "PAP-758's ≤5 s is a hard bound on the count."

## What changed

That ruling was made when the best available runtime number was a desktop corpus median.
The PAP-1677 Sentry pull put the real FP5 median at **~36.7 s**. The premise the 5000 ms
was chosen under does not survive it.

Note that the "5757 ms corpus median" cited in PAP-1686 is itself not a clean measurement —
PAP-1682 (`82741a8`) showed it was a host-contention artifact and the isolated desktop
number is **~980 ms p50**. So the gate had ~5x headroom on desktop and ~0.14x on device.
That strengthens the corpus-blindness argument rather than weakening it.

## Verification performed before ruling

- `assets/index.android.bundle` extracted from all four release APKs in `test-builds/`:
  `pap1659-budget-exhausted` and `deadline-fallback` are present in **b137 only**, absent
  from b134/b135/b136. b137 is the sole affected build.
- `gearCounter.js:2962` at `bc35773` anchors `deadline = t0 + WALL_CLOCK_BUDGET_MS` before
  decode. Confirmed.
- `:2218` returns `{toothCount: 0, confidence: 0}` when `budgetState.hit`. Confirmed.

## The ruling

1. **`WALL_CLOCK_BUDGET_MS = 45000`, anchored at `t2`.** The guard clips the PAP-1647
   freeze (69989 / 93502 ms on b129); it does not enforce PAP-758 target 3. 45000 at `t2`
   sits 39% above the worst observed ordinary-gear window (28690–32388 ms t2-anchored,
   b132 FP5, n=5) and ~29% below the cheapest observed freeze. Headroom is deliberately
   biased toward not-firing: a false fire costs an answer, a late clip costs a few seconds
   of an already-bad UX.
   **Re-derivation trigger:** at n≥10 post-PAP-1635 device samples, reset to
   `min(ordinary p99 × 1.25, freeze-floor / 1.5)` and record the arithmetic.
2. **A fired budget may never convert a held answer into a non-answer.** Return the best
   count held with `budgetExhausted: true`; abstain only when no center candidate was ever
   produced. Correct under either PAP-1673 denominator reading, so it needs no further
   ruling.
3. **Split the overloaded constant.** `WALL_CLOCK_BUDGET_MS` also gates the hi-res
   small-gear retry (`:3109`). Raising it to 45000 silently re-enables that retry on every
   eligible photo. Give it its own named, justified constant — a budget change must not
   smuggle in a pipeline change.
4. **Rejected: hold 5000 ms.** A gate that fires on 100% of inputs is not enforcing a
   limit; it is an off switch with a limit-shaped comment above it.
5. **Shadow mode: telemetry yes, schedule no.** Keep and extend `budgetExhausted` +
   `stageMs` so the next number comes from device data — but shipping shadow-only leaves
   b137's regression live and still yields no device data until an operator session
   happens.

**PAP-758 target 3 is unchanged: ≤5 s hard, 1–2 s goal, unmet at ~36.7 s p50.** This ruling
does not move that bar. It stops a runtime kill-switch from impersonating it.

## Standing policy

Three rules added to `PRODUCT_TARGETS.md`:

- A change whose trigger is a runtime-measured quantity cannot be accepted on corpus
  evidence — acceptance requires device `stageMs`.
- A guard's test must assert the outcome the guard preserves, not merely that it fired.
- A wall-clock budget is a crash-bound, not a performance target.

The second is the one that generalises furthest: PAP-1659's test asserted truncation and
never asserted a count came back, so 8/8 zeros printed `ALL CHECKS PASSED`. Apply it to
confidence and sanity gates too.
