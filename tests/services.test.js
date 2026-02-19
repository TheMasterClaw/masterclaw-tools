/**
 * Tests for services.js module
 * Run with: npm test -- services.test.js
 *
 * Tests service health checks, retry logic with exponential backoff,
 * circuit breaker integration, and error handling.
 */

const services = require('../lib/services');
const { DEFAULT_RETRY_CONFIG, withRetry, calculateBackoffDelay, isRetryableError } = require('../lib/services');

// Mock dependencies
jest.mock('../lib/docker', () => ({
  validateContainerName: jest.fn((name) => {
    if (typeof name !== 'string') {
      throw new Error('Container name must be a string');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error('Invalid container name format');
    }
    return true;
  }),
  validateComposeArgs: jest.fn((args) => args),
  validateWorkingDirectory: jest.fn((dir) => dir),
  DockerSecurityError: class DockerSecurityError extends Error {
    constructor(message, code, details) {
      super(message);
      this.code = code;
      this.details = details;
    }
  },
  DockerCommandError: class DockerCommandError extends Error {
    constructor(message, code, stderr) {
      super(message);
      this.code = code;
      this.stderr = stderr;
    }
  },
}));

jest.mock('../lib/circuit-breaker', () => ({
  executeWithCircuit: jest.fn((name, fn) => fn()),
  getCircuit: jest.fn(() => ({
    getState: () => 'CLOSED',
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  })),
  CircuitBreakerOpenError: class CircuitBreakerOpenError extends Error {
    constructor(message) {
      super(message);
      this.name = 'CircuitBreakerOpenError';
    }
  },
}));

jest.mock('../lib/http-client', () => ({
  request: jest.fn(),
  get: jest.fn(),
}));

jest.mock('../lib/logger', () => ({
  child: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe('Services Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset modules to clear any cached state
    jest.resetModules();
  });

  // ===========================================================================
  // Retry Configuration Tests
  // ===========================================================================
  describe('Retry Configuration', () => {
    test('has default retry configuration', () => {
      expect(DEFAULT_RETRY_CONFIG).toBeDefined();
      expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3);
      expect(DEFAULT_RETRY_CONFIG.initialDelayMs).toBe(500);
      expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(5000);
      expect(DEFAULT_RETRY_CONFIG.backoffMultiplier).toBe(2);
      expect(DEFAULT_RETRY_CONFIG.retryableStatuses).toContain(502);
      expect(DEFAULT_RETRY_CONFIG.retryableStatuses).toContain(503);
      expect(DEFAULT_RETRY_CONFIG.retryableStatuses).toContain(504);
    });

    test('default retryable errors include common network errors', () => {
      expect(DEFAULT_RETRY_CONFIG.retryableErrors).toContain('ECONNRESET');
      expect(DEFAULT_RETRY_CONFIG.retryableErrors).toContain('ETIMEDOUT');
      expect(DEFAULT_RETRY_CONFIG.retryableErrors).toContain('ECONNREFUSED');
      expect(DEFAULT_RETRY_CONFIG.retryableErrors).toContain('ENOTFOUND');
      expect(DEFAULT_RETRY_CONFIG.retryableErrors).toContain('EAI_AGAIN');
    });
  });

  // ===========================================================================
  // Retry Logic Tests
  // ===========================================================================
  describe('withRetry', () => {
    test('succeeds on first attempt', async () => {
      const fn = jest.fn().mockResolvedValue('success');

      const result = await withRetry(fn, {}, 'test-operation');

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('retries on retryable error and eventually succeeds', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce({ code: 'ECONNRESET', message: 'Connection reset' })
        .mockRejectedValueOnce({ code: 'ECONNRESET', message: 'Connection reset' })
        .mockResolvedValue('success');

      const result = await withRetry(fn, { maxRetries: 3, initialDelayMs: 10 }, 'test-operation');

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    test('throws after max retries exceeded', async () => {
      const error = { code: 'ECONNRESET', message: 'Connection reset' };
      const fn = jest.fn().mockRejectedValue(error);

      await expect(withRetry(fn, { maxRetries: 2, initialDelayMs: 10 }, 'test-operation'))
        .rejects.toEqual(error);

      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    test('does not retry non-retryable errors', async () => {
      const error = new Error('Invalid input');
      const fn = jest.fn().mockRejectedValue(error);

      await expect(withRetry(fn, { maxRetries: 3 }, 'test-operation'))
        .rejects.toEqual(error);

      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('retries on HTTP 502 status code', async () => {
      const error = { response: { status: 502 }, message: 'Bad Gateway' };
      const fn = jest.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('success');

      const result = await withRetry(fn, { maxRetries: 2, initialDelayMs: 10 }, 'test-operation');

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('retries on HTTP 503 status code', async () => {
      const error = { response: { status: 503 }, message: 'Service Unavailable' };
      const fn = jest.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('success');

      const result = await withRetry(fn, { maxRetries: 2, initialDelayMs: 10 }, 'test-operation');

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('retries on HTTP 504 status code', async () => {
      const error = { response: { status: 504 }, message: 'Gateway Timeout' };
      const fn = jest.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('success');

      const result = await withRetry(fn, { maxRetries: 2, initialDelayMs: 10 }, 'test-operation');

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('does not retry on HTTP 400 status code', async () => {
      const error = { response: { status: 400 }, message: 'Bad Request' };
      const fn = jest.fn().mockRejectedValue(error);

      await expect(withRetry(fn, { maxRetries: 3 }, 'test-operation'))
        .rejects.toEqual(error);

      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('retries on timeout errors', async () => {
      const error = { code: 'ECONNABORTED', message: 'Request timeout' };
      const fn = jest.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('success');

      const result = await withRetry(fn, { maxRetries: 2, initialDelayMs: 10 }, 'test-operation');

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('retries on message containing timeout', async () => {
      const error = new Error('Connection timeout');
      const fn = jest.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue('success');

      const result = await withRetry(fn, { maxRetries: 2, initialDelayMs: 10 }, 'test-operation');

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('handles null error gracefully', async () => {
      const fn = jest.fn().mockRejectedValue(null);

      // Should not throw TypeError, should throw null
      await expect(withRetry(fn, { maxRetries: 2 }, 'test-operation'))
        .rejects.toBeNull();

      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Exponential Backoff Tests
  // ===========================================================================
  describe('calculateBackoffDelay', () => {
    test('calculates initial delay correctly', () => {
      const config = {
        initialDelayMs: 100,
        maxDelayMs: 5000,
        backoffMultiplier: 2,
      };

      const delay = calculateBackoffDelay(0, config);

      // Should be around 100ms with jitter (±25%)
      expect(delay).toBeGreaterThanOrEqual(75);
      expect(delay).toBeLessThanOrEqual(125);
    });

    test('exponentially increases delay with each retry', () => {
      const config = {
        initialDelayMs: 100,
        maxDelayMs: 5000,
        backoffMultiplier: 2,
      };

      const delay0 = calculateBackoffDelay(0, config);
      const delay1 = calculateBackoffDelay(1, config);
      const delay2 = calculateBackoffDelay(2, config);

      // Each delay should be roughly 2x the previous (with jitter)
      expect(delay1).toBeGreaterThan(delay0 * 1.5);
      expect(delay2).toBeGreaterThan(delay1 * 1.5);
    });

    test('caps delay at maxDelayMs', () => {
      const config = {
        initialDelayMs: 1000,
        maxDelayMs: 2000,
        backoffMultiplier: 2,
      };

      // At attempt 3, exponential would be 8000ms, but should be capped at 2000ms
      const delay = calculateBackoffDelay(3, config);

      expect(delay).toBeLessThanOrEqual(2000);
    });

    test('applies jitter to prevent thundering herd', () => {
      const config = {
        initialDelayMs: 1000,
        maxDelayMs: 5000,
        backoffMultiplier: 2,
      };

      // Run multiple times to check jitter variation
      const delays = [];
      for (let i = 0; i < 10; i++) {
        delays.push(calculateBackoffDelay(1, config));
      }

      // With jitter, we should see some variation
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);
    });
  });

  // ===========================================================================
  // isRetryableError Tests
  // ===========================================================================
  describe('isRetryableError', () => {
    const config = DEFAULT_RETRY_CONFIG;

    test('returns true for ECONNRESET', () => {
      const error = { code: 'ECONNRESET' };
      expect(isRetryableError(error, config)).toBe(true);
    });

    test('returns true for ETIMEDOUT', () => {
      const error = { code: 'ETIMEDOUT' };
      expect(isRetryableError(error, config)).toBe(true);
    });

    test('returns true for ECONNREFUSED', () => {
      const error = { code: 'ECONNREFUSED' };
      expect(isRetryableError(error, config)).toBe(true);
    });

    test('returns true for ENOTFOUND', () => {
      const error = { code: 'ENOTFOUND' };
      expect(isRetryableError(error, config)).toBe(true);
    });

    test('returns true for EAI_AGAIN', () => {
      const error = { code: 'EAI_AGAIN' };
      expect(isRetryableError(error, config)).toBe(true);
    });

    test('returns true for 502 Bad Gateway', () => {
      const error = { response: { status: 502 } };
      expect(isRetryableError(error, config)).toBe(true);
    });

    test('returns true for 503 Service Unavailable', () => {
      const error = { response: { status: 503 } };
      expect(isRetryableError(error, config)).toBe(true);
    });

    test('returns true for 504 Gateway Timeout', () => {
      const error = { response: { status: 504 } };
      expect(isRetryableError(error, config)).toBe(true);
    });

    test('returns false for 400 Bad Request', () => {
      const error = { response: { status: 400 } };
      expect(isRetryableError(error, config)).toBe(false);
    });

    test('returns false for 404 Not Found', () => {
      const error = { response: { status: 404 } };
      expect(isRetryableError(error, config)).toBe(false);
    });

    test('returns false for 500 Internal Server Error', () => {
      const error = { response: { status: 500 } };
      expect(isRetryableError(error, config)).toBe(false);
    });

    test('returns false for null error', () => {
      expect(isRetryableError(null, config)).toBe(false);
    });

    test('returns false for undefined error', () => {
      expect(isRetryableError(undefined, config)).toBe(false);
    });

    test('returns false for generic error without code', () => {
      const error = new Error('Something went wrong');
      expect(isRetryableError(error, config)).toBe(false);
    });
  });

  // ===========================================================================
  // Service Configuration Tests
  // ===========================================================================
  describe('Service Configuration', () => {
    test('SERVICES constant contains expected services', () => {
      const { SERVICES } = services;

      expect(SERVICES).toHaveProperty('interface');
      expect(SERVICES).toHaveProperty('backend');
      expect(SERVICES).toHaveProperty('core');
      expect(SERVICES).toHaveProperty('gateway');
    });

    test('each service has required properties', () => {
      const { SERVICES } = services;

      for (const [name, config] of Object.entries(SERVICES)) {
        expect(config).toHaveProperty('port');
        expect(config).toHaveProperty('name');
        expect(config).toHaveProperty('url');
        expect(typeof config.port).toBe('number');
        expect(typeof config.name).toBe('string');
        expect(typeof config.url).toBe('string');
      }
    });

    test('service ports are valid', () => {
      const { SERVICES } = services;

      for (const [name, config] of Object.entries(SERVICES)) {
        expect(config.port).toBeGreaterThan(0);
        expect(config.port).toBeLessThan(65536);
      }
    });

    test('service URLs contain localhost', () => {
      const { SERVICES } = services;

      for (const [name, config] of Object.entries(SERVICES)) {
        expect(config.url).toContain('localhost');
      }
    });
  });

  // ===========================================================================
  // Service Name Validation Tests
  // ===========================================================================
  describe('Service Name Validation', () => {
    test('validateServiceName accepts valid service names', () => {
      const { validateServiceName } = services;

      expect(() => validateServiceName('interface')).not.toThrow();
      expect(() => validateServiceName('backend')).not.toThrow();
      expect(() => validateServiceName('core')).not.toThrow();
      expect(() => validateServiceName('gateway')).not.toThrow();
    });

    test('validateServiceName throws for invalid service names', () => {
      const { validateServiceName, DockerSecurityError } = services;

      expect(() => validateServiceName('invalid-service'))
        .toThrow(DockerSecurityError);
    });

    test('validateServiceName throws for non-string input', () => {
      const { validateServiceName, DockerSecurityError } = services;

      expect(() => validateServiceName(123))
        .toThrow(DockerSecurityError);
      expect(() => validateServiceName(null))
        .toThrow(DockerSecurityError);
      expect(() => validateServiceName(undefined))
        .toThrow(DockerSecurityError);
    });
  });

  // ===========================================================================
  // Security Constants Tests
  // ===========================================================================
  describe('Security Constants', () => {
    test('MAX_HTTP_TIMEOUT is reasonable', () => {
      const { MAX_HTTP_TIMEOUT } = services;
      expect(MAX_HTTP_TIMEOUT).toBeGreaterThanOrEqual(5000);
      expect(MAX_HTTP_TIMEOUT).toBeLessThanOrEqual(60000);
    });

    test('MAX_PS_LINES prevents DoS', () => {
      const { MAX_PS_LINES } = services;
      expect(MAX_PS_LINES).toBeGreaterThan(0);
      expect(MAX_PS_LINES).toBeLessThanOrEqual(10000);
    });

    test('MAX_OUTPUT_BUFFER_SIZE is defined', () => {
      const { MAX_OUTPUT_BUFFER_SIZE } = services;
      expect(MAX_OUTPUT_BUFFER_SIZE).toBeGreaterThan(0);
    });
  });
});
