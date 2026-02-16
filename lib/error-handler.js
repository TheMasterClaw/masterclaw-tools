/**
 * error-handler.js - Centralized Error Handling for MasterClaw CLI
 *
 * Provides consistent, user-friendly error handling across all CLI commands:
 * - Maps technical errors to actionable user messages
 * - Integrates with audit logging for security events
 * - Ensures proper exit codes for CLI usage
 * - Prevents sensitive information leakage in error messages
 */

const chalk = require('chalk');
const { logSecurityViolation, logAudit } = require('./audit');
const { DockerSecurityError, DockerCommandError } = require('./docker');
const { maskSensitiveData } = require('./security');
const { RateLimitError } = require('./rate-limiter');

// =============================================================================
// Error Categories and Exit Codes
// =============================================================================

const ExitCode = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  INVALID_ARGUMENTS: 2,
  DOCKER_ERROR: 3,
  SERVICE_UNAVAILABLE: 4,
  PERMISSION_DENIED: 5,
  SECURITY_VIOLATION: 6,
  CONFIG_ERROR: 7,
  NETWORK_ERROR: 8,
  VALIDATION_FAILED: 9,
  INTERNAL_ERROR: 99,
};

const ErrorCategory = {
  DOCKER: 'docker',
  SECURITY: 'security',
  CONFIG: 'config',
  NETWORK: 'network',
  VALIDATION: 'validation',
  SERVICE: 'service',
  PERMISSION: 'permission',
  INTERNAL: 'internal',
  USER: 'user',
};

// =============================================================================
// Error Message Mappings
// =============================================================================

/**
 * User-friendly error messages for common error patterns
 * Keys are regex patterns, values are message generators
 */
const ERROR_MESSAGE_MAP = [
  // Rate limiting errors
  {
    pattern: /rate limit exceeded|too many requests/i,
    category: ErrorCategory.SECURITY,
    message: 'Rate limit exceeded. Please slow down your requests.',
    suggestion: 'Wait a few seconds before retrying the command.',
    exitCode: ExitCode.SECURITY_VIOLATION,
  },

  // Docker errors
  {
    pattern: /docker.*not.*installed|command not found/i,
    category: ErrorCategory.DOCKER,
    message: 'Docker is not installed. Install from https://docs.docker.com/get-docker/',
    suggestion: 'Run: curl -fsSL https://get.docker.com | sh',
    exitCode: ExitCode.DOCKER_ERROR,
  },
  {
    pattern: /docker.*daemon.*not.*running|connection.*refused/i,
    category: ErrorCategory.DOCKER,
    message: 'Docker daemon is not running.',
    suggestion: 'Start Docker: sudo systemctl start docker (Linux) or open Docker Desktop (Mac/Windows)',
    exitCode: ExitCode.DOCKER_ERROR,
  },
  {
    pattern: /permission.*denied.*docker|dial.*docker/i,
    category: ErrorCategory.PERMISSION,
    message: 'Permission denied accessing Docker.',
    suggestion: 'Add your user to the docker group: sudo usermod -aG docker $USER && newgrp docker',
    exitCode: ExitCode.PERMISSION_DENIED,
  },
  
  // Network errors
  {
    pattern: /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i,
    category: ErrorCategory.NETWORK,
    message: (err) => `Network error: Unable to connect to ${err.hostname || 'service'}`,
    suggestion: 'Check your network connection and ensure the service is running.',
    exitCode: ExitCode.NETWORK_ERROR,
  },
  {
    pattern: /timeout|timed out/i,
    category: ErrorCategory.NETWORK,
    message: 'Request timed out.',
    suggestion: 'The service may be overloaded or unresponsive. Try again later.',
    exitCode: ExitCode.NETWORK_ERROR,
  },
  
  // Config errors
  {
    pattern: /\.env.*not found|config.*not found/i,
    category: ErrorCategory.CONFIG,
    message: 'Configuration file not found.',
    suggestion: 'Copy .env.example to .env and configure: cp .env.example .env',
    exitCode: ExitCode.CONFIG_ERROR,
  },
  {
    pattern: /EACCES|permission.*denied.*file/i,
    category: ErrorCategory.PERMISSION,
    message: 'Permission denied accessing files.',
    suggestion: 'Check file permissions or run with appropriate privileges.',
    exitCode: ExitCode.PERMISSION_DENIED,
  },
  
  // Service errors
  {
    pattern: /service.*down|unhealthy|not.*running/i,
    category: ErrorCategory.SERVICE,
    message: 'MasterClaw service is not running.',
    suggestion: 'Start services: mc revive',
    exitCode: ExitCode.SERVICE_UNAVAILABLE,
  },
  
  // Validation errors
  {
    pattern: /validation.*failed|invalid.*input/i,
    category: ErrorCategory.VALIDATION,
    message: 'Input validation failed.',
    suggestion: 'Check your command arguments and try again.',
    exitCode: ExitCode.VALIDATION_FAILED,
  },
];

// =============================================================================
// Error Classification
// =============================================================================

/**
 * Classifies an error and returns handling instructions
 * @param {Error} err - Error to classify
 * @returns {Object} - Classification result
 */
function classifyError(err) {
  // Check for specific error types first
  if (err instanceof DockerSecurityError) {
    return {
      category: ErrorCategory.SECURITY,
      exitCode: ExitCode.SECURITY_VIOLATION,
      shouldAudit: true,
      auditEvent: 'SECURITY_VIOLATION',
    };
  }

  if (err instanceof RateLimitError) {
    return {
      category: ErrorCategory.SECURITY,
      exitCode: ExitCode.SECURITY_VIOLATION,
      shouldAudit: true,
      auditEvent: 'RATE_LIMIT_VIOLATION',
      message: err.message,
      suggestion: `Wait ${err.rateLimitResult?.retryAfterSec || 'a few'} seconds before retrying.`,
    };
  }
  
  if (err instanceof DockerCommandError) {
    return {
      category: ErrorCategory.DOCKER,
      exitCode: ExitCode.DOCKER_ERROR,
      shouldAudit: false,
    };
  }
  
  // Check error code patterns
  if (err.code) {
    const codeMap = {
      'ENOENT': { category: ErrorCategory.CONFIG, exitCode: ExitCode.CONFIG_ERROR },
      'EACCES': { category: ErrorCategory.PERMISSION, exitCode: ExitCode.PERMISSION_DENIED },
      'EPERM': { category: ErrorCategory.PERMISSION, exitCode: ExitCode.PERMISSION_DENIED },
      'ECONNREFUSED': { category: ErrorCategory.NETWORK, exitCode: ExitCode.NETWORK_ERROR },
      'ENOTFOUND': { category: ErrorCategory.NETWORK, exitCode: ExitCode.NETWORK_ERROR },
      'ETIMEDOUT': { category: ErrorCategory.NETWORK, exitCode: ExitCode.NETWORK_ERROR },
      'EPIPE': { category: ErrorCategory.INTERNAL, exitCode: ExitCode.INTERNAL_ERROR },
    };
    
    if (codeMap[err.code]) {
      return { ...codeMap[err.code], shouldAudit: false };
    }
  }
  
  // Check message patterns
  const errorMessage = err.message || '';
  for (const mapping of ERROR_MESSAGE_MAP) {
    if (mapping.pattern.test(errorMessage)) {
      return {
        category: mapping.category,
        exitCode: mapping.exitCode,
        shouldAudit: mapping.category === ErrorCategory.SECURITY,
        message: typeof mapping.message === 'function' ? mapping.message(err) : mapping.message,
        suggestion: mapping.suggestion,
      };
    }
  }
  
  // Default classification
  return {
    category: ErrorCategory.INTERNAL,
    exitCode: ExitCode.GENERAL_ERROR,
    shouldAudit: false,
  };
}

// =============================================================================
// Error Message Generation
// =============================================================================

/**
 * Gets a user-friendly error message
 * @param {Error} err - Original error
 * @param {Object} classification - Error classification
 * @returns {string} - User-friendly message
 */
function getUserMessage(err, classification) {
  // Use mapped message if available
  if (classification.message) {
    return classification.message;
  }
  
  // Check for mapped message from ERROR_MESSAGE_MAP
  const errorMessage = err.message || '';
  for (const mapping of ERROR_MESSAGE_MAP) {
    if (mapping.pattern.test(errorMessage) && typeof mapping.message === 'string') {
      return mapping.message;
    }
  }
  
  // Default messages by category
  const categoryMessages = {
    [ErrorCategory.DOCKER]: 'Docker operation failed.',
    [ErrorCategory.SECURITY]: 'Security check failed.',
    [ErrorCategory.CONFIG]: 'Configuration error.',
    [ErrorCategory.NETWORK]: 'Network communication failed.',
    [ErrorCategory.VALIDATION]: 'Input validation failed.',
    [ErrorCategory.SERVICE]: 'Service unavailable.',
    [ErrorCategory.PERMISSION]: 'Permission denied.',
    [ErrorCategory.INTERNAL]: 'An internal error occurred.',
    [ErrorCategory.USER]: 'Invalid command or arguments.',
  };
  
  return categoryMessages[classification.category] || 'An error occurred.';
}

/**
 * Gets a suggestion for resolving the error
 * @param {Error} err - Original error
 * @param {Object} classification - Error classification
 * @returns {string|null} - Suggestion or null
 */
function getSuggestion(err, classification) {
  // Use mapped suggestion if available
  if (classification.suggestion) {
    return classification.suggestion;
  }
  
  // Check for mapped suggestion from ERROR_MESSAGE_MAP
  const errorMessage = err.message || '';
  for (const mapping of ERROR_MESSAGE_MAP) {
    if (mapping.pattern.test(errorMessage) && mapping.suggestion) {
      return mapping.suggestion;
    }
  }
  
  // Default suggestions by category
  const categorySuggestions = {
    [ErrorCategory.DOCKER]: 'Ensure Docker is running: docker version',
    [ErrorCategory.SECURITY]: 'Contact your system administrator if this persists.',
    [ErrorCategory.CONFIG]: 'Run: mc validate to check your configuration.',
    [ErrorCategory.NETWORK]: 'Check your network connection and try again.',
    [ErrorCategory.VALIDATION]: 'Run: mc <command> --help for usage information.',
    [ErrorCategory.SERVICE]: 'Run: mc status to check service health.',
    [ErrorCategory.PERMISSION]: 'Check your user permissions or use sudo.',
    [ErrorCategory.INTERNAL]: 'Please report this issue with the error details.',
  };
  
  return categorySuggestions[classification.category] || null;
}

// =============================================================================
// Error Display
// =============================================================================

/**
 * Formats and displays an error to the user
 * @param {Error} err - Error to display
 * @param {Object} options - Display options
 * @param {boolean} [options.verbose=false] - Show technical details
 * @param {string} [options.command] - Command that failed
 */
function displayError(err, options = {}) {
  const { verbose = false, command = null } = options;
  const classification = classifyError(err);
  
  // Determine icon based on category
  const icons = {
    [ErrorCategory.SECURITY]: '🔒',
    [ErrorCategory.PERMISSION]: '🔐',
    [ErrorCategory.DOCKER]: '🐳',
    [ErrorCategory.NETWORK]: '🌐',
    [ErrorCategory.SERVICE]: '⚙️',
    [ErrorCategory.CONFIG]: '⚙️',
    [ErrorCategory.VALIDATION]: '⚠️',
    [ErrorCategory.INTERNAL]: '💥',
    [ErrorCategory.USER]: '❓',
  };
  
  const icon = icons[classification.category] || '❌';
  const userMessage = getUserMessage(err, classification);
  const suggestion = getSuggestion(err, classification);
  
  // Print error header
  console.error(chalk.red(`${icon} Error: ${userMessage}`));
  
  // Print masked technical message if different from user message
  if (verbose && err.message && err.message !== userMessage) {
    const maskedMessage = maskSensitiveData(err.message);
    console.error(chalk.gray(`   Details: ${maskedMessage}`));
  }
  
  // Print suggestion
  if (suggestion) {
    console.error(chalk.yellow(`   💡 ${suggestion}`));
  }
  
  // Print command-specific help
  if (command) {
    console.error(chalk.gray(`   Run: mc ${command} --help for more information`));
  }
  
  // Print error code in verbose mode
  if (verbose && err.code) {
    console.error(chalk.gray(`   Code: ${err.code}`));
  }
  
  return classification.exitCode;
}

// =============================================================================
// Audit Logging Integration
// =============================================================================

/**
 * Logs security-related errors to the audit log
 * @param {Error} err - Error that occurred
 * @param {string} command - Command that was running
 * @param {Object} context - Additional context
 */
async function auditLogError(err, command, context = {}) {
  const classification = classifyError(err);
  
  if (!classification.shouldAudit) {
    return;
  }
  
  try {
    if (classification.category === ErrorCategory.SECURITY) {
      await logSecurityViolation('CLI_SECURITY_ERROR', {
        command,
        errorType: err.name,
        errorCode: err.code,
        message: maskSensitiveData(err.message).substring(0, 200),
      }, context);
    } else {
      await logAudit('CLI_ERROR', {
        command,
        category: classification.category,
        errorType: err.name,
        exitCode: classification.exitCode,
      }, context);
    }
  } catch (auditErr) {
    // Audit logging failures shouldn't break the CLI
    // but we should warn in verbose mode
    if (process.env.MC_VERBOSE) {
      console.warn(chalk.yellow('[Warn] Failed to write audit log:', auditErr.message));
    }
  }
}

// =============================================================================
// Command Wrapper
// =============================================================================

/**
 * Wraps an async command handler with error handling
 * Usage: program.command('foo').action(wrapCommand(async (options) => { ... }))
 * 
 * @param {Function} handler - Async command handler
 * @param {string} commandName - Name of the command for context
 * @returns {Function} - Wrapped handler
 */
function wrapCommand(handler, commandName = 'unknown') {
  return async (...args) => {
    try {
      const result = await handler(...args);
      return result;
    } catch (err) {
      // Get verbose flag from the last argument (options object)
      const options = args[args.length - 1] || {};
      const verbose = options.verbose || process.env.MC_VERBOSE;
      
      // Display error to user
      const exitCode = displayError(err, { 
        verbose, 
        command: commandName,
      });
      
      // Log to audit system (fire and forget)
      auditLogError(err, commandName, {
        command: commandName,
        args: args.slice(0, -1).map(a => typeof a === 'string' ? maskSensitiveData(a) : '[arg]'),
      }).catch(() => {});
      
      // Exit with appropriate code
      process.exit(exitCode);
    }
  };
}

/**
 * Sets up global error handlers for the CLI
 * Catches unhandled promise rejections and uncaught exceptions
 */
function setupGlobalErrorHandlers() {
  // Handle unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    console.error(chalk.red('\n💥 Unhandled error occurred'));
    
    if (reason instanceof Error) {
      displayError(reason, { verbose: process.env.MC_VERBOSE });
    } else {
      console.error(chalk.gray('   Details:', String(reason)));
    }
    
    // Log to audit
    auditLogError(
      reason instanceof Error ? reason : new Error(String(reason)),
      'unhandled_rejection',
      {}
    ).catch(() => {});
    
    process.exit(ExitCode.INTERNAL_ERROR);
  });
  
  // Handle uncaught exceptions
  process.on('uncaughtException', (err) => {
    console.error(chalk.red('\n💥 Unexpected error occurred'));
    displayError(err, { verbose: process.env.MC_VERBOSE });
    
    // Log to audit
    auditLogError(err, 'uncaught_exception', {}).catch(() => {});
    
    process.exit(ExitCode.INTERNAL_ERROR);
  });
  
  // Handle SIGINT gracefully
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\n\n⚠️  Interrupted by user'));
    process.exit(ExitCode.SUCCESS);
  });
  
  // Handle SIGTERM gracefully
  process.on('SIGTERM', () => {
    console.log(chalk.yellow('\n\n⚠️  Terminated'));
    process.exit(ExitCode.SUCCESS);
  });
}

// =============================================================================
// Export
// =============================================================================

module.exports = {
  // Main wrapper function
  wrapCommand,
  
  // Error handling setup
  setupGlobalErrorHandlers,
  
  // Error display
  displayError,
  
  // Error classification
  classifyError,
  getUserMessage,
  getSuggestion,
  
  // Audit integration
  auditLogError,
  
  // Constants
  ExitCode,
  ErrorCategory,
  ERROR_MESSAGE_MAP,
};
