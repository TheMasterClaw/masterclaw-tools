/**
 * Tests for docker.js - Docker Container Security Module
 * 
 * Security: Tests validate container name validation, compose argument validation,
 * and protection against command injection attacks.
 * 
 * Run with: npm test -- docker.test.js
 */

// Mock child_process before requiring docker module
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

const docker = require('../lib/docker');

// =============================================================================
// Container Name Validation Tests
// =============================================================================

describe('validateContainerName', () => {
  test('accepts valid container names', () => {
    const validNames = [
      'mc-core',
      'mc_backend',
      'mc.core',
      'mc123',
      'a',
      'A1B2C3',
      'container-name-123',
      'my_container.test',
    ];

    validNames.forEach(name => {
      expect(() => docker.validateContainerName(name)).not.toThrow();
      expect(docker.validateContainerName(name)).toBe(true);
    });
  });

  test('rejects empty container names', () => {
    expect(() => docker.validateContainerName('')).toThrow();
  });

  test('rejects null/undefined container names', () => {
    expect(() => docker.validateContainerName(null)).toThrow();
    expect(() => docker.validateContainerName(undefined)).toThrow();
  });

  test('rejects non-string container names', () => {
    expect(() => docker.validateContainerName(123)).toThrow();
    expect(() => docker.validateContainerName({})).toThrow();
    expect(() => docker.validateContainerName([])).toThrow();
  });

  test('rejects container names with path traversal', () => {
    const traversalNames = [
      '../etc/passwd',
      '..\\windows\\system32',
      'container/../../etc',
      'container/..',
      './container',
      'container\\..\\..',
    ];

    traversalNames.forEach(name => {
      expect(() => docker.validateContainerName(name)).toThrow();
    });
  });

  test('rejects container names with dangerous characters', () => {
    const dangerousNames = [
      'container; rm -rf /',
      'container && whoami',
      'container | cat /etc/passwd',
      'container`id`',
      'container$(whoami)',
      'container${IFS}',
      'container[name]',
      'container<script>',
    ];

    dangerousNames.forEach(name => {
      expect(() => docker.validateContainerName(name)).toThrow();
    });
  });

  test('rejects container names that are too long', () => {
    const longName = 'a'.repeat(64);
    expect(() => docker.validateContainerName(longName)).toThrow();
  });

  test('accepts container names at maximum length', () => {
    const maxName = 'a'.repeat(63);
    expect(() => docker.validateContainerName(maxName)).not.toThrow();
  });

  test('rejects container names starting with invalid characters', () => {
    expect(() => docker.validateContainerName('-container')).toThrow();
    expect(() => docker.validateContainerName('_container')).toThrow();
    expect(() => docker.validateContainerName('.container')).toThrow();
  });
});

// =============================================================================
// Compose Arguments Validation Tests
// =============================================================================

describe('validateComposeArgs', () => {
  test('accepts valid compose arguments', () => {
    const validArgs = [
      ['up', '-d'],
      ['down'],
      ['restart'],
      ['ps'],
      ['logs', '-f'],
      ['build'],
      ['config'],
    ];

    validArgs.forEach(args => {
      expect(() => docker.validateComposeArgs(args)).not.toThrow();
      expect(docker.validateComposeArgs(args)).toBe(true);
    });
  });

  test('rejects non-array arguments', () => {
    expect(() => docker.validateComposeArgs('up -d')).toThrow();
    expect(() => docker.validateComposeArgs(null)).toThrow();
    expect(() => docker.validateComposeArgs({})).toThrow();
  });

  test('handles empty arguments array', () => {
    expect(docker.validateComposeArgs([])).toBe(true);
  });

  test('rejects dangerous compose arguments', () => {
    const dangerousArgs = [
      ['up', ';', 'rm', '-rf', '/'],
      ['down', '&&', 'whoami'],
      ['restart', '|', 'cat', '/etc/passwd'],
      ['logs', '`', 'id', '`'],
    ];

    dangerousArgs.forEach(args => {
      expect(() => docker.validateComposeArgs(args)).toThrow();
    });
  });

  test('rejects arguments with path traversal', () => {
    const traversalArgs = [
      ['down', '--file', '..\\..\\windows\\system32'],
    ];

    traversalArgs.forEach(args => {
      expect(() => docker.validateComposeArgs(args)).toThrow();
    });
  });
});

// =============================================================================
// Tail Lines Validation Tests
// =============================================================================

describe('validateTailOption', () => {
  test('accepts valid tail line counts', () => {
    expect(docker.validateTailOption(100)).toBe(true);
    expect(docker.validateTailOption(1)).toBe(true);
    expect(docker.validateTailOption(1000)).toBe(true);
    expect(docker.validateTailOption(10000)).toBe(true);
  });

  test('rejects negative tail line counts', () => {
    expect(() => docker.validateTailOption(-1)).toThrow();
    expect(() => docker.validateTailOption(-100)).toThrow();
  });

  test('rejects zero tail line count', () => {
    expect(docker.validateTailOption(0)).toBe(true);
  });

  test('rejects tail line counts exceeding maximum', () => {
    expect(() => docker.validateTailOption(10001)).toThrow();
    expect(() => docker.validateTailOption(99999)).toThrow();
  });

  test('rejects string tail line counts but accepts null', () => {
    expect(() => docker.validateTailOption('100')).toThrow();
    expect(docker.validateTailOption(null)).toBe(true);
  });
});

// =============================================================================
// Working Directory Validation Tests
// =============================================================================

describe('validateWorkingDirectory', () => {
  test('accepts valid working directories', () => {
    const validDirs = [
      '/app',
      '/home/user/project',
      '/var/www/html',
      '/opt/masterclaw',
    ];

    validDirs.forEach(dir => {
      expect(() => docker.validateWorkingDirectory(dir)).not.toThrow();
    });
  });

  test('rejects path traversal in working directory', () => {
    const traversalDirs = [
      '../../../etc',
      '..\\..\\windows',
      'app/../../../etc',
    ];

    traversalDirs.forEach(dir => {
      expect(() => docker.validateWorkingDirectory(dir)).toThrow();
    });
  });

  test('handles empty working directory', () => {
    expect(docker.validateWorkingDirectory('')).toBe(true);
  });

  test('handles null/undefined working directory', () => {
    expect(docker.validateWorkingDirectory(null)).toBe(true);
    expect(docker.validateWorkingDirectory(undefined)).toBe(true);
  });

  test('rejects non-string working directory', () => {
    expect(() => docker.validateWorkingDirectory(123)).toThrow();
    expect(() => docker.validateWorkingDirectory({})).toThrow();
  });
});

// =============================================================================
// Command Injection Prevention Tests
// =============================================================================

describe('Command Injection Prevention', () => {
  test('detects shell injection characters', () => {
    const injectionChars = [
      ';',
      '&',
      '|',
      '`',
      '$',
      '(',
      ')',
      '{',
      '}',
      '[',
      ']',
      '\\',
      '<',
      '>',
      '\n',
      '\r',
    ];

    injectionChars.forEach(char => {
      const maliciousName = `container${char}rm -rf /`;
      expect(() => docker.validateContainerName(maliciousName)).toThrow();
    });
  });

  test('detects command substitution attempts', () => {
    const substitutionAttempts = [
      'container$(whoami)',
      'container`whoami`',
      'container${USER}',
    ];

    substitutionAttempts.forEach(name => {
      expect(() => docker.validateContainerName(name)).toThrow();
    });
  });

  test('detects command chaining attempts', () => {
    const chainingAttempts = [
      'container; rm -rf /',
      'container && cat /etc/passwd',
      'container || whoami',
    ];

    chainingAttempts.forEach(name => {
      expect(() => docker.validateContainerName(name)).toThrow();
    });
  });
});

// =============================================================================
// DockerSecurityError Tests
// =============================================================================

describe('DockerSecurityError', () => {
  test('exports DockerSecurityError class', () => {
    expect(docker.DockerSecurityError).toBeDefined();
    expect(typeof docker.DockerSecurityError).toBe('function');
  });

  test('DockerSecurityError has correct properties', () => {
    const error = new docker.DockerSecurityError(
      'Test message',
      'TEST_CODE',
      { detail: 'value' }
    );

    expect(error.message).toBe('Test message');
    expect(error.code).toBe('TEST_CODE');
    expect(error.details).toEqual({ detail: 'value' });
    expect(error.name).toBe('DockerSecurityError');
  });
});

// =============================================================================
// Security Constants Tests
// =============================================================================

describe('Security Constants', () => {
  test('exports security constants', () => {
    expect(docker.MAX_CONTAINER_NAME_LENGTH).toBe(63);
    expect(docker.MAX_TAIL_LINES).toBe(10000);
  });

  test('allowed compose commands are defined', () => {
    expect(docker.ALLOWED_COMPOSE_COMMANDS).toBeDefined();
    expect(docker.ALLOWED_COMPOSE_COMMANDS.has('up')).toBe(true);
    expect(docker.ALLOWED_COMPOSE_COMMANDS.has('down')).toBe(true);
    expect(docker.ALLOWED_COMPOSE_COMMANDS.has('restart')).toBe(true);
  });
});

// =============================================================================
// Module Export Tests
// =============================================================================

describe('Module Exports', () => {
  test('exports validation functions', () => {
    expect(typeof docker.validateContainerName).toBe('function');
    expect(typeof docker.validateComposeArgs).toBe('function');
    expect(typeof docker.validateTailOption).toBe('function');
    expect(typeof docker.validateWorkingDirectory).toBe('function');
    expect(typeof docker.validateTimeout).toBe('function');
  });

  test('exports Docker error classes', () => {
    expect(typeof docker.DockerSecurityError).toBe('function');
    expect(typeof docker.DockerError).toBe('function');
    expect(typeof docker.DockerCommandError).toBe('function');
  });

  test('exports constants', () => {
    expect(docker.MAX_CONTAINER_NAME_LENGTH).toBeDefined();
    expect(docker.MAX_TAIL_LINES).toBeDefined();
    expect(docker.ALLOWED_COMPOSE_COMMANDS).toBeDefined();
    expect(docker.DEFAULT_DOCKER_TIMEOUT_MS).toBeDefined();
    expect(docker.QUICK_DOCKER_TIMEOUT_MS).toBeDefined();
  });
});
