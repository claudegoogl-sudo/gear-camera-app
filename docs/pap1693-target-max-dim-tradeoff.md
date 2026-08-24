# PAP-1693 — TARGET_MAX_DIM accuracy/speed tradeoff (option 4 measured)

**2026-08-24. Full 362-photo corpus, plain node (never jest — babel-jest inflates the
typed-array loops ~400×), `countTeethFromRgba` boundary. Sweeps executed 2026-08-23 on
the shared host in two sessions (09:17–09:48 and 23:48–00:03); artifacts are
`debug-reports/pap1693_resdim_{900_sweep,700_debug-rerun,500_sweep,350_run}.json`.
No commit hash was recorded in the artifacts; all numbers below were recomputed by the
CEO from the raw JSONs, independently of the PAP-1711 closeout comments.**

## The verified table

Both rates are quoted everywhere (PAP-1673 convention): `correct/N` (of photos) **and**
`correct/answered` (of answers). One number alone silently picks a denominator reading.

| dim | correct / 362 | of-photos | abstain | answered (F) | of-answers correct | of-answers conf-wrong | conf-wrong (photos) | host p50 | host p95 | host max |
|----|----|----|----|----|----|----|----|----|----|----|
| **900** (shipped) | 210 | **58.0%** | 126 (34.8%) | 236 (65.2%) | **89.0%** | 11.0% (26) | 7.2% | 1032 ms | 1789 ms | 4832 ms |
| **700** | 192 | **53.0%** | 137 (37.8%) | 225 (62.2%) | **85.3%** | 14.7% (33) | 9.1% | 676 ms | 1390 ms | 5903 ms |
| **500** | 170 | **47.0%** | 140 (38.7%) | 222 (61.3%) | **76.6%** | 23.4% (52) | 14.4% | 380 ms | 630 ms | — |
| **350** | 135 | **37.3%** | 151 (41.7%) | 211 (58.3%) | **64.0%** | 36.0% (76) | 21.0% | 214 ms | 351 ms | — |

Deltas vs the 58.0% baseline, and speed:

| step | photos Δ | of-answers Δ | conf-wrong of answers | answered Δ | host p50 speedup |
|----|----|----|----|----|----|
| 900→700 | **−5.0pp** | −3.7pp | 11.0→14.7% (+3.7pp) | −3.0pp | 1.53× |
| 900→500 | **−11.0pp** | −12.4pp | 11.0→23.4% (**>2×**) | −3.9pp | 2.72× |
| 900→350 | **−20.7pp** | −25.0pp | 11.0→36.0% (**3.3×**) | −6.9pp | 4.82× |

Per-bucket total rates — the damage is concentrated exactly where accuracy is already
the binding constraint (Large+XL are 53% of the corpus):

| dim | Small 9–15T | Mid 16–20T | Large 21–28T | XL 29–60T |
|----|----|----|----|----|
| 900 | 75.0% | 81.8% | 45.1% | 37.5% |
| 700 | 72.8% | 75.8% | 36.3% | 33.8% |
| 500 | 69.9% | 69.7% | **25.7%** | **28.8%** |
| 350 | 57.4% | 45.5% | 22.1% | 21.3% |

At 500px, Large and XL collapse to ~26–29%: half their photos no longer get an answer
and roughly half of the remaining answers are wrong.

## Device extrapolation — and where it is uncertain

Device ≈ host × **33–38** (PAP-1682: device p50 ~36.7 s vs host ~1.0 s). Sanity anchor:
dim=900 host p50 1032 ms × 33–38 = **34.1–39.2 s**, bracketing the telemetry's 36.7 s.

| dim | device p50 (extrap.) | device p95 (extrap.) | vs 45 s crash-bound (p95) | vs 5 s hard target (p95) |
|----|----|----|----|----|
| 900 | 34.1–39.2 s | **59.0–68.0 s** | **over** | over (~12–14×) |
| 700 | 22.3–25.7 s | 45.9–52.8 s | marginal/over | over (~9–11×) |
| 500 | 12.5–14.4 s | 20.8–23.9 s | clears (~2× headroom) | over (~4–5×) |
| 350 | 7.1–8.1 s | 11.6–13.3 s | clears (~3–4×) | over (~2.3–2.7×) |

**Uncertainties, stated plainly:**
- The 33–38× factor was measured at dim=900. Fixed stages (camera, native preprocess,
  render) do not shrink with dim, so device time at lower dims may be **higher** than
  these linear extrapolations — the table above is optimistic, not conservative.
- The ratio **breaks down entirely on chainrings** (PAP-1647: device freeze 70–93 s vs
  host max ~5 s). The p95 tail is dominated by exactly those photos, so the p95
  extrapolations are the least reliable numbers here, in the direction of device-worse.
- Host legs ran in two sessions on the shared 8-vCPU host, not strictly isolated. The
  four p50s (1032→676→380→214) interpolate monotonically, which argues against
  contention artifacts, but AC1's "isolated" wording is only approximately satisfied.

## AC2 answer: can this lever alone reach 5 s on-device? **No.**

1. To get device p95 ≤ 5 s, host p95 must fall to **~132–152 ms**. The best measured
   point (dim=350) is 351 ms — a further 2.3–2.7× gap, at a dim where accuracy is
   already 37.3% and a third of answers are confidently wrong.
2. Independent of detect: at dim=900 the non-detect floor (load+preprocess) is already
   **~6.8 s on device** (PAP-1672, in PRODUCT_TARGETS.md target 3) — over 5 s with
   detect at 0 ms. `TARGET_MAX_DIM` shrinks detect, not that floor.
3. The 5 s target needs the native-kernel track (PAP-1694/1696) *and* reduction of the
   fixed stages, or a fundamentally different pipeline. Option 4 is a real but
   expensive fallback, not a path to the target.

Against the **45 s crash-bound** (PAP-1686/1689, governs `stageMs.detect+methods`):
today's shipped dim=900 extrapolates **over** the bound at p95 (59–68 s) — on device,
the budget guard will clip the slowest photos, converting some of them to
best-count/`budgetExhausted` rather than fresh answers. dim=500 clears the bound with
~2× headroom, but at −11.0pp of photos and >2× confident-wrong.

## Standing-rule statement

**No speed win is free if it costs answers.** Priced:

- **dim=500 is not acceptable as a default**: −11.0pp of photos, −12.4pp of answers,
  confident-wrong more than doubles (11.0→23.4% of answers) — for 2.7× host speed that
  does not reach 5 s anyway.
- **dim=350 is categorically out**: −20.7pp, conf-wrong 3.3×.
- **dim=700 is the only tactical fallback** (−5.0pp of photos for 1.5×), to be
  considered **only if** the native kernels (PAP-1694/1696) under-deliver and the 45 s
  crash-bound keeps firing on device. It is not a ship decision today; the default
  stays 900.

## Provenance note

The PAP-1711 closeout comments referenced this document, but the file was never
committed — the raw sweep JSONs and comment numbers were the only surviving artifacts.
This document was reconstructed by the CEO on 2026-08-24 from the raw JSONs. Two
figures in those comments were denominator conflations and are corrected here: the
900→500 "answer rate" delta is **−3.9pp of photos answered** (65.2→61.3) and
**−12.4pp of answers correct** (89.0→76.6) — not one number; and the Large/XL
collapse at 500 is **25.7%/28.8%**, not "28%/14%". The dim=700 leg quoted at p50=617 ms
elsewhere was the `test-single` run; the canonical `debug-rerun` artifact gives
p50=676 ms.
