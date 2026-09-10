# FP5 device session on production b151 — 2026-09-10 (first on-device data since 08-28)

**Detected by QA sweep** (unbound run d80de6a7, 2026-09-10T12:54Z): Sentry issue
GEAR-CAMERA-APP-3 (120360803, the `debug_report` bucket) received 3 new events at
11:31–11:32Z today. Newest device event was previously 2026-08-28T14:25:14Z.

## Session facts (from Sentry event tags/breadcrumbs — events/ has full dumps)

| Field | Value |
|---|---|
| Device | **FP5** (Fairphone 5), Android 15, build FP5.VT31.C.114.20260804, not rooted |
| Build | **b151 PRODUCTION** — release `v1.0.0 (151) · 2026-09-04 18:20`, dist=151, environment=production |
| User | id `b0fd948acd754ef6830617682e6a46e4`, geo Bispingen, DE (operator region) |
| Timeline | app start 11:29:48Z → capture 1 **11:30:10.2Z** → torch cycle 11:31:33 → capture 2 **11:31:42.6Z** → last report 11:32:58Z |
| Labels | `actualTeethCount=20` on every report |
| Results | **`toothCount=0` on every report — 2/2 captures ABSTAINED on a 20T gear** |
| Crashes | none; no new Sentry issues; no PAP-1647-class freeze |
| Backends | fft=`native-cv-dft`, preprocess=`native-cpp`, hermes=True (JS) |

## Stage timings (capture 2, console breadcrumb, 900x900px)

```
load=3657ms preprocess=349ms detect=20257ms methods=21ms total=24284ms  center=(440,...)
```

- detect dominates: 20.3s of 24.3s (84%).
- total 24.3s vs desktop node p50 989ms (PRODUCT_TARGETS row 3) ≈ **24.6x device-vs-desktop**.
  First on-device stageMs capture — confirms the PAP-1855 order-of-magnitude gap on b151
  (pre-D3 FP5 estimate was ~36.7s p50 on b142; b151 in the same band).
- Well inside the 45000ms budget (54% used). Ordinary-gear ~30s wall-clock baseline holds.

## Evaluation vs the PAP-1855 FP5/b151 session judgment criteria

| Criterion | Verdict |
|---|---|
| Dense-chainring abstain >=90%, FP <5% | **NOT EVALUABLE** — no 30+T captures in this session (only 20T) |
| Pre-FFT gate overhead <30ms | CONSISTENT — methods=21ms (AE to confirm the gate lives in the `methods` stage) |
| PAP-1647-class freeze eliminated | **PASS** — max 24.3s, budget 45s |
| Ordinary-gear ~30s wall clock = baseline, not failure | CONSISTENT — 24.3s |

## NEW FLAG for Algorithm Engineer (75b6a90d): ordinary-gear 20T abstain on production b151

2/2 captures of a 20T gear returned tc=0 on-device. Caveats: n=2, single gear, one user,
unknown photo conditions (torch cycling suggests low light), and the photos have NOT (yet)
appeared as debug-report folders in the repo. This is the first ordinary-gear on-device
data point since the D3/b151 ship. Ask: cross-check 20T on the b151 desktop corpus rows;
if the session photos upload later, route them as validation pairs. Not a release blocker
by itself (no crash/freeze; abstain is the safe failure mode).

## Board consequences (QA)

- The operator device session that PAP-1671/PAP-1677/PAP-1800/PAP-1825 were waiting on has
  (at minimum partially) HAPPENED — on the production b151 build. Whether it satisfies the
  Option A session in interaction `2b9e1994` is a CEO call: dense-chainring criteria remain
  unexercised, so if that interaction's A-path requires the 30+T shot list
  (debug-reports/DEVICE_VALIDATION_PLAN_B150.md), the session is incomplete rather than failed.
- Write-gate note: this sweep ran UNBOUND (PAP-1784 403 on comments/PATCH, re-probed this run).
  Evidence issue filed instead; staged comments refreshed in debug-reports/qa-pending-comments-2026-09-10.md.
