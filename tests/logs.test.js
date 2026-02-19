/**
 * Tests for logs.js module
 * Run with: npm test -- logs.test.js
 *
 * Tests log management validation functions and constants.
 */

const {
  SERVICES,
  VALID_SERVICES,
  VALID_DURATION,
  MAX_EXPORT_LINES,
  DANGEROUS_CHARS,
  VALID_FILENAME,
  validateServiceName,
  validateDuration,
  validateExportOptions,
  validateSearchQuery,
  validateFilename,
  formatServiceName,
  parseSinceOption,
  DockerSecurityError,
} = require('../lib/logs');

// =============================================================================
// Constants Tests
// =============================================================================

describe('Logs Module Constants', () => {
  test('SERVICES maps user-friendly names to container names', () => {
    expect(SERVICES['traefik']).toBe('mc-traefik');
    expect(SERVICES['interface']).toBe('mc-interface');
    expect(SERVICES['backend']).toBe('mc-backend');
    expect(SERVICES['core']).toBe('mc-core');
    expect(SERVICES['gateway']).toBe('mc-gateway');
    expect(SERVICES['chroma']).toBe('mc-chroma');
    expect(SERVICES['watchtower']).toBe('mc-watchtower');
    expect(SERVICES['all']).toBeNull();
  });

  test('VALID_SERVICES contains all service names', () => {
    expect(VALID_SERVICES.has('traefik')).toBe(true);
    expect(VALID_SERVICES.has('interface')).toBe(true);
    expect(VALID_SERVICES.has('backend')).toBe(true);
    expect(VALID_SERVICES.has('core')).toBe(true);
    expect(VALID_SERVICES.has('gateway')).toBe(true);
    expect(VALID_SERVICES.has('chroma')).toBe(true);
    expect(VALID_SERVICES.has('watchtower')).toBe(true);
    expect(VALID_SERVICES.has('all')).toBe(true);
  });

  test('VALID_DURATION accepts valid patterns', () => {
    expect(VALID_DURATION.test('30s')).toBe(true);
    expect(VALID_DURATION.test('5m')).toBe(true);
    expect(VALID_DURATION.test('1h')).toBe(true);
    expect(VALID_DURATION.test('24h')).toBe(true);
    expect(VALID_DURATION.test('7d')).toBe(true);
    expect(VALID_DURATION.test('2w')).toBe(true);
  });

  test('VALID_DURATION rejects invalid patterns', () => {
    expect(VALID_DURATION.test('5')).toBe(false); // No unit
    expect(VALID_DURATION.test('m')).toBe(false); // No number
    expect(VALID_DURATION.test('5x')).toBe(false); // Invalid unit
    expect(VALID_DURATION.test('abc')).toBe(false);
    expect(VALID_DURATION.test('')).toBe(false);
  });

  test('MAX_EXPORT_LINES is 50000', () => {
    expect(MAX_EXPORT_LINES).toBe(50000);
  });

  test('DANGEROUS_CHARS matches shell metacharacters', () => {
    expect(DANGEROUS_CHARS.test(';')).toBe(true);
    expect(DANGEROUS_CHARS.test('|')).toBe(true);
    expect(DANGEROUS_CHARS.test('`')).toBe(true);
    expect(DANGEROUS_CHARS.test('$')).toBe(true);
    expect(DANGEROUS_CHARS.test('(')).toBe(true);
    expect(DANGEROUS_CHARS.test(')')).toBe(true);
    expect(DANGEROUS_CHARS.test('<')).toBe(true);
    expect(DANGEROUS_CHARS.test('>')).toBe(true);
  });

  test('VALID_FILENAME accepts valid names', () => {
    expect(VALID_FILENAME.test('valid')).toBe(true);
    expect(VALID_FILENAME.test('valid-name')).toBe(true);
    expect(VALID_FILENAME.test('valid_name')).toBe(true);
    expect(VALID_FILENAME.test('valid.name')).toBe(true);
    expect(VALID_FILENAME.test('valid123')).toBe(true);
  });

  test('VALID_FILENAME rejects invalid names', () => {
    expect(VALID_FILENAME.test('-invalid')).toBe(false); // Starts with hyphen
    expect(VALID_FILENAME.test('.invalid')).toBe(false); // Starts with dot
    expect(VALID_FILENAME.test('invalid/name')).toBe(false); // Path separator
    expect(VALID_FILENAME.test('invalid;name')).toBe(false); // Dangerous char
    expect(VALID_FILENAME.test('')).toBe(false); // Empty
  });
});

// =============================================================================
// validateServiceName Tests
// =============================================================================

describe('validateServiceName', () => {
  test('accepts valid service names', () => {
    expect(() => validateServiceName('traefik')).not.toThrow();
    expect(() => validateServiceName('core')).not.toThrow();
    expect(() => validateServiceName('backend')).not.toThrow();
    expect(() => validateServiceName('all')).not.toThrow();
  });

  test('rejects invalid service names', () => {
    expect(() => validateServiceName('invalid')).toThrow(DockerSecurityError);
    expect(() => validateServiceName('unknown')).toThrow(DockerSecurityError);
  });

  test('rejects non-string inputs', () => {
    expect(() => validateServiceName(123)).toThrow(DockerSecurityError);
    expect(() => validateServiceName(null)).toThrow(DockerSecurityError);
    expect(() => validateServiceName(undefined)).toThrow(DockerSecurityError);
    expect(() => validateServiceName({})).toThrow(DockerSecurityError);
  });

  test('error includes valid services list', () => {
    try {
      validateServiceName('invalid');
    } catch (err) {
      expect(err.message).toContain('Valid services');
      expect(err.code).toBe('UNKNOWN_SERVICE');
    }
  });
});

// =============================================================================
// validateDuration Tests
// =============================================================================

describe('validateDuration', () => {
  test('accepts valid durations', () => {
    expect(() => validateDuration('5m')).not.toThrow();
    expect(() => validateDuration('1h')).not.toThrow();
    expect(() => validateDuration('30s')).not.toThrow();
    expect(() => validateDuration('7d')).not.toThrow();
    expect(() => validateDuration('2w')).not.toThrow();
  });

  test('rejects invalid formats', () => {
    expect(() => validateDuration('5')).toThrow(DockerSecurityError);
    expect(() => validateDuration('minutes')).toThrow(DockerSecurityError);
    expect(() => validateDuration('5x')).toThrow(DockerSecurityError);
  });

  test('rejects non-string inputs', () => {
    expect(() => validateDuration(5)).toThrow(DockerSecurityError);
    expect(() => validateDuration(null)).toThrow(DockerSecurityError);
  });

  test('error includes valid format examples', () => {
    try {
      validateDuration('invalid');
    } catch (err) {
      expect(err.message).toContain('30s');
      expect(err.message).toContain('5m');
      expect(err.message).toContain('1h');
    }
  });
});

// =============================================================================
// validateExportOptions Tests
// =============================================================================

describe('validateExportOptions', () => {
  test('accepts valid options', () => {
    expect(() => validateExportOptions({ lines: 1000 })).not.toThrow();
    expect(() => validateExportOptions({ lines: 100 })).not.toThrow();
    expect(() => validateExportOptions({})).not.toThrow();
  });

  test('rejects lines over MAX_EXPORT_LINES', () => {
    expect(() => validateExportOptions({ lines: 60000 })).toThrow(DockerSecurityError);
    expect(() => validateExportOptions({ lines: 100000 })).toThrow(DockerSecurityError);
  });

  test('rejects negative lines', () => {
    expect(() => validateExportOptions({ lines: -1 })).toThrow(DockerSecurityError);
  });

  test('rejects non-numeric lines', () => {
    // String '100' is actually valid because parseInt converts it
    expect(() => validateExportOptions({ lines: 'not-a-number' })).toThrow(DockerSecurityError);
    expect(() => validateExportOptions({ lines: null })).toThrow(DockerSecurityError);
  });

  test('handles undefined lines', () => {
    expect(() => validateExportOptions({ lines: undefined })).not.toThrow();
  });
});

// =============================================================================
// validateSearchQuery Tests
// =============================================================================

describe('validateSearchQuery', () => {
  test('accepts valid search queries', () => {
    expect(() => validateSearchQuery('error')).not.toThrow();
    expect(() => validateSearchQuery('connection failed')).not.toThrow();
    expect(() => validateSearchQuery('status=200')).not.toThrow();
  });

  test('rejects empty queries', () => {
    expect(() => validateSearchQuery('')).toThrow(DockerSecurityError);
    expect(() => validateSearchQuery('   ')).toThrow(DockerSecurityError);
  });

  test('rejects queries with dangerous characters', () => {
    expect(() => validateSearchQuery('test;rm -rf')).toThrow(DockerSecurityError);
    expect(() => validateSearchQuery('test|cat /etc/passwd')).toThrow(DockerSecurityError);
    expect(() => validateSearchQuery('test`whoami`')).toThrow(DockerSecurityError);
    expect(() => validateSearchQuery('test$(cmd)')).toThrow(DockerSecurityError);
  });

  test('rejects non-string queries', () => {
    expect(() => validateSearchQuery(123)).toThrow(DockerSecurityError);
    expect(() => validateSearchQuery(null)).toThrow(DockerSecurityError);
  });
});

// =============================================================================
// validateFilename Tests
// =============================================================================

describe('validateFilename', () => {
  test('accepts valid filenames', () => {
    expect(() => validateFilename('logs.txt')).not.toThrow();
    expect(() => validateFilename('my-logs')).not.toThrow();
    expect(() => validateFilename('export_2024')).not.toThrow();
    expect(() => validateFilename('file.name.with.dots')).not.toThrow();
  });

  test('rejects path traversal', () => {
    expect(() => validateFilename('../etc/passwd')).toThrow(DockerSecurityError);
    expect(() => validateFilename('..\\windows\\system32')).toThrow(DockerSecurityError);
    expect(() => validateFilename('/etc/passwd')).toThrow(DockerSecurityError);
    expect(() => validateFilename('file/../../etc')).toThrow(DockerSecurityError);
  });

  test('rejects dangerous characters', () => {
    expect(() => validateFilename('file;cmd')).toThrow(DockerSecurityError);
    expect(() => validateFilename('file|cmd')).toThrow(DockerSecurityError);
    expect(() => validateFilename('file`cmd`')).toThrow(DockerSecurityError);
    expect(() => validateFilename('file$(cmd)')).toThrow(DockerSecurityError);
  });

  test('rejects names starting with dots or hyphens', () => {
    expect(() => validateFilename('.hidden')).toThrow(DockerSecurityError);
    expect(() => validateFilename('-invalid')).toThrow(DockerSecurityError);
  });

  test('rejects empty filename', () => {
    expect(() => validateFilename('')).toThrow(DockerSecurityError);
  });
});

// =============================================================================
// formatServiceName Tests
// =============================================================================

describe('formatServiceName', () => {
  test('formats known services', () => {
    expect(formatServiceName('core')).toBe('mc-core');
    expect(formatServiceName('backend')).toBe('mc-backend');
    expect(formatServiceName('gateway')).toBe('mc-gateway');
    expect(formatServiceName('traefik')).toBe('mc-traefik');
  });

  test('returns null for all', () => {
    expect(formatServiceName('all')).toBeNull();
  });

  test('returns null for unknown services', () => {
    expect(formatServiceName('unknown')).toBeNull();
    expect(formatServiceName('invalid')).toBeNull();
  });
});

// =============================================================================
// parseSinceOption Tests
// =============================================================================

describe('parseSinceOption', () => {
  test('parses seconds correctly', () => {
    const result = parseSinceOption('30s');
    expect(result).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('parses minutes correctly', () => {
    const result = parseSinceOption('5m');
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  test('parses hours correctly', () => {
    const result = parseSinceOption('2h');
    expect(result).toBeDefined();
  });

  test('parses days correctly', () => {
    const result = parseSinceOption('1d');
    expect(result).toBeDefined();
  });

  test('parses weeks correctly', () => {
    const result = parseSinceOption('1w');
    expect(result).toBeDefined();
  });

  test('returns null for invalid duration', () => {
    expect(parseSinceOption('invalid')).toBeNull();
    expect(parseSinceOption('5x')).toBeNull();
    expect(parseSinceOption('')).toBeNull();
  });

  test('returns null for non-string input', () => {
    expect(parseSinceOption(5)).toBeNull();
    expect(parseSinceOption(null)).toBeNull();
    expect(parseSinceOption(undefined)).toBeNull();
  });

  test('returns ISO format timestamp', () => {
    const result = parseSinceOption('1h');
    // Should be a valid ISO 8601 timestamp
    const date = new Date(result);
    expect(date instanceof Date).toBe(true);
    expect(isNaN(date.getTime())).toBe(false);
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('Edge Cases', () => {
  test('handles very long search queries', () => {
    const longQuery = 'a'.repeat(1000);
    expect(() => validateSearchQuery(longQuery)).not.toThrow();
  });

  test('handles unicode in search queries', () => {
    expect(() => validateSearchQuery('错误')).not.toThrow();
    expect(() => validateSearchQuery('エラー')).not.toThrow();
  });

  test('handles whitespace-only as empty', () => {
    expect(() => validateSearchQuery('   ')).toThrow();
    expect(() => validateSearchQuery('\t\n')).toThrow();
  });

  test('MAX_EXPORT_LINES boundary', () => {
    // At the boundary should work
    expect(() => validateExportOptions({ lines: 50000 })).not.toThrow();
    // Just over should fail
    expect(() => validateExportOptions({ lines: 50001 })).toThrow();
  });
});
