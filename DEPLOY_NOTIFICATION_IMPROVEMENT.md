# MasterClaw Improvement: Deployment Notifications

## Summary

Added **deployment notification integration** to the `mc deploy` command, enabling automatic notifications to configured channels (Discord, Slack, Telegram, WhatsApp) when deployments start, succeed, fail, or are rolled back.

## What Was Improved

### 1. Enhanced Deploy Module (`lib/deploy.js`)

Extended the deployment command module with comprehensive notification capabilities:

**New Commands:**
- `mc deploy notify` — Configure deployment notification settings
- `mc deploy notify-test` — Send a test deployment notification
- `mc deploy rolling --notify` — Deploy with notifications enabled
- `mc deploy canary 10 --notify` — Canary deployment with notifications
- `mc deploy rollback --notify` — Rollback with notifications

### 2. Notification Types

Four deployment notification types with appropriate severity levels:

| Type | Severity | Icon | When Sent |
|------|----------|------|-----------|
| `started` | info | 🚀 | When deployment begins |
| `success` | resolved | ✅ | When deployment completes successfully |
| `failed` | critical | ❌ | When deployment fails |
| `rolled_back` | warning | ↩️ | When rollback completes |

### 3. Rich Notification Payloads

Notifications include contextual information:

```javascript
{
  version: '1.2.3',
  color: 'blue',
  duration: '2m 30s',
  initiator: 'username',
  error: 'Health check failed'  // only on failure
}
```

**Example Slack/Discord message:**
```
✅ Deployment Successful
MasterClaw deployment completed successfully (v1.2.3) on blue in 2m 30s
```

### 4. Integration with Existing Notification Infrastructure

Leverages the existing alert webhook system (`mc notify`):

- Reuses configured channels (Discord, Slack, Telegram, WhatsApp)
- Sends via the alert webhook at `http://localhost:8080/alerts`
- Auto-starts webhook if not running
- Gracefully fails if notifications can't be sent (doesn't break deployment)

### 5. Backward-Compatible Design

- Notifications are **opt-in** via `--notify` flag
- Existing deployments work unchanged
- New `deployment` alert type added to config (enabled by default)

## Usage

### Enable Deployment Notifications

```bash
# Enable deployment notifications
mc deploy notify --enable

# Check status
mc deploy notify
```

### Deploy with Notifications

```bash
# Standard deployment with notifications
mc deploy rolling --notify

# Canary deployment with notifications
mc deploy canary 10 --notify

# Rollback with notifications
mc deploy rollback --notify
```

### Test Notifications

```bash
# Send a test deployment notification
mc deploy notify-test
```

## Configuration

Notifications reuse your existing notification channels:

```bash
# Configure channels (if not already done)
mc notify config discord --webhook "https://discord.com/api/webhooks/..."
mc notify config slack --webhook "https://hooks.slack.com/services/..."
mc notify config telegram --token "..." --chat-id "..."

# Enable deployment notifications
mc deploy notify --enable
```

## Files Modified

| File | Change |
|------|--------|
| `lib/deploy.js` | Complete rewrite with notification integration (+400 lines) |
| `tests/deploy.notifications.test.js` | New comprehensive test suite (22 tests) |

## Test Coverage

**22 new tests covering:**

```
Deployment Notifications
  Notification Configuration
    ✓ should enable deployment notifications
    ✓ should load existing notification config
  Deployment Notification Payloads
    ✓ should build correct payload for deployment started
    ✓ should build correct payload for deployment success
    ✓ should build correct payload for deployment failure
    ✓ should build correct payload for rollback
  Duration Formatting
    ✓ should format duration less than a minute
    ✓ should format duration in minutes
    ✓ should format duration in hours
  Webhook Integration
    ✓ should check if webhook is running
    ✓ should handle webhook not running
    ✓ should send notification to webhook
  Configuration File Handling
    ✓ should add deployment alert type to existing config
    ✓ should create default config if not exists
  Environment Variable Loading
    ✓ should load ALERT_WEBHOOK_PORT from env
    ✓ should default to port 8080 if not set
Deploy Commands
  ✓ deploy module exports Command instance
  ✓ should have rolling command
  ✓ should have canary command
  ✓ should have rollback command
  ✓ should have notify command
  ✓ should have notify-test command

Test Suites: 1 passed, 1 total
Tests:       22 passed, 22 total
```

## Security Considerations

1. **No Secrets in Logs** — Webhook URLs and tokens remain in `.env`, not exposed
2. **Graceful Degradation** — Notification failures don't affect deployment
3. **Local Only** — Webhook communication stays on localhost
4. **Opt-In** — Users must explicitly add `--notify` flag

## Benefits

1. **Real-time Awareness** — Know immediately when deployments happen
2. **Team Coordination** — Multiple admins see deployment activity
3. **Failure Detection** — Immediate alerts when deployments fail
4. **Audit Trail** — Deployment history in your chat channels
5. **No New Infrastructure** — Uses existing notification system

## Example Workflow

```bash
# 1. Set up notifications (one-time)
mc notify config discord --webhook "https://..."
mc deploy notify --enable

# 2. Deploy with notifications
mc deploy rolling --notify

# Discord receives:
# 🚀 Deployment Started
# Deploying MasterClaw v1.2.3 (blue) by admin

# [deployment runs...]

# Discord receives:
# ✅ Deployment Successful
# MasterClaw deployment completed successfully (v1.2.3) on green in 2m 30s
```

## Version

This improvement is included in masterclaw-tools v0.34.0+
