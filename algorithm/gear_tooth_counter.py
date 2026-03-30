"""
Bicycle Gear Tooth Counter - Phase 1 Algorithm Prototype
Desktop Python implementation for tooth counting algorithm validation

Core approach:
1. Load gear image
2. Convert to grayscale
3. Apply edge detection (Canny)
4. Find gear contour (circular Hough or contour analysis)
5. Isolate gear region
6. Convert to polar coordinates centered on gear
7. Detect tooth peaks in polar space
8. Count peaks = tooth count
9. Return count + confidence score
"""

import cv2
import numpy as np
import matplotlib.pyplot as plt
from scipy import signal
from scipy.ndimage import label
import os
from pathlib import Path


class GearToothCounter:
    """Main class for detecting and counting gear teeth"""
    
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
        """Load image from file"""
        self.image = cv2.imread(image_path)
        if self.image is None:
            raise FileNotFoundError(f"Could not load image: {image_path}")
        # Resize for consistency (max 1000px width)
        height, width = self.image.shape[:2]
        if width > 1000:
            scale = 1000 / width
            self.image = cv2.resize(self.image, (1000, int(height * scale)))
        
        self.gray = cv2.cvtColor(self.image, cv2.COLOR_BGR2GRAY)
        return self
    
    def preprocess(self):
        """Edge detection and image preprocessing"""
        # Apply Gaussian blur to reduce noise
        blurred = cv2.GaussianBlur(self.gray, (5, 5), 1.5)
        
        # Canny edge detection
        self.edges = cv2.Canny(blurred, 50, 150)
        
        if self.debug:
            self._show_image("Edges", self.edges)
        
        return self
    
    def find_gear_region(self):
        """
        Detect the gear center via Hough, then refine the radius by finding
        the outermost strong ring in the radial edge-density profile.
        This avoids Hough latching onto inner hub rings instead of tooth tips.
        """
        h, w = self.edges.shape

        # ── Step 1: find center with Hough ──────────────────────────────────
        circles = cv2.HoughCircles(
            self.edges,
            cv2.HOUGH_GRADIENT,
            dp=1,
            minDist=50,
            param1=50,
            param2=30,
            minRadius=30,
            maxRadius=max(h, w),
        )

        if circles is not None:
            circles = np.uint16(np.around(circles))
            cx, cy = int(circles[0][0][0]), int(circles[0][0][1])
        else:
            cx, cy = w // 2, h // 2

        cx = int(np.clip(cx, 0, w - 1))
        cy = int(np.clip(cy, 0, h - 1))

        # ── Step 2: refine radius via radial edge-density profile ────────────
        y_idx, x_idx = np.where(self.edges > 0)
        dists = np.sqrt((x_idx - cx) ** 2 + (y_idx - cy) ** 2).astype(int)
        max_r = int(min(cx, w - cx, cy, h - cy)) - 1

        valid = dists < max_r
        density = np.bincount(dists[valid], minlength=max_r).astype(float)

        # Smooth with an odd window sized to ~1/8 of the search space
        win = max(5, (max_r // 8) | 1)
        density_smooth = signal.savgol_filter(density, win, 3)

        # Peaks in density = concentric rings in the gear (hub, body, teeth).
        # Cap search at 90% of max_r so we don't mistake the image border or
        # background paper edges (which always appear at the very edge of the
        # frame) for the gear's outer ring.
        search_limit = int(max_r * 0.90)
        peaks, _ = signal.find_peaks(
            density_smooth[:search_limit],
            height=density_smooth[:search_limit].max() * 0.12,
            distance=8,
        )

        if len(peaks) > 0:
            # Outermost significant peak within the safe zone = tooth-tip circle
            outer_r = int(peaks[-1])
        else:
            # Fallback to Hough radius
            outer_r = int(circles[0][0][2]) if circles is not None else max_r // 2

        self.gear_center = (cx, cy)
        self.gear_radius = outer_r

        if self.debug:
            debug_img = self.image.copy()
            cv2.circle(debug_img, self.gear_center, self.gear_radius, (0, 255, 0), 2)
            self._show_image("Detected Gear Circle", debug_img)

        return self
    
    def extract_gear_roi(self, padding=20):
        """
        Extract region of interest around gear
        padding: extra pixels beyond gear radius
        """
        x, y = self.gear_center
        r = self.gear_radius + padding
        
        # Clip to image bounds
        y1 = max(0, y - r)
        y2 = min(self.gray.shape[0], y + r)
        x1 = max(0, x - r)
        x2 = min(self.gray.shape[1], x + r)
        
        self.gear_roi = self.gray[y1:y2, x1:x2]
        self.roi_offset = (x1, y1)
        
        return self
    
    def detect_teeth(self):
        """
        Detect teeth by sampling grayscale intensity around the gear circumference
        at the detected tooth-tip radius, then finding the dominant frequency with
        FFT.  Intensity-based sampling is robust to both standard chain sprockets
        (outward-pointing teeth) and belt-drive sprockets (inward-facing notches),
        because in both cases the pixel values alternate between gear-body and
        gap/background with the tooth period.
        """
        x, y = self.gear_center
        r = self.gear_radius
        h, w = self.gray.shape

        n_angles = 360
        angles = np.linspace(0, 2 * np.pi, n_angles, endpoint=False)

        # Sample grayscale intensity at the tooth-tip circle radius
        intensity = []
        for angle in angles:
            px = int(x + r * np.cos(angle))
            py = int(y + r * np.sin(angle))
            if 0 <= px < w and 0 <= py < h:
                intensity.append(float(self.gray[py, px]))
            else:
                intensity.append(128.0)

        intensity = np.array(intensity)

        # Light smoothing
        win = max(5, (n_angles // 45) | 1)
        intensity_smooth = signal.savgol_filter(intensity, window_length=win, polyorder=3)

        # ── FFT with harmonic support: dominant frequency = tooth count ──────
        # Remove DC so low frequencies don't swamp the gear frequency.
        signal_ac = intensity_smooth - intensity_smooth.mean()
        fft_mag = np.abs(np.fft.rfft(signal_ac))

        freqs = np.arange(len(fft_mag))
        search = (freqs >= 10) & (freqs <= 65)   # valid gear range

        if not search.any():
            self.tooth_count = 0
            self.confidence = 0.0
            return self

        # Score each candidate frequency by its own magnitude plus half of
        # the 2nd harmonic (2f).  This breaks ties when fundamental peaks are
        # close: the correct frequency will have a stronger harmonic.
        candidates = freqs[search]
        scores = np.zeros(len(candidates))
        for i, f in enumerate(candidates):
            scores[i] = fft_mag[f]
            if 2 * f < len(fft_mag):
                scores[i] += 0.5 * fft_mag[2 * f]

        best_idx = int(np.argmax(scores))
        dominant_freq = int(candidates[best_idx])

        self.tooth_count = dominant_freq

        # Confidence: ratio of best score to the second-best score,
        # normalised to [0, 1].  A ratio ≥ 10× → ~100 %; ratio ≈ 1× → ~0 %.
        sorted_scores = np.sort(scores)[::-1]
        if len(sorted_scores) > 1 and sorted_scores[1] > 0:
            ratio = sorted_scores[0] / sorted_scores[1]
            self.confidence = float(min(1.0, (ratio - 1.0) / 9.0))
        else:
            self.confidence = 1.0

        if self.debug:
            plt.figure(figsize=(12, 4))

            plt.subplot(1, 2, 1)
            deg = angles * 180 / np.pi
            plt.plot(deg, intensity, 'b-', alpha=0.4, label='raw intensity')
            plt.plot(deg, intensity_smooth, 'g-', linewidth=2, label='smoothed')
            plt.xlabel('Angle (degrees)')
            plt.ylabel('Grayscale intensity')
            plt.title(f'Intensity profile at r={r}  — {self.tooth_count}T detected')
            plt.legend()
            plt.grid(True, alpha=0.3)

            plt.subplot(1, 2, 2)
            plt.bar(freqs[search], fft_mag[search], width=0.8)
            plt.axvline(dominant_freq, color='red', linewidth=2,
                        label=f'dominant={dominant_freq}')
            plt.xlabel('Frequency (teeth count)')
            plt.ylabel('FFT magnitude')
            plt.title(f'Tooth-count spectrum  (conf={self.confidence:.2f})')
            plt.legend()
            plt.grid(True, alpha=0.3)

            plt.tight_layout()
            plt.show()

        return self
    
    def count(self, image_path):
        """
        Complete pipeline: load -> preprocess -> find gear -> detect teeth
        
        Args:
            image_path (str): Path to gear image
            
        Returns:
            dict: {
                'tooth_count': int,
                'confidence': float (0.0-1.0),
                'success': bool
            }
        """
        try:
            self.load_image(image_path)
            self.preprocess()
            self.find_gear_region()
            self.extract_gear_roi()
            self.detect_teeth()
            
            result = {
                'tooth_count': self.tooth_count,
                'confidence': float(self.confidence),
                'success': True,
                'gear_center': self.gear_center,
                'gear_radius': self.gear_radius
            }
            
            return result
            
        except Exception as e:
            return {
                'tooth_count': None,
                'confidence': 0.0,
                'success': False,
                'error': str(e)
            }
    
    def _show_image(self, title, img):
        """Debug helper to display image"""
        plt.figure(figsize=(8, 6))
        if len(img.shape) == 2:
            plt.imshow(img, cmap='gray')
        else:
            plt.imshow(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        plt.title(title)
        plt.axis('off')
        plt.show()


def test_algorithm(test_image_path=None):
    """
    Test the algorithm on a single image or demo dataset
    """
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
    # Example usage (uncomment and provide path)
    # result = test_algorithm("path/to/your/gear/image.jpg")
    
    print("Gear Tooth Counter - Phase 1 Algorithm")
    print("=" * 50)
    print("Ready to test. Call: test_algorithm('image_path.jpg')")
    print("\nOr use directly:")
    print("  counter = GearToothCounter(debug=True)")
    print("  result = counter.count('image_path.jpg')")
    print("  print(f'Teeth: {result[\"tooth_count\"]}, Confidence: {result[\"confidence\"]:.2%}')")
