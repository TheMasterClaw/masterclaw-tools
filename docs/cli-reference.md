# MasterClaw CLI Documentation

Complete reference guide for the `mc` command-line interface.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Global Options](#global-options)
- [Commands](#commands)
  - [Status & Health](#status--health)
  - [Maintenance](#maintenance)
  - [Development](#development)
  - [Configuration](#configuration)
  - [Utilities](#utilities)
- [Environment Variables](#environment-variables)
- [Configuration File](#configuration-file)
- [Exit Codes](#exit-codes)
- [Examples](#examples)

## Installation

```bash
# Install globally
npm install -g masterclaw-tools

# Or use npx
npx masterclaw-tools
```

## Quick Start

```bash
# Check system status
mc status

# View help
mc --help

# Get command-specific help
mc health --help
```

## Global Options

| Option | Description |
|--------|-------------|
| `-v, --verbose` | Enable verbose output |
| `-i, --infra-dir <path>` | Path to infrastructure directory |
| `--version` | Show version number |
| `-h, --help` | Show help |

## Commands

### Status & Health

#### `mc status`
Check health of all MasterClaw services.

```bash
mc status
mc status --watch  # Continuous monitoring
```

#### `mc health`
Detailed health monitoring and diagnostics.

```bash
mc health                          # Show current health status
mc health --watch                  # Continuous monitoring
mc health --history 24h            # Show 24-hour health history
mc health --json                   # JSON output for scripting
mc health --export report.json     # Export health report
```

**Subcommands:**
- `mc health history` - Show health check history
- `mc health trends` - Show health trends and analytics

#### `mc doctor`
Run diagnostics and provide recommendations.

```bash
mc doctor              # Full diagnostics
mc doctor --quick      # Quick health check only
mc doctor --json       # JSON output
mc doctor --export report.md  # Export markdown report
```

### Maintenance

#### `mc api-maintenance`
Remote maintenance operations via Core API.

```bash
mc api-maintenance status                    # Check maintenance status
mc api-maintenance run --task all            # Run all maintenance tasks
mc api-maintenance run --task health_history_cleanup --dry-run  # Preview
mc api-maintenance tasks                     # List available tasks
```

**Available Tasks:**
- `health_history_cleanup` - Remove old health history records
- `cache_clear` - Clear response cache
- `session_cleanup` - Remove old sessions
- `memory_optimize` - Optimize memory store
- `all` - Run all maintenance tasks

#### `mc backup`
Backup operations.

```bash
mc backup create              # Create a new backup
mc backup list                # List available backups
mc backup verify              # Verify backup integrity
```

#### `mc restore`
Restore from backup.

```bash
mc restore --backup <id>      # Restore from specific backup
mc restore --latest           # Restore from latest backup
```

### Development

#### `mc logs`
View and stream logs.

```bash
mc logs --service core        # View Core API logs
mc logs --service gateway     # View Gateway logs
mc logs --follow              # Stream logs in real-time
mc logs --since 1h            # Logs from last hour
```

#### `mc workflow`
Workflow automation commands.

```bash
mc workflow list                     # List available workflows
mc workflow run <name>               # Run a workflow
mc workflow validate <name>          # Validate workflow syntax
mc workflow validate-all             # Validate all workflows
```

#### `mc terraform`
Terraform infrastructure management.

```bash
mc terraform plan -e dev             # Plan changes for dev environment
mc terraform apply -e dev            # Apply changes to dev
mc terraform destroy -e dev          # Destroy dev infrastructure
```

### Configuration

#### `mc config`
Manage CLI configuration.

```bash
mc config get <key>           # Get configuration value
mc config set <key> <value>   # Set configuration value
mc config list                # List all configuration
```

**Common Configuration Keys:**
- `infraDir` - Path to infrastructure directory
- `core.url` - Core API URL
- `gateway.url` - Gateway URL

#### `mc whoami`
Show current user context and system information.

```bash
mc whoami              # Full context
mc whoami --short      # Brief summary
mc whoami --json       # JSON output
mc whoami --secrets    # Include secret configuration
```

### Utilities

#### `mc secrets`
Manage secrets and environment variables.

```bash
mc secrets list               # List all secrets
mc secrets add <key> <value>  # Add a secret
mc secrets remove <key>       # Remove a secret
```

#### `mc ssl`
SSL certificate management.

```bash
mc ssl check                  # Check SSL certificate status
mc ssl renew                  # Renew SSL certificates
mc ssl generate               # Generate new certificates
```

#### `mc scan`
Security scanning.

```bash
mc scan security              # Run security scan
mc scan vulnerabilities       # Check for vulnerabilities
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `OPENAI_API_KEY` | OpenAI API key | Optional |
| `ANTHROPIC_API_KEY` | Anthropic API key | Optional |
| `GATEWAY_TOKEN` | Gateway authentication token | Optional |
| `MASTERCLAW_INFRA` | Path to infrastructure directory | Optional |
| `NODE_ENV` | Environment (development/production) | Optional |
| `CORE_URL` | Core API URL override | Optional |

## Configuration File

Configuration is stored in `~/.masterclaw/config.json`:

```json
{
  "infraDir": "/path/to/masterclaw-infrastructure",
  "core": {
    "url": "http://localhost:8000"
  },
  "gateway": {
    "url": "http://localhost:3000"
  }
}
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Service unavailable |
| 3 | Invalid arguments |
| 4 | Authentication error |

## Examples

### Daily Operations

```bash
# Morning health check
mc doctor --quick

# Check system status
mc status

# View recent logs
mc logs --since 1h
```

### Maintenance Tasks

```bash
# Preview maintenance
mc api-maintenance run --task all --dry-run

# Run maintenance
mc api-maintenance run --task all

# Check status after maintenance
mc health
```

### Troubleshooting

```bash
# Full diagnostic
mc doctor

# Check specific service
mc health --json | jq '.services.core'

# Stream logs for errors
mc logs --follow --level ERROR
```

### Automation

```bash
# Export health report daily
mc health --export "reports/health-$(date +%Y%m%d).json"

# Run workflow
mc workflow run nightly-backup
```

## Getting Help

```bash
# General help
mc --help

# Command help
mc <command> --help

# Examples
mc <command> --examples
```

## See Also

- [masterclaw-core README](../masterclaw-core/README.md)
- [masterclaw-infrastructure README](../masterclaw-infrastructure/README.md)
- [Troubleshooting Guide](./troubleshooting.md)
