const { spawn } = require('child_process');
const path = require('path');

// =============================================================================
// Security Constants
// =============================================================================

/** Valid container name pattern: alphanumeric, hyphens, underscores, dots */
const VALID_CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Maximum container name length (Docker limit is 64, we use 63 for safety) */
const MAX_CONTAINER_NAME_LENGTH = 63;

/** Maximum tail lines for logs (prevent resource exhaustion) */
const MAX_TAIL_LINES = 10000;

/** Allowed compose commands for validation */
const ALLOWED_COMPOSE_COMMANDS = new Set([
  'up', 'down', 'restart', 'pull', 'ps', 'logs', 'build',
  'start', 'stop', 'config', 'images', 'top', 'pause', 'unpause'
]);

/** Dangerous characters that could enable command injection */
const DANGEROUS_CHARS = /[;&|`$(){}[\]\\<>\n\r]/;

/** Default timeout for Docker commands (5 minutes) */
const DEFAULT_DOCKER_TIMEOUT_MS = 5 * 60 * 1000;

/** Timeout for quick Docker commands (30 seconds) */
const QUICK_DOCKER_TIMEOUT_MS = 30 * 1000;

// =============================================================================
// Security Validation Functions
// =============================================================================

/**
 * Validates container name to prevent command injection and path traversal
 * @param {string} name - Container name to validate
 * @returns {boolean} - True if valid
 * @throws {DockerSecurityError} - If name is invalid
 */
function validateContainerName(name) {
  if (typeof name !== 'string') {
    throw new DockerSecurityError(
      'Container name must be a string',
      'INVALID_CONTAINER_NAME_TYPE',
      { provided: typeof name }
    );
  }

  if (name.length === 0) {
    throw new DockerSecurityError(
      'Container name cannot be empty',
      'EMPTY_CONTAINER_NAME'
    );
  }

  if (name.length > MAX_CONTAINER_NAME_LENGTH) {
    throw new DockerSecurityError(
      `Container name too long (max ${MAX_CONTAINER_NAME_LENGTH} characters)`,
      'CONTAINER_NAME_TOO_LONG',
      { length: name.length, max: MAX_CONTAINER_NAME_LENGTH }
    );
  }

  // Check for path traversal attempts first (security critical)
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new DockerSecurityError(
      'Container name cannot contain path traversal sequences',
      'PATH_TRAVERSAL_DETECTED',
      { name }
    );
  }

  if (!VALID_CONTAINER_NAME.test(name)) {
    throw new DockerSecurityError(
      'Container name contains invalid characters. Only alphanumeric characters, ' +
      'hyphens, underscores, and dots are allowed. Must start with a letter or number.',
      'INVALID_CONTAINER_NAME_CHARS',
      { name }
    );
  }

  return true;
}

/**
 * Validates compose arguments to prevent command injection
 * @param {string[]} args - Arguments array
 * @returns {boolean} - True if valid
 * @throws {DockerSecurityError} - If arguments are invalid
 */
function validateComposeArgs(args) {
  if (!Array.isArray(args)) {
    throw new DockerSecurityError(
      'Arguments must be an array',
      'INVALID_ARGS_TYPE'
    );
  }

  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new DockerSecurityError(
        'All arguments must be strings',
        'INVALID_ARG_TYPE',
        { arg }
      );
    }

    // Check for dangerous shell characters
    if (DANGEROUS_CHARS.test(arg)) {
      throw new DockerSecurityError(
        'Argument contains potentially dangerous characters',
        'DANGEROUS_CHARS_DETECTED',
        { arg }
      );
    }

    // Check for common injection patterns
    if (arg.includes('$(', ')') || arg.includes('`', '`')) {
      throw new DockerSecurityError(
        'Argument contains command substitution patterns',
        'COMMAND_SUBSTITUTION_DETECTED',
        { arg }
      );
    }
  }

  // Validate first argument is an allowed compose command
  if (args.length > 0 && !ALLOWED_COMPOSE_COMMANDS.has(args[0])) {
    throw new DockerSecurityError(
      `Unknown or disallowed compose command: ${args[0]}`,
      'DISALLOWED_COMMAND',
      { allowed: Array.from(ALLOWED_COMPOSE_COMMANDS) }
    );
  }

  return true;
}

/**
 * Validates working directory path
 * @param {string} cwd - Working directory path
 * @returns {boolean} - True if valid
 * @throws {DockerSecurityError} - If path is invalid or unsafe
 */
function validateWorkingDirectory(cwd) {
  if (!cwd) {
    return true; // Undefined/null is ok (uses current dir)
  }

  if (typeof cwd !== 'string') {
    throw new DockerSecurityError(
      'Working directory must be a string',
      'INVALID_CWD_TYPE'
    );
  }

  // Check for null bytes
  if (cwd.includes('\0')) {
    throw new DockerSecurityError(
      'Working directory contains null bytes',
      'NULL_BYTE_IN_PATH'
    );
  }

  // Check for path traversal
  const normalized = path.normalize(cwd);
  // Check for traversal patterns at start or anywhere in path
  if (normalized.startsWith('..') || normalized.includes('../') || normalized.includes('..\\')) {
    throw new DockerSecurityError(
      'Working directory cannot contain path traversal sequences',
      'PATH_TRAVERSAL_IN_CWD',
      { cwd }
    );
  }

  // Additional check: resolve against a base and ensure no traversal escapes
  const resolved = path.resolve(cwd);
  const relativeToRoot = path.relative('/', resolved);
  if (relativeToRoot.startsWith('..')) {
    throw new DockerSecurityError(
      'Working directory cannot contain path traversal sequences',
      'PATH_TRAVERSAL_IN_CWD',
      { cwd }
    );
  }

  return true;
}

/**
 * Validates tail option for logs
 * @param {number} tail - Number of lines
 * @returns {boolean} - True if valid
 * @throws {DockerSecurityError} - If invalid
 */
function validateTailOption(tail) {
  if (tail === undefined || tail === null) {
    return true;
  }

  // Reject string inputs - only accept actual numbers
  if (typeof tail !== 'number') {
    throw new DockerSecurityError(
      'Tail must be a number',
      'INVALID_TAIL_TYPE'
    );
  }

  if (!Number.isInteger(tail)) {
    throw new DockerSecurityError(
      'Tail must be an integer',
      'INVALID_TAIL_TYPE'
    );
  }

  if (tail < 0) {
    throw new DockerSecurityError(
      'Tail cannot be negative',
      'NEGATIVE_TAIL'
    );
  }

  if (tail > MAX_TAIL_LINES) {
    throw new DockerSecurityError(
      `Tail exceeds maximum of ${MAX_TAIL_LINES} lines`,
      'TAIL_TOO_LARGE',
      { requested: tail, max: MAX_TAIL_LINES }
    );
  }

  return true;
}

/**
 * Validates timeout option
 * @param {number} timeout - Timeout in milliseconds
 * @returns {boolean} - True if valid
 * @throws {DockerSecurityError} - If invalid
 */
function validateTimeout(timeout) {
  if (timeout === undefined || timeout === null) {
    return true;
  }

  if (typeof timeout !== 'number') {
    throw new DockerSecurityError(
      'Timeout must be a number',
      'INVALID_TIMEOUT_TYPE'
    );
  }

  if (!Number.isInteger(timeout)) {
    throw new DockerSecurityError(
      'Timeout must be an integer',
      'INVALID_TIMEOUT_TYPE'
    );
  }

  if (timeout < 0) {
    throw new DockerSecurityError(
      'Timeout cannot be negative',
      'NEGATIVE_TIMEOUT'
    );
  }

  // Prevent excessively long timeouts (max 1 hour)
  const MAX_TIMEOUT_MS = 60 * 60 * 1000;
  if (timeout > MAX_TIMEOUT_MS) {
    throw new DockerSecurityError(
      `Timeout exceeds maximum of ${MAX_TIMEOUT_MS}ms (1 hour)`,
      'TIMEOUT_TOO_LARGE',
      { requested: timeout, max: MAX_TIMEOUT_MS }
    );
  }

  return true;
}

// =============================================================================
// Custom Error Classes
// =============================================================================

/**
 * Base error class for Docker operations
 */
class DockerError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'DockerError';
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      details: this.details,
      timestamp: this.timestamp,
      type: this.name,
    };
  }
}

/**
 * Security-specific error for validation failures
 */
class DockerSecurityError extends DockerError {
  constructor(message, code, details = {}) {
    super(message, code, details);
    this.name = 'DockerSecurityError';
    this.isSecurityError = true;
  }
}

/**
 * Command execution error
 */
class DockerCommandError extends DockerError {
  constructor(message, code, exitCode, stdout = '', stderr = '') {
    // Truncate long output to prevent memory issues
    const truncatedStdout = stdout.slice(0, 1000);
    const truncatedStderr = stderr.slice(0, 1000);
    super(message, code, { exitCode, stdout: truncatedStdout, stderr: truncatedStderr });
    this.name = 'DockerCommandError';
    this.exitCode = exitCode;
    this.stdout = truncatedStdout;
    this.stderr = truncatedStderr;
  }
}

// =============================================================================
// Docker Operations
// =============================================================================

/**
 * Check if Docker is available with timeout protection
 * @param {number} [timeout=10000] - Timeout in milliseconds (default: 10s)
 * @returns {Promise<boolean>}
 */
async function isDockerAvailable(timeout = 10000) {
  return new Promise((resolve) => {
    const docker = spawn('docker', ['--version']);
    let isSettled = false;

    const timeoutId = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        docker.kill('SIGKILL');
        resolve(false);
      }
    }, timeout);

    docker.on('close', (code) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeoutId);
      resolve(code === 0);
    });

    docker.on('error', () => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeoutId);
      resolve(false);
    });
  });
}

/**
 * Check if Docker Compose is available with timeout protection
 * @param {number} [timeout=10000] - Timeout in milliseconds (default: 10s)
 * @returns {Promise<boolean>}
 */
async function isComposeAvailable(timeout = 10000) {
  return new Promise((resolve) => {
    const compose = spawn('docker-compose', ['--version']);
    let isSettled = false;

    const timeoutId = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        compose.kill('SIGKILL');
        resolve(false);
      }
    }, timeout);

    compose.on('close', (code) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeoutId);
      resolve(code === 0);
    });

    compose.on('error', () => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeoutId);
      resolve(false);
    });
  });
}

/**
 * Run Docker Compose with security validation and timeout protection
 * @param {string[]} args - Compose command arguments
 * @param {Object} options - Options
 * @param {string} [options.cwd] - Working directory
 * @param {boolean} [options.verbose=false] - Show output in real-time
 * @param {number} [options.timeout=300000] - Timeout in milliseconds (default: 5 min)
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 * @throws {DockerSecurityError|DockerCommandError}
 */
async function compose(args, options = {}) {
  const { cwd, verbose = false, timeout = DEFAULT_DOCKER_TIMEOUT_MS } = options;

  // Validate arguments
  validateComposeArgs(args);
  validateWorkingDirectory(cwd);
  validateTimeout(timeout);

  return new Promise((resolve, reject) => {
    const composeCmd = spawn('docker-compose', args, {
      cwd: cwd || undefined,
      stdio: verbose ? 'inherit' : 'pipe',
    });

    let stdout = '';
    let stderr = '';
    let timeoutId = null;
    let isSettled = false;

    // Set up timeout if specified
    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          composeCmd.kill('SIGTERM');
          // Force kill after graceful period
          setTimeout(() => {
            if (composeCmd.exitCode === null) {
              composeCmd.kill('SIGKILL');
            }
          }, 5000);

          reject(new DockerCommandError(
            `Docker Compose command timed out after ${timeout}ms`,
            'COMPOSE_TIMEOUT',
            -1,
            stdout,
            stderr
          ));
        }
      }, timeout);
    }

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    if (!verbose) {
      composeCmd.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      composeCmd.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    composeCmd.on('close', (code) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();

      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new DockerCommandError(
          stderr || stdout || `Docker Compose exited with code ${code}`,
          'COMPOSE_FAILED',
          code,
          stdout,
          stderr
        ));
      }
    });

    composeCmd.on('error', (err) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();

      reject(new DockerCommandError(
        `Failed to spawn docker-compose: ${err.message}`,
        'SPAWN_ERROR',
        -1
      ));
    });
  });
}

/**
 * Get container logs with security validation and timeout protection
 * @param {string} containerName - Container name
 * @param {Object} options - Options
 * @param {boolean} [options.follow=false] - Follow log output
 * @param {number} [options.tail=100] - Number of lines to show
 * @param {number} [options.timeout=60000] - Timeout in milliseconds for non-follow mode (default: 60s)
 * @returns {Promise<string>}
 * @throws {DockerSecurityError|DockerCommandError}
 */
async function logs(containerName, options = {}) {
  const { follow = false, tail = 100, timeout = 60000 } = options;

  // Validate inputs
  validateContainerName(containerName);
  validateTailOption(tail);
  validateTimeout(timeout);

  const args = ['logs'];
  if (follow) args.push('-f');
  if (tail !== undefined && tail !== null) {
    args.push('--tail', String(Math.floor(Number(tail))));
  }
  args.push(containerName);

  return new Promise((resolve, reject) => {
    const logsCmd = spawn('docker', args, {
      stdio: follow ? 'inherit' : 'pipe',
    });

    if (follow) {
      // For follow mode, we don't resolve - the process continues running
      return;
    }

    let output = '';
    let timeoutId = null;
    let isSettled = false;

    // Set up timeout for non-follow mode
    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          logsCmd.kill('SIGTERM');
          setTimeout(() => {
            if (logsCmd.exitCode === null) {
              logsCmd.kill('SIGKILL');
            }
          }, 5000);

          reject(new DockerCommandError(
            `Docker logs command timed out after ${timeout}ms`,
            'LOGS_TIMEOUT',
            -1,
            output
          ));
        }
      }, timeout);
    }

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    logsCmd.stdout.on('data', (data) => {
      output += data.toString();
    });

    logsCmd.stderr.on('data', (data) => {
      output += data.toString();
    });

    logsCmd.on('close', (code) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();

      if (code === 0 || code === null) {
        // Docker logs returns null on successful follow termination
        resolve(output);
      } else {
        reject(new DockerCommandError(
          `Failed to get logs for container '${containerName}'`,
          'LOGS_FAILED',
          code,
          output
        ));
      }
    });

    logsCmd.on('error', (err) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();

      reject(new DockerCommandError(
        `Failed to spawn docker logs: ${err.message}`,
        'SPAWN_ERROR',
        -1
      ));
    });
  });
}

/**
 * Restart services with security validation
 * @param {string[]} services - Service names to restart
 * @param {Object} options - Options
 * @param {string} [options.cwd] - Working directory
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 * @throws {DockerSecurityError|DockerCommandError}
 */
async function restart(services = [], options = {}) {
  const { cwd } = options;

  // Validate all service names
  if (!Array.isArray(services)) {
    throw new DockerSecurityError(
      'Services must be an array',
      'INVALID_SERVICES_TYPE'
    );
  }

  for (const service of services) {
    if (service && typeof service === 'string') {
      validateContainerName(service);
    }
  }

  const args = ['restart'];
  if (services.length > 0) {
    args.push(...services);
  }

  return compose(args, { cwd });
}

/**
 * Pull latest images
 * @param {Object} options - Options
 * @param {string} [options.cwd] - Working directory
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
async function pull(options = {}) {
  const { cwd } = options;
  return compose(['pull'], { cwd });
}

/**
 * Get service status
 * @param {Object} options - Options
 * @param {string} [options.cwd] - Working directory
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
async function ps(options = {}) {
  const { cwd } = options;
  return compose(['ps'], { cwd });
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  // Main functions
  isDockerAvailable,
  isComposeAvailable,
  compose,
  logs,
  restart,
  pull,
  ps,

  // Validation functions (exported for testing)
  validateContainerName,
  validateComposeArgs,
  validateWorkingDirectory,
  validateTailOption,
  validateTimeout,

  // Error classes
  DockerError,
  DockerSecurityError,
  DockerCommandError,

  // Constants
  MAX_CONTAINER_NAME_LENGTH,
  MAX_TAIL_LINES,
  ALLOWED_COMPOSE_COMMANDS,
  DEFAULT_DOCKER_TIMEOUT_MS,
  QUICK_DOCKER_TIMEOUT_MS,
};
