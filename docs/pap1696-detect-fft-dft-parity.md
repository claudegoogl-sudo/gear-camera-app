# PAP-1696 — `detect`'s radial-FFT sweep: `cv::dft` parity study

Algorithm Engineer, 2026-08-23. Child of [PAP-1694](/PAP/issues/PAP-1694) (AC4).

**Bottom line up front.** Unlike PAP-1694's preprocess primitives (CLAHE
absent from the binding, `cv::Canny` IoU 0.437 vs ours), the FFT core has
**no accuracy risk**: `cv::dft`'s magnitude spectrum matches our hand-rolled
radix-2 `fftMagnitude()` to float64 machine precision (max relative error
3.4e-14 across 120 real corpus-derived signals) and to float32 machine
precision (1.8e-7) if the port uses single precision. Zero peak-bin
(tooth-count-decisive) mismatches at either precision. This is expected —
unlike CLAHE/Canny (heuristics with implementation-specific conventions), the
DFT is a single well-defined linear transform, so any correct implementation
of it must agree up to floating-point rounding. The actual C++ port is
**not blocked on an accuracy re-baseline decision** the way preprocess was.

What *is* blocking: the native C++/CMake scaffolding this port needs to live
in doesn't exist in `main` yet (PAP-1694 AC1-AC3, Option A). That work is
in progress now ([PAP-1694](/PAP/issues/PAP-1694), QA-approved on
[PAP-1697](/PAP/issues/PAP-1697)). This ticket does the per-primitive parity
prep the parent description asked for, ahead of that landing.

---

## 1. Scope of "the radial-FFT sweep"

`fftMagnitude()` (`mobile/src/algorithm/fft.js`) is called from 6 sites in
`gearCounter.js`, all inside `analyzeImage()` (the `detect` stage —
`stageMs.detect`, `gearCounter.js:3609`). Every call site follows the same
shape (`fftCountAtRadius`, `gearCounter.js:708`, is the canonical one):

```
sampleIntensityRing(enhanced, cx, cy, r, w, h, nAngles)   // ring sample
  -> savgolSmooth(ring, halfWin, wrap=true)                // SG smoothing
  -> mean-subtract                                          // "centered"
  -> fftMagnitude(centered)                                 // <- this ticket
  -> harmonic-weighted scoring over mag[MIN_TEETH..MAX_TEETH]
```

`fftMagnitude` itself is the DFT core in scope for `cv::dft` ("cv::dft core"
per the ticket title). `sampleIntensityRing` (candidate for `cv::warpPolar`,
per the parent ticket) and `savgolSmooth` (a separate FIR-filter primitive,
no direct `cv::dft`-family equivalent) are adjacent primitives with their own
porting profile — flagged for a follow-up parity study, out of scope here.

**Key structural fact:** every call site samples at a fixed, already-power-
-of-two length — `N_ANGLES = 1024` (`gearCounter.js:42`, 5 of 6 call sites)
or `BC_ANGLES = 4096` (`traceOuterContour`'s path, `gearCounter.js:2056`).
**Correction (QA cross-check, [PAP-1698](/PAP/issues/PAP-1698)):** a third
N exists — `fftPurityCheck(..., fast=true)` (`gearCounter.js:761`) sets
`nAngles = 256` for its coarse grid-search-screening path, which then calls
`fftMagnitude` at line 803. This wasn't caught by grepping the two named
constants and wasn't in the 120-case parity dump. It doesn't change the
port-safety conclusion — 256 is still a power of two, so
`fftMagnitude`'s zero-pad branch still never fires for it — but the parity
*measurement* only covers N=1024/4096, not N=256. `fftMagnitude`'s "pad to
next power of two" branch (`fft.js:14-16`) is therefore **dead code in
every production call** — real usage is always an exact N=256, N=1024, or
N=4096 real-input DFT. That removes an entire class of padding/convention
ambiguity from the port: there's no "what does cv::dft do with a
non-power-of-two signal" question to answer, and 256 (2^8), 1024 (2^10),
and 4096 (2^12) are already optimal sizes for OpenCV's mixed-radix DFT
(`getOptimalDFTSize` would return them unchanged).

## 2. Method

Mirrors PAP-1694's `pap1694_opencv_parity.py` template:

- `mobile/__tests__/pap1696.dump-fft-js.mjs` — for a stride sample of the
  cached corpus (`.cache/training-rgba/`, 900px cap), runs the real
  `preprocess()` to get `enhanced`, then reproduces `fftCountAtRadius`'s
  exact pipeline (`sampleIntensityRing` from `gearCounter.js`'s `__test`
  export, real `savgolSmooth`, real mean-subtract) at 4 radius fractions
  (0.15/0.25/0.35/0.45 of the aim-circle radius) × both N cases (1024, 4096).
  `cx`/`cy` use the image-center convention (matches `countTeethFromRgba`'s
  `aimR` anchor, PAP-1100) rather than a full `findGearCenter` candidate
  search — DFT parity is a linear-transform property independent of which
  candidate center produced the ring, so this is sufficient for primitive
  parity without depending on `findGearCenter`'s sweep contract. Dumps the
  real `centered` DFT input and the real JS `fftMagnitude` output per case.
  120 (image, radius, N) cases from a stride-10 corpus sample.
- `mobile/__tests__/pap1696_dft_parity.py` — loads each `centered` signal,
  computes `cv2.dft(src, flags=DFT_COMPLEX_OUTPUT)` → split → `cv2.magnitude`
  (the standard magnitude-spectrum idiom, and exactly what a C++ kernel
  calling the binding's exposed `dft`/`magnitude` primitives would do), diffs
  against the JS magnitude at both float64 and float32, and separately reports
  error within the harmonic-scoring band (`mag[MIN_TEETH..MAX_TEETH]`,
  `gearCounter.js:726`) since that's the only region the algorithm reads.

Full results: `debug-reports/pap1696_dft_parity_2026-08-23.json` (240 rows —
120 cases × {f64, f32}). **Coverage note:** cases are N=1024/4096 only;
N=256 (`fftPurityCheck` fast mode, §1 above) was not measured. The
linearity argument in §4 still applies to it (any correct `cv::dft` agrees
with any correct FFT up to float rounding, independent of N), but there is
no direct empirical measurement at N=256 the way there is for 1024/4096.

## 3. Results

| precision | max rel err (all bins) | max rel err (teeth band 10-65) | max abs err (teeth band) | peak-bin mismatches |
|---|---|---|---|---|
| float64 | 3.36e-14 | 6.60e-16 | 5.46e-11 | 0/120 |
| float32 | 1.84e-07 | 1.22e-07 | 4.58e-03 | 0/120 |

Both are at the respective format's machine-epsilon floor (float64 ε≈2.2e-16,
float32 ε≈1.2e-7) — i.e. the residual is pure floating-point rounding from
different summation orders (our radix-2 DIT butterfly vs OpenCV's mixed-radix
implementation), not a semantic/convention difference. `argmax` over the
tooth-count band — the value that actually drives `bestF`/`toothCount` in
`fftCountAtRadius` — never disagrees, at either precision.

## 4. Implication for the port

- **No accuracy re-baseline risk from the DFT core itself.** Unlike Canny/
  CLAHE, swapping `fftMagnitude`'s butterfly for `cv::dft` + `cv::magnitude`
  is byte-parity-safe by construction (mod float rounding), so AC5 (no
  regression vs the 58.0% baseline, [PAP-1658](/PAP/issues/PAP-1658)) is not
  at risk from this specific primitive. Either float32 or float64 is safe to
  use in the kernel; float32 halves the buffer size and is the more natural
  `cv::Mat` default, and its 4.6e-3 absolute error at the teeth band is
  negligible against the signal's actual dynamic range (raw magnitudes at
  real gear-tooth peaks run 10-1000+, per the dumped corpus).
- **Fixed N=1024/4096 simplifies the kernel design.** The C++ kernel doesn't
  need `getOptimalDFTSize`-driven dynamic padding logic — it can allocate
  fixed-size 1024 and 4096 `cv::Mat` buffers once and reuse them across the
  sweep (mirroring the JS side's own `PAP-555` buffer-reuse pattern already
  in `findGearCenter`).
- **Adjacent primitives still need their own study.** `sampleIntensityRing`
  (ring resampling — `cv::warpPolar` candidate) and `savgolSmooth` (FIR
  smoothing — no direct `cv::` primitive, but its coefficients are a fixed,
  precomputable kernel, so `cv::filter2D` may also be byte-parity-safe; this
  needs its own diff, not assumed from the DFT result) are not covered by
  this study and should each get the same per-primitive treatment before the
  full sweep pipeline is wired into C++.

## 5. Status

Blocked on [PAP-1694](/PAP/issues/PAP-1694)'s native C++/CMake scaffolding
landing (Option A, QA-approved on [PAP-1697](/PAP/issues/PAP-1697), currently
in progress). This parity study itself is complete; QA cross-check
([PAP-1698](/PAP/issues/PAP-1698)) verdict is **CONFIRMED**, with one
non-blocking correction applied to this doc (the N=256 fast-mode call site
at `gearCounter.js:761`, folded into §1/§2 above 2026-08-23). Conclusion
unchanged: no accuracy re-baseline risk from the DFT-core swap.
