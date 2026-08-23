# Reconciling 36 s device / 5757 ms audit / 977 ms profiler — 2026-08-23

PAP-1682, filed off PAP-1672 and the PAP-1677 Sentry pull
(`docs/device-telemetry-sentry-2026-08-23.md`). That doc established the three
numbers disagree by ~6x and ~37x. This doc explains *why*, using the full
`algoDiag.stageMs` bodies (not just `total`/`detect`) pulled from the same
Sentry events, plus a git-archaeology + host-load audit of the two desktop
numbers.

## TL;DR

- **The 5757 ms "corpus audit" number is not a clean measurement.** It was
  produced while the host was running two concurrent Android release builds
  and two to three other full-corpus jest sweeps at the same time. Isolated
  runs of the *identical* algorithm, on the *identical* corpus, using the
  *identical* harness code path, land at **950–990 ms** whether run under
  jest or plain node. Jest-vs-node was a red herring — every isolated jest
  run clusters with plain node once you control for host contention.
- **977 ms (profiler) and ~980 ms (isolated node) agree with each other.**
  There is really only one desktop number: **~980 ms p50**, not two
  disagreeing ones.
- **The device number (~36 s) is real and is not a resolution, retry, or
  extra-work artifact.** `algoDiag.stageMs.px` on all five FP5 samples with a
  breakdown is exactly `810000` = 900×900 — the same `TARGET_MAX_DIM=900`
  the desktop harness uses. `methods` (the off-center-retry / hi-res-retry
  block) is 29–67 ms on-device, too small for either retry path to have
  fired. So the device ran the exact same single-pass pipeline on the exact
  same pixel count as the desktop corpus.
- **What's left is a uniform ~33–38x per-instruction slowdown of the pure-JS
  numeric stages**, not a device-specific bug: `detect` is 79.8% of desktop
  total (p50) and 81.5% of device total (avg) — the *shape* of the profile
  is essentially identical, only the absolute cost differs. `detect` is
  ~38.4x slower on-device; `preprocess` (gray/clahe/blur/canny) is ~32.6x
  slower. Both numeric-loop stages scale together, which is the signature of
  an interpreter-vs-JIT gap, not of one specific hot function.
- **Candidate ruled in:** Hermes (React Native's default JS engine — confirmed
  enabled in `mobile/android/app/build.gradle`) executes JS via a bytecode
  interpreter with no general tracing JIT, unlike V8 on the desktop host.
  Tight numeric loops (FFT sweeps, radial scans, per-pixel CLAHE/Canny) are
  exactly the code shape that suffers most under an interpreter — a 20–40x
  gap between Hermes and V8 on numeric kernels is consistent with published
  Hermes benchmarks and is the only candidate that explains *both* stages
  scaling together by roughly the same factor.
- **Candidates ruled out:**
  - *Image resolution mismatch* — ruled out; `px=810000` on-device, exactly
    matching desktop's 900px target.
  - *Extra retries running on-device* — ruled out; `methods` stage (29–67 ms)
    is too small to contain a second full preprocess+detect pass, and no
    sample's `method` tag carries the `retry-` prefix `retryNearCenter`
    stamps on its output.
  - *PAP-1659 wall-clock deadline slowing normal photos down* — ruled out;
    the isolated node run shows `budgetExhausted: 0/362 (0.0%)`, and none of
    the five FP5 samples are anywhere near the deadline threshold either.
  - *Chainring-specific defect* — ruled out as the dominant issue; on b132
    chainring totals (35.5–38.9 s) sit in the same range as non-chainring
    totals (35.3–36.8 s). The 70–93 s outliers are both **b129**, which
    predates the PAP-1659/1670 deadline fix; b132 already normalized them.
  - *Not yet ruled out — needs on-device profiling to fully confirm*: thermal
    throttling and JS-thread contention with the camera/bridge. Both are
    plausible secondary contributors but neither explains why `preprocess`
    and `detect` scale by nearly the same factor as each other; a Hermes
    sampling profile on-device (out of reach from this sandbox — no adb/
    emulator here) is the next evidence needed to move this from "leading
    hypothesis" to "confirmed."

## Evidence

### 1. The device breakdown, full `stageMs` bodies (not just total/detect)

Pulled from `organizations/$SENTRY_ORG/issues/120360803/events/?full=true`
(group id from `docs/device-telemetry-sentry-2026-08-23.md`), the five FP5
`debug_report` events that carry a full `stageMs` object:

| when (UTC) | build | total | load | preprocess | detect | methods | px |
|---|---|---|---|---|---|---|---|
| 2026-08-07 12:55 | 132 | 35261 | 3662 | 2909 | 28655 | 35 | 810000 |
| 2026-08-07 12:56 | 132 | 36810 | 3631 | 2863 | 30249 | 67 | 810000 |
| 2026-08-07 12:58 | 132 | 35461 | 3961 | 2958 | 28506 | 36 | 810000 |
| 2026-08-07 12:53 | 132 | 37242 | 4130 | 3025 | 30058 | 29 | 810000 |
| 2026-08-19 13:56 | 132 | 38934 | 3612 | 2934 | 32337 | 51 | 810000 |
| **avg** | | **36742** | **3799** | **2938** | **29961** | **44** | **810000** |

`detect` = 81.5% of total on average (28.5–32.3 s of 35.3–38.9 s), matching
the ticket's "~80% every time" observation exactly.

### 2. The desktop side: two numbers, one root cause

`pap1639_pap1666_after.json` (isolated jest run, `p50=977`) stage breakdown:

| stage | p50 | share of total |
|---|---|---|
| gray | 4 | 0.4% |
| clahe | 15 | 1.5% |
| blur | 16 | 1.6% |
| canny | 55 | 5.6% |
| **detect** | **780** | **79.8%** |
| total | 977 | — |

`pap1672_speed_node_768d877_2026-08-23.log` (plain node, same commit family,
full 362-photo corpus, isolated): `total p50=989, p95=1520, max=5000`.

`pap1658_head_audit_2026-08-22.log` (the 5757 ms number, via `pap760.audit.js`
→ jest, commit `49a7498`, which git-archaeology confirms is a descendant of
the PAP-1635 speed-optimization commit `8ddcd97` — i.e. running the *same*
already-optimized algorithm as the numbers above): `TOTAL med=5757 p95=7964
max=12285` over the same 362-photo corpus.

`git log 49a7498..768d877 -- mobile/src/algorithm/gearCounter.js` shows only
two commits touched the algorithm file between the audit commit and the
node/jest comparison commits: `d1cbdf3` (PAP-1647 budget skip) and `8f87c1d`
+ `fea3570` (PAP-1659 deadline). None of these can explain a 5.9x slowdown —
the node run confirms 0% budget-exhausted hits, so the deadline code never
even engages on this corpus.

What *does* differ is host load, from file mtimes in `debug-reports/` on
2026-08-22 (the audit's run window, 18:55:31Z–19:31:32Z):

```
18:55:31  pap1658 audit (pap760.audit.js) starts
18:56:18  pap1653_b135_build.log            <- concurrent Android build
18:58:04  b135_build_20260822_1856.log      <- concurrent Android build
19:01:53  pap1639_pap1647_postguard.json    <- concurrent jest corpus sweep
19:03:46  pap1639_post1639_full.json        <- concurrent jest corpus sweep
19:16:13  pap1665_b136_release_build.log    <- concurrent Android build
19:30:31  pap1666_otsu_guard_2026-08-22.log <- concurrent jest corpus sweep
19:31:32  pap1658 audit finishes
```

The audit ran the entire time alongside at least one Gradle build and one
other full-corpus jest sweep, and for part of its window alongside three
simultaneous jest sweeps plus a build. This is exactly the 8-vCPU contention
this host's operating rules warn about. `pap1674_head_audit_2026-08-23.log`
shows the same signature on a different day: a garbled, interleaved log (two
runs' stdout landed in the same file) and a per-photo rate of ~5.1 s/photo —
matching the audit's inflated rate, not the isolated ~1 s/photo rate — while
`pap1672_speed_node_49a7498_2026-08-23.log` ran concurrently in the same
window.

**Conclusion: "5757 ms vs 977 ms" was never two measurements of the same
thing disagreeing. It was the same ~980 ms algorithm measured once in
isolation and once under multi-process host contention.** Nobody should
requote the 5757 ms figure as an algorithm property; if it's needed again,
rerun `pap760.audit.js` alone, with nothing else scheduled on the host.

### 3. Ruling out resolution and extra work on-device

- `px: 810000` on every device sample = 900×900, `TARGET_MAX_DIM` in
  `mobile/src/algorithm/gearCounter.js:118`. The device photo (`fullW: 3072,
  fullH: 4096`, `side: 1764` aim-crop) is downsampled to the same target the
  desktop harness uses before `analyzeImage` ever sees it. The `detect`
  stage is doing FFT/radial-sweep work over the *same number of pixels* on
  both sides.
- `methods` (`t4 - t3` in `countTeeth()`, covering the off-center retry and
  the 1500px small-gear retry) is 29–67 ms on every device sample — far too
  small to contain a second `loadAndDecodeImage` + preprocess + `analyzeImage`
  pass (which would cost another ~2.9 s preprocess + ~30 s detect at
  device rates). No device sample's `methodUsed` carries the `retry-` prefix
  that `retryNearCenter()`'s output is stamped with (`gearCounter.js:2825`).
  Neither retry path fired for any of these five samples.

### 4. Same profile shape, different absolute cost — the interpreter signature

| | desktop (isolated, p50) | device (avg) | scale |
|---|---|---|---|
| preprocess (gray+clahe+blur+canny) | 90 ms | 2938 ms | **32.6x** |
| detect | 780 ms | 29961 ms | **38.4x** |
| detect share of total | 79.8% | 81.5% | (matches) |

Both pure-JS numeric stages — preprocessing (per-pixel CLAHE/blur/Canny) and
detection (FFT-based radial sweeps) — are slower on-device by almost the
same factor, and both dominate their respective totals by almost the same
share. If the gap were caused by something device/network/IO-specific, or by
a single pathological hot loop, you'd expect the stages to scale
*differently*. Scaling together at ~33–38x is the signature of the JS
execution model itself being slower end-to-end, not of one bad function.

React Native's default JS engine, Hermes, is confirmed enabled for this app
(`mobile/android/app/build.gradle:181`, `implementation("com.facebook.react:hermes-android")`,
gated only by the `hermesEnabled` Gradle property which is the RN/Expo
default `true`). Hermes compiles to bytecode ahead-of-time and interprets it
on-device; it does not have a general tracing JIT comparable to V8's. Tight
numeric loops over typed arrays — exactly what `clahe`, `cannyEdges`, and the
seven `analyzeImage` sub-stages are — are the code shape where an
interpreter-vs-JIT gap is largest. A 20–40x gap on this kind of workload is
consistent with published Hermes-vs-V8 numeric benchmarks, and it is the only
candidate on the table that explains two independent stages scaling by
almost the same factor.

This is a **leading hypothesis, not a confirmed root cause**. Confirming it
needs an on-device Hermes sampling profile (`Settings → enable JS sampling
profiler`, or `react-native-hermes-engine`'s trace tooling) captured during a
real count — a step this sandbox cannot take (per QA's repeated finding,
there is no adb/emulator/kvm here; see `QA_PAP1643_signoff.md`,
`QA_PAP1660_signoff.md`). Filed as a follow-up requiring operator/device
access.

## Answering the ticket's three asks

**1. Reconcile the three numbers.** Done above. There are really only two
numbers that matter: ~980 ms desktop-isolated (jest and node agree; the
5757 ms figure was a host-contention artifact of the same algorithm, not an
independent measurement) and ~36.7 s device average. The gap is a uniform
~33–38x slowdown of the JS numeric stages, most consistent with Hermes
interpreting bytecode with no JIT versus V8 JIT-compiling the same code on
the desktop host, not a resolution, retry, or chainring-specific issue.

**2. `detect` is ~80% of runtime, both on-device and on desktop.** This
confirms it's the right lever *and* that fixing it alone will not reach 5 s
— see #3.

**3. Reframing the 5 s target.**  Even if `detect` were reduced to 0 ms, the
remaining stages on-device average **6781 ms** (`load` 3799 + `preprocess`
2938 + `methods` 44) — already 1.8 s over a 5 s hard ceiling by themselves.
**A pure `detect`-stage optimization cannot reach 5 s alone, no matter how
large.** Reaching 5 s requires cuts to `load` (native JPEG decode +
downsample of the 3072×4096 original, currently ~3.8 s) and `preprocess`
(~2.9 s) as well as `detect` (~30 s) — i.e., getting the numeric-heavy work
off the interpreted-Hermes-JS path (native module, WASM with SIMD, or a
platform vision API) rather than continuing to tune JS-level heuristics or
early-exit thresholds. The PAP-1659 wall-clock deadline caps the *tail*
(confirmed: b129's 70–93 s outliers are gone by b132) but, as the ticket
suspected, does not touch the *median* — none of the five in-range b132
samples were anywhere near budget-exhausted.

**Is 5 s reachable with the current approach?** Not via algorithm-parameter
tuning alone — the arithmetic above rules that out regardless of how good a
`detect`-stage heuristic gets. It is plausibly reachable via an architecture
change that moves the numeric kernels (CLAHE/Canny/FFT sweeps) off
interpreted JS, but that is an implementation-approach decision, not a
diagnosis, and per the standing QA cross-check requirement it needs its own
subtask before anyone commits to it — filed as a follow-up rather than
decided here.

## What this changes on the board

- `PRODUCT_TARGETS.md` target 3 row updated: the "6x disagreement, no
  trustworthy number" framing is retracted. The trustworthy number is
  ~36.7 s p50 on real hardware, ~7.3x over the 5 s hard target, concentrated
  ~82% in `detect` but not fixable by `detect` alone.
- Follow-up filed for the architecture-level speed investigation (moving
  numeric kernels off Hermes-interpreted JS), parented under this ticket,
  with a QA cross-check subtask built in before any approach is committed.
