# MasterClaw Tools 🛠️

CLI utilities, automation scripts, health checks, and maintenance tools for the MasterClaw ecosystem.

## Installation

```bash
# Clone
git clone https://github.com/TheMasterClaw/masterclaw-tools.git
cd masterclaw-tools

# Install globally
npm install -g .

# Or run with npx
npx .
```

## Commands

### `mc status`
Check health of all MasterClaw services
```bash
mc status
mc status --watch  # Continuous monitoring
```

### `mc deploy`
Zero-downtime deployment management
```bash
mc deploy rolling              # Blue-green deployment with zero downtime
mc deploy rolling --force      # Deploy even if tests fail
mc deploy canary 10            # Deploy to 10% of traffic first
mc deploy rollback             # Rollback to previous version
mc deploy status               # Show current deployment status
mc deploy history              # Show deployment history
```

### `mc logs [service]`
View service logs
```bash
mc logs mc-backend
mc logs mc-backend --follow --tail 50
```

### `mc backup`
Trigger manual backup
```bash
mc backup
```

### `mc config`
Manage configuration
```bash
mc config get gateway.url
mc config set gateway.url https://your-gateway.com
mc config list
```

### `mc revive`
Restart all services
```bash
mc revive
mc revive --pull  # Pull latest images first
```

### `mc update`
Check for updates
```bash
mc update
mc update --apply
```

## Deployment Strategy

The `mc deploy` command implements **blue-green deployment** for zero-downtime updates:

1. **Blue-Green**: Two identical production environments (blue and green)
2. **Zero Downtime**: Traffic switches instantly after health checks pass
3. **Automatic Rollback**: One-command rollback to previous version
4. **Canary Support**: Route percentage of traffic to new version first
5. **Health Checks**: Services must pass 3 consecutive health checks before switch

### How It Works

```
Current State:     Blue (active) ← Traffic
                   Green (idle)

Deploy:            Blue (active) ← Traffic
                   Green (deploying + health checks)

Switch Traffic:    Blue (idle)
                   Green (active) ← Traffic

Cleanup:           Blue (stopped)
                   Green (active) ← Traffic
```

## Configuration

Config is stored in `~/.masterclaw/config.json`:

```json
{
  "infraDir": "/path/to/infrastructure",
  "gateway": {
    "url": "http://localhost:3000",
    "token": null
  },
  "api": {
    "url": "http://localhost:3001"
  }
}
```

## Library

The CLI uses these modules:
- `lib/services.js` - Service health checking
- `lib/config.js` - Configuration management
- `lib/docker.js` - Docker Compose helpers

## Related

- [masterclaw-infrastructure](https://github.com/TheMasterClaw/masterclaw-infrastructure) — Deployment
- [masterclaw-core](https://github.com/TheMasterClaw/masterclaw-core) — AI brain
- [MasterClawInterface](https://github.com/TheMasterClaw/MasterClawInterface) — The UI

---

*Tools for the master.* 🐾
