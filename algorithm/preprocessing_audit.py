"""
Preprocessing pipeline audit — saves images at each pipeline stage.

Generates visual evidence of what the algorithm sees at every step:
1. Original image (resized)
2. Grayscale
3. CLAHE enhanced
4. Gaussian blurred
5. Canny edges
6. Detected gear center + radius overlay
7. Composite summary panel

Also reports center-finding accuracy by comparing detected center
to image center (where the gear should be in device photos).
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

import cv2
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import json
import glob
from gear_tooth_counter import GearToothCounter


AUDIT_DIR = Path(__file__).parent.parent / 'debug' / 'preprocessing_audit'
AUDIT_DIR.mkdir(parents=True, exist_ok=True)

TEST_IMAGES_DIR = Path(__file__).parent.parent / 'test_images'
TRAINING_DATA_DIR = Path(__file__).parent.parent / 'training-data'


def audit_image(image_path, label, expected_teeth=None, output_dir=None):
    """Run full pipeline and save images at each preprocessing stage."""
    out_dir = output_dir or AUDIT_DIR
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    counter = GearToothCounter(debug=False)

    # Stage 1: Load and resize
    counter.load_image(str(image_path))
    original = counter.image.copy()
    gray = counter.gray.copy()
    h, w = gray.shape

    # Stage 2: CLAHE enhancement
    enhanced = counter._get_enhanced().copy()

    # Stage 3: Preprocessing (blur + Canny)
    counter.preprocess()
    edges = counter.edges.copy()

    # Stage 4: Gear region detection
    counter.find_gear_region()
    counter.extract_gear_roi()
    cx, cy = counter.gear_center
    r = counter.gear_radius

    # Stage 5: Tooth detection
    counter.detect_teeth()
    detected = counter.tooth_count
    confidence = counter.confidence

    # Also run the full count() to get retry logic
    counter2 = GearToothCounter(debug=False)
    result = counter2.count(str(image_path))
    final_count = result.get('tooth_count', 0)
    final_conf = result.get('confidence', 0)
    final_center = result.get('gear_center', (cx, cy))
    final_radius = result.get('gear_radius', r)

    # --- Save individual stage images ---

    # 1. Original
    cv2.imwrite(str(out_dir / f'{label}_1_original.jpg'), original)

    # 2. Grayscale
    cv2.imwrite(str(out_dir / f'{label}_2_grayscale.jpg'), gray)

    # 3. CLAHE enhanced
    cv2.imwrite(str(out_dir / f'{label}_3_clahe.jpg'), enhanced)

    # 4. Blurred (reconstruct)
    blurred = cv2.GaussianBlur(enhanced, (5, 5), 1.5)
    cv2.imwrite(str(out_dir / f'{label}_4_blurred.jpg'), blurred)

    # 5. Canny edges
    cv2.imwrite(str(out_dir / f'{label}_5_edges.jpg'), edges)

    # 6. Gear detection overlay on original
    overlay = original.copy()
    cv2.circle(overlay, (cx, cy), r, (0, 255, 0), 2)
    cv2.circle(overlay, (cx, cy), 4, (0, 0, 255), -1)
    # Draw image center crosshair
    img_cx, img_cy = w // 2, h // 2
    cv2.drawMarker(overlay, (img_cx, img_cy), (255, 0, 0), cv2.MARKER_CROSS, 20, 2)
    # If retry changed center, show that too
    if final_center != (cx, cy):
        fcx, fcy = final_center
        cv2.circle(overlay, (fcx, fcy), final_radius, (255, 255, 0), 2)
        cv2.circle(overlay, (fcx, fcy), 4, (255, 255, 0), -1)
    cv2.imwrite(str(out_dir / f'{label}_6_detection.jpg'), overlay)

    # --- Composite summary panel ---
    fig, axes = plt.subplots(2, 3, figsize=(18, 12))

    axes[0, 0].imshow(cv2.cvtColor(original, cv2.COLOR_BGR2RGB))
    axes[0, 0].set_title('1. Original (resized)', fontsize=11)
    axes[0, 0].axis('off')

    axes[0, 1].imshow(enhanced, cmap='gray')
    axes[0, 1].set_title('2. CLAHE Enhanced', fontsize=11)
    axes[0, 1].axis('off')

    axes[0, 2].imshow(edges, cmap='gray')
    axes[0, 2].set_title('3. Canny Edges', fontsize=11)
    axes[0, 2].axis('off')

    # Detection overlay
    det_img = original.copy()
    cv2.circle(det_img, (cx, cy), r, (0, 255, 0), 2)
    cv2.circle(det_img, (cx, cy), 4, (0, 0, 255), -1)
    cv2.drawMarker(det_img, (img_cx, img_cy), (255, 0, 0), cv2.MARKER_CROSS, 20, 2)
    axes[1, 0].imshow(cv2.cvtColor(det_img, cv2.COLOR_BGR2RGB))
    center_dist = np.sqrt((cx - img_cx)**2 + (cy - img_cy)**2)
    axes[1, 0].set_title(f'4. Center: ({cx},{cy}) r={r}\n'
                         f'Offset from img center: {center_dist:.0f}px', fontsize=10)
    axes[1, 0].axis('off')

    # CLAHE + gear circle
    enh_rgb = cv2.cvtColor(enhanced, cv2.COLOR_GRAY2RGB)
    cv2.circle(enh_rgb, (cx, cy), r, (0, 255, 0), 2)
    # Draw sampling annulus (85%-110% of r)
    cv2.circle(enh_rgb, (cx, cy), int(r * 0.85), (255, 100, 0), 1)
    cv2.circle(enh_rgb, (cx, cy), int(r * 1.10), (255, 100, 0), 1)
    axes[1, 1].imshow(enh_rgb)
    axes[1, 1].set_title('5. CLAHE + gear circle\n'
                         'Orange = FFT sampling annulus', fontsize=10)
    axes[1, 1].axis('off')

    # Angular intensity profile at gear radius
    n_a = 720
    angles = np.linspace(0, 2 * np.pi, n_a, endpoint=False)
    cos_a, sin_a = np.cos(angles), np.sin(angles)
    sample_r = int(r * 0.95)
    if sample_r > 0:
        px = np.clip((cx + sample_r * cos_a).astype(int), 0, w - 1)
        py = np.clip((cy + sample_r * sin_a).astype(int), 0, h - 1)
        intensity = enhanced[py, px].astype(float)
        from scipy import signal as sig
        sm = sig.savgol_filter(intensity, 21, 3, mode='wrap')
        deg = np.degrees(angles)
        axes[1, 2].plot(deg, intensity, 'b-', alpha=0.3, label='raw')
        axes[1, 2].plot(deg, sm, 'r-', linewidth=1.5, label='smoothed')
        axes[1, 2].set_xlabel('Angle (deg)')
        axes[1, 2].set_ylabel('Intensity')
        axes[1, 2].set_title(f'6. Angular intensity @ r={sample_r}', fontsize=10)
        axes[1, 2].legend(fontsize=8)
        axes[1, 2].grid(True, alpha=0.3)

    status = ''
    if expected_teeth is not None:
        status = 'PASS' if final_count == expected_teeth else 'FAIL'
    suptitle = f'{label}  |  Detected: {final_count}T @ {final_conf:.0%}'
    if expected_teeth is not None:
        suptitle += f'  |  Expected: {expected_teeth}T  [{status}]'
    fig.suptitle(suptitle, fontsize=14, fontweight='bold',
                 color='green' if status == 'PASS' else 'red' if status == 'FAIL' else 'black')
    plt.tight_layout()
    plt.savefig(str(out_dir / f'{label}_summary.png'), dpi=120)
    plt.close()

    return {
        'label': label,
        'expected': expected_teeth,
        'detected': final_count,
        'confidence': final_conf,
        'center': final_center,
        'radius': final_radius,
        'initial_center': (cx, cy),
        'initial_radius': r,
        'center_offset': center_dist,
        'image_size': (w, h),
        'pass': final_count == expected_teeth if expected_teeth else None,
    }


def audit_test_suite():
    """Audit phase1 test images."""
    cases = [
        (TEST_IMAGES_DIR / 'th', 17, 'phase1_17T'),
        (TEST_IMAGES_DIR / 'th (1)', 18, 'phase1_18T'),
        (TEST_IMAGES_DIR / 'th (2)', 20, 'phase1_20T'),
        (TEST_IMAGES_DIR / '21T.jpg', 21, 'phase1_21T'),
        (TEST_IMAGES_DIR / '40T.jpg', 40, 'phase1_40T'),
        (TEST_IMAGES_DIR / '42T.jpg', 42, 'phase1_42T'),
        (TEST_IMAGES_DIR / '52T.jpg', 52, 'phase1_52T'),
    ]
    out_dir = AUDIT_DIR / 'phase1'
    results = []
    for path, expected, label in cases:
        if path.exists():
            r = audit_image(path, label, expected, out_dir)
            results.append(r)
            status = 'PASS' if r['pass'] else 'FAIL'
            print(f'  [{status}] {label}: detected={r["detected"]}T '
                  f'conf={r["confidence"]:.0%} center={r["center"]} '
                  f'r={r["radius"]} offset={r["center_offset"]:.0f}px')
    return results


def audit_device_images():
    """Audit all labeled device images from training-data/."""
    out_dir = AUDIT_DIR / 'device'
    results = []
    meta_files = sorted(glob.glob(str(TRAINING_DATA_DIR / '*_meta.json')))
    for meta_path in meta_files:
        try:
            with open(meta_path) as f:
                meta = json.load(f)
        except Exception:
            continue
        actual = meta.get('actual_tooth_count')
        if actual is None:
            continue
        photo = meta['photoFile']
        if not Path(photo).exists():
            continue
        ts = Path(meta_path).stem.replace('_meta', '')
        label = f'device_{actual}T_{ts}'
        r = audit_image(photo, label, actual, out_dir)
        results.append(r)
        status = 'PASS' if r['pass'] else 'FAIL'
        print(f'  [{status}] {label}: detected={r["detected"]}T '
              f'conf={r["confidence"]:.0%} center={r["center"]} '
              f'r={r["radius"]} offset={r["center_offset"]:.0f}px')
    return results


def print_summary(phase1_results, device_results):
    """Print combined summary."""
    print('\n' + '='*70)
    print('PREPROCESSING AUDIT SUMMARY')
    print('='*70)

    for name, results in [('Phase 1', phase1_results), ('Device', device_results)]:
        total = len(results)
        passed = sum(1 for r in results if r['pass'])
        offsets = [r['center_offset'] for r in results]
        print(f'\n{name} ({passed}/{total} = {100*passed/total:.0f}%):')
        print(f'  Center offset: mean={np.mean(offsets):.1f}px '
              f'median={np.median(offsets):.1f}px '
              f'max={np.max(offsets):.1f}px')
        failures = [r for r in results if not r['pass']]
        if failures:
            print(f'  Failures:')
            for r in failures:
                print(f'    {r["label"]}: expected={r["expected"]} '
                      f'detected={r["detected"]} offset={r["center_offset"]:.0f}px')

    print(f'\nOutput saved to: {AUDIT_DIR}/')


if __name__ == '__main__':
    print('='*70)
    print('PREPROCESSING PIPELINE AUDIT')
    print('='*70)

    print('\n--- Phase 1 Test Images ---')
    p1 = audit_test_suite()

    print('\n--- Device Images ---')
    dev = audit_device_images()

    print_summary(p1, dev)
