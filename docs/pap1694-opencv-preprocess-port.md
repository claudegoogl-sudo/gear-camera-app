# PAP-1694 — react-native-fast-opencv integration + `preprocess` port

Mobile Engineer, 2026-08-23. Follow-on from PAP-1682 (device-speed
reconciliation) and PAP-1685 (QA architecture cross-check).

**Bottom line up front.** The library integrates cleanly on this stack and the
seam is landed, but **AC3 (10x faster `preprocess`) is not reachable by calling
react-native-fast-opencv's primitives**, for two measured reasons: the binding
does not expose CLAHE at all, and its `Canny` is not semantically equivalent to
ours (IoU 0.437 against the current edge map). The two primitives that *are*
equivalent are worth 22.9% of the stage — a 1.30x ceiling. Section 5 has the
options; my recommendation is at the end.

---

## 1. Compatibility — verified, no build run yet

`react-native-fast-opencv@1.0.1` (published 2026-08-03) is a codegen
TurboModule built against RN 0.85. This app is **RN 0.81.5 / Expo 54 /
newArchEnabled=true**. Everything the module actually touches exists on 0.81.5:

| requirement | source | status on RN 0.81.5 |
|---|---|---|
| `ReactContext.getJSCallInvokerHolder()` | `FastOpencvModule.kt` | present — `ReactContext.java:503`, returns `CallInvokerHolder` |
| `ReactContext.getJavaScriptContextHolder()` | `FastOpencvModule.kt` | present — `ReactContext.java:497` |
| `BaseReactPackage` | `FastOpencvPackage.kt` | present |
| `ReactAndroid::reactnative` prefab target | `android/CMakeLists.txt` | present (unified lib, RN 0.76+) |
| `target_compile_reactnative_options()` | generated codegen CMakeLists | present — used by RN 0.81.5's own `ReactNative-application.cmake:71` |
| NDK 27.1.12297006 | library `build.gradle` | exact match with this app's `ndkVersion` |
| autolinking resolves the module | `expo-modules-autolinking react-native-config` | resolves, incl. `cmakeListsPath` to `generated/jni/CMakeLists.txt` |

The TurboModule surface is a single `install(): boolean` — everything else is
installed as a JSI global — so the codegen-ABI exposure to the 0.85-vs-0.81
version skew is about as small as it gets.

Two build-time items that still need attention and that I have **not** resolved
because they need a real gradle run (held for QA sign-off, per the build gate):

- **APK size.** `org.opencv:opencv:4.12.0` ships uncompressed `.so`s: arm64-v8a
  23.5 MB, armeabi-v7a 15.6 MB, x86 41.7 MB, x86_64 55.8 MB — **~136 MB across
  the four ABIs** `gradle.properties` currently builds. With
  `expo.useLegacyPackaging=false` those are stored uncompressed and page-aligned,
  so the current ~194 MB debug APK would land near ~330 MB. Test builds should
  set `reactNativeArchitectures=arm64-v8a` (plus `x86_64` only if an emulator is
  needed). This is a build-config decision, not a code one.
- **`libc++_shared.so` collision.** The OpenCV AAR ships its own copy under
  `jni/<abi>/`. `react-native-fast-opencv` excludes *its* copy but not the AAR's,
  so AGP may need a `pickFirst`. Will show up on the first `assembleDebug`.

The OpenCV AAR manifest declares only `minSdkVersion 21` and no `compileSdk`
floor, so this app's `compileSdkVersion = 34` is fine (the library's own
`build.gradle` asks for 36 but reads `rootProject.ext` first, so it inherits 34).

## 2. Where the `preprocess` time actually goes

`preprocess` is exactly four calls. Measured per-primitive on 54 corpus images
at the 900 px cap, plain node v22 (never jest — babel-jest inflates typed-array
loops ~400x):

| primitive | mean | p50 | p95 | share of stage |
|---|---|---|---|---|
| `rgbaToGray` | 5.17 ms | 4.88 | 6.37 | **5.0%** |
| `clahe(3.0, 8, 8)` | 17.03 ms | 15.88 | 20.98 | **16.6%** |
| `gaussianBlur5x5` | 18.39 ms | 18.13 | 25.58 | **17.9%** |
| `cannyEdges(50, 150)` | 62.07 ms | 58.57 | 86.27 | **60.5%** |
| total | 102.66 ms | 98.52 | 132.26 | 100% |

Consistent with PAP-1682's desktop `preprocess` p50 of 90 ms. Script:
`mobile/__tests__/pap1694.preprocess-split.mjs`, raw rows in
`debug-reports/pap1694_preprocess_split.json`.

**Canny alone is 60% of the stage.** It is both the biggest prize and, per the
next section, the biggest risk.

## 3. OpenCV-vs-JS parity, per primitive

Host `cv2 4.13.0` standing in for the on-device 4.12.0 — same algorithms and
same defaults, so this is a semantics check, not a bit-exactness claim across
OpenCV builds. 22 corpus images; JS planes dumped by
`pap1694.dump-js-stages.mjs`, diffed by `pap1694_opencv_parity.py`, raw in
`debug-reports/pap1694_opencv_parity.json`.

| stage | cv2 equivalent | mean abs Δ | max abs Δ | pixels differing |
|---|---|---|---|---|
| `rgbaToGray` | `cvtColor(COLOR_RGBA2GRAY)` | **0.00** | <1 | **0.0%** |
| `gaussianBlur5x5` | `GaussianBlur((5,5), 0, BORDER_REPLICATE)` | 0.92 | **2** | 89% (all ≤2 LSB) |
| `clahe` | `createCLAHE(3.0, (8,8))` | 1.20 | 11 | 68% |

| edge map | JS edge px | cv2 edge px | **IoU** | pixels disagreeing |
|---|---|---|---|---|
| `Canny(50,150, L2gradient=True)` | 1.70% | 3.13% | **0.437** | 1.84% |
| `Canny(50,150, L2gradient=False)` | 1.70% | 4.15% | **0.312** | 3.10% |

Reading these:

- **gray is byte-exact.** Safe to port, worth 5.0%.
- **blur differs by rounding only.** OpenCV picks the identical
  `[1,4,6,4,1]/16` kernel from its small-kernel table for `ksize=5, sigma=0`;
  the JS truncates each pass with `|0` where OpenCV rounds. Max delta 2 LSB,
  bounded. Safe to port, worth 17.9%.
- **CLAHE has no binding.** `cv::createCLAHE` — and `equalizeHist` — are simply
  absent from `cpp/FOCV_Function.cpp`'s dispatch table in 1.0.1. The ticket's
  premise that "`preprocess` maps 1:1 onto existing OpenCV primitives" holds for
  OpenCV the library but not for this binding. Worth 16.6%, unavailable.
- **Canny is not a drop-in.** Less than half the edge pixels agree, and OpenCV
  emits **1.84x** as many. The causes are in our own code and are deliberate:
  `cannyEdges` caps hysteresis at 20 raster passes (PAP-309, explicitly for
  mobile cost) where OpenCV propagates connectivity to completion, and quantises
  NMS to 4 directions where OpenCV interpolates. Worse, the binding **hardcodes
  `L2gradient=false`** — it forwards neither the aperture nor the L2 flag — and
  that is the *worse*-matching variant (IoU 0.312).

`edges` is consumed by the entire detect stage — centre search, radius search,
contour tracing and one of the five count methods. Substituting an edge map that
shares 44% of its pixels with the current one is an **accuracy change**, not an
optimisation, and would need a full re-baseline against PAP-1658's 58.0%.

## 4. What this means for AC3

Apportioning the device's measured `preprocess` = 2938 ms (PAP-1682, b132, n=5)
by the host shares above — which assumes all four primitives carry the same
Hermes penalty; they scale together at 33–38x elsewhere, so this is reasonable
but is an estimate, not a device measurement:

| scenario | native | stays JS | device `preprocess` | speedup | AC3 (10x)? |
|---|---|---|---|---|---|
| `safe` (shipped default off) | gray + blur | clahe + canny | ~2265 ms | **1.30x** | no |
| `opencv-canny` | gray + blur + canny | clahe | ~488 ms | **6.0x** | no |
| all four native | all four | — | ≪ 294 ms | >10x | yes |

**Neither mode reachable with the stock binding meets AC3**, and the only one
that would (all four native) requires both a CLAHE binding that does not exist
*and* accepting the Canny semantic change that AC5 is there to prevent.

## 5. Options

**A. Port the four kernels to C++ as exact ports of the current JS semantics.**
Byte-parity by construction, so AC2 and AC5 are satisfied trivially rather than
by re-baselining. C++ vs Hermes on tight `uint8` loops is exactly the 33–38x
regime PAP-1682 measured, so >10x on the stage is the expected outcome, not a
hope. Keep react-native-fast-opencv linked anyway — it is what makes AC4 cheap
(`dft`, `getOptimalDFTSize`, `mulSpectrums`, `magnitude`, `cartToPolar`,
`warpPolar` are all bound, which is the radial-FFT sweep's shopping list).
Cost: our own C++ + CMake scaffolding in the app, which this repo does not have
yet (the existing `withExtractYPlanePlugin` injects Kotlin, not C++).

**B. Patch the binding to expose CLAHE, and accept OpenCV's Canny.** ~15 lines
of C++ in `FOCV_Function.cpp` (upstreamable), carried locally via
`patch-package`. Gets AC3, but hands `detect` a different edge map *and* a
different CLAHE output, so AC5 becomes a full corpus re-baseline plus, very
likely, a re-tune of the thresholds calibrated against today's edge density.
Given the PAP-1583/1616 history — where an accuracy delta turned out to be a
harness artifact and cost months — I would not spend that risk here.

**C. Ship `safe` mode only and renegotiate AC3.** 1.30x on `preprocess`, i.e.
~670 ms off a ~36 s device total. Honest but close to pointless on its own.

**Recommendation: A**, with the library kept linked for AC4. B's speedup is
real but is bought with an accuracy change that this codebase has repeatedly
found expensive to price; A gets the same speedup with the parity question
closed by construction.

## 6. What landed in this ticket

- `react-native-fast-opencv@1.0.1` added to `mobile/package.json`; autolinking
  verified on RN 0.81.5.
- `mobile/src/algorithm/preprocess.js` — the backend seam. `countTeeth` (all
  three call sites, including the hi-res retry) and `countTeethFromRgba` now
  route through it. Default backend is pure JS and byte-identical to the
  inlined code it replaced.
- `mobile/src/algorithm/nativePreprocess.js` — the OpenCV backend, `safe` and
  `opencv-canny` modes, lazily and defensively loaded so an unlinked binary,
  jest and the node harnesses all keep working; falls back to JS permanently if
  it ever throws mid-run.
- `stageMs.preprocessBackend` added to the result so Sentry attributes a
  `preprocess` time to the backend that produced it — AC3 needs to compare
  those on-device, per `feedback_wallclock_gates_need_device_evidence`.
- Harnesses: `pap1694.preprocess-split.mjs`, `pap1694.dump-js-stages.mjs`,
  `pap1694_opencv_parity.py`, `pap1694.predict-dump.mjs`.

**Nothing is enabled by default.** The native backend is not installed anywhere
in the app; this commit cannot change algorithm output. That keeps AC5 satisfied
for the shipped default while AC1's build question gets answered.

## 7. Proof the seam is a no-op

The seam touches the hot path of both entry points, so "it should be identical"
is not good enough. `pap1694.predict-dump.mjs` was run over a stride-8 slice of
the cached corpus (54 images) on this commit and on `65d97a4` with only
`gearCounter.js` stashed back, dumping `toothCount`, `confidence` to 6 dp,
abstain reason, gear centre and gear radius per image:

```
$ diff /tmp/pred_before.tsv /tmp/pred_after.tsv
$ echo $?
0
```

**Byte-for-byte identical on all 54.** Plus `__tests__/preprocess.test.js`
(6 tests), which asserts the JS backend's four planes equal the four inlined
calls element-for-element, that a throwing backend degrades to JS and stays
there, and — the one that matters for every non-device environment — that
importing `nativePreprocess` when the native module is unlinked reports
unavailable instead of throwing. The existing `gearCounter` / `gearDetector`
suites (37 tests) still pass.

## 8. Not done in this ticket

- **No gradle build was run.** AC1's "building in both debug and release" is
  verified statically only (section 1). The build gate says implementation
  changes get QA review before an APK build, and the ABI/`libc++_shared`
  decisions in section 1 should be settled in that review rather than
  discovered by a 330 MB APK.
- **No device timing.** AC3 needs a real `stageMs.preprocess` off a device with
  `stageMs.preprocessBackend` set to a native backend, per
  `feedback_wallclock_gates_need_device_evidence`. The plumbing for that is in;
  the number is not, and the section 4 table is an apportionment estimate, not a
  measurement.
- **AC4** is filed as PAP-1696 to the Algorithm Engineer, per AC4's own
  instruction not to block this ticket on it.
