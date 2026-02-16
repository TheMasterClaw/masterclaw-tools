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

### Rate Limiting 🚦
MasterClaw CLI includes command rate limiting to prevent abuse:

```bash
mc rate-limit              # Show current rate limit status
mc rate-limit --status     # Same as above
```

**Rate limits by command category:**
| Category | Commands | Limit | Window |
|----------|----------|-------|--------|
| 🔒 High Security | `config-audit`, `config-fix`, `audit-verify`, `security`, `restore` | 3-10 | 1-5 min |
| 🚀 Deployment | `deploy`, `revive` | 5-10 | 1-5 min |
| 💾 Data Modification | `cleanup`, `import` | 5-10 | 1 min |
| 📖 Read-Only | `status`, `health`, `logs`, `validate` | 30-60 | 1 min |

**Reset rate limits (security-sensitive):**
```bash
mc rate-limit --reset security --force        # Reset specific command
mc rate-limit --reset-all --force             # Reset all commands
```

Rate limiting protects against:
- Command flooding and accidental script loops
- Brute force attacks on sensitive operations
- Resource exhaustion from rapid command execution
- Automated attack scripts

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

### Security Monitoring 🛡️

MasterClaw includes comprehensive security monitoring and threat detection:

```bash
mc security                    # Run full security scan
mc security --status           # Quick security status check
mc security --hours 48         # Scan last 48 hours
mc security --json             # Output results as JSON
```

**Threat Detection:**
- **Brute Force Detection** — Identifies repeated failed authentication attempts
- **Rate Limit Violations** — Detects command flooding and abuse patterns
- **Error Spike Detection** — Flags unusual error rates indicating attacks
- **Privilege Escalation** — Monitors for suspicious configuration changes
- **Suspicious Patterns** — Identifies reconnaissance and after-hours activity
- **Configuration Drift** — Detects unauthorized permission changes

**Example Output:**
```
🔒 MasterClaw Security Scan
   Analyzing last 24 hours...

Scan Summary:
  Scan ID: scan-1708101234567
  Duration: 234ms
  Time window: Last 24 hours

⚠️  Threats detected: 2
   High: 1
   Medium: 1

Detailed Threat Information:

  1. BRUTE_FORCE (high)
     Source: 192.168.1.100
     Time: 2024-02-16T10:30:00Z
     Failed attempts: 8 in 15 minutes

Recommendations:
  • Review high-severity threats and take appropriate action
  • Review audit logs for more details: mc logs query
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

# Loki Log Aggregation Queries (requires monitoring stack)
mc logs query                  # Follow all logs via Loki
mc logs query backend          # Query logs for specific service
mc logs query --service core   # Query specific service
mc logs query --errors         # Show only error logs
mc logs query --errors --since 24h  # Errors from last 24h
mc logs query '{service="mc-core"} |= "error"'  # Raw LogQL query
mc logs query --follow         # Real-time log tail via Loki
mc logs query --labels         # List available Loki labels
```

**Services:** `traefik`, `interface`, `backend`, `core`, `gateway`, `chroma`, `watchtower`, or `all` (default)

**Note:** `mc logs query` requires the monitoring stack (Loki) to be running. Start it with `make monitor`.

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

### `mc import`
Import data from export files (complements `mc export`)
```bash
mc import all <file>           # Auto-detect and import (config, memory, or full)
mc import all ./export.json --dry-run    # Preview import without changes
mc import all ./export.json --force      # Overwrite existing data

mc import config <file>        # Import only configuration
mc import config ./config.json --dry-run
mc import config ./config.json --force   # Overwrite existing values

mc import memory <file>        # Import memories from backup
mc import memory ./memories.json
mc import memory ./memories.json --no-delay  # Skip delays (faster, riskier)

mc import validate <file>      # Validate import file without importing
```

**Import Types:**
- **full** — Complete export with config, memories, and sessions
- **config** — Configuration settings only
- **memory** — Memory/vector data only

**Safety Features:**
- `--dry-run` — Preview what would be imported without making changes
- `--force` — Overwrite existing data (default: skip existing)
- Interactive confirmation before importing (unless `--force` is used)
- Automatic format detection with manual override (`--type`)
- Validation of import file structure before importing
- Progress reporting with error details

**Examples:**
```bash
# Export and import workflow
mc export --output ./backup-2024-02-16
mc import all ./backup-2024-02-16/config.json --dry-run
mc import all ./backup-2024-02-16/config.json

# Migrate memories between instances
mc import memory ./old-memories.json --no-delay

# Validate before import
mc import validate ./suspicious-export.json
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
- `lib/logs.js` - Log viewing, management, export, and Loki integration
- `lib/restore.js` - Disaster recovery and backup restoration
- `lib/import.js` - Import data from export files (complements restore)
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

### Security Monitor Module (`lib/security-monitor.js`)

Provides comprehensive security monitoring and threat detection:

```javascript
const securityMonitor = require('./lib/security-monitor');

// Run full security scan
const scanResults = await securityMonitor.runSecurityScan({ hours: 24 });

// Detect specific threat types
const bruteForce = await securityMonitor.detectBruteForce(24);
const rateViolations = await securityMonitor.detectRateLimitViolations(24);
const errorSpikes = await securityMonitor.detectErrorSpikes(24);
const privilegeEscalation = await securityMonitor.detectPrivilegeEscalation(24);

// Get quick status
const status = await securityMonitor.getQuickSecurityStatus();

// Monitor configuration for drift
const configHealth = await securityMonitor.monitorConfiguration();
```

**Features:**
- **Brute Force Detection**: Sliding window analysis of failed authentication attempts
- **Rate Limit Violations**: Command flooding and abuse pattern detection
- **Error Spike Detection**: Anomalous error rate monitoring
- **Privilege Escalation**: Rapid config change and permission pattern detection
- **Suspicious Activity**: Reconnaissance and after-hours activity detection
- **Configuration Drift**: File permission and hash-based change detection
- **Automated Response**: High-severity threats automatically logged to audit trail

## Related

- [masterclaw-infrastructure](https://github.com/TheMasterClaw/masterclaw-infrastructure) — Deployment
- [masterclaw-core](https://github.com/TheMasterClaw/masterclaw-core) — AI brain
- [MasterClawInterface](https://github.com/TheMasterClaw/MasterClawInterface) — The UI

---

*Tools for the master.* 🐾
