# Bicycle Gear Tooth Counter - Phase 1 Handoff to Claude Code

## Project Context

**Goal**: Build a mobile app that counts bicycle gear teeth from live camera feed using procedural computer vision (no ML/LLM).

**Current Phase**: Phase 1 - Algorithm Development & Validation

**Status**: Algorithm skeleton built, needs parameter tuning to achieve 100% accuracy on test set.

---

## Quick Summary

- **App**: Mobile (React Native) gear tooth counter with live feed → auto-capture with flash → tooth detection → overlay + result
- **Scope**: Single gears only (chainrings, rear sprockets, belt drive sprockets) - 15-60 teeth range
- **Your task**: Tune the tooth detection algorithm to work perfectly on real gear photos
- **Success criterion**: 100% accuracy on provided test images (detect exact tooth count, no off-by-one errors)

---

## Test Dataset (Ground Truth)

You have 3 validated gear images:

| Image | File | Expected Teeth | Type | Notes |
|-------|------|----------------|------|-------|
| 1 | `th` | 17 | Rear sprocket | 474x474 px |
| 2 | `th__1_` | 18 | Rear sprocket | 200x200 px (small) |
| 3 | `th__2_` | 20 | Rear sprocket | 474x475 px |

All located in `/home/claude/test_images/`

---

## Current Algorithm Status

**Files**:
- `/home/claude/gear_tooth_counter.py` — Main algorithm class
- `/home/claude/phase1_test_suite.py` — Testing harness

**Current Results** (0/3 accuracy):
```
❌ th (17T)       Detected:  8 teeth  Conf: 98%  (off by 9)
❌ th__1_ (18T)   Detected: 24 teeth  Conf: 97%  (off by 6)
❌ th__2_ (20T)   Detected: 14 teeth  Conf: 99%  (off by 6)
```

**Problem**: Peak detection in polar coordinate space is not matching teeth correctly. High false confidence indicates thresholds are too lenient.

---

## Algorithm Overview

The tooth counting approach:

```
1. Load image
2. Convert to grayscale + Gaussian blur
3. Canny edge detection
4. Circular Hough transform to find gear region (center + radius)
5. Extract gear ROI (region of interest)
6. Convert gear edge to polar coordinates (angle vs. radius)
7. Smooth radius profile with Savitzky-Golay filter
8. Find peaks in smoothed profile = tooth peaks
9. Count peaks = tooth count
10. Calculate confidence from peak uniformity
```

### Key Parameters to Tune

**In `preprocess()` method:**
- `cv2.GaussianBlur(blurred, (5, 5), 1.5)` — Kernel size and sigma
- `cv2.Canny(blurred, 50, 150)` — Lower and upper thresholds (currently 50, 150)

**In `find_gear_region()` method:**
- `cv2.HoughCircles()` parameters:
  - `param1=50` — Upper threshold for Canny (internal)
  - `param2=30` — Accumulator threshold (lower = more circles detected)
  - `minRadius=30, maxRadius=300` — Gear size bounds

**In `detect_teeth()` method:**
- `angles = np.linspace(0, 2 * np.pi, 360)` — Angular resolution (1° per sample)
- `distances = np.linspace(r - 20, r + 30, 50)` — Ray sampling range from gear center
- `window_length=9, polyorder=3` in `signal.savgol_filter()` — Smoothing aggressiveness
- `height=np.std(radii_smooth) * 0.5` — Peak height threshold
- `distance=2` — Minimum angular separation between peaks
- `prominence=np.std(radii_smooth) * 0.3` — Peak prominence threshold

---

## Debugging Strategy

### Step 1: Add Visualizations
Modify `detect_teeth()` to show:
1. **Edges image** — Are tooth edges being detected?
2. **Gear region** — Is the circular Hough finding the gear correctly?
3. **Polar plot** — Plot radius vs. angle; mark detected peaks
4. **Peak spacing histogram** — Are peaks evenly spaced?

### Step 2: Identify Root Cause
For each failing test:
- Are edges being detected on tooth tips?
- Is the gear circle found accurately?
- Are peaks appearing at tooth locations in polar space?
- Are false peaks being detected?

### Step 3: Tune Parameters Iteratively
1. Start with edge detection — maybe Canny thresholds need adjustment
2. Then Hough circle detection — ensure gear is found correctly
3. Then smoothing window — too aggressive smoothing loses peaks
4. Then peak detection thresholds — height/prominence/distance

### Step 4: Re-test
Run `python3 /home/claude/phase1_test_suite.py` after each change to see results.

---

## How to Proceed

### Immediate Actions:
1. **Run the test suite**: `python3 /home/claude/phase1_test_suite.py`
2. **Enable debug mode** in `GearToothCounter` (set `debug=True`)
3. **Add visualization code** to see what's happening at each step
4. **Test one parameter at a time** — change one thing, re-test
5. **Track improvements** — document what works

### Key Questions to Answer:
- Are the edges being detected cleanly on the teeth?
- Is the Hough circle finding the gear center/radius correctly?
- In the polar plot, do peaks appear at tooth locations?
- How sensitive is peak detection to smoothing parameters?

### Expected Outcome:
When algorithm achieves 100% accuracy on all 3 test images, you'll:
- Have validated the core algorithm works
- Have documented which parameters matter most
- Be ready to add more test images (you have 3 more high-res images ready)
- Move to Phase 2 (mobile app implementation)

---

## File Locations

```
/home/claude/
├── gear_tooth_counter.py          ← Main algorithm
├── phase1_test_suite.py           ← Test harness
├── test_images/                   ← Test gear photos
│   ├── th                         (17T)
│   ├── th__1_                     (18T)
│   └── th__2_                     (20T)
└── [outputs will be saved here]
```

---

## Success Criteria

✅ Algorithm must achieve **100% accuracy** on all 3 test images (exact tooth count, no ±1 errors)
✅ All detections must have **>85% confidence** (indicator of robust detection)
✅ Algorithm must complete in **<2 seconds per image** (for mobile real-time use)
✅ Code must be **well-commented** for mobile implementation later

---

## Next Phase (After Algorithm Works)

Once Phase 1 algorithm is validated:
- Phase 2: Mobile app scaffold (React Native setup)
- Phase 3: Motion detection (frame differencing)
- Phase 4: Integration (camera capture + flash + algorithm)
- Phase 5: UI (results display + contour overlay + reset button)
- Phase 6: Testing & polish

---

## Notes for Claude Code

- This is a **parameter tuning task**, not a from-scratch build
- The algorithm *should* work — just needs the right thresholds
- Small gears (15-20T) and large gears (50-60T) will have different characteristics — focus on 15-20T range first
- Real-world gears have wear, dirt, rust — algorithm needs to be robust
- The dev plan emphasizes ±0 tolerance (off-by-one is a failure)

**Questions to ask yourself:**
- What if I visualized what the algorithm sees at each step?
- What if the smoothing is too aggressive/not aggressive enough?
- What if the peak detection is catching noise instead of teeth?
- What if the gear isn't being detected correctly by Hough circles?

---

## Contact & Context

User is building this for their bicycle workshop. They have real gears and will provide more test images as algorithm improves. The eventual app will be used in a real workshop environment with varying lighting, angles, and gear conditions.

Good luck! 🚀
