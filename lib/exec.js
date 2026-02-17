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
  'shred', 'wipe', 'del', 'format.com',
  // Additional destructive commands
  'mkfs.ext4', 'mkfs.ext3', 'mkfs.ext2', 'mkfs.xfs', 'mkfs.btrfs',
  'mkswap', 'swapoff', 'swapon',
  'parted', 'partprobe', 'sfdisk', 'cfdisk',
  'hdparm', 'badblocks',
  'fsck', 'e2fsck', 'xfs_repair',
  'debugfs', 'tune2fs', 'resize2fs',
  'pvcreate', 'pvremove', 'vgremove', 'lvremove',
]);

/** Shell interpreters that accept command strings */
const SHELL_INTERPRETERS = new Set([
  'sh', 'bash', 'ash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh'
]);

/** Shell options that accept command strings */
const SHELL_COMMAND_OPTIONS = new Set([
  '-c', '--command',
]);

/** Blocked subcommands within shell command strings */
const BLOCKED_SUBCOMMANDS = new Set([
  'rm', 'dd', 'mkfs', 'fdisk', 'format', 'shred', 'wipe',
  'mkfs.ext4', 'mkfs.ext3', 'mkfs.xfs', 'mkfs.btrfs',
  'mkswap', 'swapoff',
  'parted', 'sfdisk',
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

  // Check for shell command injection attempts
  validateShellCommand(command);
}

/**
 * Validates shell command strings for dangerous subcommands
 * Detects when shells are invoked with -c/--command and validates the command string
 * 
 * @param {string[]} command - Command array
 * @throws {DockerSecurityError} If shell command injection is detected
 */
function validateShellCommand(command) {
  const baseCommand = command[0].toLowerCase();
  
  // Only check shell interpreters
  if (!SHELL_INTERPRETERS.has(baseCommand)) {
    // Not a shell, use regular validation
    checkDangerousCharacters(command);
    return;
  }

  // Parse shell arguments to find -c/--command options
  for (let i = 1; i < command.length; i++) {
    const arg = command[i];
    
    // Check if this is a command option
    if (SHELL_COMMAND_OPTIONS.has(arg)) {
      // The next argument is the command string
      const commandString = command[i + 1];
      if (commandString !== undefined) {
        validateShellCommandString(commandString);
        // Skip validation of the command string itself
        i++;
      }
    } else if (arg.startsWith('-c')) {
      // Handle combined form: -c'command' or -c"command"
      const inlineCommand = arg.slice(2);
      if (inlineCommand) {
        validateShellCommandString(inlineCommand);
      } else {
        // Next argument is the command
        const commandString = command[i + 1];
        if (commandString !== undefined) {
          validateShellCommandString(commandString);
          i++;
        }
      }
    } else if (!arg.startsWith('-')) {
      // Not an option, check for dangerous characters in positional args
      if (/[;&|`$(){}[\]<>]/.test(arg)) {
        throw new DockerSecurityError(
          'Command argument contains potentially dangerous characters',
          'COMMAND_INJECTION_ATTEMPT',
          { argument: arg }
        );
      }
    }
    // Other options (-e, -u, etc.) are allowed
  }
}

/**
 * Validates a shell command string for dangerous subcommands
 * 
 * @param {string} commandString - Shell command string to validate
 * @throws {DockerSecurityError} If dangerous subcommands are detected
 */
function validateShellCommandString(commandString) {
  if (typeof commandString !== 'string') {
    return;
  }

  // Check for command chaining operators that could bypass blocked commands
  const chainingOperators = /[;&|]|`[^`]*`|\$\([^)]*\)|\$\{[^}]*\}/;
  if (chainingOperators.test(commandString)) {
    throw new DockerSecurityError(
      'Shell command string contains command chaining operators (;&|) or command substitution',
      'SHELL_COMMAND_CHAINING_DETECTED',
      { 
        commandString: commandString.substring(0, 100),
        reason: 'Command chaining and substitution are not allowed for security'
      }
    );
  }

  // Check for blocked subcommands at the start or after common separators
  const normalizedCommand = commandString.trim().toLowerCase();
  
  for (const blockedCmd of BLOCKED_SUBCOMMANDS) {
    // Check if command starts with blocked command
    if (normalizedCommand.startsWith(blockedCmd + ' ') || 
        normalizedCommand === blockedCmd) {
      throw new DockerSecurityError(
        `Shell command contains blocked subcommand '${blockedCmd}'`,
        'BLOCKED_SUBCOMMAND',
        { 
          blockedCommand: blockedCmd,
          commandString: commandString.substring(0, 100)
        }
      );
    }
    
    // Check if blocked command follows common shell constructs
    const separatorPatterns = [
      new RegExp(`(^|[;|&]|&&|\|\|)\\s*${blockedCmd}\\b`),
      new RegExp(`\\$\\(${blockedCmd}\\b`),
      new RegExp(`\\\`${blockedCmd}\\b`),
    ];
    
    for (const pattern of separatorPatterns) {
      if (pattern.test(normalizedCommand)) {
        throw new DockerSecurityError(
          `Shell command contains blocked subcommand '${blockedCmd}' after separator`,
          'BLOCKED_SUBCOMMAND',
          { 
            blockedCommand: blockedCmd,
            commandString: commandString.substring(0, 100)
          }
        );
      }
    }
  }

  // Check for path traversal in shell commands
  if (/\.\.[\/\\]/.test(commandString) || /~[\/\\]/.test(commandString)) {
    throw new DockerSecurityError(
      'Shell command contains potential path traversal',
      'PATH_TRAVERSAL_IN_SHELL_COMMAND',
      { commandString: commandString.substring(0, 100) }
    );
  }
}

/**
 * Check for dangerous shell injection characters in non-shell commands
 * 
 * @param {string[]} command - Command array
 * @throws {DockerSecurityError} If dangerous characters are detected
 */
function checkDangerousCharacters(command) {
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
  SHELL_INTERPRETERS,
  SHELL_COMMAND_OPTIONS,
  BLOCKED_SUBCOMMANDS,
  validateAllowedContainer,
  validateCommand,
  validateShellCommand,
  validateShellCommandString,
  checkDangerousCharacters,
  isContainerRunning,
};
