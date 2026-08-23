# PAP-1701 — budgetExhausted telemetry read, 2026-08-23

## Query

```bash
set -a && . ./.env && set +a
H="Authorization: Bearer $SENTRY_TRIAGE_TOKEN"
curl -s -H "$H" "https://sentry.io/api/0/projects/$SENTRY_ORG/$SENTRY_PROJECT/issues/?query=&statsPeriod=&sort=date&limit=50"
curl -s -H "$H" "https://sentry.io/api/0/organizations/$SENTRY_ORG/issues/120360803/events/?limit=100&full=true"
```

Groups: `120360803` (`debug_report`+`training_sample`, 97 all-time, lastSeen
2026-08-19T14:58Z) and `120360761` (`chainring_abstain`, 63 all-time, lastSeen
2026-08-21T13:29Z). Re-checked live at time of writing — no events newer than the
2026-08-23 08:xx pull in `docs/device-telemetry-sentry-2026-08-23.md`.

## The blocking fact

`budgetExhausted` was added to the algoDiag payload in `8f87c1d` (PAP-1659), which
first shipped in **b137** (release `5696300`, 2026-08-23T01:22Z). The 45000ms budget
that replaced b137's device-fatal 5000ms currently ships in **b138**
(`957c926`, 2026-08-23T09:00Z, tagged "NEEDS DEVICE SESSION").

Every `debug_report` event with a body currently in Sentry is on **b129 or b132**
(release tags `v1.0.0 (129) · 2026-05-21` / `v1.0.0 (132) · 2026-08-07`) — both built
**before** `8f87c1d` existed. `budgetExhausted` is `None` on all 7 events, not because
the field wasn't sent, but because these binaries don't contain the code that sets it.
No device has run b137 or b138 yet.

**AC1-AC4 cannot be answered from telemetry today: n=0 events postdate the gate.**
This is not a missing-field gap (the field is correctly wired per code read of
`mobile/src/screens/CameraScreen.jsx:541` and `gearCounter.js:3601,3898`) — it's a
missing-build gap. No extrapolation is offered for AC1/AC3/AC4 per AC5's instruction.

## What the pre-gate data does support (AC2, informative only)

7 `debug_report` events with photos, all FP5/production, span b129 (2) and b132 (5).
5 of the 7 (b132) carry the PAP-1636 `stageMs` breakdown:

| build | chainringRegime | methodUsed | detect ms | methods ms | detect+methods | total ms |
|---|---|---|---|---|---|---|
| 132 | true | bc-consensus+peak | 32337 | 51 | 32388 | 38934 |
| 132 | true | fft90-fallback | 28506 | 36 | 28542 | 35461 |
| 132 | false | bc-consensus+peak | 30249 | 67 | 30316 | 36810 |
| 132 | false | peak | 28655 | 35 | 28690 | 35261 |
| 132 | true | fft90-fallback+campa-bolt-abstain | 30058 | 29 | 30087 | 37242 |
| 129 | true | retry-bc-consensus+chainring-pk | — | — | — | **93502** |
| 129 | true | fft-agreement | — | — | — | **69989** |

`detect+methods` (n=5, b132 only): p50 = 30087ms, max = 32388ms.
`total` (n=7, both builds): the b132 cluster sits at 35261–38934ms; the two b129
chainring events are 69989ms and 93502ms — a completely different regime, consistent
with the corpus's chainring-tail finding (`project_PAP1666_findgearcenter_lever`,
`project_PAP1670`-adjacent freeze reports).

Naively applying a 45000ms `stageMs.detect+methods`-scoped budget to these pre-gate
runs (caveat: budget is scoped to detect+methods per the PAP-1689 ruling, not to
`total`, and none of the 7 events carry a detect+methods breakdown large enough to
approach 45000ms — max observed is 32388ms):

- 5/5 b132 events, chainring or not, would **not** trip a 45000ms detect+methods gate.
- The 2 b129 events have no stageMs breakdown to check against the detect+methods
  scope directly; their `total` (69989/93502ms) is on the order of 2x the budget, which
  is suggestive but not a substitute for the actual scoped measurement.

This is 5-7 self-selected samples from one phone, not a distribution — it does not
replace AC1-AC3, and PAP-1682/1677's 33-38x host-to-device scaling remains an assumption,
neither confirmed nor refuted by builds that predate the field being sent.

## Answers to the ACs

- **AC1 (budgetExhausted rate)** — **cannot be answered.** n=0 events on b137/b138.
  Field exists and is wired correctly; simply never exercised by any reporting device.
- **AC2 (stageMs.detect+methods distribution)** — **partial, low-n, wrong builds.**
  5 pre-gate b132 samples: p50=30087ms, max=32388ms. Real device/host ratio implied:
  ~30087/1197 (host median from PAP-1675) ≈ **25x**, below the 33-38x PAP-1682 estimate
  — but this is 5 samples from ordinary (mostly non-abstaining) photos, not the same
  distribution as the 33-38x figure (which came from all 160 FP5 events incl. chainring
  outliers). Not a replacement measurement; directionally consistent, not confirmatory.
- **AC3 (verdict on 45000ms)** — **no verdict possible; state the gap.** The two
  chainring `total` samples (69989, 93502ms) are far enough over 45000 that if
  detect+methods scales similarly, chainring photos would very plausibly trip the gate;
  the five non-chainring/ordinary samples (35-39s total) leave comfortable headroom. But
  none of these 7 events ran the gated code, so this is informed speculation, not a
  measurement. **Genuine answer: unmeasured. File the follow-up (below).**
- **AC4 (correct-answers-lost if firing)** — **cannot be quantified; nothing observed
  firing.** No follow-up filed here per the ticket's own instruction ("if the gate IS
  firing") — it is not observed firing at all, so this AC does not trigger.
- **AC5 (missing field → name it, file instrumentation ticket)** — **the field is not
  missing; the qualifying device sample is.** No instrumentation ticket needed. What's
  needed instead is a device session on b138 (already flagged
  "NEEDS DEVICE SESSION" in the release notes) followed by a repeat of this Sentry pull.

## Verdict

**Telemetry read complete; answer is "insufficient device sample," not a number.**
Zero of 97 all-time `debug_report`/`training_sample` events and zero of 63
`chainring_abstain` events postdate b137. The wall-clock gate (5000ms in b137,
45000ms in b138) has never been exercised on a reporting device. Re-run this exact
query after any device session on b138+ — the query and event-group ids above are
reusable as-is.
