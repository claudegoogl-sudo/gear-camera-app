"""
Device Image Test Suite - Validates gear detection algorithm against
device-captured training images with ground-truth labels.

Reads all labeled device photos from the training data directory,
runs the gear detection algorithm, and compares detected tooth count
vs actual_tooth_count from meta.json.
"""

import sys
import json
import glob
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from gear_tooth_counter import GearToothCounter

TRAINING_DIR = Path(__file__).parent.parent / "training-data"


def load_labeled_images():
    """Load all training images that have actual_tooth_count labels."""
    meta_files = sorted(TRAINING_DIR.glob("*_meta.json"))
    images = []
    skipped = 0

    for meta_path in meta_files:
        try:
            with open(meta_path, encoding="utf-8", errors="replace") as f:
                meta = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            print(f"  WARNING: Could not read {meta_path.name}: {e}")
            skipped += 1
            continue

        actual = meta.get("actual_tooth_count")
        if not actual:
            skipped += 1
            continue

        # Derive photo path from meta filename
        photo_path = TRAINING_DIR / meta_path.name.replace("_meta.json", "_photo.jpg")
        if not photo_path.exists():
            print(f"  WARNING: Photo missing for {meta_path.name}")
            skipped += 1
            continue

        images.append({
            "meta_path": meta_path,
            "photo_path": photo_path,
            "actual_tooth_count": int(actual),
            "timestamp": meta_path.name.replace("_meta.json", ""),
            "build": meta.get("build", "unknown"),
        })

    if skipped:
        print(f"  Skipped {skipped} images (unlabeled or unreadable)")

    return images


def run_algorithm(photo_path):
    """Run gear tooth detection on a single image using the full pipeline
    (includes high-res retry for small/low-confidence gears)."""
    counter = GearToothCounter(debug=False)
    result = counter.count(str(photo_path))
    return result["tooth_count"], result["confidence"]


def run_suite():
    """Run the full device image test suite."""
    print("=" * 70)
    print("DEVICE IMAGE TEST SUITE")
    print("=" * 70)
    print(f"Training data dir: {TRAINING_DIR}")
    print()

    images = load_labeled_images()
    if not images:
        print("ERROR: No labeled images found.")
        return []

    # Count per class
    class_counts = {}
    for img in images:
        tc = img["actual_tooth_count"]
        class_counts[tc] = class_counts.get(tc, 0) + 1
    print(f"Loaded {len(images)} labeled images")
    print(f"Classes: {dict(sorted(class_counts.items()))}")
    print()

    results = []
    for img in images:
        actual = img["actual_tooth_count"]
        detected, confidence = run_algorithm(img["photo_path"])
        passed = detected == actual
        error = abs(detected - actual) if detected else None

        results.append({
            "timestamp": img["timestamp"],
            "actual": actual,
            "detected": detected,
            "confidence": confidence,
            "passed": passed,
            "error": error,
        })

        status = "OK" if passed else "FAIL"
        det_str = str(detected) if detected else "ERR"
        conf_str = f"{confidence:.0%}" if confidence else "N/A"
        print(f"  [{status:4s}] {actual}T actual | {det_str:>3s} detected | conf {conf_str:>4s} | {img['timestamp']}")

    # --- Summary ---
    print()
    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)

    total = len(results)
    total_pass = sum(1 for r in results if r["passed"])
    print(f"Overall: {total_pass}/{total} ({100*total_pass/total:.1f}%)")
    print()

    # Per-class breakdown
    classes = sorted(set(r["actual"] for r in results))
    print(f"{'Class':>6s}  {'Pass':>5s}  {'Total':>5s}  {'Acc':>6s}  {'Errors'}")
    print("-" * 55)
    for tc in classes:
        cls_results = [r for r in results if r["actual"] == tc]
        cls_pass = sum(1 for r in cls_results if r["passed"])
        cls_total = len(cls_results)
        acc = 100 * cls_pass / cls_total if cls_total else 0
        errors = [r["detected"] for r in cls_results if not r["passed"]]
        err_str = ", ".join(str(e) for e in errors) if errors else "-"
        print(f"{tc:>4d}T  {cls_pass:>5d}  {cls_total:>5d}  {acc:>5.1f}%  {err_str}")

    # 11-15T subset
    range_11_15 = [r for r in results if 11 <= r["actual"] <= 15]
    if range_11_15:
        r_pass = sum(1 for r in range_11_15 if r["passed"])
        r_total = len(range_11_15)
        print()
        print(f"11-15T subset: {r_pass}/{r_total} ({100*r_pass/r_total:.1f}%)")

    print("=" * 70)
    return results


if __name__ == "__main__":
    run_suite()
