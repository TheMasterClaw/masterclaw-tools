/**
 * correlation.js - Request Correlation ID System for MasterClaw CLI
 *
 * Provides distributed tracing capabilities across the CLI:
 * - Generate unique correlation IDs for each command execution
 * - Propagate IDs through logger, audit, and event systems
 * - Enable tracing a single operation across all log types
 * - Support for external correlation ID injection (CI/CD integration)
 *
 * Security considerations:
 * - Correlation IDs are sanitized to prevent log injection
 * - IDs have bounded length to prevent DoS
 * - No sensitive data encoded in correlation IDs
 */

const { sanitizeForLog } = require('./security');

// =============================================================================
// Constants
// =============================================================================

/** Maximum length for correlation IDs */
const MAX_CORRELATION_ID_LENGTH = 64;

/** Minimum length for valid correlation IDs */
const MIN_CORRELATION_ID_LENGTH = 8;

/** Valid characters for correlation IDs (URL-safe base64 subset) */
const VALID_CORRELATION_ID_CHARS = /^[a-zA-Z0-9_-]+$/;

/** HTTP header name for correlation ID propagation */
const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Environment variable name for external correlation ID */
const CORRELATION_ID_ENV_VAR = 'MC_CORRELATION_ID';

// =============================================================================
// AsyncLocalStorage Setup
// =============================================================================

/** AsyncLocalStorage for correlation ID context (Node 14.8+) */
let asyncLocalStorage = null;
let useAsyncLocalStorage = false;

try {
  const { AsyncLocalStorage } = require('async_hooks');
  asyncLocalStorage = new AsyncLocalStorage();
  useAsyncLocalStorage = true;
} catch {
  // AsyncLocalStorage not available (Node < 14.8), fall back to simple context
}

/** Module-level context for fallback when AsyncLocalStorage unavailable */
const fallbackContext = {
  correlationId: null,
};

/**
 * Clears the correlation ID from fallback context (for testing)
 * @private
 */
function clearCorrelationContext() {
  fallbackContext.correlationId = null;
}

// =============================================================================
// Correlation ID Generation
// =============================================================================

/**
 * Generates a unique correlation ID
 * Format: mc_<timestamp>_<random> (URL-safe, alphanumeric)
 *
 * @returns {string} - Unique correlation ID
 */
function generateCorrelationId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `mc_${timestamp}_${random}`;
}

/**
 * Validates a correlation ID from external source
 *
 * @param {string} id - Correlation ID to validate
 * @returns {Object} - Validation result { valid: boolean, error?: string, sanitized?: string }
 */
function validateCorrelationId(id) {
  if (typeof id !== 'string') {
    return { valid: false, error: 'Correlation ID must be a string' };
  }

  if (id.length < MIN_CORRELATION_ID_LENGTH) {
    return { valid: false, error: `Correlation ID too short (min ${MIN_CORRELATION_ID_LENGTH} chars)` };
  }

  if (id.length > MAX_CORRELATION_ID_LENGTH) {
    return { valid: false, error: `Correlation ID too long (max ${MAX_CORRELATION_ID_LENGTH} chars)` };
  }

  if (!VALID_CORRELATION_ID_CHARS.test(id)) {
    return { valid: false, error: 'Correlation ID contains invalid characters (use only a-z, A-Z, 0-9, _, -)' };
  }

  // Sanitize for safety
  const sanitized = sanitizeForLog(id, MAX_CORRELATION_ID_LENGTH);

  return { valid: true, sanitized };
}

/**
 * Sanitizes a correlation ID, generating a new one if invalid
 *
 * @param {string} [id] - Optional correlation ID to sanitize
 * @returns {string} - Valid correlation ID (sanitized or new)
 */
function sanitizeCorrelationId(id) {
  if (!id) {
    return generateCorrelationId();
  }

  const validation = validateCorrelationId(id);
  if (validation.valid) {
    return validation.sanitized;
  }

  // Invalid ID provided, generate new one
  return generateCorrelationId();
}

// =============================================================================
// Context Management
// =============================================================================

/**
 * Gets the current correlation ID from context
 * Checks AsyncLocalStorage first, then falls back to module-level storage
 * @returns {string|null} - Current correlation ID or null
 */
function getCurrentCorrelationId() {
  if (useAsyncLocalStorage && asyncLocalStorage) {
    const store = asyncLocalStorage.getStore();
    if (store && store.correlationId) {
      return store.correlationId;
    }
  }
  // Fallback to module-level storage
  return fallbackContext.correlationId || null;
}

/**
 * Sets the correlation ID for the current synchronous context
 * Note: Prefer runWithCorrelationId for async operations
 *
 * @param {string} id - Correlation ID
 * @returns {string} - The valid correlation ID that was set
 */
function setCorrelationId(id) {
  const validId = sanitizeCorrelationId(id);

  if (useAsyncLocalStorage && asyncLocalStorage) {
    const store = asyncLocalStorage.getStore();
    if (store) {
      store.correlationId = validId;
    } else {
      // Not in an async context, use fallback
      fallbackContext.correlationId = validId;
    }
  } else {
    fallbackContext.correlationId = validId;
  }

  return validId;
}

/**
 * Runs a function within a correlation ID context
 * Uses AsyncLocalStorage when available for proper async context tracking
 *
 * @param {Function} fn - Function to run
 * @param {string} [correlationId] - Optional correlation ID (generates one if not provided)
 * @returns {*} - Function result
 */
function runWithCorrelationId(fn, correlationId) {
  const id = sanitizeCorrelationId(correlationId);

  if (useAsyncLocalStorage && asyncLocalStorage) {
    return asyncLocalStorage.run({ correlationId: id }, fn);
  } else {
    // Fallback: set before, clear after
    const previousId = fallbackContext.correlationId;
    fallbackContext.correlationId = id;
    try {
      return fn();
    } finally {
      fallbackContext.correlationId = previousId;
    }
  }
}

/**
 * Runs an async function within a correlation ID context
 *
 * @param {Function} fn - Async function to run
 * @param {string} [correlationId] - Optional correlation ID
 * @returns {Promise<*>} - Function result
 */
async function runWithCorrelationIdAsync(fn, correlationId) {
  const id = sanitizeCorrelationId(correlationId);

  if (useAsyncLocalStorage && asyncLocalStorage) {
    return asyncLocalStorage.run({ correlationId: id }, fn);
  } else {
    const previousId = fallbackContext.correlationId;
    fallbackContext.correlationId = id;
    try {
      return await fn();
    } finally {
      fallbackContext.correlationId = previousId;
    }
  }
}

// =============================================================================
// Environment Integration
// =============================================================================

/**
 * Gets correlation ID from environment (for CI/CD integration)
 * @returns {string|null} - Correlation ID from environment or null
 */
function getCorrelationIdFromEnvironment() {
  const envId = process.env[CORRELATION_ID_ENV_VAR];
  if (!envId) {
    return null;
  }

  const validation = validateCorrelationId(envId);
  return validation.valid ? validation.sanitized : null;
}

/**
 * Initializes correlation ID from environment or generates new one
 * @returns {string} - Correlation ID to use
 */
function initializeCorrelationId() {
  const envId = getCorrelationIdFromEnvironment();
  if (envId) {
    return envId;
  }
  return generateCorrelationId();
}

// =============================================================================
// Hierarchy Helpers
// =============================================================================

/**
 * Creates a child correlation ID (for sub-operations)
 * Format: <parent_id>.<sub_id>
 *
 * @param {string} [parentId] - Parent correlation ID (uses current if not provided)
 * @returns {string} - Child correlation ID
 */
function createChildCorrelationId(parentId) {
  const baseId = parentId || getCurrentCorrelationId() || generateCorrelationId();
  const childSuffix = Math.random().toString(36).substring(2, 6);
  const childId = `${baseId}.${childSuffix}`;

  // Ensure we don't exceed max length
  if (childId.length > MAX_CORRELATION_ID_LENGTH) {
    // Truncate parent and add suffix
    const maxParentLength = MAX_CORRELATION_ID_LENGTH - childSuffix.length - 1;
    return `${baseId.substring(0, maxParentLength)}.${childSuffix}`;
  }

  return childId;
}

/**
 * Extracts the root correlation ID from a potentially child ID
 * @param {string} id - Correlation ID
 * @returns {string} - Root correlation ID
 */
function getRootCorrelationId(id) {
  if (!id) {
    return getCurrentCorrelationId() || generateCorrelationId();
  }
  return id.split('.')[0];
}

// =============================================================================
// HTTP Header Integration
// =============================================================================

/**
 * Gets correlation ID from HTTP headers object
 * @param {Object} headers - HTTP headers (lowercase keys recommended)
 * @returns {string|null} - Correlation ID or null
 */
function getCorrelationIdFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return null;
  }

  // Try various header name formats
  const id = headers[CORRELATION_ID_HEADER] ||
             headers['X-Correlation-Id'] ||
             headers['X-Correlation-ID'] ||
             headers['x-request-id'] ||
             headers['X-Request-Id'];

  if (!id) {
    return null;
  }

  const validation = validateCorrelationId(id);
  return validation.valid ? validation.sanitized : null;
}

/**
 * Creates HTTP headers object with correlation ID
 * @param {string} [id] - Correlation ID (uses current if not provided)
 * @returns {Object} - Headers object
 */
function createCorrelationHeaders(id) {
  const correlationId = id || getCurrentCorrelationId() || generateCorrelationId();
  return {
    [CORRELATION_ID_HEADER]: correlationId,
  };
}

// =============================================================================
// Integration with MasterClaw Systems
// =============================================================================

/**
 * Wraps a CLI command handler with correlation ID tracking
 * Automatically integrates with logger, audit, and events systems
 *
 * @param {Function} handler - Command handler function
 * @param {string} commandName - Name of the command
 * @returns {Function} - Wrapped handler
 */
function wrapCommandWithCorrelation(handler, commandName) {
  return async (...args) => {
    // Initialize correlation ID
    const correlationId = initializeCorrelationId();

    // Run handler within correlation context
    return runWithCorrelationIdAsync(async () => {
      // Log command start with correlation ID
      const { info } = require('./logger');
      info(`Command started: ${commandName}`, {
        command: commandName,
        correlationId,
      }, { context: 'command' });

      try {
        const result = await handler(...args);

        info(`Command completed: ${commandName}`, {
          command: commandName,
          correlationId,
          status: 'success',
        }, { context: 'command' });

        return result;
      } catch (err) {
        info(`Command failed: ${commandName}`, {
          command: commandName,
          correlationId,
          status: 'error',
          error: err.message,
        }, { context: 'command' });
        throw err;
      }
    }, correlationId);
  };
}

// =============================================================================
// Export
// =============================================================================

module.exports = {
  // ID generation and validation
  generateCorrelationId,
  validateCorrelationId,
  sanitizeCorrelationId,

  // Context management
  getCurrentCorrelationId,
  setCorrelationId,
  runWithCorrelationId,
  runWithCorrelationIdAsync,
  clearCorrelationContext, // For testing

  // Environment integration
  initializeCorrelationId,
  getCorrelationIdFromEnvironment,

  // Hierarchy
  createChildCorrelationId,
  getRootCorrelationId,

  // HTTP integration
  getCorrelationIdFromHeaders,
  createCorrelationHeaders,
  CORRELATION_ID_HEADER,

  // CLI integration
  wrapCommandWithCorrelation,

  // Constants
  MAX_CORRELATION_ID_LENGTH,
  MIN_CORRELATION_ID_LENGTH,
  CORRELATION_ID_ENV_VAR,
};
