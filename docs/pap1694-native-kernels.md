# PAP-1694 option A — exact-semantics native C++ preprocess kernels

2026-08-23 · Mobile Engineer · follows `docs/pap1694-opencv-preprocess-port.md`

## Why not the OpenCV binding

The ticket was written on the premise (from PAP-1685) that `preprocess` maps
1:1 onto OpenCV primitives, so `react-native-fast-opencv` would give the speedup
for free. Measuring the actual binding killed that premise, and QA independently
re-verified all three findings against the installed source on PAP-1697:

| JS primitive | `react-native-fast-opencv` 1.0.1 | share of stage |
|---|---|---|
| `rgbaToGray` | `cvtColor(RGBA2GRAY)` — byte-exact | 4.6% |
| `gaussianBlur5x5` | `GaussianBlur` — ≤2 LSB | 18.3% |
| `clahe` | **not bound at all** (no `createCLAHE`, no `equalizeHist`) | 16.6% |
| `cannyEdges` | `Canny` is bound but is a **different algorithm** — IoU 0.437, 1.84x the edge pixels, and the binding hardcodes `L2gradient=false` (the worse-matching variant, IoU 0.312) | 60.5% |

`edges` feeds the entire `detect` stage — centre, radius, contour and one count
method — so adopting OpenCV's edge map is an accuracy change, not an
optimisation, and would force exactly the corpus re-baseline AC5 exists to
prevent. Parity-safe use of the binding caps out at **1.30x**, against AC3's
10x. QA's verdict on PAP-1697: *"Agree, AC3 is unreachable via the binding as
specified. Concur with Option A."*

## What option A is

Our own C++ in `mobile/cpp/gear_kernels.cpp`: a line-by-line port of the four
functions in `mobile/src/algorithm/imageUtils.js`, with **byte-identical output
as a hard requirement** rather than a hoped-for property. Parity is closed by
construction, so there is nothing to re-baseline and AC5 is satisfied by AC2.

`react-native-fast-opencv` stays linked — `dft`, `mulSpectrums`, `magnitude` and
`warpPolar` are all bound, and those are what the `detect` port (PAP-1696)
needs.

The parity rules the port follows, each of which is load-bearing:

- JS numbers are doubles. Every expression the JS evaluates in floating point is
  evaluated in `double` here, with the same constants in the same association
  order.
- `Math.round(x)` is `floor(x + 0.5)` — it rounds .5 *up*, unlike `std::round`
  (away from zero) or `std::nearbyint` (to even). A dedicated `jsRound()` is
  used everywhere so the intent survives review.
- `x | 0` truncates toward zero. For the non-negative integer sums in
  `gaussianBlur5x5`, that is plain integer division.
- `Float32Array` narrows on every store. The Canny magnitude buffer is `float`,
  computed through a `double` `sqrt` and then narrowed, so the NMS comparisons
  see the same values the JS does.
- The hysteresis loop mutates its own buffer mid-raster-pass, so a pixel
  promoted to strong is visible to pixels later in the *same* pass. Iteration
  order and the in-place write are reproduced exactly, including the 20-pass cap
  from PAP-309.
- `-ffp-contract=off`. With contraction on, the compiler may fuse `a*b + c*d` in
  the CLAHE bilinear blend into FMAs, keeping more intermediate precision than
  the JS and shifting `Math.round` at ties. The flag is set identically in the
  parity harness and in the generated `CMakeLists.txt`; changing it in one place
  only would break parity for reasons unrelated to the port.

The one deviation from a literal transcription is a guarded fast path in
`cannyEdges`: when `gx == gy == 0` the JS computes `sqrt(0) == 0` and
`atan2(+0, +0) == +0` → bin 0, which is what the zero-initialised buffers
already hold. Skipping the `atan2` there is provably identical, and `atan2` is
the single most expensive operation in the kernel (~6% of stage time recovered).

## Evidence

**AC2 — byte parity, whole corpus.** `node mobile/__tests__/pap1694.native-parity.mjs 1 --bench`

```
images=431  byte-identical=431  allIdentical=true
```

All four stage outputs (`gray`, `clahe`, `blur`, `canny`) diffed byte-for-byte
against the JS on every cached 900px corpus image. Zero differing bytes, not
"within tolerance". Raw rows: `debug-reports/pap1694_native_parity.json`.

**Compiler-invariance.** The same corpus outputs were produced by g++ 13.3.0 and
by the NDK's clang 18.0.2 (`--target=x86_64-unknown-linux-gnu`) and compared
directly — identical. So parity is a property of the port, not of one compiler's
codegen.

**AC1 (C++ half) — compiles for every shipped ABI.** `gear_kernels.cpp` compiles
clean under NDK 27.1.12297006 for `aarch64`, `armv7a` and `x86_64`, and the full
`gearkernels` target (kernels + JSI + JNI) builds through the real Gradle/CMake
pipeline via `:app:externalNativeBuildDebug`.

That last step is why it was worth running rather than assuming: the first
attempt failed with `'createArrayBuffer' is a protected member of
facebook::jsi::Runtime`. The public route is `jsi::ArrayBuffer`'s
`(Runtime&, shared_ptr<MutableBuffer>)` constructor, which is what the code now
uses — a mistake no amount of reading the port would have caught.

**Test suite.** 53/53 jest tests pass, including 9 new ones covering the install
path — no native module linked, `install()` returning false, `install()`
throwing, semantics-version mismatch, memoisation, ArrayBuffer view offsets, and
a throwing native backend degrading the seam to JS.

## AC3 — what the host numbers do and do not say

Host, 431 images, plain node (never jest — see `project_profiling_never_under_jest`):

| | mean ms |
|---|---|
| JS (V8) | 106.2 |
| native C++ (x86-64) | 66.2 |
| per stage | gray 2.8 · clahe 9.8 · blur 8.4 · canny 45.2 |

**A 1.6x host speedup is not the device number and must not be quoted as one.**
V8 JITs this code well; Hermes does not JIT it at all, which is the entire
premise of PAP-1682. The device arithmetic:

- Device `preprocess` today is ~2.9-3.0s (Sentry `algoDiag.stageMs`, FP5).
- That implies ~27x Hermes-vs-host-V8 *for this stage*, consistent with the
  33-38x whole-pipeline figure in `docs/device-speed-reconciliation-2026-08-23.md`.
- Native ARM will be slower than native x86-64 for this scalar float work —
  call it 2-4x — so device native lands at roughly **130-270ms**, i.e. **11-22x**
  against the 2.9s baseline.

AC3's bar is 10x. The projection clears it, but the pessimistic end clears it by
little, and **this is an extrapolation, not a measurement**. Per QA's third
answer on PAP-1697 and `feedback_wallclock_gates_need_device_evidence`, AC3 is
not called until `stageMs.preprocessBackend == 'native-cpp'` shows up in Sentry
with a real `stageMs.preprocess` beside it. The telemetry field already ships
(added with the seam in `aec054c`).

Note also what AC3 does *not* buy on its own: at ~200ms preprocess the pipeline
is still `load` (~3.8s) + `detect` (JS), so the 5s product target still depends
on PAP-1696 (detect port) and on the load stage.

## Wiring

`android/` is gitignored and regenerated by `expo prebuild`, so every piece of
native wiring lives in `mobile/plugins/withGearKernelsPlugin.js`:

1. copies `mobile/cpp/*.{h,cpp}` into `android/app/src/main/cpp/`
2. writes `CMakeLists.txt` (links `ReactAndroid::jsi` via prefab, sets the
   `-ffp-contract=off` flag)
3. adds `buildFeatures { prefab true }` + `externalNativeBuild` to
   `android/app/build.gradle`
4. writes `GearKernelsModule.kt` / `GearKernelsPackage.kt`
5. registers the package in `MainApplication.kt`

`GearKernelsModule.install()` is a blocking synchronous method that hands the
`jsi::Runtime` pointer to C++, which sets `globalThis.__gearKernels`.
`mobile/src/algorithm/nativeKernels.js` calls it once from `index.js` at
startup and installs the backend into the existing `preprocess` seam.

Every failure path is a silent downgrade to the JS backend, because a device
without the `.so` must still count teeth:

- native module not linked → JS
- `System.loadLibrary` fails → JS (loaded lazily, not in a static initialiser,
  so an `UnsatisfiedLinkError` cannot take the module registry down with it)
- no JSI runtime pointer → JS
- `version` ≠ `EXPECTED_SEMANTICS_VERSION` → JS. This one is a *refusal*, not a
  fallback-on-error: a JS/`.so` disagreement about what `preprocess` means would
  silently produce a different edge map, which is the exact AC5 failure.
- a throw at call time → JS for the rest of the session (`js-fallback`, and the
  backend name travels in telemetry so a mid-run degrade is visible)

## Status against the ACs

| AC | State |
|---|---|
| AC1 debug+release variants | C++ cross-compiles for all ABIs; plugin verified to generate correct gradle/CMake/Kotlin via `expo prebuild`. **Full `assembleDebug`/`assembleRelease` not yet run** — that is the build gated on QA review. |
| AC2 byte-parity | **Met.** 431/431 images byte-identical, two compilers. |
| AC3 ≥10x on device | **Open.** Projection is 11-22x; needs `stageMs.preprocessBackend == 'native-cpp'` from a real FP5 session. |
| AC4 detect port | Filed as PAP-1696, not blocking this ticket. |
| AC5 no accuracy regression | **Follows from AC2** — byte-identical inputs to `analyzeImage` cannot change the count. No re-baseline needed. |

## Open risks

- **Bridgeless.** `newArchEnabled=true`, so the app runs bridgeless.
  `GearKernelsModule` is a legacy `ReactContextBaseJavaModule` reached through
  the interop layer and takes the runtime pointer from
  `reactApplicationContext.javaScriptContextHolder`. That works in bridgeless in
  RN 0.81, but it is the piece most likely to need adjusting once a real build
  runs, and it fails safe (returns false → JS backend).
- **ARM parity.** Parity is proven on x86-64 with two compilers. `double`
  arithmetic is IEEE-754 on both, and `-ffp-contract=off` removes the one
  ARM-specific hazard (a2+ has FMA), but `atan2` is a libm function and bionic's
  aarch64 implementation is not bit-guaranteed to match glibc's. If it ever
  differs it would move a handful of pixels between adjacent gradient bins. The
  on-device check for this is a `preprocessBackend` A/B on the same photo, and
  it should be part of the AC3 device session.
