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
| 🔒 High Security | `config-audit`, `config-fix`, `audit-verify`, `security`, `exec`, `restore` | 3-10 | 1-5 min |
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

### Import Security 🛡️

The `mc import` command includes comprehensive security protections:

**Path Traversal Protection:**
- Blocks `../../../etc/passwd` style attacks
- Prevents access to files outside intended directories
- Validates all path components before file access

**File Validation:**
- **Size limits** — Maximum 10MB import files prevent DoS
- **Extension whitelist** — Only `.json` files allowed
- **Content validation** — File structure verified before processing

**Prototype Pollution Prevention:**
- Detects and rejects `__proto__`, `constructor`, `prototype` keys
- Sanitizes nested objects recursively
- Prevents malicious object pollution attacks

**Rate Limiting:**
- 10 imports per minute maximum
- Prevents automated abuse and resource exhaustion
- Integrated with `mc rate-limit` command

**Audit Logging:**
- Security violations logged for review
- Failed import attempts tracked
- Path traversal attempts recorded with details

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

### JSON Output Mode 🆕
For production environments and CI/CD pipelines that require structured log aggregation, enable JSON output mode:

```bash
MC_JSON_OUTPUT=1 mc status          # Output errors as structured JSON
MC_JSON_OUTPUT=1 mc validate        # JSON output for automation
```

**Example JSON output:**
```json
{
  "level": "error",
  "timestamp": "2024-02-17T19:30:00.000Z",
  "category": "docker",
  "exitCode": 3,
  "message": "Docker is not installed",
  "suggestion": "Install Docker from https://docs.docker.com/get-docker/",
  "command": "status",
  "error": {
    "type": "Error",
    "message": "Docker daemon connection refused",
    "code": "ECONNREFUSED"
  }
}
```

**Benefits:**
- Structured logging for ELK, Splunk, or cloud log aggregation
- Machine-readable error details for automation
- Consistent schema across all error types
- Sensitive data automatically masked

## Commands

### `mc info` 🆕
Show comprehensive system information — versions, paths, features, and configuration summary.

```bash
mc info              # Pretty-printed system overview
mc info --json       # Machine-readable JSON output
```

### `mc notify` 🆕
Manage alert notifications across multiple channels (WhatsApp, Discord, Slack, Telegram).
Configure, test, and monitor alerts for service downtime, SSL expiration, costs, and security threats.

```bash
# Check notification status
mc notify status              # Show all channels and alert configuration
mc notify status --json       # Output as JSON

# Start/stop the alert webhook server
mc notify start               # Start webhook server
mc notify start --port 9090   # Start on custom port
mc notify stop                # Stop webhook server
mc notify restart             # Restart webhook server

# Configure notification channels
mc notify config whatsapp --number "+1234567890"
mc notify config discord --webhook "https://discord.com/api/webhooks/..."
mc notify config slack --webhook "https://hooks.slack.com/services/..."
mc notify config telegram --token "123456:ABC..." --chat-id "-1001234567890"

# Enable/disable channels
mc notify enable discord      # Enable Discord notifications
mc notify disable slack       # Disable Slack notifications

# Send test notifications
mc notify test                # Test all enabled channels
mc notify test discord        # Test specific channel
mc notify test --severity critical  # Test with critical severity

# Configure alert types
mc notify alerts --list                      # List all alert types
mc notify alerts --enable sslExpiring        # Enable SSL expiration alerts
mc notify alerts --disable highCost          # Disable cost threshold alerts
```

**Alert Types:**
| Alert Type | Description |
|------------|-------------|
| `serviceDown` | When services become unhealthy or stop |
| `sslExpiring` | SSL certificate expiration warnings (14 days) |
| `highCost` | LLM usage costs exceeding thresholds |
| `securityThreat` | Detected security threats and violations |

**Example Configuration:**
```bash
# Set up Discord notifications
mc notify config discord --webhook "https://discord.com/api/webhooks/123/abc"
mc notify enable discord

# Test the configuration
mc notify test discord

# Start the webhook server to receive alerts
mc notify start
```

### `mc events` 🆕
Event tracking and notification history — track system events, acknowledge alerts, and maintain an audit trail of important activities.

```bash
# List and filter events
mc events list                      # List recent events
mc events list -u                   # Show only unacknowledged events
mc events list --severity critical  # Show critical events only
mc events list --type backup        # Show backup events
mc events list --since 24h          # Events from last 24 hours
mc events list --search "deploy"    # Search events
mc events list --compact            # Compact output format

# View and acknowledge events
mc events show <id>                 # Show event details
mc events ack <id>                  # Acknowledge an event
mc events ack-all                   # Acknowledge all events
mc events ack-all --severity high   # Acknowledge high severity only

# Event statistics
mc events stats                     # Show event statistics
mc events stats --since 7d          # Stats for last 7 days

# Add custom events
mc events add "Custom note" --type info
mc events add "Deployment started" --type deploy --severity info

# Export and manage events
mc events export                    # Export events to JSON
mc events export --format csv       # Export as CSV
mc events clear --older-than 30d    # Clear old events

# Real-time monitoring
mc events watch                     # Watch for new events
mc events watch --severity high     # Watch for high severity+ events
```

**Event Types:**
| Type | Icon | Description |
|------|------|-------------|
| `backup` | 💾 | Backup operations |
| `deploy` | 🚀 | Deployments and rollbacks |
| `alert` | 🔔 | System alerts |
| `error` | ❌ | Errors and failures |
| `warning` | ⚠️ | Warnings |
| `info` | ℹ️ | Informational events |
| `security` | 🔒 | Security-related events |
| `maintenance` | 🔧 | Maintenance activities |
| `restore` | 📦 | Restore operations |
| `update` | ⬆️ | Updates |

**Severity Levels:**
- `critical` — Immediate attention required
- `high` — Should be addressed soon
- `medium` — Normal operational events
- `low` — Minor issues
- `info` — Informational only

**Example Workflow:**
```bash
# Check for unacknowledged critical events
mc events list -u --severity critical

# Acknowledge a specific event
mc events ack evt_1234567890

# Add a note about manual intervention
mc events add "Investigated disk alert - false positive" --type info

# Export events for compliance reporting
mc events export --since 30d -o monthly-report.json
```

**Integration with other commands:**
Events are automatically created by:
- `mc backup` — Creates backup events
- `mc deploy` — Creates deployment events
- `mc restore` — Creates restore events
- `mc health` — Creates health check events (on failures)

**Displays:**
- CLI version, Node.js version, and platform info
- Core API version and status (if running)
- System information (OS, memory, uptime)
- Docker version and availability
- Infrastructure directory location and key files
- Configuration summary (keys configured)
- Feature availability (monitoring, SSL, backups, canary deployment)

**Example Output:**
```
🐾 MasterClaw System Information

CLI:
  Version: 0.14.0
  Node.js: v22.22.0
  Platform: linux (x64)

Core API:
  Status: ● Running
  Version: 1.0.0

System:
  Hostname: ip-172-31-90-162
  OS: linux 6.14.0-1018-aws (x64)
  CPUs: 2
  Memory: 3.2 GB free / 7.5 GB total
  Uptime: 2d 5h 30m
...
```

### `mc benchmark` 🆕
Performance benchmarking for LLM providers, memory store, and API endpoints.
Compare providers, track performance trends, and detect regressions.

```bash
# Run full benchmark suite
mc benchmark

# Run specific benchmarks only
mc benchmark --skip-llm      # Skip LLM provider tests
mc benchmark --skip-memory   # Skip memory store tests
mc benchmark --skip-api      # Skip API endpoint tests

# Customize test iterations
mc benchmark --iterations 5

# Use different API endpoint
mc benchmark --api-url http://localhost:8000
```

**Benchmarks:**
| Test | Measures |
|------|----------|
| LLM | Response time, time-to-first-token, throughput by provider/model |
| Memory | Add entry latency, search latency at scale |
| API | Endpoint latency under concurrent load |

**Example Output:**
```
🐾 MasterClaw Performance Benchmark

🧪 LLM Provider Benchmarks

Test: short (10 expected tokens)
  GPT-4o... ✓ 450ms avg, 22.2 t/s
  GPT-4o Mini... ✓ 280ms avg, 35.7 t/s
  Claude 3 Opus... ✓ 520ms avg, 19.2 t/s

💾 Memory Store Benchmarks
  Add entry: ✓ 15ms avg per entry
  Search: ✓ 45ms avg per search

📊 Results Summary
═══════════════════════════════════════════════════════════

LLM Performance:
─────────────────────────────────────────────────────
Model                Test       Avg Time     Throughput   Success
─────────────────────────────────────────────────────
GPT-4o               short      450ms        22.2 t/s     ✓ 100%
GPT-4o Mini          short      280ms        35.7 t/s     ✓ 100%
Claude 3 Opus        short      520ms        19.2 t/s     ✓ 100%
```

### `mc benchmark-history`
View benchmark history and track performance trends over time.

```bash
mc benchmark-history         # Show last 10 runs
mc benchmark-history --all   # Show all historical runs
```

### `mc benchmark-compare`
Compare recent benchmark runs to detect performance changes.

```bash
mc benchmark-compare
```

**Output:**
```
📊 Benchmark Comparison

LLM Performance Changes:
──────────────────────────────────────────────────────
  GPT-4o (short)
    ↑ +5.2%  428ms → 450ms
  GPT-4o Mini (short)
    ↓ -12.1%  319ms → 280ms 🟢
```

### `mc benchmark-export`
Export benchmark history for analysis in external tools.

```bash
mc benchmark-export                    # Export as JSON
mc benchmark-export --format csv       # Export as CSV
mc benchmark-export -o report.json     # Custom output file
```

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

### `mc smoke-test` 🆕
Post-deployment API smoke tests — verify that your deployment actually works by testing all critical endpoints

```bash
mc smoke-test                  # Run full smoke test suite
mc smoke-test --quick          # Run quick test (critical endpoints only)
mc smoke-test --api-url http://localhost:8000  # Specify API URL
mc smoke-test --json           # Output results as JSON
```

**Tests:**
| Category | Endpoints | Purpose |
|----------|-----------|---------|
| Health | `/health`, `/health/security`, `/metrics` | Service availability |
| API | `/v1/chat`, `/v1/memory/search`, `/v1/sessions` | Core functionality |
| Analytics | `/v1/costs`, `/v1/analytics/stats` | Cost tracking |
| Realtime | WebSocket connectivity | Streaming functionality |

**Example Output:**
```
🧪 MasterClaw API Smoke Tests
   Base URL: http://localhost:8000

  ✅ Health Endpoint (45ms)
  ✅ Metrics Endpoint (32ms)
  ✅ Security Health Check (28ms)
  ✅ Chat Endpoint (1245ms)
  ✅ Memory Search (156ms)
  ✅ Session List (89ms)
  ✅ Cost Summary (67ms)
  ✅ Analytics Stats (45ms)
  ✅ WebSocket Connectivity (23ms)

📊 Test Results
   Duration: 1730ms
   9 passed, 0 failed

Category Breakdown:
  ✅ health: 3/3
  ✅ monitoring: 1/1
  ✅ api: 4/4
  ✅ realtime: 1/1

✅ All smoke tests passed! Deployment is healthy.
```

**Exit codes:**
- `0` — All tests passed, deployment is healthy
- `1` — Some tests failed (non-critical)
- `2` — Critical tests failed (deployment may be unhealthy)

**Integration:**
```bash
# Run automatically after deployment
make prod-smoke    # Deploy and run smoke tests
make smoke-test    # Run smoke tests on existing deployment

# In CI/CD pipeline
mc smoke-test --api-url https://api.example.com --json
```

### `mc env` 🆕
Environment configuration management — compare, validate, and sync environment configurations between dev/staging/prod

```bash
# Compare environments
mc env diff                      # Compare .env with .env.prod
mc env diff .env .env.staging    # Compare specific files
mc env diff --show-values        # Show actual values (default: masked)

# Validate environment configuration
mc env check                     # Validate .env file
mc env check .env.prod           # Validate specific file
mc env check --json              # Output as JSON

# Sync configuration between environments
mc env sync                      # Sync from .env.prod to .env
mc env sync .env.prod .env.dev   # Sync specific files
mc env sync --dry-run            # Preview changes without applying

# Generate new environment template
mc env template                  # Create .env template
mc env template -o .env.dev      # Output to specific file
mc env template --include-optional  # Include API keys
```

**Features:**
- **Compare** — Detect added, removed, and modified variables between environments
- **Validate** — Check required variables, email/URL formats, and placeholder values
- **Sync** — Copy non-sensitive configuration between environments (with backups)
- **Security** — Sensitive values (tokens, API keys) are masked by default

**Environment Schema:**
| Category | Variables |
|----------|-----------|
| Required | `DOMAIN`, `ACME_EMAIL`, `GATEWAY_TOKEN` |
| Sensitive | `GATEWAY_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` |
| Recommended | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `RETENTION_DAYS` |

**Example workflow:**
```bash
# 1. Validate production config
mc env check .env.prod

# 2. Compare dev with prod
mc env diff .env.dev .env.prod

# 3. Sync non-sensitive config from prod to dev
mc env sync .env.prod .env.dev --dry-run  # Preview first
mc env sync .env.prod .env.dev            # Apply changes

# 4. Generate template for new environment
mc env template -o .env.staging
```

**Exit codes:**
- `0` — Environment valid/synced successfully
- `1` — Validation failed or differences found

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

### `mc exec` 🆕
Execute commands in running MasterClaw containers — like `kubectl exec` or `docker exec` but tailored for MasterClaw

```bash
# Execute a command in a container
mc exec mc-core "python --version"           # Check Python version in core
mc exec mc-backend "node --version"          # Check Node version in backend
mc exec mc-chroma "ls -la /chroma/chroma"    # List files in ChromaDB

# Interactive shell (full terminal access)
mc exec mc-core sh --shell                   # Open shell in core container
mc exec mc-backend bash --shell              # Open bash shell (if available)

# With working directory
mc exec mc-core "ls -la" -w /data            # List files in /data directory

# With environment variables
mc exec mc-core "echo \$MY_VAR" -e MY_VAR=hello

# Interactive mode with TTY (for colored output)
mc exec mc-core "htop" -i -t                 # Run htop interactively
```

**Security Features:**
- Container whitelist — only MasterClaw containers can be targeted
- Command injection prevention — dangerous characters blocked
- Blocked commands — `rm`, `dd`, `mkfs`, `fdisk`, and other dangerous commands are blocked
- Rate limiting — 10 executions per minute (high-security command)
- Audit logging — all executions logged for security review
- Timeout protection — commands timeout after 5 minutes (30 min for interactive)

**Allowed Containers:**
- `mc-core` — AI brain (Python environment)
- `mc-backend` — API backend (Node.js environment)
- `mc-gateway` — OpenClaw gateway
- `mc-chroma` — Vector database
- `mc-interface` — Frontend (nginx)
- `mc-traefik` — Reverse proxy

**Exit Codes:**
- Container exit code is passed through
- Non-zero exit codes indicate command failure

### `mc containers` 🆕
List running MasterClaw containers

```bash
mc containers              # Show running containers
mc containers -a           # Show all containers (including stopped)
```

**Example Output:**
```
🐾 MasterClaw Containers

Running Containers:
  ● mc-core
     Status: Up 3 hours
  ● mc-backend
     Status: Up 3 hours
  ● mc-gateway
     Status: Up 3 hours

Use 'mc exec <container> <command>' to run commands
Use 'mc exec <container> sh --shell' for interactive shell
```
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

### `mc backup-verify`
Verify backup integrity and restorability — ensures backups can actually be restored
```bash
mc backup-verify                 # Verify latest backup (default)
mc backup-verify --latest        # Same as above
mc backup-verify --all           # Verify all backups within retention
mc backup-verify --file <path>   # Verify specific backup file
mc backup-verify --metrics       # Output Prometheus metrics format
mc backup-verify --quiet         # Exit code only, no output
```

**Why verify backups?**
- Detects corrupted archives before you need them
- Tests that backups can actually be restored
- Validates backup contents and structure
- Provides Prometheus metrics for monitoring

**Verification checks:**
- Archive integrity (corruption detection)
- Manifest file presence
- Data archive readability
- Test restore of sample files
- Age warnings for stale backups

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
Manage CLI configuration — view, modify, export, and import settings

```bash
# View configuration
mc config list                           # List all config values (masked)
mc config list --json                    # Output as JSON
mc config list --no-mask                 # Show sensitive values (use with caution)

# Get/set individual values
mc config get gateway.url                # Get a specific value
mc config set gateway.url https://gw.example.com
mc config set defaults.backupRetention 14
mc config set defaults.autoUpdate false --json  # Parse value as JSON

# Export/import configuration
mc config export                         # Export to timestamped file
mc config export ./backup-config.json    # Export to specific file
mc config export --no-mask               # Export with sensitive values (caution!)
mc config import ./backup-config.json    # Import from file (interactive)
mc config import ./config.json --force   # Import without confirmation
mc config import ./config.json --dry-run # Preview changes

# Reset configuration
mc config reset                          # Reset to defaults (with confirmation)
mc config reset --force                  # Skip confirmation
```

**Features:**
- **Dot notation** — Use keys like `gateway.url` for nested values
- **Type inference** — Automatically converts booleans, numbers, null
- **Security masking** — Sensitive values (tokens, passwords) are masked by default
- **Safe export** — Exports mask sensitive values; use `--no-mask` only when necessary
- **Import preview** — Shows diff before applying changes
- **Rate limiting** — Set and import operations are rate-limited for security

**Configuration Schema:**
```json
{
  "infraDir": "/path/to/infrastructure",
  "gateway": {
    "url": "http://localhost:3000",
    "token": null
  },
  "api": {
    "url": "http://localhost:3001"
  },
  "core": {
    "url": "http://localhost:8000"
  },
  "defaults": {
    "backupRetention": 7,
    "autoUpdate": true
  }
}
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

**Security Features:**
- **Path Traversal Protection** — Blocks `../../../etc/passwd` style attacks
- **File Size Limits** — Maximum 10MB import files (DoS protection)
- **Extension Validation** — Only `.json` files allowed
- **Prototype Pollution Prevention** — Rejects `__proto__`, `constructor`, `prototype` keys
- **Rate Limiting** — 10 imports per minute (prevents abuse)
- **Item Limits** — Maximum 10,000 memories per import
- **Audit Logging** — Security violations are logged for review

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
Update MasterClaw services and CLI to the latest versions
```bash
mc update                      # Update all services and check for CLI updates
mc update --check              # Check for available updates without applying
mc update --dry-run            # Show what would be updated without making changes
mc update --services           # Update Docker services only (skip CLI check)
mc update --cli-only           # Check CLI updates only (skip Docker services)
mc update version              # Show current versions of all components
mc update version --json       # Output versions as JSON
```

**Features:**
- **Check mode**: Preview available updates without applying
- **Dry-run**: See exactly what would change before committing
- **Selective updates**: Update only services or only CLI
- **Version tracking**: Shows current vs available versions
- **Safe by default**: Requires explicit flags to apply changes

**Update workflow:**
```bash
# 1. Check what updates are available
mc update --check

# 2. Preview what would change (dry run)
mc update --dry-run

# 3. Apply updates
mc update

# 4. Verify services are healthy after update
mc status
```

**CI/CD integration:**
```bash
# Automated update with health check
mc update --services && mc health --compact || echo "Update failed"
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

### `mc maintenance` 🆕
Run comprehensive system maintenance — combines health checks, cleanup, backup verification, and Docker optimization
```bash
mc maintenance                           # Interactive maintenance (recommended)
mc maintenance --force                   # Skip all confirmations
mc maintenance --days 30                 # Clean sessions older than 30 days
mc maintenance --no-cleanup              # Skip session cleanup
mc maintenance --no-docker               # Skip Docker pruning
mc maintenance --no-verify               # Skip backup verification
mc maintenance --logs                    # Also clean old container logs
mc maintenance --report                  # Generate maintenance report file
mc maintenance status                    # Quick status check
mc maintenance schedule                  # Show cron scheduling examples
```

**What maintenance does:**
1. **Health Checks** — Verifies Core API, disk space, session stats
2. **Session Cleanup** — Removes old sessions based on retention policy
3. **Backup Verification** — Checks backup freshness and integrity
4. **Docker Pruning** — Removes unused images, containers, and volumes
5. **Log Cleanup** — Optionally cleans old container logs (with `--logs`)

**Why use maintenance instead of individual commands?**
- **Unified workflow** — One command for routine upkeep
- **Safety checks** — Health verification before destructive operations
- **Comprehensive** — Covers all aspects of system hygiene
- **Report generation** — Audit trail for compliance (with `--report`)

**Example maintenance session:**
```
🔧 MasterClaw Maintenance

📊 Phase 1: Health Checks
=========================
  ✅ Core API: Healthy (v1.0.0)
  ✅ Disk: 45% used (45GB/100GB)
  📈 Sessions: 1,245 total, 23 active (24h)

🧹 Phase 2: Session Cleanup
===========================
  ⚠️  Found 156 sessions older than 30 days
     Total messages to remove: 3,420
  Delete 156 old sessions? [y/N] y
  ✓ Deleted 156 sessions

💾 Phase 3: Backup Verification
================================
  ✅ 12 backup(s) found
     Latest: masterclaw_backup_20250217.tar.gz
     Size: 450MB
     Age: 4.2 hours
     Status: Fresh

🐳 Phase 4: Docker Maintenance
===============================
  Current Usage:
     Images: 2.4GB (1.2GB reclaimable)
     Volumes: 450MB (120MB reclaimable)
  Prune unused Docker images, containers, and volumes? [y/N] y
  ✅ Docker pruning complete

📋 Maintenance Summary
======================
  ✅ Passed: 4
  Duration: 12.3s
🐾 Maintenance complete! System is healthy.
```

**Recommended schedules:**
```bash
# Weekly maintenance (keep 30 days of sessions)
0 3 * * 0 /usr/local/bin/mc maintenance --force --days 30 --report

# Daily lightweight maintenance (keep 14 days, no Docker pruning)
0 2 * * * /usr/local/bin/mc maintenance --force --days 14 --no-docker

# Monthly deep maintenance (keep 90 days, full optimization)
0 4 1 * * /usr/local/bin/mc maintenance --force --days 90 --logs --report
```

**Report output:**
When using `--report`, a JSON file is generated with full maintenance details:
```bash
mc maintenance --report  # Creates maintenance-report-<timestamp>.json
```

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
- `lib/update.js` - Update management for services and CLI
- `lib/memory.js` - Memory operations
- `lib/task.js` - Task management
- `lib/completion.js` - Shell auto-completion support
- `lib/notify.js` - **NEW: Notification channel management**
- `lib/events.js` - **NEW: Event tracking and notification history**
- `lib/security.js` - Centralized security utilities
- `lib/exec.js` - Container execution (mc exec, mc containers)
- `lib/rate-limiter.js` - Command rate limiting

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

## Testing 🧪

MasterClaw Tools includes comprehensive test coverage with 400+ tests:

```bash
# Run all tests
npm test

# Run specific test suite
npm test -- docker.security.test.js
npm test -- exec.security.test.js
npm test -- error-handler.test.js

# Run with coverage
npm test -- --coverage
```

### Security Test Suites

| Test File | Coverage |
|-----------|----------|
| `docker.security.test.js` | Docker command validation, container security |
| `exec.security.test.js` | **Container execution security** — `mc exec` command hardening |
| `config.security.test.js` | Config file permissions, prototype pollution protection |
| `services.security.test.js` | Service health check security |
| `audit.integrity.test.js` | Audit log signing and tamper detection |
| `security-monitor.test.js` | Threat detection algorithms |
| `rate-limiter.test.js` | Command rate limiting |
| `error-handler.test.js` | Error classification and safe error messages |

### exec.security.test.js — Container Execution Security

The test suite validates the security controls for `mc exec` and `mc containers` commands:

**Container Validation:**
- ✅ Only allowed containers can be targeted (`mc-core`, `mc-backend`, etc.)
- ✅ Path traversal attempts in container names are blocked
- ✅ Container must be running before execution

**Command Security:**
- ✅ Blocked commands are rejected (`rm`, `dd`, `mkfs`, `fdisk`, etc.)
- ✅ Shell injection characters are detected and blocked
- ✅ Command length limits prevent DoS attacks
- ✅ Environment variable name validation

**Shell Command Injection Prevention (v0.16.1) 🆕**
- ✅ Detects and blocks shell escapes via `-c` / `--command` options
- ✅ Validates command strings passed to shell interpreters (`sh`, `bash`, `zsh`, etc.)
- ✅ Blocks command chaining (`;`, `&&`, `||`, `|`)
- ✅ Blocks command substitution (`$(...)`, `` `...` ``)
- ✅ Blocks dangerous subcommands within shell strings
- ✅ Prevents path traversal via tilde expansion (`~/..`)
- ✅ Comprehensive blocked command list includes filesystem utilities (`mkfs.*`, `mkswap`, etc.)

**Example blocked attacks:**
```bash
# Blocked: dangerous command in shell string
mc exec mc-core sh -c "rm -rf /"        # ❌ BLOCKED
mc exec mc-core bash -c "dd if=/dev/zero of=/dev/sda"  # ❌ BLOCKED

# Blocked: command chaining attempts
mc exec mc-core sh -c "echo test; rm -rf /"            # ❌ BLOCKED
mc exec mc-core bash -c "echo test && mkfs.ext4 /dev/sda"  # ❌ BLOCKED

# Blocked: command substitution
mc exec mc-core sh -c 'echo $(rm -rf /)'               # ❌ BLOCKED
mc exec mc-core bash -c "echo \`fdisk -l\`"            # ❌ BLOCKED

# Allowed: safe shell commands
mc exec mc-core sh -c "echo hello"                     # ✅ OK
mc exec mc-core bash -c "ls -la /app"                  # ✅ OK
```

**Integration Security:**
- ✅ Prevents command injection through container names
- ✅ Prevents command injection through arguments
- ✅ Path traversal protection in working directories
- ✅ All security errors include proper error codes for debugging

## Related

- [masterclaw-infrastructure](https://github.com/TheMasterClaw/masterclaw-infrastructure) — Deployment
- [masterclaw-core](https://github.com/TheMasterClaw/masterclaw-core) — AI brain
- [MasterClawInterface](https://github.com/TheMasterClaw/MasterClawInterface) — The UI

---

*Tools for the master.* 🐾
