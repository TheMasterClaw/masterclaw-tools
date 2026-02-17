/**
 * MasterClaw Container Execution Module
 * 
 * Provides secure command execution in running containers.
 * Similar to `kubectl exec` or `docker exec` but tailored for MasterClaw services.
 * 
 * Security features:
 * - Container name validation
 * - Command injection prevention
 * - Timeout enforcement
 * - Audit logging
 * - Allowed/disallowed command filtering
 */

const { spawn } = require('child_process');
const chalk = require('chalk');
const { validateContainerName, DockerSecurityError } = require('./docker');
const { logAuditEvent } = require('./audit');

// =============================================================================
// Security Constants
// =============================================================================

/** MasterClaw service containers that can be targeted */
const ALLOWED_CONTAINERS = new Set([
  'mc-core',
  'mc-backend',
  'mc-gateway',
  'mc-chroma',
  'mc-interface',
  'mc-traefik',
]);

/** Dangerous commands that are blocked */
const BLOCKED_COMMANDS = new Set([
  'rm', 'dd', 'mkfs', 'fdisk', 'format',
  'shred', 'wipe', 'del', 'format.com'
]);

/** Maximum command length */
const MAX_COMMAND_LENGTH = 4096;

/** Default execution timeout (5 minutes) */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Interactive shell timeout (30 minutes) */
const INTERACTIVE_TIMEOUT_MS = 30 * 60 * 1000;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Validates that a container is in the allowed list
 * @param {string} container - Container name
 * @throws {DockerSecurityError} If container is not allowed
 */
function validateAllowedContainer(container) {
  validateContainerName(container);
  
  if (!ALLOWED_CONTAINERS.has(container)) {
    throw new DockerSecurityError(
      `Container '${container}' is not in the allowed list. ` +
      `Allowed containers: ${Array.from(ALLOWED_CONTAINERS).join(', ')}`,
      'CONTAINER_NOT_ALLOWED',
      { container, allowed: Array.from(ALLOWED_CONTAINERS) }
    );
  }
}

/**
 * Validates command for security issues
 * @param {string[]} command - Command array
 * @throws {DockerSecurityError} If command is invalid or dangerous
 */
function validateCommand(command) {
  if (!Array.isArray(command) || command.length === 0) {
    throw new DockerSecurityError(
      'Command must be a non-empty array',
      'INVALID_COMMAND_FORMAT'
    );
  }

  // Check command length
  const fullCommand = command.join(' ');
  if (fullCommand.length > MAX_COMMAND_LENGTH) {
    throw new DockerSecurityError(
      `Command too long (max ${MAX_COMMAND_LENGTH} characters)`,
      'COMMAND_TOO_LONG',
      { length: fullCommand.length, max: MAX_COMMAND_LENGTH }
    );
  }

  // Check for blocked commands
  const baseCommand = command[0].toLowerCase();
  if (BLOCKED_COMMANDS.has(baseCommand)) {
    throw new DockerSecurityError(
      `Command '${baseCommand}' is blocked for security reasons`,
      'BLOCKED_COMMAND',
      { command: baseCommand }
    );
  }

  // Check for shell injection attempts
  const dangerousPattern = /[;&|`$(){}[\]<>]/;
  for (const arg of command) {
    if (dangerousPattern.test(arg)) {
      throw new DockerSecurityError(
        'Command contains potentially dangerous characters',
        'COMMAND_INJECTION_ATTEMPT',
        { argument: arg }
      );
    }
  }
}

/**
 * Checks if a container is running
 * @param {string} container - Container name
 * @returns {Promise<boolean>}
 */
async function isContainerRunning(container) {
  return new Promise((resolve, reject) => {
    const check = spawn('docker', ['ps', '--filter', `name=${container}`, '--format', '{{.Names}}']);
    
    let output = '';
    check.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    check.on('close', (code) => {
      if (code !== 0) {
        resolve(false);
        return;
      }
      resolve(output.trim() === container);
    });
    
    check.on('error', () => resolve(false));
  });
}

// =============================================================================
// Main Execution Functions
// =============================================================================

/**
 * Execute a command in a running container
 * 
 * @param {Object} options - Execution options
 * @param {string} options.container - Target container name
 * @param {string[]} options.command - Command to execute
 * @param {boolean} options.interactive - Whether to run in interactive mode
 * @param {boolean} options.tty - Whether to allocate TTY
 * @param {string} options.workdir - Working directory in container
 * @param {Object} options.env - Environment variables to set
 * @param {number} options.timeout - Timeout in milliseconds
 * @returns {Promise<Object>} Execution result
 */
async function execInContainer(options) {
  const {
    container,
    command,
    interactive = false,
    tty = false,
    workdir = null,
    env = {},
    timeout = interactive ? INTERACTIVE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
  } = options;

  // Validate inputs
  validateAllowedContainer(container);
  validateCommand(command);

  // Check if container is running
  const running = await isContainerRunning(container);
  if (!running) {
    throw new DockerSecurityError(
      `Container '${container}' is not running`,
      'CONTAINER_NOT_RUNNING',
      { container }
    );
  }

  // Build docker exec command
  const dockerArgs = ['exec'];
  
  if (interactive) dockerArgs.push('-i');
  if (tty) dockerArgs.push('-t');
  if (workdir) {
    // Validate workdir (prevent path traversal)
    if (workdir.includes('..') || workdir.includes('\\')) {
      throw new DockerSecurityError(
        'Invalid working directory',
        'INVALID_WORKDIR',
        { workdir }
      );
    }
    dockerArgs.push('-w', workdir);
  }
  
  // Add environment variables
  for (const [key, value] of Object.entries(env)) {
    // Validate env var name (alphanumeric and underscores only)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      throw new DockerSecurityError(
        `Invalid environment variable name: ${key}`,
        'INVALID_ENV_VAR',
        { key }
      );
    }
    dockerArgs.push('-e', `${key}=${value}`);
  }
  
  dockerArgs.push(container, ...command);

  // Log audit event
  await logAuditEvent('container_exec', {
    container,
    command: command.join(' '),
    interactive,
    workdir,
  });

  // Execute command
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const child = spawn('docker', dockerArgs, {
      stdio: interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      timeout,
    });

    let stdout = '';
    let stderr = '';

    if (!interactive) {
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('error', (error) => {
      reject(new DockerSecurityError(
        `Failed to execute command: ${error.message}`,
        'EXEC_FAILED',
        { error: error.message }
      ));
    });

    child.on('close', (code) => {
      const duration = Date.now() - startTime;
      
      if (interactive) {
        resolve({
          success: code === 0,
          exitCode: code,
          duration,
          interactive: true,
        });
      } else {
        resolve({
          success: code === 0,
          exitCode: code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          duration,
          interactive: false,
        });
      }
    });

    // Handle timeout
    child.on('timeout', () => {
      child.kill('SIGTERM');
      reject(new DockerSecurityError(
        `Command timed out after ${timeout}ms`,
        'EXEC_TIMEOUT',
        { timeout }
      ));
    });
  });
}

/**
 * Get list of running MasterClaw containers
 * @returns {Promise<Array<{name: string, status: string, uptime: string}>>}
 */
async function getRunningContainers() {
  return new Promise((resolve, reject) => {
    const containers = [];
    const filter = Array.from(ALLOWED_CONTAINERS).map(c => `--filter=name=${c}`);
    
    const ps = spawn('docker', ['ps', '--format', '{{.Names}}|{{.Status}}', ...filter]);
    
    let output = '';
    ps.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    ps.on('close', (code) => {
      if (code !== 0) {
        resolve([]);
        return;
      }
      
      const lines = output.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const [name, status] = line.split('|');
        if (name && ALLOWED_CONTAINERS.has(name)) {
          containers.push({
            name,
            status: 'running',
            uptime: status || 'unknown',
          });
        }
      }
      
      resolve(containers);
    });
    
    ps.on('error', () => resolve([]));
  });
}

/**
 * Execute a shell in a container (convenience method)
 * @param {string} container - Container name
 * @param {string} shell - Shell to use (sh, bash, etc.)
 */
async function shell(container, shell = 'sh') {
  // Validate shell
  const allowedShells = ['sh', 'bash', 'ash', 'zsh'];
  if (!allowedShells.includes(shell)) {
    throw new DockerSecurityError(
      `Shell '${shell}' is not allowed. Use: ${allowedShells.join(', ')}`,
      'SHELL_NOT_ALLOWED',
      { shell, allowed: allowedShells }
    );
  }

  return execInContainer({
    container,
    command: [shell],
    interactive: true,
    tty: true,
  });
}

// =============================================================================
// Module Exports
// =============================================================================

module.exports = {
  execInContainer,
  getRunningContainers,
  shell,
  ALLOWED_CONTAINERS,
  BLOCKED_COMMANDS,
  validateAllowedContainer,
  validateCommand,
  isContainerRunning,
};
