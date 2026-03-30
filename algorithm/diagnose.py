"""
Diagnostic script — saves debug images and polar plots for each test image.
Run from the algorithm/ directory.
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

import cv2
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from scipy import signal
from gear_tooth_counter import GearToothCounter

TEST_IMAGES_DIR = Path(__file__).parent.parent / 'test_images'
DEBUG_DIR = Path(__file__).parent.parent / 'debug'
DEBUG_DIR.mkdir(exist_ok=True)

CASES = [
    (TEST_IMAGES_DIR / 'th',      17, 'th_17T'),
    (TEST_IMAGES_DIR / 'th (1)',  18, 'th1_18T'),
    (TEST_IMAGES_DIR / 'th (2)',  20, 'th2_20T'),
]


def diagnose(image_path, expected, label):
    print(f"\n--- {label} (expected {expected}T) ---")

    counter = GearToothCounter(debug=False)
    counter.load_image(str(image_path))
    counter.preprocess()
    counter.find_gear_region()
    counter.extract_gear_roi()

    x, y = counter.gear_center
    r = counter.gear_radius
    h, w = counter.gray.shape
    print(f"  Image size : {w}x{h}")
    print(f"  Gear center: ({x}, {y})   radius: {r}")

    # ── 1. Edges + detected circle ──────────────────────────────────────────
    fig, axes = plt.subplots(1, 3, figsize=(18, 6))
    axes[0].imshow(cv2.cvtColor(counter.image, cv2.COLOR_BGR2RGB))
    axes[0].set_title('Original')
    axes[0].axis('off')

    edges_rgb = cv2.cvtColor(counter.edges, cv2.COLOR_GRAY2RGB)
    cv2.circle(edges_rgb, (x, y), r, (0, 255, 0), 2)
    cv2.circle(edges_rgb, (x, y), 3, (255, 0, 0), -1)
    axes[1].imshow(edges_rgb)
    axes[1].set_title(f'Edges + Hough circle  r={r}')
    axes[1].axis('off')

    # ── 2. Polar radius profile ──────────────────────────────────────────────
    angles = np.linspace(0, 2 * np.pi, 360)
    radii = []
    for angle in angles:
        distances = np.linspace(r - 20, r + 30, 50)
        samples = []
        for dist in distances:
            px = int(x + dist * np.cos(angle))
            py = int(y + dist * np.sin(angle))
            if 0 <= px < w and 0 <= py < h:
                samples.append(counter.edges[py, px])
        if samples:
            peak_idx = np.argmax(samples)
            peak_dist = (r - 20) + peak_idx * (50 / len(samples))
            radii.append(peak_dist)
        else:
            radii.append(r)

    radii = np.array(radii)
    radii_smooth = signal.savgol_filter(radii, window_length=9, polyorder=3)

    # current peaks (distance=2 — what the algorithm actually uses)
    peaks_loose, _ = signal.find_peaks(
        radii_smooth,
        height=np.std(radii_smooth) * 0.5,
        distance=2,
        prominence=np.std(radii_smooth) * 0.3,
    )
    # peaks with tighter distance (360 / 65 ≈ 5)
    min_dist = max(4, int(360 / 65))
    peaks_tight, _ = signal.find_peaks(
        radii_smooth,
        height=np.std(radii_smooth) * 0.5,
        distance=min_dist,
        prominence=np.std(radii_smooth) * 0.3,
    )

    deg = angles * 180 / np.pi
    axes[2].plot(deg, radii,        'b-',  alpha=0.4, label='raw')
    axes[2].plot(deg, radii_smooth, 'g-',  linewidth=2, label='smoothed')
    axes[2].plot(deg[peaks_loose],  radii_smooth[peaks_loose],
                 'rv', markersize=8, label=f'peaks dist=2  ({len(peaks_loose)})')
    axes[2].plot(deg[peaks_tight],  radii_smooth[peaks_tight],
                 'b^', markersize=8, label=f'peaks dist={min_dist} ({len(peaks_tight)})')
    axes[2].axhline(r, color='gray', linestyle='--', alpha=0.5, label=f'Hough r={r}')
    axes[2].set_xlabel('Angle (deg)')
    axes[2].set_ylabel('Peak radius (px)')
    axes[2].set_title(f'Polar profile  — expected {expected}T')
    axes[2].legend(fontsize=8)
    axes[2].grid(True, alpha=0.3)

    # Profile stats
    print(f"  Radii range: {radii.min():.1f} – {radii.max():.1f}  "
          f"std={radii.std():.2f}  smooth_std={radii_smooth.std():.2f}")
    print(f"  Peaks (dist=2):   {len(peaks_loose)}")
    print(f"  Peaks (dist={min_dist}):   {len(peaks_tight)}")
    expected_spacing = 360 / expected
    print(f"  Expected spacing: {expected_spacing:.1f} deg  ({expected}T)")

    plt.suptitle(label, fontsize=14)
    plt.tight_layout()
    out = DEBUG_DIR / f'{label}_diag.png'
    plt.savefig(out, dpi=120)
    plt.close()
    print(f"  Saved: {out}")


for img_path, exp, lbl in CASES:
    diagnose(img_path, exp, lbl)

print("\nDone — check debug/ folder.")
