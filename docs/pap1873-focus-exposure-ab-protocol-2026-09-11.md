# PAP-1873 — Focus/exposure capture A/B protocol v1 (pre-registered 2026-09-11)

Owner: Algorithm Engineer. Vehicle: PAP-1800 **Phase 6, NON-GATING** (arms sketched by QA in `da68610`; this doc supplies the pairing procedure, endpoints, pass criteria, decision rule). Analysis: desktop, after the session, with committed probe machinery.

**Question answered:** does assisted capture (AF-lock on the rim + AE lock) change the captured photons in the direction of dense countability? This is the last surviving capture-side lever after the 1500px resolution negative (`bdf4c2e`, PAP-1869: deficit is optical, not sampling).

## Session procedure (rides Phase 6; ~10 min)

1. **Targets, priority order:** 52T (primary, signal-absent class), 50T (present-but-misselected), 48T, 42T (mid-dense control). Minimum 3 pairs per target, 5 preferred. If session time runs short, skip later targets — **52T pairs carry the verdict**.
2. **Pair loop per target** (frame once, then alternate):
   - **Arm A (default):** capture immediately, no interaction.
   - **Arm B (assisted):** tap-to-focus placed on the rim at ~mid-radius (not hub, not background, not specular highlight); engage AE/AF lock (long-press) where the device supports it; capture within 2 s of lock.
   - Alternate A,B,A,B… for the pair count — decorrelates slow drift (light, hand) from the arm effect.
3. **Log per capture:** target, arm, order index, lock success (Arm B only). Standard session conditions otherwise: Phase 2 distance band, no zoom, no flash.

## Endpoints (pre-registered; any change = a new dated pre-registration)

- **G1 — manipulation check (void gate):** per pair, rim-annulus sharpness on the 900px masked crop — Laplacian variance over the annulus `[0.85, 1.05] x contourRadius`. **Pass: B > A on >= 60% of valid pairs.** Fail → the assisted arm never changed the photons; A/B is **void**.
- **G2 — primary census endpoint:** paired census flips — absent(A)→present(B) minus present(A)→absent(B) — **>= +2** across the 52T/50T/48T targets. Census convention: ±1-correct frequency present anywhere in the production scan, rel >= 0.04 (PAP-1865 convention, `pap1671.capture_probe.mjs` machinery, desktop).
- **G3 — guard:** production end-to-end output per capture: **confident-wrong count in B must not exceed A** (dense class). Abstain honesty is untouched; a focus assist may only convert abstain→correct or abstain→abstain, never correct→wrong.

## Decision rule

- **G1 fail** → A/B void; fix the lock procedure; retry once at the next cadence session; void again → lever closed (procedure infeasible on device).
- **G1 pass, G2 fail** → lever **CLOSED as negative** (same disposition as the 1500px lever). Recorded on PAP-1873 and as decision input for the next PAP-1671 card.
- **G1 + G2 + G3 pass** → census-validated positive → **AC2 queue: QA independently recomputes G1/G2/G3 from the session artifacts** (PAP-1869 pattern) before anything reaches an operator card. If confirmed, the next card may propose focus-guidance UX as a dense assist — dense-abstain remains the fallback either way.

## Power honesty

Session-size n (12–20 pairs) is a direction check, not a proof. +2 net census flips is the minimum interesting effect given the corpus 52T present-rate of 2/22; anything smaller is noise-level. Negatives are recorded, not dropped (PAP-1873 AC1).
