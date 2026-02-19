/**
 * Tests for docker.js module
 * Run with: npm test -- docker.test.js
 *
 * Tests Docker security validation functions.
 */

const {
  VALID_CONTAINER_NAME,
  MAX_CONTAINER_NAME_LENGTH,
  MAX_TAIL_LINES,
  ALLOWED_COMPOSE_COMMANDS,
  DANGEROUS_CHARS,
  DEFAULT_DOCKER_TIMEOUT_MS,
  QUICK_DOCKER_TIMEOUT_MS,
  validateContainerName,
  validateComposeArgs,
  validateWorkingDirectory,
  validateTailOption,
  DockerSecurityError,
} = require('../lib/docker');

// =============================================================================
// Constants Tests
// =============================================================================

describe('Docker Module', () => {
  describe('Constants', () => {
    test('VALID_CONTAINER_NAME allows valid names', () => {
      expect(VALID_CONTAINER_NAME.test('mc-core')).toBe(true);
      expect(VALID_CONTAINER_NAME.test('container123')).toBe(true);
      expect(VALID_CONTAINER_NAME.test('a')).toBe(true);
    });

    test('VALID_CONTAINER_NAME rejects invalid names', () => {
      expect(VALID_CONTAINER_NAME.test('-container')).toBe(false);
      expect(VALID_CONTAINER_NAME.test('.container')).toBe(false);
      expect(VALID_CONTAINER_NAME.test('container;rm')).toBe(false);
    });

    test('MAX_CONTAINER_NAME_LENGTH is 63', () => {
      expect(MAX_CONTAINER_NAME_LENGTH).toBe(63);
    });

    test('MAX_TAIL_LINES is 10000', () => {
      expect(MAX_TAIL_LINES).toBe(10000);
    });

    test('ALLOWED_COMPOSE_COMMANDS contains expected commands', () => {
      expect(ALLOWED_COMPOSE_COMMANDS.has('up')).toBe(true);
      expect(ALLOWED_COMPOSE_COMMANDS.has('down')).toBe(true);
      expect(ALLOWED_COMPOSE_COMMANDS.has('restart')).toBe(true);
      expect(ALLOWED_COMPOSE_COMMANDS.has('logs')).toBe(true);
      expect(ALLOWED_COMPOSE_COMMANDS.has('ps')).toBe(true);
    });

    test('DANGEROUS_CHARS matches shell metacharacters', () => {
      expect(DANGEROUS_CHARS.test(';')).toBe(true);
      expect(DANGEROUS_CHARS.test('|')).toBe(true);
      expect(DANGEROUS_CHARS.test('`')).toBe(true);
      expect(DANGEROUS_CHARS.test('$')).toBe(true);
      expect(DANGEROUS_CHARS.test('&')).toBe(true);
    });

    test('DEFAULT_DOCKER_TIMEOUT_MS is 5 minutes', () => {
      expect(DEFAULT_DOCKER_TIMEOUT_MS).toBe(5 * 60 * 1000);
    });

    test('QUICK_DOCKER_TIMEOUT_MS is 30 seconds', () => {
      expect(QUICK_DOCKER_TIMEOUT_MS).toBe(30 * 1000);
    });
  });

  // ===========================================================================
  // DockerSecurityError Tests
  // ===========================================================================
  describe('DockerSecurityError', () => {
    test('creates error with message and code', () => {
      const err = new DockerSecurityError('Test error', 'TEST_CODE');
      expect(err.message).toBe('Test error');
      expect(err.code).toBe('TEST_CODE');
      expect(err.name).toBe('DockerSecurityError');
    });

    test('includes details when provided', () => {
      const details = { key: 'value' };
      const err = new DockerSecurityError('Test error', 'TEST_CODE', details);
      expect(err.details).toEqual(details);
    });

    test('is instanceof Error', () => {
      const err = new DockerSecurityError('Test', 'CODE');
      expect(err instanceof Error).toBe(true);
    });
  });

  // ===========================================================================
  // validateContainerName Tests
  // ===========================================================================
  describe('validateContainerName', () => {
    test('accepts valid container names', () => {
      expect(() => validateContainerName('mc-core')).not.toThrow();
      expect(() => validateContainerName('container123')).not.toThrow();
      expect(() => validateContainerName('my_container')).not.toThrow();
      expect(() => validateContainerName('my.container')).not.toThrow();
    });

    test('rejects non-string names', () => {
      expect(() => validateContainerName(123)).toThrow(DockerSecurityError);
      expect(() => validateContainerName(null)).toThrow(DockerSecurityError);
      expect(() => validateContainerName({})).toThrow(DockerSecurityError);
    });

    test('rejects empty names', () => {
      expect(() => validateContainerName('')).toThrow(DockerSecurityError);
    });

    test('rejects names that are too long', () => {
      const longName = 'a'.repeat(64);
      expect(() => validateContainerName(longName)).toThrow(DockerSecurityError);
    });

    test('rejects names with path traversal', () => {
      expect(() => validateContainerName('../etc')).toThrow(DockerSecurityError);
      expect(() => validateContainerName('container/../root')).toThrow(DockerSecurityError);
      expect(() => validateContainerName('container\\..\\root')).toThrow(DockerSecurityError);
    });

    test('rejects names starting with hyphen', () => {
      expect(() => validateContainerName('-container')).toThrow(DockerSecurityError);
    });

    test('rejects names starting with dot', () => {
      expect(() => validateContainerName('.container')).toThrow(DockerSecurityError);
    });

    test('rejects names with dangerous characters', () => {
      expect(() => validateContainerName('container;rm')).toThrow(DockerSecurityError);
      expect(() => validateContainerName('container|cat')).toThrow(DockerSecurityError);
      expect(() => validateContainerName('container$(cmd)')).toThrow(DockerSecurityError);
    });

    test('accepts names at max length', () => {
      const maxName = 'a'.repeat(63);
      expect(() => validateContainerName(maxName)).not.toThrow();
    });
  });

  // ===========================================================================
  // validateComposeArgs Tests
  // ===========================================================================
  describe('validateComposeArgs', () => {
    test('accepts valid compose up command', () => {
      expect(() => validateComposeArgs(['up', '-d'])).not.toThrow();
    });

    test('accepts valid compose down command', () => {
      expect(() => validateComposeArgs(['down'])).not.toThrow();
    });

    test('accepts valid compose logs command', () => {
      expect(() => validateComposeArgs(['logs', '-f'])).not.toThrow();
    });

    test('rejects non-array arguments', () => {
      expect(() => validateComposeArgs('up')).toThrow(DockerSecurityError);
      expect(() => validateComposeArgs(null)).toThrow(DockerSecurityError);
    });

    test('rejects non-string arguments', () => {
      expect(() => validateComposeArgs(['up', 123])).toThrow(DockerSecurityError);
    });

    test('rejects disallowed commands', () => {
      expect(() => validateComposeArgs(['exec', 'container', 'bash'])).toThrow(DockerSecurityError);
      expect(() => validateComposeArgs(['rm', 'container'])).toThrow(DockerSecurityError);
    });

    test('rejects dangerous characters in args', () => {
      expect(() => validateComposeArgs(['up', ';', 'rm', '-rf', '/'])).toThrow(DockerSecurityError);
      expect(() => validateComposeArgs(['up', '|', 'cat', '/etc/passwd'])).toThrow(DockerSecurityError);
    });

    test('rejects command substitution', () => {
      expect(() => validateComposeArgs(['up', '$(rm -rf /)'])).toThrow(DockerSecurityError);
    });

    test('accepts empty array', () => {
      expect(() => validateComposeArgs([])).not.toThrow();
    });
  });

  // ===========================================================================
  // validateWorkingDirectory Tests
  // ===========================================================================
  describe('validateWorkingDirectory', () => {
    test('accepts valid paths', () => {
      expect(() => validateWorkingDirectory('/home/user/project')).not.toThrow();
      expect(() => validateWorkingDirectory('./project')).not.toThrow();
      expect(() => validateWorkingDirectory('project/subdir')).not.toThrow();
    });

    test('accepts null/undefined', () => {
      expect(() => validateWorkingDirectory(null)).not.toThrow();
      expect(() => validateWorkingDirectory(undefined)).not.toThrow();
    });

    test('rejects non-string paths', () => {
      expect(() => validateWorkingDirectory(123)).toThrow(DockerSecurityError);
      expect(() => validateWorkingDirectory({})).toThrow(DockerSecurityError);
    });

    test('rejects paths with null bytes', () => {
      expect(() => validateWorkingDirectory('/path\0/../etc')).toThrow(DockerSecurityError);
    });

    test('rejects paths starting with ..', () => {
      expect(() => validateWorkingDirectory('../etc')).toThrow(DockerSecurityError);
    });

    test('rejects paths containing ../', () => {
      expect(() => validateWorkingDirectory('path/../../etc')).toThrow(DockerSecurityError);
    });

    test('rejects paths containing ..\\', () => {
      expect(() => validateWorkingDirectory('path\\..\\etc')).toThrow(DockerSecurityError);
    });
  });

  // ===========================================================================
  // validateTailOption Tests
  // ===========================================================================
  describe('validateTailOption', () => {
    test('accepts undefined/null', () => {
      expect(() => validateTailOption(undefined)).not.toThrow();
      expect(() => validateTailOption(null)).not.toThrow();
    });

    test('accepts valid numbers', () => {
      expect(() => validateTailOption(100)).not.toThrow();
      expect(() => validateTailOption(1000)).not.toThrow();
      expect(() => validateTailOption(10000)).not.toThrow();
    });

    test('rejects negative numbers', () => {
      expect(() => validateTailOption(-1)).toThrow(DockerSecurityError);
      expect(() => validateTailOption(-100)).toThrow(DockerSecurityError);
    });

    test('rejects numbers over MAX_TAIL_LINES', () => {
      expect(() => validateTailOption(10001)).toThrow(DockerSecurityError);
      expect(() => validateTailOption(50000)).toThrow(DockerSecurityError);
    });

    test('accepts MAX_TAIL_LINES exactly', () => {
      expect(() => validateTailOption(10000)).not.toThrow();
    });

    test('rejects non-numbers', () => {
      expect(() => validateTailOption('100')).toThrow(DockerSecurityError);
      expect(() => validateTailOption({})).toThrow(DockerSecurityError);
    });
  });
});
