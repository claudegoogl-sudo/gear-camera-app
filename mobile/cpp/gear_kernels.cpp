#include "gear_kernels.h"

#include <cmath>
#include <algorithm>
#include <cstring>
#include <vector>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace gearkernels {
namespace {

// JS `Math.round`: floor(x + 0.5).  Differs from std::round for negatives and
// from std::nearbyint for exact .5; see the header note.
inline double jsRound(double x) { return std::floor(x + 0.5); }

inline uint8_t clampToByte(double v) {
  if (v < 0.0) return 0;
  if (v > 255.0) return 255;
  return static_cast<uint8_t>(v);
}

}  // namespace

void rgbaToGray(const uint8_t* rgba, int width, int height, uint8_t* out) {
  const size_t len = static_cast<size_t>(width) * static_cast<size_t>(height);
  for (size_t i = 0; i < len; i++) {
    const size_t j = i * 4;
    // ITU-R BT.601 luminance weights — same literals, same order as the JS.
    const double v = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    out[i] = clampToByte(jsRound(v));
  }
}

void gaussianBlur5x5(const uint8_t* gray, int width, int height, uint8_t* out,
                     uint8_t* scratch) {
  static const int kernel[5] = {1, 4, 6, 4, 1};
  const int kSum = 16;
  const size_t len = static_cast<size_t>(width) * static_cast<size_t>(height);

  std::vector<uint8_t> owned;
  uint8_t* tmp = scratch;
  if (tmp == nullptr) {
    owned.resize(len);
    tmp = owned.data();
  }

  // Horizontal pass.  `sum` is a non-negative integer (max 255*16), so the
  // JS `(sum / kSum) | 0` truncation is plain integer division here.
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      int sum = 0;
      for (int k = -2; k <= 2; k++) {
        int sx = x + k;
        if (sx < 0) sx = 0;
        if (sx > width - 1) sx = width - 1;
        sum += gray[static_cast<size_t>(y) * width + sx] * kernel[k + 2];
      }
      tmp[static_cast<size_t>(y) * width + x] = static_cast<uint8_t>(sum / kSum);
    }
  }

  // Vertical pass.
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      int sum = 0;
      for (int k = -2; k <= 2; k++) {
        int sy = y + k;
        if (sy < 0) sy = 0;
        if (sy > height - 1) sy = height - 1;
        sum += tmp[static_cast<size_t>(sy) * width + x] * kernel[k + 2];
      }
      out[static_cast<size_t>(y) * width + x] = static_cast<uint8_t>(sum / kSum);
    }
  }
}

void clahe(const uint8_t* gray, int width, int height, double clipLimit,
           int tilesX, int tilesY, uint8_t* out) {
  const size_t len = static_cast<size_t>(width) * static_cast<size_t>(height);
  const int tileW = width / tilesX;   // Math.floor, both operands positive
  const int tileH = height / tilesY;
  if (tileW < 2 || tileH < 2) {       // too small — JS returns a copy
    std::memcpy(out, gray, len);
    return;
  }

  const int nPixels = tileW * tileH;
  int clipCount = static_cast<int>(std::floor(clipLimit * nPixels / 256.0));
  if (clipCount < 1) clipCount = 1;

  // maps[ty][tx] -> 256-entry mapping, flattened.
  std::vector<uint8_t> maps(static_cast<size_t>(tilesY) * tilesX * 256);

  std::vector<int32_t> hist(256);
  for (int ty = 0; ty < tilesY; ty++) {
    for (int tx = 0; tx < tilesX; tx++) {
      const int x0 = tx * tileW;
      const int y0 = ty * tileH;

      std::fill(hist.begin(), hist.end(), 0);
      for (int dy = 0; dy < tileH; dy++) {
        const size_t row = static_cast<size_t>(y0 + dy) * width + x0;
        for (int dx = 0; dx < tileW; dx++) hist[gray[row + dx]]++;
      }

      // Clip and redistribute.
      int64_t excess = 0;
      for (int i = 0; i < 256; i++) {
        if (hist[i] > clipCount) {
          excess += hist[i] - clipCount;
          hist[i] = clipCount;
        }
      }
      const int64_t perBin = excess / 256;          // Math.floor, excess >= 0
      int64_t leftover = excess - perBin * 256;
      for (int i = 0; i < 256; i++) {
        hist[i] += static_cast<int32_t>(perBin);
        if (leftover > 0) { hist[i]++; leftover--; }
      }

      uint8_t* mapping = &maps[(static_cast<size_t>(ty) * tilesX + tx) * 256];
      int64_t cdf = 0;
      for (int i = 0; i < 256; i++) {
        cdf += hist[i];
        double v = jsRound((static_cast<double>(cdf) * 255.0) / nPixels);
        if (v > 255.0) v = 255.0;                   // Math.min(255, ...)
        mapping[i] = static_cast<uint8_t>(v);
      }
    }
  }

  // Bilinear interpolation of the tile mappings.
  const double halfTileH = tileH / 2.0;
  const double halfTileW = tileW / 2.0;
  const double maxTy = tilesY - 1 - 1e-6;
  const double maxTx = tilesX - 1 - 1e-6;

  for (int y = 0; y < height; y++) {
    double tyf = (y - halfTileH) / tileH;
    if (tyf < 0.0) tyf = 0.0;
    if (tyf > maxTy) tyf = maxTy;
    const int ty0 = static_cast<int>(std::floor(tyf));
    const int ty1 = (ty0 + 1 < tilesY - 1) ? ty0 + 1 : tilesY - 1;
    const double fy = tyf - ty0;

    for (int x = 0; x < width; x++) {
      double txf = (x - halfTileW) / tileW;
      if (txf < 0.0) txf = 0.0;
      if (txf > maxTx) txf = maxTx;
      const int tx0 = static_cast<int>(std::floor(txf));
      const int tx1 = (tx0 + 1 < tilesX - 1) ? tx0 + 1 : tilesX - 1;
      const double fx = txf - tx0;

      const uint8_t v = gray[static_cast<size_t>(y) * width + x];
      const double tl = maps[(static_cast<size_t>(ty0) * tilesX + tx0) * 256 + v];
      const double tr = maps[(static_cast<size_t>(ty0) * tilesX + tx1) * 256 + v];
      const double bl = maps[(static_cast<size_t>(ty1) * tilesX + tx0) * 256 + v];
      const double br = maps[(static_cast<size_t>(ty1) * tilesX + tx1) * 256 + v];

      // Same association order as the JS expression.
      const double acc = tl * (1 - fx) * (1 - fy) + tr * fx * (1 - fy) +
                         bl * (1 - fx) * fy + br * fx * fy;
      out[static_cast<size_t>(y) * width + x] = clampToByte(jsRound(acc));
    }
  }
}

void cannyEdges(const uint8_t* gray, int width, int height, double low,
                double high, uint8_t* out) {
  const size_t len = static_cast<size_t>(width) * static_cast<size_t>(height);
  // Float32Array in the JS — narrowing on every store is part of the contract.
  std::vector<float> mag(len, 0.0f);
  std::vector<uint8_t> dir(len, 0);

  const double kRadToDeg = 180.0 / M_PI;

  // ── Sobel gradient ──────────────────────────────────────────────────────
  for (int y = 1; y < height - 1; y++) {
    for (int x = 1; x < width - 1; x++) {
      const size_t i = static_cast<size_t>(y) * width + x;
      const int gx =
          -gray[i - width - 1] + gray[i - width + 1] +
          -2 * gray[i - 1] + 2 * gray[i + 1] +
          -gray[i + width - 1] + gray[i + width + 1];
      const int gy =
          -gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1] +
           gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1];

      // Provably-identical fast path, not an approximation: for gx == gy == 0
      // the JS computes sqrt(0) == 0 and atan2(+0, +0) == +0, which lands in
      // bin 0 — exactly what the zero-initialised buffers already hold.  Flat
      // regions are most of a typical frame and atan2 is the single most
      // expensive operation in this kernel, so skipping it there is free
      // speed with no parity risk.
      if (gx == 0 && gy == 0) continue;

      mag[i] = static_cast<float>(
          std::sqrt(static_cast<double>(gx) * gx + static_cast<double>(gy) * gy));

      double angle = std::atan2(static_cast<double>(gy), static_cast<double>(gx)) * kRadToDeg;
      if (angle < 0) angle += 180;
      if (angle < 22.5 || angle >= 157.5) dir[i] = 0;       // horizontal
      else if (angle < 67.5) dir[i] = 1;                    // 45 deg
      else if (angle < 112.5) dir[i] = 2;                   // vertical
      else dir[i] = 3;                                      // 135 deg
    }
  }

  // ── Non-maximum suppression ─────────────────────────────────────────────
  std::vector<float> nms(len, 0.0f);
  for (int y = 1; y < height - 1; y++) {
    for (int x = 1; x < width - 1; x++) {
      const size_t i = static_cast<size_t>(y) * width + x;
      float p1, p2;
      switch (dir[i]) {
        case 0: p1 = mag[i - 1]; p2 = mag[i + 1]; break;
        case 1: p1 = mag[i - width + 1]; p2 = mag[i + width - 1]; break;
        case 2: p1 = mag[i - width]; p2 = mag[i + width]; break;
        default: p1 = mag[i - width - 1]; p2 = mag[i + width + 1]; break;
      }
      nms[i] = (mag[i] >= p1 && mag[i] >= p2) ? mag[i] : 0.0f;
    }
  }

  // ── Double-threshold hysteresis ─────────────────────────────────────────
  for (size_t i = 0; i < len; i++) {
    if (nms[i] >= high) out[i] = 255;
    else if (nms[i] >= low) out[i] = 128;
    else out[i] = 0;
  }

  // PAP-309: capped at 20 passes.  The JS writes `edges` in place, so a pixel
  // promoted within a pass is visible to later pixels of the same pass —
  // reproduced here, including the redundant dx=dy=0 neighbour check (a no-op,
  // since the centre pixel is 128 at that point).
  bool changed = true;
  int hysteresisIter = 0;
  const int kMaxHysteresisIter = 20;
  while (changed && hysteresisIter < kMaxHysteresisIter) {
    changed = false;
    hysteresisIter++;
    for (int y = 1; y < height - 1; y++) {
      for (int x = 1; x < width - 1; x++) {
        const size_t i = static_cast<size_t>(y) * width + x;
        if (out[i] != 128) continue;
        for (int dy = -1; dy <= 1; dy++) {
          for (int dx = -1; dx <= 1; dx++) {
            if (out[static_cast<size_t>(y + dy) * width + (x + dx)] == 255) {
              out[i] = 255;
              changed = true;
            }
          }
        }
      }
    }
  }

  for (size_t i = 0; i < len; i++) {
    if (out[i] != 255) out[i] = 0;
  }
}

void preprocess(const uint8_t* rgba, int width, int height, uint8_t* gray,
                uint8_t* enhanced, uint8_t* blurred, uint8_t* edges) {
  rgbaToGray(rgba, width, height, gray);
  clahe(gray, width, height, 3.0, 8, 8, enhanced);
  gaussianBlur5x5(enhanced, width, height, blurred);
  cannyEdges(blurred, width, height, 50, 150, edges);
}

}  // namespace gearkernels
