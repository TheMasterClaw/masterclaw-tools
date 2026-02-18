# Security Policy and Documentation

> **MasterClaw Security**: This document outlines security features, threat model, vulnerability reporting, and best practices for the MasterClaw CLI ecosystem.

## 🔒 Security Overview

MasterClaw implements defense-in-depth security across multiple layers:

| Layer | Protection |
|-------|------------|
| **Input Validation** | Path traversal prevention, command injection filtering, prototype pollution protection |
| **Authentication** | Secure token handling, API key validation, environment-based secrets |
| **Audit Logging** | Tamper-evident signed logs, comprehensive event tracking |
| **Encryption** | AES-256-GCM for secrets at rest, secure key derivation |
| **Rate Limiting** | Command-level throttling to prevent abuse |
| **Circuit Breakers** | Fail-fast protection against cascading failures |
| **Resource Limits** | Fork bomb protection, memory limits on container execution |

## 🛡️ Security Features

### 1. Secrets Encryption at Rest

All secrets are encrypted using AES-256-GCM with:
- **System-derived encryption key** - Unique per user/system combination
- **PBKDF2 key derivation** - 100,000 iterations
- **Transparent migration** - Plaintext secrets auto-encrypted on first load
- **Secure file permissions** - 0o600 on all secret files

```javascript
// Secrets are automatically encrypted when stored
await setSecret('API_KEY', 'sk-...');
// Value is encrypted with AES-256-GCM before writing to disk
```

### 2. Audit Log Integrity

Audit logs are cryptographically signed to detect tampering:
- **HMAC-SHA256 signatures** on every entry
- **Constant-time verification** to prevent timing attacks
- **Automatic rotation** support for signing keys
- **Verification command**: `mc audit-verify`

```bash
# Verify audit log integrity
mc audit-verify -v

# Results:
# ✅ All entries have valid signatures
# ❌ Invalid signatures detected (possible tampering)
```

### 3. Input Validation & Sanitization

All user inputs are validated and sanitized:

| Input Type | Validation |
|------------|------------|
| **File Paths** | Path traversal blocked (`../`, `..\`) |
| **Container Names** | Whitelist validation |
| **Commands** | Dangerous characters filtered, blocked command list |
| **Environment Variables** | Prototype pollution keys rejected |
| **Log Entries** | Control characters sanitized |

### 4. Container Execution Security

The `mc exec` command implements multiple safeguards:
- **Container whitelist** - Only MasterClaw containers allowed
- **Blocked commands** - `rm`, `dd`, `mkfs`, `fdisk`, etc. blocked
- **Resource limits**:
  - Max 128 processes (fork bomb protection)
  - Max 1GB memory
  - Max 2048 file descriptors
  - Max 8MB stack size
- **Timeout protection** - 5 min default, 30 min interactive
- **Audit logging** - All executions logged

### 5. Rate Limiting

Command-level rate limiting prevents abuse:

| Category | Commands | Limit | Window |
|----------|----------|-------|--------|
| 🔒 High Security | `config-audit`, `audit-verify`, `security`, `exec` | 3-10 | 1-5 min |
| 🚀 Deployment | `deploy`, `revive` | 5-10 | 1-5 min |
| 💾 Data Modification | `cleanup`, `import` | 5-10 | 1 min |
| 📖 Read-Only | `status`, `health`, `logs` | 30-60 | 1 min |

### 6. SSRF Protection

Domain validation prevents Server-Side Request Forgery:
- Private IP ranges blocked (10.x, 192.168.x, 127.x, etc.)
- Internal hostnames flagged (`localhost`, `internal`, etc.)
- Suspicious patterns detected (`.local`, `.internal`, IP-as-domain)

### 7. Circuit Breaker Pattern

Service resilience through circuit breakers:
- **Fail-fast** after 3 consecutive failures
- **Automatic recovery** testing in half-open state
- **Per-service isolation** - failures don't cascade
- **Error rate monitoring** - opens at 60% error rate

## 🐛 Reporting Vulnerabilities

We take security seriously. If you discover a vulnerability:

### Responsible Disclosure

1. **Do NOT** open a public issue
2. **Email** security concerns to: `security@masterclaw.local` (placeholder)
3. **Allow** 90 days for remediation before public disclosure
4. **Provide** detailed reproduction steps

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)
- Your contact information for coordination

### Response Process

| Timeline | Action |
|----------|--------|
| Within 48 hours | Acknowledgment of report |
| Within 7 days | Initial assessment |
| Within 90 days | Fix released or timeline communicated |
| Upon fix | Public disclosure with credit |

## 📋 Security Checklist

### For Administrators

- [ ] Run `mc config-audit` to verify file permissions
- [ ] Run `mc secrets check` to validate required secrets
- [ ] Run `mc audit-verify` to check log integrity
- [ ] Enable audit logging in production
- [ ] Set strong `GATEWAY_TOKEN` (min 16 characters)
- [ ] Review `mc security` output regularly
- [ ] Keep MasterClaw CLI updated

### For Developers

- [ ] Use `wrapCommand()` for all new commands
- [ ] Sanitize all user inputs with `sanitizeForLog()`
- [ ] Mask sensitive data with `maskSensitiveData()`
- [ ] Log security events via `logAudit()`
- [ ] Validate file paths with `containsPathTraversal()`
- [ ] Use constant-time comparison for secrets
- [ ] Add tests for security-critical paths

### For Deployment

- [ ] Validate environment with `mc validate` before deployment
- [ ] Run smoke tests with `mc smoke-test` after deployment
- [ ] Set up log rotation for audit logs
- [ ] Configure backup encryption
- [ ] Enable rate limiting in production
- [ ] Set resource limits on containers

## 🔐 Security Best Practices

### 1. Secrets Management

```bash
# Good: Use CLI secrets management
mc secrets set GATEWAY_TOKEN "$(openssl rand -hex 32)"
mc secrets rotate GATEWAY_TOKEN

# Bad: Hardcode in scripts or commit to git
echo "TOKEN=hardcoded" > .env  # ❌ Don't do this
```

### 2. Audit Log Monitoring

```bash
# Check for security violations
mc audit -t SECURITY_VIOLATION --hours 24

# Monitor for failed authentications
mc audit -t AUTH_FAILURE -s warning

# Set up automated integrity checks
mc audit-verify --hours 168  # Weekly
```

### 3. Container Access

```bash
# Good: Use resource-limited exec
mc exec mc-core "python --version"

# Bad: Bypass security with env override
MC_EXEC_NO_RESOURCE_LIMITS=1 mc exec mc-core "heavy-command"  # ⚠️ Avoid
```

### 4. Backup Security

```bash
# Verify backup integrity
mc backup-verify

# Enable cloud backup encryption
mc backup cloud setup  # Uses server-side encryption

# Test restore procedure regularly
mc restore preview <backup-name>
```

## 🎯 Threat Model

### Assets

| Asset | Value | Protection |
|-------|-------|------------|
| API Keys | High | Encryption at rest, masked display |
| Audit Logs | High | HMAC signatures, append-only |
| Container Access | High | Whitelist, resource limits |
| User Data | Medium | Access controls, validation |
| Configuration | Medium | File permissions, validation |

### Threats

| Threat | Likelihood | Impact | Mitigation |
|--------|------------|--------|------------|
| Path Traversal | Medium | High | Input validation, path sanitization |
| Command Injection | Low | Critical | Command filtering, blocked commands |
| Secret Exposure | Medium | Critical | Encryption, masking, secure permissions |
| Audit Tampering | Low | High | HMAC signatures, integrity checks |
| DoS via Resource Exhaustion | Medium | Medium | Rate limiting, resource limits |
| Prototype Pollution | Low | Medium | Key validation, safe merge |
| SSRF | Low | High | Domain validation, IP filtering |

### Trust Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│                      User (Trusted)                         │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                MasterClaw CLI (Trusted)                     │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐        │
│  │   Validate   │ │    Audit     │ │    Rate      │        │
│  │    Input     │ │     Log      │ │    Limit     │        │
│  └──────────────┘ └──────────────┘ └──────────────┘        │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│              Docker Daemon (Semi-Trusted)                   │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│              MasterClaw Services (Trusted)                  │
│         (core, backend, gateway, chroma)                    │
└─────────────────────────────────────────────────────────────┘
```

## 🔧 Security Configuration

### Environment Variables

| Variable | Purpose | Security Level |
|----------|---------|----------------|
| `MC_JSON_OUTPUT` | Structured logging | Info |
| `MC_VERBOSE` | Debug output | Warning (may leak data) |
| `MC_CORRELATION_ID` | Request tracing | Info |
| `MC_EXEC_NO_RESOURCE_LIMITS` | Disable limits | **Critical** (avoid in prod) |
| `GATEWAY_TOKEN` | Auth token | **Critical** |
| `OPENAI_API_KEY` | API access | **Critical** |

### File Permissions

```bash
# Expected permissions
~/.masterclaw/
├── config.json          # 0o600 (rw-------)
├── secrets.json         # 0o600 (rw-------)
├── .secrets.key         # 0o600 (rw-------)
└── audit/
    ├── audit.log        # 0o600 (rw-------)
    └── .audit.key       # 0o600 (rw-------)
```

## 🚨 Security Incident Response

### Detection

```bash
# Automated security scanning
mc security --hours 24

# Check for integrity violations
mc audit-verify

# Monitor circuit breaker status
mc circuits
```

### Response Playbook

1. **Isolate** - Stop affected services if necessary
2. **Preserve** - Backup audit logs before they rotate
3. **Analyze** - Review audit logs with `mc audit --verify`
4. **Remediate** - Fix the vulnerability
5. **Verify** - Run `mc security` and `mc doctor`
6. **Document** - Update this documentation if needed

## 📚 Additional Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [CIS Docker Benchmark](https://www.cisecurity.org/benchmark/docker)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [MasterClaw CLI README](./README.md)

## 📝 Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02-18 | Initial security documentation |

---

**Note**: This is a living document. Security features and practices evolve. Please contribute improvements via pull requests or report issues through the responsible disclosure process.
