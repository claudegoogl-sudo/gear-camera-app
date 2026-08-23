// PAP-1694 option A — exact-semantics C++ ports of the `preprocess` kernels.
//
// These are deliberately NOT OpenCV.  react-native-fast-opencv 1.0.1 binds
// neither createCLAHE nor equalizeHist, and its cv::Canny is a different
// algorithm from ours (IoU 0.437 against the JS edge map — see
// docs/pap1694-opencv-preprocess-port.md).  Swapping in OpenCV's primitives
// would be an accuracy change requiring a full re-baseline, which is exactly
// what AC5 exists to prevent.
//
// So each function below is a line-by-line port of the corresponding function
// in mobile/src/algorithm/imageUtils.js, with byte-for-byte identical output
// as a hard requirement, verified over the 431-image corpus by
// mobile/__tests__/pap1694.native-parity.mjs.
//
// Parity rules followed throughout — every one of these is load-bearing:
//
//   * JS numbers are IEEE-754 doubles.  Any expression the JS evaluates in
//     floating point is evaluated here in `double`, never `float`, and with
//     the same constants in the same association order.
//   * `Math.round(x)` is floor(x + 0.5) — it rounds .5 UP, not away from zero
//     and not to even.  `std::round` differs for negatives; all values here
//     are non-negative, but jsRound() is used anyway so the intent is explicit.
//   * `x | 0` truncates toward zero.  For the non-negative integer sums in
//     gaussianBlur5x5 that is plain integer division.
//   * `Float32Array` stores narrow a double to float on every write.  The
//     Canny magnitude buffer is therefore `float`, computed via a double
//     sqrt and then narrowed, so the NMS comparisons see the same values.
//   * The hysteresis loop mutates its own buffer mid-raster-pass, so a pixel
//     promoted to strong is visible to pixels later in the SAME pass.  The
//     iteration order and in-place write are reproduced exactly.
//
// No dependency beyond the C++ standard library, so the same translation unit
// compiles for the NDK (arm64-v8a/armeabi-v7a) and for the host g++ parity CLI.

#pragma once

#include <cstdint>
#include <cstddef>

namespace gearkernels {

// Version of the kernel semantics.  Bumped whenever an output could change;
// exposed to JS so a build can assert the native side matches what the JS
// fallback would have produced.
constexpr int kSemanticsVersion = 1;

// rgbaToGray: BT.601 luma, Math.round.  in = w*h*4 bytes, out = w*h bytes.
void rgbaToGray(const uint8_t* rgba, int width, int height, uint8_t* out);

// gaussianBlur5x5: separable [1,4,6,4,1]/16, clamped edges, truncating divide.
// `scratch` must be at least w*h bytes; pass nullptr to allocate internally.
void gaussianBlur5x5(const uint8_t* gray, int width, int height, uint8_t* out,
                     uint8_t* scratch = nullptr);

// clahe: tiled clipped-histogram equalisation with bilinear map interpolation.
void clahe(const uint8_t* gray, int width, int height, double clipLimit,
           int tilesX, int tilesY, uint8_t* out);

// cannyEdges: Sobel -> 4-direction NMS -> double threshold -> hysteresis
// capped at 20 raster passes (PAP-309).  Output is 0 or 255.
void cannyEdges(const uint8_t* gray, int width, int height, double low,
                double high, uint8_t* out);

// The whole preprocess stage, matching JS_BACKEND.run in
// mobile/src/algorithm/preprocess.js:
//   rgbaToGray -> clahe(3.0, 8, 8) -> gaussianBlur5x5 -> cannyEdges(50, 150)
// Each of gray/enhanced/blurred/edges must point to a w*h buffer.
void preprocess(const uint8_t* rgba, int width, int height, uint8_t* gray,
                uint8_t* enhanced, uint8_t* blurred, uint8_t* edges);

}  // namespace gearkernels
