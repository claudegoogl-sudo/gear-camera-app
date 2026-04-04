"""
Bicycle Gear Tooth Counter - Phase 1 Algorithm Prototype
Desktop Python implementation for tooth counting algorithm validation

Core approach:
1. Load gear image
2. Convert to grayscale + CLAHE enhancement
3. Apply edge detection (Canny)
4. Find gear center via Hough Circle Transform
5. Build candidate radii from radial edge-density peaks + evenly-spaced outer band
6. At each candidate radius, sample intensity and run FFT to score tooth count
7. Pick outermost candidate with rel-purity >= threshold (avoids inner hub bias)
8. Cross-check with outer-profile scan (outermost edge per angle) using sub-harmonic doubling
9. Apply decision rule and return count + confidence
"""

import cv2
import numpy as np
import matplotlib.pyplot as plt
from scipy import signal
import os
from pathlib import Path


class GearToothCounter:
    """Main class for detecting and counting gear teeth"""

    # Gear tooth count search range
    MIN_TEETH = 10
    MAX_TEETH = 65

    def __init__(self, debug=True):
        """
        Initialize the counter

        Args:
            debug (bool): If True, display intermediate processing steps
        """
        self.debug = debug
        self.image = None
        self.gray = None
        self.edges = None
        self.gear_center = None
        self.gear_radius = None
        self.tooth_count = None
        self.confidence = None

    def load_image(self, image_path):
        """Load image from file and resize so max dimension <= 1000 px."""
        self.image = cv2.imread(image_path)
        if self.image is None:
            raise FileNotFoundError(f"Could not load image: {image_path}")

        h0, w0 = self.image.shape[:2]
        max_dim = max(h0, w0)
        if max_dim > 1000:
            scale = 1000.0 / max_dim
            self.image = cv2.resize(
                self.image,
                (max(1, int(w0 * scale)), max(1, int(h0 * scale))),
            )

        self.gray = cv2.cvtColor(self.image, cv2.COLOR_BGR2GRAY)
        return self

    def preprocess(self):
        """CLAHE contrast enhancement + Gaussian blur + Canny edge detection."""
        clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(self.gray)
        blurred = cv2.GaussianBlur(enhanced, (5, 5), 1.5)
        self.edges = cv2.Canny(blurred, 50, 150)

        if self.debug:
            self._show_image("Edges", self.edges)

        return self

    def find_gear_region(self):
        """
        Detect gear center via center-weighted edge centroid (primary) with
        Hough Circle Transform as a secondary signal, then refine the radius
        by finding the outermost significant ring in the radial edge-density
        profile.

        The center-weighted centroid applies a 2-D Gaussian weight so that
        edge pixels near the image borders (paper-towel texture, table
        clutter) have much less influence than edges near the middle of the
        photo where the gear is expected.
        """
        h, w = self.edges.shape

        # ── Primary: iterative centre refinement ─────────────────────────
        # Pass 1 — coarse: start from the IMAGE CENTRE (user is expected
        #   to roughly centre the gear in the viewfinder) and compute a
        #   preliminary radial density profile to find an approximate gear
        #   radius.
        # Pass 2 — refined: recompute the centroid using only edges within
        #   [0.3r, 1.4r] of the image centre, which isolates the gear ring
        #   from far-away clutter.
        cx, cy = w // 2, h // 2

        y_all, x_all = np.where(self.edges > 0)
        if len(x_all) == 0:
            cx, cy = w // 2, h // 2

        # ── Secondary: Hough circles (nudge toward if close) ────────────
        circles = cv2.HoughCircles(
            self.edges,
            cv2.HOUGH_GRADIENT,
            dp=2,
            minDist=50,
            param1=50,
            param2=30,
            minRadius=30,
            maxRadius=min(h, w) // 2,
        )

        if circles is not None:
            circles = np.uint16(np.around(circles))
            hx, hy = int(circles[0][0][0]), int(circles[0][0][1])
            # Blend towards Hough centre only if it is reasonably close
            if abs(hx - cx) < w * 0.15 and abs(hy - cy) < h * 0.15:
                cx = (cx + hx) // 2
                cy = (cy + hy) // 2

        cx = int(np.clip(cx, 0, w - 1))
        cy = int(np.clip(cy, 0, h - 1))

        # Radial edge-density profile → pick outermost significant peak as radius
        y_idx, x_idx = np.where(self.edges > 0)
        dists = np.sqrt((x_idx - cx) ** 2 + (y_idx - cy) ** 2).astype(int)
        max_r = int(min(cx, w - cx, cy, h - cy)) - 1
        if max_r < 20:
            max_r = min(h, w) // 3

        valid = dists < max_r
        density = np.bincount(dists[valid], minlength=max_r).astype(float)
        win = max(5, (max_r // 8) | 1)
        density_smooth = signal.savgol_filter(density, win, 3)

        search_limit = int(max_r * 0.90)
        peaks, _ = signal.find_peaks(
            density_smooth[:search_limit],
            height=density_smooth[:search_limit].max() * 0.12,
            distance=8,
        )

        if len(peaks) > 0:
            outer_r = int(peaks[-1])
        else:
            outer_r = max_r // 2

        # ── Pass 2: refine centre using only edges near gear ring ────────
        # Keep edges within [0.3·r, 1.4·r] to exclude far-away clutter.
        ring_lo = int(outer_r * 0.3)
        ring_hi = int(outer_r * 1.4)
        ring_mask = (dists >= ring_lo) & (dists <= ring_hi) & valid
        if ring_mask.sum() > 20:
            rx, ry = x_idx[ring_mask], y_idx[ring_mask]
            cx = int(np.round(rx.mean()))
            cy = int(np.round(ry.mean()))
            cx = int(np.clip(cx, 0, w - 1))
            cy = int(np.clip(cy, 0, h - 1))

            # Recompute density from refined centre
            dists2 = np.sqrt((x_idx - cx) ** 2 + (y_idx - cy) ** 2).astype(int)
            max_r2 = int(min(cx, w - cx, cy, h - cy)) - 1
            if max_r2 >= 30:
                valid2 = dists2 < max_r2
                density2 = np.bincount(dists2[valid2], minlength=max_r2).astype(float)
                win2 = max(5, (max_r2 // 8) | 1)
                ds2 = signal.savgol_filter(density2, win2, 3)
                sl2 = int(max_r2 * 0.90)
                p2, _ = signal.find_peaks(
                    ds2[:sl2], height=ds2[:sl2].max() * 0.12, distance=8
                )
                if len(p2) > 0:
                    outer_r = int(p2[-1])

        self.gear_center = (cx, cy)
        self.gear_radius = outer_r

        if self.debug:
            debug_img = self.image.copy()
            cv2.circle(debug_img, self.gear_center, self.gear_radius, (0, 255, 0), 2)
            self._show_image("Detected Gear Circle", debug_img)

        return self

    def extract_gear_roi(self, padding=20):
        """Extract region of interest around gear."""
        x, y = self.gear_center
        r = self.gear_radius + padding

        y1 = max(0, y - r)
        y2 = min(self.gray.shape[0], y + r)
        x1 = max(0, x - r)
        x2 = min(self.gray.shape[1], x + r)

        self.gear_roi = self.gray[y1:y2, x1:x2]
        self.roi_offset = (x1, y1)
        return self

    def detect_teeth(self):
        """
        Tooth detection via two complementary methods:

        1. Multi-radius FFT scan: evaluate intensity-based FFT at each
           candidate radius (radial edge-density peaks + evenly-spaced outer
           band).  The outermost candidate with spectral purity >= 0.12 is
           chosen to avoid being fooled by the inner hub ring, which often has
           higher absolute contrast but a lower tooth count.

        2. Outer-profile scan: for each angle sample outward from the gear
           center to find the outermost edge pixel.  FFT on this radial profile
           gives a tooth count that is independent of which radial slice is
           sampled.  A sub-harmonic doubling rule corrects the case where a
           symmetric tooth geometry produces a dominant half-frequency.

        Decision:
        - Use multi-radius result if rel-purity >= 0.15 and tooth count >= 15.
        - Otherwise fall back to outer-profile result if its rel-purity >= 0.10.
        - Final fallback: highest-purity multi-radius candidate.

        Confidence is a linear ramp: 0 % at rel = 0.05, 100 % at rel = 0.20.
        """
        cx, cy = self.gear_center
        h, w = self.gray.shape

        # ── Build radial edge-density and candidate radii ─────────────────
        y_idx, x_idx = np.where(self.edges > 0)
        dists = np.sqrt((x_idx - cx) ** 2 + (y_idx - cy) ** 2).astype(int)
        max_r = int(min(cx, w - cx, cy, h - cy)) - 1
        if max_r < 20:
            max_r = min(h, w) // 3

        valid = dists < max_r
        density = np.bincount(dists[valid], minlength=max_r).astype(float)
        win = max(5, (max_r // 8) | 1)
        dens_smooth = signal.savgol_filter(density, win, 3)

        search_limit = int(max_r * 0.90)
        peaks, props = signal.find_peaks(
            dens_smooth[:search_limit],
            height=dens_smooth[:search_limit].max() * 0.12,
            distance=8,
        )

        # Keep only the top-10 peaks by height (avoids many noisy small peaks)
        if len(peaks) > 10:
            top_idx = np.argsort(props["peak_heights"])[-10:]
            cand_set = {int(peaks[i]) for i in top_idx}
        else:
            cand_set = {int(p) for p in peaks} if len(peaks) > 0 else {max_r // 2}

        # Always include evenly-spaced outer radii (65–93 % of max_r)
        for frac in [0.65, 0.72, 0.79, 0.86, 0.93]:
            cand_set.add(int(max_r * frac))

        candidates = sorted(cand_set)

        # ── FFT tooth count at a single radius ───────────────────────────
        def _fft_count(r_val):
            n_a = 360
            angles = np.linspace(0, 2 * np.pi, n_a, endpoint=False)
            px = np.clip((cx + r_val * np.cos(angles)).astype(int), 0, w - 1)
            py = np.clip((cy + r_val * np.sin(angles)).astype(int), 0, h - 1)
            intensity = self.gray[py, px].astype(float)

            win2 = max(5, (n_a // 45) | 1)
            i_sm = signal.savgol_filter(intensity, win2, 3)
            fft_mag = np.abs(np.fft.rfft(i_sm - i_sm.mean()))

            freqs = np.arange(len(fft_mag))
            mask = (freqs >= self.MIN_TEETH) & (freqs <= self.MAX_TEETH)
            if not mask.any():
                return 0, 0.0

            cf = freqs[mask]
            scores = np.array([
                fft_mag[f]
                + (0.5 * fft_mag[2 * f] if 2 * f < len(fft_mag) else 0.0)
                + (0.25 * fft_mag[3 * f] if 3 * f < len(fft_mag) else 0.0)
                for f in cf
            ])
            best = int(np.argmax(scores))
            total = scores.sum()
            return int(cf[best]), float(scores[best] / total) if total > 0 else 0.0

        # ── Evaluate all candidates; pick outermost with rel >= 0.12 ─────
        cand_results = [
            (r_val, *_fft_count(r_val))
            for r_val in candidates
            if 10 <= r_val < max_r
        ]

        MIN_REL = 0.12
        peak_tc, peak_rel, peak_r = 0, 0.0, 0
        for r_val, tc, rel in sorted(cand_results, key=lambda x: -x[0]):
            if rel >= MIN_REL:
                peak_tc, peak_rel, peak_r = tc, rel, r_val
                break
        if peak_tc == 0 and cand_results:
            r_val, tc, rel = max(cand_results, key=lambda x: x[2])
            peak_tc, peak_rel, peak_r = tc, rel, r_val

        # ── Outer-profile scan (vectorised) ──────────────────────────────
        n_op = 720
        angles_op = np.linspace(0, 2 * np.pi, n_op, endpoint=False)
        cos_op = np.cos(angles_op)
        sin_op = np.sin(angles_op)

        outer_radii = np.zeros(n_op)
        for r_scan in np.arange(int(max_r * 0.95), 10, -3, dtype=float):
            px = np.clip((cx + r_scan * cos_op).astype(int), 0, w - 1)
            py = np.clip((cy + r_scan * sin_op).astype(int), 0, h - 1)
            hit = self.edges[py, px] > 0
            outer_radii[hit & (outer_radii == 0)] = r_scan
        outer_radii[outer_radii == 0] = 10.0  # fill misses with minimum

        win3 = max(5, (n_op // 45) | 1)
        op_ac = signal.savgol_filter(outer_radii, win3, 3)
        op_ac -= op_ac.mean()
        op_fft = np.abs(np.fft.rfft(op_ac))

        freqs_op = np.arange(len(op_fft))
        mask_op = (freqs_op >= self.MIN_TEETH) & (freqs_op <= self.MAX_TEETH)
        if mask_op.any():
            cf_op = freqs_op[mask_op]
            sc_op = np.array([
                op_fft[f]
                + (0.5 * op_fft[2 * f] if 2 * f < len(op_fft) else 0.0)
                + (0.25 * op_fft[3 * f] if 3 * f < len(op_fft) else 0.0)
                for f in cf_op
            ])
            best_op = int(np.argmax(sc_op))
            op_tc = int(cf_op[best_op])
            total_op = sc_op.sum()
            op_rel = float(sc_op[best_op] / total_op) if total_op > 0 else 0.0

            # Sub-harmonic doubling: if 2f is nearly as strong as f, use 2f
            if op_tc <= self.MAX_TEETH // 2 and 2 * op_tc <= self.MAX_TEETH:
                f1, f2 = op_tc, 2 * op_tc
                s1 = op_fft[f1] + (0.5 * op_fft[min(2 * f1, len(op_fft) - 1)])
                s2 = op_fft[f2] + (0.5 * op_fft[min(2 * f2, len(op_fft) - 1)])
                if s2 >= 0.75 * s1:
                    op_tc = f2
        else:
            op_tc, op_rel = 0, 0.0

        # ── Decision rule ────────────────────────────────────────────────
        if peak_rel >= 0.15 and peak_tc >= 15:
            # Strong density-peak signal with a plausible tooth count
            final_tc = peak_tc
            final_rel = peak_rel
        elif op_tc > 0 and op_rel >= 0.10:
            # Outer profile has a decent signal
            final_tc = op_tc
            final_rel = op_rel
        elif peak_tc > 0:
            # Fallback: best density-peak candidate
            final_tc = peak_tc
            final_rel = peak_rel
        else:
            final_tc = 0
            final_rel = 0.0

        self.tooth_count = final_tc
        self.gear_radius = peak_r  # update with the winning radius

        # Confidence: linear ramp  rel=0.05 → 0 %,  rel=0.20 → 100 %
        self.confidence = float(min(1.0, max(0.0, (final_rel - 0.05) / 0.15)))

        if self.debug:
            self._debug_plot(peak_tc, peak_rel, peak_r, op_tc, op_rel)

        return self

    # ── Public pipeline ──────────────────────────────────────────────────────

    def count(self, image_path):
        """
        Complete pipeline: load → preprocess → find gear → detect teeth.

        Args:
            image_path (str): Path to gear image

        Returns:
            dict: {
                'tooth_count': int,
                'confidence': float (0.0–1.0),
                'success': bool
            }
        """
        try:
            self.load_image(image_path)
            self.preprocess()
            self.find_gear_region()
            self.extract_gear_roi()
            self.detect_teeth()

            return {
                "tooth_count": self.tooth_count,
                "confidence": float(self.confidence),
                "success": True,
                "gear_center": self.gear_center,
                "gear_radius": self.gear_radius,
            }

        except Exception as e:
            return {
                "tooth_count": None,
                "confidence": 0.0,
                "success": False,
                "error": str(e),
            }

    # ── Debug helpers ────────────────────────────────────────────────────────

    def _debug_plot(self, peak_tc, peak_rel, peak_r, op_tc, op_rel):
        """Show intensity profile and FFT spectrum at the winning radius."""
        cx, cy = self.gear_center
        h, w = self.gray.shape
        r = peak_r if peak_r > 0 else self.gear_radius

        n_a = 360
        angles = np.linspace(0, 2 * np.pi, n_a, endpoint=False)
        px = np.clip((cx + r * np.cos(angles)).astype(int), 0, w - 1)
        py = np.clip((cy + r * np.sin(angles)).astype(int), 0, h - 1)
        intensity = self.gray[py, px].astype(float)
        win2 = max(5, (n_a // 45) | 1)
        i_sm = signal.savgol_filter(intensity, win2, 3)
        fft_mag = np.abs(np.fft.rfft(i_sm - i_sm.mean()))
        freqs = np.arange(len(fft_mag))
        mask = (freqs >= self.MIN_TEETH) & (freqs <= self.MAX_TEETH)

        plt.figure(figsize=(12, 4))

        plt.subplot(1, 2, 1)
        deg = angles * 180 / np.pi
        plt.plot(deg, intensity, "b-", alpha=0.4, label="raw intensity")
        plt.plot(deg, i_sm, "g-", linewidth=2, label="smoothed")
        plt.xlabel("Angle (degrees)")
        plt.ylabel("Grayscale intensity")
        plt.title(
            f"Intensity at r={r}  —  peak={peak_tc}T(rel={peak_rel:.2f})"
            f"  outer={op_tc}T(rel={op_rel:.2f})"
        )
        plt.legend()
        plt.grid(True, alpha=0.3)

        plt.subplot(1, 2, 2)
        plt.bar(freqs[mask], fft_mag[mask], width=0.8)
        plt.axvline(
            self.tooth_count,
            color="red",
            linewidth=2,
            label=f"final={self.tooth_count}T",
        )
        plt.xlabel("Frequency (teeth count)")
        plt.ylabel("FFT magnitude")
        plt.title(f"Tooth-count spectrum  (conf={self.confidence:.2f})")
        plt.legend()
        plt.grid(True, alpha=0.3)

        plt.tight_layout()
        plt.show()

    def _show_image(self, title, img):
        """Debug helper to display an image."""
        plt.figure(figsize=(8, 6))
        if len(img.shape) == 2:
            plt.imshow(img, cmap="gray")
        else:
            plt.imshow(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        plt.title(title)
        plt.axis("off")
        plt.show()


def test_algorithm(test_image_path=None):
    """Test the algorithm on a single image."""
    counter = GearToothCounter(debug=True)

    if test_image_path:
        result = counter.count(test_image_path)
        print(f"\nResult: {result['tooth_count']} teeth")
        print(f"Confidence: {result['confidence']:.2%}")
        return result
    else:
        print("No test image provided. Provide a gear image path to test.")
        print("Usage: test_algorithm('path/to/gear/image.jpg')")


if __name__ == "__main__":
    print("Gear Tooth Counter - Phase 1 Algorithm")
    print("=" * 50)
    print("Ready to test. Call: test_algorithm('image_path.jpg')")
    print("\nOr use directly:")
    print("  counter = GearToothCounter(debug=True)")
    print("  result = counter.count('image_path.jpg')")
    print("  print(f'Teeth: {result[\"tooth_count\"]}, Confidence: {result[\"confidence\"]:.2%}')")
