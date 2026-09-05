# PAP-1803 Operator Runbook: Fix fork.37 Relay Outage

## Problem Summary
Company 2a07d193 has a broken Telegram relay because fork.37 requires secret-ref binding for plugin configurations. The messenger plugin cannot start without a valid secret reference.

**Impact:** Relay verification blocked (PAP-1760/1761); operator pages cannot be delivered.

## Root Cause (from PAP-1784)
- Fork.37 introduced strict validation: `assertSecretRefBinding(rejectLegacyUuid=true)`
- Old plugin configs stored bare UUID strings in `telegramBotTokenSecretId`
- Fork.37 rejects legacy format → worker fails to start → relay broken

## Fix: 4 Steps

### Step 1: Locate the Telegram Bot Token
**Action:** Get the actual bot token from Telegram BotFather
- If you have it: use the existing value
- If lost: contact @BotFather on Telegram and regenerate it for the `paperclipai-gear-camera-app` bot
- **Do NOT share the token in any Paperclip comment; store in vault only**

### Step 2: Create Secret in Company Vault
**Endpoint:** POST `/api/companies/2a07d193-9a49-4cbd-ab0b-486be0ae801b/secrets`
**Required:** Board-level API key (operator key with `company.secrets.write` scope)

**Request body:**
```json
{
  "name": "Telegram Messenger Bot Token",
  "value": "<paste-actual-bot-token-here>",
  "type": "secret"
}
```

**Expected response:** HTTP 201 with secret object including `id` (e.g., `aec3df6f-ef95-4572-b786-290e3baa1a8e`)

### Step 3: Update Messenger Plugin Config (DATABASE)
**Context:** Plugin config lives in the `plugin_config` table; must be edited as DB record or via admin UI.
**Action:** Update the `config_json` column for plugin `543e9aaf` in company `2a07d193`.

**Current broken config (approximately):**
```json
{
  "topicMap": {
    "2a07d193-9a49-4cbd-ab0b-486be0ae801b": 174
  },
  "telegramBotTokenSecretId": "aec3df6f-ef95-4572-b786-290e3baa1a8e"
}
```

**Fixed config (use the actual secret ID from Step 2):**
```json
{
  "topicMap": {
    "2a07d193-9a49-4cbd-ab0b-486be0ae801b": 174
  },
  "telegramBotTokenSecretId": {
    "type": "secret_ref",
    "secretId": "aec3df6f-ef95-4572-b786-290e3baa1a8e"
  }
}
```

**Key difference:** `telegramBotTokenSecretId` changes from a bare UUID string to a structured secret-ref object.

### Step 4: Verify and Restart Worker
**Action:** Restart messenger worker (board plugin disable/enable, or host restart if permitted)

**Verification:** Check server.log for:
- ✓ Worker start WITHOUT "topicMap warning" line
- ✓ Line containing: `deliver delivered` (from first relay test)

**If no "deliver delivered":** Worker still failing. Check server.log for `extractSecretRefBindingsFromConfig` errors.

## QA Verification (AFTER fix)
Once you've completed Steps 1-4, QA will:
1. Post a marked comment to PAP-1760 (with `[[operator-deliver]]` marker)
2. Wait 60 seconds
3. Grep server.log for `deliver delivered` line
4. Confirm relay working → close PAP-1760 and PAP-1761

## Access Level Required
- **Step 2 & 3:** Board Admin (elevated company secrets + plugin config access)
- Board-scoped API key with `company.secrets.write` and `plugin_config.write` scopes

## Timeline
- Fix time: ~5 minutes (if you have the bot token)
- Verification: ~2 minutes (QA automated)
- Total unblock: < 10 minutes

## Questions?
- PAP-1784: Platform investigation findings (root cause)
- PAP-1760: Original relay issue
- PAP-1761: Detailed root cause + this runbook
