const chalk = require('chalk');
const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

// Import security validation functions from docker module
const {
  validateContainerName,
  validateComposeArgs,
  validateWorkingDirectory,
  DockerSecurityError,
  DockerCommandError,
} = require('./docker');

// Import circuit breaker for resilient service calls
const { executeWithCircuit, getCircuit, CircuitBreakerOpenError } = require('./circuit-breaker');

// Import logger for structured logging
const logger = require('./logger').child('services');

// Service configuration
const SERVICES = {
  interface: { port: 3000, name: 'Interface', url: 'http://localhost:3000' },
  backend: { port: 3001, name: 'Backend API', url: 'http://localhost:3001' },
  core: { port: 8000, name: 'AI Core', url: 'http://localhost:8000' },
  gateway: { port: 3000, name: 'Gateway', url: 'http://localhost:3000' },
};

/** Valid service names for validation */
const VALID_SERVICE_NAMES = new Set(Object.keys(SERVICES));

/** Maximum HTTP request timeout in ms (prevent hanging requests) */
const MAX_HTTP_TIMEOUT = 10000;

/** Maximum allowed Docker PS output lines (prevent DoS) */
const MAX_PS_LINES = 1000;

/** Maximum output buffer size in bytes (10MB) */
const MAX_OUTPUT_BUFFER_SIZE = 10 * 1024 * 1024;

// =============================================================================
// Retry Configuration
// =============================================================================

/** Default retry configuration for resilient health checks */
const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  retryableStatuses: [502, 503, 504], // Bad Gateway, Service Unavailable, Gateway Timeout
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'],
};

// =============================================================================
// Retry Logic with Exponential Backoff
// =============================================================================

/**
 * Sleeps for the specified duration
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Determines if an error is retryable based on configuration
 * @param {Error} error - The error that occurred
 * @param {Object} config - Retry configuration
 * @returns {boolean} - True if the error is retryable
 */
function isRetryableError(error, config) {
  // Handle null/undefined errors
  if (!error) {
    return false;
  }

  // Check for network-level errors that are typically transient
  if (error.code && config.retryableErrors.includes(error.code)) {
    return true;
  }

  // Check for HTTP status codes that indicate temporary unavailability
  if (error.response && config.retryableStatuses.includes(error.response.status)) {
    return true;
  }

  // Timeout errors are typically retryable
  if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
    return true;
  }

  return false;
}

/**
 * Calculates delay with exponential backoff and jitter
 * @param {number} attempt - Current attempt number (0-indexed)
 * @param {Object} config - Retry configuration
 * @returns {number} - Delay in milliseconds
 */
function calculateBackoffDelay(attempt, config) {
  // Calculate base delay with exponential backoff
  const baseDelay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);

  // Add jitter (±25%) to prevent thundering herd
  const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);

  // Clamp to max delay
  return Math.min(baseDelay + jitter, config.maxDelayMs);
}

/**
 * Executes an async function with retry logic
 * @param {Function} fn - Async function to execute
 * @param {Object} options - Retry options
 * @param {string} operationName - Name of the operation for logging
 * @returns {Promise<any>} - Result of the function
 * @throws {Error} - Last error if all retries exhausted
 */
async function withRetry(fn, options = {}, operationName = 'operation') {
  const config = { ...DEFAULT_RETRY_CONFIG, ...options };
  const errors = [];

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const result = await fn();

      // Log success after retries
      if (attempt > 0) {
        logger.debug(`${operationName} succeeded after ${attempt + 1} attempts`);
      }

      return result;
    } catch (error) {
      errors.push(error);

      // Check if we should retry
      if (attempt >= config.maxRetries) {
        logger.debug(`${operationName} failed after ${attempt + 1} attempts`);
        throw error;
      }

      // Check if error is retryable
      if (!isRetryableError(error, config)) {
        logger.debug(`${operationName} failed with non-retryable error: ${error.message}`);
        throw error;
      }

      // Calculate delay and wait
      const delay = calculateBackoffDelay(attempt, config);
      logger.debug(`${operationName} attempt ${attempt + 1} failed, retrying in ${delay.toFixed(0)}ms: ${error.message}`);
      await sleep(delay);
    }
  }

  // This should never be reached, but just in case
  throw errors[errors.length - 1];
}

// =============================================================================
// Security Validation Functions
// =============================================================================

/**
 * Validates service name to prevent injection attacks
 * @param {string} name - Service name to validate
 * @returns {boolean} - True if valid
 * @throws {DockerSecurityError} - If name is invalid
 */
function validateServiceName(name) {
  if (typeof name !== 'string') {
    throw new DockerSecurityError(
      'Service name must be a string',
      'INVALID_SERVICE_NAME_TYPE',
      { provided: typeof name }
    );
  }

  if (!VALID_SERVICE_NAMES.has(name)) {
    throw new DockerSecurityError(
      `Unknown service: ${name}`,
      'UNKNOWN_SERVICE',
      { validServices: Array.from(VALID_SERVICE_NAMES) }
    );
  }

  return true;
}

/**
 * Validates that an array of service names are all valid
 * @param {string[]} names - Array of service names
 * @returns {boolean} - True if all valid
 * @throws {DockerSecurityError} - If any name is invalid
 */
function validateServiceNames(names) {
  if (!Array.isArray(names)) {
    throw new DockerSecurityError(
      'Service names must be an array',
      'INVALID_SERVICE_NAMES_TYPE'
    );
  }

  for (const name of names) {
    validateServiceName(name);
  }

  return true;
}

// =============================================================================
// Service Operations
// =============================================================================

/**
 * Circuit breaker configuration for service health checks
 * More conservative than defaults to fail fast when services are unstable
 */
const SERVICE_CIRCUIT_CONFIG = {
  failureThreshold: 3,
  resetTimeoutMs: 15000,
  successThreshold: 2,
  errorRateThreshold: 60,
};

/**
 * Check if a service is running via HTTP health endpoint
 * Includes circuit breaker protection for resilience
 * @param {string} name - Service name (must be a key in SERVICES)
 * @param {Object} config - Service configuration
 * @param {Object} retryOptions - Optional retry configuration
 * @returns {Promise<Object>} - Service status object
 */
async function checkService(name, config, retryOptions = {}) {
  // Validate service name for security
  try {
    validateServiceName(name);
  } catch (err) {
    return {
      name: name || 'unknown',
      status: 'error',
      error: err.message,
      port: config?.port,
      url: config?.url,
    };
  }

  try {
    const start = Date.now();

    // Use circuit breaker + retry logic for resilient health checks
    const result = await executeWithCircuit(
      `service-${name}`,
      async () => {
        return withRetry(
          async () => {
            return axios.get(`${config.url}/health`, {
              timeout: MAX_HTTP_TIMEOUT,
              validateStatus: () => true
            });
          },
          { ...DEFAULT_RETRY_CONFIG, ...retryOptions },
          `health check for ${config.name}`
        );
      },
      {
        circuitConfig: SERVICE_CIRCUIT_CONFIG,
        throwOnOpen: true,
      }
    );

    const response = result.result;
    const responseTime = Date.now() - start;

    return {
      name: config.name,
      status: response.status === 200 ? 'healthy' : 'unhealthy',
      port: config.port,
      url: config.url,
      responseTime: `${responseTime}ms`,
      statusCode: response.status,
      circuitState: result.circuitState,
    };
  } catch (error) {
    // Handle circuit breaker open state
    if (error instanceof CircuitBreakerOpenError) {
      return {
        name: config.name,
        status: 'unavailable',
        port: config.port,
        url: config.url,
        error: `Service temporarily unavailable (circuit open, retry in ${Math.ceil(error.retryAfterMs / 1000)}s)`,
        circuitOpen: true,
        circuitState: 'OPEN',
      };
    }

    return {
      name: config.name,
      status: 'down',
      port: config.port,
      url: config.url,
      error: error.code || error.message,
    };
  }
}

/**
 * Check Docker containers with security validation
 * Filters to only MasterClaw containers (mc-* prefix)
 * Includes DoS protection via output size limits
 * @returns {Promise<Array>} - Array of container objects
 * @throws {DockerSecurityError} - If output exceeds safety limits
 */
async function checkDockerContainers() {
  return new Promise((resolve, reject) => {
    // Use --filter to limit output and prevent parsing issues
    const docker = spawn('docker', ['ps', '--filter', 'name=mc-*', '--format', '{{.Names}}|{{.Status}}']);
    let output = '';
    let lineCount = 0;
    let bufferExceeded = false;

    docker.stdout.on('data', (data) => {
      // Security: Prevent memory exhaustion from excessive output
      if (bufferExceeded) {
        return;
      }

      const chunk = data.toString();

      // Check buffer size limit
      if (output.length + chunk.length > MAX_OUTPUT_BUFFER_SIZE) {
        bufferExceeded = true;
        docker.kill();
        reject(new DockerSecurityError(
          `Docker ps output exceeded maximum buffer size (${MAX_OUTPUT_BUFFER_SIZE} bytes)`,
          'OUTPUT_BUFFER_EXCEEDED',
          { maxSize: MAX_OUTPUT_BUFFER_SIZE }
        ));
        return;
      }

      output += chunk;
      lineCount += (chunk.match(/\n/g) || []).length;

      // Security: Prevent DoS from excessive lines
      if (lineCount > MAX_PS_LINES) {
        bufferExceeded = true;
        docker.kill();
        reject(new DockerSecurityError(
          `Docker ps output exceeded maximum line count (${MAX_PS_LINES} lines)`,
          'OUTPUT_LINE_LIMIT_EXCEEDED',
          { maxLines: MAX_PS_LINES, actualLines: lineCount }
        ));
        return;
      }
    });

    docker.on('close', (code) => {
      if (bufferExceeded) {
        // Already rejected above
        return;
      }

      if (code !== 0) {
        resolve([]);
        return;
      }

      const containers = output.trim().split('\n')
        .filter(line => line.trim())
        .slice(0, MAX_PS_LINES) // Extra safety: hard limit on processing
        .map(line => {
          const parts = line.split('|');
          // Validate expected format (name|status)
          if (parts.length < 2) {
            return null;
          }
          return { name: parts[0], status: parts[1] };
        })
        .filter(c => {
          if (!c) return false;
          // Additional validation: ensure name starts with mc- and is a valid container name
          if (!c.name || !c.name.startsWith('mc-')) {
            return false;
          }
          try {
            validateContainerName(c.name.substring(3)); // Validate without 'mc-' prefix
            return true;
          } catch {
            return false;
          }
        });

      resolve(containers);
    });

    // Handle spawn errors gracefully
    docker.on('error', (err) => {
      resolve([]);
    });

    // Timeout protection: kill after 30 seconds
    const timeout = setTimeout(() => {
      docker.kill();
      reject(new DockerCommandError(
        'Docker ps command timed out after 30 seconds',
        'DOCKER_PS_TIMEOUT',
        -1
      ));
    }, 30000);

    docker.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

// Get all service statuses
async function getAllStatuses() {
  const results = [];

  for (const [key, config] of Object.entries(SERVICES)) {
    const status = await checkService(key, config);
    results.push(status);
  }

  return results;
}

/** Default timeout for Docker Compose commands (5 minutes) */
const COMPOSE_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum output buffer size for Docker Compose (10MB) */
const COMPOSE_MAX_BUFFER_SIZE = 10 * 1024 * 1024;

/**
 * Run Docker Compose command with security validation and timeout protection
 * @param {string[]} args - Compose command arguments (validated)
 * @param {string} cwd - Working directory (optional)
 * @param {Object} options - Additional options
 * @param {number} options.timeout - Timeout in milliseconds (default: 5 minutes)
 * @returns {Promise<Object>} - Command result with stdout, stderr, code
 * @throws {DockerSecurityError|DockerCommandError} - On validation or execution failure
 */
async function runDockerCompose(args, cwd = process.cwd(), options = {}) {
  // Validate arguments for security
  try {
    validateComposeArgs(args);
    validateWorkingDirectory(cwd);
  } catch (err) {
    return Promise.reject(err);
  }

  const timeoutMs = options.timeout || COMPOSE_TIMEOUT_MS;
  let bufferExceeded = false;

  return new Promise((resolve, reject) => {
    const compose = spawn('docker-compose', args, {
      cwd,
      stdio: 'pipe'
    });

    let stdout = '';
    let stderr = '';
    let stdoutSize = 0;
    let stderrSize = 0;

    // Security: Buffer size limits to prevent memory exhaustion
    compose.stdout.on('data', (data) => {
      if (bufferExceeded) return;

      const chunkSize = data.length;
      if (stdoutSize + chunkSize > COMPOSE_MAX_BUFFER_SIZE) {
        bufferExceeded = true;
        compose.kill();
        reject(new DockerSecurityError(
          `Docker Compose stdout exceeded maximum buffer size (${COMPOSE_MAX_BUFFER_SIZE} bytes)`,
          'COMPOSE_OUTPUT_BUFFER_EXCEEDED',
          { maxSize: COMPOSE_MAX_BUFFER_SIZE, actualSize: stdoutSize + chunkSize }
        ));
        return;
      }
      stdout += data.toString();
      stdoutSize += chunkSize;
    });

    compose.stderr.on('data', (data) => {
      if (bufferExceeded) return;

      const chunkSize = data.length;
      if (stderrSize + chunkSize > COMPOSE_MAX_BUFFER_SIZE) {
        bufferExceeded = true;
        compose.kill();
        reject(new DockerSecurityError(
          `Docker Compose stderr exceeded maximum buffer size (${COMPOSE_MAX_BUFFER_SIZE} bytes)`,
          'COMPOSE_OUTPUT_BUFFER_EXCEEDED',
          { maxSize: COMPOSE_MAX_BUFFER_SIZE, actualSize: stderrSize + chunkSize }
        ));
        return;
      }
      stderr += data.toString();
      stderrSize += chunkSize;
    });

    compose.on('close', (code) => {
      if (bufferExceeded) return;

      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new DockerCommandError(
          `Docker Compose failed with exit code ${code}`,
          'COMPOSE_FAILED',
          code,
          stdout,
          stderr
        ));
      }
    });

    // Handle spawn errors
    compose.on('error', (err) => {
      if (bufferExceeded) return;
      reject(new DockerCommandError(
        `Failed to spawn docker-compose: ${err.message}`,
        'SPAWN_ERROR',
        -1
      ));
    });

    // Security: Timeout protection to prevent hanging processes
    const timeout = setTimeout(() => {
      if (bufferExceeded) return;
      compose.kill();
      reject(new DockerCommandError(
        `Docker Compose command timed out after ${timeoutMs}ms`,
        'COMPOSE_TIMEOUT',
        -1,
        stdout,
        stderr
      ));
    }, timeoutMs);

    // Clear timeout on completion
    compose.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

/**
 * Find infrastructure directory with path validation
 * @returns {Promise<string|null>} - Path to infrastructure directory or null
 */
async function findInfraDir() {
  const possiblePaths = [
    path.join(process.cwd(), 'masterclaw-infrastructure'),
    path.join(process.cwd(), '../masterclaw-infrastructure'),
    path.join(require('os').homedir(), 'masterclaw-infrastructure'),
    '/opt/masterclaw-infrastructure',
  ];

  for (const dir of possiblePaths) {
    // Validate path before using
    try {
      validateWorkingDirectory(dir);
      if (await fs.pathExists(path.join(dir, 'docker-compose.yml'))) {
        return dir;
      }
    } catch {
      // Skip invalid paths
      continue;
    }
  }

  return null;
}

module.exports = {
  SERVICES,
  VALID_SERVICE_NAMES,
  MAX_HTTP_TIMEOUT,
  MAX_PS_LINES,
  MAX_OUTPUT_BUFFER_SIZE,
  COMPOSE_TIMEOUT_MS,
  COMPOSE_MAX_BUFFER_SIZE,
  DEFAULT_RETRY_CONFIG,
  SERVICE_CIRCUIT_CONFIG,
  checkService,
  checkDockerContainers,
  getAllStatuses,
  runDockerCompose,
  findInfraDir,
  validateServiceName,
  validateServiceNames,
  // Retry utilities (exported for testing)
  withRetry,
  sleep,
  isRetryableError,
  calculateBackoffDelay,
  // Export error classes for consumers
  DockerSecurityError,
  DockerCommandError,
  CircuitBreakerOpenError,
  chalk,
  axios,
};
