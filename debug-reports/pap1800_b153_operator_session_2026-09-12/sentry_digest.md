# Sentry digest — operator's ad-hoc b153 attempt (2026-09-11 17:34-17:39Z)

Source: Sentry project events, release `v1.0.0 (153) · 2026-09-11 14:39`, device FP5 (high) Android 15.
10 `training_sample` events (level=info). ZERO error/crash/ANR events. No freeze (max total 40.1s, within budget).

| ts (Z) | gate fired | pre-gate tc | conf | total | CRES (detected=false/total) |
|---|---|---|---|---|---|
| 17:34:53 | fft90-fallback | (op=20) | - | 28827ms | n/a (no CRES crumbs retained) |
| 17:35:34 | G1-tc40 | 42 | 0.728 | 26223ms | n/a |
| 17:36:59 | G1-tc40 | 40 | 0.452 | 35462ms (hi-res retry ran, methods=11.5s) | n/a |
| 17:37:13/14 (dup deliveries) | G1-tc40 | 40 | 0.452 | 35462ms | n/a |
| 17:38:03/15/16 (dup deliveries) | G1-tc40 | 40 | 0.452 | 40089ms (retry ran) | n/a |
| 17:38:59 | G4-fft-collapse-op-commit | 20 | 0.728 | 24925ms | 7/7 (score 0.000) |
| 17:39:00 (dup) | G4-fft-collapse-op-commit | 20 | 0.728 | 24925ms | 7/7 |

camera.capture breadcrumb (last capture): `flash:"on", hasTorch:true, torchProp:"off"` — b153-era STALE
telemetry (PAP-1883 probe class; b153 has no flash control button and no torchEngaged dep fix; both in b155).

Reading: ~5-6 distinct captures. Dense shots (42T, 40T candidates) honestly abstained by G1 = by design.
tc=20@0.728 abstained by G4: if a true ~20T gear -> on-device false-abstain (needs the photos to confirm);
if dense -> correct abstain. CRES 0.000 across all retained frames = auto-capture never saw a usable
(stable/lit) gear -> dark-capture hypothesis (AE) supported. App never crashed or froze.
