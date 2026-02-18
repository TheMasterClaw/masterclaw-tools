/**
 * rate-limiter.js - Command Rate Limiting for MasterClaw CLI
 *
 * Provides protection against:
 * - Command flooding and abuse
 * - Brute force attacks on CLI operations
 * - Resource exhaustion from rapid command execution
 * - Automated attack scripts
 *
 * Features:
 * - Sliding window rate limiting per command
 * - Configurable limits per command type
 * - Persistent tracking across CLI sessions
 * - Audit logging of rate limit violations
 * - Automatic cleanup of old entries
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Import audit logging and security utilities
const { logSecurityViolation } = require('./audit');
const { sanitizeForLog, maskSensitiveData } = require('./security');

// =============================================================================
// Rate Limiting Configuration
// =============================================================================

/** Rate limit state file */
const RATE_LIMIT_FILE = path.join(os.homedir(), '.masterclaw', 'rate-limits.json');

/** Secure file permissions */
const SECURE_FILE_MODE = 0o600;

/** Default rate limits for commands (commands per minute) */
const DEFAULT_RATE_LIMITS = {
  // High-security commands - very strict limits
  'config-audit': { max: 10, windowMs: 60000 },      // 10 per minute
  'config-fix': { max: 5, windowMs: 60000 },         // 5 per minute
  'audit-verify': { max: 5, windowMs: 60000 },       // 5 per minute
  'security': { max: 10, windowMs: 60000 },          // 10 per minute
  'exec': { max: 10, windowMs: 60000 },              // 10 per minute
  'restore': { max: 3, windowMs: 300000 },           // 3 per 5 minutes

  // Deployment commands
  'deploy': { max: 5, windowMs: 300000 },            // 5 per 5 minutes
  'revive': { max: 10, windowMs: 60000 },            // 10 per minute

  // Update commands - external API calls
  'update': { max: 10, windowMs: 60000 },            // 10 per minute
  'update-version': { max: 20, windowMs: 60000 },    // 20 per minute

  // Data modification commands
  'cleanup': { max: 5, windowMs: 60000 },            // 5 per minute
  'import': { max: 10, windowMs: 60000 },            // 10 per minute

  // Read-only commands - more permissive
  'status': { max: 60, windowMs: 60000 },            // 60 per minute
  'health': { max: 60, windowMs: 60000 },            // 60 per minute
  'logs': { max: 30, windowMs: 60000 },              // 30 per minute
  'validate': { max: 30, windowMs: 60000 },          // 30 per minute

  // Communication commands
  'chat': { max: 20, windowMs: 60000 },              // 20 per minute

  // Default for unspecified commands
  'default': { max: 30, windowMs: 60000 },           // 30 per minute
};

/** Maximum entries to keep per command (prevents file bloat) */
const MAX_ENTRIES_PER_COMMAND = 100;

/** Cleanup interval - remove entries older than this */
const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// =============================================================================
// Rate Limit State Management
// =============================================================================

/**
 * Gets a unique identifier for the current user/session
 * Uses user ID hash to prevent cross-user rate limit bypass
 * @returns {string} - User identifier
 */
function getUserIdentifier() {
  // Combine user info into a unique identifier
  const userInfo = `${os.userInfo().uid}-${os.userInfo().gid}-${os.homedir()}`;
  return crypto.createHash('sha256').update(userInfo).digest('hex').substring(0, 16);
}

/**
 * Prototype pollution keys that should never appear in state
 */
const POLLUTION_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Validates that a command name is safe (no prototype pollution)
 * @param {string} command - Command name to validate
 * @returns {boolean} - True if safe
 */
function isSafeCommandName(command) {
  if (typeof command !== 'string') {
    return false;
  }

  // Check for prototype pollution keys
  if (POLLUTION_KEYS.includes(command)) {
    return false;
  }

  // Check for prototype pollution via property paths (e.g., "__proto__.polluted")
  for (const key of POLLUTION_KEYS) {
    if (command.includes(key)) {
      return false;
    }
  }

  // Command name must be reasonable length
  if (command.length === 0 || command.length > 100) {
    return false;
  }

  // Only allow alphanumeric, hyphen, and underscore in command names
  // This prevents injection via special characters
  if (!/^[a-zA-Z0-9_-]+$/.test(command)) {
    return false;
  }

  return true;
}

/**
 * Validates that the loaded state has the expected structure
 * Security-hardened against prototype pollution attacks
 * @param {*} state - State to validate
 * @returns {boolean} - True if valid
 */
function isValidRateLimitState(state) {
  // State must be a plain object (not null, not array)
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return false;
  }

  // Check for prototype pollution keys using getOwnPropertyNames
  // This catches non-enumerable properties like __proto__
  const allKeys = Object.getOwnPropertyNames(state);
  for (const key of allKeys) {
    if (POLLUTION_KEYS.includes(key)) {
      return false;
    }
  }

  // Also check using hasOwnProperty for enumerable keys
  for (const key of POLLUTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(state, key)) {
      return false;
    }
  }

  // Get all own property keys (excludes prototype chain)
  const keys = Object.keys(state);

  // Validate each command entry
  for (const command of keys) {
    // Check for prototype pollution in command name
    if (!isSafeCommandName(command)) {
      return false;
    }

    // Get value
    const entries = state[command];

    // Entries must be an array
    if (!Array.isArray(entries)) {
      return false;
    }

    // Validate array length limits (prevent DoS via oversized arrays)
    if (entries.length > MAX_ENTRIES_PER_COMMAND * 2) {
      return false;
    }

    // Each entry must be a valid timestamp (number)
    for (const entry of entries) {
      if (typeof entry !== 'number' || !Number.isFinite(entry) || entry <= 0) {
        return false;
      }

      // Timestamp should be reasonable (within last year and not in future)
      const now = Date.now();
      const oneYearAgo = now - (365 * 24 * 60 * 60 * 1000);
      if (entry > now + 60000 || entry < oneYearAgo) { // Allow 1 minute clock skew
        return false;
      }
    }
  }

  return true;
}

/**
 * Detects if state object contains prototype pollution
 * Checks for both direct pollution keys and polluted properties
 * @param {Object} state - State to check
 * @returns {Object|null} - Pollution info if detected, null otherwise
 */
function detectPrototypePollution(state) {
  if (!state || typeof state !== 'object') {
    return null;
  }

  // Check for direct prototype pollution keys as own properties
  const allKeys = Object.getOwnPropertyNames(state);
  for (const key of allKeys) {
    if (POLLUTION_KEYS.includes(key)) {
      return { type: 'direct_key', key };
    }
  }

  // Check if Object.prototype has been polluted with suspicious properties
  // We create a fresh object and check if it has unexpected properties
  const testObj = {};
  for (const prop of ['polluted', 'injected', 'malicious', 'hacked']) {
    if (prop in testObj && testObj[prop] !== undefined) {
      return { type: 'prototype_polluted', property: prop };
    }
  }

  // Check for nested pollution in command entries
  // Only check actual command entries (arrays), not the prototype chain
  for (const key of Object.keys(state)) {
    const value = state[key];
    if (Array.isArray(value)) {
      // Check if any pollution keys exist as own properties of the array
      for (const pollutionKey of POLLUTION_KEYS) {
        if (Object.prototype.hasOwnProperty.call(value, pollutionKey)) {
          return { type: 'nested_pollution', key, pollutionKey };
        }
      }
    }
  }

  return null;
}

/**
 * Loads the rate limit state from disk
 * Security-hardened with prototype pollution detection
 * @returns {Promise<Object>} - Rate limit state
 */
async function loadRateLimitState() {
  try {
    if (await fs.pathExists(RATE_LIMIT_FILE)) {
      const state = await fs.readJson(RATE_LIMIT_FILE);

      // Check for prototype pollution before validation
      const pollution = detectPrototypePollution(state);
      if (pollution) {
        const safePath = sanitizeForLog(RATE_LIMIT_FILE, 100);
        console.warn(`[RateLimiter] Security alert: Prototype pollution detected in ${safePath}`);

        await logSecurityViolation('RATE_LIMIT_STATE_POLLUTION', {
          file: RATE_LIMIT_FILE,
          pollutionType: pollution.type,
          details: pollution.key || pollution.property || 'unknown',
        });

        // Return empty state - don't use polluted data
        return {};
      }

      // Validate state structure to prevent corruption issues
      if (isValidRateLimitState(state)) {
        return state;
      } else {
        const safePath = sanitizeForLog(RATE_LIMIT_FILE, 100);
        console.warn(`[RateLimiter] State file ${safePath} has invalid structure, starting fresh`);
        return {};
      }
    }
  } catch (err) {
    // If file is corrupted, start fresh
    const safeError = sanitizeForLog(String(err.message), 200);
    console.warn(`[RateLimiter] Could not load rate limit state, starting fresh: ${safeError}`);
  }
  return {};
}

/**
 * Saves the rate limit state to disk with secure permissions
 * Verifies that permissions were actually set correctly
 * @param {Object} state - Rate limit state to save
 * @returns {Promise<boolean>} - True if save succeeded with proper permissions
 */
async function saveRateLimitState(state) {
  try {
    await fs.ensureDir(path.dirname(RATE_LIMIT_FILE));
    await fs.writeJson(RATE_LIMIT_FILE, state, { spaces: 2 });
    await fs.chmod(RATE_LIMIT_FILE, SECURE_FILE_MODE);

    // Verify permissions were actually set (security check)
    const stats = await fs.stat(RATE_LIMIT_FILE);
    const modeOctal = (stats.mode & 0o777);

    if (modeOctal !== SECURE_FILE_MODE) {
      // Permissions don't match - log warning but don't fail (graceful degradation)
      if (process.env.MC_VERBOSE) {
        const safePath = sanitizeForLog(RATE_LIMIT_FILE, 100);
        console.warn(`[RateLimiter] Warning: File permissions for ${safePath} are ${modeOctal.toString(8)} (expected ${SECURE_FILE_MODE.toString(8)})`);
      }

      // Log security event for permission mismatch
      await logSecurityViolation('RATE_LIMIT_FILE_PERMISSION_MISMATCH', {
        file: RATE_LIMIT_FILE,
        expectedMode: SECURE_FILE_MODE,
        actualMode: modeOctal,
      });

      return false;
    }

    return true;
  } catch (err) {
    // Non-critical: rate limiting failures shouldn't break the CLI
    if (process.env.MC_VERBOSE) {
      const safeError = sanitizeForLog(String(err.message), 200);
      console.warn(`[RateLimiter] Could not save rate limit state: ${safeError}`);
    }
    return false;
  }
}

/**
 * Cleans up old rate limit entries to prevent file bloat
 * @param {Object} state - Current rate limit state
 * @returns {Object} - Cleaned state
 */
function cleanupOldEntries(state) {
  const now = Date.now();
  const cutoff = now - CLEANUP_AGE_MS;
  const cleaned = {};

  for (const [command, entries] of Object.entries(state)) {
    if (Array.isArray(entries)) {
      // Keep only recent entries and limit total count
      const recentEntries = entries
        .filter(ts => ts > cutoff)
        .slice(-MAX_ENTRIES_PER_COMMAND);

      if (recentEntries.length > 0) {
        cleaned[command] = recentEntries;
      }
    }
  }

  return cleaned;
}

// =============================================================================
// Rate Limit Checking
// =============================================================================

/**
 * Checks if a command execution is allowed under rate limits
 * @param {string} command - Command name
 * @param {Object} options - Check options
 * @param {boolean} [options.increment=true] - Whether to increment the counter
 * @returns {Promise<Object>} - Rate limit check result
 */
async function checkRateLimit(command, options = {}) {
  const { increment = true } = options;

  // Get rate limit config for this command
  const limitConfig = DEFAULT_RATE_LIMITS[command] || DEFAULT_RATE_LIMITS.default;
  const { max, windowMs } = limitConfig;

  // Load current state
  let state = await loadRateLimitState();

  // Initialize command entry if needed
  if (!state[command]) {
    state[command] = [];
  }

  const now = Date.now();
  const windowStart = now - windowMs;

  // Filter to only entries within the current window
  state[command] = state[command].filter(ts => ts > windowStart);

  // Check if limit exceeded
  const currentCount = state[command].length;
  const allowed = currentCount < max;

  // Calculate retry after time
  let retryAfterMs = 0;
  if (!allowed && state[command].length > 0) {
    const oldestInWindow = Math.min(...state[command]);
    retryAfterMs = (oldestInWindow + windowMs) - now;
  }

  // Increment if allowed and requested
  if (allowed && increment) {
    state[command].push(now);
  }

  // Cleanup and save state
  state = cleanupOldEntries(state);
  await saveRateLimitState(state);

  return {
    allowed,
    command,
    currentCount: increment && allowed ? currentCount + 1 : currentCount,
    max,
    windowMs,
    retryAfterMs: Math.max(0, retryAfterMs),
    retryAfterSec: Math.ceil(Math.max(0, retryAfterMs) / 1000),
  };
}

/**
 * Enforces rate limit for a command, throwing if exceeded
 * @param {string} command - Command name
 * @param {Object} context - Additional context for logging
 * @throws {RateLimitError} - If rate limit exceeded
 */
async function enforceRateLimit(command, context = {}) {
  const result = await checkRateLimit(command);

  if (!result.allowed) {
    // Log the rate limit violation
    await logSecurityViolation('RATE_LIMIT_EXCEEDED', {
      command,
      attemptedCount: result.currentCount + 1,
      maxAllowed: result.max,
      windowMs: result.windowMs,
      retryAfterSec: result.retryAfterSec,
    }, context);

    throw new RateLimitError(
      `Rate limit exceeded for command '${command}'`,
      result
    );
  }

  return result;
}

/**
 * Gets current rate limit status for all commands
 * @returns {Promise<Object>} - Status for all commands
 */
async function getRateLimitStatus() {
  const state = await loadRateLimitState();
  const status = {};

  for (const [command, limitConfig] of Object.entries(DEFAULT_RATE_LIMITS)) {
    if (command === 'default') continue;

    const { max, windowMs } = limitConfig;
    const now = Date.now();
    const windowStart = now - windowMs;

    const entries = (state[command] || []).filter(ts => ts > windowStart);
    const remaining = Math.max(0, max - entries.length);
    const resetTime = entries.length > 0
      ? new Date(Math.min(...entries) + windowMs).toISOString()
      : null;

    status[command] = {
      limit: max,
      used: entries.length,
      remaining,
      windowMs,
      resetTime,
    };
  }

  return status;
}

/**
 * Resets rate limits for a specific command or all commands
 * Requires explicit confirmation for security
 * @param {string} [command] - Command to reset, or null for all
 * @param {boolean} [force=false] - Skip confirmation (use with caution)
 * @returns {Promise<boolean>} - Success status
 */
async function resetRateLimits(command = null, force = false) {
  // Security: Only allow reset with explicit force flag
  if (!force) {
    throw new Error('Rate limit reset requires force=true - this is a security-sensitive operation');
  }

  try {
    let state = await loadRateLimitState();

    if (command) {
      // Reset specific command
      delete state[command];
    } else {
      // Reset all commands
      state = {};
    }

    await saveRateLimitState(state);

    // Log the reset for security audit
    await logSecurityViolation('RATE_LIMIT_RESET', {
      command: command || 'ALL',
      resetBy: getUserIdentifier(),
    });

    return true;
  } catch (err) {
    throw new Error(`Failed to reset rate limits: ${err.message}`);
  }
}

// =============================================================================
// Custom Error Class
// =============================================================================

/**
 * Rate limit exceeded error
 */
class RateLimitError extends Error {
  constructor(message, rateLimitResult) {
    super(message);
    this.name = 'RateLimitError';
    this.code = 'RATE_LIMIT_EXCEEDED';
    this.rateLimitResult = rateLimitResult;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      command: this.rateLimitResult?.command,
      currentCount: this.rateLimitResult?.currentCount,
      max: this.rateLimitResult?.max,
      retryAfterSec: this.rateLimitResult?.retryAfterSec,
      timestamp: this.timestamp,
    };
  }
}

// =============================================================================
// Integration Helper
// =============================================================================

/**
 * Wraps a command handler with rate limiting
 * Usage: program.command('foo').action(withRateLimit('foo', async (options) => { ... }))
 *
 * @param {string} commandName - Command name for rate limit tracking
 * @param {Function} handler - Async command handler
 * @returns {Function} - Wrapped handler
 */
function withRateLimit(commandName, handler) {
  return async (...args) => {
    // Check rate limit before executing
    await enforceRateLimit(commandName, {
      command: commandName,
      args: args.map(a => typeof a === 'object' ? '[options]' : String(a).substring(0, 50)),
    });

    // Execute the handler
    return await handler(...args);
  };
}

// =============================================================================
// Export
// =============================================================================

module.exports = {
  // Main functions
  checkRateLimit,
  enforceRateLimit,
  getRateLimitStatus,
  resetRateLimits,

  // Integration helper
  withRateLimit,

  // Error class
  RateLimitError,

  // Configuration
  DEFAULT_RATE_LIMITS,
  MAX_ENTRIES_PER_COMMAND,
  CLEANUP_AGE_MS,
  RATE_LIMIT_FILE,
  SECURE_FILE_MODE,

  // Internal utilities (for testing)
  getUserIdentifier,
  loadRateLimitState,
  saveRateLimitState,
  cleanupOldEntries,
  isValidRateLimitState,
  isSafeCommandName,
  detectPrototypePollution,
  POLLUTION_KEYS,
};
