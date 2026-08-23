# PAP-1703 AC3 — device JS baseline + b140 telemetry watch

Pulled 2026-08-23 by Mobile Engineer while the ticket is blocked on the operator's
FP5 session. Tool: `scripts/sentry-ac3-read.py` (added in this commit).

## 1. b140 has produced ZERO events

The most recent event in the project is **2026-08-21T13:29:41Z on b132**. The
Sentry release list contains only b125, b129, b132. No b133-b140 event has ever
been ingested.

`scripts/sentry-ac3-read.py --build 140` → `NO EVENTS for build 140`.

This is the expected state — the operator has not installed b140 yet. It is
recorded here so that "no b140 events" is a measured fact with a timestamp
rather than an assumption, and so the same command re-run after the session is a
direct before/after.

## 2. The "~2.9-3.0s JS baseline" is device-measured, not extrapolated

AC3 is written against a "~2.9-3.0s JS baseline". That number checks out against
real FP5 telemetry, which matters because `feedback_wallclock_gates_need_device_evidence`
warns that host corpus numbers do not transfer.

b132, device FP5, `px=810000` on every row, n=16 events / **9 distinct photos**
(each photo emits a `chainring_abstain` and/or `debug_report` event with
identical `stageMs`):

| stage | n (events) | min | p50 | mean | max |
|---|---|---|---|---|---|
| `preprocess` | 16 | 2803 | 2941 | 2935 | 3254 |
| `detect` | 16 | 28367 | 30058 | 30746 | 34545 |
| `methods` | 16 | 29 | 61 | 52 | 68 |
| `total` | 16 | 34581 | 37026 | 37605 | 41285 |

Deduplicated to 9 distinct photos: `preprocess` p50 **2934ms**, mean 2946ms,
range 2803-3254ms. That is the constant baked into the reader as
`JS_BASELINE_P50_MS`.

**AC3's baseline is confirmed.** A native `preprocess` at the CEO-ruled 7-8x bar
lands at ~370-420ms; at the original 10x estimate, ~293ms.

## 3. Caveat for how the AC3 result should be read

`preprocess` is **7.8% of end-to-end time** on this device (2934ms of 37026ms
p50). `detect` alone is 30058ms — 81%.

So even a *perfect* native preprocess (→0ms) moves total from 37.0s to 34.1s, an
8% end-to-end win. A 7x preprocess win moves it to ~34.6s, a **6.5% end-to-end
improvement**.

This does not weaken AC3 — AC3 is explicitly scoped to the preprocess stage and
the CEO ruling names `stageMs.preprocessBackend == 'native-cpp'` plus a large
stage win as what it has to prove. But the ~36s/photo device figure from
`project_PAP1677_telemetry_live` will *not* visibly improve when AC3 passes, and
that should not be read as the native port underdelivering. The end-to-end number
is gated on **AC4 / PAP-1696** (the `detect` port through `cv::dft`), which owns
81% of the time. Recording it here so the AC3 pass is not later mistaken for a
product-level speed fix.

## 4. `preprocess_backend` tag is a clean b140 discriminator

The tag is absent on all 16 b132 events — it ships in `6972385` (PAP-1700), first
released in b140. So tag presence alone distinguishes a b140 session from any
older build; there is no risk of misattributing stale events to the new build.

## Files

- `device_js_baseline_rows.json` — the 16 b132 rows, raw
- `b132_ac3_rows.json` — reader output, exercising the verdict path against b132
