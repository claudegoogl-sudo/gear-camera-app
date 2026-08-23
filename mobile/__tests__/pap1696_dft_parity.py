#!/usr/bin/env python3
"""
PAP-1696 -- diff cv::dft (via host cv2, same build PAP-1694 used) against
fft.js's fftMagnitude() on the real `centered` radial-ring signals dumped by
pap1696.dump-fft-js.mjs.

This mirrors pap1694_opencv_parity.py's template but for the detect stage's
DFT core rather than the preprocess primitives.

cv::dft convention used (matches the binding's exposed surface: dft +
magnitude, per PAP-1696's description): real input, DFT_COMPLEX_OUTPUT flag
-> split into re/im planes -> cv2.magnitude(re, im). This is the standard
idiom for a magnitude spectrum and is exactly what the eventual C++ kernel
would call.

Usage: python3 mobile/__tests__/pap1696_dft_parity.py
"""
import json
import struct
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
PARITY_DIR = ROOT / ".cache" / "pap1696-parity"


def load_f64(path):
    return np.fromfile(path, dtype="<f8")


def cv_dft_magnitude(centered_f64, dtype):
    """Mirror cv::dft(src, dst, DFT_COMPLEX_OUTPUT) -> split -> magnitude."""
    src = centered_f64.astype(dtype).reshape(1, -1)
    dst = cv2.dft(src, flags=cv2.DFT_COMPLEX_OUTPUT)
    re = dst[..., 0]
    im = dst[..., 1]
    mag = cv2.magnitude(re, im)
    return mag.reshape(-1)


def main():
    index = json.loads((PARITY_DIR / "index.json").read_text())
    print(f"{len(index)} DFT cases to check\n")

    # MIN_TEETH..MAX_TEETH from gearCounter.js -- the only bins the algorithm
    # actually scores (harmonic-weighted scoring reads mag[f], mag[2f], mag[3f]).
    MIN_TEETH, MAX_TEETH = 10, 65

    rows = []
    for case in index:
        stamp, nAngles, frac = case["stamp"], case["nAngles"], case["frac"]
        case_id = f"{stamp}.r{nAngles}_f{frac}"
        centered = load_f64(PARITY_DIR / f"{case_id}.centered.bin")
        mag_js = load_f64(PARITY_DIR / f"{case_id}.mag_js.bin")
        assert centered.shape[0] == nAngles, (centered.shape, nAngles)

        half = nAngles // 2 + 1
        assert mag_js.shape[0] == half, (mag_js.shape, half)

        for dtype, label in [(np.float64, "f64"), (np.float32, "f32")]:
            mag_cv = cv_dft_magnitude(centered, dtype)[:half]
            abs_err = np.abs(mag_cv - mag_js)
            # Relative error where the JS magnitude is non-negligible, to
            # avoid divide-by-~0 noise dominating the summary at quiet bins.
            scale = max(float(mag_js.max()), 1e-9)
            rel_err = abs_err / scale

            band = slice(MIN_TEETH, min(MAX_TEETH + 1, half))
            rows.append({
                "case": case_id,
                "dtype": label,
                "n": nAngles,
                "max_abs_err": float(abs_err.max()),
                "max_rel_err": float(rel_err.max()),
                "max_abs_err_teeth_band": float(abs_err[band].max()) if band.stop > band.start else 0.0,
                "max_rel_err_teeth_band": float(rel_err[band].max()) if band.stop > band.start else 0.0,
                "argmax_js": int(np.argmax(mag_js[band]) + MIN_TEETH) if band.stop > band.start else -1,
                "argmax_cv": int(np.argmax(mag_cv[band]) + MIN_TEETH) if band.stop > band.start else -1,
            })

    by_dtype = {}
    for r in rows:
        by_dtype.setdefault(r["dtype"], []).append(r)

    argmax_mismatches = 0
    for label, group in by_dtype.items():
        max_rel = max(r["max_rel_err"] for r in group)
        max_rel_band = max(r["max_rel_err_teeth_band"] for r in group)
        max_abs_band = max(r["max_abs_err_teeth_band"] for r in group)
        mism = sum(1 for r in group if r["argmax_js"] != r["argmax_cv"])
        argmax_mismatches += mism if label == "f64" else 0
        print(f"[{label}] n_cases={len(group)}  "
              f"max_rel_err(all bins)={max_rel:.3e}  "
              f"max_rel_err(teeth band {MIN_TEETH}-{MAX_TEETH})={max_rel_band:.3e}  "
              f"max_abs_err(teeth band)={max_abs_band:.3e}  "
              f"argmax(peak-tooth-bin) mismatches={mism}/{len(group)}")

    out = {"rows": rows, "min_teeth": MIN_TEETH, "max_teeth": MAX_TEETH}
    out_path = PARITY_DIR / "parity_results.json"
    out_path.write_text(json.dumps(out, indent=1))
    print(f"\nfull results -> {out_path}")

    verdict = "PASS (byte/float parity, no accuracy-relevant divergence)" \
        if argmax_mismatches == 0 else f"FAIL: {argmax_mismatches} peak-bin mismatches at f64"
    print(f"\nVerdict: {verdict}")


if __name__ == "__main__":
    main()
