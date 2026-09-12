# AE corpus context — the G4 tc=20@0.728 abstain in the operator's 17:34-17:39Z b153 attempt

Companion to `sentry_digest.md` (QA, bd874c5). Question QA flagged: G4-fft-collapse-op-commit
abstained a tc=20 conf=0.728 candidate — on-device false-abstain if that was a true ~20T
ordinary gear, correct abstain if dense. Photos are still the ground truth; this note pins the
corpus prior so the photo check is mechanical when they land. All numbers re-computable from
committed artifacts (`debug-reports/pap1872_dense_abstain_2026-09-11/`: gate_corpus_rows.json,
corpus_gate.log, gate_summary.json; 364 rows).

## 1. The event signature is a corpus-established fire class, not novel telemetry

G4-fft-collapse-op-commit fired 7 times in the 364-photo corpus gate run; 6 of 7 fires had
pre-gate tc 20-22 (the 7th tc=31). Corpus G4 profile: fft collapses to peak=fft90=10, bc=10,
op-commit 20, pre-gate conf 0.44-0.66. Device event (tc=20, conf=0.728) is the same family;
its conf sits slightly ABOVE the corpus G4 band.

## 2. Truth-class prior favors dense-alias / dark-frame (correct or vacuous abstain)

- Ordinary gate damage in the corpus is NOT at 20T. Newly-abstained ordinary gears
  (baseline returned a count, gate abstained): 11 total — actuals 28x4, 24x3, 21x3, 34x1.
  Zero at 20T. (10 count in AC2's n=284; the 11th is the C(29-39) 34T row in the n=16 bucket.)
- Those 11 were ALREADY low-conf wrong at baseline: baselineTc mostly 10/11/20/22 at
  baselineConf 0.20-0.65. The gate converts quiet-wrong into honest abstain there; it does not
  touch high-conf ordinary answers (correctness regressions = 0).
- The only true-20T rows in the corpus are the 2 SYNTHETIC anchors (pap1862_captureA/B):
  both return tc=20 conf=1.0, gate never fires. Honest caveat: the corpus contains NO real
  20T photo, so "true 20T never fires" rests on synthetic anchors + the nearest real classes
  (21T/24T rows: 6 newly abstained, all low-conf-at-baseline cases above).
- Device CRES on the event frame: 7/7 detected=false, score 0.000 — the capture-level detector
  retained nothing usable. A lit, usable 20T gear should not CRES to 0.000. This is independent
  device-side evidence toward the dark-frame reading.

## 3. Pre-registered classification rule (execute when photos are pulled, protocol v2 naming)

For each capture matching the 17:34-17:39Z window (5-6 distinct):
1. Lit/unlit triage first. Unlit -> void row, no gate strike (dark-capture hypothesis stands).
2. Lit + visually dense (40-60T) -> G4 abstain CORRECT (dense alias, by design).
3. Lit + true ordinary ~18-24T -> ORDINARY FALSE-ABSTAIN strike, and a NEW failure class
   (first observed anywhere: corpus has zero true-20T gate damage). File a repro ticket with
   the photo + this telemetry line; do NOT hot-tune G4 on one frame.
4. Lit + other ordinary (25-39T) -> treat as ordinary false-abstain strike on the <5% budget;
   classify which arm of the digest table it belongs to.

Any single lit-ordinary strike moves the b155 session from "clean run" to "repro-first" —
the controlled A/B still proceeds (per plan, session clears PAP-1800 + PAP-1662 + PAP-1665).

## 4. Small telemetry gap worth closing (non-urgent)

Per-row abstain gate-rule NAMES are not exported into gate_corpus_rows.json (only the
interleaved corpus_gate.log carries them, without photo ids). Rule x truth attribution above is
therefore inferred from counts (G1-tc40/G2-bc40 dense-only by construction; G3 fires 21 ~
ordinary fires 22), not row-joined. If a future gate run adds `gateRule` name per row, this
class of question answers in one query. AE happy to take that as a tiny harness item if QA
agrees it is worth a lane.
