# PAP-1862 — QA cross-check: FP5 b151 20T D3-abstain FP (2026-09-10)

Verdict: **algorithm bug at HEAD confirmed (2/2 exact host repro); D3 gate UNSHIPPABLE
as specified — no threshold or cheap-FFT rescue satisfies the PAP-1855 criteria on the
real corpus.** Evidence below; raw rows committed alongside.

## 1. Attachment pull (AE ask #1) — DONE, no new token needed

All 4 attachments downloaded 200 OK with the EXISTING repo tokens via the
PROJECT-scoped endpoint (AE's 404s were endpoint-specific, not a scope gap):
`GET /api/0/projects/{org}/{proj}/events/{event_id}/attachments/{id}/?download=1`

- captureA: photo 898620610 (4096x3072) + cropped 898620612 (1764x1764)
- captureB: photo 898623251 + cropped 898623252
- Files: `attachments/` (committed).

## 2. Host reproduction at HEAD (AE ask #2) — 2/2 EXACT REPRO

Pipeline: cropped.jpg -> bilinear->900 -> 0.49*min(W,H) mask -> countTeethFromRgba
(probe: `mobile/__tests__/pap1862.d3_fp_probe.test.js`; rows: `host_repro_rows.json`).

| capture | device rOuter | host rOuter | host fraction | host result |
|---|---|---|---|---|
| A | 144 | **144** | 144/329 = 0.4377 | abstain, methodUsed=pap1534-d3-dense-chainring-abstain |
| B | 155 | **155** | 155/350 = 0.4429 | abstain, same tag |

innerRadius matches the device telemetry TO THE PIXEL on both captures; B's
contourRadius 350 equals AE's inverted 350.0px. => estimateInnerRadius + the 0.50
threshold produce identical outcomes on host and device. NOT a device divergence.

## 3. Threshold fix (ask #3) — RULED OUT by full-corpus sweep

Gate-only read (preprocess -> findGearCenter -> checkDenseChainringRegime) on ALL 364
labeled corpus photos + the 2 capture anchors
(`mobile/__tests__/pap1862.d3_threshold_sweep.test.js`; rows: `threshold_sweep_rows.json`).

Fraction distribution (innerRadius/contourRadius), 0.50 = shipped threshold:

| class | n | med | q75 | q90 |
|---|---|---|---|---|
| S 9-13T | 54 | 0.372 | 0.442 | 0.500 |
| M 14-19T | 115 | 0.514 | 0.573 | 0.590 |
| L 20-28T | 115 | 0.389 | 0.463 | 0.500 |
| C 29-39T | 16 | 0.357 | 0.394 | 0.485 |
| D 40-60T | 64 | 0.349 | 0.431 | 0.509 |

- **AUC = 0.375** — the fraction feature barely (inversely) separates dense from ordinary.
- At shipped T=0.50: ordinary FP = **200/284 = 70.4%** (criterion <5%); dense abstain =
  56/64 = 87.5% (criterion >=90%). Fails BOTH sides.
- **No threshold meets both criteria** (dense med 0.349 vs ordinary-L med 0.389 — classes
  interleave). At T=0.40: dense 62.5%, ordinary FP 43.0%. At T=0.30: 29.7% / 23.2%.
- Structural: estimateInnerRadius scans only r in [0.1, 0.6]*contourRadius, so fraction
  in [0.1,0.6]; the 8-angle gradient+variance median lands mid-radius on ordinary hubs.
- End-to-end check at locally-patched T=0.40 (worktree only, reverted): BOTH 20T
  anchors produce **toothCount=20, confidence=1.0** (method bc-consensus+peak). The D3
  gate is the ONLY thing between the user and a correct 20T answer.

## 4. Two-feature rescue (cheap FFT confirmation) — RULED OUT

Probe on all 272 fraction<0.50 rows (`pap1862.d3_rescue_probe.test.js`;
`rescue_rows.json`): abstain iff fraction<0.50 AND max(fft90tc, opTc) >= 30.

- Anchors: cheapMax 20/21 -> PASS (both rescued). Ordinary pass-through 98.0%.
- **But dense retention only 16/56 = 28.6%** — on true dense photos the cheap reads
  alias to 10-13T (e.g. 52T -> fft90=10): the confirming feature is exactly the failure
  mode D3 was built to prevent, so it anti-correlates on the population that matters.

## 5. Recount (ask #4) — n=2 stands

Sentry GEAR-CAMERA-APP-3 (group 120360803): 15 events lifetime; the 2026-09-10 session
contributed exactly 3 (11:31:31, 11:31:32, 11:32:58Z). **No events after 11:33Z** as of
~13:20Z. Session analyzed-capture count remains n=2 (2/2 abstained).

## 6. Recommendation (QA cross-check verdict per standing protocol)

1. **Do NOT attempt threshold tuning** — no value satisfies dense>=90% & FP<5%; tuning
   trades one failure class for the other (measured, not conjectured).
2. **Do NOT ship the cheap-FFT two-feature rescue** — 28.6% dense retention.
3. The PAP-1534 0.50 threshold was validated on synthetic/small sets (AE_D3_CLOSURE
   notes 10/10 synthetic tests); it never saw this corpus distribution. The gate's
   premise — inner-hub fraction separates 40+T from 9-30T — is false on real photos.
4. Options for the CEO/A-B decision (PAP-1671 card 2b9e1994):
   a. **Disable the D3 gate** until a discriminative feature exists (re-exposes the
      dense confident-wrong cluster it was meant to prevent — product trade-off), or
   b. **Keep + accept ~70% ordinary-gear abstain** (b151 current behavior; the FP5
      session is the visible symptom), or
   c. **Redesign on a discriminative feature** before any implementation: candidates
      are tooth-pitch at the outer annulus (not hub ratio) and robust concentric-circle
      hub estimation (scikit-image hough_circle,
      https://scikit-image.org/docs/stable/api/skimage.transform.html#skimage.transform.hough_circle
      — verified live 2026-09-10). QA re-runs the 364-photo sweep on any new feature
      BEFORE implementation (same protocol as this cross-check).
5. PAP-1855 session criteria: b151 D3 ship criterion FAILS on FP (2/2 ordinary, and the
   corpus predicts this is systemic, not bad luck).

## Artifacts (this folder)

- `attachments/` — 4 Sentry attachments (2 captures x photo+cropped)
- `host_repro_rows.json` — 2-anchor full-pipeline + gate read at HEAD
- `threshold_sweep_rows.json` — 364-photo gate-fraction sweep
- `rescue_rows.json` — 272-row cheap-FFT rescue probe
- `threshold_sweep.log`, `rescue_probe.log` — raw run logs
