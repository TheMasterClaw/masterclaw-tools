/**
 * security.js - Security Utilities for MasterClaw CLI
 *
 * Provides centralized security utilities for:
 * - Log injection prevention
 * - Input sanitization
 * - Security-sensitive data masking
 * - Safe string handling
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

/** Maximum safe JSON string length (10MB) */
const MAX_JSON_STRING_LENGTH = 10 * 1024 * 1024;

/** Keys that are dangerous for prototype pollution */
const DANGEROUS_PROTO_KEYS = ['__proto__', 'constructor', 'prototype'];

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
  const protoPattern = new RegExp(
    `"(${DANGEROUS_PROTO_KEYS.join('|')})"\\s*:\\s*`,
    'i'
  );
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

  // Constants
  MAX_SAFE_LOG_LENGTH,
  MAX_JSON_STRING_LENGTH,
  LOG_INJECTION_CHARS,
  LOG_NEWLINE_CHARS,
  DANGEROUS_PROTO_KEYS,
};
