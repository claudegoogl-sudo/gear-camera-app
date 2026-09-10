# PAP-1862 — FP5 b151 live session 2026-09-10: D3 gate false-positive abstain on labeled 20T

Sentry issue GEAR-CAMERA-APP-3, release `v1.0.0 (151) · 2026-09-04 18:20`, FP5
(`FP5.VT31.C.114`), events 11:31:31–11:32:58Z. 2 debug_report captures + 1
training_sample, all `actualTeethCount=20`. No events after 11:33Z as of 12:58Z.

## Result table

| capture | event | actual | detected | conf | method | rOuter (=innerRadius) | detect | total |
|---|---|---|---|---|---|---|---|---|
| A | dad332a5 | 20 | 0 | 0 | pap1534-d3-dense-chainring-abstain | 144 | 19813ms | 24018ms |
| B | 7d20ca5f | 20 | 0 | 0 | pap1534-d3-dense-chainring-abstain | 155 | 20257ms | 24284ms |

`chainringRegime=false` both (PAP-1536 cue separate from D3). `budgetExhausted=false`
— NOT a PAP-1647 freeze (45s budget, used ~24s).

## Why the D3 gate fired (inverted from telemetry + HEAD 27322a3 code)

`checkDenseChainringRegime` (mobile/src/algorithm/gearCounter.js:2361) abstains when
`estimateInnerRadius(...) / contourRadius < 0.50` (PAP-1534 threshold). The abstain
return carries `rOuter: denseCheck.innerRadius`, and `gearContour.radius` =
`(gearR/900) * 1764/3072`:

- gearR = 0.22330729166666663 / (1764/3072) * 900 = **350.0px** (900×900 space)
- isDense ⇒ contourRadius > 288px (A) / > 310px (B) ⇒ **fraction ≈ 0.41–0.49**

Both 20T photos sat just under the 0.50 threshold: the `estimateInnerRadius`
gradient+variance transition heuristic scored their hub ring marginally "dense".
False-positive abstain on an ordinary mid-gear — 2/2 captures, 0 correct.

## Consequences for pending decisions

- **PAP-1855 session criteria** (dense-chainring abstain ≥90%, FP <5%): FP currently
  2/2 on ordinary gear. If the session ended here, the b151 D3 ship criterion FAILS.
- **Interaction 2b9e1994** (A/A2/B on PAP-1671): this is the on-device proof the card
  was waiting for; an Option-B "ship as-is" call now carries a known 20T→0 regression
  risk (mid-gear band 0.41–0.49 fraction).
- **PAP-1688 re-derivation trigger**: ordinary-gear device stageMs n=2/10 (abstain-path;
  admissibility for p99 is a QA/CEO call). Not owed yet.
- **Hermes gap refinement**: detect ran 19.8/20.3s WITH FFT methods skipped
  (methods=21/34ms) ⇒ the ~20–30x device-vs-host gap concentrates in
  `findGearCenter` JS, not the FFT channels. Highest-leverage native port candidate
  if the gap work reopens.

## Blocked on QA

Attachment download needs `event:admin` (repo tokens have only event:read/org:read/
project:read → 404). Capture A: photo.jpg 898620572/898620610 + cropped.jpg 898620612.
Capture B: photo.jpg 898623251 + cropped.jpg 898623252. Host reproduction at HEAD on
the two cropped.jpg decides algorithm-bug-at-HEAD vs device-only divergence.

Raw payloads in this folder. QA handoff: PAP-1862 (assigned QA, 2026-09-10 ~13:00Z;
QA checked out within minutes).
