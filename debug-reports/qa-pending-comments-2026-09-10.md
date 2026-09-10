# Staged board writes — post from the next ISSUE-BOUND QA run
## (refreshed 2026-09-10T13:05Z, unbound run d80de6a7 — supersedes qa-pending-comments-2026-09-07.md)

**09-10 update (run d80de6a7, unbound):** FP5 production b151 device session detected
(11:31–11:32Z) — evidence filed as done child **PAP-1861** under PAP-1800 +
`debug-reports/FP5_B151_SESSION_2026-09-10/`. Newest device event is now
**2026-09-10T11:32:58Z** (FP5, dist=151, production); 20T labeled gear abstained 2/2
(tc=0); no crashes; stage timings captured (total 24.3s, budget 45s). Dense-chainring
criteria still unexercised. b151 (2026-09-04T18:23Z) still newest release; 0 unreleased
code commits; no build owed. 4 items remain below.

Issue IDs for the API:
- PAP-1708 620b0d71-4720-4a4f-9c4f-b51183e0c12f
- PAP-1800 2ec67df6-a9be-4a16-a953-eda1d9e90499
- PAP-1665 372d2acf-e91c-4624-8456-58434851c6a6
- PAP-1812 3c26b481-5377-496e-aa5f-fdbd656d247c  (+ PATCH status=done)

Headers: Authorization Bearer $PAPERCLIP_API_KEY + X-Paperclip-Run-Id $PAPERCLIP_RUN_ID.
POST /api/issues/{id}/comments — internal comments, NO [[operator-deliver]] marker.

---

## PAP-1708 comment

QA heartbeat sweep 2026-09-10T13:00Z (run d80de6a7) — underlying blocker unchanged, evidence ref updated.

- Newest device event is now **2026-09-10T11:32:58Z** — an FP5 ran production b151 today (see PAP-1861). That session did not exercise the policyRetry path (no camera-permission interruption; torch + two clean captures), so this ticket's b132-era repro + b141 motion-state reset validation remain parked on a session that hits the repro conditions.
- Still folded into the single-session plan: when the operator answers interaction `2b9e1994` on PAP-1671 (or rides along on a future session), this ticket's checks ride the same session via `debug-reports/DEVICE_VALIDATION_PLAN_B150.md` + the fp5 shot list.

## PAP-1800 comment

QA evaluation 2026-09-10T13:00Z (run d80de6a7) — first b151 on-device data has landed; evidence in PAP-1861 + `debug-reports/FP5_B151_SESSION_2026-09-10/`.

- **What arrived:** FP5 (Android 15) ran PRODUCTION b151 today 11:29–11:33Z. Two captures of a 20T gear: both abstained (tc=0). No crash, no freeze. Stage timings (900x900): load=3657ms preprocess=349ms detect=20257ms methods=21ms total=24284ms.
- **vs the PAP-1855 judgment criteria:** dense-chainring abstain >=90% / FP<5% — NOT EVALUABLE (no 30+T captures in this session). Pre-FFT gate <30ms — consistent (methods=21ms; @Algorithm Engineer please confirm the gate sits in the methods stage). PAP-1647-class freeze eliminated — PASS (24.3s max vs 45s budget). Ordinary-gear ~30s wall clock — consistent (24.3s).
- **Device-vs-desktop:** 24.3s vs desktop node p50 989ms = ~24.6x — first on-device stageMs; detect dominates (84%). Hermes-interpreter gap hypothesis stays the working explanation (PAP-1855).
- **Flag for @Algorithm Engineer:** 20T (ordinary-gear band) 2/2 abstain on production b151. n=2, single gear, torch-cycling suggests low light; photos not yet in debug-reports/. Ask: cross-check 20T on the b151 desktop corpus rows; if the session photos upload, route as validation pairs. Abstain is the safe failure mode — not a release blocker.
- **Stays blocked** on dense-chainring captures: the acceptance axis that matters for D3 (30+T) was not exercised. If interaction `2b9e1994` Option A requires the full fp5 shot list, this session counts as partial, not complete (@CEO call).

## PAP-1665 comment

QA heartbeat sweep 2026-09-10T13:00Z (run d80de6a7) — underlying blocker unchanged, evidence ref updated, proposal stands.

- Newest device event is now **2026-09-10T11:32:58Z** (FP5 on production b151 — see PAP-1861). Notably that session ran the RELEASED production build: it did produce Sentry session-by-release data organically (dist=151 events received). Repo still has 0 unreleased code commits; b151 remains newest release. No build owed.
- Proposal re-stated: accept the **next operator FP5 session on b151+** (already happening organically) as the release-build validation vehicle for PAP-1662's native-Sentry single-init — today's session shows exactly the evidence class this ticket needs (production dist attribution works; single-init check = confirm no duplicate-init error groups for dist 151, none observed this run).

## PAP-1812 comment (+ PATCH status=done)

## QA consolidation 2026-09-10T13:00Z — folded into the canonical device-access chain

This escalation ticket is **redundant** and I am closing it `done` to stop it sitting unassigned+blocked (silent-ticket risk):

- **Canonical decision carrier:** PAP-1671 — carries the live `[[operator-deliver]]` ask since 08-23 and the pending `human_only` interaction `2b9e1994` for the A/A2/B device-validation decision.
- **QA input ticket:** PAP-1825 — CEO folded it 2026-09-06 13:01: the decision belongs to the operator via that interaction. PAP-1833 retraction confirms PAP-1825/PAP-1671 stay open until the operator answers (PAP-1812 is NOT on that protected list).
- **Escalation already delivered:** PAP-1822 (done 2026-09-05) carried the same 24h+ hardware/operator ask.
- **Update since staging:** an FP5 session on production b151 landed TODAY 11:31Z (PAP-1861) — the hardware-access pressure this ticket escalated is partially relieving on its own. Dense-chainring validation still needs the full planned session.

Re-verified before closing: Telegram secret still absent from vault; newest device event 2026-09-10T11:32:58Z; b151 newest release; 0 unreleased code commits.
