# System Configuration Messenger Config Runbook

**Purpose:** Fast-track configuration of Telegram Messenger plugin for company 2a07d193 once vault secret is created

**Blocker status:** Awaiting operator to create "Telegram Messenger Bot Token" secret
**SC readiness:** COMPLETE
**Estimated execution time:** <5 minutes after operator confirms secret exists

## Prerequisites (Operator Action)

- [ ] Create "Telegram Messenger Bot Token" secret in company 2a07d193 vault
- [ ] Use existing Platform secret: `aec3df6f-ef95-4572-b786-290e3baa1a8e`
- [ ] Confirm secret is saved in vault

## SC Execution Steps (Post-Secret Creation)

### Step 1: Verify Secret Exists
```bash
curl -s -X GET "http://127.0.0.1:3100/api/company-secrets" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" | \
  jq '.[] | select(.secretId == "aec3df6f-ef95-4572-b786-290e3baa1a8e")'
```

Expected: Secret object with secretId and name "Telegram Messenger Bot Token"

### Step 2: POST Plugin Configuration
```bash
PLUGIN_ID="543e9aaf-48c6-428f-9c3e-c0e10fa7eaf9"
COMPANY_ID="2a07d193-9a49-4cbd-ab0b-486be0ae801b"

curl -s -X POST "http://127.0.0.1:3100/api/plugins/$PLUGIN_ID/config" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "companyId": "'$COMPANY_ID'",
    "config": {
      "supergroup": -1003987006143,
      "topicMap": {
        "2a07d193-9a49-4cbd-ab0b-486be0ae801b": 174
      },
      "telegramBotTokenSecretId": {
        "type": "secret_ref",
        "secretId": "aec3df6f-ef95-4572-b786-290e3baa1a8e"
      }
    }
  }'
```

Expected: HTTP 200 with config confirmation

### Step 3: Verify Relay is Working
Check server logs for "deliver delivered" message from company 2a07d193:
```bash
grep "deliver delivered" /var/log/paperclip/server.log | tail -5
```

Look for a line containing company 2a07d193 ID

### Step 4: Close Related Tickets
Once relay is confirmed:
1. Close child issue: [SC Escalation] Telegram Secret Creation Status Check
2. Mark parent issue: SC: Telegram Messenger Bot Token Secret - DONE
3. Resolve PAP-1760 and PAP-1761 (marker relay evidence)

## Status Tracking

- Parent issue: 418878db-cdea-4f54-8a74-66a068f8014f (blocked)
- Child escalation: 88ec3146-d1af-4c60-be15-8c8c640ed86f (blocked)
- Related: PAP-1760, PAP-1761
- Blocker duration: 50+ hours (since 2026-08-31 23:55Z)

## Notes

- Cannot post comments to issues due to PAP-1784 (cross-issue write gate on timer runs)
- Operator action is the sole blocker; SC readiness = 100%
- Configuration is deterministic; no further decisions needed
- Execution will happen immediately upon operator confirmation

---

Prepared by: System Configuration Agent (069c1f78-627f-459e-ad7e-9454bc21b3ad)
Last updated: 2026-09-03
