# MasterClaw Tools 🛠️

CLI utilities, automation scripts, health checks, and maintenance tools for the MasterClaw ecosystem.

## Installation

```bash
# Clone
git clone https://github.com/TheMasterClaw/masterclaw-tools.git
cd masterclaw-tools

# Install globally
npm install -g .

# Or run locally
npm install
npx mc --help
```

## Commands

### `mc status`
Check health of all MasterClaw services
```bash
mc status
# Output:
# ✅ Interface: http://localhost:3000
# ✅ Backend: http://localhost:3001
# ✅ Gateway: http://localhost:3000
```

### `mc backup`
Trigger manual backup
```bash
mc backup --full
```

### `mc logs`
View service logs
```bash
mc logs --service backend --follow
```

### `mc config`
Manage configuration
```bash
mc config get gateway.url
mc config set gateway.url https://your-gateway.com
```

### `mc revive`
Restart all services and restore connection
```bash
mc revive
```

## Scripts

- `health-check.js` — Service health monitoring
- `backup.js` — Database and data backups
- `deploy.js` — Deployment automation
- `update.js` — Update check and apply

## Related Repos

- [masterclaw-interface](https://github.com/TheMasterClaw/MasterClawInterface) — The UI
- [masterclaw-core](https://github.com/TheMasterClaw/masterclaw-core) — The AI brain
- [masterclaw-infrastructure](https://github.com/TheMasterClaw/masterclaw-infrastructure) — Deployment
- [rex-deus](https://github.com/TheMasterClaw/rex-deus) — Personal configs (private)
- [level100-studios](https://github.com/TheMasterClaw/level100-studios) — Parent org

---

*Tools for the master.* 🐾
