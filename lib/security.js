/**
 * security.js - Security Utilities for MasterClaw CLI
 *
 * Provides centralized security utilities for:
 * - Log injection prevention
 * - Input sanitization
 * - Security-sensitive data masking
 * - Safe string handling
 * - Secure file wiping
 */

// =============================================================================
// Security Constants
// =============================================================================

/** Dangerous characters for log injection (excluding \x1b which is handled by ANSI pattern) */
const LOG_INJECTION_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;

/** Newline/carriage return characters that could inject log entries */
const LOG_NEWLINE_CHARS = /[\r\n]/g;

/** ANSI escape sequences that could corrupt terminal output */
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

/** Sensitive data patterns to mask */
const SENSITIVE_PATTERNS = [
  { pattern: /\b[a-zA-Z_]*token[=:]\s*['"]?([a-zA-Z0-9_\-]{8,})['"]?/gi, replacement: 'token=[REDACTED]' },
  { pattern: /\b[a-zA-Z_]*api[_-]?key[=:]\s*['"]?([a-zA-Z0-9_\-]{8,})['"]?/gi, replacement: 'api_key=[REDACTED]' },
  { pattern: /\b[a-zA-Z_]*password[=:]\s*['"]?([^'"\s]+)['"]?/gi, replacement: 'password=[REDACTED]' },
  { pattern: /\b[a-zA-Z_]*secret[=:]\s*['"]?([a-zA-Z0-9_\-]{8,})['"]?/gi, replacement: 'secret=[REDACTED]' },
  { pattern: /\bBearer\s+[a-zA-Z0-9_\-\.]+/gi, replacement: 'Bearer [REDACTED]' },
  { pattern: /\bBasic\s+[a-zA-Z0-9=]+/gi, replacement: 'Basic [REDACTED]' },
];

/** Maximum safe string length for logging */
const MAX_SAFE_LOG_LENGTH = 10000;

/** Maximum safe JSON string length (10MB) */
const MAX_JSON_STRING_LENGTH = 10 * 1024 * 1024;

/** Keys that are dangerous for prototype pollution */
const DANGEROUS_PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];

// =============================================================================
// Log Sanitization
// =============================================================================

/**
 * Sanitizes a string for safe logging
 * Prevents log injection attacks by removing control characters and newlines
 *
 * @param {string} str - String to sanitize
 * @param {number} maxLength - Maximum length (default: 1000)
 * @returns {string} - Sanitized string
 */
function sanitizeForLog(str, maxLength = 1000) {
  if (typeof str !== 'string') {
    return String(str);
  }

  // Limit length to prevent DoS via oversized log entries
  let sanitized = str.slice(0, Math.min(str.length, maxLength, MAX_SAFE_LOG_LENGTH));

  // Remove control characters that could inject log entries
  sanitized = sanitized.replace(LOG_INJECTION_CHARS, '');

  // Replace newlines to prevent log injection (log forging)
  sanitized = sanitized.replace(LOG_NEWLINE_CHARS, '\\n');

  // Remove ANSI escape sequences to prevent terminal manipulation
  sanitized = sanitized.replace(ANSI_ESCAPE_PATTERN, '');

  return sanitized;
}

/**
 * Masks sensitive data in strings (tokens, passwords, API keys)
 *
 * @param {string} str - String to mask
 * @returns {string} - Masked string
 */
function maskSensitiveData(str) {
  if (typeof str !== 'string') {
    return str;
  }

  let masked = str;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }

  return masked;
}

/**
 * Sanitizes and masks for secure logging
 * Combines sanitization with sensitive data masking
 *
 * @param {string} str - String to process
 * @param {number} maxLength - Maximum length
 * @returns {string} - Safe string for logging
 */
function secureLogString(str, maxLength = 1000) {
  return maskSensitiveData(sanitizeForLog(str, maxLength));
}

// =============================================================================
// Input Validation
// =============================================================================

/**
 * Validates that a value is a safe string (no null bytes, reasonable length)
 *
 * @param {*} value - Value to validate
 * @param {Object} options - Validation options
 * @param {number} [options.maxLength=1000] - Maximum length
 * @param {boolean} [options.allowEmpty=false] - Allow empty strings
 * @returns {boolean} - True if valid
 */
function isSafeString(value, options = {}) {
  const { maxLength = 1000, allowEmpty = false } = options;

  if (typeof value !== 'string') {
    return false;
  }

  if (!allowEmpty && value.length === 0) {
    return false;
  }

  if (value.length > maxLength) {
    return false;
  }

  // Check for null bytes (often used in injection attacks)
  if (value.includes('\0')) {
    return false;
  }

  return true;
}

/**
 * Validates an IP address (IPv4 or IPv6)
 *
 * @param {string} ip - IP address to validate
 * @returns {boolean} - True if valid
 */
function isValidIpAddress(ip) {
  if (typeof ip !== 'string') {
    return false;
  }

  // IPv4 pattern
  const ipv4Pattern = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

  // IPv6 pattern (simplified)
  const ipv6Pattern = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::$/;

  return ipv4Pattern.test(ip) || ipv6Pattern.test(ip);
}

/**
 * Validates a hostname/domain
 *
 * @param {string} hostname - Hostname to validate
 * @returns {boolean} - True if valid
 */
function isValidHostname(hostname) {
  if (typeof hostname !== 'string') {
    return false;
  }

  if (hostname.length > 253) {
    return false;
  }

  // Allow localhost
  if (hostname === 'localhost') {
    return true;
  }

  // Hostname pattern
  const hostnamePattern = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?$/;

  return hostnamePattern.test(hostname);
}

// =============================================================================
// Path Security
// =============================================================================

/**
 * Checks if a path contains traversal attempts
 *
 * @param {string} filePath - Path to check
 * @returns {boolean} - True if path contains traversal
 */
function containsPathTraversal(filePath) {
  if (typeof filePath !== 'string') {
    return true; // Non-strings are unsafe
  }

  const normalized = filePath.replace(/\\/g, '/');

  // Check for common traversal patterns
  if (normalized.includes('../') || normalized.includes('..\\')) {
    return true;
  }

  if (normalized.startsWith('..')) {
    return true;
  }

  // Check for null bytes
  if (filePath.includes('\0')) {
    return true;
  }

  return false;
}

/**
 * Sanitizes a filename for safe use
 *
 * @param {string} filename - Filename to sanitize
 * @param {Object} options - Options
 * @param {string} [options.replacement='_'] - Character to replace unsafe chars
 * @returns {string} - Sanitized filename
 */
function sanitizeFilename(filename, options = {}) {
  const { replacement = '_' } = options;

  if (typeof filename !== 'string') {
    return 'unnamed';
  }

  // Remove Windows drive letter
  let sanitized = filename.replace(/^[a-zA-Z]:/, '');

  // Convert backslashes to forward slashes for consistent processing
  sanitized = sanitized.replace(/\\/g, '/');

  // Extract just the filename (remove all path components)
  sanitized = sanitized.split('/').pop();

  // Replace dangerous characters
  sanitized = sanitized.replace(/[^a-zA-Z0-9._-]/g, replacement);

  // Prevent hidden files (starting with .) - replace leading dots
  sanitized = sanitized.replace(/^[._]+/, replacement);

  // Limit length
  if (sanitized.length > 255) {
    const ext = sanitized.lastIndexOf('.');
    if (ext > 0 && ext > sanitized.length - 20) {
      sanitized = sanitized.slice(0, 250) + sanitized.slice(ext);
    } else {
      sanitized = sanitized.slice(0, 255);
    }
  }

  // Ensure not empty
  if (!sanitized || sanitized === replacement) {
    sanitized = 'unnamed';
  }

  return sanitized;
}

// =============================================================================
// Timing Attack Prevention
// =============================================================================

/**
 * Compares two strings in constant time to prevent timing attacks
 *
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} - True if equal
 */
function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  let result = 0;
  const len = Math.max(a.length, b.length);

  for (let i = 0; i < len; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }

  return result === 0 && a.length === b.length;
}

// =============================================================================
// Safe JSON
// =============================================================================

/**
 * Calculates the maximum nesting depth of a JSON string before parsing
 * This is more secure than parsing first and checking depth during reviver
 *
 * @param {string} jsonString - JSON string to analyze
 * @returns {number} - Maximum nesting depth detected
 */
function getJsonDepth(jsonString) {
  let maxDepth = 0;
  let currentDepth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !inString) {
      inString = true;
      continue;
    }

    if (char === '"' && inString) {
      inString = false;
      continue;
    }

    // Only count braces outside of strings
    if (!inString) {
      if (char === '{' || char === '[') {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      } else if (char === '}' || char === ']') {
        currentDepth--;
      }
    }
  }

  return maxDepth;
}

/**
 * Checks if a JSON string contains prototype pollution keys
 *
 * @param {string} jsonString - JSON string to check
 * @returns {boolean} - True if dangerous keys found
 */
function hasProtoPollutionKeys(jsonString) {
  // Check for dangerous keys using regex (faster than parsing)
  // Match "__proto__", "constructor", or "prototype" as property names
  // Handles optional whitespace around the colon
  const patternStr = `"(${DANGEROUS_PROTO_KEYS.join('|')})"\\s*:`;
  const protoPattern = new RegExp(patternStr, 'i');
  return protoPattern.test(jsonString);
}

/**
 * Safely parses JSON with depth limit and prototype pollution protection
 *
 * Security features:
 * - Prevents prototype pollution by stripping dangerous keys
 * - Enforces maximum nesting depth before parsing
 * - Limits input size to prevent DoS
 * - Uses reviver for additional safety during parse
 *
 * @param {string} jsonString - JSON string to parse
 * @param {number} maxDepth - Maximum nesting depth (default: 100)
 * @param {boolean} allowProtoKeys - Allow prototype keys (default: false, dangerous!)
 * @returns {Object|null} - Parsed object or null on error
 */
function safeJsonParse(jsonString, maxDepth = 100, allowProtoKeys = false) {
  try {
    // Validate input type
    if (typeof jsonString !== 'string') {
      return null;
    }

    // Enforce maximum input size to prevent DoS
    if (jsonString.length > MAX_JSON_STRING_LENGTH) {
      return null;
    }

    // Check depth before parsing to prevent stack overflow
    const detectedDepth = getJsonDepth(jsonString);
    if (detectedDepth > maxDepth) {
      return null;
    }

    // Check for prototype pollution attempts
    if (!allowProtoKeys && hasProtoPollutionKeys(jsonString)) {
      // Don't parse - return null for security
      // This prevents any possibility of prototype pollution
      return null;
    }

    // Parse with reviver for additional safety
    const result = JSON.parse(jsonString, (key, value) => {
      // Block prototype pollution keys during parsing
      if (!allowProtoKeys && DANGEROUS_PROTO_KEYS.includes(key)) {
        return undefined; // Remove the property
      }
      return value;
    });

    return result;
  } catch (err) {
    return null;
  }
}

/**
 * Safely stringifies objects with circular reference protection
 *
 * @param {*} obj - Object to stringify
 * @param {number} maxLength - Maximum output length
 * @returns {string} - JSON string
 */
function safeJsonStringify(obj, maxLength = 100000) {
  const seen = new WeakSet();

  try {
    const result = JSON.stringify(obj, (key, value) => {
      // Handle prototype pollution keys
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return undefined;
      }

      // Handle circular references
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }

      return value;
    });

    if (result.length > maxLength) {
      return JSON.stringify({ _truncated: true, _originalSize: result.length });
    }

    return result;
  } catch (err) {
    return JSON.stringify({ _error: 'Stringification failed' });
  }
}

// =============================================================================
// Secure File Wipe
// =============================================================================

/** Secure wipe pass count (Gutmann method uses 35 passes, DoD 5220.22-M uses 3) */
const SECURE_WIPE_PASSES = 3;

/** Buffer size for wipe operations (1MB chunks) */
const WIPE_BUFFER_SIZE = 1024 * 1024;

/**
 * Securely wipes a file by overwriting it with random data before deletion.
 * This prevents recovery of sensitive data from disk after file deletion.
 *
 * Security features:
 * - Multiple overwrite passes with random data
 * - Syncs to disk after each pass to ensure data is written
 * - Final pass with zeros to hide wiping pattern
 * - Handles large files in chunks to avoid memory exhaustion
 *
 * @param {string} filePath - Path to file to securely delete
 * @param {Object} options - Wipe options
 * @param {number} [options.passes=3] - Number of overwrite passes
 * @param {boolean} [options.remove=true] - Remove file after wiping
 * @returns {Promise<boolean>} - True if wipe succeeded
 */
async function secureWipeFile(filePath, options = {}) {
  const fs = require('fs-extra');
  const crypto = require('crypto');
  const path = require('path');

  const { passes = SECURE_WIPE_PASSES, remove = true } = options;

  try {
    // Validate file exists and is a file
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error('Path is not a file');
    }

    const fileSize = stats.size;

    // Don't attempt to wipe empty files
    if (fileSize === 0) {
      if (remove) {
        await fs.remove(filePath);
      }
      return true;
    }

    // Open file for writing
    const fd = await fs.open(filePath, 'r+');

    try {
      // Perform multiple overwrite passes
      for (let pass = 0; pass < passes; pass++) {
        let bytesWritten = 0;

        while (bytesWritten < fileSize) {
          const chunkSize = Math.min(WIPE_BUFFER_SIZE, fileSize - bytesWritten);
          // Generate random data for this chunk
          const randomData = crypto.randomBytes(chunkSize);
          await fs.write(fd, randomData, 0, chunkSize, bytesWritten);
          bytesWritten += chunkSize;
        }

        // Sync to ensure data is written to disk
        await fs.fsync(fd);
      }

      // Final pass: overwrite with zeros to hide wiping pattern
      let bytesWritten = 0;
      const zeroBuffer = Buffer.alloc(WIPE_BUFFER_SIZE, 0);

      while (bytesWritten < fileSize) {
        const chunkSize = Math.min(WIPE_BUFFER_SIZE, fileSize - bytesWritten);
        await fs.write(fd, zeroBuffer, 0, chunkSize, bytesWritten);
        bytesWritten += chunkSize;
      }

      // Final sync
      await fs.fsync(fd);

      // Truncate to zero length (extra precaution)
      await fs.ftruncate(fd, 0);
    } finally {
      // Always close file descriptor
      await fs.close(fd);
    }

    // Remove the wiped file
    if (remove) {
      await fs.remove(filePath);
    }

    return true;
  } catch (err) {
    // Log error but don't expose sensitive path info
    throw new Error(`Secure wipe failed: ${err.message}`);
  }
}

/**
 * Securely wipes a directory and all its contents.
 * Files are individually wiped before directory removal.
 *
 * @param {string} dirPath - Path to directory
 * @param {Object} options - Wipe options
 * @param {number} [options.passes=3] - Number of overwrite passes per file
 * @returns {Promise<{success: number, failed: number, errors: string[]}>}
 */
async function secureWipeDirectory(dirPath, options = {}) {
  const fs = require('fs-extra');
  const path = require('path');

  const { passes = SECURE_WIPE_PASSES } = options;
  const result = { success: 0, failed: 0, errors: [] };

  try {
    const stats = await fs.stat(dirPath);
    if (!stats.isDirectory()) {
      throw new Error('Path is not a directory');
    }

    // Recursively process directory
    async function processDirectory(currentPath) {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          // Recurse into subdirectory
          await processDirectory(entryPath);
          // Remove empty directory
          await fs.rmdir(entryPath);
        } else if (entry.isFile()) {
          // Securely wipe file
          try {
            await secureWipeFile(entryPath, { passes, remove: true });
            result.success++;
          } catch (err) {
            result.failed++;
            result.errors.push(`${entryPath}: ${err.message}`);
          }
        }
      }
    }

    await processDirectory(dirPath);

    // Remove the now-empty root directory
    await fs.rmdir(dirPath);

    return result;
  } catch (err) {
    throw new Error(`Secure directory wipe failed: ${err.message}`);
  }
}

/**
 * Calculates the secure wipe time estimate based on file size.
 * Used for user feedback before long operations.
 *
 * @param {number} fileSizeBytes - Size of file in bytes
 * @param {number} passes - Number of passes (default: 3)
 * @returns {string} - Human-readable time estimate
 */
function estimateWipeTime(fileSizeBytes, passes = SECURE_WIPE_PASSES) {
  // Estimate: ~50MB/s per pass on modern SSDs
  const bytesPerSecond = 50 * 1024 * 1024;
  const totalBytes = fileSizeBytes * passes;
  const seconds = Math.ceil(totalBytes / bytesPerSecond);

  if (seconds < 60) {
    return `~${seconds}s`;
  } else if (seconds < 3600) {
    return `~${Math.ceil(seconds / 60)}m`;
  } else {
    return `~${Math.ceil(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m`;
  }
}

// =============================================================================
// Export
// =============================================================================

module.exports = {
  // Log sanitization
  sanitizeForLog,
  maskSensitiveData,
  secureLogString,

  // Input validation
  isSafeString,
  isValidIpAddress,
  isValidHostname,

  // Path security
  containsPathTraversal,
  sanitizeFilename,

  // Cryptographic utilities
  constantTimeCompare,

  // Safe JSON
  safeJsonParse,
  safeJsonStringify,
  getJsonDepth,
  hasProtoPollutionKeys,

  // Secure file wipe
  secureWipeFile,
  secureWipeDirectory,
  estimateWipeTime,
  SECURE_WIPE_PASSES,
  WIPE_BUFFER_SIZE,

  // Constants
  MAX_SAFE_LOG_LENGTH,
  MAX_JSON_STRING_LENGTH,
  LOG_INJECTION_CHARS,
  LOG_NEWLINE_CHARS,
  DANGEROUS_PROTO_KEYS,
};
