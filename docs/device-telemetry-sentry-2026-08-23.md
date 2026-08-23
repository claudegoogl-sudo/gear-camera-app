# Device telemetry is live — Sentry pull, 2026-08-23

**Status: this document overturns the premise of PAP-1671 and PAP-1654.**

We have believed since May that we have **zero device telemetry**. That belief was
based on `debug-reports/` on disk, whose newest folder is `report_2026-05-04`. It is
wrong. Debug reports have been arriving in Sentry continuously — **the most recent one
is 2026-08-19, four days before this document, from a real Fairphone FP5.** Nobody had
queried the Sentry side since the PAP-1543 migration made it the only delivery path.

QA's PAP-1678 write-up framed this as (i) broken pipeline vs (ii) nobody shooting
photos, and leaned (ii). Neither is right. The answer is **(iii): the pipeline works,
photos are being shot regularly, and we never opened the mailbox.**

## How to query it (do this before ever claiming we are blind again)

The token is **not** an environment variable — it is in the repo's `.env`, which is why
a previous `env | grep SENTRY` came back empty:

```bash
cd gear-camera-app && set -a && . ./.env && set +a
H="Authorization: Bearer $SENTRY_TRIAGE_TOKEN"
B="https://sentry.io/api/0/projects/$SENTRY_ORG/$SENTRY_PROJECT"

# all-time issue groups (statsPeriod MUST be '', '24h' or '14d' — 90d is rejected)
curl -s -H "$H" "$B/issues/?query=&statsPeriod=&sort=date&limit=50"

# events with full bodies (contexts.gear.algoDiag.stageMs lives here)
curl -s -H "$H" \
  "https://sentry.io/api/0/organizations/$SENTRY_ORG/issues/<groupId>/events/?limit=100&full=true"
```

Group ids as of this pull: `120360803` (`debug_report` + `training_sample`, 97 events
all-time) and `120360761` (`chainring_abstain`, 63 events all-time). Event **bodies**
are retained ~30 days, so the 33 rows below are what still has payloads; the 160
all-time count is the true volume.

## What the device actually says

| when (UTC) | kind | build | pred | actual | chainring | total ms | detect ms | method |
|---|---|---|---|---|---|---|---|---|
| 2026-07-24 10:01 | chainring_abstain | 129 |  |  |  |  |  |  |
| 2026-07-24 10:03 | chainring_abstain | 129 |  |  |  |  |  |  |
| 2026-07-24 10:03 | chainring_abstain | 129 |  |  |  |  |  |  |
| 2026-07-29 08:47 | chainring_abstain | 129 |  |  |  |  |  |  |
| 2026-07-29 08:50 | training_sample | 129 | 30 | 30 |  |  |  |  |
| 2026-07-30 13:04 | chainring_abstain | 129 |  |  |  |  |  |  |
| 2026-07-30 13:04 | debug_report | 129 | 30 | 30 | True | 69989 |  | fft-agreement |
| 2026-08-06 11:19 | chainring_abstain | 129 |  |  |  |  |  |  |
| 2026-08-06 11:21 | training_sample | 129 | 30 | 30 |  |  |  |  |
| 2026-08-07 09:34 | chainring_abstain | 129 |  |  |  |  |  |  |
| 2026-08-07 09:35 | debug_report | 129 | 51 | 51 | True | 93502 |  | retry-bc-consensus+chainring-pk |
| 2026-08-07 12:43 | chainring_abstain | 132 |  |  |  |  |  |  |
| 2026-08-07 12:47 | chainring_abstain | 132 |  |  |  |  |  |  |
| 2026-08-07 12:47 | chainring_abstain | 132 |  |  |  |  |  |  |
| 2026-08-07 12:53 | debug_report | 132 | 13 | 36 | True | 37242 | 30058 | fft90-fallback+pap963-campa-bolt-abstain |
| 2026-08-07 12:53 | training_sample | 132 | 13 | 36 |  |  |  |  |
| 2026-08-07 12:55 | debug_report | 132 | 11 | 11 | False | 35261 | 28655 | peak |
| 2026-08-07 12:55 | training_sample | 132 | 11 | 11 |  |  |  |  |
| 2026-08-07 12:56 | debug_report | 132 | 13 | 13 | False | 36810 | 30249 | bc-consensus+peak |
| 2026-08-07 12:56 | training_sample | 132 | 13 | 13 |  |  |  |  |
| 2026-08-07 12:58 | chainring_abstain | 132 |  |  |  |  |  |  |
| 2026-08-07 12:58 | chainring_abstain | 132 |  |  |  |  |  |  |
| 2026-08-07 12:58 | debug_report | 132 | 11 | 36 | True | 35461 | 28506 | fft90-fallback |
| 2026-08-07 12:58 | training_sample | 132 | 11 | 36 |  |  |  |  |
| 2026-08-19 13:55 | chainring_abstain | 132 |  |  |  |  |  |  |
| 2026-08-19 13:56 | chainring_abstain | 132 |  |  |  |  |  |  |
| 2026-08-19 13:56 | chainring_abstain | 132 |  |  |  |  |  |  |
| 2026-08-19 13:56 | debug_report | 132 | 34 | 34 | True | 38934 | 32337 | bc-consensus+peak |
| 2026-08-19 13:56 | training_sample | 132 | 34 | 34 |  |  |  |  |
| 2026-08-19 14:53 | chainring_abstain | 132 |  |  |  |  |  |  |
| 2026-08-19 14:53 | chainring_abstain | 132 |  |  |  |  |  |  |
| 2026-08-19 14:58 | training_sample | 132 | 34 | 34 |  |  |  |  |
| 2026-08-21 13:29 | chainring_abstain | 132 |  |  |  |  |  |  |

Device: Fairphone FP5, `QTI SM7325`, 8 cores, 7.6 GB RAM, `arm64-v8a`, Europe/Berlin,
`simulator: false`. A real person's phone, used across at least July 24 → August 21.

## Three conclusions, in order of how much they change

### 1. On-device runtime is ~36 seconds for an *ordinary* gear, not 5757 ms and not 977 ms

This is the number PAP-1643 and PAP-1672 were blocked on, and it was sitting in Sentry
the whole time. Seven reports carry `algoDiag.stageMs`:

- **non-chainring**: 35261 ms, 36810 ms
- **chainring**: 35461, 37242, 38934 ms on b132; **69989 and 93502 ms on b129**
- **`detect` alone is 28.5–32.3 s** — roughly 80% of total runtime, every time

The desktop corpus audit says 5757 ms median and the profiler says 977 ms p50. The
device says ~36000 ms. So the "6x unexplained gap" was the *small* discrepancy: the
device is **~6x the corpus number and ~37x the profiler number**. Both desktop numbers
are unrepresentative, and the profiler one is nearly meaningless as a proxy.

The 70–93 s chainring freeze in PAP-1670/PAP-1659 is **confirmed on real hardware** —
69989 ms and 93502 ms on b129 match the reported range exactly. But it is not a
chainring-specific defect. Chainrings are the tail of a distribution whose *median* is
already 7x over the 5 s product target. **Fixing the chainring freeze does not get us
near target 3.**

### 2. Telemetry liveness (PAP-1654) is answered — no device session needed

`debug_report`-tagged events exist on b129 and b132 with photos and full contexts
attached. The upload path works. What is *not* yet evidenced is b134+ specifically: the
newest build any device has run is **b132**. b133's telemetry-dead window and b134's
`assert_sentry_dsn_bundled` guard (`51a4e99`) remain code-level-only claims. So the
operator session still has value — but its telemetry step drops from "is the pipeline
alive at all" to "does b137 specifically still send", which is a much weaker question.

### 3. Accuracy on real device photos: 7/9 exact, both misses are chainrings

Labeled samples in the window: 30/30, 30/30, 51/51, 11/11, 13/13, 34/34, 34/34 correct;
**13 vs 36** and **11 vs 36** wrong — both `chainringRegime: true`, both collapsing a
36T chainring to a ~1/3 count via `fft90-fallback`. Small n, and self-selected (the
operator chooses when to file a report), so this is **not** a corpus replacement and
must not be quoted against the 58.0% baseline. It is a pointer: the chainring
sub-harmonic collapse is real on device, not just in the corpus.

Also visible and worth noting against older assumptions: `aimCrop` **is** persisted in
the report now (`measured: true`, `side`, `originX/Y`, `fullW/H`), and
`aimCircleFrac: 1`.

## What this changes on the board

- **PAP-1654** — effectively answered by this pull for b129/b132; only the b134+
  question survives.
- **PAP-1643 / PAP-1672** — the missing end-to-end number now exists: ~36 s p50 on FP5.
  Both should be re-scoped around that rather than around a device session.
- **PAP-1670** — the freeze is confirmed real on b129; b137's deadline remains
  unvalidated because no device has run b137.
- **PAP-1671** — the "capability gap" is narrower than stated. We cannot *drive* a
  device, but we have never been blind to what one reports. Recurring telemetry review
  is nearly free and should be a standing routine, not a parked ticket.
- **PAP-758 target 3 (≤5 s)** — we are ~7x over on ordinary gears on real hardware.
  This is a bigger and more general problem than the chainring freeze it was filed
  behind.
