# CEO ruling — `WALL_CLOCK_BUDGET_MS = 45000`, anchored post-preprocess

**Issue:** PAP-1689 (decision) · **Implements into:** PAP-1683 · **Date:** 2026-08-23 · **Decider:** CEO

## Ruling

1. **Fix B is confirmed.** `4f244d7` (anchor `deadline` at `t2`, after decode+preprocess,
   in both `countTeeth` and `countTeethFromRgba`) stays. Decode and preprocess contain no
   checkpoint; charging them against the budget only shrank the window the real checkpoints
   get to work with.
2. **`WALL_CLOCK_BUDGET_MS = 45000`.** Confirmed as recommended on PAP-1689.
3. **Option D is rejected** as a companion change (reasoning in §3).
4. **Option C is not taken as a separate release**, because the chosen value already gives
   us C's data (§4) without spending a device session on a shadow build.

## 1. The window the number has to sit in

Fix B means the budget now governs `t2 → t4`, which is exactly what `stageMs.detect` +
`stageMs.methods` measure (`gearCounter.js:3565-3572`, `t3` is taken immediately after the
base `analyzeImage` call). So the device numbers can be read against the budget directly,
with no estimation:

| quantity | source | post-preprocess cost |
|---|---|---|
| ordinary gear, observed range (n=5, b132) | `docs/pap1659-device-deadline-analysis-2026-08-23.md` §1 | detect 28 506–32 337 ms + methods 29–67 ms |
| ordinary gear, post-optimisation median | PAP-1677 live Sentry, 160 FP5 events, ~36 s total | ≈ 29 s |
| chainring freeze (the defect PAP-1647 filed) | PAP-1647, b129, 70–93 s total | ≈ 63–86 s |

AC1 (must not fire on an ordinary photo) puts a floor at **~32.4 s**.
AC3 (the freeze must still be clipped) puts a ceiling at **~63 s**.

`sqrt(32.4 × 63) = 45.1 s`. **45 000 ms is the geometric midpoint of the two binding
constraints** — 1.39x headroom over the worst ordinary photo ever measured, and it still
clips the mildest freeze we have on record by 18 s. No other single number is better
balanced between the two ACs, which is why I am confirming the recommendation as written
rather than adjusting it.

Behaviour at 45 000, end to end:

- ordinary photo: gate never reached → byte-identical to a build without the gate. AC1 holds.
- chainring freeze: gate fires, `:2218` returns `tc=0` promptly → total ≈ 45 s + ~7 s
  preprocess ≈ **52 s wall clock, down from 70–93 s**. AC3 holds, and an abstain is what the
  chainring path already produces on these photos anyway, so no answer is lost.

## 2. Why not tighter

20 s (the optimistic post-PAP-1635 estimate) is below the ~29 s real-device median. It would
reproduce the b137 defect on a slower schedule. The two errors are not symmetric: firing
early costs the user *the answer* (`tc=0`, not a degraded count), firing late costs the user
*seconds of freeze*. Bias high; 45 000 is the tighter end of what "bias high" allows.

## 3. Why option D is rejected

D ("never abstain when the base pass completed") reads as free only if the five count methods
are cheap. They are not separable in the telemetry we have: `stageMs.methods` (29–67 ms) is
the *retry / hi-res* tail, not the count methods — those sit inside `detect`, and PAP-1666
priced `findGearCenter` at ~60 % of the base pass, leaving ~40 % for them. Letting them run
after a fired budget therefore adds roughly 40 % on top of an already-exhausted window: a
45 s fire could run to ~75 s+ and hand PAP-1647's freeze straight back. Gating the methods
individually instead is not available either — PAP-1647 already established `retryNearCenter`
is not gateable, because correct counts flow through it and truncating it yields fast-but-wrong
answers, which under the ±0 policy are misses, i.e. worse than the abstain.

D was the right instinct for a 5 s budget, where the gate fired on everything and discarding a
good center was pure loss. At 45 s the gate only fires on the pathological tail, where an
abstain is the correct output. **The correct number makes D unnecessary; D with the wrong
number would have been a patch over it.**

## 4. Why option C is not a separate release

C's substance — pick the threshold from real device data — is preserved: `budgetExhausted`
already ships in the debug report and reaches Sentry. Shipping 45 000 *is* a shadow read with
a safety clip attached: on ordinary traffic the gate is inert and reports nothing, and any fire
is a labelled event we can pull. A separate shadow build would spend one of our scarce device
sessions (PAP-1671/PAP-1677 capability gap) to learn what this build reports for free, while
leaving the 70–93 s freeze unbounded in the meantime.

**Standing escape hatch:** if Sentry shows `budgetExhausted: true` on *non-chainring* FP5
photos, raise the value to 55 000 — do not remove the gate, and do not reopen this decision.
55 000 still clips at ~62 s against a 70–93 s freeze.

## 5. Acceptance criteria for PAP-1683

- **AC1** — at a device-realistic clock multiplier (~30x; corpus plain-node median 1167 ms vs
  ~36 s device ≈ 31x), all 8 photos in `pap1659.deadline-bound.mjs` return `toothCount > 0`
  and `methodUsed` does not contain `pap1659-budget-exhausted`.
- **AC3** — at a freeze-representative multiplier (~60–80x), the budget fires *and* simulated
  post-preprocess elapsed is bounded at ≈ `WALL_CLOCK_BUDGET_MS`, below the 70–93 s figure.
- The existing 20x case is now vacuous at 45 000 (20 × ~1.2 s ≈ 23 s, under budget). The test
  must be re-parameterised, not left green-by-inertness — inertness passing for a pass is the
  exact failure that let PAP-1659 ship.
- **Evidence rule (carried from PAP-1683 §5):** acceptance is device stage timings from Sentry.
  A green desktop corpus sweep is structurally unable to price this gate; **PAP-1674's audit
  result does not clear it** and must not be cited as if it did.

## 6. What this ruling does not do

45 000 ms is a **freeze clip, not a latency target**. PAP-758 target 3 (≤ 5 s per photo)
remains **open and unmet** — the device is at ~36 s p50, ~7x over. Nothing here changes that
number, and no document should read 45 s as an accepted product latency.
