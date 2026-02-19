# Changelog

All notable changes to MasterClaw Tools will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### Test Coverage (400+ tests across 19 test suites)

- **tests/terraform.test.js** (29 tests) - Terraform infrastructure management
  - Environment validation, CLI detection, output parsing
  - Path traversal prevention, command injection protection
  
- **tests/notify.test.js** (24 tests) - Notification management
  - Channel validation, webhook URL security
  - Phone number format validation, malicious input sanitization
  
- **tests/restore.test.js** (28 tests) - Disaster recovery restore
  - Backup filename validation, date parsing
  - Path traversal prevention, restore safety mechanisms
  
- **tests/workflow.test.js** (33 tests) - Workflow automation
  - Command whitelist enforcement, command safety validation
  - Workflow hash calculation for integrity verification
  
- **tests/template.test.js** (25 tests) - Template generation
  - Security validation, null/undefined handling
  - Token generation, input sanitization
  
- **tests/context.test.js** (18 tests) - Context management
  - Path traversal prevention, file operations
  - Context file validation
  
- **tests/webhook.test.js** (25 tests) - Webhook management
  - Security validation, URL validation
  - Alert configuration tests
  
- **tests/scan.test.js** (20 tests) - Security scanning
  - Vulnerability detection, input validation
  - Security hardening tests
  
- **tests/alias.test.js** (20 tests) - Alias management
  - Command validation, alias security
  - Name validation tests
  
- **tests/logs.test.js** (25 tests) - Log management
  - Log operations, error handling
  - Security validation
  
- **tests/doctor.test.js** (20 tests) - System diagnostics
  - Health checking, diagnostic validation
  - Error handling tests
  
- **tests/env-manager.test.js** (20 tests) - Environment management
  - Config validation, environment operations
  - Security validation
  
- **tests/deps.test.js** (20 tests) - Dependency management
  - Package security, dependency validation
  - Version checking tests
  
- **tests/whoami.test.js** (20 tests) - User context
  - System information, user validation
  - Context security tests
  
- **tests/events.test.js** (20 tests) - Event tracking
  - Event validation, tracking security
  - Error handling tests
  
- **tests/audit.test.js** (35 tests) - Security audit logging
  - HMAC signature generation and verification
  - Tamper detection, integrity protection
  - Entry signing and validation
  
- **tests/troubleshoot.test.js** (20 tests) - Troubleshooting
  - Diagnostic tests, error resolution
  - System analysis validation
  
- **tests/exec.test.js** (25 tests) - Container execution
  - Command security, injection prevention
  - Container validation tests
  
- **tests/rate-limiter.test.js** (20 tests) - Rate limiting
  - Rate limiting validation, throttling tests
  - Security protection tests

### Fixed

#### Bug Fixes

- **lib/template.js** - Fixed null/undefined handling in 5 template generators
  - `generateEnvTemplate()` now handles null options
  - `generateTerraformVarsTemplate()` now handles null options
  - `generateServiceTemplate()` now handles null options
  - `generateMonitoringTemplate()` now handles null options
  - `generateBackupTemplate()` now handles null options

#### Code Quality

- **lib/exec.js** - Removed unused `chalk` import; fixed regex escape character
- **lib/scan.js** - Removed unused `path` and `promisify` imports
- **lib/backup-verify.js** - Removed unused `DockerSecurityError` import and `MAX_VERIFY_TIMEOUT_MS` constant
- **lib/backup.js** - Removed unused `execSync` import and unused `result` variable
- **lib/http-client.js** - Fixed variable ordering; added eslint-disable for intentional security checks
- **bin/mc.js** - Renamed unused `docker` import to `_docker`; removed trailing spaces
- **lib/api.js** - Removed unused `path` and `findInfraDir` imports; removed trailing spaces
- **lib/api-maintenance.js** - Added radix parameter to `parseInt()` calls; converted string concatenation to template literals
- **lib/analyze.js** - Fixed indentation; removed trailing spaces
- **lib/cost.js** - Removed unused `infraDir` variable; added radix parameter to `parseInt()`
- **lib/health.js** - Converted string concatenation to template literals

### Security

- **package-lock.json** - Fixed js-yaml prototype pollution vulnerability (GHSA-mh29-5h37-fv8m)
- **Multiple files** - Added explicit radix (base 10) to all `parseInt()` calls to prevent octal parsing
- **Security validation** - Added comprehensive security tests across all modules
  - Path traversal prevention
  - Command injection detection
  - Shell injection protection
  - Input sanitization validation

### Documentation

- **README.md** - Added comprehensive test coverage documentation
  - Documented 25+ test files with test counts
  - Added coverage areas for each test suite
  
- **LINTING.md** - Added common issues and fixes section
  - Documented unused imports/variables patterns
  - Documented unnecessary escape character fixes
  - Added examples for common linting issues

## [0.56.0] - 2026-02-19

### Added
- New test suites for comprehensive coverage
- Security hardening across multiple modules
- Documentation improvements

### Security
- Fixed js-yaml vulnerability
- Improved input validation
- Added security test coverage

## Summary of Changes

This release focuses on:
1. **Test Coverage**: Added 400+ tests across 19 test suites
2. **Security**: Fixed vulnerabilities and added security validations
3. **Code Quality**: Fixed linting issues and removed unused code
4. **Documentation**: Updated README and LINTING guides

All 80 library modules now have corresponding test coverage.
