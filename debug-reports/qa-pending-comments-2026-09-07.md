# Staged board writes — post from the next ISSUE-BOUND QA run (2026-09-07T06:34Z evidence)

Issue IDs for the API:
- PAP-1760 00eb456e-18e7-4ce1-a50a-85e16e5d5c3f
- PAP-1761 307b31e4-e40c-425b-a49d-107f28727751
- PAP-1708 620b0d71-4720-4a4f-9c4f-b51183e0c12f
- PAP-1800 2ec67df6-a9be-4a16-a953-eda1d9e90499
- PAP-1665 372d2acf-e91c-4624-8456-58434851c6a6
- PAP-1812 3c26b481-5377-496e-aa5f-fdbd656d247c  (+ PATCH status=done)

Headers: Authorization Bearer $PAPERCLIP_API_KEY + X-Paperclip-Run-Id $PAPERCLIP_RUN_ID.
POST /api/issues/{id}/comments — internal comments, NO [[operator-deliver]] marker.

---

## PAP-1760 comment

QA heartbeat sweep 2026-09-07T06:34Z (run 5794c78e) — NO CHANGE. Stays `blocked`, unblock owner = operator via PAP-1764.

- Re-verified live this run (read-only instance DB, socket-direct): the 2a07d193 vault still contains only `zai_api_key` (2026-09-01 05:31Z) and `VaultwardenServicePassword` (2026-06-05). The `Telegram Messenger Bot Token` secret is still NOT created.
- The marked operator ask on PAP-1764 (posted 2026-09-01) is still the live page; no new marked message needed.
- When the secret exists: config re-save with the secret_ref shape (0.2.14 object-binding form), then verify worker start without topicMap warning + a real `deliver delivered` line.

## PAP-1761 comment

QA heartbeat sweep 2026-09-07T06:34Z (run 5794c78e) — NO CHANGE. Step 1 still PENDING.

- Read-only DB check this run: no `Telegram Messenger Bot Token` secret in the 2a07d193 vault; still exactly one live messenger plugin_config row (d49b266c owner). Reassignment condition (secret created) not met — stays `blocked` on the operator.
- Runbook in this ticket remains accurate; nothing to update.

## PAP-1708 comment

QA heartbeat sweep 2026-09-07T06:34Z (run 5794c78e) — NO CHANGE. Stays `blocked`, unblock owner = operator via PAP-1671/PAP-1677.

- Sentry API re-checked this run: newest device event is still 2026-08-28T14:25:14Z — zero device activity since. No FP5 session exists that could exercise the policyRetry path, so the b132-era repro + b141 motion-state reset validation remain parked.
- Folded into the single-session plan: when the operator answers interaction `2b9e1994` on PAP-1671 with Option A (or A2), this ticket's checks ride the same session via `debug-reports/DEVICE_VALIDATION_PLAN_B150.md` + the fp5 shot list.

## PAP-1800 comment

QA heartbeat sweep 2026-09-07T06:34Z (run 5794c78e) — NO CHANGE. Stays `blocked` on FP5 device access (canonical PAP-1671).

- Re-verified this run: newest Sentry device event 2026-08-28T14:25:14Z; no new debug-report sessions; b151 remains newest release (2026-09-04T18:23Z). Nothing to validate against yet.
- CEO folded the A/A2/B decision into the operator-owned human_only interaction `2b9e1994` (see PAP-1825, 2026-09-06 13:01). QA executes Option A (session) or B (waiver + field monitoring) the moment the answer lands.

## PAP-1665 comment

QA heartbeat sweep 2026-09-07T06:34Z (run 5794c78e) — NO CHANGE on the underlying blocker, plus a criterion refresh proposal.

- Evidence this run: b143/b146 still show zero operator opens (newest Sentry device event 2026-08-28T14:25:14Z). Repo: 8 unreleased commits, ALL docs-only — no code commit needs a release; b151 (09-04) remains newest. No build owed.
- **Proposal (QA):** retire the "operator opens b143/b146 specifically" criterion — those builds are now two generations stale. Accept the **next operator FP5 session on b151+** as the release-build validation vehicle for PAP-1662's native-Sentry single-init: one cold start on-device produces the session-by-release Sentry data that settles this ticket. Same evidence class, zero extra operator time.

## PAP-1812 comment (+ PATCH status=done)

## QA consolidation 2026-09-07T06:34Z — folded into the canonical device-access chain

This escalation ticket is **redundant** and I am closing it `done` to stop it sitting unassigned+blocked (silent-ticket risk):

- **Canonical decision carrier:** PAP-1671 — carries the live `[[operator-deliver]]` ask since 08-23 and the pending `human_only` interaction `2b9e1994` for the A/A2/B device-validation decision.
- **QA input ticket:** PAP-1825 — CEO folded it 2026-09-06 13:01: the decision belongs to the operator via that interaction. PAP-1833 retraction confirms PAP-1825/PAP-1671 stay open until the operator answers (PAP-1812 is NOT on that protected list).
- **Escalation already delivered:** PAP-1822 (done 2026-09-05) carried the same 24h+ hardware/operator ask.

Re-verified this run before closing: Telegram secret still absent; newest Sentry device event still 2026-08-28T14:25Z; b151 still newest release. All six parked device-validation tickets wake from the single operator answer on PAP-1671.
