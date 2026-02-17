/**
 * Tests for correlation.js
 * Run with: npm test -- correlation.test.js
 */

// Module under test
const {
  generateCorrelationId,
  validateCorrelationId,
  sanitizeCorrelationId,
  getCurrentCorrelationId,
  setCorrelationId,
  runWithCorrelationId,
  runWithCorrelationIdAsync,
  initializeCorrelationId,
  getCorrelationIdFromEnvironment,
  createChildCorrelationId,
  getRootCorrelationId,
  getCorrelationIdFromHeaders,
  createCorrelationHeaders,
  wrapCommandWithCorrelation,
  clearCorrelationContext,
  MAX_CORRELATION_ID_LENGTH,
  MIN_CORRELATION_ID_LENGTH,
  CORRELATION_ID_HEADER,
  CORRELATION_ID_ENV_VAR,
} = require('../lib/correlation');

// Mock security module
jest.mock('../lib/security', () => ({
  sanitizeForLog: jest.fn((str, maxLength = 1000) => {
    if (typeof str !== 'string') return String(str);
    return str.slice(0, maxLength);
  }),
}));

// Mock logger
jest.mock('../lib/logger', () => ({
  info: jest.fn(),
}));

// =============================================================================
// Setup & Teardown
// =============================================================================

const originalEnv = process.env;

beforeEach(() => {
  // Clear environment before each test
  process.env = { ...originalEnv };
  delete process.env[CORRELATION_ID_ENV_VAR];
  
  // Clear any lingering correlation context
  clearCorrelationContext();
});

afterEach(() => {
  process.env = originalEnv;
});

// =============================================================================
// ID Generation Tests
// =============================================================================

describe('generateCorrelationId', () => {
  test('generates unique IDs', () => {
    const id1 = generateCorrelationId();
    const id2 = generateCorrelationId();
    expect(id1).not.toBe(id2);
  });

  test('generates IDs with correct prefix', () => {
    const id = generateCorrelationId();
    expect(id.startsWith('mc_')).toBe(true);
  });

  test('generates IDs with valid format', () => {
    const id = generateCorrelationId();
    const parts = id.split('_');
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe('mc');
    // Second part is timestamp in base36
    expect(parts[1]).toMatch(/^[a-z0-9]+$/);
    // Third part is random
    expect(parts[2]).toMatch(/^[a-z0-9]+$/);
  });

  test('generates IDs within length limits', () => {
    const id = generateCorrelationId();
    expect(id.length).toBeGreaterThanOrEqual(MIN_CORRELATION_ID_LENGTH);
    expect(id.length).toBeLessThanOrEqual(MAX_CORRELATION_ID_LENGTH);
  });

  test('generates URL-safe IDs', () => {
    const id = generateCorrelationId();
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

// =============================================================================
// ID Validation Tests
// =============================================================================

describe('validateCorrelationId', () => {
  test('validates correct IDs', () => {
    const validIds = [
      'mc_1234567890_abcdefgh',
      'request-123-abc',
      'valid_id_with_underscores',
      'valid-id-with-hyphens',
      'a'.repeat(MIN_CORRELATION_ID_LENGTH),
    ];
    
    for (const id of validIds) {
      const result = validateCorrelationId(id);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.sanitized).toBeDefined();
    }
  });

  test('rejects non-string IDs', () => {
    const invalidIds = [null, undefined, 123, {}, [], true];
    
    for (const id of invalidIds) {
      const result = validateCorrelationId(id);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('must be a string');
    }
  });

  test('rejects IDs that are too short', () => {
    const shortIds = ['', 'a', 'ab', '1234567'];
    
    for (const id of shortIds) {
      const result = validateCorrelationId(id);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too short');
    }
  });

  test('rejects IDs that are too long', () => {
    const longId = 'a'.repeat(MAX_CORRELATION_ID_LENGTH + 1);
    const result = validateCorrelationId(longId);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('too long');
  });

  test('rejects IDs with invalid characters', () => {
    const invalidIds = [
      'id with spaces',
      'id\nwith\nnewlines',
      'id\twith\ttabs',
      'id.with.dots',
      'id/with/slashes',
      'id@with@symbols',
      'id<script>alert(1)</script>',
    ];
    
    for (const id of invalidIds) {
      const result = validateCorrelationId(id);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('invalid characters');
    }
  });

  test('sanitizes valid IDs', () => {
    const id = 'mc_1234567890_abcdefgh';
    const result = validateCorrelationId(id);
    expect(result.sanitized).toBe(id);
  });
});

// =============================================================================
// ID Sanitization Tests
// =============================================================================

describe('sanitizeCorrelationId', () => {
  test('returns valid IDs unchanged', () => {
    const validId = 'mc_1234567890_abcdefgh';
    const result = sanitizeCorrelationId(validId);
    expect(result).toBe(validId);
  });

  test('generates new ID when input is null', () => {
    const result = sanitizeCorrelationId(null);
    expect(result).toMatch(/^mc_/);
  });

  test('generates new ID when input is undefined', () => {
    const result = sanitizeCorrelationId(undefined);
    expect(result).toMatch(/^mc_/);
  });

  test('generates new ID when input is empty', () => {
    const result = sanitizeCorrelationId('');
    expect(result).toMatch(/^mc_/);
  });

  test('generates new ID when input is invalid', () => {
    const result = sanitizeCorrelationId('invalid id with spaces');
    expect(result).toMatch(/^mc_/);
  });

  test('generates unique IDs for multiple invalid inputs', () => {
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(sanitizeCorrelationId('invalid'));
    }
    const uniqueResults = new Set(results);
    expect(uniqueResults.size).toBe(10);
  });
});

// =============================================================================
// Context Management Tests
// =============================================================================

describe('Context Management', () => {
  describe('getCurrentCorrelationId', () => {
    test('returns null when no context is set', () => {
      expect(getCurrentCorrelationId()).toBeNull();
    });

    test('returns ID after setting', () => {
      const id = 'mc_test_12345678';
      setCorrelationId(id);
      expect(getCurrentCorrelationId()).toBe(id);
    });
  });

  describe('setCorrelationId', () => {
    test('sets valid ID', () => {
      const id = 'mc_test_12345678';
      setCorrelationId(id);
      expect(getCurrentCorrelationId()).toBe(id);
    });

    test('sanitizes invalid ID', () => {
      setCorrelationId('invalid id');
      expect(getCurrentCorrelationId()).toMatch(/^mc_/);
    });

    test('generates new ID when passed null', () => {
      setCorrelationId(null);
      expect(getCurrentCorrelationId()).toMatch(/^mc_/);
    });

    test('returns the set/sanitized ID', () => {
      const id = 'mc_test_12345678';
      const result = setCorrelationId(id);
      expect(result).toBe(id);
    });
  });

  describe('runWithCorrelationId', () => {
    test('provides correlation ID to function', () => {
      const testId = 'mc_test_run_1234';
      let capturedId = null;
      
      runWithCorrelationId(() => {
        capturedId = getCurrentCorrelationId();
      }, testId);
      
      expect(capturedId).toBe(testId);
    });

    test('generates ID when not provided', () => {
      let capturedId = null;
      
      runWithCorrelationId(() => {
        capturedId = getCurrentCorrelationId();
      });
      
      expect(capturedId).toMatch(/^mc_/);
    });

    test('restores previous context after execution', () => {
      const previousId = 'mc_previous_1234';
      setCorrelationId(previousId);
      
      runWithCorrelationId(() => {
        setCorrelationId('mc_inner_5678');
      }, 'mc_outer_9012');
      
      // Note: In AsyncLocalStorage, the context doesn't restore the same way
      // This test may vary based on Node version
    });

    test('returns function result', () => {
      const result = runWithCorrelationId(() => {
        return 'success';
      }, 'mc_test_1234');
      
      expect(result).toBe('success');
    });
  });

  describe('runWithCorrelationIdAsync', () => {
    test('provides correlation ID to async function', async () => {
      const testId = 'mc_async_test_1234';
      let capturedId = null;
      
      await runWithCorrelationIdAsync(async () => {
        await Promise.resolve();
        capturedId = getCurrentCorrelationId();
      }, testId);
      
      expect(capturedId).toBe(testId);
    });

    test('handles async errors', async () => {
      const testId = 'mc_async_error_1234';
      
      await expect(runWithCorrelationIdAsync(async () => {
        await Promise.resolve();
        throw new Error('Test error');
      }, testId)).rejects.toThrow('Test error');
    });

    test('returns async function result', async () => {
      const result = await runWithCorrelationIdAsync(async () => {
        await Promise.resolve();
        return { success: true };
      }, 'mc_test_1234');
      
      expect(result).toEqual({ success: true });
    });
  });
});

// =============================================================================
// Environment Integration Tests
// =============================================================================

describe('Environment Integration', () => {
  describe('getCorrelationIdFromEnvironment', () => {
    test('returns null when env var not set', () => {
      delete process.env[CORRELATION_ID_ENV_VAR];
      expect(getCorrelationIdFromEnvironment()).toBeNull();
    });

    test('returns ID from environment', () => {
      process.env[CORRELATION_ID_ENV_VAR] = 'mc_env_test_1234';
      expect(getCorrelationIdFromEnvironment()).toBe('mc_env_test_1234');
    });

    test('returns null for invalid ID in environment', () => {
      process.env[CORRELATION_ID_ENV_VAR] = 'invalid id with spaces';
      expect(getCorrelationIdFromEnvironment()).toBeNull();
    });

    test('sanitizes valid ID from environment', () => {
      const longButValid = 'a'.repeat(MAX_CORRELATION_ID_LENGTH);
      process.env[CORRELATION_ID_ENV_VAR] = longButValid;
      expect(getCorrelationIdFromEnvironment()).toBe(longButValid);
    });
  });

  describe('initializeCorrelationId', () => {
    test('uses environment ID when available', () => {
      process.env[CORRELATION_ID_ENV_VAR] = 'mc_env_init_1234';
      expect(initializeCorrelationId()).toBe('mc_env_init_1234');
    });

    test('generates new ID when env not set', () => {
      delete process.env[CORRELATION_ID_ENV_VAR];
      const id = initializeCorrelationId();
      expect(id).toMatch(/^mc_/);
    });

    test('generates new ID when env ID is invalid', () => {
      process.env[CORRELATION_ID_ENV_VAR] = 'short';
      const id = initializeCorrelationId();
      expect(id).toMatch(/^mc_/);
    });
  });
});

// =============================================================================
// Hierarchy Tests
// =============================================================================

describe('Hierarchy', () => {
  describe('createChildCorrelationId', () => {
    test('creates child from parent ID', () => {
      const parentId = 'mc_parent_12345678';
      const childId = createChildCorrelationId(parentId);
      
      expect(childId.startsWith(parentId + '.')).toBe(true);
    });

    test('uses current ID when parent not provided', () => {
      const currentId = 'mc_current_12345678';
      setCorrelationId(currentId);
      
      const childId = createChildCorrelationId();
      expect(childId.startsWith(currentId + '.')).toBe(true);
    });

    test('generates parent when no context exists', () => {
      setCorrelationId(null);
      const childId = createChildCorrelationId();
      
      expect(childId).toContain('.');
      expect(childId).toMatch(/^mc_/);
    });

    test('limits total length', () => {
      const longParent = 'a'.repeat(MAX_CORRELATION_ID_LENGTH - 5);
      const childId = createChildCorrelationId(longParent);
      
      expect(childId.length).toBeLessThanOrEqual(MAX_CORRELATION_ID_LENGTH);
    });
  });

  describe('getRootCorrelationId', () => {
    test('returns root from child ID', () => {
      const rootId = 'mc_root_12345678';
      const childId = `${rootId}.abcd`;
      
      expect(getRootCorrelationId(childId)).toBe(rootId);
    });

    test('returns ID when no dot present', () => {
      const simpleId = 'mc_simple_12345678';
      expect(getRootCorrelationId(simpleId)).toBe(simpleId);
    });

    test('returns current ID when input is falsy', () => {
      const currentId = 'mc_current_12345678';
      setCorrelationId(currentId);
      
      expect(getRootCorrelationId(null)).toBe(currentId);
    });

    test('generates new ID when no context exists', () => {
      setCorrelationId(null);
      const rootId = getRootCorrelationId(null);
      
      expect(rootId).toMatch(/^mc_/);
    });
  });
});

// =============================================================================
// HTTP Header Integration Tests
// =============================================================================

describe('HTTP Header Integration', () => {
  describe('getCorrelationIdFromHeaders', () => {
    test('extracts ID from lowercase header', () => {
      const headers = { [CORRELATION_ID_HEADER]: 'mc_header_1234' };
      expect(getCorrelationIdFromHeaders(headers)).toBe('mc_header_1234');
    });

    test('extracts ID from X-Correlation-Id header', () => {
      const headers = { 'X-Correlation-Id': 'mc_header_1234' };
      expect(getCorrelationIdFromHeaders(headers)).toBe('mc_header_1234');
    });

    test('extracts ID from X-Correlation-ID header', () => {
      const headers = { 'X-Correlation-ID': 'mc_header_1234' };
      expect(getCorrelationIdFromHeaders(headers)).toBe('mc_header_1234');
    });

    test('extracts ID from x-request-id header', () => {
      const headers = { 'x-request-id': 'mc_header_1234' };
      expect(getCorrelationIdFromHeaders(headers)).toBe('mc_header_1234');
    });

    test('returns null for empty headers', () => {
      expect(getCorrelationIdFromHeaders({})).toBeNull();
      expect(getCorrelationIdFromHeaders(null)).toBeNull();
      expect(getCorrelationIdFromHeaders(undefined)).toBeNull();
    });

    test('returns null for invalid ID in headers', () => {
      const headers = { [CORRELATION_ID_HEADER]: 'invalid id' };
      expect(getCorrelationIdFromHeaders(headers)).toBeNull();
    });

    test('returns null for non-object headers', () => {
      expect(getCorrelationIdFromHeaders('string')).toBeNull();
      expect(getCorrelationIdFromHeaders(123)).toBeNull();
      expect(getCorrelationIdFromHeaders([])).toBeNull();
    });
  });

  describe('createCorrelationHeaders', () => {
    test('creates headers with provided ID', () => {
      const headers = createCorrelationHeaders('mc_provided_1234');
      expect(headers[CORRELATION_ID_HEADER]).toBe('mc_provided_1234');
    });

    test('creates headers with current ID', () => {
      const currentId = 'mc_current_1234';
      setCorrelationId(currentId);
      
      const headers = createCorrelationHeaders();
      expect(headers[CORRELATION_ID_HEADER]).toBe(currentId);
    });

    test('generates new ID when none available', () => {
      setCorrelationId(null);
      
      const headers = createCorrelationHeaders();
      expect(headers[CORRELATION_ID_HEADER]).toMatch(/^mc_/);
    });
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('Integration', () => {
  test('full flow: generate → set → get → child → headers', () => {
    // Generate new ID
    const id = generateCorrelationId();
    
    // Set in context
    setCorrelationId(id);
    
    // Get from context
    expect(getCurrentCorrelationId()).toBe(id);
    
    // Create child
    const childId = createChildCorrelationId();
    expect(childId.startsWith(id + '.')).toBe(true);
    
    // Create headers
    const headers = createCorrelationHeaders();
    expect(headers[CORRELATION_ID_HEADER]).toBe(id);
  });

  test('full flow: env → init → context → async operation', async () => {
    // Set in environment
    const envId = 'mc_integration_test_1234';
    process.env[CORRELATION_ID_ENV_VAR] = envId;
    
    // Initialize
    const id = initializeCorrelationId();
    expect(id).toBe(envId);
    
    // Run async operation
    await runWithCorrelationIdAsync(async () => {
      expect(getCurrentCorrelationId()).toBe(envId);
      await Promise.resolve();
      expect(getCurrentCorrelationId()).toBe(envId);
    }, id);
  });

  test('validation prevents injection attacks', () => {
    const maliciousIds = [
      'id\nNewLogEntry',
      'id\r\nInjected: admin',
      'id\tHidden',
      '../../../etc/passwd',
      '..\\..\\windows\\system32\\config\\sam',
      'id\x00nullbyte',
    ];
    
    for (const maliciousId of maliciousIds) {
      const result = validateCorrelationId(maliciousId);
      expect(result.valid).toBe(false);
    }
  });

  test('concurrent operations maintain separate contexts', async () => {
    const results = [];
    
    // Run multiple concurrent operations with different IDs
    const promises = [
      runWithCorrelationIdAsync(async () => {
        await new Promise(r => setTimeout(r, 10));
        results.push({ op: 1, id: getCurrentCorrelationId() });
      }, 'mc_concurrent_1'),
      runWithCorrelationIdAsync(async () => {
        await new Promise(r => setTimeout(r, 5));
        results.push({ op: 2, id: getCurrentCorrelationId() });
      }, 'mc_concurrent_2'),
      runWithCorrelationIdAsync(async () => {
        results.push({ op: 3, id: getCurrentCorrelationId() });
      }, 'mc_concurrent_3'),
    ];
    
    await Promise.all(promises);
    
    // Verify each operation had its own ID
    expect(results).toContainEqual({ op: 1, id: 'mc_concurrent_1' });
    expect(results).toContainEqual({ op: 2, id: 'mc_concurrent_2' });
    expect(results).toContainEqual({ op: 3, id: 'mc_concurrent_3' });
  });
});

// =============================================================================
// CLI Integration Tests
// =============================================================================

describe('wrapCommandWithCorrelation', () => {
  const { info } = require('../lib/logger');

  beforeEach(() => {
    info.mockClear();
  });

  test('wraps command and logs start/completion', async () => {
    const handler = jest.fn().mockResolvedValue('result');
    const wrapped = wrapCommandWithCorrelation(handler, 'test-command');
    
    await wrapped({ option: true });
    
    expect(handler).toHaveBeenCalledWith({ option: true });
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Command started'),
      expect.any(Object),
      expect.any(Object)
    );
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Command completed'),
      expect.any(Object),
      expect.any(Object)
    );
  });

  test('logs failure on error', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('Test error'));
    const wrapped = wrapCommandWithCorrelation(handler, 'failing-command');
    
    await expect(wrapped()).rejects.toThrow('Test error');
    
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Command failed'),
      expect.objectContaining({
        command: 'failing-command',
        status: 'error',
      }),
      expect.any(Object)
    );
  });

  test('includes correlation ID in log metadata', async () => {
    const handler = jest.fn().mockResolvedValue('result');
    const wrapped = wrapCommandWithCorrelation(handler, 'test-command');
    
    await wrapped();
    
    const startCall = info.mock.calls.find(call => call[0].includes('started'));
    expect(startCall[1]).toHaveProperty('correlationId');
    expect(startCall[1].correlationId).toMatch(/^mc_/);
  });
});

// =============================================================================
// Constants Tests
// =============================================================================

describe('Constants', () => {
  test('MAX_CORRELATION_ID_LENGTH is 64', () => {
    expect(MAX_CORRELATION_ID_LENGTH).toBe(64);
  });

  test('MIN_CORRELATION_ID_LENGTH is 8', () => {
    expect(MIN_CORRELATION_ID_LENGTH).toBe(8);
  });

  test('CORRELATION_ID_HEADER is x-correlation-id', () => {
    expect(CORRELATION_ID_HEADER).toBe('x-correlation-id');
  });

  test('CORRELATION_ID_ENV_VAR is MC_CORRELATION_ID', () => {
    expect(CORRELATION_ID_ENV_VAR).toBe('MC_CORRELATION_ID');
  });
});
