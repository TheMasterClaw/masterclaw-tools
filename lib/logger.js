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
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const { maskSensitiveData } = require('./security');

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

let globalConfig = { ...DEFAULT_CONFIG };
let logFilePath = null;
let logStream = null;
let logBuffer = [];
let isShuttingDown = false;

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
        logStream.write(msg + '\n');
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
 * Rotate log files
 */
function rotateLogFiles() {
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
 * @returns {string} - Formatted string
 */
function formatHuman(entry) {
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
  return JSON.stringify(entry);
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

  // Redact sensitive data
  let safeMessage = message;
  if (globalConfig.redactSensitive) {
    safeMessage = maskSensitiveData(message);
  }

  // Build log entry
  const entry = {
    timestamp: formatTimestamp(),
    level: level.toLowerCase(),
    message: safeMessage,
    ...meta,
  };

  if (options.context) {
    entry.context = options.context;
  }

  // Format output
  const output = globalConfig.format === 'json' 
    ? formatJson(entry) 
    : formatHuman(entry);

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
    if (logStream) {
      logStream.write(fileOutput + '\n');
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
    error: {
      message: err.message,
      name: err.name,
      code: err.code,
      stack: err.stack,
    },
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
  if (logStream) {
    return new Promise((resolve) => {
      logStream.end(() => resolve());
    });
  }
}

/**
 * Graceful shutdown
 */
function shutdown() {
  isShuttingDown = true;
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
