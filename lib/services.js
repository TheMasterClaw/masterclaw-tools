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
 * Check if a service is running via HTTP health endpoint
 * @param {string} name - Service name (must be a key in SERVICES)
 * @param {Object} config - Service configuration
 * @returns {Promise<Object>} - Service status object
 */
async function checkService(name, config) {
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
    const response = await axios.get(`${config.url}/health`, {
      timeout: MAX_HTTP_TIMEOUT,
      validateStatus: () => true
    });
    const responseTime = Date.now() - start;

    return {
      name: config.name,
      status: response.status === 200 ? 'healthy' : 'unhealthy',
      port: config.port,
      url: config.url,
      responseTime: `${responseTime}ms`,
      statusCode: response.status,
    };
  } catch (error) {
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
 * @returns {Promise<Array>} - Array of container objects
 */
async function checkDockerContainers() {
  return new Promise((resolve) => {
    // Use --filter to limit output and prevent parsing issues
    const docker = spawn('docker', ['ps', '--filter', 'name=mc-*', '--format', '{{.Names}}|{{.Status}}']);
    let output = '';

    docker.stdout.on('data', (data) => {
      output += data.toString();
    });

    docker.on('close', (code) => {
      if (code !== 0) {
        resolve([]);
        return;
      }

      const containers = output.trim().split('\n')
        .filter(line => line.trim())
        .map(line => {
          const [name, status] = line.split('|');
          return { name, status };
        })
        .filter(c => {
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
    docker.on('error', () => {
      resolve([]);
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

/**
 * Run Docker Compose command with security validation
 * @param {string[]} args - Compose command arguments (validated)
 * @param {string} cwd - Working directory (optional)
 * @returns {Promise<Object>} - Command result with stdout, stderr, code
 * @throws {DockerSecurityError|DockerCommandError} - On validation or execution failure
 */
async function runDockerCompose(args, cwd = process.cwd()) {
  // Validate arguments for security
  try {
    validateComposeArgs(args);
    validateWorkingDirectory(cwd);
  } catch (err) {
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    const compose = spawn('docker-compose', args, {
      cwd,
      stdio: 'pipe'
    });

    let stdout = '';
    let stderr = '';

    compose.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    compose.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    compose.on('close', (code) => {
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
      reject(new DockerCommandError(
        `Failed to spawn docker-compose: ${err.message}`,
        'SPAWN_ERROR',
        -1
      ));
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
  checkService,
  checkDockerContainers,
  getAllStatuses,
  runDockerCompose,
  findInfraDir,
  validateServiceName,
  validateServiceNames,
  chalk,
  axios,
};
