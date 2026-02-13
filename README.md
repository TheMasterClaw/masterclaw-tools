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

### `mc logs [service]`
View service logs
```bash
mc logs mc-backend
c logs mc-backend --follow --tail 50
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
