# Training Data Labeling Summary

**Date:** 2026-04-06
**Corrected by:** Algorithm Engineer per board audit (PAP-84, PAP-96); QA Engineer labeled builds 28-30 (PAP-125)
**Images:** 51 total (12 from April 4 + 35 from April 5 + 4 from April 6)

## Overview

51 labeled training images of bicycle cassette sprockets (Shimano-style). All images photographed on paper towels or white paper. Four distinct sprocket sizes appear across the dataset.

## Correct Tooth Counts (chronological)

15, 14, 13, 11, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 15, 15, 14, 13, 13, 13, 11, 11, 11, 14, 14, 15, 15, 14, 14, 13, 13, 11, 11, 11, 11, 11, 13, 14, 14, 15, 11, 13, 14, 15, 14, 15, 11, 13

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
| 08-29-38-474Z | 15 | 10 | -5 | Board-verified 15T |
| 08-30-34-676Z | 15 | 10 | -5 | Board-verified 15T |
| 08-31-06-222Z | 13 | 10 | -3 | Smaller sprocket |
| 08-31-34-725Z | 13 | 10 | -3 | |
| 08-32-16-126Z | 13 | 13 | 0 | Correct! |
| 08-32-48-875Z | 11 | 10 | -1 | Lockring cog |
| 08-33-27-869Z | 11 | 10 | -1 | |
| 08-34-06-051Z | 11 | 10 | -1 | |

### April 5 Session 2: 13:27-13:31 (2 images, build 25)

| Training File | Actual Teeth | Algo Result | Error | Notes |
|---|---|---|---|---|
| 13-27-32-499Z | 14 | 18 | +4 | Board-verified 14T |
| 13-31-32-807Z | 14 | 13 | -1 | Medium sprocket |

### April 5 Session 3: 14:34-14:41 (8 images, build 26)

| Training File | Actual Teeth | Algo Result | Error | Notes |
|---|---|---|---|---|
| 14-34-16-932Z | 15 | 20 | +5 | Large sprocket, 0 confidence |
| 14-35-16-858Z | 15 | 21 | +6 | Same, different angle, 0 confidence |
| 14-36-18-288Z | 14 | 20 | +6 | Medium sprocket, 0 confidence |
| 14-37-17-240Z | 14 | 20 | +6 | Same, different angle, 0 confidence |
| 14-38-39-916Z | 13 | 13 | 0 | Correct! 0 confidence though |
| 14-39-43-491Z | 13 | 13 | 0 | Correct! 0 confidence though |
| 14-40-38-072Z | 11 | 17 | +6 | Lockring cog, 0 confidence |
| 14-41-38-021Z | 11 | 10 | -1 | Lockring cog, 0 confidence |

### April 5 Session 4: 16:50 (1 image, build 27)

| Training File | Actual Teeth | Algo Result | Error | Notes |
|---|---|---|---|---|
| 16-50-12-545Z | 11 | 11 | 0 | Lockring cog, board-verified 11T |

### April 5 Session 5: 17:30 (1 image, build 27)

| Training File | Actual Teeth | Algo Result | Error | Notes |
|---|---|---|---|---|
| 17-30-18-613Z | 11 | 15 | +4 | Lockring cog, board-verified 11T |

### April 5 Session 6: 17:37-17:45 (5 images, build 28)

| Training File | Actual Teeth | Algo Result | Error | Notes |
|---|---|---|---|---|
| 17-37-19-161Z | 11 | 11 | 0 | Lockring cog, correct! |
| 17-39-11-112Z | 13 | 11 | -2 | Medium-small sprocket |
| 17-42-01-194Z | 14 | 11 | -3 | Medium sprocket, lightening holes |
| 17-42-25-166Z | 14 | 11 | -3 | Same sprocket, same angle |
| 17-45-32-734Z | 15 | 12 | -3 | Large sprocket, lightening holes |

### April 5 Session 7: 20:05-20:14 (4 images, build 29)

| Training File | Actual Teeth | Algo Result | Error | Notes |
|---|---|---|---|---|
| 20-05-36-867Z | 11 | 12 | +1 | Lockring cog |
| 20-11-19-230Z | 13 | 10 | -3 | Medium-small sprocket |
| 20-12-48-480Z | 14 | 10 | -4 | Medium sprocket, close-up |
| 20-14-33-985Z | 15 | 10 | -5 | Large sprocket, lightening holes |

### April 6 Session 1: 08:15-10:07 (4 images, build 30)

| Training File | Actual Teeth | Algo Result | Error | Notes |
|---|---|---|---|---|
| 08-15-57-376Z | 14 | 13 | -1 | Medium sprocket, lightening holes |
| 09-24-05-913Z | 15 | 10 | -5 | Large sprocket, lightening holes |
| 10-01-25-781Z | 11 | 16 | +5 | Lockring cog |
| 10-07-48-115Z | 13 | 12 | -1 | Medium-small sprocket |

## Algorithm Performance Summary

- **Images analyzed:** 51
- **Correct results:** 7/51 (13.7%) — images 08-27-08, 08-32-16, 14-38-39, 14-39-43, 16-50-12, 17-37-19, plus near-miss 09-10-20
- **Complete failures (0 count):** 3 images
- **Zero confidence (build 26):** 8 images (all from April 5 session 3)
- **Wildly incorrect (>10 error):** 4 images

## Distinct Sprockets in Dataset

1. **15T sprocket** — 8 images. Large, lightening holes.
2. **14T sprocket** — 23 images (most common).
3. **13T sprocket** — 9 images.
4. **11T sprocket** — 11 images. Lockring-style cog.

## Correction Log

8 of 12 original April 4 labels were incorrect (board audit PAP-84). Key changes:
- What was labeled 16T is actually 15T (1 image) or 14T (7 images)
- What was labeled 13T is actually 14T (1 image)
- What was labeled 12T is actually 13T (1 image)
- No 12T or 16T sprockets exist in the dataset
