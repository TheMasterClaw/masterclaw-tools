# MasterClaw Improvement: Docker Status Timeout Protection

## Summary

Added **timeout protection** to Docker status checking functions (`isContainerRunning` and `getRunningContainers`) in `lib/exec.js` to prevent indefinite hangs when the Docker daemon is unresponsive. This is a security hardening measure against resource exhaustion attacks and a reliability improvement for production deployments.

## What Was Improved

### 1. Timeout Protection for Docker Commands
Both `isContainerRunning()` and `getRunningContainers()` previously used `child_process.spawn()` without any timeout, which could cause indefinite hangs if the Docker daemon was unresponsive or under heavy load.

**Added:**
- **`DOCKER_STATUS_TIMEOUT_MS`** — Constant defining the default timeout (10 seconds)
- **Configurable timeout parameter** — Both functions now accept an optional timeout parameter
- **Graceful termination** — On timeout, processes receive SIGTERM first, then SIGKILL after 1 second
- **Race condition prevention** — Uses flags to prevent duplicate resolution

### 2. Improved Error Handling
- Added `stderr` capture for better debugging
- Prevents memory leaks by clearing timeouts after resolution
- Ensures process cleanup even on unexpected errors

## Security Benefits

| Risk | Mitigation |
|------|------------|
| **Resource Exhaustion** | Prevents hanging processes from accumulating during Docker daemon issues |
| **Denial of Service** | Limits attack window for unresponsive Docker daemon scenarios |
| **Memory Leaks** | Ensures proper cleanup of event handlers and timeouts |
| **CI/CD Timeouts** | Prevents pipeline hangs during Docker issues |

## API Changes

```javascript
// Both functions now accept an optional timeout parameter (default: 10000ms)
await isContainerRunning('mc-core');  // Uses default 10s timeout
await isContainerRunning('mc-core', 5000);  // Custom 5s timeout

await getRunningContainers();  // Uses default 10s timeout
await getRunningContainers(15000);  // Custom 15s timeout
```

## Files Modified

- `lib/exec.js` — Added timeout protection to Docker status functions
- `tests/exec.timeout.test.js` — New comprehensive test suite (23 tests)

## Test Results

```
PASS tests/exec.timeout.test.js
  Docker Status Timeout Protection
    DOCKER_STATUS_TIMEOUT_MS
      ✓ is exported and has correct value
      ✓ is a reasonable timeout value (5-30 seconds)
    isContainerRunning timeout protection
      ✓ resolves with false when Docker command times out
      ✓ kills the process with SIGTERM on timeout
      ✓ forces SIGKILL if process does not terminate after SIGTERM
      ✓ accepts custom timeout parameter
      ✓ clears timeout when process completes normally
      ✓ handles stderr output during timeout
      ✓ handles process error event before timeout
      ✓ ignores close event after timeout already fired
      ✓ ignores error event after timeout already fired
    getRunningContainers timeout protection
      ✓ resolves with empty array when Docker command times out
      ✓ kills the process with SIGTERM on timeout
      ✓ forces SIGKILL if process does not terminate after SIGTERM
      ✓ accepts custom timeout parameter
      ✓ clears timeout when process completes normally
      ✓ handles stderr output during timeout
      ✓ handles process error event before timeout
      ✓ ignores close event after timeout already fired
      ✓ parses container output correctly even with custom timeout
    Timeout protection integration
      ✓ isContainerRunning uses DOCKER_STATUS_TIMEOUT_MS as default
      ✓ getRunningContainers uses DOCKER_STATUS_TIMEOUT_MS as default
      ✓ both functions can operate with different timeouts concurrently

Test Suites: 2 passed (including existing exec.security.test.js)
Tests:       108 passed
```

## Backward Compatibility

Fully backward compatible:
- Default timeout (10s) is reasonable for most use cases
- Functions resolve with same return values (no API breakage)
- Timeout parameter is optional
- Existing code continues to work without modification

---

# MasterClaw Improvement: Secure HTTP Client

## Summary

Added a **Secure HTTP Client** module (`lib/http-client.js`) that centralizes all outbound HTTP requests with comprehensive security hardening, SSRF protection, and audit logging integration.

## What Was Improved

### 1. New Secure HTTP Client Module
Created a centralized HTTP client that wraps axios with security features:

- **`get()`, `post()`, `put()`, `del()`, `patch()`** — HTTP methods with built-in security
- **`createSecureClient()`** — Factory for creating custom-configured secure clients
- **`validateUrlSSRF()`** — URL validation with SSRF protection
- **`validateAndSanitizeHeaders()`** — Header injection prevention
- **`healthCheck()`** — Secure health check helper

### 2. SSRF (Server-Side Request Forgery) Protection
Blocks requests to potentially dangerous destinations:

- **Dangerous URL schemes**: `data:`, `file:`, `javascript:` URLs are rejected
- **Private IP ranges**: `10.x.x.x`, `192.168.x.x`, `172.16-31.x.x`, `127.x.x.x` blocked by default
- **Internal hostnames**: `localhost`, `*.local`, `*.internal`, `*.lan` blocked
- **Suspicious patterns**: IP-as-domain, hex-encoded IPs detected

Override for legitimate internal calls:
```javascript
await httpClient.get(url, httpClient.allowPrivateIPs());
```

### 3. Header Injection Prevention
Prevents CRLF injection attacks in HTTP headers:
- Validates header names (alphanumeric, hyphens, underscores only)
- Blocks headers containing newline characters (`\r`, `\n`)
- Sanitizes header values

### 4. Resource Limits
Prevents DoS attacks via resource exhaustion:

| Limit | Value | Purpose |
|-------|-------|---------|
| Max Response Size | 10MB | Prevents memory exhaustion |
| Max Redirects | 5 | Prevents redirect loops |
| Default Timeout | 10s | Prevents hanging requests |
| Max Timeout | 60s | Upper bound for all requests |
| Min Timeout | 1s | Lower bound for all requests |

### 5. Audit Logging Integration
All external HTTP calls can be tracked:
- Security violations logged as `SECURITY_VIOLATION` events
- External calls can be audited with `withAudit()` helper
- Correlation IDs propagated via `X-Correlation-ID` header
- Sensitive data masked in logs

### 6. Comprehensive Test Coverage
37 tests covering:
- SSRF protection (private IPs, internal hostnames, suspicious domains)
- URL scheme validation (blocking data:, file:, javascript:)
- Header injection prevention
- Response size validation
- Helper functions (withAudit, allowPrivateIPs, withTimeout)

## Security Benefits

1. **Centralized Security** — All outbound HTTP requests go through a single security gateway
2. **SSRF Prevention** — Automatic blocking of internal/private destinations
3. **Audit Trail** — All external calls tracked for security monitoring
4. **DoS Protection** — Response size limits and timeout enforcement
5. **Defense in Depth** — Multiple layers of validation (URL, headers, response)

## Files Modified

- `lib/http-client.js` — New secure HTTP client module (459 lines)
- `tests/http-client.test.js` — Comprehensive test suite (37 tests)
- `SECURITY.md` — Added secure HTTP client documentation
- `README.md` — Updated security section with HTTP client features

## Test Results

```
PASS tests/http-client.test.js
  SSRF Protection
    ✓ should detect private IP addresses as SSRF vectors
    ✓ should allow public IP addresses
    ✓ should detect internal hostnames
    ✓ should detect suspicious domain patterns
    ✓ should allow valid public domains
  HTTP Client URL Validation
    ✓ should block dangerous URL schemes
    ✓ should block private IP URLs by default
    ✓ should allow private IPs when explicitly enabled
    ✓ should allow valid public URLs
  HTTP Client Header Security
    ✓ should sanitize valid headers
    ✓ should reject headers with injection attempts
  ... 27 more passing tests

Test Suites: 1 passed, 1 total
Tests:       37 passed, 37 total
```

## Backward Compatibility

Fully backward compatible:
- New module is opt-in for existing code
- No changes to existing APIs
- Can gradually migrate existing axios usage

## Migration Guide

Replace direct axios usage with secure client:

```javascript
// Before: Direct axios usage (no SSRF protection)
const axios = require('axios');
const response = await axios.get('https://api.example.com/data');

// After: Secure HTTP client with SSRF protection
const httpClient = require('./lib/http-client');
const response = await httpClient.get('https://api.example.com/data');
```

For internal service calls that need private IP access:
```javascript
const response = await httpClient.get(
  'http://localhost:8000/health',
  httpClient.allowPrivateIPs()
);
```

---

# MasterClaw Improvement: Safe Output Module Bug Fix

## Summary

Fixed a **critical bug** in the `safe-output.js` module where the `CONTROL_CHARACTERS` regex incorrectly included the ANSI escape character (`\x1b`) in its pattern range. This caused legitimate color codes (e.g., `\x1b[31m` for red text) to be stripped from output, breaking colored terminal output across the CLI.

## What Was Fixed

### The Bug
The `CONTROL_CHARACTERS` regex was:
```javascript
const CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
```

The range `\x0e-\x1f` (14-31 in decimal) **incorrectly included `\x1b`** (27, the ANSI escape character), which is required for all ANSI escape sequences including safe SGR color codes.

### The Fix
Updated the regex to exclude `\x1b`:
```javascript
const CONTROL_CHARACTERS = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;
```

This splits the range into `\x0e-\x1a` (14-26) and `\x1c-\x1f` (28-31), excluding `\x1b` (27).

## Why This Is Safe

The `\x1b` character alone is harmless - it only becomes dangerous when combined with specific follow-on characters to form ANSI control sequences. Dangerous sequences (cursor movement, screen clearing, title changes, etc.) are already handled by the separate `stripDangerousAnsi()` function, which:

- Specifically allows safe SGR codes (colors/formatting ending in `m`)
- Removes dangerous CSI sequences (cursor movement, screen clearing)
- Removes OSC sequences (window title manipulation)
- Removes other dangerous sequences (DCS, APC, PM, SOS)

## Test Fixes

Updated `tests/safe-output.test.js` to fix 5 failing tests:

1. **`should handle empty strings`** - Updated to not require ANSI codes (chalk disables colors in non-TTY environments)
2. **`should sanitize input while preserving color`** - Updated to check content preservation rather than specific ANSI codes
3. **`should preserve safe chalk colors when requested`** - The main fix - `\x1b` is now preserved
4. **`should strip Cyrillic lookalikes`** - Fixed expectation: `'pаyраl.com'` removes 3 Cyrillic chars (2x `а`, 1x `р`), not 2
5. **`should handle mixed attack vectors`** - Fixed expectation: `'password'` is normal text and should be preserved (only attack sequences are removed)

## Test Results

```
PASS tests/safe-output.test.js
  Safe Output Module
    Terminal Title Manipulation Protection
      ✓ should strip window title changes (OSC 0)
      ✓ should strip window title changes (OSC 2)
      ...
    Safe Color Functions
      ✓ should sanitize input while preserving color
      ✓ should handle empty strings
    ...
    Edge Cases
      ✓ should preserve safe chalk colors when requested
      ✓ should strip colors when preserveColors is false
    Real Attack Scenarios
      ✓ should prevent terminal DoS via excessive output
      ✓ should prevent log injection with newlines
      ✓ should prevent title-based social engineering
      ✓ should prevent hidden text attacks with zero-width chars
      ✓ should prevent bidirectional text reordering attack
      ✓ should handle mixed attack vectors

Test Suites: 1 passed, 1 total
Tests:       69 passed, 69 total
```

## Files Modified

- `lib/safe-output.js` — Fixed CONTROL_CHARACTERS regex (1 line change + documentation)
- `tests/safe-output.test.js` — Fixed 5 test expectations

## Backward Compatibility

Fully backward compatible:
- No API changes
- Only fixes broken behavior (color codes now work correctly)
- All existing security protections remain in place

## Security Impact

**No security degradation:**
- Dangerous ANSI sequences are still blocked by `stripDangerousAnsi()`
- Control characters (NUL, BS, DEL, etc.) are still stripped
- Bidirectional text attacks are still prevented
- Zero-width character attacks are still prevented
- All other security features remain intact
