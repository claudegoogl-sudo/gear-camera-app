# PAP-1873 — Focus/exposure capture A/B protocol v2 (2026-09-11)

Supersedes v1 (`6ec8c1a`, `docs/pap1873-focus-exposure-ab-protocol-2026-09-11.md`) on QA review (`81f30f90` on PAP-1800: **ENDORSED, endpoints unchanged**). v2 changes PROCEDURE ONLY — G1/G2/G3, thresholds, and the decision rule are byte-identical to the v1 pre-registration, which stands.

## Binding change from QA review

**Both arms run through the SYSTEM camera app** (not the gear-camera app). Verified constraint: `CameraScreen.jsx` (react-native-vision-camera 4.7.3) has no tap-to-focus and no AE/AF lock — Arm B has no in-app path. Same app for both arms preserves arm symmetry; all endpoints are desktop-computed; no algoDiag `stageMs` is produced — accepted, none of G1/G2/G3 consumes it. G3 "production end-to-end" = host-side plain-node run of the production pipeline on the pulled files, exactly like the pap1862/pap1865 audits. Adding in-app focus/AE-lock is real code + a build — disproportionate for a non-gating direction check; it stays as the positive-branch follow-up (focus-guidance UX) only if G2 passes. In-flight abstain tag on the dense-abstain build resolves to `pap1872-dense-chainring-abstain`.

## Session procedure (~10 min; rides PAP-1800 Phase 6, NON-GATING)

1. **Targets, priority order:** 52T (primary, signal-absent class), 50T (present-but-misselected), 48T, 42T (mid-dense control). Minimum 3 pairs per target, 5 preferred. If time runs short, skip later targets — **52T pairs carry the verdict**.
2. **Distance:** standard session working distance = the PAP-1701 gate-bearing band (dist ≥ 142); keep the SAME distance across both arms of a pair (enforced by frame-once pairing).
3. **Pair loop per target** (frame once, then alternate; system camera for BOTH arms):
   - **Arm A (default):** point-and-shoot, no interaction.
   - **Arm B (assisted):** tap-to-focus on the rim at ~mid-radius (not hub, not background, not specular highlight); engage AE/AF lock (long-press); capture within 2 s of lock.
   - Alternate A,B,A,B… for the pair count — decorrelates slow drift (light, hand) from the arm effect.
4. **Lock-fail rule (v2):** Arm B lock fails → re-attempt the lock once → still fails → **discard the pair** (both frames), log the discard. An unlocked B frame must never enter the analysis (it poisons G1).
5. **Artifacts (v2 convention):** pull frames from DCIM via adb; rename host-side copies to `{target}T_p{pair:02d}_{arm}_{order}.jpg` (e.g. `52T_p01_B_2.jpg`); store under `debug-reports/pap1873_focusAB_<session-date>/` together with `MANIFEST.csv` (`file,target,pair,arm,order,lockSuccess,nativeName`) and the session log. Primary files in DCIM are never renamed. The census/sharpness machinery keys on the target label in the filename.

## Endpoints (unchanged from v1 pre-registration)

- **G1 — manipulation check (void gate):** rim-annulus sharpness, Laplacian variance over `[0.85, 1.05] x contourRadius` on the 900px masked crop. Pass: B > A on >= 60% of valid pairs. Fail → A/B void; fix procedure; retry once at the next cadence session; void again → lever closed (procedure infeasible).
- **G2 — primary census endpoint:** paired census flips absent(A)→present(B) minus present(A)→absent(B) >= +2 across 52T/50T/48T targets. Census convention: ±1-correct frequency anywhere in the production scan, rel >= 0.04 (PAP-1865 convention, desktop).
- **G3 — guard:** production-pipeline output per photo (desktop): confident-wrong count in B must not exceed A (dense class). Abstain honesty untouched.

## Decision rule (unchanged)

- G1 fail → void; fix; retry once; void again → lever closed.
- G1 pass, G2 fail → lever CLOSED as negative (same disposition as 1500px); recorded on PAP-1873 + next PAP-1671 card input.
- G1 + G2 + G3 pass → census-validated positive → **AC2: QA independently recomputes G1/G2/G3 from session artifacts** before anything reaches an operator card; if confirmed, next card may propose focus-guidance UX (in-app focus/AE-lock) as a dense assist. Dense-abstain remains the fallback either way.

## Changelog v1 → v2

| # | Change | Source |
|---|---|---|
| 1 | Both arms via system camera app; adb pull; G3 runs host-side; no stageMs | QA binding constraint (app has no AF/AE-lock UX) |
| 2 | Lock-fail → 1 re-attempt → discard pair + log | QA clarification 1 |
| 3 | "Phase 2 distance band" → PAP-1701 gate-bearing band (dist ≥ 142) | QA clarification 2 |
| 4 | Artifact naming `{target}T_p{pair:02d}_{arm}_{order}.jpg` + MANIFEST.csv | QA clarification 3 |

Power honesty (unchanged): 12–20 pairs is a direction check, not a proof; +2 net census flips is the minimum interesting effect given corpus 52T present-rate 2/22. Negatives are recorded, not dropped (PAP-1873 AC1).

## Post-session communication map (added 2026-09-11, commit follow-up to `1fcf780`)

Makes the reporting mechanical too: run `pap1873.focus_ab_analyze.mjs <sessionDir>`, read the verdict, send exactly the mapped message. No improvised wording under time pressure. Internal handoffs are never operator-marked; at most ONE operator-marked message exists in this whole flow (the NEGATIVE end-state, if it happens).

| Analyzer verdict | First action | Operator-marked? | Message target + content |
|---|---|---|---|
| **VOID** (G1 fail) | Post `ab_summary.json` + void reason on PAP-1873; log procedure fix needed | No | None. Retry once at next cadence session per decision rule; second void = lever closed → then use the NEGATIVE row. |
| **NEGATIVE** (G1 pass, G2 fail) | Post `ab_summary.json` on PAP-1873; record lever closed in the canonical falsified list (#8) | **Yes** | PAP-1873, marked: "Focus/exposure A/B verdict: NEGATIVE (G1 pass, G2 net < +2). Dense 40-60T remains not precisely countable at 900px after all 8 levers tested; dense-abstain (PAP-1872) is the product answer. Standing research on this directive is complete unless a new lever class is identified." (Final disposition of the operator directive — this is the only operator decision point.) |
| **POSITIVE** (G1+G2+G3 pass) | Queue AC2: child issue assigned to QA with session dir + `ab_summary.json` (PAP-1877 pattern) | No | None yet. Operator card only AFTER QA independently confirms the verdict AND an implementation plan exists (in-app focus/AE-lock assist proposal). Premature operator messaging is exactly what the AC2 gate exists to prevent. |

Interpretation notes (recorded 2026-09-11, no prereg change):
- G2's +2 threshold sits ~1 pair-noise sigma above zero at n=9-12 pairs (each pair contributes −1/0/+1; synthetic cross-photo sessions can reach +2 by chance). A real session landing at exactly +2 must get full AC2 scrutiny, not a rubber stamp.
- Abstains (tc=0) never count as confident-wrong in G3 (PAP-1872 convention).
- Analyzer mechanics verified at full session shape (9 pairs × 3 targets, 36 artifacts) on synthetic corpus data — numbers from that check are not measurements.
