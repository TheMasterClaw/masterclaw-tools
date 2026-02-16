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

## Security 🔒

MasterClaw Tools implements comprehensive security hardening:

### Input Validation
- **Service names** — Validated against whitelist before use
- **Container names** — Sanitized to prevent command injection
- **Docker Compose args** — Only allowed commands permitted
- **File paths** — Path traversal attempts blocked
- **Log options** — Bounds checking prevents DoS attacks

### Prototype Pollution Protection
Config operations are protected against prototype pollution attacks:
- **Dangerous keys blocked** — `__proto__`, `constructor`, and `prototype` keys are rejected
- **Config sanitization** — All loaded config is automatically sanitized
- **Safe deep merge** — Config merging prevents prototype chain pollution
- **Set operation validation** — Nested key paths are validated before assignment

### Security Commands
```bash
mc config-audit    # Audit config file permissions
mc config-fix      # Fix config file permissions (600)
```

### Error Handling
All security violations throw `DockerSecurityError` with:
- Descriptive error codes for programmatic handling
- Detailed context (what was provided vs. expected)
- Automatic logging for audit trails

## Error Handling 🛡️

MasterClaw CLI provides comprehensive error handling with user-friendly messages:

### Features
- **User-friendly error messages** — Technical errors translated to actionable guidance
- **Automatic error classification** — Errors categorized by type (Docker, Network, Security, etc.)
- **Context-aware suggestions** — Specific remediation steps for each error type
- **Proper exit codes** — Standardized exit codes for CI/CD integration
- **Sensitive data masking** — Tokens and passwords automatically redacted in logs
- **Global error handling** — Unhandled exceptions and rejections caught gracefully
- **Audit logging** — Security events automatically logged for forensics

### Exit Codes
| Code | Meaning | Use Case |
|------|---------|----------|
| `0` | Success | Command completed successfully |
| `1` | General Error | Non-specific error occurred |
| `2` | Invalid Arguments | Bad command-line arguments |
| `3` | Docker Error | Docker daemon or command issues |
| `4` | Service Unavailable | MasterClaw services not running |
| `5` | Permission Denied | File or Docker permission issues |
| `6` | Security Violation | Security check failed |
| `7` | Config Error | Configuration file issues |
| `8` | Network Error | Connection or timeout issues |
| `9` | Validation Failed | Pre-flight validation failed |
| `99` | Internal Error | Unexpected internal error |

### Error Message Examples

**Before (technical):**
```
Error: connect ECONNREFUSED 127.0.0.1:8000
```

**After (user-friendly):**
```
🌐 Error: Network error: Unable to connect to service
   💡 Check your network connection and ensure the service is running.
   Run: mc status to check service health
```

### Usage in CI/CD
```bash
mc validate || exit 9    # Exit with validation code on failure
mc status || exit 4      # Exit with service unavailable code
```

## Commands

### `mc validate`
Pre-flight environment validation before deployment
```bash
mc validate                    # Validate environment for production
mc validate --dev              # Development mode (skip production checks)
mc validate --quiet            # Minimal output
mc validate --skip-ports       # Skip port availability checks
mc validate --fix-suggestions  # Show remediation steps for common issues
```

**Validates:**
- Docker and Docker Compose installation and running state
- Required environment variables (`DOMAIN`, `ACME_EMAIL`, `GATEWAY_TOKEN`)
- Recommended environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`)
- Domain and email format validity
- Gateway token strength (minimum 16 characters)
- Placeholder values in configuration
- Port availability (80, 443)
- System resources (memory, disk space)
- Data directory write permissions

**Exit codes:**
- `0` — Validation passed, ready for deployment
- `1` — Validation failed, fix issues before deploying

### `mc health`
Comprehensive health monitoring with multiple modes
```bash
mc health                      # Quick health check
mc health --watch              # Continuous monitoring (refresh every 5s)
mc health --notify             # Desktop notifications on status changes
mc health --compact            # Cron-friendly output (exits 1 on failure)
```

Checks performed:
- HTTP endpoint health (Interface, Backend, Core, Gateway)
- Docker container status
- SSL certificate expiration
- Infrastructure health checks

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

### `mc logs`
Comprehensive log management and viewing
```bash
mc logs [service]              # View logs (service: traefik, interface, backend, core, gateway, chroma, watchtower, all)
mc logs backend --follow       # Follow logs in real-time
mc logs backend --lines 500    # Show last 500 lines
mc logs backend --since 1h     # Show logs from last hour
mc logs status                 # Show log sizes and rotation status
mc logs clean                  # Clean up logs to free disk space
mc logs clean --all            # Clean logs AND prune Docker system
mc logs export                 # Export all logs for troubleshooting
mc logs export backend         # Export specific service logs
mc logs export --since 24h     # Export logs from last 24 hours
mc logs search "ERROR"         # Search for pattern in all logs
mc logs search "error" backend -i  # Case-insensitive search in backend
```

**Services:** `traefik`, `interface`, `backend`, `core`, `gateway`, `chroma`, `watchtower`, or `all` (default)

### `mc backup`
Trigger manual backup
```bash
mc backup
```

### `mc restore`
Disaster recovery - restore from backups with interactive selection
```bash
mc restore                     # List available backups
mc restore list                # Same as above
mc restore list -n 20          # Show last 20 backups
mc restore preview <name>      # Preview backup contents without restoring
mc restore run                 # Interactive restore (select backup, confirm)
mc restore run <backup-name>   # Restore specific backup
mc restore run -y              # Skip confirmations (use with caution!)
mc restore run --dry-run       # Preview what would be restored
```

**Safety Features:**
- Interactive backup selection with size and age display
- Preview mode shows components included in backup
- Double confirmation required for actual restore
- Shows warning if services are running
- Dry-run mode for testing

**Components Restored:**
- Backend data (SQLite, uploads)
- Gateway configuration and data
- Core AI memory and state
- ChromaDB vector embeddings
- Environment configuration (saved as `.env.restored` for review)

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

### `mc completion`
Shell auto-completion support for bash, zsh, and fish

### `mc cleanup`
Clean up old sessions and orphaned memories to reclaim disk space
```bash
mc cleanup                     # Interactive cleanup (default: 30 days)
mc cleanup --days 90           # Delete sessions older than 90 days
mc cleanup --days 30 --force   # Skip confirmation prompt
mc cleanup --dry-run           # Preview what would be deleted
mc cleanup --sessions-only     # Only clean sessions, keep memories
mc cleanup status              # Show cleanup status and recommendations
mc cleanup schedule            # Show how to schedule automatic cleanup
```

**Why cleanup?**
- Sessions and chat history accumulate over time
- Old data consumes disk space
- Performance degrades with very large datasets
- Most sessions are only relevant for a short time

**Recommended schedule:**
- Weekly: `mc cleanup --days 30` (keep last month)
- Monthly: `mc cleanup --days 90` (aggressive cleanup)

**Automatic scheduling via cron:**
```bash
# Add to crontab (crontab -e)
0 2 * * 0 /usr/local/bin/mc cleanup --days 30 --force
```

**Safety features:**
- Confirmation prompt before deletion (use `--force` to skip)
- Dry-run mode to preview changes
- Shows session age distribution before cleanup
- Displays statistics before and after cleanup

Shell auto-completion support for bash, zsh, and fish
```bash
mc completion bash              # Print bash completion script
mc completion bash --install    # Install bash completion
mc completion zsh --install     # Install zsh completion
mc completion fish --install    # Install fish completion
mc completion status            # Check completion installation status
```

**Features:**
- Auto-detects your shell if not specified
- Completes commands, subcommands, and flags
- Service name completion for `mc logs`
- Smart file completion for restore commands
- Install to standard shell directories automatically

**Manual Installation:**
```bash
# Bash
mc completion bash --print >> ~/.bashrc

# Zsh
mc completion zsh --print > ~/.zsh/completions/_mc

# Fish
mc completion fish --print > ~/.config/fish/completions/mc.fish
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
- `lib/config.js` - Configuration management with security
- `lib/docker.js` - Docker Compose helpers
- `lib/health.js` - Comprehensive health monitoring
- `lib/deploy.js` - Deployment management
- `lib/logs.js` - Log viewing, management, and export
- `lib/restore.js` - Disaster recovery and backup restoration
- `lib/cleanup.js` - Session and memory cleanup management
- `lib/validate.js` - Pre-flight environment validation
- `lib/memory.js` - Memory operations
- `lib/task.js` - Task management
- `lib/completion.js` - Shell auto-completion support
- `lib/security.js` - Centralized security utilities

### Security Module (`lib/security.js`)

Provides comprehensive security utilities for the MasterClaw ecosystem:

```javascript
const security = require('./lib/security');

// Log sanitization - prevents log injection attacks
const safe = security.sanitizeForLog(userInput, 1000);

// Sensitive data masking
const masked = security.maskSensitiveData('token=secret123');
// Result: 'token=[REDACTED]'

// Input validation
if (security.isSafeString(userInput)) {
  // Process input safely
}

// Path traversal detection
if (security.containsPathTraversal(filePath)) {
  throw new Error('Invalid path');
}

// Constant-time comparison for secrets
if (security.constantTimeCompare(providedToken, storedToken)) {
  // Authentication successful
}
```

**Features:**
- **Log Injection Prevention**: Removes control characters, newlines, and ANSI escape sequences
- **Sensitive Data Masking**: Automatically masks tokens, passwords, API keys, and auth headers
- **Input Validation**: Validates strings, IP addresses, and hostnames
- **Path Security**: Detects path traversal attacks and sanitizes filenames
- **Timing Attack Prevention**: Constant-time string comparison for secrets
- **Safe JSON Handling**: Circular reference protection and depth limiting

## Related

- [masterclaw-infrastructure](https://github.com/TheMasterClaw/masterclaw-infrastructure) — Deployment
- [masterclaw-core](https://github.com/TheMasterClaw/masterclaw-core) — AI brain
- [MasterClawInterface](https://github.com/TheMasterClaw/MasterClawInterface) — The UI

---

*Tools for the master.* 🐾
