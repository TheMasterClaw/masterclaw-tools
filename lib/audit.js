/**
 * audit.js - Security Audit Logging for MasterClaw CLI
 *
 * Provides structured audit logging for security events, enabling:
 * - Forensic analysis of security incidents
 * - Compliance reporting
 * - Detection of suspicious activity patterns
 * - Accountability tracking
 * - **Tamper detection via HMAC signatures**
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Import security utilities
const { sanitizeForLog } = require('./security');

// =============================================================================
// Audit Configuration
// =============================================================================

/** Directory for audit logs */
const AUDIT_DIR = path.join(os.homedir(), '.masterclaw', 'audit');

/** Path to the audit signing key */
const AUDIT_KEY_FILE = path.join(AUDIT_DIR, '.audit.key');

/** Maximum audit log file size (5MB) before rotation */
const MAX_AUDIT_LOG_SIZE = 5 * 1024 * 1024;

/** Maximum number of rotated audit log files to keep */
const MAX_AUDIT_FILES = 10;

/** Maximum individual audit entry size (10KB) */
const MAX_ENTRY_SIZE = 10 * 1024;

/** HMAC algorithm for integrity verification */
const HMAC_ALGORITHM = 'sha256';

// =============================================================================
// Audit Signing Key Management
// =============================================================================

/**
 * Gets or creates the audit signing key
 * Creates a new key if one doesn't exist
 * @returns {Promise<Buffer>} - The signing key
 */
async function getAuditSigningKey() {
  try {
    // Try to read existing key
    if (await fs.pathExists(AUDIT_KEY_FILE)) {
      const key = await fs.readFile(AUDIT_KEY_FILE);
      // Ensure secure permissions on key file
      await fs.chmod(AUDIT_KEY_FILE, 0o600);
      return key;
    }
  } catch (err) {
    // Fall through to create new key
  }

  // Generate new key
  const key = crypto.randomBytes(32);

  try {
    await fs.ensureDir(AUDIT_DIR);
    await fs.writeFile(AUDIT_KEY_FILE, key, { mode: 0o600 });
  } catch (err) {
    console.error('[Audit] Failed to save signing key:', err.message);
    // Continue with in-memory key (less secure but functional)
  }

  return key;
}

/**
 * Generates an HMAC signature for an audit entry
 * @param {Object} entry - Audit entry to sign
 * @param {Buffer} key - Signing key
 * @returns {string} - Hex-encoded HMAC signature
 */
function generateEntrySignature(entry, key) {
  // Create a canonical representation of the entry for signing
  // Exclude any existing signature fields to avoid circular issues
  const { _signature, _sigAlg, ...entryToSign } = entry;

  // Use a replacer function to sort keys at each level for deterministic serialization
  const canonicalData = JSON.stringify(entryToSign, (k, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((sorted, k) => {
        sorted[k] = value[k];
        return sorted;
      }, {});
    }
    return value;
  });

  const hmac = crypto.createHmac(HMAC_ALGORITHM, key);
  hmac.update(canonicalData);
  return hmac.digest('hex');
}

/**
 * Signs an audit entry with an HMAC signature
 * @param {Object} entry - Audit entry to sign
 * @returns {Promise<Object>} - Signed entry with _signature field
 */
async function signAuditEntry(entry) {
  const key = await getAuditSigningKey();
  const signature = generateEntrySignature(entry, key);

  return {
    ...entry,
    _signature: signature,
    _sigAlg: HMAC_ALGORITHM,
  };
}

/**
 * Verifies the signature of an audit entry
 * @param {Object} entry - Audit entry to verify
 * @param {Buffer} key - Signing key (optional, will load if not provided)
 * @returns {Promise<boolean>} - True if signature is valid
 */
async function verifyEntrySignature(entry, key = null) {
  if (!entry._signature) {
    return false;
  }

  try {
    const signingKey = key || await getAuditSigningKey();
    const expectedSignature = generateEntrySignature(entry, signingKey);

    // Use constant-time comparison to prevent timing attacks
    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const actualBuf = Buffer.from(entry._signature, 'hex');

    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < expectedBuf.length; i++) {
      result |= expectedBuf[i] ^ actualBuf[i];
    }

    return result === 0;
  } catch (err) {
    return false;
  }
}

// =============================================================================
// Audit Event Types
// =============================================================================

const AuditEventType = {
  // Authentication events
  AUTH_SUCCESS: 'AUTH_SUCCESS',
  AUTH_FAILURE: 'AUTH_FAILURE',
  AUTH_LOGOUT: 'AUTH_LOGOUT',
  TOKEN_VALIDATION: 'TOKEN_VALIDATION',

  // Configuration events
  CONFIG_READ: 'CONFIG_READ',
  CONFIG_WRITE: 'CONFIG_WRITE',
  CONFIG_DELETE: 'CONFIG_DELETE',

  // Deployment events
  DEPLOY_START: 'DEPLOY_START',
  DEPLOY_SUCCESS: 'DEPLOY_SUCCESS',
  DEPLOY_FAILURE: 'DEPLOY_FAILURE',
  DEPLOY_ROLLBACK: 'DEPLOY_ROLLBACK',

  // Security events
  SECURITY_VIOLATION: 'SECURITY_VIOLATION',
  PATH_VALIDATION_FAILURE: 'PATH_VALIDATION_FAILURE',
  COMMAND_REJECTED: 'COMMAND_REJECTED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  AUDIT_INTEGRITY_FAILURE: 'AUDIT_INTEGRITY_FAILURE',

  // Docker events
  DOCKER_EXEC: 'DOCKER_EXEC',
  DOCKER_COMPOSE: 'DOCKER_COMPOSE',
  CONTAINER_ACCESS: 'CONTAINER_ACCESS',

  // Data events
  BACKUP_CREATE: 'BACKUP_CREATE',
  BACKUP_RESTORE: 'BACKUP_RESTORE',
  EXPORT_DATA: 'EXPORT_DATA',
  LOG_ACCESS: 'LOG_ACCESS',

  // System events
  SERVICE_START: 'SERVICE_START',
  SERVICE_STOP: 'SERVICE_STOP',
  HEALTH_CHECK: 'HEALTH_CHECK',
};

// Event severity levels
const Severity = {
  DEBUG: 'debug',
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical',
};

// Map event types to severity
const EVENT_SEVERITY = {
  [AuditEventType.AUTH_FAILURE]: Severity.WARNING,
  [AuditEventType.SECURITY_VIOLATION]: Severity.ERROR,
  [AuditEventType.PATH_VALIDATION_FAILURE]: Severity.WARNING,
  [AuditEventType.COMMAND_REJECTED]: Severity.WARNING,
  [AuditEventType.PERMISSION_DENIED]: Severity.ERROR,
  [AuditEventType.DEPLOY_FAILURE]: Severity.ERROR,
  [AuditEventType.AUDIT_INTEGRITY_FAILURE]: Severity.CRITICAL,
};

// =============================================================================
// Audit Entry Structure
// =============================================================================

/**
 * Creates a new audit entry
 * @param {string} eventType - Type of event from AuditEventType
 * @param {Object} details - Event details (will be sanitized)
 * @param {Object} context - Additional context (user, session, etc.)
 * @returns {Object} - Structured audit entry
 */
function createAuditEntry(eventType, details = {}, context = {}) {
  const timestamp = new Date().toISOString();
  const entryId = generateEntryId();

  // Sanitize details to prevent log injection
  const sanitizedDetails = sanitizeAuditDetails(details);
  const sanitizedContext = sanitizeAuditContext(context);

  return {
    id: entryId,
    timestamp,
    eventType,
    severity: EVENT_SEVERITY[eventType] || Severity.INFO,
    details: sanitizedDetails,
    context: sanitizedContext,
    metadata: {
      version: '1.1',
      hostname: os.hostname(),
      pid: process.pid,
    },
  };
}

/**
 * Generates a unique entry ID
 * @returns {string} - Unique ID
 */
function generateEntryId() {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return `mc-${timestamp}-${random}`;
}

/**
 * Sanitizes audit details to prevent log injection
 * @param {Object} details - Details to sanitize
 * @returns {Object} - Sanitized details
 */
function sanitizeAuditDetails(details) {
  if (!details || typeof details !== 'object') {
    return {};
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(details)) {
    // Skip dangerous keys
    if (isDangerousKey(key)) {
      continue;
    }

    // Sanitize string values
    if (typeof value === 'string') {
      sanitized[key] = sanitizeForLog(value, 500);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
    } else if (value === null || value === undefined) {
      sanitized[key] = value;
    } else if (typeof value === 'object') {
      // Recursively sanitize nested objects (limit depth)
      sanitized[key] = sanitizeAuditDetails(value);
    } else {
      // Convert other types to string representation
      sanitized[key] = sanitizeForLog(String(value), 100);
    }
  }

  return sanitized;
}

/**
 * Sanitizes audit context
 * @param {Object} context - Context to sanitize
 * @returns {Object} - Sanitized context
 */
function sanitizeAuditContext(context) {
  const sanitized = {};

  if (context.userId) {
    sanitized.userId = sanitizeForLog(String(context.userId), 100);
  }
  if (context.sessionId) {
    sanitized.sessionId = sanitizeForLog(String(context.sessionId), 100);
  }
  if (context.command) {
    sanitized.command = sanitizeForLog(String(context.command), 200);
  }
  if (context.sourceIp) {
    sanitized.sourceIp = sanitizeForLog(String(context.sourceIp), 50);
  }

  return sanitized;
}

/**
 * Checks if a key is dangerous (could enable prototype pollution)
 * @param {string} key - Key to check
 * @returns {boolean} - True if dangerous
 */
function isDangerousKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

// =============================================================================
// Audit Logging
// =============================================================================

/**
 * Writes an audit entry to the log file
 * @param {Object} entry - Audit entry to write
 * @returns {Promise<boolean>} - Success status
 */
async function writeAuditEntry(entry) {
  try {
    await fs.ensureDir(AUDIT_DIR);

    // Check if current log file needs rotation
    const currentLogPath = path.join(AUDIT_DIR, 'audit.log');
    const needsRotation = await shouldRotateLog(currentLogPath);

    if (needsRotation) {
      await rotateAuditLogs();
    }

    // Sign the entry before writing
    const signedEntry = await signAuditEntry(entry);

    // Convert entry to JSON line
    const entryJson = JSON.stringify(signedEntry);
    const entrySize = Buffer.byteLength(entryJson, 'utf8');

    // Prevent oversized entries
    if (entrySize > MAX_ENTRY_SIZE) {
      signedEntry.details = { _truncated: true, _originalSize: entrySize };
      signedEntry.metadata.warning = 'Entry was truncated due to size';
    }

    // Write entry
    await fs.appendFile(currentLogPath, `${entryJson  }\n`, 'utf8');
    return true;
  } catch (err) {
    // Audit logging failures should not break the application
    // But we should log to stderr
    console.error('[Audit] Failed to write audit entry:', err.message);
    return false;
  }
}

/**
 * Checks if the audit log should be rotated
 * @param {string} logPath - Path to log file
 * @returns {Promise<boolean>} - True if rotation needed
 */
async function shouldRotateLog(logPath) {
  try {
    const stats = await fs.stat(logPath);
    return stats.size > MAX_AUDIT_LOG_SIZE;
  } catch {
    // File doesn't exist, no rotation needed
    return false;
  }
}

/**
 * Rotates audit log files
 * Renames existing logs and removes old ones
 */
async function rotateAuditLogs() {
  const basePath = path.join(AUDIT_DIR, 'audit');

  // Remove oldest log if it exists
  const oldestLog = `${basePath}.${MAX_AUDIT_FILES}.log`;
  await fs.remove(oldestLog).catch(() => {});

  // Shift existing logs
  for (let i = MAX_AUDIT_FILES - 1; i >= 1; i--) {
    const oldPath = `${basePath}.${i}.log`;
    const newPath = `${basePath}.${i + 1}.log`;
    await fs.move(oldPath, newPath).catch(() => {});
  }

  // Move current log to .1
  const currentLog = `${basePath}.log`;
  const newLog = `${basePath}.1.log`;
  await fs.move(currentLog, newLog).catch(() => {});
}

/**
 * Main audit logging function
 * Creates and writes an audit entry
 * @param {string} eventType - Event type from AuditEventType
 * @param {Object} details - Event details
 * @param {Object} context - Additional context
 * @returns {Promise<boolean>} - Success status
 */
async function logAudit(eventType, details = {}, context = {}) {
  const entry = createAuditEntry(eventType, details, context);
  return writeAuditEntry(entry);
}

// =============================================================================
// Convenience Methods
// =============================================================================

/**
 * Logs a security violation event
 * @param {string} violationType - Type of violation
 * @param {Object} details - Violation details
 * @param {Object} context - Additional context
 * @returns {Promise<boolean>} - Success status
 */
async function logSecurityViolation(violationType, details = {}, context = {}) {
  return logAudit(AuditEventType.SECURITY_VIOLATION, {
    violationType,
    ...details,
  }, context);
}

/**
 * Logs a command execution
 * @param {string} command - Command that was executed
 * @param {Object} details - Execution details
 * @param {Object} context - Additional context
 * @returns {Promise<boolean>} - Success status
 */
async function logCommand(command, details = {}, context = {}) {
  return logAudit(AuditEventType.DOCKER_EXEC, {
    command,
    ...details,
  }, context);
}

/**
 * Logs configuration access
 * @param {string} action - Action performed (read/write/delete)
 * @param {string} key - Configuration key
 * @param {Object} context - Additional context
 * @returns {Promise<boolean>} - Success status
 */
async function logConfigAccess(action, key, context = {}) {
  const eventTypes = {
    read: AuditEventType.CONFIG_READ,
    write: AuditEventType.CONFIG_WRITE,
    delete: AuditEventType.CONFIG_DELETE,
  };

  return logAudit(eventTypes[action] || AuditEventType.CONFIG_READ, {
    action,
    key: sanitizeForLog(key, 100),
  }, context);
}

/**
 * Logs a deployment event
 * @param {string} status - Deployment status (start/success/failure/rollback)
 * @param {Object} details - Deployment details
 * @param {Object} context - Additional context
 * @returns {Promise<boolean>} - Success status
 */
async function logDeployment(status, details = {}, context = {}) {
  const eventTypes = {
    start: AuditEventType.DEPLOY_START,
    success: AuditEventType.DEPLOY_SUCCESS,
    failure: AuditEventType.DEPLOY_FAILURE,
    rollback: AuditEventType.DEPLOY_ROLLBACK,
  };

  return logAudit(eventTypes[status] || AuditEventType.DEPLOY_START, {
    status,
    ...details,
  }, context);
}

// =============================================================================
// Audit Log Querying
// =============================================================================

/**
 * Reads audit log entries
 * @param {Object} options - Query options
 * @param {string} [options.eventType] - Filter by event type
 * @param {string} [options.severity] - Filter by severity
 * @param {number} [options.limit=100] - Maximum entries to return
 * @param {number} [options.hours=24] - Look back this many hours
 * @returns {Promise<Array>} - Matching audit entries
 */
async function queryAuditLog(options = {}) {
  const {
    eventType = null,
    severity = null,
    limit = 100,
    hours = 24,
  } = options;

  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  const entries = [];

  try {
    // Read current and rotated logs
    const logFiles = ['audit.log'];
    for (let i = 1; i <= MAX_AUDIT_FILES; i++) {
      logFiles.push(`audit.${i}.log`);
    }

    for (const logFile of logFiles) {
      const logPath = path.join(AUDIT_DIR, logFile);
      if (!await fs.pathExists(logPath)) {
        continue;
      }

      const content = await fs.readFile(logPath, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          // Apply filters
          if (eventType && entry.eventType !== eventType) {
            continue;
          }
          if (severity && entry.severity !== severity) {
            continue;
          }
          if (new Date(entry.timestamp) < cutoffTime) {
            continue;
          }

          entries.push(entry);

          if (entries.length >= limit) {
            break;
          }
        } catch {
          // Skip invalid lines
          continue;
        }
      }

      if (entries.length >= limit) {
        break;
      }
    }

    // Sort by timestamp descending
    return entries.sort((a, b) =>
      new Date(b.timestamp) - new Date(a.timestamp)
    );
  } catch (err) {
    console.error('[Audit] Failed to query audit log:', err.message);
    return [];
  }
}

/**
 * Gets a summary of recent security events
 * @param {number} [hours=24] - Look back this many hours
 * @returns {Promise<Object>} - Security summary
 */
async function getSecuritySummary(hours = 24) {
  const events = await queryAuditLog({ hours, limit: 1000 });

  const summary = {
    totalEvents: events.length,
    bySeverity: {},
    byType: {},
    securityViolations: 0,
    failedAuthentications: 0,
    timeRange: {
      from: new Date(Date.now() - hours * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
    },
  };

  for (const event of events) {
    // Count by severity
    summary.bySeverity[event.severity] = (summary.bySeverity[event.severity] || 0) + 1;

    // Count by type
    summary.byType[event.eventType] = (summary.byType[event.eventType] || 0) + 1;

    // Count specific security concerns
    if (event.eventType === AuditEventType.SECURITY_VIOLATION) {
      summary.securityViolations++;
    }
    if (event.eventType === AuditEventType.AUTH_FAILURE) {
      summary.failedAuthentications++;
    }
  }

  return summary;
}

// =============================================================================
// Audit Integrity Verification
// =============================================================================

/**
 * Verifies the integrity of all audit log files
 * @param {Object} options - Verification options
 * @param {boolean} [options.verbose=false] - Show detailed output
 * @param {number} [options.hours=168] - Look back this many hours (default: 7 days)
 * @returns {Promise<Object>} - Verification result
 */
async function verifyAuditIntegrity(options = {}) {
  const { verbose = false, hours = 168 } = options;

  const result = {
    valid: true,
    totalEntries: 0,
    validSignatures: 0,
    invalidSignatures: 0,
    unsignedEntries: 0,
    errors: [],
    filesChecked: [],
  };

  try {
    const signingKey = await getAuditSigningKey();
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);

    // Check all log files
    const logFiles = ['audit.log'];
    for (let i = 1; i <= MAX_AUDIT_FILES; i++) {
      logFiles.push(`audit.${i}.log`);
    }

    for (const logFile of logFiles) {
      const logPath = path.join(AUDIT_DIR, logFile);
      if (!await fs.pathExists(logPath)) {
        continue;
      }

      result.filesChecked.push(logFile);
      const content = await fs.readFile(logPath, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());

      for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        try {
          const entry = JSON.parse(lines[lineNum]);

          // Skip entries outside the time range
          if (new Date(entry.timestamp) < cutoffTime) {
            continue;
          }

          result.totalEntries++;

          if (!entry._signature) {
            result.unsignedEntries++;
            if (verbose) {
              result.errors.push({
                file: logFile,
                line: lineNum + 1,
                entryId: entry.id,
                error: 'Entry is not signed',
              });
            }
            continue;
          }

          const isValid = await verifyEntrySignature(entry, signingKey);
          if (isValid) {
            result.validSignatures++;
          } else {
            result.invalidSignatures++;
            result.valid = false;
            result.errors.push({
              file: logFile,
              line: lineNum + 1,
              entryId: entry.id,
              timestamp: entry.timestamp,
              error: 'Invalid signature - entry may have been tampered with',
            });
          }
        } catch (err) {
          // Invalid JSON line
          result.errors.push({
            file: logFile,
            line: lineNum + 1,
            error: `Invalid JSON: ${err.message}`,
          });
        }
      }
    }

    // If tampering detected, log it as a security event
    if (result.invalidSignatures > 0) {
      await logAudit(AuditEventType.AUDIT_INTEGRITY_FAILURE, {
        invalidCount: result.invalidSignatures,
        totalChecked: result.totalEntries,
        files: result.filesChecked,
      });
    }

    return result;
  } catch (err) {
    result.valid = false;
    result.errors.push({
      file: 'N/A',
      line: 0,
      error: `Verification failed: ${err.message}`,
    });
    return result;
  }
}

/**
 * Rotates the audit signing key
 * This invalidates all existing signatures, so use with caution
 * @returns {Promise<boolean>} - Success status
 */
async function rotateSigningKey() {
  try {
    // Remove old key
    await fs.remove(AUDIT_KEY_FILE).catch(() => {});

    // Generate new key
    await getAuditSigningKey();

    // Log the key rotation
    await logAudit(AuditEventType.CONFIG_WRITE, {
      action: 'audit_key_rotation',
      keyFile: AUDIT_KEY_FILE,
    });

    return true;
  } catch (err) {
    console.error('[Audit] Failed to rotate signing key:', err.message);
    return false;
  }
}

// =============================================================================
// Export
// =============================================================================

module.exports = {
  // Main logging function
  logAudit,

  // Convenience methods
  logSecurityViolation,
  logCommand,
  logConfigAccess,
  logDeployment,

  // Query functions
  queryAuditLog,
  getSecuritySummary,

  // Integrity verification
  verifyAuditIntegrity,
  rotateSigningKey,

  // Constants
  AuditEventType,
  Severity,
  AUDIT_DIR,
  HMAC_ALGORITHM,

  // Internal utilities (for testing)
  createAuditEntry,
  sanitizeAuditDetails,
  generateEntryId,
  getAuditSigningKey,
  generateEntrySignature,
  signAuditEntry,
  verifyEntrySignature,
};
