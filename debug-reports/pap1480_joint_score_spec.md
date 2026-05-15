# PAP-1480 — Joint (radius × tooth-count) chainring-regime discriminator — spec v3

**Status**: spec only — v3 folds the PAP-1487 pre-flight FAIL recovery (Option α bc-consensus carve-out) into §3.4. Routed for QA cross-check #3 via PAP-1491. No `gearCounter.js` change before QA cross-check #2 on a chosen Phase-1 cell (still gated; cross-check #3 must clear first).

**Author**: Algorithm Engineer
**Date**: 2026-05-14 (v1) / 2026-05-14 (v2 amendments) / 2026-05-15 (v3 PAP-861 carve-out)
**Successor to**: PAP-1102 (descoped 2026-05-14, see [project_PAP1102_descope.md](../mobile/__tests__/.cache/_unused) memory).

---

## v3 amendment summary (PAP-1487 pre-flight FAIL → PAP-1491 carve-out round)

PAP-1487 ran the §4.0 pre-flight on the 362-photo corpus and reported **FAIL — 7 broken PAP-861 bc-isolated rows / 19 fires (36.8%)**. All seven are XL 36–50T chainring cases where bc-consensus self-confirms (`bcTc===bcPeaks≈actual`, both ≥35) but the FFT chain collapses to inner alias (10–24); v2 abstain rule then sets `peakTc=0`, killing PAP-861's `peakTc>0 && (bcTc-peakTc)>=10` clauses. Margin is 0.001–0.018 (5/7) or floor (1/7); even sweep extremes `ε_abs=0.015 + ε_floor=0.06` rescue only 2/7. σ_R alone cannot fix it — widening the prior strengthens the inner-alias cell.

v3 adds **Option α (bc-consensus carve-out)** — the recommended path from the PAP-1487 verdict and PAP-1491 child description.

| # | Amendment | Section landed |
|---|-----------|----------------|
| **C1 (Option α)** | When `bcTc === bcPeaks && bcTc >= 30 && |bcTc - tc*| > 2` (bc-consensus self-confirms AND disagrees with joint argmax by > 2), inject `(R_bc, bcTc)` as an additional grid cell with `J_bc := S_rel(R_bc, bcTc) · P(R_bc) · γ_bc` where `R_bc := rOuter` (already exposed). If `J_bc ≥ J*` (bc cell wins after boost), commit `tc* := bcTc, R* := R_bc` instead of evaluating the abstain rule. Predicate stays `peakTc > 0` natural after substitution; preserves all 7 broken PAP-861 rows. | §3.4 (new §3.4.6) |
| **C2** | Phase-1 sweep gains `γ_bc ∈ {0.6, 0.8, 1.0}` (boost factor) — wide enough to bracket the "bc cell ≥ joint cell" tipping point at the 7 known broken rows. Adds 3× to grid → 864 → 2592 cells. Recommended: prune by AC1+AC2 elimination during sweep (no need to evaluate every cell to completion). | §3.4, §4.1 |
| **C3** | If `rOuter == 0` on a row (no radial-gradient outer signal), Option α inactive on that row — joint-scan abstain holds. Documented as a known PAP-861 carve-out limitation; rOuter is non-zero for 19/19 PAP-861 fires in PAP-1487 corpus, so empirically unreached in scope. | §3.4.6, §7 |
| **C4** | Pre-flight harness PAP-1487 re-run on v3 defaults is required before opening Phase-1 calibration child; verdict criterion: 0 broken PAP-861 rows AND ≤ existing broken count (=0) on PAP-868/885/889/1059. | §4.0, §9 |

QA Options β (skip-abstain when bc self-confirms) and γ (R-band-aware disagree-set tightening) are documented as fallbacks in §3.4.6 should QA reject Option α at cross-check #3.

---

## v2 amendment summary (carried from QA PAP-1482, comment id `9728c534-07c3-4030-8421-a837d2f1a6ca`)

QA cross-check #1 verdict was **APPROVED w/ amendments**. Six amendments land in this spec; sequencing follows.

| # | Amendment | Section landed |
|---|-----------|----------------|
| **A1** | Extend §4 grid `σ_R/aimR` to `{0.15, 0.20, 0.25, 0.30}` (4 values, was 3). Net 432 cells. | §4 |
| **A2** | AC1 cohort sizing path (b): accept n=24 (PAP-1108 baseline at HEAD `a54d24d`); revise AC1 to "≥13/24 confident-correct AND 0 new CW". Wilson 95% UB ~67% but informative. | §6 |
| **A3** | Pre-flight bypass-row guard (PAP-861/868/885/889/1059) BEFORE Phase-1 sweep; hard-exit on regression. | §4.0 (new), §9 |
| **A4** | Sweep `extreme_R_abstain ∈ {off, on}` (Q3). On = also abstain when `R* ∉ [0.50, 1.00]·aimR` AND no second candidate. | §3.4, §4 |
| **A5** | Wilson 95% UB hard-exit per PAP-1091 — descope to PAP-758 successor if best cell AC1 UB > 20% OR AC2 305-photo sweep > 0 LOSS. | §6, §9 |
| **A6** | PAP-1483 inheritance — in-place replacement satisfies path (a). Delete module-level `_aimPriorAlpha=0.85`, `_aimPriorBeta=1.20` and `setAimPriorBounds` setter when joint-scan lands; no separate revert commit needed. | §0 |
| **R5 (add)** | Joint-scan aggregate cost ≈2.5× via 2 call sites + `retryNearCenter`; confirm against PAP-555 budget after Phase-1 wall-clock. | §7 |
| **R6 (add)** | At `aimR==0` (pre-b97), prior degenerates to uniform; verify no regression on pre-b97 subset of AC2 corpus (free reporter slice — already in 305 sweep). | §7 |

QA Q1-Q4 answers folded into amendments above (Q1 → §3.2 unchanged, per-radius `S_rel` is the right normalization; Q2 → §3.3 default σ_R=0.20, swept up to 0.30 (A1); Q3 → A4; Q4 → A3).

---

## 0. Pre-ship state — 86b4458 (PAP-1100 plumbing) — per PAP-1483 (revised v2)

The local main contains two unpushed commits ahead of `origin/main`:

| SHA       | Subject                                                                 |
|-----------|-------------------------------------------------------------------------|
| `86b4458` | PAP-1100/PAP-1108: aim-circle FFT sweep-range prior — plumbing + harness scaffold |
| `a54d24d` | PAP-1108: pap1100 harness — resumable baseline + cell cache + cohort caps |

`86b4458` ships **production-default** module-level bounds `_aimPriorAlpha=0.85`, `_aimPriorBeta=1.20` (`gearCounter.js:57-58`) and activates the prior whenever `aimR > 0` (`gearCounter.js:1409`). In production `aimR = 0.5·min(W,H)` is always non-zero on aimCrop'd captures (`gearCounter.js:2777`), so the prior fires by default on every capture. PAP-1108 calibration was DESCOPED (11T Wilson UB 31.0%, XL UB 27.8% << 80% AC1), and the production-default delta vs `origin/main` was never measured.

### v2 path: A6 — in-place replacement satisfies PAP-1483 path (a)

QA's amendment A6 supersedes v1's standalone-revert plan. PAP-1480 v1 implementation (post-cross-check #2) **deletes** `_aimPriorAlpha`, `_aimPriorBeta`, and the `setAimPriorBounds()` setter as part of the same commit that introduces joint-scan. This satisfies PAP-1483 path (a) — no separate revert commit, single coherent diff.

Rationale (carried from v1 §0):

1. **Spec mismatch.** PAP-1480 uses a *soft Gaussian* prior on R (§3.3, multiplicative weight, never a hard cut), not the hard `[α·aimR, β·aimR]` window 86b4458 ships. Keeping the hard-cut plumbing alongside the soft prior creates two competing aim-circle priors on the same FFT path — the hard cut would silently veto soft-Gaussian-recoverable cells.
2. **Calibration descoped.** The (α, β) defaults in 86b4458 were "QA midpoint pending calibration" placeholders; PAP-1108 (the calibration owner) was cancelled. Shipping placeholder defaults to production violates the PAP-1085 protocol exit rule.
3. **a54d24d is moot.** The companion harness commit only adds resumable cell-caches for the PAP-1108 sweep that no longer runs. Deletion is co-landed with the joint-scan commit for tidy diff.

### Implementation order (post-cross-check #2)

1. Single commit: "PAP-1480 v2 — joint (R×tc) scoring; supersedes PAP-1100 plumbing":
   - Replaces `multiRadiusFftScan` internals (§3).
   - Deletes `_aimPriorAlpha`, `_aimPriorBeta`, `setAimPriorBounds()`.
   - Removes the `priorActive`/`priorLo`/`priorHi` derivation (gearCounter.js:1409-1411).
   - Removes the `pap1100.aim-prior.js` harness file (its successor is the PAP-1480 calibration harness).
2. PAP-961 post-hoc `peakR<0.65*aimR` abstain is **preserved verbatim** (defence-in-depth, untouched).
3. PAP-861 / PAP-868 / PAP-885 / PAP-889 / PAP-1059 bypass predicates **unchanged**. They consume `peakTc/peakRel/peakR` from the new joint-scan via the same return shape (§3.5).
4. Pre-flight bypass-row guard (§4.0, A3) MUST have been clean before this lands.

### What QA will see at PAP-1480 cross-check #2 (post-implementation)

- A net-new commit introducing PAP-1480 v2 (soft Gaussian, no hard cut, AC3 by P≡1 when aimR==0).
- `git diff origin/main..HEAD -- mobile/src/algorithm/gearCounter.js` shows ONE coherent change (joint scoring inside `multiRadiusFftScan` + removal of PAP-1100 plumbing) — no orphaned hard-cut bounds.
- PAP-961 post-hoc abstain unchanged.

---

## 1. Goal

Replace the implicit `radius → tooth-count` cascade in `multiRadiusFftScan` / `analyzeImage` with an **explicit 2-D joint scoring grid** over `(R, tc)`. Decide on the joint argmax, with an abstain rule when the top cell and its strongest competitor disagree on `tc` by more than 2.

The PAP-1078 / PAP-1092 / PAP-1102 ladder all failed because they conditioned on `peakR` first — when chainring/bolt-circle dominates the gear-region edge density, `peakR` locks onto the wrong structure and every downstream feature inherits that lock-in (QA's PAP-1098 finding).

A joint search lets the *true* cog `(R≈0.55·aimR, tc=11)` cell beat the chainring `(R≈aimR, tc=large)` cell directly, instead of being filtered out by a primary-radius gate.

---

## 2. Inputs

- `enhanced[]` — CLAHE-enhanced grayscale (same as multiRadiusFftScan input).
- `cx, cy` — gear center from `findGearCenter`.
- `aimR` — aim-circle prior radius in crop space (may be `0` for legacy <b97 corpus; AC3 requires the algorithm to work in that case).
- `width, height` — crop dims.

Pre-computed by `analyzeImage` and reused as-is:
- `gearR` (max of contour + edge-density radius).
- `bcTc`, `bcPeaks`, `bcPurity` — binary-contour cross-channel (NOT used for joint scoring; reserved for the abstain-tie-break only).

---

## 3. Predicate

### 3.1 Radius candidate grid `R_k`

- If `aimR > 0`:
  - `R_lo = floor(0.40 · aimR)`, `R_hi = floor(min(1.10 · aimR, maxR_geom))`
    where `maxR_geom = min(cx, w-cx, cy, h-cy) - 1`.
  - Step `Δ = max(2, floor((R_hi − R_lo) / 32))` → ~32 evenly-spaced radii.
- If `aimR == 0` (AC3 path):
  - `R_lo = floor(0.40 · gearR)`, `R_hi = floor(min(1.10 · gearR, maxR_geom))`.
  - Step `Δ` as above; gearR acts as a *soft* anchor only — its bias is absorbed by the geometric prior term (§3.3).
- Hard floor: `R_lo ≥ 10` (below this, ring sampling is unreliable per existing code).

Approx 32 radii. Compare to status quo `multiRadiusFftScan` which evaluates ~26 radii via density-peak + grid; cost increase **≈1.25×**.

### 3.2 Cell score `S(R_k, tc)`

Per cell, **phase-coherence** of the angular intensity signal at radius `R_k` evaluated at frequency `tc`. Use the existing `fftCountAtRadius` infrastructure (`sampleIntensityRing` → `savgolSmooth` → `fftMagnitude`), but extract the *per-tc* score rather than the `argmax_f` shortcut:

```
sample_ring(enhanced, cx, cy, R_k, N_ANGLES=1024)
centered = subtract mean of savgol-smoothed ring
mag[]    = fftMagnitude(centered)                  // length N_ANGLES/2

score(R_k, tc) = mag[tc] + 0.5·mag[2·tc] + 0.25·mag[3·tc]      // harmonic-weighted, same as fftCountAtRadius (line 552–558)
norm(R_k)     = Σ_f∈[MIN,MAX] score(R_k, f)                    // per-radius normalizer
S_rel(R_k,tc) = score(R_k, tc) / norm(R_k)                     // ∈ [0, 1], comparable across radii
```

`S_rel` ranges roughly 0.04 (background) to 0.30 (strong tooth signal) — same scale as the existing `rel` in `multiRadiusFftScan`.

QA Q1 verdict: per-radius `S_rel` is the right normalization (grid-wide z-score would suppress the legitimate chainring lobe).

### 3.3 Geometric prior `P(R_k)`

Soft Gaussian penalty around `aimR` when present:

```
σ_R = 0.20 · aimR          // wide; lets 0.55·aimR cog still be picked
P(R_k) = exp( − ((R_k − aimR)² / (2·σ_R²)) )      if aimR > 0
P(R_k) = 1                                          if aimR == 0
```

Default `σ_R = 0.20·aimR` — `R = 0.55·aimR` (true 11T-cog-on-chainring case) has `P ≈ 0.32`. v2 sweeps σ_R/aimR ∈ {0.15, 0.20, 0.25, 0.30} per A1; cap at 0.30 because above that the prior approaches uniform (Q2).

The prior is **soft** (multiplicative weight, never a hard cut). AC3 (works without aimR) is satisfied by definition since `P ≡ 1` when `aimR == 0`.

### 3.4 Joint score and decision

```
J(R_k, tc) = S_rel(R_k, tc) · P(R_k)

(R*, tc*) = argmax_{(R_k, tc)} J(R_k, tc)
J*        = J(R*, tc*)
```

Find the **strongest competitor disagreeing on tc by > 2**:

```
disagree_set = { (R_k, tc) : |tc − tc*| > 2 }
J_dis        = max J(R_k, tc) over disagree_set     (0 if empty)
```

**Decision**:

- **Commit** to `tc*` when `J* − J_dis ≥ ε_abs` AND `J* ≥ ε_floor`.
- **Abstain** (set `peakTc = 0`, `peakRel = 0`, `peakR = 0` — same shape as current `multiRadiusFftScan` abstain) otherwise.

#### v2: extreme-R abstain toggle (A4 / Q3)

Sweep with both `extreme_R_abstain ∈ {off, on}`:

- **off** — decision rule above is the only abstain.
- **on** — additional abstain fires when `R* ∉ [0.50, 1.00]·aimR` AND `disagree_set == ∅` (no second candidate to challenge an extreme-radius win). Conservative variant — guards against lone-wolf high-conf commits at extreme R when no consensus exists.

The toggle is a Phase-1 sweep dimension; Phase-2 ships only the cell QA selects.

#### v3: bc-consensus carve-out — Option α (§3.4.6)

PAP-1487 pre-flight FAILed on 7/19 PAP-861 bc-isolated rescue rows where joint-scan abstains at margins 0.001–0.018 (well below `ε_abs=0.020`). Root cause: bc-consensus self-confirms at the true outer ring while the joint argmax locks onto the inner alias, and the v2 abstain rule never consults `bcTc/bcPeaks` (reserved per §2 as "abstain-tie-break channel"). v3 corrects this by promoting bcTc to a tie-breaking grid injection when bc-consensus self-confirms.

**Algorithm (v3, runs after §3.4 joint argmax / disagree-set computation, BEFORE the commit/abstain decision):**

```
// bc-consensus self-confirmation gate
bcSelfConfirms = (bcTc === bcPeaks) && (bcTc >= 30) && (Math.abs(bcTc - tc*) > 2)

if (bcSelfConfirms && rOuter > 0):
    R_bc  = rOuter                                    // radial-gradient outer peak (already exposed on row)
    J_bc  = S_rel(R_bc, bcTc) · P(R_bc) · γ_bc        // inject bc cell with boost γ_bc

    if (J_bc >= J*):
        tc*  := bcTc
        R*   := R_bc
        J*   := J_bc
        // recompute J_dis on the disagree set wrt new tc* — anything with |tc - bcTc| > 2 is competitor
        J_dis := max J(R_k, tc) over { (R_k, tc) : |tc - bcTc| > 2 }   (0 if empty)

// Commit/abstain decision (§3.4) proceeds as usual on the (potentially substituted) (R*, tc*, J*, J_dis)
```

**Why this works on the 7 broken rows:**

- All 7 have `bcTc === bcPeaks`, both ≥ 35.
- All 7 have `rOuter ∈ [158, 181] px` (non-zero, see PAP-1487 broken-row table).
- All 7 have joint `tc*` ∈ [10, 24] (inner alias) → `|bcTc - tc*| > 11` trivially.
- Boost γ_bc gives the bc cell competitive J even when its raw `S_rel(rOuter, bcTc)` is somewhat below the inner-alias's `S_rel(R*, tc*)`.

**Why we boost rather than just inject the cell unweighted:**

Without γ_bc, the bc cell would just be one more grid cell — and joint argmax already saw `(rOuter, bcTc)` (or close to it) during the §3.2 grid scan because rOuter is in the candidate radius set when aimR is the anchor. The reason bcTc didn't win on those 7 rows is that the inner-alias cell *genuinely* has higher `S_rel · P` under the v2 prior. The boost γ_bc encodes "when bc-consensus says ≥30 and self-confirms, that's strong external evidence — give the bc cell a tiebreak weight". γ_bc < 1.0 still requires the bc cell to be *close* to J*; γ_bc = 1.0 makes any bc-self-confirmed disagreement win unconditionally.

**Phase-1 sweep dimension γ_bc ∈ {0.6, 0.8, 1.0}** picks the tipping point where bc cell wins on all 7 broken rows without sacrificing AC2.

**Carve-out limitation (C3)**: when `rOuter == 0` on a row (no radial-gradient outer-edge signal — happens on inner-only or noise-dominated frames), Option α is inactive and joint-scan abstain holds. PAP-1487 corpus shows 19/19 PAP-861 fires have `rOuter > 0`, so empirically unreached in scope. Documented as a known limitation should it surface in future corpus expansion.

**Fallback options** (documented in case QA cross-check #3 rejects Option α):

- **Option β**: skip the entire abstain rule on bc-self-confirmed rows. Strictly weaker than α (commits even when `J*` is genuinely below `ε_floor`), risks AC2 regression.
- **Option γ**: R-band-aware disagree-set — when `R*<0.75·aimR` (inner regime) AND `R_dis>0.85·aimR` (outer regime), prefer the outer cell unconditionally. Encodes the "true cog is outer" prior physically; may conflict with PAP-961 (which abstains when peakR<0.65·aimR).

#### Parameter defaults (to be calibrated by Phase-1 sweep)

| Parameter   | v1 default | v2 grid (Phase-1)                   | Rationale                                                                                            |
|-------------|------------|--------------------------------------|------------------------------------------------------------------------------------------------------|
| `ε_abs`     | 0.02       | {0.015, 0.020, 0.025, 0.030}        | One harmonic bin's worth of `S_rel`; smaller margins are noise-equivalent.|
| `ε_floor`   | 0.08       | {0.06, 0.08, 0.10}                  | Below this, no radius has a coherent ring signal — abstain regardless.|
| `σ_R/aimR`  | 0.20       | **{0.15, 0.20, 0.25, 0.30}** (A1)   | See §3.3.                                                                                            |
| `R_lo/aimR` | 0.40       | {0.35, 0.40, 0.45}                  | Lower bound on cog candidates. 0.40 covers 11T-on-50T chainring case.                                 |
| `R_hi/aimR` | 1.10       | {1.05, 1.10, 1.15}                  | Upper bound. 1.10 is current PAP-1100 ceiling.                                                       |
| `extreme_R_abstain` | off | {off, on} (A4)                       | See above (Q3 / A4).                                                                                 |
| `γ_bc`      | 0.8        | **{0.6, 0.8, 1.0}** (C2)             | v3 bc-cell boost factor (§3.4.6). 0.6 = bc cell must clearly win raw, 1.0 = any bc-self-confirmed disagreement wins. |

### 3.5 Integration point

Replace the **internal logic** of `multiRadiusFftScan` (gearCounter.js:1407–1521) only. Its **return shape** stays identical: `{ peakTc, peakRel, peakR, candResults }`. All call sites (analyzeImage:2048, retryNearCenter — same signature) are unchanged. `peakRel ← J*`; `peakR ← R*`; `peakTc ← tc*` or `0` on abstain.

This isolates the change inside one function and preserves PAP-961 / PAP-815 / PAP-861 / PAP-885 / PAP-889 / PAP-1059 downstream rules verbatim. The chainring/bolt-bypass and AC1-rescue gates added by those tickets continue to operate on the same field names.

The PAP-1100 plumbing (`_aimPriorAlpha`, `_aimPriorBeta`, `priorActive`, `setAimPriorBounds`) is removed in the same commit (A6).

---

## 4. Parameter grid (Phase-1 sweep) — v2 amended

### 4.0 Pre-flight bypass-row guard (A3) — runs BEFORE Phase-1

A simulator harness (`mobile/__tests__/pap1480.preflight.js`, filed as PAP-1485 child) computes joint-scan output for every row currently rescued by PAP-861/868/885/889/1059 bypass predicates, using the **default** parameters (`σ_R/aimR=0.20`, `ε_abs=0.020`, `ε_floor=0.08`, R-band `[0.40, 1.10]·aimR`, `extreme_R_abstain=off`).

**Rows in scope** (sourced from the most recent corpus run + each ticket's bypass predicate):

- PAP-861: `methodUsed === 'bc-consensus' && bcTc>=30 && bcPeaks>=30 && peakTc>0 && fft90tc>0 && opTc>0 && (bcTc-peakTc)>=10 && (bcTc-fft90tc)>=10 && (bcTc-opTc)>=10` (bc-isolated abstain).
- PAP-868 Option A: `peakTc===MIN_TEETH(=10) && fft90tc>=30 && gearR>0.30·minDim && contourR>0.20·minDim` (fft90-XL-rescue).
- PAP-868 Option E: same predicate, outer abstain bypass.
- PAP-885: `peakTc/fft90tc/opTc/bcTc/bcPeaks all >=30 AND max-min<=1` (fiveWayChainringAgree).
- PAP-889: conf<0.40 secondary gate (predicate copied verbatim from gearCounter.js current state).
- PAP-1059: `tc>=30 && ((peakTc===tc && (bcTc>=30 || opTc===tc)) || (bcTc===tc && |bcPeaks-bcTc|<=1))` (chainringTcConfirmed).

**Hard-exit rule (A3)**: if any bypass row in scope would have `peakTc = 0` (joint-scan abstain) or `peakTc != predicate-required tc` (joint-scan commits to wrong tc breaking the predicate's tc-equality clauses), **revise the predicate before sweeping**. Each broken bypass row is reported with: stamp, actual tc, current peakTc, simulated joint-scan (R*, tc*, J*), which bypass predicate breaks.

**v2 pre-flight result (PAP-1487)**: FAIL — 7 broken PAP-861 bc-isolated rows, 0 broken on the other four predicates (PAP-868 / PAP-885 / PAP-889 / PAP-1059 all clean).

**v3 pre-flight (C4) — required re-run before Phase-1**:

After spec v3 lands, re-run `mobile/__tests__/pap1480.preflight.js` with Option α (§3.4.6) wired into the inline simulator. Verdict criterion:

- 0 broken PAP-861 rows (Option α MUST close the 7 v2-broken rows).
- 0 broken on PAP-868 / PAP-885 / PAP-889 / PAP-1059 (Option α MUST NOT introduce new breakage on previously-clean predicates).
- γ_bc default for the re-run: **0.8** (mid of {0.6, 0.8, 1.0}).

If v3 pre-flight reports any broken row, file v4 round (likely fall back to Option β or γ).

If v3 pre-flight is clean (0 broken bypass rows across all five predicates), proceed to §4.1 Phase-1 sweep.

### 4.1 Phase-1 sweep grid (A1 amended)

| Param        | Grid                                | # values |
|--------------|-------------------------------------|---------:|
| `R_lo/aimR`  | {0.35, 0.40, 0.45}                  | 3 |
| `R_hi/aimR`  | {1.05, 1.10, 1.15}                  | 3 |
| `σ_R/aimR`   | **{0.15, 0.20, 0.25, 0.30}** (A1)  | 4 |
| `ε_abs`      | {0.015, 0.020, 0.025, 0.030}        | 4 |
| `ε_floor`    | {0.06, 0.08, 0.10}                  | 3 |
| `extreme_R_abstain` | {off, on} (A4)               | 2 |
| `γ_bc` (v3, C2)     | {0.6, 0.8, 1.0}              | 3 |

Total **3·3·4·4·3·2·3 = 2592** cells. (v1: 324 → +A1 σ_R: 432 → +A4 extreme_R: 864 → +C2 γ_bc: 2592.) Recommended Phase-1 strategy: AC2-eliminate-first — reject any cell with > 0 LOSS on PAP-760/796/939/1052 corpus before scoring AC1, which prunes the dominant cost. Cell-cache + resumable design (lifted from `pap1100.aim-prior.js`) makes the sweep tractable.

Each cell evaluates the current 305-photo corpus (PAP-760 / PAP-796 / PAP-939 / PAP-1052 union) plus the AC1 cohort (n=24, A2 — see §6).

---

## 5. Cost estimate (per photo, vs status quo)

`multiRadiusFftScan` today:
- ~26 radii × (1 ring sample @ N_ANGLES=1024 + 1 savgol + 1 FFT-1024) per call site.
- Per radius ≈ 1024 (ring) + 1024 (savgol, halfWin≈11) + 5120 (FFT N log N) ≈ 7.2 K mul-adds.
- Total ≈ **187 K mul-adds**, called from `analyzeImage` and `retryNearCenter` (2 call sites).

New joint scan:
- 32 radii (vs 26) × *same* per-radius FFT cost. The `score(R,tc)` extraction is *free* — we already compute `mag[]` and read every bin in the existing `bestF` loop (line 552–558).
- The only new cost is the per-cell normalization (`Σ score`, line 556 — already there) and the prior multiplication (32 ops). The disagree-set scan is O(32 · MAX_TEETH) = ~2 K comparisons (negligible).
- Joint-argmax scan: 32 · 56 ≈ 1.8 K comparisons (negligible).

**Net per-call cost ≈ 1.25× existing `multiRadiusFftScan`**, dominated by the 32-vs-26 radius bump. Wall-clock impact on PAP-755 budget: estimated **+30–50 ms** per analyze (out of current ~6–8 s end-to-end), comfortably below the PAP-555 <10 s envelope.

Two call sites doubles this; still well within budget. No new sampling primitive, no new FFT length, no morph/edge-detect pass.

---

## 6. Acceptance criteria — v2 (A2 + A5 amended)

- **AC1 (revised per A2)**: 11T cluster on PAP-1108 baseline cohort (n=24, sourced at HEAD `a54d24d` per QA verdict). Pass = **≥13/24 confident-correct AND 0 new confident-wrong**. Wilson 95% UB ~67% — informative under the AC1 cohort QA accepts as the practical baseline.
- **AC2**: Zero new LOSS on PAP-760 / PAP-796 / PAP-939 / PAP-1052 305-photo sweep.
- **AC3**: Functions when `aimCrop` (hence `aimR`) is absent — soft prior degenerates to uniform (`P ≡ 1`).
- **AC4 (new — A5 hard-exit)**: per PAP-1091 protocol, if the best Phase-1 cell yields AC1 Wilson 95% **UB > 20%** (≥80% chance the underlying recovery rate is below the AC1 floor) **OR** AC2 305-sweep > 0 LOSS, **descope** PAP-1480 and file a successor under PAP-758. Do not iterate parameters past the chosen cell without a new spec round.

---

## 7. Risks and out-of-scope guardrails

- **Risk: 11T cluster `peakR` data is missing today** (only 2/11 produce non-zero `peakR`). If the underlying ring signal genuinely lacks a coherent 11T harmonic at *any* radius in `[0.40, 1.10]·aimR`, joint scoring cannot rescue it either — it will abstain, which is still better than confident-wrong on AC1 metric.
- **Risk: false abstains on XL 42T**. The PAP-861 / PAP-868 / PAP-885 / PAP-889 / PAP-1059 ladder's bypasses operate on `peakTc`/`fft90tc` agreement post-scan. If joint scoring abstains, those bypasses become inoperative on that row. **Mitigation: §4.0 pre-flight (A3) — hard-exit if any bypass row breaks**.
- **v3 risk: Option α boost γ_bc may regress AC2** if a true small-cog row has `bcTc===bcPeaks≥30` from a misdetected outer ring. Empirically PAP-1487 corpus has 19 PAP-861 fires of which 7 are the broken set; the other 12 currently pass joint-scan and are a control. Phase-1 sweep over `γ_bc ∈ {0.6, 0.8, 1.0}` is the AC2 guard — any cell with γ_bc that introduces AC2 LOSS is rejected per the AC2-eliminate-first strategy (§4.1).
- **v3 carve-out limitation (C3)**: rows with `rOuter == 0` cannot benefit from Option α. PAP-1487 shows 19/19 PAP-861 fires have rOuter > 0; future corpus expansion may surface rows where this fails. Documented; no current mitigation needed.
- **R5 (PAP-1486 add): joint-scan aggregate cost ≈ 2.5× via 2 call sites + `retryNearCenter`**. Per-call cost is ≈1.25× per §5; multi-call amplifier pushes aggregate against the PAP-555 wall-clock budget. **Action: AE confirms against the PAP-555 budget once Phase-1 produces wall-clock numbers; not a blocker for the spec.** Deferred to Phase-1 measurement.
- **R6 (PAP-1486 add): AC3 corpus (`aimR==0`, pre-b97) — soft prior degenerates to uniform**. Per §3.1, when `aimR` is absent the prior falls back to `gearR` as soft anchor and effectively degenerates to a uniform `P(R_k)`. Pre-b97 photos in the AC2 sweep test exactly this regime. **Action: explicitly verify on the pre-b97 corpus subset that joint-scan doesn't regress those photos; add as a Phase-1 reporter slice (no extra sweep cost — already part of AC2 305-photo corpus).**
- **Out-of-scope** (per issue):
  - No FFT-magnitude-at-peakR resurrection (PAP-1078 ladder).
  - No aim-circle-prior expansions beyond the soft Gaussian here (PAP-961 + PAP-1100 stay as-is at code level until §0 deletion).
  - No new geometry / new ring-sampling primitive.

---

## 8. Open questions (closed by QA cross-check #1)

1. (Q1) Per-radius `S_rel` normalization → **APPROVED** as-is.
2. (Q2) `σ_R = 0.20·aimR` width → **APPROVED** as default; v2 sweeps {0.15, 0.20, 0.25, 0.30} (A1).
3. (Q3) Extreme-R abstain → **A4** added; sweep with both off and on.
4. (Q4) Pre-flight bypass-row check → **A3** added; hard-exit BEFORE Phase-1.

---

## 9. Sequencing (v3)

1. **DONE (v2, ae28d85)**: Update `pap1480_joint_score_spec.md` → v2.
2. **DONE (PAP-1487, 2bd05d5)**: Run pre-flight bypass-row guard (§4.0, A3) → **FAIL verdict** (7 broken PAP-861 rows). Reports at `debug-reports/pap1485_preflight_2026-05-15.{log,json}`.
3. **THIS REVISION (v3, PAP-1491)**: Fold Option α (bc-consensus carve-out) into §3.4.6 → **route to QA cross-check #3**.
4. **NEXT (gated on QA #3 APPROVED)**: Re-run PAP-1487 harness with Option α wired (γ_bc=0.8 default). Verdict criterion = 0 broken across all five predicates. If FAIL → v4 (likely Option β/γ).
5. **THEN (gated on v3 PAP-1487 PASS)**: Open **Phase-1 calibration child** under PAP-1480 (2592-cell sweep with AC2-eliminate-first pruning, on union corpus + AC1 n=24 cohort). Cell-cache + resumable design lifted from `pap1100.aim-prior.js` minus the PAP-1100-specific bounds plumbing.
6. Pick best cell maximizing AC1-pass while preserving 305-photo AC2 (0 LOSS). Apply A5 hard-exit if best cell fails AC4.
7. **QA cross-check #2** on the chosen cell + parameter values + Phase-1 corpus diff. No `gearCounter.js` edit before this signoff.
6. PAP-1480 v2 implementation lands as the single coherent commit described in §0 (joint-scan + PAP-1100 plumbing deletion in one diff).
7. QA full sweep + signoff post-implementation → build subtask filed by QA.
