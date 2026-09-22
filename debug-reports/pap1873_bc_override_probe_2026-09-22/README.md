# PAP-1873 probe 8 — bc-consensus dense-gate override — POSITIVE (2026-09-22)

Prereg: PAP-1873 comment `63e65848` (pass criteria posted BEFORE evaluation, AC1).
Data: QA's committed `pap1872_gate_export_2026-09-12/gate_corpus_rows_export.json`
(364 rows; export lane `15d433d` keeps pre-gate candidate + inputs on abstain rows).
No corpus re-run; b158 device events are NOT in the corpus (disjoint validation).

## Rules
- **R** (prereg form): on pap1872-dense gate fire, if `bcPeaks ∈ [40,60]` AND `|bcTc − bcPeaks| ≤ 1` → commit `bcTc`.
- **R'** (device-implementable sensitivity, reported post-hoc): `bcPeaks ∈ [40,60]` → commit `bcPeaks`.
  (Device payloads emit bcPeaks but not bcTc — R' is what ships; R' ⊇ R results below.)

## Gates (prereg 63e65848)
- **P1 dense rescue — PASS:** R fires 16/33, exact 16, wrong 0, **net +16** (bar ≥+8, ≤2 wrong, ≥10 fires).
  R' fires 17/33, **17/17 exact, 0 wrong**. G1-tc40-only subset (the rule that fires on device): 17/17 exact.
- **P2 ordinary no-harm — PASS:** 0 commits on 22 ordinary fires (bcPeaks there ∈ {4,11,12,13,14,18} — never near the band). 0 voids.

## Mechanism (why precision is 100%)
bcPeaks = bolt-circle peak count; on a correctly localized chainring it equals the tooth count
(rollers engage teeth 1:1) and is INDEPENDENT of the radial-FFT lock that motivates the dense gate.
Dense mislocalizations collapse bcPeaks DOWNWARD (observed: 2–13, one 36/39 pair) — never spuriously
into [40,60]. The window therefore perfectly separates rescuable (17) from mislocalized (15) fires;
a naive preGateTc-commit would rescue 18 but commit 15 confident-wrongs.

## Field concordance (b158 session, descriptive per prereg P3)
| event | label | committed today | bcPeaks | R' prediction |
|---|---|---|---|---|
| `058f427c` | 51 | abstain | **51** | commit 51 = exact |
| `a730f84f` | 48 | abstain | **48** | commit 48 = exact |
| `8e7b61dd` | 48 | abstain | **48** | commit 48 = exact |
| `1e0b5c41` | 51 | abstain | 21 (collapsed) | stays abstain (honest) |
| `a3b7b7dd` | unlabeled | abstain | **51** | commit 51 (51-class) |

b158 dense would go 0/4 answered → 3/4 exact + 1 honest abstain. Zero predicted wrongs.

## Caveats
1. Rows are validator-generated at the 09-12 gate calibration (`60ab20c`+`15d433d`), not a fresh HEAD replay — AC2 QA re-derivation required (same JSON, minutes).
2. Empirical invariant, not a proof: downward-collapse is observed on n=364, not derived. QA may tighten the window or add guards.
3. Closes part of the present-but-misselected subclass only; 52T-class signal-absent stays capture-side (PAP-1671 route).

Repro: `node debug-reports/pap1873_bc_override_probe_2026-09-22/eval.mjs` (plain node, zero imports).
