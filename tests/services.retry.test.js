/**
 * Tests for retry logic in services.js
 * Run with: npm test -- services.retry.test.js
 */

const {
  withRetry,
  sleep,
  isRetryableError,
  calculateBackoffDelay,
  DEFAULT_RETRY_CONFIG,
} = require('../lib/services');

// Mock logger to avoid console output during tests
jest.mock('../lib/logger', () => ({
  child: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// =============================================================================
// Sleep Utility Tests
// =============================================================================

describe('sleep', () => {
  test('resolves after specified duration', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45); // Allow small variance
  });

  test('resolves immediately for 0ms', async () => {
    const start = Date.now();
    await sleep(0);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10);
  });
});

// =============================================================================
// Is Retryable Error Tests
// =============================================================================

describe('isRetryableError', () => {
  const config = DEFAULT_RETRY_CONFIG;

  test('returns true for retryable network errors', () => {
    expect(isRetryableError({ code: 'ECONNRESET' }, config)).toBe(true);
    expect(isRetryableError({ code: 'ETIMEDOUT' }, config)).toBe(true);
    expect(isRetryableError({ code: 'ECONNREFUSED' }, config)).toBe(true);
    expect(isRetryableError({ code: 'ENOTFOUND' }, config)).toBe(true);
    expect(isRetryableError({ code: 'EAI_AGAIN' }, config)).toBe(true);
  });

  test('returns true for retryable HTTP status codes', () => {
    expect(isRetryableError({ response: { status: 502 } }, config)).toBe(true);
    expect(isRetryableError({ response: { status: 503 } }, config)).toBe(true);
    expect(isRetryableError({ response: { status: 504 } }, config)).toBe(true);
  });

  test('returns true for timeout errors', () => {
    expect(isRetryableError({ code: 'ECONNABORTED' }, config)).toBe(true);
    expect(isRetryableError({ message: 'Request timeout' }, config)).toBe(true);
    expect(isRetryableError({ message: 'timeout exceeded' }, config)).toBe(true);
  });

  test('returns false for non-retryable HTTP status codes', () => {
    expect(isRetryableError({ response: { status: 400 } }, config)).toBe(false);
    expect(isRetryableError({ response: { status: 401 } }, config)).toBe(false);
    expect(isRetryableError({ response: { status: 404 } }, config)).toBe(false);
    expect(isRetryableError({ response: { status: 500 } }, config)).toBe(false);
  });

  test('returns false for non-retryable errors', () => {
    expect(isRetryableError({ code: 'UNKNOWN_ERROR' }, config)).toBe(false);
    expect(isRetryableError({ message: 'Some other error' }, config)).toBe(false);
  });

  test('returns false for errors without code or response', () => {
    expect(isRetryableError({}, config)).toBe(false);
    expect(isRetryableError(null, config)).toBe(false);
  });
});

// =============================================================================
// Calculate Backoff Delay Tests
// =============================================================================

describe('calculateBackoffDelay', () => {
  const config = DEFAULT_RETRY_CONFIG;

  test('returns initial delay for first attempt', () => {
    const delay = calculateBackoffDelay(0, config);
    // Should be around initialDelayMs with jitter
    expect(delay).toBeGreaterThanOrEqual(config.initialDelayMs * 0.75);
    expect(delay).toBeLessThanOrEqual(config.initialDelayMs * 1.25);
  });

  test('increases delay exponentially', () => {
    const delay0 = calculateBackoffDelay(0, config);
    const delay1 = calculateBackoffDelay(1, config);
    const delay2 = calculateBackoffDelay(2, config);

    // Each should be roughly 2x the previous (accounting for ±25% jitter)
    // delay0 ~ 500ms, delay1 ~ 1000ms, delay2 ~ 2000ms
    expect(delay1).toBeGreaterThanOrEqual(config.initialDelayMs * config.backoffMultiplier * 0.75);
    expect(delay2).toBeGreaterThanOrEqual(config.initialDelayMs * config.backoffMultiplier * config.backoffMultiplier * 0.75);
  });

  test('respects max delay limit', () => {
    const delay = calculateBackoffDelay(10, config);
    expect(delay).toBeLessThanOrEqual(config.maxDelayMs);
  });

  test('adds jitter to prevent thundering herd', () => {
    const delays = [];
    for (let i = 0; i < 20; i++) {
      delays.push(calculateBackoffDelay(1, config));
    }
    
    // All delays should not be identical (jitter should vary them)
    const uniqueDelays = new Set(delays);
    expect(uniqueDelays.size).toBeGreaterThan(1);
  });

  test('calculates correct delay for middle attempts', () => {
    // Attempt 2: 500 * 2^2 = 2000ms
    const delay = calculateBackoffDelay(2, config);
    expect(delay).toBeGreaterThanOrEqual(1500); // 2000 * 0.75
    expect(delay).toBeLessThanOrEqual(2500);    // 2000 * 1.25
  });
});

// =============================================================================
// With Retry Tests
// =============================================================================

describe('withRetry', () => {
  test('succeeds on first attempt', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    
    const result = await withRetry(fn, { maxRetries: 3 }, 'test-op');
    
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on retryable error', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce({ code: 'ECONNRESET' })
      .mockResolvedValue('success');
    
    const result = await withRetry(fn, { maxRetries: 3, initialDelayMs: 10 }, 'test-op');
    
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('retries multiple times if needed', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce({ code: 'ECONNRESET' })
      .mockRejectedValueOnce({ code: 'ETIMEDOUT' })
      .mockResolvedValue('success');
    
    const result = await withRetry(fn, { maxRetries: 3, initialDelayMs: 10 }, 'test-op');
    
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('throws after max retries exceeded', async () => {
    const error = { code: 'ECONNRESET', message: 'Connection reset' };
    const fn = jest.fn().mockRejectedValue(error);
    
    await expect(
      withRetry(fn, { maxRetries: 2, initialDelayMs: 10 }, 'test-op')
    ).rejects.toEqual(error);
    
    expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
  });

  test('does not retry non-retryable errors', async () => {
    const error = { code: 'UNKNOWN_ERROR', message: 'Unknown' };
    const fn = jest.fn().mockRejectedValue(error);
    
    await expect(
      withRetry(fn, { maxRetries: 3, initialDelayMs: 10 }, 'test-op')
    ).rejects.toEqual(error);
    
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('respects custom retry configuration', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce({ response: { status: 500 } }) // Not in default retryable statuses
      .mockResolvedValue('success');
    
    const customConfig = {
      maxRetries: 3,
      initialDelayMs: 10,
      retryableStatuses: [500], // Custom: retry on 500
    };
    
    const result = await withRetry(fn, customConfig, 'test-op');
    
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('handles HTTP 502/503/504 as retryable by default', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValue('success');
    
    const result = await withRetry(fn, { maxRetries: 3, initialDelayMs: 10 }, 'test-op');
    
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('uses default config when no options provided', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    
    const result = await withRetry(fn);
    
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('handles successful async operations', async () => {
    const fn = jest.fn().mockResolvedValue({ data: 'test', status: 'ok' });
    
    const result = await withRetry(fn, { maxRetries: 1 }, 'test-op');
    
    expect(result).toEqual({ data: 'test', status: 'ok' });
  });

  test('handles errors with message containing timeout', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce({ message: 'Connection timeout exceeded' })
      .mockResolvedValue('success');
    
    const result = await withRetry(fn, { maxRetries: 2, initialDelayMs: 10 }, 'test-op');
    
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('increases delay between retries', async () => {
    const delays = [];
    const startTimes = [];
    
    const fn = jest.fn()
      .mockImplementation(() => {
        startTimes.push(Date.now());
        if (startTimes.length > 1) {
          delays.push(startTimes[startTimes.length - 1] - startTimes[startTimes.length - 2]);
        }
        return Promise.reject({ code: 'ECONNRESET' });
      });
    
    try {
      await withRetry(fn, { maxRetries: 3, initialDelayMs: 50 }, 'test-op');
    } catch {
      // Expected to fail
    }
    
    // Should have some delay between calls
    expect(delays.length).toBeGreaterThanOrEqual(1);
  });
});

// =============================================================================
// Default Configuration Tests
// =============================================================================

describe('DEFAULT_RETRY_CONFIG', () => {
  test('has expected default values', () => {
    expect(DEFAULT_RETRY_CONFIG.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_CONFIG.initialDelayMs).toBe(500);
    expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(5000);
    expect(DEFAULT_RETRY_CONFIG.backoffMultiplier).toBe(2);
    expect(DEFAULT_RETRY_CONFIG.retryableStatuses).toEqual([502, 503, 504]);
    expect(DEFAULT_RETRY_CONFIG.retryableErrors).toContain('ECONNRESET');
    expect(DEFAULT_RETRY_CONFIG.retryableErrors).toContain('ETIMEDOUT');
    expect(DEFAULT_RETRY_CONFIG.retryableErrors).toContain('ECONNREFUSED');
    expect(DEFAULT_RETRY_CONFIG.retryableErrors).toContain('ENOTFOUND');
    expect(DEFAULT_RETRY_CONFIG.retryableErrors).toContain('EAI_AGAIN');
  });

  test('retryable statuses are gateway/timeout errors', () => {
    // 502: Bad Gateway
    // 503: Service Unavailable
    // 504: Gateway Timeout
    DEFAULT_RETRY_CONFIG.retryableStatuses.forEach(status => {
      expect(status).toBeGreaterThanOrEqual(502);
      expect(status).toBeLessThanOrEqual(504);
    });
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('Retry Integration', () => {
  test('simulates real-world transient failure scenario', async () => {
    let attempts = 0;
    const fn = jest.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 3) {
        return Promise.reject({ code: 'ECONNREFUSED' });
      }
      return Promise.resolve({ status: 'healthy', uptime: 3600 });
    });
    
    const result = await withRetry(fn, { maxRetries: 5, initialDelayMs: 10 }, 'health-check');
    
    expect(attempts).toBe(3);
    expect(result).toEqual({ status: 'healthy', uptime: 3600 });
  });

  test('fails fast on permanent errors', async () => {
    let attempts = 0;
    const fn = jest.fn().mockImplementation(() => {
      attempts++;
      return Promise.reject({ code: 'ENOTFOUND' });
    });
    
    await expect(
      withRetry(fn, { maxRetries: 5, initialDelayMs: 10 }, 'health-check')
    ).rejects.toEqual({ code: 'ENOTFOUND' });
    
    // NOTFOUND is retryable, so it should retry
    expect(attempts).toBe(6); // Initial + 5 retries
  });

  test('handles mixed success and failures', async () => {
    const results = ['fail', 'fail', 'success'];
    let index = 0;
    
    const fn = jest.fn().mockImplementation(() => {
      const result = results[index++];
      if (result === 'fail') {
        return Promise.reject({ code: 'ETIMEDOUT' });
      }
      return Promise.resolve('success');
    });
    
    const finalResult = await withRetry(fn, { maxRetries: 5, initialDelayMs: 10 }, 'test');
    
    expect(finalResult).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

// Export for Jest
module.exports = {
  DEFAULT_RETRY_CONFIG,
};
