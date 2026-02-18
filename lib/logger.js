/**
 * logger.js - Structured Logging Utility for MasterClaw CLI
 *
 * Provides consistent, leveled logging across the CLI:
 * - Log levels: debug, info, warn, error, silent
 * - Human-readable and JSON output formats
 * - Log rotation support for file output
 * - Context/metadata attachment
 * - Sensitive data redaction
 * - Performance-aware (lazy evaluation for debug logs)
 * - Security hardened against log injection attacks
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const { maskSensitiveData, sanitizeForLog } = require('./security');

// =============================================================================
// Correlation ID Integration (Lazy-loaded to prevent circular dependencies)
// =============================================================================

let correlationModule = null;

/**
 * Lazy-load correlation module to avoid circular dependency
 * correlation.js imports logger.js, so we can't import it at the top level
 * @returns {Object|null} - Correlation module or null if not available
 */
function getCorrelationModule() {
  if (!correlationModule) {
    try {
      correlationModule = require('./correlation');
    } catch {
      // Module not available (circular dependency or missing)
      correlationModule = null;
    }
  }
  return correlationModule;
}

/**
 * Get current correlation ID from the correlation context
 * @returns {string|null} - Current correlation ID or null
 */
function getCurrentCorrelationId() {
  const mod = getCorrelationModule();
  if (mod && typeof mod.getCurrentCorrelationId === 'function') {
    return mod.getCurrentCorrelationId();
  }
  return null;
}

// =============================================================================
// Security Constants
// =============================================================================

/** Maximum size for a single log entry (metadata + message) to prevent DoS */
const MAX_LOG_ENTRY_SIZE = 100 * 1024; // 100KB

/** Maximum depth for nested metadata objects */
const MAX_METADATA_DEPTH = 10;

/** Maximum number of keys in metadata object */
const MAX_METADATA_KEYS = 100;

/** Maximum length for individual string values in metadata */
const MAX_METADATA_VALUE_LENGTH = 10000;

/** Keys that should be redacted from metadata (case-insensitive) */
const SENSITIVE_METADATA_KEYS = [
  'password', 'secret', 'token', 'apikey', 'api_key', 'auth',
  'credential', 'passwd', 'pwd', 'privatekey', 'private_key',
  'access_token', 'refresh_token', 'bearer', 'authorization'
];

// =============================================================================
// Logger Configuration
// =============================================================================

/** Log levels with numeric priorities */
const LogLevel = {
  SILENT: 0,
  ERROR: 1,
  WARN: 2,
  INFO: 3,
  DEBUG: 4,
};

/** Log level names for string parsing */
const LogLevelNames = {
  silent: LogLevel.SILENT,
  error: LogLevel.ERROR,
  warn: LogLevel.WARN,
  warning: LogLevel.WARN,
  info: LogLevel.INFO,
  debug: LogLevel.DEBUG,
  verbose: LogLevel.DEBUG,
};

/** Default configuration */
const DEFAULT_CONFIG = {
  level: LogLevel.INFO,
  format: 'human', // 'human' or 'json'
  colorize: true,
  timestamp: true,
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 5,
  redactSensitive: true,
  exitOnError: false,
};

/** Default log directory */
const DEFAULT_LOG_DIR = path.join(os.homedir(), '.masterclaw', 'logs');

// =============================================================================
// Logger State
// =============================================================================

const globalConfig = { ...DEFAULT_CONFIG };
let logFilePath = null;
let logStream = null;
let logBuffer = [];
let isShuttingDown = false;
let isRotating = false; // Lock to prevent rotation race conditions

// =============================================================================
// Security: Metadata Sanitization
// =============================================================================

/**
 * Checks if a key is a sensitive key that should be redacted
 * @param {string} key - Key to check
 * @returns {boolean} - True if sensitive
 */
function isSensitiveKey(key) {
  if (typeof key !== 'string') return false;
  const lowerKey = key.toLowerCase();
  return SENSITIVE_METADATA_KEYS.some(sensitive => lowerKey.includes(sensitive));
}

/**
 * Deep sanitizes metadata to prevent log injection and DoS attacks
 * - Removes circular references
 * - Limits nesting depth
 * - Limits string lengths
 * - Limits total keys
 * - Sanitizes string values
 * - Redacts sensitive keys
 *
 * @param {*} value - Value to sanitize
 * @param {number} depth - Current depth
 * @param {WeakSet} seen - Set of seen objects (for circular ref detection)
 * @param {number} keyCount - Current key count (for limiting)
 * @returns {*} - Sanitized value
 */
function sanitizeMetadata(value, depth = 0, seen = new WeakSet(), keyCount = { count: 0 }) {
  // Check depth limit
  if (depth > MAX_METADATA_DEPTH) {
    return '[MaxDepthExceeded]';
  }

  // Check key count limit
  if (keyCount.count > MAX_METADATA_KEYS) {
    return '[MaxKeysExceeded]';
  }

  // Handle null/undefined
  if (value === null || value === undefined) {
    return value;
  }

  // Handle strings
  if (typeof value === 'string') {
    // Limit string length
    let sanitized = value;
    if (sanitized.length > MAX_METADATA_VALUE_LENGTH) {
      sanitized = `${sanitized.slice(0, MAX_METADATA_VALUE_LENGTH)  }...[truncated]`;
    }
    // Sanitize for log safety
    return sanitizeForLog(sanitized, MAX_METADATA_VALUE_LENGTH);
  }

  // Handle numbers, booleans
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  // Handle functions (convert to string representation)
  if (typeof value === 'function') {
    return '[Function]';
  }

  // Handle symbols
  if (typeof value === 'symbol') {
    return value.toString();
  }

  // Handle BigInt
  if (typeof value === 'bigint') {
    return value.toString();
  }

  // Handle objects
  if (typeof value === 'object') {
    // Check for circular references
    if (seen.has(value)) {
      return '[Circular]';
    }

    // Handle Date
    if (value instanceof Date) {
      return value.toISOString();
    }

    // Handle Error
    if (value instanceof Error) {
      return {
        name: value.name,
        message: sanitizeForLog(value.message, MAX_METADATA_VALUE_LENGTH),
        code: value.code,
        stack: value.stack ? sanitizeForLog(value.stack, MAX_METADATA_VALUE_LENGTH) : undefined,
      };
    }

    // Handle RegExp
    if (value instanceof RegExp) {
      return value.toString();
    }

    // Handle Buffer/ArrayBuffer (redact binary data)
    if (value instanceof Buffer || value instanceof ArrayBuffer ||
        (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer)) {
      return `[BinaryData:${value.byteLength || value.length}bytes]`;
    }

    // Add to seen set
    seen.add(value);

    // Handle arrays
    if (Array.isArray(value)) {
      const result = [];
      for (let i = 0; i < value.length && i < 100; i++) { // Limit array length
        result.push(sanitizeMetadata(value[i], depth + 1, seen, keyCount));
      }
      if (value.length > 100) {
        result.push(`...[${value.length - 100} more items]`);
      }
      return result;
    }

    // Handle plain objects
    const result = {};
    for (const key of Object.keys(value)) {
      keyCount.count++;
      if (keyCount.count > MAX_METADATA_KEYS) {
        result['[truncated]'] = '[MaxKeysExceeded]';
        break;
      }

      // Redact sensitive keys
      if (globalConfig.redactSensitive && isSensitiveKey(key)) {
        result[key] = '[REDACTED]';
      } else {
        // Sanitize the key itself
        const safeKey = sanitizeForLog(key, 256);
        result[safeKey] = sanitizeMetadata(value[key], depth + 1, seen, keyCount);
      }
    }

    return result;
  }

  // Fallback for any other type
  return String(value);
}

/**
 * Estimates the serialized size of a log entry
 * @param {Object} entry - Log entry
 * @returns {number} - Estimated size in bytes
 */
function estimateEntrySize(entry) {
  try {
    return JSON.stringify(entry).length;
  } catch {
    return Infinity;
  }
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configure the logger
 * @param {Object} options - Configuration options
 * @param {string|number} options.level - Log level (string name or number)
 * @param {string} options.format - Output format ('human' or 'json')
 * @param {boolean} options.colorize - Whether to colorize console output
 * @param {boolean} options.timestamp - Whether to include timestamps
 * @param {string} options.file - Log file path (null for console-only)
 * @param {number} options.maxFileSize - Maximum log file size before rotation
 * @param {number} options.maxFiles - Maximum number of rotated files to keep
 * @param {boolean} options.redactSensitive - Whether to redact sensitive data
 * @param {boolean} options.exitOnError - Whether to exit on error logs
 */
function configure(options = {}) {
  if (options.level !== undefined) {
    globalConfig.level = parseLevel(options.level);
  }
  if (options.format !== undefined) {
    globalConfig.format = options.format === 'json' ? 'json' : 'human';
  }
  if (options.colorize !== undefined) {
    globalConfig.colorize = Boolean(options.colorize);
  }
  if (options.timestamp !== undefined) {
    globalConfig.timestamp = Boolean(options.timestamp);
  }
  if (options.file !== undefined) {
    setLogFile(options.file);
  }
  if (options.maxFileSize !== undefined) {
    globalConfig.maxFileSize = options.maxFileSize;
  }
  if (options.maxFiles !== undefined) {
    globalConfig.maxFiles = options.maxFiles;
  }
  if (options.redactSensitive !== undefined) {
    globalConfig.redactSensitive = Boolean(options.redactSensitive);
  }
  if (options.exitOnError !== undefined) {
    globalConfig.exitOnError = Boolean(options.exitOnError);
  }
}

/**
 * Parse log level from string or number
 * @param {string|number} level - Log level
 * @returns {number} - Numeric log level
 */
function parseLevel(level) {
  if (typeof level === 'number') {
    return Math.max(0, Math.min(4, level));
  }
  if (typeof level === 'string') {
    const normalized = level.toLowerCase().trim();
    if (LogLevelNames[normalized] !== undefined) {
      return LogLevelNames[normalized];
    }
  }
  return LogLevel.INFO;
}

/**
 * Get current log level name
 * @returns {string} - Current level name
 */
function getLevelName() {
  const entries = Object.entries(LogLevel);
  const found = entries.find(([, val]) => val === globalConfig.level);
  return found ? found[0].toLowerCase() : 'info';
}

// =============================================================================
// File Output
// =============================================================================

/**
 * Set log file path and initialize stream
 * @param {string} filePath - Path to log file (null for console-only)
 */
function setLogFile(filePath) {
  // Close existing stream
  if (logStream) {
    logStream.end();
    logStream = null;
  }

  logFilePath = filePath;

  if (filePath) {
    ensureLogDirectory();
    openLogStream();
  }
}

/**
 * Ensure log directory exists
 */
function ensureLogDirectory() {
  if (logFilePath) {
    const dir = path.dirname(logFilePath);
    fs.ensureDirSync(dir);
  }
}

/**
 * Open log file stream with rotation support
 */
function openLogStream() {
  try {
    // Check if rotation is needed
    if (fs.existsSync(logFilePath)) {
      const stats = fs.statSync(logFilePath);
      if (stats.size >= globalConfig.maxFileSize) {
        rotateLogFiles();
      }
    }

    logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

    // Flush buffered messages
    if (logBuffer.length > 0) {
      for (const msg of logBuffer) {
        logStream.write(`${msg  }\n`);
      }
      logBuffer = [];
    }

    logStream.on('error', (err) => {
      console.error(`[Logger] Failed to write to log file: ${err.message}`);
      logStream = null;
    });
  } catch (err) {
    console.error(`[Logger] Failed to open log file: ${err.message}`);
    logStream = null;
  }
}

/**
 * Rotate log files with locking to prevent race conditions
 */
function rotateLogFiles() {
  // Prevent concurrent rotation
  if (isRotating) {
    return;
  }

  isRotating = true;

  try {
    // Remove oldest file if it exists
    const oldestFile = `${logFilePath}.${globalConfig.maxFiles}`;
    if (fs.existsSync(oldestFile)) {
      fs.unlinkSync(oldestFile);
    }

    // Shift existing files
    for (let i = globalConfig.maxFiles - 1; i >= 1; i--) {
      const oldFile = `${logFilePath}.${i}`;
      const newFile = `${logFilePath}.${i + 1}`;
      if (fs.existsSync(oldFile)) {
        fs.renameSync(oldFile, newFile);
      }
    }

    // Rotate current file
    if (fs.existsSync(logFilePath)) {
      fs.renameSync(logFilePath, `${logFilePath}.1`);
    }
  } catch (err) {
    console.error(`[Logger] Failed to rotate log files: ${err.message}`);
    // Continue logging - don't let rotation failure stop logging
  } finally {
    isRotating = false;
  }
}

// =============================================================================
// Message Formatting
// =============================================================================

/**
 * Format timestamp
 * @returns {string} - Formatted timestamp
 */
function formatTimestamp() {
  const now = new Date();
  return now.toISOString();
}

/**
 * Get colored level string
 * @param {string} level - Log level
 * @returns {string} - Colored level string
 */
function getColoredLevel(level) {
  if (!globalConfig.colorize) {
    return level.toUpperCase();
  }

  const colors = {
    debug: chalk.gray('DEBUG'),
    info: chalk.blue('INFO'),
    warn: chalk.yellow('WARN'),
    error: chalk.red('ERROR'),
  };

  return colors[level] || level.toUpperCase();
}

/**
 * Format log entry for human-readable output
 * @param {Object} entry - Log entry
 * @param {Object} formatOptions - Formatting options
 * @param {boolean} formatOptions.verbose - Include verbose details like correlation ID
 * @returns {string} - Formatted string
 */
function formatHuman(entry, formatOptions = {}) {
  const { verbose = false } = formatOptions;
  const parts = [];

  if (globalConfig.timestamp) {
    parts.push(chalk.gray(`[${entry.timestamp}]`));
  }

  parts.push(getColoredLevel(entry.level));

  if (entry.context) {
    parts.push(chalk.cyan(`[${entry.context}]`));
  }

  parts.push(entry.message);

  // Add metadata if present (excluding internal fields)
  const meta = { ...entry };
  delete meta.timestamp;
  delete meta.level;
  delete meta.message;
  delete meta.context;
  delete meta.correlationId; // Handled separately

  // Show correlation ID in verbose mode for debugging/traceability
  if (verbose && entry.correlationId) {
    parts.push(chalk.gray(`[correlation:${entry.correlationId}]`));
  }

  if (Object.keys(meta).length > 0) {
    const metaStr = Object.entries(meta)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ');
    parts.push(chalk.gray(`{${metaStr}}`));
  }

  return parts.join(' ');
}

/**
 * Format log entry for JSON output
 * @param {Object} entry - Log entry
 * @returns {string} - JSON string
 */
function formatJson(entry) {
  try {
    return JSON.stringify(entry);
  } catch (err) {
    // Handle circular references or other JSON serialization errors
    return JSON.stringify({
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
      _error: 'Failed to serialize log entry',
      _serializeError: err.message,
    });
  }
}

// =============================================================================
// Core Logging
// =============================================================================

/**
 * Core log function
 * @param {string} level - Log level name
 * @param {string} message - Log message
 * @param {Object} meta - Additional metadata
 * @param {Object} options - Log options
 */
function log(level, message, meta = {}, options = {}) {
  const numericLevel = LogLevel[level.toUpperCase()];

  // Check level filter
  if (numericLevel > globalConfig.level) {
    return;
  }

  // Skip if shutting down (unless it's an error)
  if (isShuttingDown && numericLevel < LogLevel.ERROR) {
    return;
  }

  // Redact sensitive data in message
  let safeMessage = message;
  if (globalConfig.redactSensitive) {
    safeMessage = maskSensitiveData(message);
  }

  // Sanitize message for log safety
  safeMessage = sanitizeForLog(safeMessage, 10000);

  // Sanitize metadata for security
  const sanitizedMeta = sanitizeMetadata(meta);

  // Build log entry
  const entry = {
    timestamp: formatTimestamp(),
    level: level.toLowerCase(),
    message: safeMessage,
    ...sanitizedMeta,
  };

  // Add context if provided
  if (options.context) {
    entry.context = sanitizeForLog(options.context, 100);
  }

  // Auto-inject correlation ID for distributed tracing
  // This enables tracing logs across async operations without manual context passing
  const correlationId = getCurrentCorrelationId();
  if (correlationId) {
    entry.correlationId = sanitizeForLog(correlationId, 64);
  }

  // Check entry size limit
  if (estimateEntrySize(entry) > MAX_LOG_ENTRY_SIZE) {
    entry._truncated = true;
    entry._originalSize = estimateEntrySize(entry);
    // Remove large metadata fields
    for (const key of Object.keys(entry)) {
      if (key !== 'timestamp' && key !== 'level' && key !== 'message' && key !== 'context') {
        delete entry[key];
      }
    }
    entry._metaTruncated = 'Entry exceeded maximum size limit';
  }

  // Format output
  const output = globalConfig.format === 'json'
    ? formatJson(entry)
    : formatHuman(entry, { verbose: options.verbose || process.env.MC_VERBOSE });

  // Console output - WARN and ERROR go to stderr, INFO and DEBUG go to stdout
  const isError = numericLevel <= LogLevel.WARN;
  if (isError) {
    console.error(output);
  } else {
    console.log(output);
  }

  // File output
  if (logFilePath) {
    const fileOutput = formatJson(entry);
    if (logStream && !logStream.destroyed) {
      // Check if rotation needed before writing
      try {
        if (fs.existsSync(logFilePath)) {
          const stats = fs.statSync(logFilePath);
          if (stats.size >= globalConfig.maxFileSize) {
            // Close stream, rotate, reopen
            logStream.end();
            rotateLogFiles();
            openLogStream();
          }
        }
      } catch (err) {
        // Ignore stat errors, continue with write attempt
      }

      logStream.write(`${fileOutput  }\n`, (err) => {
        if (err) {
          // Write failed, buffer the message for retry
          logBuffer.push(fileOutput);
        }
      });
    } else {
      logBuffer.push(fileOutput);
      if (logBuffer.length > 1000) {
        logBuffer.shift(); // Prevent unbounded growth
      }
    }
  }

  // Exit on error if configured
  if (isError && globalConfig.exitOnError && !options.noExit) {
    process.exit(1);
  }
}

// =============================================================================
// Convenience Methods
// =============================================================================

/**
 * Log debug message
 * @param {string} message - Message to log
 * @param {Object} meta - Additional metadata
 * @param {Object} options - Log options
 */
function debug(message, meta, options) {
  log('debug', message, meta, options);
}

/**
 * Log info message
 * @param {string} message - Message to log
 * @param {Object} meta - Additional metadata
 * @param {Object} options - Log options
 */
function info(message, meta, options) {
  log('info', message, meta, options);
}

/**
 * Log warning message
 * @param {string} message - Message to log
 * @param {Object} meta - Additional metadata
 * @param {Object} options - Log options
 */
function warn(message, meta, options) {
  log('warn', message, meta, options);
}

/**
 * Log error message
 * @param {string} message - Message to log
 * @param {Object} meta - Additional metadata
 * @param {Object} options - Log options
 */
function error(message, meta, options) {
  log('error', message, meta, options);
}

/**
 * Log error with Error object
 * @param {string} message - Message to log
 * @param {Error} err - Error object
 * @param {Object} options - Log options
 */
function errorWithStack(message, err, options = {}) {
  const meta = {
    error: err,
  };
  log('error', message, meta, options);
}

// =============================================================================
// Child Logger (Contextual)
// =============================================================================

/**
 * Create a child logger with preset context
 * @param {string} context - Context name
 * @param {Object} defaultMeta - Default metadata
 * @returns {Object} - Child logger
 */
function child(context, defaultMeta = {}) {
  return {
    debug: (msg, meta, opts) => debug(msg, { ...defaultMeta, ...meta }, { ...opts, context }),
    info: (msg, meta, opts) => info(msg, { ...defaultMeta, ...meta }, { ...opts, context }),
    warn: (msg, meta, opts) => warn(msg, { ...defaultMeta, ...meta }, { ...opts, context }),
    error: (msg, meta, opts) => error(msg, { ...defaultMeta, ...meta }, { ...opts, context }),
    errorWithStack: (msg, err, opts) => errorWithStack(msg, err, { ...opts, context }),
  };
}

// =============================================================================
// Lifecycle
// =============================================================================

/**
 * Flush pending logs and close file stream
 * @returns {Promise<void>}
 */
async function flush() {
  // First, flush any buffered messages to the stream
  if (logBuffer.length > 0 && logStream && !logStream.destroyed) {
    for (const msg of logBuffer) {
      logStream.write(`${msg}\n`);
    }
    logBuffer = [];
  }

  if (logStream && !logStream.destroyed) {
    return new Promise((resolve) => {
      logStream.end(() => resolve());
    });
  }
}

/**
 * Graceful shutdown - flushes logs before closing
 */
function shutdown() {
  isShuttingDown = true;
  // Flush buffered messages before closing
  if (logBuffer.length > 0 && logStream && !logStream.destroyed) {
    for (const msg of logBuffer) {
      try {
        logStream.write(`${msg}\n`);
      } catch (err) {
        // Ignore write errors during shutdown
      }
    }
    logBuffer = [];
  }
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}

// Setup graceful shutdown handlers
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });

// =============================================================================
// Environment Integration
// =============================================================================

/**
 * Configure from environment variables
 */
function configureFromEnvironment() {
  const config = {};

  if (process.env.MC_LOG_LEVEL) {
    config.level = process.env.MC_LOG_LEVEL;
  }

  if (process.env.MC_LOG_FORMAT) {
    config.format = process.env.MC_LOG_FORMAT;
  }

  if (process.env.MC_LOG_FILE) {
    config.file = process.env.MC_LOG_FILE;
  }

  if (process.env.MC_LOG_COLORIZE === 'false' || process.env.MC_LOG_COLORIZE === '0') {
    config.colorize = false;
  }

  if (process.env.MC_LOG_TIMESTAMP === 'false' || process.env.MC_LOG_TIMESTAMP === '0') {
    config.timestamp = false;
  }

  if (process.env.MC_LOG_REDACT === 'false' || process.env.MC_LOG_REDACT === '0') {
    config.redactSensitive = false;
  }

  if (process.env.MC_VERBOSE || process.env.DEBUG) {
    config.level = 'debug';
  }

  configure(config);
}

// Auto-configure from environment on load
configureFromEnvironment();

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  // Security constants
  MAX_LOG_ENTRY_SIZE,
  MAX_METADATA_DEPTH,
  MAX_METADATA_KEYS,
  MAX_METADATA_VALUE_LENGTH,
  SENSITIVE_METADATA_KEYS,

  // Security functions
  isSensitiveKey,
  sanitizeMetadata,
  estimateEntrySize,

  // Correlation ID integration
  getCurrentCorrelationId,
  getCorrelationModule,

  // Log levels
  LogLevel,
  LogLevelNames,

  // Configuration
  configure,
  configureFromEnvironment,
  parseLevel,
  getLevelName,
  setLogFile,

  // Core logging
  log,
  debug,
  info,
  warn,
  error,
  errorWithStack,

  // Child loggers
  child,

  // Lifecycle
  flush,
  shutdown,

  // Constants
  DEFAULT_CONFIG,
  DEFAULT_LOG_DIR,
};
