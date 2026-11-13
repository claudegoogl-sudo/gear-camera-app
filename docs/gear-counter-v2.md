# Gear counter v2

Date: 2026-11-13. First released in build b167; built on top of `f96fa8d` (b166).
This file gives the measured numbers, how to reproduce them, and what is not verified.

## What changed

- `mobile/src/algorithm/gearCounterV2.js`: new counter. One pipeline, no retries, no per-size rules, no dependencies.
- `mobile/src/algorithm/gearCounterV2Photo.js`: photo entry point with the result shape that the screens use.
- `mobile/src/screens/CameraScreen.jsx`: switch `USE_COUNTER_V2` (true). With v2 the crop is the aim square plus 50 %,
  resized natively to 1024 px, and no circular mask is applied. Set the switch to `false` to get the legacy behaviour.
- `mobile/src/screens/ResultScreen.jsx` + `mobile/src/utils/abstainGuidance.js`: the "can't count" panel says what is
  wrong with the photo (gear cut off, no gear, outline is not teeth, teeth unclear).
- `training-data/CORPUS_EXCLUDED.json`: three photos are left out of the test corpus because their label is not certain. For two, an agent set a label that differs from the operator's debug report (15 / 14); for the third the two uploads of the same photo disagree (51 / 52).
- The legacy counter (`gearCounter.js`) is unchanged.

## How v2 counts

1. Edges: Sobel gradient magnitude on the blurred gray image, one robust threshold.
2. Centre: every edge pixel votes along its gradient line. A gear centre collects the votes of all its concentric arcs.
3. Tooth ring: the outermost radius band around that centre in which most rays hit an edge.
4. Geometry: circle fit, then ellipse fit (tilted camera), on the outline points of that band.
5. Outline: r(theta) = outermost edge of the band's own edge components.
6. Count: dominant frequency of r(theta), then the exact number of cycles of the narrow-band signal around it.
   This stays exact when the tooth pitch varies around the circle (perspective, centre offset).
7. Gates: no number when the outline is not tooth-shaped (`not-teeth`), the gear is cut off (`cut-off`),
   the signal is weak (`unclear`), or nothing is found (`no-gear`).

## Measured results

Scoring: EXACT tooth count for every gear size. "No answer" = the counter abstains. Labels: meta files and debug reports as they are; the photos in `CORPUS_EXCLUDED.json` are skipped.
Both counters get the same pixels in every row. Host: laptop, node 26. "ms" is the count only (no JPEG decode).

| Input set | Counter | Photos | Exact | No answer | Wrong | ms p50 / p95 |
|---|---|---|---|---|---|---|
| Whole photo, 1200 px (`MODE=full`) | legacy | 359 | 185 (51.5 %) | 168 | 6 | 1463 / 1957 |
| Whole photo, 1200 px (`MODE=full`) | **v2** | 359 | **350 (97.5 %)** | 9 | 0 | 49 / 70 |
| Device crop from the debug reports, 900 px (`MODE=real`) | legacy (with its mask) | 90 | 43 (47.8 %) | 45 | 2 | 1367 / 1856 |
| Device crop from the debug reports, 900 px (`MODE=real`) | **v2** (no mask) | 90 | **83 (92.2 %)** | 7 | 0 | 68 / 181 |
| Aim square + 50 %, 1024 px (`MODE=pad`, what the app sends to v2) | **v2** | 96 | **94 (97.9 %)** | 2 | 0 | 64 / 83 |

The five runs ran at the same time on one laptop, so the ms values are a little high. One process alone, device crops: legacy 1276 / 1612 ms, v2 53 / 146 ms.

Correction: an earlier version of this table gave the legacy counter 169 exact / 184 no answer / 9 wrong for whole photos. That run used 900 px input, not the 1200 px that v2 got. The row above is the same input for both.

v2 per size, whole photo: S 9-15T 132/134, M 16-20T 33/33, L 21-28T 110/113, XL 29-60T 75/79; wrong answers: 0.

Photos that were never looked at while v2 was developed (91 photos from 7 capture days): whole photo v2 89 exact, 2 no answer, 0 wrong; legacy 38 exact, 51 no answer, 2 wrong.
These photos show the same gears on the same table as the other photos. They are not a test on new gears or new places.

Runtime in the Hermes engine (hermes-engine-cli 0.12.0, `hermes -O`, on the laptop, 900 px device crops, count only):

| Photo | legacy | v2 |
|---|---|---|
| 11T | 25.8 s | 0.88 s |
| 18T | 25.3 s | 0.87 s |
| 28T | 29.4 s | 1.02 s |
| 42T | 31.8 s (no answer) | 0.81 s (42) |

The legacy numbers match the recorded phone numbers (about 30 s median, Sentry b159-b162), so this engine on the laptop
is a usable stand-in for the phone. It is not a phone measurement.

## Reproduce

```
cd mobile && npm ci --ignore-scripts
npm run test:v2                         # 8 drawn-gear tests, about 1 s
npm run measure:v2                      # MODE=full, about 15 min (JPEG decode of 362 photos); prints the table, PASS / FAIL
MODE=pad  npm run measure:v2            # about 5 min
MODE=real npm run measure:v2
MODE=real ALGO=legacy npm run measure:v2
npx jest __tests__/v2.resultShape.test.js
```

The full jest suite (`npm test`) takes about 28 minutes and does not measure accuracy. On this branch: 28 of 29 files pass; `pap1881.flash_control.test.js` times out under load and passes when run alone (same at `f96fa8d`).

`measure:v2` exits 1 when a set is below its limits (`LIMITS` in `__tests__/v2.corpus.mjs`).

## Not verified

- Nothing was run on a phone. Device runtime, the native crop + resize step, and the changed screens need one device session.
- The JPEG decode still runs in JS (jpeg-js). It now gets about 1 MP instead of about 3.3 MP. Its device time was not measured.
- Light with hard shadows, a strongly tilted camera (more than about 45 degrees), motion blur, and dark gears on a dark
  surface are not in the photo set. v2 answers "unclear" or "no-gear" in the cases that were tried, but this is not measured.
- The photos cover 19 tooth counts from 11 to 52, mostly on white paper, from one workshop. Other gear types (belt pulleys, very worn teeth) and other backgrounds are not measured.
- The three excluded photos were not checked on the physical gears.

## Rules for later changes

- Never change a label in `training-data`. If a label looks wrong, add the photo to `CORPUS_EXCLUDED.json` with the evidence and ask the operator.
- A change to the counter needs the `measure:v2` table for `full` and `pad`, before and after, at named commits.
- Keep some capture days out of tuning and report them separately.
- The measured input must be the input the app sends. Check it against a real `cropped.jpg` from a debug report.
