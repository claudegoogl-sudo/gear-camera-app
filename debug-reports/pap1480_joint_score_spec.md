# PAP-1480 — Joint (radius × tooth-count) chainring-regime discriminator — spec v5

**Status**: spec only — v5 folds QA cross-check #4 amendments B3' (J_dis_new / commit_margin instrumentation), B4 (AC2 pre-flight pass), and B5 (γ_bc=2.5 sentinel). v4's B1 (gate tolerance ≤2) and B2 (γ_bc upward grid) carry forward APPROVED. Routed for QA cross-check #5 via PAP-1491 (new child). No `gearCounter.js` change before QA cross-check #2 on a chosen Phase-1 cell (still gated; cross-check #5 must clear first, then v5 PAP-1487 re-run PASS, then Phase-1 cell choice).

**Author**: Algorithm Engineer
**Date**: 2026-05-14 (v1) / 2026-05-14 (v2 amendments) / 2026-05-15 (v3 PAP-861 carve-out) / 2026-05-15 (v4 QA #3 amendments B1+B2+B3) / 2026-05-15 (v5 QA #4 amendments B3'+B4+B5)
**Successor to**: PAP-1102 (descoped 2026-05-14, see [project_PAP1102_descope.md](../mobile/__tests__/.cache/_unused) memory).

---

## v5 amendment summary (QA cross-check #4 verdict APPROVED-W-AMENDMENTS → PAP-1491 v5 round)

QA cross-check #4 on PAP-1494 returned **APPROVED-W-AMENDMENTS** with three findings (B3' advisory-but-diagnostic-critical, B4 blocking, B5 blocking). v4 B1+B2 carry forward APPROVED; v5 folds B3'/B4/B5 only.

| # | Amendment | Section landed |
|---|-----------|----------------|
| **B3'** (advisory, diagnostic-critical) | v4 B3 harness columns (`J_bc_raw`, `J_star_v4`, `gamma_eff`, `subst_fired`, `gate_passed`) leave the commit-criterion side opaque. Of §3.4.6's three failure modes — (1) gate didn't fire (covered by `gate_passed`); (2) `J_bc_raw` too far below J* (covered by `gamma_eff > 2.0`); (3) `J_dis_new` disqualifies commit (UNCOVERED) — only modes 1+2 are observable. v5 adds two columns: `J_dis_new` (max J over disagree-set after bc-substitution, recomputed from §3.4.6 algorithm's `J_dis := max J over {(R_k,tc):\|tc-bcTc\|>2}` line) and `commit_margin := J_star_v4 - J_dis_new`. Compare `commit_margin` against the swept `ε_abs` to verify commit fires. Diagnostic-critical rows pre-identified: 05-01_48T (margin ≈0.0012) and 05-04_42T (margin ≈0.0011) — both within sub-ε_abs band even after a successful boost. | §4.0 v5 pre-flight harness; §3.4.6 prose |
| **B4** (BLOCKING) | v3 grid `{0.6, 0.8, 1.0}` was algebraically inert (no substitution would fire per §3.4.6 B2 algebra). v4's `{1.0, 1.3, 1.6, 2.0}` is the **first** grid that introduces non-trivial substitution-FP risk on the 305-photo AC2 corpus, but the v4 §4.0 pre-flight ran only on the 19 PAP-861 fire rows. Phase-1 sweep AC2-eliminate-first pruning surfaces AC2 risk *after* AE invests Phase-1 cost. v5 extends §4.0 v5 pre-flight to **also** evaluate the 305-photo AC2 corpus (PAP-760 / PAP-796 / PAP-939 / PAP-1052 union — identical to the AC2 sweep set in §6) at γ_bc ∈ {1.0, 1.3, 1.6, 2.0, 2.5} and report rows where `gate_passed && subst_fired` at any value. Verdict criterion: **AC2 substitution-FP count ≤ 2 at γ_bc=1.3 default**. If AC2-FP > 2 at γ_bc=1.3, surface as Phase-1 risk and the default lowers (γ_bc=1.0 or v5+ Option β/γ). Cost: ~305 simulator passes — reuses the existing PAP-861/868/885/889/1059 corpus scan engine. | §4.0 v5 pre-flight section (new AC2 corpus pass); §7 risks (re-cast) |
| **B5** (BLOCKING) | v4 grid tops out at γ_bc=2.0. If `gamma_eff > 2.0` for any of the 7 v2-broken rows, v4 escalates directly to Option β (skip-abstain on bc-self-confirmed) — but Option β is acknowledged in §3.4.6 as "strictly weaker than α" with broader AC2 risk. A γ_bc=2.5 sentinel inside Option α provides a cheap intermediate step before escalating to a strictly-weaker fallback. AE chooses path **(b)** — pre-flight-only sentinel on the 7 v2-broken rows + 305-photo AC2 corpus, no Phase-1 cost increase. Phase-1 grid stays at 3456 cells (γ_bc ∈ {1.0, 1.3, 1.6, 2.0}); sentinel γ_bc=2.5 is purely diagnostic and lives in the pre-flight harness only. Verdict criterion: **PASS if all 7 v2-broken rows commit at γ_bc ≤ 2.5 AND AC2-FP ≤ 2 at the same γ_bc** ; FAIL → escalate to v6+ (Option β/γ). | §4.0 v5 pre-flight section; §3.4.6 prose; rationale in §3.4 param table footnote |

Default γ_bc for the v5 pre-flight stays at **1.3** (mid-low of {1.0, 1.3, 1.6, 2.0}, unchanged from v4).

Path-(b) rationale: path (a) grid extension {1.0, 1.3, 1.6, 2.0, 2.5} bloats Phase-1 from 3456 → 4320 cells (+25%) for one diagnostic cell. The 2.5 sentinel is not intended as a default-shippable value — if a Phase-1 cell selects γ_bc=2.5, AE re-routes to QA as an explicit v5+ amendment. Keeping 2.5 sentinel-only preserves Phase-1 cost while still gating fallback escalation through cheap evidence.

QA #4 confirmation on v4 Q1 (B1 gate tolerance), Q2 (B2 algebra), Q5 (gamma_eff > 2.0 FAIL criterion — now revised: > 2.5 is the new FAIL line per B5), Q6 (grid math 3456 unchanged at Phase-1) stands. Q3 (B3 column completeness) addressed by B3'; Q4 (AC2 risk surface) addressed by B4.

---

## v4 amendment summary (QA cross-check #3 verdict REJECTED-FOR-AMENDMENTS → PAP-1491 v4 round)

QA cross-check #3 on PAP-1492 (comment authored 2026-05-15T01:17:52Z) returned **REJECTED-FOR-AMENDMENTS** with three findings (B1 blocking, B2 blocking, B3 advisory). Two algebraic flaws in the v3 Option α formulation would make the §4.0 C4 re-run guaranteed to FAIL; v4 corrects them.

| # | Amendment | Section landed |
|---|-----------|----------------|
| **B1** (BLOCKING) | Replace strict `bcTc === bcPeaks` gate with `Math.abs(bcTc - bcPeaks) <= 2`. v3 prose claimed all 7 broken rows pass strict equality; QA's pre-flight data shows only 3/7 do — the remaining 4 have \|Δ\| ∈ {1, 2} (rows 36T `bcTc=37,bcPk=35`; 48T `bcTc=49,bcPk=48`; 47T `bcTc=47,bcPk=48`; 42T `bcTc=43,bcPk=41`). Tolerance `≤2` matches three in-tree precedents (`strongConsensusBypass` gearCounter.js:2093 uses `≤2`; PAP-396-era abstain at line 2258 uses `>3`; PAP-861 bc-isolated predicate requires no equality at all). Strict `===` was inherited verbatim from PAP-792 `bcStrongAgree` which has separate purpose (5-way isolated commit) and tighter `|bcTc-peakTc|>5` sanity margin. | §3.4.6 algorithm; §3.4.6 broken-row table |
| **B2** (BLOCKING) | γ_bc grid `{0.6, 0.8, 1.0}` is algebraically inert. `rOuter ∈ [158, 181]px` and `aimR ∈ [290, 330]px` on the 7 broken rows → `rOuter/aimR ≈ 0.55`, inside the joint grid `[0.40, 1.10]·aimR`. Grid spacing `Δ_R = (R_hi-R_lo)/32 ≈ 0.022·aimR ≈ 6.5px` for aimR≈300px places the nearest grid radius within ±3.25px of rOuter, so `S_rel(R_grid_near, bcTc) ≈ S_rel(rOuter, bcTc)`. Therefore `J_bc(γ_bc=1.0) ≈ J(grid_cell_at_rOuter, bcTc) ≤ J*` **by definition of joint argmax** — at most a tie at γ_bc=1.0, strictly below for γ_bc<1.0. To trigger substitution requires γ_bc > 1.0; to commit (clear J_dis_new + ε_abs) requires γ_bc ≈ 1.3–2.0 given typical J* ≈ 0.07–0.10 and raw `S_rel·P` at rOuter typically ≤ J*. v4 replaces the grid with `{1.0, 1.3, 1.6, 2.0}` (4 values; total grid 2592 → **3456 cells**). The 1.0 floor anchors a tie-wins control cell; upward extension provides the head-room required for substitution. The v3 prose claim "γ_bc = 1.0 makes any bc-self-confirmed disagreement win unconditionally" is removed (inverted algebra). | §3.4.6 prose; §3.4 param table; §4.1 sweep grid |
| **B3** (advisory) | Pre-flight harness must report `J_bc_raw := S_rel(rOuter, bcTc) · P(rOuter)` (pre-boost) per row alongside `J*` and `J_dis`. Without this column no future verdict can verify γ_bc head-room or distinguish "boost insufficient" from "gate didn't fire". | §4.0 v3 → v4 pre-flight requirements |

Default γ_bc for the C4 re-run shifts from 0.8 to **1.3** (mid of new grid).

QA confirmation on v3 Q1/Q3/Q5/Q6 stands (algebra placement, C3 rOuter==0 carve-out, grid math correctness, sequencing); Q2 (γ_bc range) and Q4 (AC2 risk surface) revisit after B2 lands.

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

**Algorithm (v4, runs after §3.4 joint argmax / disagree-set computation, BEFORE the commit/abstain decision):**

```
// bc-consensus self-confirmation gate (v4: B1 tolerance, was strict === in v3)
bcSelfConfirms = (Math.abs(bcTc - bcPeaks) <= 2) && (bcTc >= 30) && (Math.abs(bcTc - tc*) > 2)

if (bcSelfConfirms && rOuter > 0):
    R_bc     = rOuter                                    // radial-gradient outer peak (already exposed on row)
    J_bc_raw = S_rel(R_bc, bcTc) · P(R_bc)               // pre-boost (instrumented per B3 in harness)
    J_bc     = J_bc_raw · γ_bc                           // inject bc cell with boost γ_bc (γ_bc > 1.0 expected, see B2)

    if (J_bc >= J*):
        tc*  := bcTc
        R*   := R_bc
        J*   := J_bc
        // recompute J_dis on the disagree set wrt new tc* — anything with |tc - bcTc| > 2 is competitor
        J_dis := max J(R_k, tc) over { (R_k, tc) : |tc - bcTc| > 2 }   (0 if empty)

// Commit/abstain decision (§3.4) proceeds as usual on the (potentially substituted) (R*, tc*, J*, J_dis)
```

**Why this works on the 7 broken rows (v4 — B1 corrected table):**

| stamp                          | actual tc | bcTc | bcPk | \|Δ\| | strict `===` (v3 gate) | `≤2` (v4 gate) |
|--------------------------------|-----------|------|------|------|------------------------|----------------|
| 2026-04-25_08-45-07-271Z       | 36T       |   37 |   35 |   2  | ✗                      | ✓              |
| 2026-04-30_12-31-00-766Z       | 50T       |   50 |   50 |   0  | ✓                      | ✓              |
| 2026-05-01_08-28-38-224Z       | 50T       |   50 |   50 |   0  | ✓                      | ✓              |
| 2026-05-01_09-04-04-917Z       | 48T       |   49 |   48 |   1  | ✗                      | ✓              |
| 2026-05-01_15-00-55-239Z       | 48T       |   48 |   48 |   0  | ✓                      | ✓              |
| 2026-05-01_15-04-02-875Z       | 47T       |   47 |   48 |   1  | ✗                      | ✓              |
| 2026-05-04_11-33-56-211Z       | 42T       |   43 |   41 |   2  | ✗                      | ✓              |

v3 strict `===` catches **3/7**; v4 `|Δ| ≤ 2` catches **7/7**. All 7 also satisfy `bcTc ≥ 30` (range [37, 50]) and `rOuter > 0` (range [158, 181]px). Joint `tc*` for all 7 ∈ [10, 24] → `|bcTc - tc*| > 11` trivially.

The `≤2` tolerance is justified by three in-tree precedents (see v4 amendment B1 above): `strongConsensusBypass` (gearCounter.js:2093), PAP-396-era abstain at line 2258 (`>3` is the *abstain* threshold, so `≤3` is treated as consensus elsewhere), and PAP-861's own bc-isolated predicate (no equality required, only `bcTc≥30 && bcPeaks≥30`). Setting the tolerance at `≤2` (rather than `≤3`) keeps a margin from PAP-396's abstain threshold and matches the canonical strongConsensus rule.

**Why a multiplicative boost γ_bc > 1.0 is required (v4 — B2 corrected algebra):**

`rOuter ≈ 0.55·aimR` falls inside the §3.2 joint grid (`R ∈ [0.40, 1.10]·aimR`). Grid spacing `Δ_R = (R_hi - R_lo)/32 ≈ 0.022·aimR ≈ 6.5px` for aimR≈300px → the nearest grid radius is within ±3.25px of rOuter. Because `S_rel` is computed from a savgol-smoothed ring signal whose support is much wider than 6.5px, `S_rel(R_grid_near, bcTc) ≈ S_rel(rOuter, bcTc)` to within sub-bin noise (well below ε_abs).

Therefore:
```
J_bc_raw = S_rel(rOuter, bcTc) · P(rOuter)
        ≈ J(R_grid_near, bcTc)
        ≤ J*                  (by definition of joint argmax over the §3.2 grid)
```

A boost γ_bc ≤ 1.0 cannot trigger substitution (at best ties); γ_bc > 1.0 is required. The v3 prose's claim "γ_bc = 1.0 makes any bc-self-confirmed disagreement win unconditionally" inverts the algebra and is withdrawn.

**Magnitude target**: empirical `J* ≈ 0.07–0.10` on broken rows; substitution + commit requires `J_bc ≥ J_dis_new + ε_abs ≈ J* + ε_abs ≈ 0.09–0.12`. If `J_bc_raw ≈ 0.5·J*` (a conservative head-room assumption pending B3 instrumentation), then γ_bc ∈ [1.8, 2.4] commits all 7 rows; tighter head-room (J_bc_raw close to J*) commits at γ_bc ≈ 1.0–1.3. Until B3 prints per-row `J_bc_raw`, the grid brackets both regimes.

**Phase-1 sweep dimension γ_bc ∈ {1.0, 1.3, 1.6, 2.0}** (v4) — `1.0` anchors a tie-wins control cell (verifies substitution geometry in the absence of head-room), and the upward tail covers the worst-case head-room. The 7 broken rows must commit at some γ_bc in this range; if none does, B3/B3' instrumentation pinpoints whether the failure is "gate doesn't fire" (B1 regression, via `gate_passed`), "J_bc_raw too far below J*" (need γ_bc > 2.0, surfaced by `gamma_eff`), or "J_dis_new disqualifies commit" (Option γ regime, surfaced by `commit_margin := J_star_v4 - J_dis_new` falling below ε_abs — see B3' instrumentation in §4.0 v5).

**v5 sentinel γ_bc=2.5 (B5, pre-flight-only)** — before escalating to Option β (strictly weaker than α per §3.4.6 fallbacks), the v5 pre-flight harness evaluates γ_bc=2.5 as a sentinel cell on (i) the 7 v2-broken PAP-861 rows and (ii) the 305-photo AC2 corpus (B4). The sentinel does NOT enter the Phase-1 sweep grid (Phase-1 stays at 3456 cells). If any of the 7 broken rows requires γ_bc > 2.5 to commit, OR if AC2 substitution-FP count > 2 at any γ_bc ≤ 2.5, v5 fails and AE drafts v6+ (Option β/γ).

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
| `γ_bc`      | 1.3        | **{1.0, 1.3, 1.6, 2.0}** (v4 B2); v5 sentinel `2.5` pre-flight-only | bc-cell boost factor (§3.4.6). Floor `1.0` = tie-wins control (substitution geometry sanity). Upward extension required because rOuter sits inside §3.2 grid → raw `J_bc ≤ J*` by argmax; γ_bc > 1.0 needed to substitute (B2). v5 (B5): γ_bc=2.5 sentinel runs in pre-flight only (path b) to gate Option β escalation; Phase-1 grid unchanged. |

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

**v5 pre-flight (C4 + B3 + B3' + B4 + B5) — required re-run before Phase-1**:

After spec v5 lands (and QA cross-check #5 APPROVED), re-run `mobile/__tests__/pap1480.preflight.js` with Option α v5 (§3.4.6, B1 gate `|bcTc-bcPeaks|≤2`, B2 γ_bc grid, B3' commit-margin instrumentation) wired into the inline simulator. The harness performs **two corpus passes**:

**Pass A — bypass-row guard (v4 carry-forward)**: evaluates the 19+ rows currently rescued by PAP-861/868/885/889/1059 predicates. Verdict criterion:

- 0 broken PAP-861 rows (Option α MUST close all 7 v2-broken rows; v4's `|Δ|≤2` gate catches 7/7 — see §3.4.6 table).
- 0 broken on PAP-868 / PAP-885 / PAP-889 / PAP-1059 (Option α MUST NOT introduce new breakage on previously-clean predicates).
- γ_bc default for the re-run: **1.3** (mid-low of {1.0, 1.3, 1.6, 2.0}).
- `gamma_eff ≤ 2.5` for all 7 historically-broken rows (B5 sentinel ceiling; v4's `≤ 2.0` was the prior bound).

**Pass B — AC2 substitution-FP surface (v5 B4, new)**: evaluates the 305-photo AC2 corpus (PAP-760 / PAP-796 / PAP-939 / PAP-1052 union, identical to §6 AC2 set) sweeping γ_bc ∈ {1.0, 1.3, 1.6, 2.0, **2.5 (B5 sentinel)**}. Report all rows where `gate_passed && subst_fired` at any γ_bc value. Verdict criterion:

- **AC2 substitution-FP count ≤ 2 at γ_bc=1.3** (default). If > 2 at default, surface as Phase-1 risk and lower the recommended default in v5 prose (γ_bc=1.0 if AC2 clean there, else escalate to v6+ Option β/γ).
- AC2 substitution-FP count ≤ 2 at γ_bc=2.5 sentinel (B5). If > 2 even at sentinel ceiling, Option α has insufficient AC2 head-room → escalate to v6+.

Cost: ~305 simulator passes — reuses the PAP-861/868/885/889/1059 corpus scan engine.

**B3 + B3' instrumentation requirement (v5)**: harness output must include the following columns per row, in addition to the existing v2 fields:

| Column           | Definition                                                          | Purpose                                                                              |
|------------------|---------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| `J_bc_raw`       | `S_rel(rOuter, bcTc) · P(rOuter)` (pre-boost)                       | (B3) Verifies γ_bc head-room (B2). Should be ≤ J* in argmax regime.                  |
| `J_star_v4`      | `max J` over (§3.2 grid ∪ injected bc cell after boost)             | (B3) Post-substitution argmax; differs from v2 `J*` iff bc cell wins.                |
| `gamma_eff`      | smallest γ_bc ∈ grid at which `J_bc ≥ J*` for this row              | (B3) Per-row substitution threshold — drives γ_bc grid tightening.                   |
| `subst_fired`    | bool: did Option α substitute on this row?                          | (B3) Distinguishes "gate didn't fire" from "boost insufficient".                     |
| `gate_passed`    | bool: did `bcSelfConfirms && rOuter>0` hold?                        | (B3) Isolates B1 regression risk independent of boost magnitude.                     |
| `J_dis_new`      | **(B3', new)** `max J` over `{(R_k, tc) : \|tc - bcTc\| > 2}` *after* bc-substitution | Surfaces failure mode 3 (commit-criterion side). Without this, "J_dis_new disqualifies commit" is opaque. |
| `commit_margin`  | **(B3', new)** `J_star_v4 - J_dis_new`                              | Compare against swept `ε_abs` to verify commit fires. Diagnostic-critical rows have margin ≈0.001 (05-01_48T: 0.0012; 05-04_42T: 0.0011). |

For each row, the harness sweeps γ_bc ∈ {1.0, 1.3, 1.6, 2.0, **2.5 sentinel**} and reports `subst_fired` and the smallest grid value that closes the row (`gamma_eff`). If `gamma_eff > 2.5` for any of the 7 v2-broken rows, the verdict is FAIL → escalate to v6 (Option β fallback per §3.4.6).

**v5 PASS criterion (combined)**: Pass A 0 broken across all five predicates AND `gamma_eff ≤ 2.5` for all 7 v2-broken rows AND Pass B AC2 substitution-FP ≤ 2 at γ_bc=1.3.

If v5 pre-flight reports any failure on the above, file v6 round (do NOT proceed to Phase-1).

If v5 pre-flight PASSes, proceed to §4.1 Phase-1 sweep (Phase-1 grid stays at 3456 cells; sentinel γ_bc=2.5 does NOT enter Phase-1).

### 4.1 Phase-1 sweep grid (A1 amended)

| Param        | Grid                                | # values |
|--------------|-------------------------------------|---------:|
| `R_lo/aimR`  | {0.35, 0.40, 0.45}                  | 3 |
| `R_hi/aimR`  | {1.05, 1.10, 1.15}                  | 3 |
| `σ_R/aimR`   | **{0.15, 0.20, 0.25, 0.30}** (A1)  | 4 |
| `ε_abs`      | {0.015, 0.020, 0.025, 0.030}        | 4 |
| `ε_floor`    | {0.06, 0.08, 0.10}                  | 3 |
| `extreme_R_abstain` | {off, on} (A4)               | 2 |
| `γ_bc` (v4, B2)     | **{1.0, 1.3, 1.6, 2.0}**     | 4 |

Total **3·3·4·4·3·2·4 = 3456** cells. (v1: 324 → +A1 σ_R: 432 → +A4 extreme_R: 864 → +C2 γ_bc (v3): 2592 → +B2 γ_bc upward (v4): 3456.) Recommended Phase-1 strategy: AC2-eliminate-first — reject any cell with > 0 LOSS on PAP-760/796/939/1052 corpus before scoring AC1, which prunes the dominant cost. Cell-cache + resumable design (lifted from `pap1100.aim-prior.js`) makes the sweep tractable.

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
- **v4 risk (was v3 risk, B2 elevated) — v5 mitigated by B4 pre-flight pass**: Option α boost γ_bc > 1.0 may regress AC2 if a true small-cog row has `|bcTc-bcPeaks|≤2 && bcTc≥30` from a misdetected outer ring AND `rOuter` happens to sit at a small-cog harmonic peak. v3's grid `{0.6, 0.8, 1.0}` masked this risk (no substitution would have fired); v4's `{1.0, 1.3, 1.6, 2.0}` exposes it for the first time. v5 (B4) pre-empts this by adding a 305-photo AC2 corpus pass to the §4.0 pre-flight harness *before* Phase-1 sweep cost is incurred — substitution-FP rows are surfaced at the cheap pre-flight stage rather than waiting for Phase-1 AC2-eliminate-first pruning to detect them. B3+B3' instrumentation (`gamma_eff`, `commit_margin`) makes the safety margin between "lowest γ_bc that rescues all 7 v2-broken rows" and "lowest γ_bc that triggers an AC2 LOSS" empirically measurable per-row.
- **v5 risk (B5 — γ_bc=2.5 sentinel)**: pre-flight-only sentinel does not change Phase-1 cost (3456 cells unchanged). However, if Phase-1 selects γ_bc=2.5 as the best-cell value (it cannot, since 2.5 isn't in the sweep grid by path-(b) choice), AE re-routes to QA as an explicit v5+ amendment. Pre-flight FAIL at sentinel (`gamma_eff > 2.5` on any v2-broken row OR AC2-FP > 2 at γ_bc=2.5) is a hard descope signal — Option α is structurally inadequate for the disagree set + AC2 corpus combination, escalate to Option β/γ under v6+.
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

## 9. Sequencing (v5)

1. **DONE (v2, ae28d85)**: Update `pap1480_joint_score_spec.md` → v2.
2. **DONE (PAP-1487, 2bd05d5)**: Run pre-flight bypass-row guard (§4.0, A3) → **FAIL verdict** (7 broken PAP-861 rows). Reports at `debug-reports/pap1485_preflight_2026-05-15.{log,json}`.
3. **DONE (v3, 361c010)**: Fold Option α (bc-consensus carve-out) into §3.4.6 → routed to QA cross-check #3 (PAP-1492).
4. **DONE (QA #3, 2026-05-15T01:17:52Z)**: PAP-1492 returned **REJECTED-FOR-AMENDMENTS** — B1 (gate tolerance), B2 (γ_bc upward grid), B3 (instrumentation).
5. **DONE (v4, 6a0d2b6)**: Fold B1 (`|bcTc-bcPeaks|≤2` gate), B2 (γ_bc ∈ {1.0, 1.3, 1.6, 2.0}), and B3 (harness J_bc_raw / gamma_eff / subst_fired columns) → routed to QA cross-check #4 (PAP-1494).
6. **DONE (QA #4, PAP-1494)**: APPROVED-W-AMENDMENTS — B3' (J_dis_new / commit_margin), B4 (AC2 pre-flight pass), B5 (γ_bc=2.5 sentinel before Option β escalation).
7. **THIS REVISION (v5, PAP-1497)**: Fold B3'+B4+B5 → **route to QA cross-check #5** (file new child under PAP-1491). v4 B1+B2 carry forward APPROVED; QA #5 should be brief — only validates the three v5 amendments land cleanly.
8. **NEXT (gated on QA #5 APPROVED)**: Wire Option α v5 into `mobile/__tests__/pap1480.preflight.js` inline simulator (γ_bc=1.3 default; B3 + B3' instrumentation rows; sentinel γ_bc=2.5; Pass B 305-photo AC2 corpus added). Re-run on full 362-photo corpus + 305-photo AC2 corpus.
9. **v5 PASS criterion** = 0 broken across all five PAP-861/868/885/889/1059 predicates AND `gamma_eff ≤ 2.5` on all 7 v2-broken PAP-861 rows AND AC2 substitution-FP count ≤ 2 at γ_bc=1.3. If FAIL → v6 round (likely Option β fallback).
10. **THEN (gated on v5 PAP-1487 PASS)**: Open **Phase-1 calibration child** under PAP-1480 (3456-cell sweep with AC2-eliminate-first pruning, on union corpus + AC1 n=24 cohort). Cell-cache + resumable design lifted from `pap1100.aim-prior.js` minus the PAP-1100-specific bounds plumbing.
11. Pick best cell maximizing AC1-pass while preserving 305-photo AC2 (0 LOSS). Apply A5 hard-exit if best cell fails AC4.
12. **QA cross-check #2** on the chosen cell + parameter values + Phase-1 corpus diff. No `gearCounter.js` edit before this signoff.
13. PAP-1480 implementation lands as the single coherent commit described in §0 (joint-scan + PAP-1100 plumbing deletion in one diff).
14. QA full sweep + signoff post-implementation → build subtask filed by QA.
