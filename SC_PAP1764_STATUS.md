# System Configuration Status — PAP-1764 Telegram Messenger Blocker

## Summary
PAP-1764 is blocked waiting for operator action to create the Telegram bot token secret in the company vault.

## Root Cause
After fork.37, the messenger plugin uses per-company configuration. Company 2a07d193 is missing:
- "Telegram Messenger Bot Token" secret in the vault
- Messenger plugin configuration with the secret reference

See PAP-1761 for detailed root cause analysis.

## Current Status
**Assigned to:** System Configuration (069c1f78-627f-459e-ad7e-9454bc21b3ad)
**Status:** BLOCKED
**Created:** 2026-09-01T12:00:21Z
**Last Updated:** 2026-09-03T23:16:46Z
**Time Blocked:** ~3 days

## What's Needed (Operator Action Only)
1. Go to Board Settings → Secrets (for company 2a07d193-9a49-4cbd-ab0b-486be0ae801b)
2. Create new secret: "Telegram Messenger Bot Token"
3. Paste the BotFather token value (or use existing Platform secret aec3df6f-ef95-4572-b786-290e3baa1a8e)
4. Save the configuration

## System Configuration's Next Steps (After Operator Creates Secret)
Once the secret is in place, System Configuration will:
1. POST /api/plugins/{messenger-plugin-id}/config
2. Configure with proper secret-ref to the created secret
3. Verify relay logs show "deliver delivered" messages
4. Close PAP-1764 as done

## Related Issues
- **PAP-1761:** Root cause + runbook (blocked, waiting for this fix)
- **PAP-1760:** Relay symptom issue (blocked, depends on this fix)

## Unblock Descriptor
**Owner:** System Configuration (069c1f78-627f-459e-ad7e-9454bc21b3ad)
**Action:** "Operator creates 'Telegram Messenger Bot Token' secret in company 2a07d193 vault via Board UI (Settings → Secrets) OR replies through Board comment/interaction"

## How to Apply
1. Operator: Create the secret in Board UI (Settings → Secrets)
2. Notify System Configuration (via comment or status change)
3. System Configuration: Verify and configure plugin
4. Close issue as done

## Notes
- This is a pure provisioning issue, not a code/logic bug
- Once secret exists, fix is ~2 steps (POST config, verify logs)
- Blocks all Telegram notifications for this company
- API comment endpoint unavailable (using status/blocker mechanism for escalation)

**Last Updated by System Configuration:** 2026-09-04 (this heartbeat)
**Status:** Standing by for operator action
