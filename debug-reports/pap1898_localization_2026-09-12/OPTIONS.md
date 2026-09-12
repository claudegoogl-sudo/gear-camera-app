# PAP-1898 — contour localization failure: reproduction + candidate options

Date: 2026-09-12 · Author: Algorithm Engineer · Status: PROBE (pre-implementation, QA cross-check pending)

Artifacts in `debug-reports/pap1898_localization_2026-09-12/`:
- `repro_rows.json` — production-parity rerun of the 5 audited b153 crops
- `candidate_dump.json` — full findGearCenter candidate sets + purities (env-guarded dump)
- `options_probe_rows.json` — Option A/B localization measurements
- `*_pap1898_cmp.png` — annotated overlays: red = production pick, blue = Option A, green = Option B, white = audit truth

Probes (plain node, committed alongside): `mobile/__tests__/pap1898.repro.mjs`,
`pap1898.candidates.mjs`, `pap1898.options.mjs`.

## 1. Reproduction — 5/5 exact parity with b153 device telemetry

Production path (bilinear→900, 0.49·min circular mask, preprocess, analyzeImage + retry):
counts, confidences, contourRadius, methodUsed and pap1872 gate rules all match the
Sentry algoDiag of the audited events exactly (contourR 169/357/330/91/441).

| stamp | label | tc (repro) | conf | abstained | contourR | method (repro) |
|---|---|---|---|---|---|---|
| f5886a846722 | 52T | 13 | 0.423 | no | 169 | fft-agreement |
| af9294fe87f0 | 50T | 24 | 0.328 | no | 357 | fft90-fallback |
| caa1725c6bae | 42T | 0 | 0 | G1-tc40 | 330 | retry-fft90-fallback+pap1872 |
| f3a8e88a13d8 | 36T | 11 | 0 | no | 91 | bc-consensus+pap961-abstain |
| 92e4b255112c | 24T | 0 | 0 | G4 | 441 | bc-fft+large-op-override+pap1872 |

The offline harness is faithful; all measurements below are on device-parity inputs.

## 2. Mechanism — the candidate dump (findGearCenter internals)

Selection vs detection failure, per photo (truth = PAP-1897 audit annotation, 900px space):

| stamp | label | production pick | closest candidate | truth-region candidate present? | verdict |
|---|---|---|---|---|---|
| f5886a84 | 52T | (199,576,r169) p=0.070 | (488,426,r397) dC=45px dR=-8px p=0.038 | YES | **selection failure** |
| af9294fe | 50T | (470,465,r357) p=0.055 | same (selected) dC=31px dR=-34px | YES (picked but 31px off = 63% of tooth spacing) | selection precision |
| caa1725c | 42T | (550,381,r365) p=0.073 | (450,450,r441) dC=9px p=0.051 | YES | **selection failure** |
| f3a8e88a | 36T | (193,399,r91) p=0.086 | (515,463,r398) dC=69px | NO (>5% off) | **detection failure** (near-miss) |
| 92e4b255 | 24T | (450,450,r441) p=0.066 | (390,416,r205) dC=9px dR=-20px p=0.048 | YES | **selection failure** |

Key observations:

1. **Purity paradox**: on 4/5 the *correct* candidate has LOWER fft purity than the
   selected wrong one (0.038 vs 0.070; 0.051 vs 0.073; 0.048 vs 0.066). Consistent with
   PAP-1865 signal census — dense-ring tooth periodicity is often absent at 900px
   (52T present 2/22) — while spider arms / rivets / bolt circles have strong short-range
   symmetry. **Purity-max selection is structurally wrong in this regime.**
2. **Mask-circle artifact**: 92e4b255's winner (450,450,r441) is exactly the PAP-476 mask
   radius (0.49·900) at image center — the Hough stage voted for the mask boundary itself.
   (caa1725c's near-truth candidate is also this mask circle; it lands near truth only
   because that gear is centered.)
3. Conf=0 results still surface as numeric counts (36T→11) — count-path guard issue
   noted in the audit; separate from localization but on the same failure path.

## 3. Options measured (5-photo, truth = audit annotation; errors = % of image width / % of true radius)

**Option A — prior-weighted re-selection (no new passes).**
Keep the existing sweep + Hough candidate generation; replace purity-max selection with
`w = purity · exp(-dCenter²/2σ²) · priorR(r/aimR)` (σ=0.10·aimR; priorR ramps to 1.0 for
r ≥ 0.70·aimR). Result: center err 1.0–7.6% (production 2–31%), radius err 2–96%.
Fails on 24T (picks the r=441 mask circle, dr=96%) unless the mask-boundary candidates
are excluded — cheap fix, but the 96% shows selection-only fixes stay hostage to what
the sweep generates.

**Option B — silhouette-anchored localization (RECOMMENDED).**
Walk inward per 720 angles from the mask boundary (r = 0.49·min−6 … 12) on the Canny
edge map; first edge hit per angle = gear silhouette point (PAP-1865 pass-2 anchor,
which QA verified: coverage 0.994 dense, cannot bolt-circle-lock by construction).
Robust circle fit on the 720 points: algebraic (Kasa) fit + keep-70%-lowest-residual
refit ×4. Result (all 5): center err 2.1–6.9%, radius err 0.1–10.5%, coverage 0.99–1.00,
**2–6 ms** at 900px plain node. Works on the 36T detection failure too (dC 6.9%, r err
0.1%). Independent of FFT purity, hence immune to the purity paradox.

**Option C — gradient-direction Hough upgrade** (replace/augment findHoughCircleCandidates
with edge-gradient-orientation voting, OpenCV HoughCircles-style). Not probed (bigger lift,
new tuning surface); listed for cross-check completeness. Would need its own anti-mask-
boundary and anti-inner-feature measures.

**Option D — hard aim-prior restriction** (restrict search near aim center, radius floor).
Rejected as a global path: off-center gears (24T sits ~6% off aim center) and small-gear
legit cases break under hard floors. The soft version IS option A's prior term.

## 4. Proposed integration shape (to be finalized after QA cross-check + corpus run)

Gate B behind the regime where purity-selection is demonstrably unreliable — trigger set
(all must hold, tuned on corpus, not on these 5):
- max candidate purity < 0.10 (the existing PAP-346 low-purity condition), OR dense-chainring
  regime per checkDenseChainringRegime, OR selected radius < 0.35·aimR while a larger
  candidate exists (implausible-for-aim-crop small lock), AND
- B's silhouette coverage ≥ threshold (fit quality self-check; no coverage → keep production pick), AND
- B center within aim circle (sanity).

Downstream stays untouched: count methods run at the (possibly replaced) center/radius;
pap1872 gates keep honest-abstain duty when signal is genuinely absent at 900px. Expected
effect matches the issue thesis: signal-present dense rings (PAP-1865 census ~23/64) get a
correct geometry to count against; signal-absent rings abstain instead of aliasing
(52→13 becomes abstain, not a correct count — honest outcome).

Also in scope (cheap, independent): exclude Hough candidates within ~2-3% of the mask
radius (mask-boundary artifact); do not surface numeric counts at conf=0 on the
bc-consensus path (36T→11 case).

## 5. Validation plan (acceptance)

1. Dense 40–60T corpus slice (n=64, pap1862/1865 rows as baseline): gated-B end-to-end —
   correct-count rate must rise (target: capture the signal-present subclass), wrong-answer
   rate must drop to ~0 (abstain instead).
2. Ordinary 9–39T corpus (n=298): no regression vs pap1862 audit rows (gate must leave the
   ordinary path untouched; any net drop >0.5pp = stop).
3. The 5 audited b153 photos: no numeric wrong answers; counts or honest abstains.
4. Timing: device budget — B adds ms-scale at 900px (2-6ms desktop; Hermes factor ~37x
   still < 250ms), no new full-image passes beyond the walk (O(720·r) reads).


## 6. Corpus A/B results (2026-09-12, post-options — 367 photos at HEAD 1eabd14 + rescue)

Arm setup: `PAP1898_RESCUE_OFF=1` (baseline) vs unset (rescue), same tree, pap1862 mask
conventions, `mobile/__tests__/pap1898.corpus.mjs`; geometry + supports in
`corpus_geom.json` (pap1898.corpus2.mjs). Strict = tc == label.

### Gate evolution (the purity-only trigger was too broad)

| gate | fires | strict ALL | wrongNZ ALL | dense wrongNZ | fix:harm | note |
|---|---|---|---|---|---|---|
| baseline | 0 | 126 (34.3%) | 86 | 14 | — | |
| G1 purity-only (as first coded) | 196 | 131 (35.7%) | 79 | 13 | 45:38 | huge churn — low purity is normal on ordinary corpus photos |
| G2/G5 support-validator (dSup) | 1–2 | 126 | 85–86 | 14 | — | DEAD: wrong circles (inner rings) have high rim support too |
| **G11 = small-lock OR over-lock, support-gated (SHIPPED)** | **49** | **134 (36.5%)** | **80** | **10** | **15:5** | see below |

G11 fires only when the picked circle contradicts the well-supported silhouette circle:
- small-lock arm: pickedR < 0.85·silR AND supportSil − supportPicked ≥ 0.20
- over-lock arm: pickedR > 1.15·silR AND supportSil − supportPicked ≥ 0.30
- fit quality: silhouette coverage ≥ 0.90, plausible radius, center near frame center

### G11 arm vs baseline (production code path, real run)

| slice | baseline | G11 rescue |
|---|---|---|
| ALL strict | 126/367 (34.3%) | **134/367 (36.5%)** |
| ALL wrong-nonzero | 86 | **80** |
| ALL abstain | 141 | 136 |
| dense 40-60T wrong-nonzero | 14 | **10** |
| dense abstain | 53 | 57 |
| ordinary strict | 126/300 (42.0%) | **134/300 (44.7%)** |
| runtime p50 | 1065ms | 1299ms (walk + support ≈ +ms-scale; rest is re-run methods on rescued geometry) |

Audited b153 anchors under G11: 52T 13→**0 honest abstain** (small-lock fired);
36T 11→**35** (small-lock fired; ±1 miss); 50T/42T/24T unchanged (42T/24T already
honest abstains; 24T's mask-circle lock has genuinely high rim support so the
support gate correctly refuses to fire on it — conservative direction).
Simulation upper-bound (G11 on downstream-peakR geometry, corpus_rescue_G1broad.json
counterfactuals) was strict 137 / fires 92; the shipped in-findGearCenter gate is more
conservative because it sees the sweep pick, not the post-analysis peakR.

### Interpretation + limits

- Dense strict stays 0/67 in every arm — consistent with the PAP-1865 signal census
  (outer-band tooth periodicity largely absent at 900px): localization repair alone
  cannot make dense counts correct; it converts wrong answers into honest abstains
  and fixes the aliased wrong-answer class. The signal-absent dense subclass still
  routes to PAP-1671 capture-side levers.
- The 50T b153 anchor stays 24 (sub-harmonic at corrected geometry) — count-method
  limitation, separate from localization.
- Suite: pap1898.silhouette.test.js 6/6; non-pap1862 suites 114/114 (re-run green);
  both pap1862 corpus suites PASS with the change active (they are the 35-min
  budget-sensitive ones; corpus-photo tests are the known jest-parallelism flake
  family — first full run had 5 flake failures, green on isolated re-runs).


## 7. QA cross-check (PAP-1901) — verdict folded into the shipped arm

QA **endorsed Option B** and independently re-derived the fits (separate Python
pipeline): centers within 1.3–11.5 px of ours; B's circle is the best
edge-supported ring in 5/5; production winners carry near-zero image support in 5/5
(and the 24T "winner" IS the PAP-476 mask ring). The annotated truth circles are
±3–6% instrumentation; acceptance rides on operator tooth-count labels.

Required refinements — resolution on corpus data (367 photos):

1. **Walk-depth prefit outlier rejection (required): SHIPPED, but gated.**
   Plain per-angle depth trimming (median + 3·1.4826·MAD + 2px) was measured and
   shifted washout-rim fits by 1px (52T 377→378), which flipped a downstream commit
   (honest abstain → wrong 23 @conf 0.23) — exactly the annulus-placement load-
   bearing effect of refinement 2. Shipped form: depth gate **arms only when
   ≥12% of angles latched deep** (bolt-circle / spider-arm sectors; QA's synth
   breakdown starts at 30%); below 12% the fit is bit-identical to the plain
   walk+Kasa. Unit tests: 35% contiguous inner-sector recovers to ≤6px center;
   clean circle fit equals untrimmed Kasa (pap1898.silhouette.test.js 8/8).
   Kasa→Taubin swap: deferred (algebraic bias not observable at our coverages;
   same O(n); noted as follow-up).
2. **Annulus placement as corpus-acceptance check (required): DONE.** In-band
   outcomes measured on every rescue fire; the acceptance check is exactly what
   caught the blind depth gate above. Signal-present dense rings did not flip to
   strict-correct (see §6 limits) — in-band placement follows the fitted r via
   the existing relative radius bands (1.03–1.07× outer).
3. **Edge-derived metrics (required): DONE.** Shipped fits vs QA's independent
   edge-derived reference:
   f588 (460,467,377) dc 5.4px (1.4%r) · f3a8 (455,503,360) dc 7.1px (2.0%r);
   probe fits: af929 dc 0.0px · caa dc 4.1px (1.1%r) · 92e4 dc 10.2px (4.5%r, and
   within 1/3 tooth-pitch for its 24T class). Radii within 0.3–2.2% everywhere.

Endorsed cheap fixes — one shipped, one rejected on data:

- **bc-consensus conf-0 guard: SHIPPED.** Bare bc-consensus commits whose purity
  would surface at confidence 0 abstain instead (method
  `bc-consensus+pap1898-conf0-abstain`). Corpus class measurement: 24/26 such
  baseline commits are wrong (>±1); the guard's net corpus effect: −1 wrongNZ,
  −1 strict (one lucky 21@conf0 → honest abstain). Kept for honesty.
- **Hough mask-radius exclusion: evaluated, REJECTED.** It changed exactly one
  corpus photo (the 24T b153 anchor) and flipped its honest abstain into a
  conf-0 wrong count (14), because removing the mask-ring candidate let the
  sweep pick another wrong circle; the silhouette rescue's support gate already
  refuses to fire on the high-support mask ring. Keep the candidate; documented
  in-code at the exclusion site.

### Shipped arm — final corpus (367 photos, HEAD 1eabd14 + this change)

| slice | baseline | shipped rescue |
|---|---|---|
| ALL strict | 126/367 (34.3%) | **133/367 (36.2%)** |
| ALL wrong-nonzero | 86 | **79** |
| ALL abstain | 141 | 138 |
| dense 40-60T wrong-nonzero | 14 | **10** |
| dense abstain | 53 | 57 |
| ordinary strict | 126/300 (42.0%) | **133/300 (44.3%)** |
| fires | — | 50 (fix:harm = 15:5) |

Anchors: 52T 13→**0 honest abstain** · 36T 11→**35** · 24T stays honest abstain ·
50T 24 (count-method sub-harmonic, separate) · 42T abstain. Strict is −1 vs the
unguarded pre-refinement arm (134) purely from the conf-0 honesty trade above;
wrong-nonzero is the best of all measured arms (79). Runtime +~230ms p50 vs
baseline (walk + rim support; negligible vs the 45s budget).

Tests: pap1898.silhouette.test.js 8/8; non-pap1862 suites 122/122 at the shipped
shape; pap1862 corpus suites re-run at the shipped shape (see ticket for result).


## 8. Rebase onto PAP-1900 (G5/G6 collapse guards) — corrected merged-base A/B

While this task was in flight, PAP-1900 landed its QA-approved G5/G6
collapse-guard rules on main (aa27ffa..c78e000, cross-check PAP-1902). This
worktree was rebased onto c78e000 (silhouette helpers + rescue block + bc-conf0
guard re-applied verbatim; pre-merge copy kept as
gearCounter.preRefine_merge_backup.js). §6–7 tables were measured against the
pre-PAP-1900 base and are superseded by this section; stale-base artifacts are
kept as corpus_baseline_stalebase.json / corpus_rescue_stalebase.json.

### Interaction with G5/G6

G5 (radial-anchor disagreement at low confidence) abstains several classes this
rescue had already fixed at the old base (36T conf-0 → 35, 50T → 24): on the
merged base those rows are honest abstains in BOTH arms. The audited b153 set
under the merged shipped arm is **all-honest: zero wrong numeric answers**
(52T 13→abstain, 50T 24→abstain via G5, 36T 11→abstain, 42T/24T abstain).

One real interaction to flag to QA (PAP-1900-owned): G5's fft90OuterRescue
carve-out (PAP-1902 §5, binding) exempts rows that sit at high radial
disagreement BY CONSTRUCTION — which now includes rows whose geometry this
rescue corrected. Four corpus photos use that path to commit still-wrong counts
(all ordinary-class: act 24→10, 14→22, 28→22, 34→20). Dense harms: 0.

### Merged-base A/B (367 photos; both arms include G5/G6; only the rescue toggles)

| slice | rescue OFF | rescue ON (shipped) |
|---|---|---|
| ALL strict | 97/367 (26.4%) | **101/367 (27.5%)** |
| ALL wrong-nonzero | 29 | **24** |
| ALL abstain | 235 | 233 |
| dense 40-60T wrong-nonzero | 4 | **1** |
| dense abstain | 63 | 66 |
| ordinary strict | 97/300 (32.3%) | **101/300 (33.7%)** |
| fires | — | 49 (fix:harm = 12:4) |

Per-photo marginal effect of the rescue on top of G5/G6: 12 photos fixed
(wrong→correct or wrong→honest abstain), 4 harmed (carve-out gap above),
net 3:1 with dense wrong-numerics nearly eliminated (4→1). Runtime unchanged
(+~230ms p50, walk + rim support). QA edge-derived localization metrics (§7.3)
are base-independent and unchanged.

## 9. Full-suite gate + anchor-B regression fix (2026-09-12, post-§8)

The full parallel jest run at the merged shape caught a real regression the
367-photo corpus could not: `pap1862.d3_gate_disabled.test.js` anchor B
(FP5-b151 `captureB_898623252`, device-labeled 20T) dropped from an exact
conf-1.0 `20` to `19 @conf 0.54`. Mechanism: the silhouette walk latched a
coverage-1.0 fake circle at r=416 = 0.943·maskR (the vignette/mask-edge ring,
~25px inside the scan start) — small-lock fired (350 < 0.85·416, support
delta ≥0.20) and the annulus moved onto the near-boundary structure, off by
one harmonic. Anchor B is a session capture, not a corpus row, so the corpus
A/B was blind to it.

Fix: **mask-proximity refusal** — the rescue refuses to fire when
`silR > 0.90 · 0.49·minDim`. Measured separation: corpus silR/maskR max is
**0.894 over all 367 rows** (zero corpus fires blocked), the anchor-B latch
sits at 0.943 (blocked), and the two load-bearing audited b153 silhouette
fits sit at 0.855 (52T) and 0.816 (36T) (unchanged). Decision extracted to
`__test.pap1898ShouldRescue` (behavior-identical; unit-tested incl. the
396-fires/399-refuses boundary).

Post-fix verification: anchors A+B exact `20 @conf 1.000` (rescue ON ==
OFF); audited-5 repro bit-identical to §8's repro_rows.json;
pap1898.silhouette.test.js 13/13; pap1862.d3_gate_disabled 4/4 standalone;
pap1881.flash_control 4/4 standalone (known parallel-jest flake class); full
suite re-run at the commit — see jest_full_final.log.
