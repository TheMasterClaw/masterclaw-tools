/**
 * deps-validator.js - Command Dependency Validator for MasterClaw CLI
 *
 * Validates that command dependencies are satisfied before execution,
 * providing clear, actionable error messages when prerequisites are missing.
 *
 * Features:
 * - Pre-flight dependency checks for all commands
 * - Actionable remediation suggestions
 * - Cached results for performance
 * - Dependency chain validation
 * - Graceful degradation hints
 */

const { isDockerAvailable, isComposeAvailable } = require('./docker');
const { findInfraDir } = require('./services');
const { securityAudit } = require('./config');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// =============================================================================
// Dependency Types
// =============================================================================

const DependencyType = {
  DOCKER: 'docker',
  DOCKER_COMPOSE: 'docker-compose',
  INFRA_DIR: 'infra-dir',
  CONFIG: 'config',
  SERVICES_RUNNING: 'services-running',
  FILE: 'file',
  ENV_VAR: 'env-var',
  PERMISSION: 'permission',
  NETWORK: 'network',
  DISK_SPACE: 'disk-space',
  MEMORY: 'memory',
};

// =============================================================================
// Validation Results Cache
// =============================================================================

/** Cache for validation results to avoid repeated checks */
const validationCache = new Map();
const CACHE_TTL_MS = 5000; // 5 seconds

/**
 * Gets cached validation result or null if expired/missing
 * @param {string} key - Cache key
 * @returns {Object|null} - Cached result or null
 */
function getCachedValidation(key) {
  const cached = validationCache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    validationCache.delete(key);
    return null;
  }

  return cached.result;
}

/**
 * Caches a validation result
 * @param {string} key - Cache key
 * @param {Object} result - Validation result
 */
function cacheValidation(key, result) {
  validationCache.set(key, {
    result,
    timestamp: Date.now(),
  });
}

/**
 * Clears the validation cache
 * Useful for testing or when you want to force fresh validation
 * @param {string} [key] - Specific key to clear, or omit to clear all
 */
function clearValidationCache(key) {
  if (key) {
    validationCache.delete(key);
  } else {
    validationCache.clear();
  }
}

// =============================================================================
// Individual Validators
// =============================================================================

/**
 * Validates Docker is available and running
 * @returns {Promise<Object>} - Validation result
 */
async function validateDocker() {
  const cached = getCachedValidation('docker');
  if (cached) return cached;

  const available = await isDockerAvailable(5000);

  const result = {
    type: DependencyType.DOCKER,
    satisfied: available,
    severity: 'critical',
    message: available
      ? 'Docker is available and running'
      : 'Docker is not available or not running',
    remediation: available ? null : [
      'Install Docker: https://docs.docker.com/get-docker/',
      'Start Docker: sudo systemctl start docker (Linux)',
      'Or open Docker Desktop (Mac/Windows)',
    ],
    checkCommand: 'docker --version',
  };

  cacheValidation('docker', result);
  return result;
}

/**
 * Validates Docker Compose is available
 * @returns {Promise<Object>} - Validation result
 */
async function validateDockerCompose() {
  const cached = getCachedValidation('docker-compose');
  if (cached) return cached;

  const available = await isComposeAvailable(5000);

  const result = {
    type: DependencyType.DOCKER_COMPOSE,
    satisfied: available,
    severity: 'critical',
    message: available
      ? 'Docker Compose is available'
      : 'Docker Compose is not available',
    remediation: available ? null : [
      'Docker Compose is included with Docker Desktop (Mac/Windows)',
      'On Linux, install: sudo apt-get install docker-compose-plugin',
      'Or: pip install docker-compose',
    ],
    checkCommand: 'docker-compose --version',
  };

  cacheValidation('docker-compose', result);
  return result;
}

/**
 * Validates infrastructure directory exists
 * @returns {Promise<Object>} - Validation result
 */
async function validateInfraDir() {
  const cached = getCachedValidation('infra-dir');
  if (cached) return cached;

  const infraDir = await findInfraDir();
  const satisfied = !!infraDir;

  const result = {
    type: DependencyType.INFRA_DIR,
    satisfied,
    severity: 'critical',
    message: satisfied
      ? `Infrastructure directory found: ${infraDir}`
      : 'Infrastructure directory not found',
    remediation: satisfied ? null : [
      'Run from the masterclaw-infrastructure directory',
      'Or specify with: mc --infra-dir /path/to/infrastructure',
      'Clone the infrastructure repository if needed',
    ],
    currentDir: process.cwd(),
    infraDir: infraDir || null,
  };

  cacheValidation('infra-dir', result);
  return result;
}

/**
 * Validates configuration file exists and is secure
 * @returns {Promise<Object>} - Validation result
 */
async function validateConfig() {
  const cached = getCachedValidation('config');
  if (cached) return cached;

  try {
    const audit = await securityAudit();
    const satisfied = audit.secure;

    const result = {
      type: DependencyType.CONFIG,
      satisfied,
      severity: 'warning',
      message: satisfied
        ? 'Configuration is secure'
        : 'Configuration has security issues',
      remediation: satisfied ? null : [
        'Run: mc config-fix to fix permissions',
        'Review: mc config-audit for details',
      ],
      issues: audit.issues,
    };

    cacheValidation('config', result);
    return result;
  } catch (err) {
    const result = {
      type: DependencyType.CONFIG,
      satisfied: false,
      severity: 'warning',
      message: `Configuration validation failed: ${err.message}`,
      remediation: [
        'Ensure .env file exists: cp .env.example .env',
        'Run: mc validate to check configuration',
      ],
    };

    cacheValidation('config', result);
    return result;
  }
}

/**
 * Validates required environment variables
 * @param {string[]} envVars - Required environment variable names
 * @returns {Promise<Object>} - Validation result
 */
async function validateEnvVars(envVars = []) {
  const missing = [];
  const present = [];

  for (const envVar of envVars) {
    if (!process.env[envVar]) {
      missing.push(envVar);
    } else {
      present.push(envVar);
    }
  }

  return {
    type: DependencyType.ENV_VAR,
    satisfied: missing.length === 0,
    severity: 'critical',
    message: missing.length === 0
      ? `All required environment variables present (${present.join(', ')})`
      : `Missing environment variables: ${missing.join(', ')}`,
    remediation: missing.length === 0 ? null : missing.map(v =>
      `Set ${v}: export ${v}=<value> (add to ~/.bashrc or .env file)`
    ),
    missing,
    present,
  };
}

/**
 * Validates required files exist
 * @param {string[]} files - Required file paths
 * @returns {Promise<Object>} - Validation result
 */
async function validateFiles(files = []) {
  const missing = [];
  const present = [];

  for (const file of files) {
    if (!(await fs.pathExists(file))) {
      missing.push(file);
    } else {
      present.push(file);
    }
  }

  return {
    type: DependencyType.FILE,
    satisfied: missing.length === 0,
    severity: 'critical',
    message: missing.length === 0
      ? 'All required files present'
      : `Missing files: ${missing.join(', ')}`,
    remediation: missing.length === 0 ? null : missing.map(f =>
      `Create ${f} or check the path is correct`
    ),
    missing,
    present,
  };
}

/**
 * Validates disk space is available
 * @param {number} minSpaceGB - Minimum space required in GB
 * @returns {Promise<Object>} - Validation result
 */
async function validateDiskSpace(minSpaceGB = 1) {
  try {
    const { execSync } = require('child_process');
    const output = execSync('df -k .', { encoding: 'utf8', timeout: 5000 });
    const lines = output.trim().split('\n');
    const dataLine = lines[lines.length - 1];
    const parts = dataLine.split(/\s+/);
    const availableKB = parseInt(parts[3], 10);
    const availableGB = availableKB / (1024 * 1024);

    const satisfied = availableGB >= minSpaceGB;

    return {
      type: DependencyType.DISK_SPACE,
      satisfied,
      severity: 'warning',
      message: satisfied
        ? `Disk space available: ${availableGB.toFixed(2)} GB`
        : `Insufficient disk space: ${availableGB.toFixed(2)} GB (need ${minSpaceGB} GB)`,
      remediation: satisfied ? null : [
        'Free up disk space: docker system prune -a',
        'Clean old backups: mc backup cleanup',
        'Remove old logs: mc logs clean --all',
      ],
      availableGB,
      requiredGB: minSpaceGB,
    };
  } catch (err) {
    return {
      type: DependencyType.DISK_SPACE,
      satisfied: true, // Assume OK if we can't check
      severity: 'info',
      message: 'Could not verify disk space',
      remediation: null,
    };
  }
}

/**
 * Validates memory is available
 * @param {number} minMemoryMB - Minimum memory required in MB
 * @returns {Promise<Object>} - Validation result
 */
async function validateMemory(minMemoryMB = 512) {
  try {
    const totalMemoryMB = os.totalmem() / (1024 * 1024);
    const freeMemoryMB = os.freemem() / (1024 * 1024);

    const satisfied = freeMemoryMB >= minMemoryMB;

    return {
      type: DependencyType.MEMORY,
      satisfied,
      severity: 'warning',
      message: satisfied
        ? `Memory available: ${freeMemoryMB.toFixed(0)} MB free / ${totalMemoryMB.toFixed(0)} MB total`
        : `Low memory: ${freeMemoryMB.toFixed(0)} MB free (need ${minMemoryMB} MB)`,
      remediation: satisfied ? null : [
        'Close unnecessary applications',
        'Restart services: mc revive',
        'Consider upgrading your system memory',
      ],
      freeMemoryMB,
      totalMemoryMB,
      requiredMB: minMemoryMB,
    };
  } catch (err) {
    return {
      type: DependencyType.MEMORY,
      satisfied: true,
      severity: 'info',
      message: 'Could not verify memory',
      remediation: null,
    };
  }
}

// =============================================================================
// Command Dependency Definitions
// =============================================================================

/**
 * Dependency definitions for each command
 * Maps command names to their required dependencies
 */
const COMMAND_DEPENDENCIES = {
  'status': [DependencyType.DOCKER],
  'health': [DependencyType.DOCKER],
  'revive': [DependencyType.DOCKER, DependencyType.DOCKER_COMPOSE, DependencyType.INFRA_DIR],
  'deploy': [DependencyType.DOCKER, DependencyType.DOCKER_COMPOSE, DependencyType.INFRA_DIR],
  'logs': [DependencyType.DOCKER],
  'exec': [DependencyType.DOCKER],
  'backup': [DependencyType.DOCKER, DependencyType.INFRA_DIR],
  'restore': [DependencyType.DOCKER, DependencyType.INFRA_DIR],
  'validate': [DependencyType.INFRA_DIR],
  'config-audit': [],
  'config-fix': [],
  'cleanup': [],
  'info': [],
  'smoke-test': [],
  'benchmark': [],
};

// =============================================================================
// Main Validation Functions
// =============================================================================

/**
 * Validates dependencies for a specific command
 * @param {string} commandName - Name of the command
 * @param {Object} options - Validation options
 * @param {boolean} [options.fastFail=true] - Stop on first failure
 * @returns {Promise<Object>} - Validation results
 */
async function validateCommandDeps(commandName, options = {}) {
  const { fastFail = true } = options;

  const requiredDeps = COMMAND_DEPENDENCIES[commandName] || [];
  const results = [];
  const failures = [];

  for (const depType of requiredDeps) {
    let result;

    switch (depType) {
      case DependencyType.DOCKER:
        result = await validateDocker();
        break;
      case DependencyType.DOCKER_COMPOSE:
        result = await validateDockerCompose();
        break;
      case DependencyType.INFRA_DIR:
        result = await validateInfraDir();
        break;
      case DependencyType.CONFIG:
        result = await validateConfig();
        break;
      default:
        continue;
    }

    results.push(result);

    if (!result.satisfied) {
      failures.push(result);
      if (fastFail && result.severity === 'critical') {
        break;
      }
    }
  }

  return {
    command: commandName,
    satisfied: failures.filter(f => f.severity === 'critical').length === 0,
    results,
    failures,
    canProceed: failures.filter(f => f.severity === 'critical').length === 0,
  };
}

/**
 * Validates custom dependencies
 * @param {Array} dependencies - Array of dependency types or validator functions
 * @returns {Promise<Object>} - Validation results
 */
async function validateCustomDeps(dependencies = []) {
  const results = [];

  for (const dep of dependencies) {
    if (typeof dep === 'function') {
      results.push(await dep());
    } else if (typeof dep === 'string') {
      // Handle built-in dependency types
      switch (dep) {
        case DependencyType.DOCKER:
          results.push(await validateDocker());
          break;
        case DependencyType.DOCKER_COMPOSE:
          results.push(await validateDockerCompose());
          break;
        case DependencyType.INFRA_DIR:
          results.push(await validateInfraDir());
          break;
        case DependencyType.CONFIG:
          results.push(await validateConfig());
          break;
        case DependencyType.DISK_SPACE:
          results.push(await validateDiskSpace());
          break;
        case DependencyType.MEMORY:
          results.push(await validateMemory());
          break;
      }
    }
  }

  const failures = results.filter(r => !r.satisfied);

  return {
    satisfied: failures.filter(f => f.severity === 'critical').length === 0,
    results,
    failures,
  };
}

// =============================================================================
// Higher-Order Function for Command Wrapping
// =============================================================================

/**
 * Wraps a command handler with dependency validation
 * Usage: program.command('foo').action(withDeps('foo', async (options) => { ... }))
 *
 * @param {string} commandName - Command name for dependency lookup
 * @param {Function} handler - Async command handler
 * @param {Object} options - Validation options
 * @returns {Function} - Wrapped handler
 */
function withDeps(commandName, handler, options = {}) {
  const { skipValidation = false, customDeps = null } = options;

  return async (...args) => {
    if (skipValidation) {
      return handler(...args);
    }

    // Perform validation
    const validation = customDeps
      ? await validateCustomDeps(customDeps)
      : await validateCommandDeps(commandName, options);

    if (!validation.canProceed && !validation.satisfied) {
      const chalk = require('chalk');

      console.error(chalk.red(`\n❌ Cannot run '${commandName}': Missing dependencies\n`));

      for (const failure of validation.failures) {
        console.error(chalk.yellow(`  ⚠️  ${failure.message}`));
        if (failure.remediation) {
          for (const step of failure.remediation) {
            console.error(chalk.gray(`     → ${step}`));
          }
        }
        console.error();
      }

      // Exit with appropriate code
      process.exit(2);
      return; // Prevent further execution when exit is mocked in tests
    }

    // Log warnings for non-critical failures
    if (validation.failures && validation.failures.length > 0) {
      const chalk = require('chalk');
      const warnings = validation.failures.filter(f => f.severity !== 'critical');

      for (const warning of warnings) {
        console.warn(chalk.yellow(`⚠️  Warning: ${warning.message}`));
      }
    }

    // Execute the handler
    return handler(...args);
  };
}

// =============================================================================
// Export
// =============================================================================

module.exports = {
  // Validation functions
  validateDocker,
  validateDockerCompose,
  validateInfraDir,
  validateConfig,
  validateEnvVars,
  validateFiles,
  validateDiskSpace,
  validateMemory,
  validateCommandDeps,
  validateCustomDeps,

  // Higher-order function
  withDeps,

  // Constants
  DependencyType,
  COMMAND_DEPENDENCIES,

  // Cache utilities
  getCachedValidation,
  cacheValidation,
  clearValidationCache,
};
