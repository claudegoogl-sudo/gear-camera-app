# PAP-1534 — PAP-758 D3: pre-FFT chainring/cassette regime classifier (≤500KB) — spec v1

**Status**: spec only — no code, no harness work. v1 fulfils PAP-1534 AC1+AC2 (deliverable answers items §1–§6 in enough detail that an implementation child can be filed without further architectural questions) and stages AC3 (QA review). §1 partition analysis triggers **AC4**: the existing 362-photo labeled corpus is structurally insufficient for the 30–60T chainring sub-range under the PAP-758 >99% accuracy contract, and the recommended next step is escalation of D4 (UX descope) to CEO rather than greenlighting an implementation child against this spec.

**Author**: Algorithm Engineer
**Date**: 2026-05-16
**Successor to (D3 routing)**: PAP-1533 (D-track decision); supersedes none.
**Sibling options**: D1 multi-frame (descoped), D2 sensor prior (descoped), D4 UX descope (held in reserve — escalates per §1 verdict), D5 (none active).

---

## 0. Origin and architectural framing

The single-image-cue FFT ladder under PAP-758 has been exhausted across two architectural rounds:

- **Round 1 — single-feature** (PAP-1078 → PAP-1481): four ladder heads (rOuter-only, Hough bolt-pattern, spectral sub-harmonic, Hough abstain-only) all closed DESCOPED on `n ≤ 145` per-photo evidence with Wilson 95% UB below the PAP-758 80%/99% targets; root cause structural rather than tuning per PAP-1097/PAP-1098/PAP-1489-v4.
- **Round 2 — joint radius×tooth-count** (PAP-1102 → PAP-1480 → PAP-1485): full joint-scan, σ_R prior, Option α (bc-consensus carve-out), Option β (skip-abstain on bc-self-confirmed) all closed DESCOPED at the §3.4.7 v6.1 §4.0 hard-cap matrix (0/6912 cells PASS on Phase-1 sweep — PAP-1525→PAP-1527 endorse-closure on commit `30cc688`).

QA's root-cause finding stands (PAP-1098 / restated in PAP-1499 §3.4.6 footnote): for cassette-on-chainring photos the strongest ring in the gear region IS the chainring (or its bolt-circle), so `peakR` locks onto the wrong structure and downstream FFT features inherit the lock-in. No re-weighting of features evaluated at `peakR` can escape the lock — every joint-scan or radius-conditioned discriminator has had its discrimination band collapsed because the disagreement set sits inside the locked-in outer band.

**D3 = architectural break**: remove the discriminator burden from the FFT path entirely. Insert a **regime classifier** before `peakR` selection that emits a hard regime label and uses that label to *gate* downstream feature selection (e.g. for `regime=chainring`, the FFT path constrains its radius search to the inner cassette band and ignores the chainring outer ring; for `regime=cassette`, it runs unchanged). The classifier does NOT predict tooth-count; it predicts the structural regime so the existing tooth-count detector can operate in its native single-ring assumption.

This document specifies the design only. Training, integration, harness, and rollout each land as separate children gated on QA endorsement of this spec (AC3) and on the AC4 corpus-feasibility verdict in §1 below.

---

## 1. Training data partition (PAP-1534 §1 — **AC4 trigger surfaces here**)

### 1.1 Label-source-of-record

Per PAP-1534 references: the 362-photo labeled corpus from the PAP-1485 sweep is the source-of-record. Concretely this is the union resolved by `mobile/__tests__/lib/harness-runner.js::discoverLabeled({ minActual: 9, maxActual: 60 })` over `training-data/*_meta.json` with `actual_tooth_count || actualTeethCount` set, at HEAD `30cc688` (sweep CSV: `debug-reports/pap1514_sweep_2026-05-16.csv`).

Verified corpus distribution at HEAD (re-derived from `training-data/` at spec authoring time):

| Bucket (per `harness-runner.js::classOf`) | Range | N | Distinct labels | Mode concentration |
|---|---|---:|---:|---|
| Small | 9–13T | 54 | 3 | 11T=41 (76%) |
| Mid | 14–19T | 115 | 4 | 14T=47, 15T=35, 18T=32 (3 modes ≈ 99%) |
| Large | 20–28T | 113 | 4 | 21T=32, 24T=36, 28T=44 (3 modes ≈ 99%) |
| **XL (chainring band)** | **30–60T** | **80** | **7** | **42T=27, 52T=22, 36T=10 (3 modes ≈ 74%); 32T=2, 34T=4, 48T=7, 50T=7, 51T=1** |
| Total | 9–60T | 362 | 19 | — |

### 1.2 Required regime label add (precondition for ANY training)

**No `regime` label exists in the current `_meta.json` schema.** The only ground-truth field is `actualTeethCount` (or its underscore variant). The PAP-1098 root cause distinguishes two regimes:

- **`regime: cassette`** — the gear region contains a single ring (the cassette/cog itself); no concentric chainring is visible inside the aim circle. This is the assumption the entire FFT path was built on; ~all 282 sub-30T photos are believed cassette by capture context, but this has not been re-labeled.
- **`regime: chainring`** — the gear region contains the chainring as the dominant ring, optionally with a cassette mounted in front (the PAP-1098 failure mode). The 80 photos in the 30–60T band are mostly chainrings by tooth-count, but the cassette-on-chainring sub-population is the failure mode the classifier exists to detect and is **not separable from solo-chainring photos by `actualTeethCount` alone**.

**Minimum-viable label-add** before any implementation child can begin training:

1. Schema extension: add `regime ∈ {cassette, chainring}` to `_meta.json` for every photo in `training-data/`. Two-class only at v1 (no "mixed" class — see §3.3 abstain).
2. Sub-label `chainring_subtype ∈ {solo_chainring, cassette_on_chainring}` for the 80 chainring-band photos. This is the discriminator the failure mode hinges on — solo-chainring photos do not exhibit the lock-in and must not poison the chainring class.
3. Manual re-label pass by someone with the original capture context (CEO or capture-time photographer). Estimated effort: ~3–4 hours for 362 photos at ~30s/photo for binary regime label plus subtype on the 80 chainring rows.

The implementation child issue MUST NOT begin until labels are in metadata; QA's per-class accuracy AC (§5) is unverifiable without them.

### 1.3 Train / held-out partition (proposed if labels exist)

Assuming labels exist, the partition follows the same scope discipline as the PAP-1485 v6.1 §4.1 pre-flight grid:

- **Held-out**: 30% per stratum, seeded with `mulberry32(1337)` over `(stamp, regime)` pairs (matches `harness-runner.js::selectCorpus` regression sampler). Stratify by `(regime, chainring_subtype)` to preserve sub-population balance.
- **Train**: remaining 70% with class-weighted sampling (cassette:chainring ≈ 282:80 ≈ 3.5:1 → invert weights to ~1:3.5 during training to compensate).
- **Internal validation**: 5-fold CV within the train set during model selection; held-out is touched once for the §5 accuracy report.

### 1.4 Corpus-feasibility verdict (AC4 trigger)

**The corpus is structurally insufficient for the PAP-758 >99% accuracy contract on the 30–60T chainring sub-range.** Three independent reasons:

1. **Held-out statistical power** — 30% held-out of 80 chainring photos = **24 photos**. Wilson 95% lower bound on chainring-class accuracy at empirical 100% (24/24) is **86.2%**, well below the >99% PAP-758 contract. Even at empirical 100% on every held-out chainring photo, the held-out partition cannot statistically demonstrate >99% on this class. (For comparison: to demonstrate >99% Wilson 95% LB at empirical 100%, ≥298 held-out chainring photos are required — roughly 13× the available sample.)

2. **Tooth-count diversity collapse in the chainring band** — 80 chainring photos span 7 distinct tooth counts, but 51 of 80 (64%) are 42T or 52T, and 4 of 7 distinct labels have ≤7 photos (32T=2, 34T=4, 48T=7, 50T=7, 51T=1). Effective diversity ≈ 3 modes (42T, 52T, 36T). A held-out partition that loses any one of those modes leaves the classifier under-tested for that range; cross-validated training is dominated by the 42T+52T cluster and will not generalise across the full 30–60T band.

3. **Cassette-on-chainring sub-population unknown** — the PAP-1098 failure mode requires the `cassette_on_chainring` subtype, but per §1.2 these labels do not exist in current metadata and are likely **rare or absent** in the lab-captured training set (most lab photos are solo gears for tooth-count labelling). Without ≥30–50 confirmed `cassette_on_chainring` photos in the train set, the classifier has zero positive examples of the regime it most needs to detect — a binary classifier trained against zero positive failure-mode examples cannot generalise to the failure mode. The label pass in §1.2 may surface the empty-positive-class state, in which case label-only re-pass cannot rescue training and the corpus needs **capture-time expansion** (new device photos with the failure mode deliberately staged) before training is feasible.

### 1.5 AC4 action — recommend D4 (UX descope) escalation

Per PAP-1534 AC4, when §1 finds the corpus structurally insufficient for the 30–60T sub-range, this ticket closes with a recommendation to escalate D4 (UX descope) rather than producing a stubbed spec.

Sections §2–§6 below are still specified at full detail so that:
- (a) IF the CEO chooses to fund the corpus expansion path (re-label + capture-time augmentation per §1.2 + §1.4 reason 3), an implementation child can be filed against §2–§6 without further architectural questions, satisfying PAP-1534 AC2;
- (b) the structural insufficiency is concretely traced to specific corpus gaps (not generic concerns), so the D4 escalation memo is evidence-backed rather than hand-wavy.

QA's §6 acceptance criteria already cover the demonstrable-evidence gate — under §1 corpus reality, the proposed AC1 (held-out chainring accuracy ≥99% Wilson 95% LB) is **not satisfiable** today and the implementation child would be DOA. AE recommends CEO routes to D4.

---

## 2. Model-class candidates within the ≤500KB envelope

Both candidates target single-frame inference on the gear region of interest (ROI) after the existing aim-circle prior (PAP-961) has fixed the centre and approximate outer radius. Input is a fixed-resolution patch (e.g. 96×96 or 128×128 grayscale or single-channel gradient-magnitude), cropped to a generous multiple of `aimR` (e.g. 1.4×) and zero-padded to square. This keeps the classifier resolution-independent at the camera level and lets the FFT path keep its own preprocessing unchanged.

### 2.1 Candidate A — small CNN (MobileNet-v2 head, depthwise-separable)

- **Architecture**: 3-block depthwise-separable CNN — Conv3×3(8) + DWConv3×3(16) + DWConv3×3(32) + GAP + Dense(2). Approx parameter count ~25k weights, ~100KB in float32, ~50KB quantized int8 — well inside the 500KB envelope with headroom.
- **Inference cost (estimated)**: 96×96 input on TFLite int8 quantization, Pixel 6 class device, ~5–15ms per inference. On older devices (Snapdragon 6-series) ~30–60ms. Well under the 1s/5s PAP-758 budget.
- **Strengths**: end-to-end feature learning; can pick up gradient/texture cues the classical-CV path misses; quantization-friendly.
- **Weaknesses**: requires the most training data; least interpretable; data hunger most acute when chainring class is corpus-thin (per §1.4).

### 2.2 Candidate B — classical-CV features + linear/tree classifier

- **Architecture**: hand-engineered features computed on the aim-circle ROI — (i) radial-gradient profile peak count and spacing entropy (probes for multiple concentric rings); (ii) angular FFT magnitude at the inner-band radius vs the outer-band radius (ratio probes regime); (iii) bolt-circle Hough peak count and inner-vs-outer ring ratio. Approx 10–20 scalar features fed to a Logistic Regression or shallow gradient-boosted tree (XGBoost depth=3, max 50 trees). Model size <50KB.
- **Inference cost (estimated)**: feature computation ~20–40ms (dominated by one radial-gradient pass over the ROI — partial reuse of existing `gearCounter.js` infrastructure); classifier inference <1ms. Well under budget.
- **Strengths**: interpretable per-feature contributions enable QA cross-checks; trains effectively with ~50 examples per class (much closer to the corpus reality in §1.1); features map directly to the PAP-1098 root cause (concentric-ring count is the regime signal).
- **Weaknesses**: feature engineering risk — if the chosen features turn out to be regime-correlated only on photos similar to the training set, generalisation suffers more silently than with a CNN.

### 2.3 Candidate C — tiny ViT distillate (NOT recommended at v1)

A 4-layer patch-16 ViT distilled from a larger teacher would fit in ~300KB int8, but: (i) training a distillate requires a strong teacher model that itself requires the corpus we don't have; (ii) ViT inference on mobile is poorly supported in TFLite; (iii) interpretability is worse than the CNN. Listed only to acknowledge consideration; not recommended.

### 2.4 Recommendation

**Candidate B (classical-CV features + GBT)** is the recommended v1, conditional on §1 corpus expansion landing. Rationale:

- Aligns with PAP-1098 root cause — the discriminator IS the concentric-ring structure, which is what hand-engineered radial-gradient features directly probe.
- Trains effectively with the available corpus scale (after the §1 label add) without requiring the capture-time expansion that the CNN would demand.
- Per-feature interpretability lets QA cross-check predictions against the existing PAP-861/868/885/889/1059/1063 predicate traces — feature contributions can be regressed against known confirmed-wrong rows to verify the classifier isn't relying on spurious correlates.
- Falls back to PAP-961 abstain (§4) cleanly because feature scores are calibrated probabilities, not opaque CNN softmaxes.

Candidate A is the v2 fallback if Candidate B's feature set proves insufficient on a future cluster.

---

## 3. Integration point

### 3.1 Where the gate runs in the pipeline

Insertion point is **after the PAP-961 aim-circle prior, before the joint-scan / `peakR` selection in `gearCounter.js`**.

Concrete call-site references at HEAD `30cc688`:

- `gearCounter.js:3037` and `gearCounter.js:3393` — the two `peakR` selection sites identified by the PAP-1485 §3.4.7 wire-up (PAP-1489 cross-check #3 location verification stands).
- The regime classifier runs **once per photo**, immediately after `aimCircleR` is finalised (which happens upstream of both sites). Result is a `{ regime, confidence }` pair that flows into both sites as a single new context field.

### 3.2 Classifier contract

```
RegimeClassifier.classify({ rgbaPatch, aimCircleR, aimCircleCx, aimCircleCy })
  → { regime: 'cassette' | 'chainring' | 'abstain', confidence: [0,1] }
```

- `regime` is the hard label after the §4 confidence-threshold gate. `abstain` indicates confidence below threshold (NOT a third learned class — see §4).
- `confidence` is the calibrated probability of the predicted class (post-Platt or isotonic calibration on the held-out partition). Required for downstream gates that consume it.

### 3.3 How the regime label gates downstream feature selection

| Regime | Effect on `peakR` selection / joint-scan |
|---|---|
| `cassette` | No change vs HEAD. Joint-scan radius search range stays `[0.40, 1.10]·aimR` per PAP-1480 v6.1. The classifier acts as a no-op for cassette-regime photos, preserving the b94+ Small/Mid/Large accuracy floor verbatim. |
| `chainring` | Joint-scan radius search range **clamped to the cassette-on-chainring inner band** `[0.40, 0.65]·aimR` (i.e. the chainring outer ring band `≈ 0.85·aimR` is excluded). All existing PAP-861/868/885/889/1059/1063 chainring-bypass predicates remain active in parallel — they were the partial mitigations for this exact failure mode and continue to function. The classifier's role is to constrain the search BEFORE those predicates run, not replace them. |
| `abstain` | Identical to HEAD behaviour: joint-scan unchanged; PAP-961 aim-circle abstain may still fire downstream as today. The classifier is invisible on `abstain` rows. |

The `[0.40, 0.65]·aimR` chainring-regime range is provisional and must be re-derived from the §1-labelled corpus (specifically, the empirical peakR distribution on `chainring_subtype=cassette_on_chainring` photos when the ground-truth cassette tooth-count is detected correctly). The implementation child specifies the calibration procedure.

### 3.4 Backwards-compatibility guarantee

When the classifier is gated off (env flag `REGIME_CLASSIFIER=off` or model file missing), the pipeline behaves byte-identically to HEAD. This is the same identity-by-default pattern as PAP-1483 enforces for `extremeR` clipping. The wire-up child must verify identity-by-default on the 362-photo corpus (per-row prediction match against HEAD) before the model file ships.

---

## 4. Abstain fallback

### 4.1 Confidence threshold

`regime = abstain` when `confidence < τ_abstain`. Calibration procedure:

1. Compute per-photo `(true_regime, predicted_regime, calibrated_confidence)` triples on the held-out partition.
2. Sweep `τ_abstain ∈ [0.50, 0.95]` step 0.05; for each candidate, compute (abstain_rate, residual_error_rate) where `residual_error_rate := #{non-abstain rows with wrong regime} / 362`.
3. Choose the smallest `τ_abstain` such that `residual_error_rate ≤ ε_regime`, where `ε_regime := 0` (zero confidently-wrong regime predictions on held-out — the PAP-758 contract leaves no headroom for FP regime predictions because each one re-enables the failure mode the classifier was added to fix).
4. **Hard ceiling on abstain rate**: `abstain_rate ≤ current_PAP961_abstain_rate` measured at matched accuracy on the same held-out partition. If no `τ_abstain` satisfies both `residual_error_rate=0` AND `abstain_rate ≤ PAP-961`, the implementation child FAILS and reports back to QA for spec revision.

### 4.2 Abstain disposition

On `regime=abstain`, downstream behaviour falls back to the existing **PAP-961 aim-circle prior abstain** (`peakR < 0.65·aimR` ⇒ abstain). This is the only change to PAP-961: it consumes the classifier's `abstain` label as a *no-op* (PAP-961 runs unchanged regardless of classifier output; the classifier's `abstain` simply doesn't gate it out). Per PAP-1534 out-of-scope rule, no other change to PAP-961.

### 4.3 Why abstain is not a third learned class

Adding `abstain` as a third softmax output would: (i) require ~50–100 explicitly labelled `abstain` examples (impossible to define ground-truth — there is no "should abstain" regime in reality, only "uncertain prediction"); (ii) conflate model uncertainty with structural ambiguity. Calibrated-confidence thresholding is the standard binary-classifier abstain mechanism and lets QA tune the abstain/accuracy trade off post-hoc without re-training.

---

## 5. Success metric and AC plan for the implementation child

### 5.1 Per-class held-out accuracy

| Metric | Target (PAP-758 contract) | Held-out feasibility (per §1.4) |
|---|---|---|
| Cassette-class accuracy (held-out) | ≥99% Wilson 95% LB | Held-out cassette N = 30%·282 = 85. Wilson 95% LB at empirical 100% = 95.7%. **Cannot demonstrate >99%** without ~298 held-out cassette photos. |
| Chainring-class accuracy (held-out) | ≥99% Wilson 95% LB | Held-out chainring N = 30%·80 = 24. Wilson 95% LB at empirical 100% = 86.2%. **Cannot demonstrate >99%** without ~298 held-out chainring photos. |
| Overall pipeline accuracy on 9T–60T (post-integration) | ≥99% (PAP-758 root contract) | Inherited from above + downstream FFT path; same statistical wall. |

§1.4 reason 1 surfaces here as a binding constraint independent of model choice. The implementation child cannot satisfy §5.1 as written; either the AC must relax (smaller Wilson 95% LB, e.g. 90%) — which weakens the PAP-758 contract and must be CEO-routed — or the corpus must expand (§1 escalation).

### 5.2 Per-photo regression-cap AC (PAP-1485 v6.1 §3.4.7 parallel)

Adopt the same 6-bucket `regime_outcome` enum and per-bucket caps as PAP-1485 v6.1 B7+B8, mapped to the regime classifier setting:

| Bucket | Definition | Hard cap |
|---|---|---|
| `rescue` | HEAD = CW (wrong tooth-count) AND classifier-gated pipeline = correct | ≥0 (target ≥7, matching the PAP-861 broken-row set) |
| `regress_correct→CW` | HEAD = correct AND classifier-gated = CW (regime FP poisoned the joint-scan band) | **≤ 1** (loss-aversion — same as B8) |
| `regress_abstain→CW` | HEAD = abstain AND classifier-gated = CW | **≤ 2** (B8) |
| `regress_CW_worse_delta` | HEAD = CW(Δ_old) AND classifier-gated = CW(Δ_new) where `|Δ_new| > |Δ_old|` | **≤ 1** (B8) |
| `no_change_correct` | HEAD = correct AND classifier-gated = correct | benign |
| `no_change_CW_same_or_better` | HEAD = CW AND classifier-gated = CW or correct within ±1 | benign |

QA drops the existing PAP-1485 sweep harness in unchanged (per §3 PAP-1527 endorse-closure CSV format) with a new `regime` column and `classifier_confidence` column.

### 5.3 Abstain-rate ceiling AC

`classifier_abstain_rate ≤ PAP-961_abstain_rate_at_matched_accuracy`. Computed on held-out at the chosen `τ_abstain` per §4.1. Implementation child reports the joint (abstain_rate, accuracy) Pareto frontier so QA can verify the chosen operating point dominates HEAD.

### 5.4 Inference latency budget AC

p99 inference latency on a representative mid-range mobile device (Pixel 5a or Snapdragon 7-series equivalent) **≤ 100ms**. This leaves ≥4.9s of the 5s PAP-758 budget to the FFT path. Stretch target ≤ 50ms.

### 5.5 Model size AC

Model file (TFLite int8 quantized for Candidate A; serialized GBT for Candidate B) **≤ 500KB**. Hard limit per PAP-1534 envelope.

---

## 6. QA acceptance criteria for the implementation child

The implementation child must ship with the following evidence packet for QA cross-check before merge:

1. **Corpus state** — confirmation that the §1 label add has landed (regime + chainring_subtype in `_meta.json`), including per-class N and per-subtype N in the partition report.
2. **Held-out accuracy report** — per-class confusion matrix (cassette / chainring), per-class Wilson 95% LB at chosen `τ_abstain`, per-bucket counts from §5.2.
3. **Abstain-rate report** — empirical (abstain_rate, residual_error_rate) at the chosen `τ_abstain`; comparison curve vs HEAD PAP-961 abstain on matched corpus.
4. **Inference latency report** — p50 / p99 wall-clock per inference on the spec'd device (§5.4); cold-start vs warm; battery profile spot-check.
5. **Model size report** — file size on disk; verify ≤500KB.
6. **Identity-by-default verification** — per-row prediction match against HEAD on the 362-photo corpus when classifier is gated off (per §3.4); zero divergences.
7. **Regression-cap matrix** — PAP-1485 v6.1-shaped CSV (`debug-reports/pap1534_impl_sweep_*.csv`) with the §5.2 6-bucket enum and per-bucket caps; QA re-derives independently (per PAP-1528 independent re-derivation precedent).
8. **PAP-1483-style pre-ship gate** — verify identity-by-default at every `peakR` selection site (the two `gearCounter.js:3037` + `gearCounter.js:3393` locations from §3.1); no production delta when classifier returns `abstain`.

QA endorsement bar inherits the PAP-1525 / PAP-1527 / PAP-1528 closure precedent: independent CSV re-derivation matches AE numbers OR ENDORSE-CLOSURE on documented mismatch root-causes.

---

## 7. Out-of-scope reaffirmation

- Training the model (separate child once spec clears QA review per AC3 — but see §1.5 AC4 routing).
- Re-opening PAP-1078 / PAP-1481 / PAP-1102 / PAP-1480 / PAP-1485.
- Re-opening D1 (multi-frame), D2 (sensor prior), or D5.
- D4 (UX descope) — held in reserve as the fallback if §1 finds the corpus structurally insufficient. **§1.4 found exactly that condition; this spec routes the AC4 escalation but does not itself act on it.**
- Any change to PAP-961 beyond consuming it as the §4.2 abstain fallback.

---

## 8. Routing

- **AC1**: this doc committed at `debug-reports/pap1534_d3_regime_classifier_spec.md` and linked from PAP-1534 thread.
- **AC2**: §1–§6 answered with implementation-ready detail.
- **AC3**: PAP-1534 transitions to in_review with assignee = QA Engineer for spec cross-check. QA verdict required before any implementation child is filed.
- **AC4**: per §1.5, AE's spec-level verdict is that the corpus is structurally insufficient and the implementation child would be DOA. AE recommends QA endorse the AC4 trigger and route to CEO for D4 (UX descope) decision rather than greenlight the implementation child against the current corpus. If CEO funds corpus expansion (§1.2 + §1.4 reason 3 capture pass), §2–§6 stand as the implementation spec.

---

## 9. Open questions for QA cross-check

1. Does QA concur with the §1.4 corpus-feasibility verdict? Specifically: is Wilson 95% LB at the >99% PAP-758 contract the binding statistical bar, or is a relaxed contract (e.g. ≥95% LB) the operative one for D3?
2. Does QA accept Candidate B (classical-CV features + GBT) as the recommended v1, or push for Candidate A (small CNN)?
3. §5.2 6-bucket enum — does QA want any new buckets specific to the regime-classifier setting (e.g. `regime_correct_but_pipeline_CW` separated from `regress_correct→CW`)?
4. §4.1 zero-CW abstain calibration — is `ε_regime = 0` the right bar, or would QA tolerate ≤1 confidently-wrong regime prediction in exchange for lower abstain rate?
5. §3.3 chainring-regime radius clamp `[0.40, 0.65]·aimR` — is this provisional range acceptable as a spec placeholder, or does QA want it derived empirically before this spec clears?
