# Training Data Labeling Summary

**Date:** 2026-04-05
**Corrected by:** Algorithm Engineer per board audit (PAP-84)
**Images:** 26 total (12 from April 4 + 14 from April 5)

## Overview

26 labeled training images of bicycle cassette sprockets (Shimano-style). All images photographed on paper towels or white paper. Four distinct sprocket sizes appear across the dataset.

## Correct Tooth Counts (chronological)

15, 14, 13, 11, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 13, 13, 13, 11, 11, 11

## Image-by-Image Labels

### April 4 Session 1: 09:09-09:10 (4 images)

| Training File | Actual Teeth | Algo Result | Error | Notes |
|---|---|---|---|---|
| 09-09-24-950Z | 15 | 11 | -4 | Large sprocket with lightening holes |
| 09-09-54-631Z | 14 | 10 | -4 | Medium sprocket, slightly dirty |
| 09-10-20-407Z | 13 | 12 | -1 | Medium-small sprocket, clear view |
| 09-10-51-656Z | 11 | 14 | +3 | Smallest sprocket, lockring cog |

### April 4 Session 2: 16:15-16:16 (3 images)

| Training File | Actual Teeth | Algo Result | Error | Notes |
|---|---|---|---|---|
| 16-15-39-652Z | 14 | 11 | -3 | White paper on dark desk |
| 16-16-09-444Z | 14 | 10 | -4 | Rotated orientation |
| 16-16-44-639Z | 14 | 10 | -4 | Another rotation, slightly overexposed |

### April 4 Session 3: 18:49-18:54 (5 images)

| Training File | Actual Teeth | Algo Result | Error | Notes |
|---|---|---|---|---|
| 18-49-40-768Z | 14 | 32 | +18 | Algo wildly overestimated |
| 18-50-11-106Z | 14 | 10 | -4 | Same sprocket, different angle |
| 18-52-30-549Z | 14 | 0 | -14 | Algo failed completely |
| 18-53-44-084Z | 14 | 11 | -3 | Close-up |
| 18-54-21-451Z | 14 | 0 | -14 | Algo failed completely |

### April 5 Session: 08:24-08:34 (14 images)

| Training File | Actual Teeth | Algo Result | Error | Notes |
|---|---|---|---|---|
| 08-24-37-589Z | 14 | 11 | -3 | Build 24 |
| 08-25-08-743Z | 14 | 10 | -4 | |
| 08-25-39-887Z | 14 | 0 | -14 | Algo failed |
| 08-26-06-796Z | 14 | 12 | -2 | |
| 08-27-08-187Z | 14 | 14 | 0 | Correct! |
| 08-27-44-023Z | 14 | 10 | -4 | |
| 08-29-38-474Z | 14 | 10 | -4 | |
| 08-30-34-676Z | 14 | 10 | -4 | |
| 08-31-06-222Z | 13 | 10 | -3 | Smaller sprocket |
| 08-31-34-725Z | 13 | 10 | -3 | |
| 08-32-16-126Z | 13 | 13 | 0 | Correct! |
| 08-32-48-875Z | 11 | 10 | -1 | Lockring cog |
| 08-33-27-869Z | 11 | 10 | -1 | |
| 08-34-06-051Z | 11 | 10 | -1 | |

## Algorithm Performance Summary

- **Images analyzed:** 26
- **Correct results:** 3/26 (11.5%) — images 08-27-08, 08-32-16, plus near-miss 09-10-20
- **Complete failures (0 count):** 3 images
- **Wildly incorrect (>10 error):** 4 images

## Distinct Sprockets in Dataset

1. **15T sprocket** — 1 image. Large, lightening holes.
2. **14T sprocket** — 16 images (most common).
3. **13T sprocket** — 4 images.
4. **11T sprocket** — 5 images. Lockring-style cog.

## Correction Log

8 of 12 original April 4 labels were incorrect (board audit PAP-84). Key changes:
- What was labeled 16T is actually 15T (1 image) or 14T (7 images)
- What was labeled 13T is actually 14T (1 image)
- What was labeled 12T is actually 13T (1 image)
- No 12T or 16T sprockets exist in the dataset
