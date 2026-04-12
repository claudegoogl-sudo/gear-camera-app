"""
Bicycle Gear Tooth Counter - Phase 1 Algorithm Prototype
Desktop Python implementation for tooth counting algorithm validation

Core approach:
1. Load gear image and resize
2. Convert to grayscale + CLAHE enhancement
3. Apply edge detection (Canny)
4. Find gear center via multi-threshold contour sweep (robust to varying
   backgrounds and lighting — replaces original Otsu dual-polarity)
5. Build candidate radii from radial edge-density peaks + evenly-spaced outer band
6. At each candidate radius, sample intensity and run FFT to score tooth count
7. Pick outermost candidate with rel-purity >= threshold (avoids inner hub bias)
8. Cross-check with outer-profile scan (outermost edge per angle) using sub-harmonic doubling
9. CLAHE peak-counting fallback for small gears with weak FFT signal
10. Apply decision rule and return count + confidence
"""

import cv2
import numpy as np
import matplotlib.pyplot as plt
from scipy import signal
import os
from pathlib import Path
from collections import defaultdict


class GearToothCounter:
    """Main class for detecting and counting gear teeth"""

    # Gear tooth count search range
    MIN_TEETH = 10
    # Lower bound for CLAHE peak counting (small cassette cogs)
    MIN_TEETH_CLAHE = 8
    MAX_TEETH = 65

    def __init__(self, debug=True):
        self.debug = debug
        self.image = None
        self.gray = None
        self.edges = None
        self._enhanced = None  # cached CLAHE-enhanced grayscale
        self.gear_center = None
        self.gear_radius = None
        self.gear_contour = None
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

    def _get_enhanced(self):
        """Return CLAHE-enhanced grayscale, caching the result."""
        if self._enhanced is None:
            clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
            self._enhanced = clahe.apply(self.gray)
        return self._enhanced

    def preprocess(self):
        """CLAHE contrast enhancement + Gaussian blur + Canny edge detection."""
        enhanced = self._get_enhanced()
        blurred = cv2.GaussianBlur(enhanced, (5, 5), 1.5)
        self.edges = cv2.Canny(blurred, 50, 150)

        if self.debug:
            self._show_image("Edges", self.edges)

        return self

    def find_gear_region(self):
        """
        Detect gear center via multi-threshold contour sweep with
        multi-candidate FFT validation.

        Pipeline:
        1. Sweep thresholds 40–220 in both polarities (BINARY / BINARY_INV)
        2. For each threshold, morphological close + open to clean mask
        3. Find external contours and score by circularity × compactness ×
           area^0.3, filtering by aspect ratio, border distance, and
           enclosing-circle size relative to image
        4. Keep top candidates (by score, deduplicated by center proximity)
        5. Run a quick FFT spectral-purity check at each candidate
        6. Pick the candidate with the best FFT purity; fall back to the
           highest contour score if no candidate yields a usable spectrum
        7. Refine center with ellipse fit when contour has enough points

        Falls back to Hough circles if no contour found.
        """
        h, w = self.gray.shape
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))

        # Collect all viable candidates: (score, cx, cy, r, cnt)
        all_candidates = []

        for thresh in range(40, 220, 5):
            for flag in [cv2.THRESH_BINARY_INV, cv2.THRESH_BINARY]:
                _, binary = cv2.threshold(self.gray, thresh, 255, flag)
                binary = cv2.morphologyEx(
                    binary, cv2.MORPH_CLOSE, kernel, iterations=2
                )
                binary = cv2.morphologyEx(
                    binary, cv2.MORPH_OPEN, kernel, iterations=1
                )

                contours, _ = cv2.findContours(
                    binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
                )

                for cnt in contours:
                    area = cv2.contourArea(cnt)
                    peri = cv2.arcLength(cnt, True)
                    if area < 1000 or peri < 100:
                        continue

                    x, y, bw, bh = cv2.boundingRect(cnt)
                    margin = 5
                    if (x <= margin or y <= margin or
                            x + bw >= w - margin or y + bh >= h - margin):
                        continue

                    if min(bw, bh) / max(bw, bh) < 0.5:
                        continue

                    circ = 4 * np.pi * area / (peri ** 2)
                    compact = area / (bw * bh)

                    _, enc_r = cv2.minEnclosingCircle(cnt)
                    if enc_r / min(h, w) < 0.08 or enc_r / min(h, w) > 0.45:
                        continue

                    score = circ * compact * (area ** 0.3)

                    M = cv2.moments(cnt)
                    if M["m00"] > 0:
                        c_x = int(round(M["m10"] / M["m00"]))
                        c_y = int(round(M["m01"] / M["m00"]))
                    else:
                        c_x, c_y = x + bw // 2, y + bh // 2
                    c_r = int(round(enc_r))

                    if len(cnt) >= 5:
                        ell = cv2.fitEllipse(cnt)
                        c_x = int(round(ell[0][0]))
                        c_y = int(round(ell[0][1]))

                    all_candidates.append((score, c_x, c_y, c_r, cnt))

        # Deduplicate: keep highest score per (center, radius) neighborhood
        all_candidates.sort(key=lambda c: -c[0])
        top_candidates = []
        for cand in all_candidates:
            sc, c_x, c_y, c_r, cnt = cand
            duplicate = False
            for _, t_x, t_y, t_r, _ in top_candidates:
                if (abs(c_x - t_x) < 30 and abs(c_y - t_y) < 30
                        and abs(c_r - t_r) < 20):
                    duplicate = True
                    break
            if not duplicate:
                top_candidates.append(cand)
            if len(top_candidates) >= 5:
                break

        # FFT purity check on contour candidates
        best_cnt = None
        best_score = -1
        cx, cy, outer_r = w // 2, h // 2, min(h, w) // 4

        if top_candidates:
            best_purity = -1.0
            best_purity_idx = 0

            for idx, (sc, c_x, c_y, c_r, cnt) in enumerate(top_candidates):
                purity = self._fft_purity_check(c_x, c_y, c_r)
                if purity > best_purity:
                    best_purity = purity
                    best_purity_idx = idx

            # ── Hough circle candidates ──────────────────────────────────
            # PAP-282: raised threshold from 0.10 → 0.15 so Hough circles
            # run for large cassette cogs where contour detection picks up
            # cutout holes with moderate purity (0.08-0.12).  Hough detects
            # actual circular gear outlines that contours miss due to teeth
            # lowering circularity.  A small purity bonus (10%) accounts
            # for the stronger geometric constraint Hough provides.
            if best_purity < 0.15:
                max_contour_r = max((c[3] for c in top_candidates), default=0)
                # PAP-288: lowered minRadius from //4 to //6 so Hough
                # detects large cassette cogs (28T) that fill ~20-25%
                # of image width — previously missed at //4 threshold.
                circles = cv2.HoughCircles(
                    self.edges, cv2.HOUGH_GRADIENT,
                    dp=2, minDist=100, param1=50, param2=30,
                    minRadius=min(h, w) // 6, maxRadius=min(h, w) // 2,
                )
                if circles is not None:
                    circles = np.uint16(np.around(circles))
                    for c in circles[0][:3]:
                        hc_x, hc_y, hc_r = int(c[0]), int(c[1]), int(c[2])
                        margin = 5
                        if not (margin < hc_x < w - margin
                                and margin < hc_y < h - margin):
                            continue
                        edge_dist = min(hc_x, w - hc_x, hc_y, h - hc_y)
                        if edge_dist < hc_r * 0.92:
                            continue
                        if max_contour_r > 0 and hc_r > max_contour_r * 2:
                            continue
                        duplicate = False
                        for _, t_x, t_y, t_r, _ in top_candidates:
                            if (abs(hc_x - t_x) < 30 and abs(hc_y - t_y) < 30
                                    and abs(hc_r - t_r) < 20):
                                duplicate = True
                                break
                        # PAP-288: evaluate Hough purity even for near-
                        # duplicate contour candidates.  Contour and Hough
                        # may detect the same feature with different radii;
                        # the Hough radius can yield better FFT purity
                        # (e.g. r=145 vs contour r=153 for 28T gears).
                        purity = self._fft_purity_check(
                            hc_x, hc_y, hc_r)
                        # PAP-282: 10% purity bonus for Hough circles —
                        # they encode a stronger geometric constraint
                        # (actual circular shape in edge image) compared
                        # to contour candidates that may match cutout holes.
                        if purity * 1.10 > best_purity:
                            top_candidates.append(
                                (0, hc_x, hc_y, hc_r, None))
                            best_purity = purity
                            best_purity_idx = len(top_candidates) - 1

            sc, cx, cy, outer_r, best_cnt = top_candidates[best_purity_idx]

        # ── Fallback: Hough circles (small radii) ────────────────────────
        if best_cnt is None and outer_r <= min(h, w) // 4:
            circles_fb = cv2.HoughCircles(
                self.edges, cv2.HOUGH_GRADIENT,
                dp=2, minDist=50, param1=50, param2=30,
                minRadius=30, maxRadius=min(h, w) // 2,
            )
            if circles_fb is not None:
                circles_fb = np.uint16(np.around(circles_fb))
                cx = int(circles_fb[0][0][0])
                cy = int(circles_fb[0][0][1])
                outer_r = int(circles_fb[0][0][2])

        cx = int(np.clip(cx, 0, w - 1))
        cy = int(np.clip(cy, 0, h - 1))

        # Refine center by maximizing rotational symmetry (FFT purity)
        cx, cy = self._refine_center(cx, cy, outer_r)

        self.gear_center = (cx, cy)
        self.gear_radius = outer_r
        self.gear_contour = best_cnt

        if self.debug:
            debug_img = self.image.copy()
            cv2.circle(debug_img, self.gear_center, self.gear_radius,
                       (0, 255, 0), 2)
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
        Tooth detection via three complementary methods:

        1. Multi-radius FFT scan: evaluate intensity-based FFT at each
           candidate radius (radial edge-density peaks + evenly-spaced outer
           band).  The outermost candidate with spectral purity >= 0.12 is
           chosen to avoid being fooled by the inner hub ring.

        2. Outer-profile scan: for each angle sample outward from the gear
           center to find the outermost edge pixel.  FFT on this radial profile
           gives a tooth count independent of radius selection.  Sub-harmonic
           doubling corrects half-frequency artifacts.

        3. CLAHE peak counting: at radii near the detected gear radius,
           count intensity peaks on CLAHE-enhanced image using Savitzky-Golay
           smoothing + find_peaks.  Helps small gears (8-20T) where FFT
           spectral purity is low.

        Decision:
        - Use multi-radius FFT if rel-purity >= 0.15 and count >= MIN_TEETH.
        - Else outer-profile if rel-purity >= 0.10.
        - Else CLAHE peak voting if confident (>= 50 % agreement).
        - Final fallback: highest-purity multi-radius candidate.
        """
        cx, cy = self.gear_center
        h, w = self.gray.shape

        # ── Build radial edge-density and candidate radii ─────────────────
        y_idx, x_idx = np.where(self.edges > 0)
        dists = np.sqrt((x_idx - cx) ** 2 + (y_idx - cy) ** 2).astype(int)
        max_r = int(min(cx, w - cx, cy, h - cy)) - 1
        if max_r < 20:
            max_r = min(h, w) // 3

        # Constrain search to within 135 % of detected gear radius so we
        # do not waste FFT evaluations on background pixels far from the gear.
        # Raised from 120 % → 135 % (PAP-280): 1.20× was insufficient for
        # large cassette cogs where gearR underestimates due to edge-density
        # peaks at inner cutout features rather than the tooth ring.
        if self.gear_radius > 20:
            max_r = min(max_r, int(self.gear_radius * 1.35))

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

        if len(peaks) > 10:
            top_idx = np.argsort(props["peak_heights"])[-10:]
            cand_set = {int(peaks[i]) for i in top_idx}
        else:
            cand_set = {int(p) for p in peaks} if len(peaks) > 0 else {max_r // 2}

        # Evenly-spaced outer radii (relative to detected gear radius)
        gr = self.gear_radius if self.gear_radius > 20 else max_r
        for pct in range(65, 85, 4):
            cand_set.add(int(gr * pct / 100))
        for pct in range(85, 108, 2):
            cand_set.add(int(gr * pct / 100))

        candidates = sorted(cand_set)

        # ── FFT tooth count at a single radius ───────────────────────────
        def _fft_count(r_val):
            n_a = 720
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

        # ── Evaluate all candidates ──────────────────────────────────────
        cand_results = [
            (r_val, *_fft_count(r_val))
            for r_val in candidates
            if 10 <= r_val < max_r
        ]

        MIN_REL = 0.12
        peak_tc, peak_rel, peak_r = 0, 0.0, 0

        # Primary: outermost candidate with rel >= threshold
        for r_val, tc, rel in sorted(cand_results, key=lambda x: -x[0]):
            if rel >= MIN_REL:
                peak_tc, peak_rel, peak_r = tc, rel, r_val
                break

        # Small-gear refinement: nearby count with stronger total support
        if 0 < peak_tc <= 20 and cand_results:
            outer_half_min = max_r * 0.45
            tc_votes = defaultdict(float)
            for r_val, tc, rel in cand_results:
                if r_val >= outer_half_min and rel >= 0.04:
                    tc_votes[tc] += rel
            if tc_votes:
                best_vote_tc = max(tc_votes, key=tc_votes.get)
                if (best_vote_tc != peak_tc
                        and abs(best_vote_tc - peak_tc) <= 3
                        and tc_votes[best_vote_tc] > tc_votes.get(peak_tc, 0)):
                    for r_val, tc, rel in sorted(cand_results, key=lambda x: -x[2]):
                        if tc == best_vote_tc and r_val >= outer_half_min:
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
        outer_radii[outer_radii == 0] = 10.0

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

            # Sub-harmonic doubling
            if op_tc <= self.MAX_TEETH // 2 and 2 * op_tc <= self.MAX_TEETH:
                f1, f2 = op_tc, 2 * op_tc
                s1 = op_fft[f1] + (0.5 * op_fft[min(2 * f1, len(op_fft) - 1)])
                s2 = op_fft[f2] + (0.5 * op_fft[min(2 * f2, len(op_fft) - 1)])
                if s2 >= 0.75 * s1:
                    op_tc = f2
        else:
            op_tc, op_rel = 0, 0.0

        # ── CLAHE peak counting for small gears ──────────────────────────
        enhanced = self._get_enhanced()
        n_a = 720
        angles = np.linspace(0, 2 * np.pi, n_a, endpoint=False)
        cos_a = np.cos(angles)
        sin_a = np.sin(angles)
        min_dist = max(10, n_a // (self.MAX_TEETH + 5))

        clahe_votes = defaultdict(float)
        for pct in range(90, 116, 2):
            r_val = int(self.gear_radius * pct / 100)
            if r_val < 10 or r_val >= max_r:
                continue
            px = np.clip((cx + r_val * cos_a).astype(int), 0, w - 1)
            py = np.clip((cy + r_val * sin_a).astype(int), 0, h - 1)
            intensity = enhanced[py, px].astype(float)
            sm = signal.savgol_filter(intensity, 21, 3)
            amp = sm.max() - sm.min()
            if amp < 8:
                continue
            pk, _ = signal.find_peaks(sm, distance=min_dist, prominence=amp * 0.10)
            tc_pk = len(pk)
            if self.MIN_TEETH_CLAHE <= tc_pk <= self.MAX_TEETH:
                clahe_votes[tc_pk] += amp

        clahe_tc, clahe_conf = 0, 0.0
        if clahe_votes:
            clahe_scores = {}
            for tc in clahe_votes:
                clahe_scores[tc] = (clahe_votes[tc]
                                    + 0.5 * clahe_votes.get(tc - 1, 0)
                                    + 0.5 * clahe_votes.get(tc + 1, 0))
            clahe_tc = max(clahe_scores, key=clahe_scores.get)
            total_w = sum(clahe_votes.values())
            agreeing_w = sum(clahe_votes.get(tc, 0) for tc in clahe_votes
                             if abs(tc - clahe_tc) <= 1)
            clahe_conf = float(min(1.0, agreeing_w / (total_w * 0.4)))

        # ── FFT at >= 90 % of max contour radius ─────────────────────────
        fft90_tc = self._fft_at_90pct()

        # ── Binary contour tooth count (Otsu silhouette) ─────────────────
        bc_tc, bc_purity, bc_peaks = self._binary_contour_count()

        # ── Decision rule ────────────────────────────────────────────────
        # 1. Multi-radius FFT with strong purity — use that directly.
        # 2. Binary contour method when FFT-based purity is weak.
        # 3. Fall through to remaining heuristics otherwise.

        # Best available purity for confidence calculation
        final_rel = peak_rel if peak_rel > 0 else (
            op_rel if op_rel > 0 else 0.0
        )

        # FFT-based confidence (linear ramp: rel 0.05→0%, 0.20→100%)
        fft_conf = float(min(1.0, max(0.0, (final_rel - 0.05) / 0.15)))

        if fft_conf >= 0.70 and peak_tc > 0:
            # Multi-radius outermost candidate is highly confident — trust it.
            # Prefer peak_tc over fft90_tc because _fft_at_90pct accumulates
            # votes across all radii and can be dominated by inner features
            # (spider arms, mounting holes) in large gears.
            final_tc = peak_tc
        elif (peak_tc > 0 and fft90_tc > 0
              and abs(peak_tc - fft90_tc) <= 1
              and fft_conf >= 0.40
              and bc_purity < 0.20):
            # PAP-282: FFT agreement rule — when multi-radius FFT and
            # FFT@90% agree (within ±1 tooth), trust them even at moderate
            # confidence.  Two independent FFT methods agreeing is strong
            # evidence; prevents fallthrough to unreliable binary contour
            # on large gears with spider-arm cutouts.
            # Guard: do NOT override a high-purity binary contour (>= 0.20)
            # since the contour silhouette is more reliable than FFT for
            # gears with clean Otsu segmentation (e.g. 20T, 21T).
            final_tc = peak_tc
        elif bc_purity >= 0.20 and self.MIN_TEETH <= bc_tc <= self.MAX_TEETH:
            # Binary contour FFT has high purity — use it
            final_tc = bc_tc
            final_rel = max(final_rel, bc_purity * 0.30)
        elif (bc_purity >= 0.10
              and self.MIN_TEETH <= bc_peaks <= self.MAX_TEETH):
            # Binary contour peak count is in valid range.
            # PAP-282: raised threshold from 0.05 → 0.10; lower purities
            # are unreliable on large gears where spider-arm cutout
            # features dominate the silhouette contour.
            # Peak counting on Otsu silhouette can be off by ±1 for
            # small gears (11-15T) due to merged/split teeth.  When
            # FFT methods agree on a count that differs from bc_peaks
            # by exactly 1, prefer the FFT result.
            if (fft90_tc > 0 and bc_tc > 0
                    and fft90_tc == bc_tc
                    and abs(fft90_tc - bc_peaks) == 1):
                final_tc = fft90_tc
            elif (peak_tc > 0 and fft90_tc > 0
                    and peak_tc == fft90_tc
                    and abs(peak_tc - bc_peaks) == 1):
                final_tc = peak_tc
            elif (self.MIN_TEETH <= bc_tc <= self.MAX_TEETH
                    and abs(bc_tc - bc_peaks) > 3
                    and bc_tc > bc_peaks
                    and bc_tc < 2 * bc_peaks):
                # PAP-288: when binary contour FFT and peak count
                # disagree substantially (>3 teeth) and the FFT count
                # is higher but not a harmonic (< 2× peaks), prefer
                # the FFT.  Peak counting undercounts on large gears
                # because spider-arm cutouts split the silhouette.
                final_tc = bc_tc
            else:
                final_tc = bc_peaks
            final_rel = max(final_rel, bc_purity * 0.25)
        elif fft90_tc > 0:
            final_tc = fft90_tc
        elif peak_rel >= 0.15 and peak_tc >= self.MIN_TEETH:
            final_tc = peak_tc
        elif op_tc > 0 and op_rel >= 0.10:
            final_tc = op_tc
        elif peak_tc > 0:
            final_tc = peak_tc
        elif clahe_tc > 0 and clahe_conf >= 0.50:
            final_tc = clahe_tc
        else:
            final_tc = 0

        self.tooth_count = final_tc
        self.gear_radius = peak_r if peak_r > 0 else self.gear_radius

        # Confidence: linear ramp  rel=0.05 → 0 %,  rel=0.20 → 100 %
        self.confidence = float(min(1.0, max(0.0, (final_rel - 0.05) / 0.15)))

        if self.debug:
            self._debug_plot(peak_tc, peak_rel, peak_r, op_tc, op_rel)

        return self

    # ── Complementary tooth-counting methods ───────────────────────────────

    def _fft_at_90pct(self):
        """
        FFT tooth count using only radii >= 85 % of the max contour radius.

        Ignoring inner radii avoids pollution from mounting holes and hub
        features, focusing the frequency analysis on the tooth tips.
        85 % was found optimal across the 26-image training set.
        """
        cx, cy = self.gear_center
        h, w = self.gray.shape
        cnt = self.gear_contour
        enhanced = self._get_enhanced()

        # Determine max radius from contour points
        if cnt is not None and len(cnt) > 20:
            pts = cnt.reshape(-1, 2).astype(float)
            max_r_cnt = np.max(np.sqrt(
                (pts[:, 0] - cx) ** 2 + (pts[:, 1] - cy) ** 2
            ))
        else:
            max_r_cnt = self.gear_radius
        max_r_use = max(max_r_cnt, self.gear_radius)

        threshold_r = int(max_r_use * 0.85)
        max_r_scan = min(
            int(max_r_use * 1.10),
            min(cx, w - cx, cy, h - cy) - 1,
        )

        n_a = 720
        angles = np.linspace(0, 2 * np.pi, n_a, endpoint=False)
        cos_a, sin_a = np.cos(angles), np.sin(angles)

        fft_votes = defaultdict(float)
        for rv in range(threshold_r, max_r_scan + 1, 2):
            if rv < 10:
                continue
            px = np.clip((cx + rv * cos_a).astype(int), 0, w - 1)
            py = np.clip((cy + rv * sin_a).astype(int), 0, h - 1)
            intensity = enhanced[py, px].astype(float)
            sm = signal.savgol_filter(intensity, 21, 3, mode='wrap')
            amp = sm.max() - sm.min()
            if amp < 5:
                continue
            fft_mag = np.abs(np.fft.rfft(sm - sm.mean()))
            # Radius-weighted voting (PAP-280): bias toward outer radii
            # where tooth tips live; inner radii are contaminated by
            # spider-arm cutouts on large cassette cogs.
            span = max(1, max_r_scan - threshold_r)
            radial_weight = 0.5 + 0.5 * (rv - threshold_r) / span
            for freq in range(self.MIN_TEETH, self.MAX_TEETH + 1):
                if freq < len(fft_mag):
                    fft_votes[freq] += float(fft_mag[freq]) * radial_weight

        if not fft_votes:
            return 0
        return max(fft_votes, key=fft_votes.get)

    def _refine_center(self, cx, cy, r):
        """
        Refine gear center by finding the point that maximizes
        rotational symmetry (FFT spectral purity), with a radial-symmetry
        tie-breaker to avoid drifting toward artifact centers.

        Two-pass grid search: coarse (±25px, step 5) then fine (±5px, step 1).
        Uses the full-resolution _fft_purity_check for accurate scoring.
        Only accepts the refined center if purity improves by ≥15%.
        """
        h, w = self.gray.shape

        def _search(cx0, cy0, radius, half_range, step):
            best_cx, best_cy = cx0, cy0
            best_p = self._fft_purity_check(cx0, cy0, radius)
            for dx in range(-half_range, half_range + 1, step):
                for dy in range(-half_range, half_range + 1, step):
                    if dx == 0 and dy == 0:
                        continue
                    ncx, ncy = cx0 + dx, cy0 + dy
                    if ncx < 10 or ncy < 10 or ncx >= w - 10 or ncy >= h - 10:
                        continue
                    p = self._fft_purity_check(ncx, ncy, radius)
                    if p > best_p:
                        best_p = p
                        best_cx, best_cy = ncx, ncy
            return best_cx, best_cy, best_p

        orig_purity = self._fft_purity_check(cx, cy, r)

        # Coarse pass (±25px for broader coverage)
        cx1, cy1, _ = _search(cx, cy, r, 25, 5)
        # Fine pass
        cx2, cy2, refined_purity = _search(cx1, cy1, r, 5, 1)

        # Accept only when: meaningful shift, significant gain, and the
        # refined center actually produces a clean tooth signal.
        shift = np.sqrt((cx2 - cx) ** 2 + (cy2 - cy) ** 2)
        if (shift >= 3
                and orig_purity > 0
                and refined_purity > orig_purity * 1.15
                and refined_purity >= 0.14):
            return cx2, cy2
        return cx, cy

    def _fft_purity_check(self, cx, cy, r):
        """
        Quick FFT spectral-purity score for a candidate gear centre/radius.

        Samples CLAHE-enhanced intensity at radii from 85 % to 110 % of *r*,
        accumulates FFT votes per frequency in [MIN_TEETH, MAX_TEETH], and
        returns the ratio of the winning frequency's total magnitude to the
        sum across all candidate frequencies.  Higher = cleaner tooth signal.

        """
        h, w = self.gray.shape
        enhanced = self._get_enhanced()

        lo = int(r * 0.85)
        hi = min(int(r * 1.10), min(cx, w - cx, cy, h - cy) - 1)
        if lo >= hi or lo < 10:
            return 0.0

        n_a = 720
        angles = np.linspace(0, 2 * np.pi, n_a, endpoint=False)
        cos_a, sin_a = np.cos(angles), np.sin(angles)

        fft_votes = defaultdict(float)
        for rv in range(lo, hi + 1, 2):
            px = np.clip((cx + rv * cos_a).astype(int), 0, w - 1)
            py = np.clip((cy + rv * sin_a).astype(int), 0, h - 1)
            intensity = enhanced[py, px].astype(float)
            sm = signal.savgol_filter(intensity, 21, 3, mode='wrap')
            amp = sm.max() - sm.min()
            if amp < 5:
                continue
            fft_mag = np.abs(np.fft.rfft(sm - sm.mean()))
            for freq in range(self.MIN_TEETH, self.MAX_TEETH + 1):
                if freq < len(fft_mag):
                    fft_votes[freq] += float(fft_mag[freq])

        if not fft_votes:
            return 0.0

        total = sum(fft_votes.values())
        best = max(fft_votes.values())
        return best / total if total > 0 else 0.0

    def _contour_groups(self, pct=94):
        """
        Count tooth tips by thresholding the contour's angular radius profile.

        Resamples the contour radius as a function of angle, smooths it,
        then counts groups of consecutive samples above *pct* % of max
        radius.  Each group corresponds to one tooth tip.
        """
        cnt = self.gear_contour
        if cnt is None or len(cnt) < 30:
            return 0

        cx, cy = self.gear_center
        pts = cnt.reshape(-1, 2).astype(float)
        angles = np.arctan2(pts[:, 1] - cy, pts[:, 0] - cx)
        radii = np.sqrt((pts[:, 0] - cx) ** 2 + (pts[:, 1] - cy) ** 2)

        order = np.argsort(angles)
        angles_s, radii_s = angles[order], radii[order]

        # Interpolate onto evenly-spaced angular grid
        n_a = 720
        even_a = np.linspace(-np.pi, np.pi, n_a, endpoint=False)
        all_a = np.concatenate([
            angles_s - 2 * np.pi, angles_s, angles_s + 2 * np.pi,
        ])
        all_r = np.concatenate([radii_s, radii_s, radii_s])
        profile = np.interp(even_a, all_a, all_r)

        sm = signal.savgol_filter(profile, 7, 3, mode='wrap')
        threshold = sm.max() * pct / 100
        above = sm >= threshold

        # Count rising edges (transitions from below to above threshold)
        extended = np.concatenate([above, [above[0]]])
        transitions = np.diff(extended.astype(int))
        return int(np.sum(transitions == 1))

    def _contour_profile_peaks(self, distance=18, prom_pct=2):
        """
        Count peaks in the contour's angular radius profile.

        Unlike ``_contour_groups`` (which thresholds at a fixed percentage),
        this method uses ``find_peaks`` with a prominence criterion, making
        it sensitive to small-amplitude teeth that groups might merge.
        """
        cnt = self.gear_contour
        if cnt is None or len(cnt) < 30:
            return 0

        cx, cy = self.gear_center
        pts = cnt.reshape(-1, 2).astype(float)
        angles = np.arctan2(pts[:, 1] - cy, pts[:, 0] - cx)
        radii = np.sqrt((pts[:, 0] - cx) ** 2 + (pts[:, 1] - cy) ** 2)

        order = np.argsort(angles)
        angles_s, radii_s = angles[order], radii[order]

        n_a = 720
        even_a = np.linspace(-np.pi, np.pi, n_a, endpoint=False)
        all_a = np.concatenate([
            angles_s - 2 * np.pi, angles_s, angles_s + 2 * np.pi,
        ])
        all_r = np.concatenate([radii_s, radii_s, radii_s])
        profile = np.interp(even_a, all_a, all_r)

        sm = signal.savgol_filter(profile, 7, 3, mode='wrap')
        amp = sm.max() - sm.min()
        prom = amp * prom_pct / 100
        pks, _ = signal.find_peaks(sm, distance=distance, prominence=prom)
        return len(pks)

    def _binary_contour_count(self):
        """
        Count teeth by analysing the outer contour of an Otsu-thresholded
        binary silhouette.

        Both polarities of Otsu (foreground dark / foreground bright) are
        tried.  For each external contour with sufficient angular coverage
        the radius profile is resampled onto a uniform angular grid and
        teeth are detected via both FFT and peak counting.

        Returns (fft_tc, fft_purity, peak_tc).  Caller should interpret
        purity to decide whether the result is usable.
        """
        cx, cy = self.gear_center
        gr = self.gear_radius
        n_a = 3600
        results = []

        # Otsu threshold for primary analysis
        otsu_t, _ = cv2.threshold(self.gray, 0, 255,
                                  cv2.THRESH_BINARY | cv2.THRESH_OTSU)
        # Multi-threshold sweep: Otsu + fixed thresholds to handle cases
        # where Otsu fails (e.g. metallic gears on white paper).  PAP-266.
        thresholds = sorted(set([int(otsu_t)] + list(range(60, 201, 35))))

        for thresh in thresholds:
          for invert in (False, True):
            if invert:
                binary = np.where(self.gray <= thresh, 255, 0).astype(np.uint8)
            else:
                binary = np.where(self.gray > thresh, 255, 0).astype(np.uint8)
            contours, _ = cv2.findContours(
                binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE,
            )
            for cnt in contours:
                if len(cnt) < 100:
                    continue
                pts = cnt.reshape(-1, 2).astype(float)
                dx = pts[:, 0] - cx
                dy = pts[:, 1] - cy
                radii = np.sqrt(dx ** 2 + dy ** 2)
                angles_cnt = np.arctan2(dy, dx)

                order = np.argsort(angles_cnt)
                a_sorted = angles_cnt[order]
                r_sorted = radii[order]
                if a_sorted[-1] - a_sorted[0] < 4.0:
                    continue

                uniform = np.linspace(-np.pi, np.pi, n_a, endpoint=False)
                r_interp = np.interp(uniform, a_sorted, r_sorted)
                sm = signal.savgol_filter(r_interp, 51, 3, mode='wrap')
                amp = sm.max() - sm.min()
                if amp < 2:
                    continue

                # Peak counting
                min_d = n_a // 80
                peaks, _ = signal.find_peaks(
                    sm, distance=min_d, prominence=amp * 0.10,
                )
                n_peaks = len(peaks)

                # FFT
                fft_mag = np.abs(np.fft.rfft(sm - sm.mean()))
                tooth_fft = fft_mag[self.MIN_TEETH:self.MAX_TEETH + 1]
                total = tooth_fft.sum()
                if total <= 0:
                    continue
                fft_winner = int(np.argmax(tooth_fft) + self.MIN_TEETH)
                fft_purity = float(tooth_fft.max() / total)

                results.append((fft_winner, fft_purity, n_peaks))

        if not results:
            return 0, 0.0, 0

        # Prefer results where peak count is in the valid tooth range
        valid = [r for r in results
                 if self.MIN_TEETH <= r[2] <= self.MAX_TEETH]
        if valid:
            # Among valid, prefer where FFT and peaks agree closely
            agreeing = [r for r in valid if abs(r[0] - r[2]) <= 2]
            if agreeing:
                return max(agreeing, key=lambda r: r[1])
            return max(valid, key=lambda r: r[1])
        return max(results, key=lambda r: r[1])

    def _outermost_edge_peaks(self):
        """
        Build a radial profile from the outermost Canny edge per angle,
        then count peaks.

        For each of 720 angular samples, scan inward from 115 % to 80 % of
        the detected gear radius and record the first edge hit.  Peak
        counting on the smoothed profile gives a tooth count independent
        of threshold-based contour extraction.
        """
        cx, cy = self.gear_center
        h, w = self.gray.shape
        cnt = self.gear_contour

        enhanced = self._get_enhanced()
        blurred = cv2.GaussianBlur(enhanced, (3, 3), 1.0)
        edges = cv2.Canny(blurred, 50, 150)

        if cnt is not None and len(cnt) > 20:
            pts = cnt.reshape(-1, 2).astype(float)
            max_r_cnt = np.max(np.sqrt(
                (pts[:, 0] - cx) ** 2 + (pts[:, 1] - cy) ** 2
            ))
        else:
            max_r_cnt = self.gear_radius
        max_r_use = max(max_r_cnt, self.gear_radius)

        n_a = 720
        angles = np.linspace(0, 2 * np.pi, n_a, endpoint=False)
        cos_a, sin_a = np.cos(angles), np.sin(angles)

        outer_radii = np.zeros(n_a)
        for rv_pct in range(115, 80, -1):
            rv = int(max_r_use * rv_pct / 100)
            if rv < 10 or rv >= min(cx, w - cx, cy, h - cy):
                continue
            px = np.clip((cx + rv * cos_a).astype(int), 0, w - 1)
            py = np.clip((cy + rv * sin_a).astype(int), 0, h - 1)
            hit = edges[py, px] > 0
            outer_radii[hit & (outer_radii == 0)] = rv

        if not np.any(outer_radii > 0):
            return 0
        med = np.median(outer_radii[outer_radii > 0])
        outer_radii[outer_radii == 0] = med

        sm = signal.savgol_filter(outer_radii, 11, 3, mode='wrap')
        amp = sm.max() - sm.min()
        if amp < 2:
            return 0

        pks, _ = signal.find_peaks(sm, distance=25, prominence=amp * 0.1)
        return len(pks)

    # ── Public pipeline ──────────────────────────────────────────────────────

    # Small gears (radius < this) with low confidence get a retry at higher
    # resolution.  At 1000 px max dim, small sprockets (11-15 T) can end up
    # with only ~80 px radius, which gives the FFT too few pixels per tooth.
    _SMALL_GEAR_RADIUS = 100
    # PAP-282: raised from 0.50 → 0.65 so the off-center retry fires
    # more aggressively for large gears with misleading confidence.
    _SMALL_GEAR_CONF = 0.65
    _RETRY_MAX_DIM = 1500

    def count(self, image_path):
        """
        Complete pipeline: load → preprocess → find gear → detect teeth.

        If the detected gear is small and confidence is low, retries at
        higher resolution to give the FFT more pixels per tooth.

        Returns:
            dict with tooth_count, confidence, success, gear_center, gear_radius
        """
        try:
            self.load_image(image_path)
            self.preprocess()
            self.find_gear_region()
            self.extract_gear_roi()
            self.detect_teeth()

            # Off-center, low-confidence retry: if the detected center is
            # far from the image center (aim circle) and confidence is weak,
            # the algorithm may have locked onto a background feature.
            # Re-run with the center forced near the image center.
            if (self.confidence < self._SMALL_GEAR_CONF
                    and self.gear_center is not None):
                h, w = self.gray.shape
                img_cx, img_cy = w // 2, h // 2
                cdist = np.sqrt(
                    (self.gear_center[0] - img_cx) ** 2
                    + (self.gear_center[1] - img_cy) ** 2
                )
                # PAP-282: lowered from 0.15 → 0.08 so the retry fires
                # more aggressively for large gears whose detected center
                # may be close to image center but still wrong (e.g. locked
                # onto a cutout hole near the actual gear center).
                if cdist > min(h, w) * 0.08:
                    retry_c = self._retry_near_center(img_cx, img_cy)
                    # PAP-282: accept retry if confidence is within 0.05
                    # of the original.  The original may have misleadingly
                    # high confidence from spider-arm cutout artifacts;
                    # a retry that finds a similar confidence at a centre
                    # closer to the aim circle should be preferred.
                    # Tooth-density sanity check: reject retry results
                    # where the tooth count is unrealistically low for the
                    # detected radius (implies spurious center that samples
                    # across gear edge and background).
                    # PAP-288: sub-harmonic guard — reject retry when its
                    # count is a sub-harmonic (half or third) of the
                    # initial detection.  Spider-arm features create strong
                    # 12-fold or 10-fold symmetry that can dominate at
                    # inner radii, producing counts like 12 vs actual 24.
                    is_subharmonic = (
                        self.tooth_count is not None
                        and self.tooth_count > 0
                        and retry_c is not None
                        and retry_c["tooth_count"] is not None
                        and retry_c["tooth_count"] > 0
                        and any(
                            abs(retry_c["tooth_count"] * k
                                - self.tooth_count) <= 1
                            for k in (2, 3)
                        )
                    )
                    if (retry_c is not None
                            and not is_subharmonic
                            and retry_c["confidence"]
                            > self.confidence - 0.05
                            and (retry_c["gear_radius"] <= 150
                                 or retry_c["tooth_count"]
                                 > retry_c["gear_radius"] / 15)):
                        return retry_c

            # Small-gear, low-confidence retry at higher resolution
            if (self.confidence < self._SMALL_GEAR_CONF
                    and self.gear_radius <= self._SMALL_GEAR_RADIUS
                    and self.tooth_count is not None
                    and self.tooth_count > 0):
                retry = self._retry_higher_res(image_path)
                if retry is not None and retry["confidence"] > self.confidence:
                    return retry

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

    def _retry_near_center(self, img_cx, img_cy):
        """Re-run tooth detection with the center forced near the image center.

        When the main pipeline picks a center far from the aim circle and
        confidence is low, this method searches for the best FFT purity
        in a region around the image center.  If a better result is found,
        it returns the improved result; otherwise returns None.

        Uses a two-pass coarse-to-fine search:
        1. Coarse: ±80px step 20 across radii 10%-35% of min dim (step 8)
        2. Fine:   ±15px step 5 around the coarse-best position and radius
        """
        try:
            h, w = self.gray.shape
            best_purity = 0.0
            best_cx, best_cy, best_r = img_cx, img_cy, min(h, w) // 4

            # Search radii from 10% to 42% of image min dim
            # PAP-282: raised from 35% → 42% so 28T gears (~34% of min dim)
            # are covered by the retry search.
            min_r = max(30, int(min(h, w) * 0.10))
            max_r = int(min(h, w) * 0.42)

            # Coarse pass: wide center range, larger radius step
            for r in range(min_r, max_r, 8):
                for dx in range(-80, 81, 20):
                    for dy in range(-80, 81, 20):
                        tcx = int(np.clip(img_cx + dx, 10, w - 10))
                        tcy = int(np.clip(img_cy + dy, 10, h - 10))
                        p = self._fft_purity_check(tcx, tcy, r)
                        if p > best_purity:
                            best_purity = p
                            best_cx, best_cy, best_r = tcx, tcy, r

            if best_purity < 0.03:
                return None

            # Fine pass: refine around coarse-best position and radius
            fine_cx, fine_cy, fine_r = best_cx, best_cy, best_r
            fine_purity = best_purity
            r_lo = max(min_r, best_r - 15)
            r_hi = min(max_r, best_r + 16)
            for r in range(r_lo, r_hi, 5):
                for dx in range(-15, 16, 5):
                    for dy in range(-15, 16, 5):
                        tcx = int(np.clip(best_cx + dx, 10, w - 10))
                        tcy = int(np.clip(best_cy + dy, 10, h - 10))
                        p = self._fft_purity_check(tcx, tcy, r)
                        if p > fine_purity:
                            fine_purity = p
                            fine_cx, fine_cy, fine_r = tcx, tcy, r

            best_cx, best_cy, best_r = fine_cx, fine_cy, fine_r
            best_purity = fine_purity

            if best_purity < 0.05:
                return None

            # Fine-tune center around best position
            cx2, cy2 = self._refine_center(best_cx, best_cy, best_r)

            # Re-run tooth detection at the new center
            saved = (self.gear_center, self.gear_radius, self.gear_contour,
                     self.tooth_count, self.confidence)
            self.gear_center = (cx2, cy2)
            self.gear_radius = best_r
            self.gear_contour = None
            self.extract_gear_roi()
            self.detect_teeth()

            result = {
                "tooth_count": self.tooth_count,
                "confidence": float(self.confidence),
                "success": True,
                "gear_center": self.gear_center,
                "gear_radius": self.gear_radius,
            }
            # Restore original state (caller will use result dict)
            (self.gear_center, self.gear_radius, self.gear_contour,
             self.tooth_count, self.confidence) = saved
            return result
        except Exception:
            return None

    def _retry_higher_res(self, image_path):
        """Re-run the pipeline at higher resolution for small gears."""
        try:
            hi = GearToothCounter(debug=False)
            hi.image = cv2.imread(image_path)
            if hi.image is None:
                return None
            h0, w0 = hi.image.shape[:2]
            max_dim = max(h0, w0)
            if max_dim > self._RETRY_MAX_DIM:
                scale = self._RETRY_MAX_DIM / max_dim
                hi.image = cv2.resize(
                    hi.image,
                    (max(1, int(w0 * scale)), max(1, int(h0 * scale))),
                )
            hi.gray = cv2.cvtColor(hi.image, cv2.COLOR_BGR2GRAY)
            hi.preprocess()
            hi.find_gear_region()
            hi.extract_gear_roi()
            hi.detect_teeth()
            return {
                "tooth_count": hi.tooth_count,
                "confidence": float(hi.confidence),
                "success": True,
                "gear_center": hi.gear_center,
                "gear_radius": hi.gear_radius,
            }
        except Exception:
            return None

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
