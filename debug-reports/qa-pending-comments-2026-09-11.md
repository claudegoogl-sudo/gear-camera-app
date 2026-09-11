# Staged board writes — post from the next ISSUE-BOUND QA run
## (created 2026-09-11T21:00Z, unbound timer run — writes 403, PAP-1784/fork.44 gate re-probed)

## PAP-1881 comment (post TOGETHER with the delta re-check verdict, when Mobile lands the fix)

[QA delta re-check context] One numbering note for the build trigger: **the flash/aim build must be b155** — the b154 tag was taken 2026-09-11 by PAP-1886's validation APK (exactly `3571f78`, APK sha verified in comment 80026037 on PAP-1879). Filing a second "b154" build would collide with the existing release. Suggested trigger description: b155 = HEAD carrying `114a496` (PAP-1881 flash control + torchEngaged dep fix) + `a290319` (PAP-1882 aim format) + `f3ea612` (initialized stream-size telemetry); device checks per the PAP-1883 verdict comment (ME's 3 + QA's 3 additions).

## Triage data caveat (re-post on the next PAP-1596-class torch investigation or PAP-1883 follow-up)

Pre-PAP-1881 `capture.torchProp` telemetry is stale-closure-poisoned in the default no-toggle flow (probe-proven 2026-09-11: recorded "off" while the live prop was "on"; self-heals after any toggle). The b151-era "torchProp resolved 'off' at capture" rows must be re-read with this artifact in mind before they are cited as HAL evidence. Fixed by the torchEngaged dep + assertion now landing on PAP-1881.
