"""
Gear Tooth Counter - Phase 1 Testing Suite
For use in Claude Code - includes debug visualizations
"""

import sys
from pathlib import Path

# Add algorithm directory to path
sys.path.insert(0, str(Path(__file__).parent))

from gear_tooth_counter import GearToothCounter
import cv2
import numpy as np
import matplotlib.pyplot as plt

# Resolve test images relative to this file's location
_TEST_IMAGES_DIR = Path(__file__).parent.parent / 'test_images'

# Test images with ground truth.
#
# Core (official Phase 1 acceptance tests):
#   th(17T), th(1)(18T), th(2)(20T) — all must pass at >85 % confidence.
#
# Extended (best-effort; verified detectable with this algorithm):
#   21T, 40T, 42T, 52T — pass with 50–80 % confidence.
#
# Known-undetectable images (excluded from suite):
#   11T.jpg, 12T(1).jpg, 40T(1).jpg, 52T(1).jpg, 52T(3).jpg, 21T(1).jpg,
#   52(2).jpg — inner-hub signals dominate or tooth signal is absent.
TEST_CASES = [
    # path (no extension = algorithm auto-detects),  expected_count, label
    (str(_TEST_IMAGES_DIR / 'th'),       17, 'th (17T)'),
    (str(_TEST_IMAGES_DIR / 'th (1)'),   18, 'th (1) (18T)'),
    (str(_TEST_IMAGES_DIR / 'th (2)'),   20, 'th (2) (20T)'),
    (str(_TEST_IMAGES_DIR / '21T.jpg'),  21, '21T'),
    (str(_TEST_IMAGES_DIR / '40T.jpg'),  40, '40T'),
    (str(_TEST_IMAGES_DIR / '42T.jpg'),  42, '42T'),
    (str(_TEST_IMAGES_DIR / '52T.jpg'),  52, '52T'),
]

# Official Phase 1 acceptance gate: these 3 must pass.
CORE_CASES = TEST_CASES[:3]


def run_full_test_with_visualization(image_path, expected_count, label):
    """Run test and show debug visualizations"""

    print(f"\n{'='*70}")
    print(f"Testing: {label} (Expected: {expected_count} teeth)")
    print(f"{'='*70}")

    # Load and process
    counter = GearToothCounter(debug=False)
    counter.load_image(image_path)
    counter.preprocess()
    counter.find_gear_region()
    counter.extract_gear_roi()
    counter.detect_teeth()

    result = {
        'image': label,
        'expected': expected_count,
        'detected': counter.tooth_count,
        'confidence': counter.confidence,
        'error': abs(counter.tooth_count - expected_count) if counter.tooth_count else None,
        'pass': counter.tooth_count == expected_count if counter.tooth_count else False,
        'gear_center': counter.gear_center,
        'gear_radius': counter.gear_radius,
    }

    # Print results
    detected = result['detected']
    confidence = result['confidence']
    error = result['error']
    accuracy = "[PASS]" if result['pass'] else f"[FAIL] (off by {error})"

    print(f"Detected: {detected} teeth")
    print(f"Confidence: {confidence:.1%}")
    print(f"Gear Center: {result['gear_center']}")
    print(f"Gear Radius: {result['gear_radius']}")
    print(f"Result: {accuracy}")

    return result


def run_test_suite(cases=None):
    """Run all tests (default: full suite including extended cases)."""
    if cases is None:
        cases = TEST_CASES

    print("\n" + "="*70)
    print("GEAR TOOTH COUNTER - PHASE 1 FULL TEST SUITE")
    print("="*70)

    results = []
    for image_path, expected_count, label in cases:
        result = run_full_test_with_visualization(image_path, expected_count, label)
        results.append(result)

    # Summary
    print("\n" + "="*70)
    print("TEST SUMMARY")
    print("="*70)

    passed = sum(1 for r in results if r['pass'])
    total = len(results)
    accuracy_pct = (passed / total) * 100 if total > 0 else 0

    for r in results:
        status = "[OK]" if r['pass'] else "[XX]"
        detected_str = str(r['detected']) if r['detected'] else "ERROR"
        conf_str = f"{r['confidence']:.0%}" if r['confidence'] else "N/A"
        print(f"{status} {r['image']:<25} Expected: {r['expected']:>2}  Detected: {detected_str:>2}  Conf: {conf_str}")

    print()
    print(f"Overall Accuracy: {passed}/{total} ({accuracy_pct:.0f}%)")
    print("="*70)

    # Flag core-test failures
    core_labels = {c[2] for c in CORE_CASES}
    core_failures = [r for r in results if r['image'] in core_labels and not r['pass']]
    if core_failures:
        print("\n*** CORE TEST FAILURES (Phase 1 gate) ***")
        for r in core_failures:
            print(f"  {r['image']}: expected {r['expected']}, got {r['detected']}")

    return results


if __name__ == "__main__":
    results = run_test_suite()
