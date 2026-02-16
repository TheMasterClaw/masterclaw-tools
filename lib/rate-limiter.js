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

// Import audit logging
const { logSecurityViolation } = require('./audit');

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
  'restore': { max: 3, windowMs: 300000 },           // 3 per 5 minutes

  // Deployment commands
  'deploy': { max: 5, windowMs: 300000 },            // 5 per 5 minutes
  'revive': { max: 10, windowMs: 60000 },            // 10 per minute

  // Data modification commands
  'cleanup': { max: 5, windowMs: 60000 },            // 5 per minute
  'import': { max: 10, windowMs: 60000 },            // 10 per minute

  // Read-only commands - more permissive
  'status': { max: 60, windowMs: 60000 },            // 60 per minute
  'health': { max: 60, windowMs: 60000 },            // 60 per minute
  'logs': { max: 30, windowMs: 60000 },              // 30 per minute
  'validate': { max: 30, windowMs: 60000 },          // 30 per minute

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
 * Loads the rate limit state from disk
 * @returns {Promise<Object>} - Rate limit state
 */
async function loadRateLimitState() {
  try {
    if (await fs.pathExists(RATE_LIMIT_FILE)) {
      const state = await fs.readJson(RATE_LIMIT_FILE);
      return state || {};
    }
  } catch (err) {
    // If file is corrupted, start fresh
    console.warn('[RateLimiter] Could not load rate limit state, starting fresh');
  }
  return {};
}

/**
 * Saves the rate limit state to disk with secure permissions
 * @param {Object} state - Rate limit state to save
 */
async function saveRateLimitState(state) {
  try {
    await fs.ensureDir(path.dirname(RATE_LIMIT_FILE));
    await fs.writeJson(RATE_LIMIT_FILE, state, { spaces: 2 });
    await fs.chmod(RATE_LIMIT_FILE, SECURE_FILE_MODE);
  } catch (err) {
    // Non-critical: rate limiting failures shouldn't break the CLI
    if (process.env.MC_VERBOSE) {
      console.warn('[RateLimiter] Could not save rate limit state:', err.message);
    }
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

  // Internal utilities (for testing)
  getUserIdentifier,
  loadRateLimitState,
  saveRateLimitState,
  cleanupOldEntries,
};
