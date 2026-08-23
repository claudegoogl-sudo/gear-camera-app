# b137 abstains on 100% of real device photos — PAP-1659's 5 s deadline vs FP5 stage timings

**Author:** Mobile Engineer · **Date:** 2026-08-23 · **Verdict: b137 must not be validated on device.**

PAP-1659 shipped a hard wall-clock deadline (`WALL_CLOCK_BUDGET_MS = 5000`) in `8f87c1d`
+ `fea3570`, first released in **b137**. It was validated against the desktop corpus,
where the plain-node median count is **1167 ms** — so the gate never fires and the audit
reads as neutral.

The Sentry device telemetry pulled on 2026-08-23 (`docs/device-telemetry-sentry-2026-08-23.md`)
makes that validation invalid. On the real FP5 the gate fires on **every single photo**,
and a fired gate does not return a degraded answer — it returns **no answer at all**.

## 1. The device numbers

Five b132 `debug_report` events carry the full `stageMs` block (PAP-1636, `99d8bf3`).
`stageMs.load + stageMs.preprocess` is the time spent **before `analyzeImage` is entered**,
i.e. before the first deadline checkpoint can ever be reached:

| when (UTC) | load | preprocess | **load+preprocess** | detect | methods | total |
|---|---|---|---|---|---|---|
| 2026-08-07 12:53 | 4130 | 3025 | **7155** | 30058 | 29 | 37242 |
| 2026-08-07 12:55 | 3662 | 2909 | **6571** | 28655 | 35 | 35261 |
| 2026-08-07 12:56 | 3631 | 2863 | **6494** | 30249 | 67 | 36810 |
| 2026-08-07 12:58 | 3961 | 2958 | **6919** | 28506 | 36 | 35461 |
| 2026-08-19 13:56 | 3612 | 2934 | **6546** | 32337 | 51 | 38934 |

Device: Fairphone FP5, QTI SM7325, arm64-v8a, `simulator: false`. All five at 810 000 px.

**The budget is 5000 ms. The cheapest observed load+preprocess is 6494 ms — 30 % over the
entire budget before the algorithm starts.** There is no variance overlap: the minimum
observed pre-detect cost exceeds the whole budget on every sample.

### Does PAP-1635's 58 % cut rescue this?

No, and it is important not to lean on it. `8ddcd97` (PAP-1635, "cut gear frame-pipeline
latency 58 %") landed at 13:05 UTC on 2026-08-07; **b132 was built at 12:31 UTC**, so
these numbers are pre-optimisation. Applying the full 58 % cut generously:

- load+preprocess ≈ 6.5 s → **≈ 2.7 s**, leaving ≈ 2.3 s of budget when `analyzeImage` starts
- detect ≈ 30 s → **≈ 12.6 s**

Detect would have to shrink by **92 %**, not 58 %, to fit in the remaining budget. The gate
still fires on every photo; it just fires a few sweep iterations in rather than at
iteration zero. Same outcome.

## 2. What a fired gate actually returns

The chain in `mobile/src/algorithm/gearCounter.js` at HEAD is deterministic:

1. `countTeeth()` sets `deadline = t0 + 5000` at entry — **`t0` is before decode/downsample**,
   so `load` and `preprocess` are charged against the budget (`gearCounter.js:2957-2963`).
2. `findGearCenter()`'s threshold sweep checkpoints per `(thresh, invert)` pair. With the
   deadline already in the past it breaks on the **first** iteration, collecting zero
   candidates (`:1045`).
3. `bestPurity` is 0 → the Hough fallback is skipped because the budget is spent (`:1207`).
4. Otsu/donut fallback skipped (`:1338`), edge-centroid fallback skipped, and `result` is
   replaced by the stub `{cx: w/2, cy: h/2, radius: 0, method: 'deadline-fallback'}` (`:1398-1400`).
5. Back in `analyzeImage()`, `budgetState.hit` is true → **early return of
   `{toothCount: 0, confidence: 0, methodUsed: 'pap1659-budget-exhausted'}`** (`:2218`).
6. `countTeeth()` returns `toothCount: 0`, `budgetExhausted: true` → the UI abstains.

So the user-visible result on an FP5 running b137 is **"no count", on every photo, forever**.
Not a worse count — no count.

## 3. Empirical confirmation, using PAP-1659's own test

`mobile/__tests__/pap1659.deadline-bound.mjs` already simulates a slow device by inflating
`Date.now()` 20x. Run at HEAD (`84b4baa`) in a clean worktree — full log in
`debug-reports/pap1679_b137_device_deadline_2026-08-23.log`:

```
2026-05-01_08-24-07-480Z (actual=52T, 20x clock): tc=0 conf=0.00 method=pap1659-budget-exhausted -> PASS
2026-05-04_11-46-43-304Z (actual=36T, 20x clock): tc=0 conf=0.00 method=pap1659-budget-exhausted -> PASS
2026-05-01_09-09-26-510Z (actual=36T, 20x clock): tc=0 conf=0.00 method=pap1659-budget-exhausted -> PASS
2026-04-28_06-56-36-143Z (actual=52T, 20x clock): tc=0 conf=0.00 method=pap1659-budget-exhausted -> PASS
2026-04-22_07-10-07-868Z (actual=21T, 20x clock): tc=0 conf=0.00 method=pap1659-budget-exhausted -> PASS
2026-04-24_07-05-25-396Z (actual=21T, 20x clock): tc=0 conf=0.00 method=pap1659-budget-exhausted -> PASS
2026-04-17_10-57-40-821Z (actual=21T, 20x clock): tc=0 conf=0.00 method=pap1659-budget-exhausted -> PASS
2026-04-30_11-35-41-631Z (actual=42T, 20x clock): tc=0 conf=0.00 method=pap1659-budget-exhausted -> PASS

ALL CHECKS PASSED
```

**8/8 photos return `tc=0`. The suite reports ALL CHECKS PASSED.** Its pass predicate is
`simulatedElapsed <= BUDGET_MS * 3 && r.budgetExhausted === true` — it asserts that the
count was *truncated*, and never asserts that anything was *returned*. The evidence that
shipped PAP-1659 is, read correctly, a demonstration of this bug.

Note also the simulated device is **kinder than the real one**: 20x produces 5060–9860 ms
(1.0–2.0x budget), while the measured FP5 is ~30x desktop on total runtime.

## 4. Why every desktop audit says this is neutral

At the desktop node median of 1167 ms, `Date.now()` never reaches `t0 + 5000`, so no
checkpoint fires and the corpus is byte-identical with and without the gate. **A
full-corpus audit at HEAD cannot detect this defect** — a green result there is not
evidence of device safety. This applies directly to PAP-1674, which is pricing the gate on
the 362-photo desktop corpus right now.

The jest-vs-node discrepancy PAP-1672 found (jest median 5820 ms, 5/13 hitting the
deadline) is the same phenomenon seen through a slower interpreter — and is the closest
any desktop measurement has come to reproducing device behaviour.

## 5. Recommendation

The defect PAP-1647 originally filed was a **70–93 s freeze** — an unresponsive app, on
chainrings only. The fix was scoped to a 5 s bound because the corpus said the median was
5757 ms. The device says the median is ~36 000 ms. The premise the 5000 ms was chosen
under does not hold, in the same way the "we are blind" premise did not.

Options, in the order I would take them:

- **A — recalibrate the budget to the device, not the target.** Set the bound above the
  real FP5 p95 for an ordinary gear (~40 s pre-PAP-1635) so it clips only the 70–93 s
  freeze tail it was filed for. Kills the actual user-visible defect, breaks nothing.
- **B — don't charge load+preprocess to the budget.** Anchor `deadline` at `t2` rather
  than `t0`. Roughly 6.5 s of the current budget is spent on work no checkpoint can
  interrupt anyway. Correct regardless of which value A picks.
- **C — shadow mode first.** Keep `budgetExhausted` telemetry, drop the truncation and the
  hard abstain, ship, and read the real distribution off Sentry before choosing a number.
  Slowest, but it is the only option that picks the threshold from device data.
- **D — never abstain on a completed base pass.** Even when the gate fires, if
  `findGearCenter` produced a real candidate, run the count rather than returning `tc=0`.
  `:2218` currently discards a good center because a later stage would be slow.

A and B are one-line changes and are enough to unblock a device session. Whichever is
chosen, **the acceptance evidence must be device stage timings, not a corpus sweep** —
that is the specific mistake that let this reach a release.

## 6. Immediate board consequences

- **b137 must not be device-validated** (PAP-1670) — it would spend the scarce hardware
  session measuring a 100 % abstain rate. Release notes updated to say so.
- **PAP-1674**'s corpus audit is structurally unable to price this gate; its result should
  not be read as clearing it.
- **PAP-758 target 3** is untouched by PAP-1659: bounding the clock does not make the
  count faster, and at ~36 s p50 on real hardware we are ~7x over target with or without it.
