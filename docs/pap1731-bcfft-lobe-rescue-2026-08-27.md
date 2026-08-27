# PAP-1731/PAP-1738 — bc-fft lobe-harmonic rescue (32T cassette undercount)

Status: fix committed `5797f59` (2026-08-27), QA review pending before any build.

## Defect

b142 device session 2026-08-26 12:28–12:30Z (FP5): labeled 32T cassette read
**10/32 at conf 0.7174 via bc-fft** (event `93a89a7c`); the same subject ~70 s
later read **32/32 via peak** (event `3274b2b2`). Worst failure class — a
confident wrong answer, not an abstain.

## Root cause

Both events replay bit-for-bit through the device pipeline
(`mobile/__tests__/pap1731.diag.mjs`, fixtures under
`mobile/__tests__/fixtures/pap1731/`). On the miss:

- `peakTc=32` (correct) at `peakRel=0.1434` → `fftConf=0.623`, just under the
  0.70 branch-1 (`peak`) threshold — the correct answer was present but unused.
- bc-fft branch gate (`bcPurity ≥ 0.20 ∧ bcTc ∈ [10,60]`) accepted `bcTc=10`,
  purity 0.315; `finalRel = bcPurity·0.50 = 0.1576` → the observed 0.7174.
- **The winning contour's spectrum is a 5-fold lobe series** — relative
  magnitudes `5:3.54 10:1.00 15:0.46 20:0.24`. The 32 teeth are invisible at
  that threshold. The bc scoring window starts at `MIN_TEETH=10`, so the
  out-of-range 5-fundamental is dropped and its **2nd harmonic at exactly 10**
  wins by default. The independent peak count on the same contour read 5 —
  out of tooth range: the channel self-describes as a sub-tooth lobe contour.
- `bcTc===MIN_TEETH` is never a true count: 0 of 362 corpus photos are
  labeled 10T (min truth label 11T) — same fact PAP-474/PAP-632 used for the
  peak-channel floor abstains.

## Fix (as committed in 5797f59)

In the bc-fft branch — both the main `analyzeImage` cascade and the
`analyzeImageAtCenter` retry mirror — before committing `finalTc = bcTc`:

```
bcTc === MIN_TEETH && bcPeaks < MIN_TEETH && peakTc >= 2*MIN_TEETH && fftConf >= 0.40
  → finalTc = peakTc; method 'bc-fft+peak-lobe-rescue'
```

Each condition is load-bearing: never-true floor value; no bc self-
corroboration; sharp (≥2×) disagreement; moderate-confidence band
(PAP-282/PAP-300 floor). No `bcPurity·0.50` confidence boost in the rescue
branch — bc is the distrusted channel there. Confidence on the miss is the
honest 0.623 from the FFT path.

Class-safety: fires only inside a branch that was already committing a
confident answer at the never-true floor value. Can convert confident-wrong →
correct or wrong → wrong; cannot convert correct → wrong or abstain → wrong.

## Corrections to the 5797f59 commit message

Two claims in that message do not match the code/logs:

1. It lists conditions `!innerBoreSuspect` and `!centerDisagree` (its items
   5–6). **These are not in the code** — the guard is the 4-condition
   predicate above. On the 93a89a7c miss both would be false, so behavior is
   identical either way; adding them is a hardening option left for the QA
   verdict (functional change → re-review required before build).
2. It says "accuracy 217/362 unchanged". The committed pap1675-convention
   audit logs say **210/362** (identical before/after). The probe-based
   scoring (analyzeImage internals, no retry path) yields a different
   absolute; "unchanged / 0 fires" is correct on both bases.

## Evidence

- Replay + standing regression check (exits non-zero on mismatch):
  `node --import ./mobile/__tests__/lib/node-esm-stubs.mjs mobile/__tests__/pap1731.diag.mjs`
  → miss 10→32 `bc-fft+peak-lobe-rescue` conf 0.623; hit 32 `peak` unchanged.
- Corpus predicate probe (pre-fix, all 362):
  `mobile/__tests__/pap1731.probe.mjs`, `debug-reports/pap1731_probe_2026-08-27.log`
  — 8 rows reached the bc-fft branch, 6 with bcTc=10, **0** satisfy the full
  predicate (all fail peakTc≥20 or fftConf≥0.40).
- Full-path before/after audit (pap1675 conventions, dim=900, unmasked,
  `countTeethFromRgba` incl. retry): `debug-reports/pap1731_audit_before_2026-08-27.log`,
  `..._after_...log`, `..._beforeafter_diff_...log` — **0 rows changed**
  (tc/conf/method identical), 210/126/26 both sides, matching the historic
  PAP-1675 baseline at 9c4eacc.
- jest: 6 suites / 60 tests pass; `pap1659.deadline-bound.mjs` ALL CHECKS PASSED.

## Not ported

Python reference `algorithm/gear_tooth_counter.py` keeps its original cascade.
Device runs the JS; porting the guard is an Algorithm Engineer handback option.
