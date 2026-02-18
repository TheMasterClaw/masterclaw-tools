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

> 📖 **Comprehensive security documentation**: See [SECURITY.md](./SECURITY.md) for detailed security features, threat model, vulnerability reporting, and best practices.

MasterClaw Tools implements comprehensive security hardening:

### Distributed Tracing & Correlation IDs 🔗

MasterClaw CLI automatically generates correlation IDs for distributed tracing:

```bash
# Correlation IDs are automatically included in all logs
# Set custom correlation ID via environment variable (CI/CD integration)
MC_CORRELATION_ID=deploy-2024-001 mc deploy

# Correlation IDs propagate through:
# - Logger output (as context)
# - Audit log entries  
# - System events
# - HTTP headers (x-correlation-id)
```

**Features:**
- **Automatic generation** — Unique IDs for each command execution (`mc_<timestamp>_<random>`)
- **Environment integration** — Pass `MC_CORRELATION_ID` for CI/CD pipeline tracing
- **Hierarchical tracing** — Child IDs for sub-operations (`parent.child`)
- **Security validated** — IDs sanitized to prevent log injection (max 64 chars, alphanumeric + `_-`)
- **HTTP propagation** — Automatic `x-correlation-id` header for API calls

### Secure HTTP Client 🆕

All outbound HTTP requests are routed through a security-hardened client:

```javascript
const httpClient = require('./lib/http-client');

// SSRF-protected GET request
const response = await httpClient.get('https://api.example.com/data');

// With audit logging
const result = await httpClient.post(url, data, httpClient.withAudit());

// Health check
const status = await httpClient.healthCheck('https://api.example.com/health');
```

**Security Features:**
- **SSRF Protection** — Blocks private IPs, internal hostnames, suspicious domains
- **URL Scheme Validation** — Rejects `data:`, `file:`, `javascript:` URLs
- **Header Injection Prevention** — Sanitizes headers, blocks CRLF injection
- **Response Size Limits** — Prevents DoS via oversized responses (10MB max)
- **Timeout Enforcement** — Safe defaults with configurable limits
- **Audit Logging** — All external calls tracked with correlation IDs

**Usage in code:**
```javascript
const { 
  generateCorrelationId,
  runWithCorrelationIdAsync,
  getCurrentCorrelationId 
} = require('./lib/correlation');

// Run with correlation context
await runWithCorrelationIdAsync(async () => {
  console.log(getCurrentCorrelationId()); // mc_abc123...
}, 'my-custom-id');
```

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

### Circuit Breaker ⚡
MasterClaw CLI includes circuit breaker protection for service resilience:

```bash
mc circuits              # Show circuit breaker status for all services
mc circuits --json       # Output as JSON for monitoring
mc circuits --reset core # Reset circuit for a specific service
mc circuits --reset-all  # Reset all circuits
```

**Features:**
- **Fail-fast protection** — Opens circuit after consecutive failures to prevent cascading failures
- **Automatic recovery** — Tests service health in half-open state before fully closing
- **Per-service isolation** — Each service has its own circuit; failures don't affect other services
- **Error rate monitoring** — Opens circuit when error rate exceeds configurable threshold

**Circuit States:**
| State | Icon | Description |
|-------|------|-------------|
| `CLOSED` | ✅ | Normal operation - requests pass through |
| `OPEN` | 🔴 | Failure threshold exceeded - requests fail fast |
| `HALF_OPEN` | 🟡 | Testing if service has recovered |

**Example Output:**
```
⚡ MasterClaw Circuit Breaker Status

✅ AI Core
   State: CLOSED ●
   Calls: 245 total (243 success, 2 failed)
   Error Rate: 0.8%

🔴 Backend API
   State: OPEN ●
   Calls: 15 total (10 success, 5 failed)
   Error Rate: 33.3%
   Recent Failures: 5 in last 60s
```

**Configuration:**
- Failure threshold: 3 consecutive failures
- Reset timeout: 15 seconds before attempting recovery
- Success threshold: 2 consecutive successes to close
- Error rate threshold: 60%

**Fallback Support (Graceful Degradation):**
When a circuit is open, the CLI can use fallback mechanisms to maintain partial functionality:
- **Static fallback values** — Return cached or default data instead of failing
- **Fallback functions** — Execute alternative logic (e.g., read from cache)
- **Audit logging** — All fallback usage is tracked for monitoring

This enables graceful degradation where services continue operating with reduced functionality during outages, rather than complete failure.

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

### Audit Log Viewer 📋

View and analyze security audit logs with powerful filtering:

```bash
mc audit                       # View recent audit entries (last 24h)
mc audit -n 100                # Show last 100 entries
mc audit --hours 48            # Show entries from last 48 hours
mc audit --summary             # Show security statistics only
mc audit -t SECURITY_VIOLATION # Filter by event type
mc audit -s error              # Filter by severity (debug, info, warning, error, critical)
mc audit --search "deploy"     # Search for text in audit entries
mc audit --verify              # Verify integrity of displayed entries
mc audit --json                # Output as JSON
```

**Event Types:**
- `AUTH_SUCCESS` / `AUTH_FAILURE` — Authentication events
- `SECURITY_VIOLATION` — Security violations detected
- `CONFIG_READ` / `CONFIG_WRITE` — Configuration changes
- `DEPLOY_START` / `DEPLOY_SUCCESS` / `DEPLOY_FAILURE` — Deployment events
- `DOCKER_EXEC` — Container execution events
- `BACKUP_CREATE` / `BACKUP_RESTORE` — Backup operations

**Example Output:**
```
📋 Audit Log Viewer
   Showing last 50 entries from 24 hours ago

Found 42 entries:

ℹ  2/17/2026, 10:30:15 PM DEPLOY_SUCCESS ✓
   status=success, target=production

⚠  2/17/2026, 10:15:42 PM AUTH_FAILURE ✓
   cmd: config-read

✖  2/17/2026, 09:45:12 PM SECURITY_VIOLATION ✓
   violationType=rate_limit_exceeded, source=192.168.1.50
```

**Audit Integrity Verification:**
```bash
mc audit-verify                # Verify all audit log signatures
mc audit-verify -v             # Show detailed verification results
mc audit-verify --hours 48     # Verify last 48 hours only
mc audit-verify --rotate-key   # Rotate audit signing key (invalidates old signatures)
```

All audit entries are cryptographically signed with HMAC-SHA256 to detect tampering.

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

### `mc quickstart` 🆕
Interactive project bootstrap wizard for new MasterClaw projects. Creates a complete project structure with sensible defaults.

```bash
# Interactive mode
mc quickstart                    # Prompts for project name and options
mc quickstart my-project         # Use specified project name

# Non-interactive mode
mc quickstart my-project --yes   # Use all defaults

# Template selection
mc quickstart my-project --template minimal   # Bare essentials
mc quickstart my-project --template standard  # Recommended (default)
mc quickstart my-project --template complete  # Full-featured

# Additional options
mc quickstart my-project --skip-docker        # Skip Docker setup
mc quickstart my-project --skip-git           # Skip git initialization
mc quickstart my-project -d ~/projects        # Create in specific directory
```

**Templates:**

| Template | Description | Includes |
|----------|-------------|----------|
| `minimal` | Bare essentials | Basic config, environment setup |
| `standard` | Recommended setup | Docker Compose, monitoring, sample memories |
| `complete` | Full-featured | All above + backup scripts, CI/CD, health checks |

**Interactive Prompts:**
- Project name validation (letters, numbers, hyphens, underscores)
- Template selection with feature preview
- LLM provider choice (OpenAI, Anthropic, Google, Ollama)
- Docker Compose setup option
- Git initialization option

**Generated Structure:**
```
my-project/
├── .env                    # Environment configuration
├── .env.example            # Example environment file
├── .gitignore             # Git ignore rules
├── README.md              # Project documentation
├── config.json            # MasterClaw configuration
├── docker-compose.yml     # Docker setup (if selected)
├── backups/               # Backup storage
├── data/                  # Application data
├── docs/                  # Documentation
├── logs/                  # Log files
├── memory/                # Memory files
│   └── welcome.md         # Sample memory
├── scripts/               # Utility scripts
└── skills/                # Custom skills
```

**Example:**
```bash
# Create a new project interactively
mc quickstart
# ? Project name: my-ai-project
# ? Choose a project template: Standard
# ? Set up Docker Compose? Yes
# ? Initialize git repository? Yes
# ? Primary LLM provider: OpenAI

# Quick start with defaults
mc quickstart my-project --yes
cd my-project
docker-compose up -d
mc status
```

### `mc info` 🆕
Show comprehensive system information — versions, paths, features, and configuration summary.

```bash
mc info              # Pretty-printed system overview
mc info --json       # Machine-readable JSON output
```

### `mc alias` 🆕
Manage command aliases and shortcuts for faster CLI operations. Create custom shortcuts for frequently used commands.

```bash
# List all aliases
mc alias list              # Show all aliases and shortcuts
mc alias list --json       # Output as JSON

# Execute an alias
mc alias run <name>        # Execute an alias or shortcut
mc alias run s             # Example: runs 'mc status'

# Add new aliases
mc alias add <name> <command>     # Add a command alias
mc alias add st "status"          # Now 'mc alias run st' runs 'mc status'
mc alias add bk "backup --cloud"  # Alias with arguments
mc alias add deploy-prod "deploy rolling" --shortcut  # Add shell shortcut

# Manage aliases
mc alias show <name>       # Show alias details
mc alias remove <name>     # Remove an alias
mc alias export [file]     # Export aliases to JSON
mc alias import <file>     # Import aliases from JSON
mc alias import <file> --merge  # Merge with existing aliases
mc alias reset --force     # Reset to defaults
```

**Default Aliases:**
| Alias | Command | Description |
|-------|---------|-------------|
| `s` | `status` | Quick status check |
| `st` | `status` | Alternative status alias |
| `l` | `logs` | View logs |
| `log` | `logs` | Alternative logs alias |
| `b` | `backup` | Create backup |
| `bk` | `backup` | Alternative backup alias |
| `r` | `revive` | Start services |
| `u` | `update` | Update images |
| `d` | `deploy` | Deployment commands |
| `cfg` | `config` | Configuration management |
| `ex` | `exec` | Execute in containers |
| `ev` | `events` | Event tracking |
| `nt` | `notify` | Notification settings |
| `perf` | `performance` | Performance metrics |
| `sm` | `smoke-test` | Run smoke tests |
| `val` | `validate` | Validate environment |

**Default Shortcuts:**
| Shortcut | Command | Description |
|----------|---------|-------------|
| `deploy` | `cd /opt/masterclaw-infrastructure && ./scripts/deploy.sh` | Full deployment |
| `logs-backend` | `mc logs mc-backend --follow` | Follow backend logs |
| `logs-core` | `mc logs mc-core --follow` | Follow core logs |
| `logs-gateway` | `mc logs mc-gateway --follow` | Follow gateway logs |
| `quick-status` | `mc status --compact` | Quick status |
| `full-backup` | `mc backup && mc backup-cloud` | Backup + cloud upload |
| `health-watch` | `mc health --watch` | Watch health continuously |
| `restart-core` | `mc restart core` | Restart AI Core service |

**Examples:**
```bash
# Add custom alias for quick deploy check
mc alias add quick-check "smoke-test --quick"

# Add shell shortcut for custom workflow
mc alias add my-deploy "cd /opt/masterclaw && make prod && mc smoke-test" --shortcut

# Export aliases for backup
mc alias export ~/mc-aliases-backup.json

# Import aliases on new machine
mc alias import ~/mc-aliases-backup.json
```

Aliases are stored in `~/.openclaw/workspace/rex-deus/config/aliases.json` and integrate with rex-deus for personalized command shortcuts.

### `mc plugin` 🆕
**Plugin System** — Extend `mc` with custom commands without modifying core code. Install plugins from npm, git, or create your own.

```bash
# List installed plugins
mc plugin list                    # Show installed plugins
mc plugin list -a                 # Include disabled plugins

# Install plugins
mc plugin install mc-plugin-hello              # From npm
mc plugin install https://github.com/user/plugin.git  # From git
mc plugin install ./my-local-plugin            # From local directory

# Manage plugins
mc plugin uninstall mc-plugin-hello            # Remove a plugin
mc plugin enable mc-plugin-hello               # Enable a disabled plugin
mc plugin disable mc-plugin-hello              # Disable a plugin
mc plugin info mc-plugin-hello                 # Show plugin details

# Search and update
mc plugin search hello                         # Search npm for plugins
mc plugin update mc-plugin-hello               # Update a plugin
mc plugin update --all                         # Update all plugins

# Development
mc plugin create mc-plugin-mine                # Scaffold a new plugin
mc plugin run mc-plugin-hello -- arg1 arg2     # Run plugin directly
```

**Features:**
- **Install from multiple sources** — npm registry, git repositories, or local directories
- **Automatic dependency management** — npm dependencies installed automatically
- **Lifecycle hooks** — Install, update, and uninstall scripts
- **Permission system** — Plugins declare required permissions (fs, network, docker)
- **Enable/disable** — Temporarily disable plugins without uninstalling
- **Hot registration** — Installed plugins immediately available as `mc <command>`

**Plugin Manifest Example:**
```json
{
  "name": "mc-plugin-hello",
  "version": "1.0.0",
  "description": "A friendly greeting plugin",
  "author": "Your Name <email@example.com>",
  "main": "index.js",
  "command": "hello",
  "dependencies": ["chalk"],
  "permissions": ["fs"]
}
```

**Creating a Plugin:**
```bash
# 1. Scaffold a new plugin
mc plugin create mc-plugin-mycommand

# 2. Edit the generated files
cd mc-plugin-mycommand
# Edit index.js with your logic

# 3. Install and test
mc plugin install ./mc-plugin-mycommand
mc mycommand
```

See [rex-deus/docs/plugin-system.md](../rex-deus/docs/plugin-system.md) for complete documentation.

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

### `mc performance` 🆕
View API endpoint performance metrics and profiling data from the Core API.
Identify slow endpoints, track response times, and optimize API performance.

```bash
# Show performance summary (default)
mc performance

# Show detailed endpoint statistics
mc performance --stats

# Show top N slowest endpoints
mc performance --slowest 10

# Show recent request profiles
mc performance --profiles 50

# Show only slow requests
mc performance --profiles --slow-only

# Clear all performance profiles
mc performance --clear
```

**Performance Metrics:**
| Metric | Description |
|--------|-------------|
| Avg Response Time | Mean response time across all requests |
| Min/Max Time | Fastest and slowest observed times |
| Slow Requests | Count of requests exceeding threshold (default: 1000ms) |
| Slow % | Percentage of requests that were slow |
| Status Codes | Distribution of HTTP response codes |

**Example Output:**
```
🐾 MasterClaw Performance Summary

Total Requests: 1,247
Average Response Time: 245.32ms
Slow Requests: 23 (1.84%)
Endpoints Tracked: 15
Slow Threshold: 1000ms
```

**Use Cases:**
- Identify endpoints needing optimization
- Monitor API performance trends
- Debug slow response times
- Set performance SLAs and alerts

**Configuration:**
Environment variables (in Core):
- `PERF_SLOW_THRESHOLD_MS` — Slow request threshold (default: 1000ms)
- `PERF_MAX_PROFILES` — Maximum profiles to store (default: 10000)
- `PERF_ENABLED` — Enable/disable profiling (default: true)

### `mc metrics` 🆕
View system metrics and performance data without needing Grafana access. Quickly monitor request rates, error rates, LLM costs, and system health from the command line.

```bash
# Show current metrics summary
mc metrics

# Watch mode - continuously updating
mc metrics --watch
mc metrics --watch --interval 10  # Update every 10 seconds

# Output as JSON for scripting
mc metrics --json

# Export metrics to file
mc metrics --export
mc metrics --export --output ./metrics-$(date +%Y%m%d).json

# Compare with previous metrics
mc metrics --compare
```

**Metrics Displayed:**
| Metric | Description |
|--------|-------------|
| **Health Score** | Overall system health (0-100) based on error rate and response times |
| **Request Rate** | Requests per second |
| **Error Rate** | Percentage of failed requests |
| **Response Times** | Average and P95 response times |
| **LLM Metrics** | Total calls, rate, and accumulated costs |
| **Memory & Sessions** | Active memory entries and sessions |
| **System Resources** | CPU, memory, and disk usage (if node_exporter available) |

**Example Output:**
```
🐾 MasterClaw Metrics
   2/18/2026, 6:15:30 AM

Sources: Prometheus, Core API

✅ Health Score: 95/100

📊 Request Metrics
──────────────────────────────────────────────────
  Total Requests: 15.2k
  Request Rate:   25.50 req/s ↑ 5%
  Error Rate:     1.2%
  Avg Response:   245ms
  P95 Response:   520ms

🤖 LLM Metrics
──────────────────────────────────────────────────
  Total LLM Calls: 500
  LLM Rate:        2.50 calls/s
  Total Cost:      $12.50

💾 Memory & Sessions
──────────────────────────────────────────────────
  Memory Entries:  2,500
  Active Sessions: 15
```

**Data Sources:**
1. **Prometheus** (preferred) — Rich metrics from monitoring stack
2. **Core API** (fallback) — Basic metrics from `/metrics` endpoint

**Environment Variables:**
- `PROMETHEUS_URL` — Prometheus endpoint (default: http://localhost:9090)
- `CORE_URL` — Core API endpoint (default: http://localhost:8000)

**Exit Codes:**
- `0` — Metrics collected successfully
- `1` — Rate limit exceeded
- `4` — No metrics sources available

### `mc top` 🆕
Real-time container resource monitor — like `htop` but for MasterClaw services. Watch CPU, memory, network I/O, and container health in an auto-updating display.

```bash
# Start interactive resource monitor (watch mode)
mc top

# Single snapshot, no refresh
mc top --once

# Custom refresh interval
mc top --interval 5

# Output as JSON for scripting
mc top --json

# Export to file
mc top --export stats.json
```

**Display Columns:**
| Column | Description |
|--------|-------------|
| **Container** | Service name (traefik, core, backend, etc.) |
| **Status** | Running state and health (healthy/unhealthy) |
| **CPU** | CPU usage percentage with trend indicator |
| **Memory** | Current memory usage |
| **Mem%** | Memory usage as percentage of container limit |
| **Net In/Out** | Network I/O since container started |
| **PIDs** | Number of processes in container |
| **Uptime** | How long container has been running |

**Example Output:**
```
🐾 MasterClaw Resource Monitor
   2/18/2026, 6:20:15 AM

📱 App Services
────────────────────────────────────────────────────────────────────────────────────
  core         healthy    12.5%    850 MB     42%      12 MB      45 MB     15     2d
  backend      healthy     3.2%    420 MB     21%       8 MB      23 MB      8     2d
  interface    healthy     0.1%     85 MB      4%       2 MB       5 MB      5     2d
  gateway      healthy     2.1%    156 MB      8%       5 MB      12 MB      7     2d

💾 Data
────────────────────────────────────────────────────────────────────────────────────
  chroma       healthy     8.7%    1.2 GB     35%     156 MB     234 MB     12     2d

🔧 Infrastructure
────────────────────────────────────────────────────────────────────────────────────
  traefik      healthy     1.2%     45 MB      2%       1 MB       3 MB      7     2d
  watchtower   healthy     0.5%     32 MB      2%       0 B        1 MB      5     2d

📊 Monitoring
────────────────────────────────────────────────────────────────────────────────────
  grafana      healthy     2.3%    156 MB      7%       2 MB       8 MB      9     2d
  prometheus   healthy     4.1%    890 MB     22%      45 MB     156 MB     11     2d

📦 Docker System
──────────────────────────────────────────────────
  Containers: 10 (2.1GB)
  Images: 45 (8.5GB)
  Volumes: 12 (500MB)

Press Ctrl+C to exit | Refreshing every 3s
```

**Features:**
- **Categorized view** — Services grouped by type (App, Data, Infrastructure, Monitoring)
- **Color coding** — CPU and memory usage colors indicate severity (green/yellow/red)
- **Trend indicators** — Arrows show CPU usage trending up/down vs previous sample
- **Health indicators** — ● green for healthy, red for unhealthy, yellow for unknown
- **Auto-refresh** — Live updates every 3 seconds (configurable)
- **JSON export** — Scriptable output for automation and monitoring

**Keyboard Shortcuts:**
- `Ctrl+C` — Exit watch mode

**Exit Codes:**
- `0` — Normal exit
- `1` — Rate limit exceeded

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

### `mc check` 🆕
Pre-flight dependency validation — check that command dependencies are satisfied before execution with actionable remediation steps.

```bash
# Check dependencies for a specific command
mc check status                # Check if 'mc status' can run
mc check revive                # Check if 'mc revive' can run
mc check deploy                # Check if 'mc deploy' can run

# Check all common dependencies
mc check --all                 # Check Docker, Compose, infrastructure, config, disk, memory

# Check specific dependencies
mc check -d docker             # Check Docker only
mc check -d docker compose     # Check Docker and Docker Compose
mc check -d infra config       # Check infrastructure directory and config

# Quiet mode (exit code only, useful for scripts)
mc check status --quiet        # Exit 0 if ready, non-zero if not
```

**Dependency Types:**
| Type | Description | Severity |
|------|-------------|----------|
| `docker` | Docker daemon availability | Critical |
| `compose` | Docker Compose availability | Critical |
| `infra` | Infrastructure directory location | Critical |
| `config` | Configuration file security | Warning |
| `disk` | Available disk space | Warning |
| `memory` | Available system memory | Warning |

**Example Output:**
```
🔍 Checking dependencies for 'revive'

✅ Docker is available and running
✅ Docker Compose is available
✅ Infrastructure directory found: /opt/masterclaw-infrastructure
⚠️  Configuration has security issues
   → Run: mc config-fix to fix permissions
   → Review: mc config-audit for details

Results: 3 passed, 1 failed

⚠️  Critical dependencies satisfied - can proceed with caution
```

**Programmatic Usage:**
```bash
# In scripts: check before running
if mc check deploy --quiet; then
    mc deploy rolling
else
    echo "Cannot deploy - fix dependencies first"
    exit 1
fi
```

**Exit Codes:**
- `0` — All critical dependencies satisfied, can proceed
- `9` — Critical dependencies missing, cannot proceed

### `mc circuits` 🆕
View and manage circuit breaker status for service resilience

```bash
mc circuits                    # Show circuit breaker status for all services
mc circuits --json             # Output as JSON for monitoring integration
mc circuits --reset core       # Reset circuit for specific service
mc circuits --reset-all        # Reset all circuits to CLOSED state
```

**Circuit Breaker States:**
| State | Description | Visual |
|-------|-------------|--------|
| `CLOSED` | Normal operation - requests pass through | ✅ |
| `OPEN` | Failure threshold exceeded - fast fail | 🔴 |
| `HALF_OPEN` | Testing recovery with limited traffic | 🟡 |

**Example Output:**
```
⚡ MasterClaw Circuit Breaker Status

✅ AI Core
   State: CLOSED ●
   Calls: 245 total (243 success, 2 failed)
   Error Rate: 0.8%

🔴 Backend API
   State: OPEN ●
   Calls: 15 total (10 success, 5 failed)
   Error Rate: 33.3%
   Recent Failures: 5 in last 60s
```

**Benefits:**
- **Fail-fast protection** — Prevents cascading failures when services are unstable
- **Automatic recovery** — Tests service recovery without overwhelming it
- **Per-service isolation** — Each service has independent circuit protection
- **Reduced load** — Stops hammering failing services with repeated requests

**When to reset circuits:**
- After fixing a service that was causing failures
- If a circuit opened due to a transient network issue
- During maintenance when you want to force retry behavior

### `mc status`
Check health of all MasterClaw services
```bash
mc status
mc status --watch  # Continuous monitoring
```

### `mc restart` 🆕
Restart MasterClaw services with health checking
```bash
mc restart                      # Restart all services
mc restart core                 # Restart specific service
mc restart --force              # Force restart (immediate shutdown)
mc restart --wait               # Wait for health checks (default: true)
mc restart --timeout 120000     # Health check timeout in ms
mc restart history              # Show restart history
```

**Features:**
- **Graceful restart** — Stops and starts services gracefully (default)
- **Force restart** — Kill immediately without graceful shutdown (`--force`)
- **Health verification** — Waits for services to become healthy after restart (`--wait`)
- **Configurable timeout** — Adjust health check timeout (`--timeout`)
- **Per-service restart** — Restart individual services or all at once

**Example Output:**
```
🔄 Restarting 4 service(s)...

  → Restarting core... ✅ (5234ms)
  → Restarting backend... ✅ (3121ms)
  → Restarting gateway... ✅ (1892ms)
  → Restarting interface... ✅ (2156ms)

Results: 4 restarted, 0 failed, 12403ms

✅ All services restarted successfully
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

### `mc analyze` 🆕
Intelligent log analysis and anomaly detection — automatically analyze logs for errors, patterns, and potential issues

```bash
# Analyze logs for all services (default: last hour)
mc analyze

# Analyze specific service
mc analyze --service core         # Analyze core service logs
mc analyze --service backend      # Analyze backend logs
mc analyze --service gateway      # Analyze gateway logs

# Analyze different time windows
mc analyze --time 1h              # Last hour (default)
mc analyze --time 6h              # Last 6 hours
mc analyze --time 24h             # Last 24 hours
mc analyze --time 7d              # Last 7 days

# Focus on specific issue types
mc analyze --focus critical       # Focus on critical issues
mc analyze --focus security       # Focus on security events
mc analyze --focus performance    # Focus on performance issues

# Output options
mc analyze --verbose              # Show detailed error patterns
mc analyze --json                 # Output as JSON for automation
```

**Analysis Features:**
- **Error Pattern Detection** — Identifies runtime errors, network issues, resource exhaustion, SSL problems
- **Anomaly Detection** — Detects error spikes, repeated errors, service imbalances
- **Security Analysis** — Flags authentication failures and suspicious access patterns
- **Performance Insights** — Identifies timeouts and slow requests
- **Actionable Recommendations** — Suggests specific commands to fix issues

**Detected Categories:**
| Category | Description | Severity |
|----------|-------------|----------|
| `runtime` | Application errors and exceptions | error |
| `network` | Connection issues, refused connections | error |
| `resource` | Memory/disk exhaustion | critical |
| `security` | Auth failures, access violations | warning |
| `ssl` | Certificate errors, TLS issues | critical |
| `database` | SQLite/ChromaDB errors | error |
| `health` | Health check failures | error |
| `performance` | Timeouts, slow requests | warning |
| `rate_limiting` | Rate limit violations | warning |

**Example Output:**
```
🔍 MasterClaw Log Analysis

Analyzed 1,247 log lines in 234ms

Error Summary:
  runtime         12
  network          3
  ssl              1

Top Error Patterns:
  ❌ [database] Database connection pool exhausted
     Count: 8 | Service: backend
  ⚠️ [network] Connection refused to mc-core:8000
     Count: 3 | Service: backend

Detected Anomalies:
  🔴 Error rate is 3.2x above normal

Insights & Recommendations:
  🔴 Resource Exhaustion Detected
     Check disk space with `mc doctor --category system`
     → Run: mc doctor --category system

  ⚠️ Network Connectivity Issues
     Check service dependencies with `mc deps-check`
     → Run: mc deps-check

Overall Health:
  🔴 CRITICAL - Immediate attention required
```

**Exit Codes:**
- `0` — No critical issues detected
- `1` — Critical issues detected (useful for CI/CD alerting)

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
- **Resource limits** — fork bomb protection (max 128 processes), memory limits (1GB max), file descriptor limits
- Rate limiting — 10 executions per minute (high-security command)
- Audit logging — all executions logged for security review
- Timeout protection — commands timeout after 5 minutes (30 min for interactive)

**Resource Limits (Security Hardening):**
The `mc exec` command automatically applies resource limits to prevent attacks:

| Limit | Value | Purpose |
|-------|-------|---------|
| `nproc` | 128 soft / 256 hard | **Fork bomb protection** — prevents process exhaustion |
| `nofile` | 1024 soft / 2048 hard | File descriptor limits — prevents resource exhaustion |
| `memory` | 1GB hard limit | Memory exhaustion protection |
| `memory-swap` | 1GB hard limit | Swap exhaustion protection |
| `stack` | 8MB soft / 16MB hard | Stack overflow protection |

To disable resource limits (emergency override):
```bash
MC_EXEC_NO_RESOURCE_LIMITS=1 mc exec mc-core "heavy-command"
```

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

### `mc backup` 🆕
Comprehensive backup management — create, list, analyze, and clean up backups

```bash
# Create backups
mc backup                              # Create a new backup
mc backup --retention-days 14          # Override retention period
mc backup --quiet                      # Minimal output

# List and view backups
mc backup list                         # List all backups (last 10)
mc backup list --limit 20              # Show last 20 backups
mc backup list --json                  # Output as JSON

# Backup statistics and trends
mc backup stats                        # Show backup statistics
mc backup stats --json                 # Output as JSON

# Clean up old backups
mc backup cleanup                      # Remove backups past retention
mc backup cleanup --dry-run            # Preview what would be deleted
mc backup cleanup --force              # Skip confirmation

# Export backup metadata
mc backup export                       # Export to ./mc-backups.json
mc backup export -o ./backups.json     # Custom output file

# Cloud backup commands ☁️ (NEW!)
mc backup cloud setup                  # Interactive setup wizard
mc backup cloud upload                 # Upload latest backup to cloud
mc backup cloud upload /path/to/file   # Upload specific backup
mc backup cloud download <name>        # Download from cloud
mc backup cloud download <name> -o ./  # Download to specific directory
mc backup cloud list                   # List all cloud backups
mc backup cloud sync                   # Sync all local backups to cloud
mc backup cloud test                   # Test cloud connection
mc backup cloud status                 # Show cloud backup status
mc backup cloud cleanup                # Remove old cloud backups
```

**Cloud Backup Features:**
- **Multi-provider support** — AWS S3, Google Cloud Storage, Azure Blob Storage
- **Interactive setup** — Wizard guides you through configuration
- **Server-side encryption** — All backups encrypted at rest (enabled by default)
- **Automatic cleanup** — Old cloud backups removed based on retention policy
- **Integrity verification** — Backups verified after upload
- **Audit logging** — All operations logged for security

**Cloud Backup Setup:**
```bash
# Run the interactive setup wizard
mc backup cloud setup

# Follow the prompts to configure:
# 1. Select provider (AWS S3, GCS, Azure)
# 2. Enter bucket/container name
# 3. Enter cloud region
# 4. Configure credentials
# 5. Test connection

# After setup, upload your first backup
mc backup cloud upload
```

**Configuration (in `.env`):**
```bash
CLOUD_BACKUP_PROVIDER=s3                    # s3, gcs, or azure
CLOUD_BACKUP_BUCKET=masterclaw-backups      # Bucket name
CLOUD_BACKUP_PREFIX=masterclaw              # Path prefix
CLOUD_BACKUP_REGION=us-east-1               # Cloud region
CLOUD_BACKUP_ENCRYPTION=true                # Server-side encryption
CLOUD_BACKUP_RETENTION_DAYS=30              # Cloud retention

# Provider-specific credentials:
AWS_ACCESS_KEY_ID=...                       # For S3
AWS_SECRET_ACCESS_KEY=...
GOOGLE_APPLICATION_CREDENTIALS=...          # For GCS
AZURE_STORAGE_ACCOUNT=...                   # For Azure
AZURE_STORAGE_KEY=...
```

**Features:**
- **Create on demand** — Trigger backups manually from CLI
- **List with details** — Size, age, and creation date for each backup
- **Statistics** — Total count, size trends, backup frequency analysis
- **Smart cleanup** — Remove old backups with dry-run preview
- **Export metadata** — JSON export for external tracking

**Statistics include:**
- Total backup count and cumulative size
- Average backup size
- Backup frequency (average days between backups)
- Size growth trend (comparing recent vs older backups)
- Retention policy status

**Example Output:**
```
🐾 MasterClaw Backups

● masterclaw_backup_20250218_001500.tar.gz
   Size: 450MB  |  Created: 2/18/2026, 12:15:00 AM  |  2 hours ago
○ masterclaw_backup_20250217_120000.tar.gz
   Size: 448MB  |  Created: 2/17/2026, 12:00:00 PM  |  14 hours ago
○ masterclaw_backup_20250216_030000.tar.gz
   Size: 445MB  |  Created: 2/16/2026, 3:00:00 AM  |  2 days ago

Total: 3 backups
Run 'mc restore' to restore from a backup
```

**Statistics Example:**
```
🐾 Backup Statistics

Overview:
  Total backups: 12
  Total size: 5.2 GB
  Average size: 450MB

Timeline:
  Oldest backup: 2/6/2026
  Newest backup: 2/18/2026
  Backup frequency: ~1.0 days

Trends:
  Size trend: 📈 +2.3%

Retention:
  Policy: 7 days
  Backups past retention: 5
  Run 'mc backup cleanup' to remove old backups
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

### `mc migrate` 🆕
Database migration management — run pending migrations, check status, and create new migration files.

```bash
# Run pending migrations
mc migrate                     # Run all pending migrations
mc migrate run                 # Same as above
mc migrate --dry-run           # Preview migrations without applying
mc migrate --continue-on-error # Continue even if a migration fails

# Check migration status
mc migrate status              # Show current version and pending migrations

# Create new migrations
mc migrate create "add users table"     # Create a new migration file
```

**Features:**
- **Version tracking** — Schema versions tracked in `schema_migrations` table
- **Dry-run mode** — Preview migrations before applying
- **Transactional safety** — Each migration runs in a transaction
- **Audit logging** — All migrations logged for compliance
- **Rate limiting** — Protected against accidental repeated runs

**Migration File Format:**
Migration files are stored in `services/backend/migrations/` with the format:
```
001_initial_schema.sql
002_add_sessions_table.sql
003_add_memory_index.sql
```

**Example Migration File:**
```sql
-- Migration 4: Add users table
-- Created: 2025-02-18T15:00:00Z

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);
```

**Status Output:**
```
🗄️  Migration Status
   Database: /opt/masterclaw/data/backend/mc.db
   Migrations directory: services/backend/migrations/

   Current schema version: 3

   Migration Files:

   001  initial schema                 ✓ Applied
   002  add sessions table             ✓ Applied
   003  add memory index               ✓ Applied
   004  add users table                ○ Pending

⚠️  1 migration(s) pending
   Run: mc migrate
```

**Exit Codes:**
- `0` — All migrations applied successfully / database up to date
- `1` — Migration failed or database not found

### `mc secrets` 🔐
Secure secrets management for API keys, tokens, and credentials across the MasterClaw ecosystem.

```bash
# Check secrets configuration
mc secrets check                         # Validate all required secrets are set

# List and view secrets (masked by default)
mc secrets list                          # List all configured secrets
mc secrets list --show-values            # Show actual values (use with caution!)

# Set and get secrets
mc secrets set GATEWAY_TOKEN <token>     # Set a secret value
mc secrets set OPENAI_API_KEY <key>      # Set API key with validation
mc secrets set ANTHROPIC_API_KEY <key>   # Set Anthropic key
mc secrets get GATEWAY_TOKEN             # Get a secret (masked display)

# Rotate and manage secrets
mc secrets rotate GATEWAY_TOKEN          # Auto-generate new gateway token
mc secrets rotate OPENAI_API_KEY --value <new-key>  # Rotate with custom value
mc secrets delete OPENAI_API_KEY         # Delete a secret

# Validate secrets against services
mc secrets validate GATEWAY_TOKEN        # Test token against gateway
mc secrets validate OPENAI_API_KEY       # Verify API key with OpenAI
mc secrets validate ANTHROPIC_API_KEY    # Verify API key with Anthropic

# Sync secrets between CLI and .env
mc secrets sync                          # Sync CLI secrets to .env file
mc secrets sync --direction from-env     # Sync .env to CLI storage
mc secrets sync --dry-run                # Preview changes without applying

# Export secrets (masked)
mc secrets export                        # Export as JSON (masked values)
mc secrets export --format env           # Export as .env format
mc secrets export -o secrets-backup.json # Export to file
```

**Security Features:**
- **Secure storage** — Secrets stored with 0o600 file permissions
- **Masked display** — Values are masked by default (show first/last 4 chars)
- **Format validation** — Validates API key formats before saving
- **Audit logging** — All secret operations logged (without values)
- **No plain text logging** — Secrets are never logged in plain text

**Required Secrets:**
| Secret | Required | Description |
|--------|----------|-------------|
| `GATEWAY_TOKEN` | ✅ | OpenClaw Gateway authentication token |
| `OPENAI_API_KEY` | ❌ | OpenAI API key for GPT models |
| `ANTHROPIC_API_KEY` | ❌ | Anthropic API key for Claude models |

**Workflow Example:**
```bash
# 1. Check current secrets status
mc secrets check

# 2. Set required secrets
mc secrets set GATEWAY_TOKEN mc_my_secure_token_123
mc secrets set OPENAI_API_KEY sk-...

# 3. Validate secrets work
mc secrets validate GATEWAY_TOKEN
mc secrets validate OPENAI_API_KEY

# 4. Sync to .env for Docker deployment
mc secrets sync

# 5. Rotate a compromised token
mc secrets rotate GATEWAY_TOKEN
mc secrets sync  # Don't forget to sync!
```

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

### `mc context sync` 🆕
Synchronize rex-deus context files (preferences, projects, goals, knowledge, people) into the AI's memory system. This creates a live bridge between static documentation and dynamic AI context awareness.

```bash
# Sync all context files
mc context sync                          # Sync all rex-deus context to AI memory

# Sync specific sections only
mc context sync --sections preferences,projects    # Sync only preferences and projects
mc context sync --sections goals                   # Sync only goals

# Preview changes without syncing
mc context sync --dry-run                # Show what would be synced without making changes

# Force re-sync (overwrite existing)
mc context sync --force                  # Re-sync all content, even if unchanged

# Add custom tags
mc context sync --tag personal           # Add "personal" tag to all synced memories
```

**Sync Sections:**
| Section | Memory Category | Content |
|---------|-----------------|---------|
| `preferences` | `user_preferences` | Communication style, tech stack, values |
| `projects` | `active_projects` | Current projects, progress, priorities |
| `goals` | `user_goals` | Short/medium/long-term goals |
| `knowledge` | `domain_knowledge` | Rex's expertise areas |
| `people` | `relationships` | Contacts and relationships |

**Features:**
- **Smart deduplication** — Content hashing skips unchanged files
- **Metadata enrichment** — Memories tagged with source, priority, category
- **Incremental sync** — Only syncs modified content
- **Traceable** — All memories link back to source file
- **Privacy-first** — Local processing, no external calls

**Workflow Example:**
```bash
# 1. Initial sync of all context
mc context sync

# 2. Make changes to rex-deus context files
vim ~/rex-deus/context/goals.md

# 3. Sync only the changes
mc context sync --sections goals

# 4. Verify memories are searchable
mc memory search "short-term goals"
```

**Integration with AI:**
Once synced, the AI can reference this context in conversations:
- "What are Rex's current projects?" → Queries active_projects
- "What's his tech stack preference?" → Queries user_preferences
- "Tell me about his goals" → Queries user_goals

**Requirements:**
- rex-deus repository must be accessible
- MasterClaw Core must be running with memory support
- API connection to Core (configured via `mc config`)

### `mc contacts` 🆕
Manage personal and professional contacts in rex-deus. Store contact information securely with structured data, search capabilities, and notification integration.

```bash
# List contacts
mc contacts list                           # Show all contacts
mc contacts list --category professional   # Filter by category
mc contacts list --tag urgent              # Filter by tag
mc contacts list --search "John"           # Search by name
mc contacts list --json                    # Output as JSON

# View contact details
mc contacts show "John Doe"                # Show full contact details
mc contacts show "John Doe" --reveal       # Show unmasked contact values

# Manage contacts
mc contacts add                            # Interactive add contact
mc contacts add --name "Jane" --category technical --role "DevOps"
mc contacts remove "John Doe"              # Remove a contact
mc contacts remove "John Doe" --force      # Skip confirmation

# Export contacts
mc contacts export                         # Export to contacts-backup.json
mc contacts export --format csv            # Export as CSV
mc contacts export --format vcard          # Export as vCard
mc contacts export -o my-contacts.json     # Custom output file

# Statistics
mc contacts stats                          # Show contact statistics
```

**Contact Categories:**
| Category | Icon | Use For |
|----------|------|---------|
| `personal` | 👤 | Friends, family |
| `professional` | 💼 | Colleagues, business contacts |
| `technical` | 🔧 | Technical support, developers |
| `services` | 🏢 | Hosting, domains, vendors |
| `emergency` | 🚨 | Critical contacts |

**Contact Methods Supported:**
- Email, Phone, WhatsApp, Signal, Telegram
- Discord, Slack, Twitter, GitHub
- Website, Other

**Security:**
- Contacts stored in rex-deus (private repository)
- Sensitive values masked by default (e.g., `+1*****5678` for phone)
- Secure file permissions (0o600)
- Audit logging for all modifications
- Exportable to JSON/CSV/vCard

**Integration with Notifications:**
```bash
# Get notification info for a contact
mc contacts notify-info "John Doe"         # Returns best contact method

# Used internally by:
mc notify send --contact "John Doe"        # Send notification to contact
```

**Example Workflow:**
```bash
# Add your hosting provider contact
mc contacts add
# > Name: Hetzner Support
# > Category: services
# > Role: Technical Support
# > Organization: Hetzner Online
# > Contact methods: email (support@hetzner.com), phone (+49...)
# > Tags: hosting, critical

# Quickly find during outage
mc contacts list --category services --search "Hetzner"
mc contacts show "Hetzner Support" --reveal
```

### `mc api` 🆕
API documentation management — view, export, and interact with MasterClaw Core API documentation

```bash
# Check API status and documentation URLs
mc api status

# Open API documentation in browser
mc api docs                    # Open Swagger UI
mc api docs --redoc           # Open ReDoc instead

# Export OpenAPI specification
mc api export                 # Export as JSON (default)
mc api export --yaml          # Export as YAML
mc api export -o my-api.json  # Custom output file

# List available API endpoints
mc api endpoints              # List all endpoints
mc api endpoints --json       # Output as JSON
mc api endpoints -t chat      # Filter by tag/category

# Show API version information
mc api version
mc api version --json
```

**Example Output:**
```
🐾 MasterClaw API Status
──────────────────────────────────────────────────

API URL: http://localhost:8000
 ● Status: Accessible
 ● Version: 1.0.0

📚 Documentation:
   Swagger UI: http://localhost:8000/docs
   ReDoc:      http://localhost:8000/redoc
   OpenAPI:    http://localhost:8000/openapi.json

🔌 Endpoints:
   Health:  http://localhost:8000/health
   Metrics: http://localhost:8000/metrics
```

**Features:**
- **Status Check** — Verify API accessibility and get version info
- **Documentation Access** — Open Swagger UI or ReDoc in your browser
- **Spec Export** — Export OpenAPI spec for client generation or documentation
- **Endpoint Discovery** — Browse all available endpoints by category
- **JSON Output** — All commands support `--json` for scripting

**Environment Variables:**
- `CORE_URL` — API base URL (default: http://localhost:8000)

**Exit Codes:**
- `0` — API accessible, command successful
- `1` — API unreachable or error occurred

### `mc export` 🆕
Export data from MasterClaw for backup and migration (complements `mc import`)
```bash
# Export everything
mc export all                              # Export all data with auto-generated filename
mc export all ./backup.json                # Export to specific file
mc export all ./backup.json --no-mask      # Include unmasked sensitive values (caution!)
mc export all ./backup.json --include-messages  # Include full session message history

# Export specific data types
mc export config ./config.json             # Export configuration only
mc export config --no-mask                 # Export config without masking secrets
mc export memory ./memories.json           # Export memories
mc export memory ./memories.json --limit 500    # Limit number of memories
mc export sessions ./sessions.json         # Export sessions
mc export sessions ./sessions.json --include-messages  # Include full message history
```

**Export Types:**
- **all** — Complete export with config, memories, and sessions
- **config** — Configuration settings only (masked by default)
- **memory** — Memory/vector data only
- **sessions** — Session data (with optional message history)

**Options:**
- `--no-mask` — Do not mask sensitive values like tokens and API keys (security risk)
- `--limit <n>` — Maximum items to export (default: 1000)
- `--include-messages` — Include full chat history for each session
- `--pretty` — Pretty-print JSON output (default: true)

**Security:**
- Sensitive values (tokens, API keys, passwords) are automatically masked
- Use `--no-mask` only when necessary and store exports securely
- Exported files should be treated as sensitive data

**Examples:**
```bash
# Full backup with timestamp
mc export all
# Creates: masterclaw-export-2025-02-18T02-50-00-000Z.json

# Export config for migration (masked)
mc export config ./config-backup.json

# Export memories with limit
mc export memory ./memories.json --limit 100

# Pipe to another command
mc export config | jq '.gateway.url'
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

### `mc changelog` 🆕
View changelogs from across the MasterClaw ecosystem — see what's new, what changed, and track version history without leaving the terminal.

```bash
# View changelogs
mc changelog                     # Show summary of all component changelogs
mc changelog core                # Show full changelog for core
mc changelog tools               # Show full changelog for tools
mc changelog infrastructure      # Show full changelog for infrastructure
mc changelog all                 # Same as 'mc changelog' (default)

# Filter and search
mc changelog --limit 10          # Show last 10 entries
mc changelog --version 1.0.0     # Show specific version only
mc changelog --since 2024-01-01  # Show entries since date
mc changelog --json              # Output as JSON for scripting

# View latest changes
mc changelog latest              # Show latest changes from all components
mc changelog latest -n 5         # Show 5 entries per component

# Search changelogs
mc changelog search "security"   # Search for "security" across all changelogs
mc changelog search "API"        # Search for API-related changes
```

**Features:**
- **Multi-component** — View changelogs from core, tools, and infrastructure
- **Summary view** — Quick overview of recent changes across the ecosystem
- **Version filtering** — Find changes for specific versions
- **Full-text search** — Search for terms across all changelogs
- **Colorized output** — Syntax highlighting for added/fixed/changed sections
- **JSON output** — Scriptable output for automation

**Example Output:**
```
🐾 MasterClaw Changelog Summary
==============================

📦 Core
  1.2.0        (2024-02-15)
  1.1.0        (2024-02-01)
  1.0.0        (2024-01-15)

📦 Tools
  0.31.0       (2024-02-18)  ← 5 added | 2 fixed
  0.30.0       (2024-02-16)
  0.29.0       (2024-02-14)

📦 Infrastructure
  Unreleased   (2024-02-18)  ← 3 added | 1 fixed
  1.1.0        (2024-02-10)
```

**Search Example:**
```bash
$ mc changelog search "security"

🐾 Changelog Search: "security"
================================

Found 3 results:

[core] 1.2.0
  SECURITY: Fixed authentication bypass in webhook handler

[tools] 0.31.0
  Added security hardening to mc exec command

[infrastructure] 1.1.0
  SECURITY: Updated Traefik to patch CVE-2024-xxx
```

**Workflow:**
```bash
# After updating, see what's new
mc update && mc changelog latest

# Before deploying to production, check for breaking changes
mc changelog search "BREAKING"

# Get JSON output for CI/CD notifications
mc changelog latest --json | jq '.core[0].version'
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

**Performance:**
Uses the bulk deletion API (`/v1/sessions/bulk-delete`) for efficient cleanup:
- Single API call instead of N individual deletes
- Atomic operation with progress reporting
- Dry-run preview without making changes

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

### `mc size` 🆕
Analyze disk usage of MasterClaw components — see exactly what's consuming storage across data directories, Docker volumes, containers, and images.

```bash
# Show complete disk usage analysis
mc size

# Show only data directory sizes
mc size --data-only

# Show only Docker resource sizes
mc size --docker-only

# Show detailed breakdown of subdirectories
mc size --breakdown

# Only show items larger than 100MB
mc size --threshold 100MB

# Output as JSON for scripting
mc size --json
```

**Analysis Categories:**
| Category | Description |
|----------|-------------|
| **Data Directories** | Backups, logs, data, memory, sessions |
| **Docker Volumes** | mc-data, mc-backend-data, mc-chroma-data, etc. |
| **Docker Containers** | Running and stopped container sizes |
| **Docker Images** | MasterClaw-related images and tags |

**Example Output:**
```
🐾 MasterClaw Disk Usage Analysis

Infrastructure: /opt/masterclaw-infrastructure

📁 Data Directories
──────────────────────────────────────────────────
  backups      2.45 GB
  logs        512.34 MB
  data         1.23 GB
  memory     256.00 MB
  sessions   128.00 MB
  ────────────────────────────────────────────────
  Total        4.56 GB

💾 Docker Volumes
──────────────────────────────────────────────────
  mc-chroma-data           1.20 GB
  mc-backend-data        450.00 MB
  mc-gateway-data         32.00 MB
  mc-data                 16.00 MB
  ────────────────────────────────────────────────
  Total                    1.70 GB

🐳 Docker Containers
──────────────────────────────────────────────────
  ● mc-chroma         1.20 GB  (virtual 2.45 GB)
  ● mc-backend      450.00 MB  (virtual 1.12 GB)
  ● mc-core         256.00 MB  (virtual 890.00 MB)
  ● mc-gateway       32.00 MB  (virtual 245.00 MB)
  ● mc-traefik       16.00 MB  (virtual 78.00 MB)
  ────────────────────────────────────────────────
  Total               1.94 GB

📦 Docker Images
──────────────────────────────────────────────────
  masterclaw/core:latest     890.00 MB
  masterclaw/backend:latest  670.00 MB
  chromadb/chroma:latest     1.25 GB
  traefik:v3.0               62.00 MB
  ────────────────────────────────────────────────
  Total                      2.87 GB

══════════════════════════════════════════════════
  Grand Total:           11.07 GB
══════════════════════════════════════════════════

💡 Tips:
  • Large backup directory - consider running: mc backup cleanup
  • Run with --json flag for machine-readable output
  • Run with --breakdown for detailed subdirectory analysis
```

**Use Cases:**
- **Storage planning** — Understand your total footprint before scaling
- **Cleanup decisions** — Identify what's consuming the most space
- **Monitoring** — Track growth over time with `--json` output
- **Troubleshooting** — Find unexpectedly large directories

**Relationship to Other Commands:**
- Use `mc size` to **analyze** what's consuming space
- Use `mc prune` to **clean up** Docker resources
- Use `mc cleanup` to **remove** old sessions
- Use `mc backup cleanup` to **remove** old backups

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
- `lib/backup.js` - **NEW: Comprehensive backup management (create, list, stats, cleanup)**
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
- `lib/deps-validator.js` - **NEW: Command dependency validation with actionable remediation**

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
| `secrets.test.js` | **Secrets management** — Secure API key and token handling |
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
