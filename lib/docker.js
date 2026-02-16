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

  if (!VALID_CONTAINER_NAME.test(name)) {
    throw new DockerSecurityError(
      'Container name contains invalid characters. Only alphanumeric characters, ' +
      'hyphens, underscores, and dots are allowed. Must start with a letter or number.',
      'INVALID_CONTAINER_NAME_CHARS',
      { name }
    );
  }

  // Check for path traversal attempts (even though pattern should catch this)
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new DockerSecurityError(
      'Container name cannot contain path traversal sequences',
      'PATH_TRAVERSAL_DETECTED',
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
  if (normalized.startsWith('..') || normalized.includes('../')) {
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

  const numTail = Number(tail);

  if (!Number.isInteger(numTail)) {
    throw new DockerSecurityError(
      'Tail must be an integer',
      'INVALID_TAIL_TYPE'
    );
  }

  if (numTail < 0) {
    throw new DockerSecurityError(
      'Tail cannot be negative',
      'NEGATIVE_TAIL'
    );
  }

  if (numTail > MAX_TAIL_LINES) {
    throw new DockerSecurityError(
      `Tail exceeds maximum of ${MAX_TAIL_LINES} lines`,
      'TAIL_TOO_LARGE',
      { requested: numTail, max: MAX_TAIL_LINES }
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
    super(message, code, { exitCode, stdout: stdout.slice(0, 1000), stderr: stderr.slice(0, 1000) });
    this.name = 'DockerCommandError';
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

// =============================================================================
// Docker Operations
// =============================================================================

/**
 * Check if Docker is available
 * @returns {Promise<boolean>}
 */
async function isDockerAvailable() {
  return new Promise((resolve) => {
    const docker = spawn('docker', ['--version']);
    docker.on('close', (code) => {
      resolve(code === 0);
    });
    docker.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Check if Docker Compose is available
 * @returns {Promise<boolean>}
 */
async function isComposeAvailable() {
  return new Promise((resolve) => {
    const compose = spawn('docker-compose', ['--version']);
    compose.on('close', (code) => {
      resolve(code === 0);
    });
    compose.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Run Docker Compose with security validation
 * @param {string[]} args - Compose command arguments
 * @param {Object} options - Options
 * @param {string} [options.cwd] - Working directory
 * @param {boolean} [options.verbose=false] - Show output in real-time
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 * @throws {DockerSecurityError|DockerCommandError}
 */
async function compose(args, options = {}) {
  const { cwd, verbose = false } = options;

  // Validate arguments
  validateComposeArgs(args);
  validateWorkingDirectory(cwd);

  return new Promise((resolve, reject) => {
    const composeCmd = spawn('docker-compose', args, {
      cwd: cwd || undefined,
      stdio: verbose ? 'inherit' : 'pipe',
    });

    let stdout = '';
    let stderr = '';

    if (!verbose) {
      composeCmd.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      composeCmd.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    composeCmd.on('close', (code) => {
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
      reject(new DockerCommandError(
        `Failed to spawn docker-compose: ${err.message}`,
        'SPAWN_ERROR',
        -1
      ));
    });
  });
}

/**
 * Get container logs with security validation
 * @param {string} containerName - Container name
 * @param {Object} options - Options
 * @param {boolean} [options.follow=false] - Follow log output
 * @param {number} [options.tail=100] - Number of lines to show
 * @returns {Promise<string>}
 * @throws {DockerSecurityError|DockerCommandError}
 */
async function logs(containerName, options = {}) {
  const { follow = false, tail = 100 } = options;

  // Validate inputs
  validateContainerName(containerName);
  validateTailOption(tail);

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
    logsCmd.stdout.on('data', (data) => {
      output += data.toString();
    });

    logsCmd.stderr.on('data', (data) => {
      output += data.toString();
    });

    logsCmd.on('close', (code) => {
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

  // Error classes
  DockerError,
  DockerSecurityError,
  DockerCommandError,

  // Constants
  MAX_CONTAINER_NAME_LENGTH,
  MAX_TAIL_LINES,
  ALLOWED_COMPOSE_COMMANDS,
};
