# Training Data Labeling Summary

**Date:** 2026-04-04
**Labeled by:** Algorithm Engineer (visual inspection)

## Overview

14 debug reports were collected. 2 reports (05:39 and 05:52 timestamps) have no photos and are skipped for training data. The remaining 12 photos were visually inspected and labeled with ground truth tooth counts.

All images show bicycle cassette sprockets (cogs) — Shimano-style, photographed on paper towels or white paper. Three distinct sprocket sizes appear across the dataset.

## Image-by-Image Analysis

### Session 1: 09:09–09:10 (4 images, paper towel background)

| Training File | Actual Teeth | Algo Result | Error | Notes |
|---|---|---|---|---|
| 09-09-24-950Z | 16 | 11 | -5 | Large sprocket with lightening holes, good visibility |
| 09-09-54-631Z | 13 | 10 | -3 | Medium sprocket, slightly dirty, some debris on towel |
| 09-10-20-407Z | 12 | 12 | 0 | Small sprocket, clear view. Only correct algorithm result |
| 09-10-51-656Z | 11 | 14 | +3 | Smallest sprocket, knurled inner ring (lockring cog) |

### Session 2: 16:15–16:16 (3 images, white paper on dark desk)

| Training File | Actual Teeth | Algo Result | Error | Notes |
|---|---|---|---|---|
| 16-15-39-652Z | 16 | 11 | -5 | Same 16T sprocket, different background. Good contrast |
| 16-16-09-444Z | 16 | 10 | -6 | Rotated orientation |
| 16-16-44-639Z | 16 | 10 | -6 | Another rotation. Slightly overexposed |

### Session 3: 18:49–18:54 (5 images, paper towel background)

| Training File | Actual Teeth | Algo Result | Error | Notes |
|---|---|---|---|---|
| 18-49-40-768Z | 14 | 32 | +18 | Medium sprocket. Algo wildly overestimated |
| 18-50-11-106Z | 14 | 10 | -4 | Same 14T sprocket, slightly different angle |
| 18-52-30-549Z | 16 | 0 | -16 | 16T sprocket. Algo failed completely (0 count) |
| 18-53-44-084Z | 16 | 11 | -5 | Close-up of 16T sprocket |
| 18-54-21-451Z | 14 | 0 | -14 | 14T sprocket. Algo failed completely (0 count) |

### Reports Without Photos (skipped)

| Debug Report | Algo Result | Notes |
|---|---|---|
| 05-39-43-689Z | 26 teeth, confidence 0 | No photo captured |
| 05-52-50-251Z | 27 teeth, confidence 0 | No photo captured |

## Algorithm Performance Summary

- **Images analyzed:** 12
- **Correct results:** 1/12 (8.3%)
- **Mean absolute error:** 7.1 teeth
- **Error range:** -16 to +18
- **Complete failures (0 count):** 2 images
- **Wildly incorrect (>10 error):** 3 images
- **All confidences near zero** (max 0.34), indicating the algorithm knows it is uncertain

## Distinct Sprockets in Dataset

1. **16T sprocket** — appears in 6 images (most common). Has lightening holes around inner diameter.
2. **14T sprocket** — appears in 3 images.
3. **13T sprocket** — appears in 1 image.
4. **12T sprocket** — appears in 1 image.
5. **11T sprocket** — appears in 1 image. Lockring-style cog with knurled inner ring.

## Image Quality Notes

- Paper towel backgrounds have heart/decorative patterns that may confuse edge detection
- Some images have debris/dirt near the sprocket
- Lighting varies: session 2 images are slightly overexposed; session 3 has mixed lighting
- Most images have good gear visibility with the full sprocket in frame
- The dark desk background in session 2 provides better contrast than paper towel
