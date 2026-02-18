/**
 * Tests for session.js - Session management commands
 * Tests secure HTTP client integration, circuit breaker, retry logic, and error handling
 */

// Mock dependencies before requiring the module
jest.mock('../lib/config', () => ({
  get: jest.fn(),
}));

jest.mock('../lib/http-client', () => ({
  request: jest.fn(),
  allowPrivateIPs: jest.fn(() => ({ _allowPrivateIPs: true })),
  withAudit: jest.fn(() => ({ _audit: true })),
}));

jest.mock('../lib/circuit-breaker', () => ({
  executeWithCircuit: jest.fn((name, fn, options) => fn()),
  CircuitBreakerOpenError: class CircuitBreakerOpenError extends Error {
    constructor(message, circuitName, retryAfterMs) {
      super(message);
      this.name = 'CircuitBreakerOpenError';
      this.circuitName = circuitName;
      this.retryAfterMs = retryAfterMs;
      this.isCircuitBreakerError = true;
    }
  },
}));

const config = require('../lib/config');
const httpClient = require('../lib/http-client');
const { executeWithCircuit } = require('../lib/circuit-breaker');
const {
  apiCall,
  getUserFriendlyError,
  isRetryableError,
  getRetryDelay,
  formatRelativeTime,
  formatDuration,
  CIRCUIT_BREAKER_CONFIG,
  RETRY_CONFIG,
} = require('../lib/session');

// Mock console to reduce noise
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

beforeAll(() => {
  console.log = jest.fn();
  console.error = jest.fn();
});

afterAll(() => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});

beforeEach(() => {
  jest.clearAllMocks();
});

// =============================================================================
// Retry Logic Tests
// =============================================================================

describe('getRetryDelay', () => {
  test('calculates exponential delay', () => {
    const delay0 = getRetryDelay(0);
    const delay1 = getRetryDelay(1);
    const delay2 = getRetryDelay(2);

    // Base delay is 500ms, so delay0 should be around 500ms
    expect(delay0).toBeGreaterThanOrEqual(500);
    expect(delay0).toBeLessThan(700); // 500 + 30% jitter

    // delay1 should be around 1000ms (500 * 2^1)
    expect(delay1).toBeGreaterThanOrEqual(1000);
    expect(delay1).toBeLessThan(1300);

    // delay2 should be around 2000ms (500 * 2^2)
    expect(delay2).toBeGreaterThanOrEqual(2000);
    expect(delay2).toBeLessThan(2600);
  });

  test('applies jitter to prevent thundering herd', () => {
    const delays = [];
    for (let i = 0; i < 10; i++) {
      delays.push(getRetryDelay(1));
    }

    // All delays should be different (jitter in effect)
    const uniqueDelays = new Set(delays);
    expect(uniqueDelays.size).toBeGreaterThan(1);
  });

  test('respects max delay limit', () => {
    const delay = getRetryDelay(10); // Very high attempt number
    expect(delay).toBeLessThanOrEqual(RETRY_CONFIG.maxDelayMs);
  });
});

describe('isRetryableError', () => {
  test('detects retryable HTTP status codes', () => {
    const retryableStatuses = [408, 429, 500, 502, 503, 504];

    for (const status of retryableStatuses) {
      const error = { response: { status } };
      expect(isRetryableError(error)).toBe(true);
    }
  });

  test('detects non-retryable HTTP status codes', () => {
    const nonRetryableStatuses = [400, 401, 403, 404, 422];

    for (const status of nonRetryableStatuses) {
      const error = { response: { status } };
      expect(isRetryableError(error)).toBe(false);
    }
  });

  test('detects retryable error codes', () => {
    const retryableCodes = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND'];

    for (const code of retryableCodes) {
      const error = { code };
      expect(isRetryableError(error)).toBe(true);
    }
  });

  test('detects non-retryable error codes', () => {
    const nonRetryableCodes = ['EACCES', 'EPERM', 'EINVAL'];

    for (const code of nonRetryableCodes) {
      const error = { code };
      expect(isRetryableError(error)).toBe(false);
    }
  });

  test('returns false for errors without status or code', () => {
    expect(isRetryableError({})).toBe(false);
    expect(isRetryableError({ message: 'Some error' })).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });
});

// =============================================================================
// Error Message Translation Tests
// =============================================================================

describe('getUserFriendlyError', () => {
  test('translates circuit breaker errors', () => {
    const err = {
      isCircuitBreakerError: true,
      retryAfterMs: 5000,
    };

    const message = getUserFriendlyError(err);
    expect(message).toContain('temporarily unavailable');
    expect(message).toContain('5');
  });

  test('translates SSRF violations', () => {
    const err = { code: 'SSRF_VIOLATION' };
    const message = getUserFriendlyError(err);
    expect(message).toContain('Security violation');
    expect(message).toContain('Invalid API URL');
  });

  test('translates response too large errors', () => {
    const err = { code: 'RESPONSE_TOO_LARGE' };
    const message = getUserFriendlyError(err);
    expect(message).toContain('Response too large');
  });

  test('translates 404 errors', () => {
    const err = { response: { status: 404 } };
    const message = getUserFriendlyError(err);
    expect(message).toContain('Session not found');
  });

  test('translates 401 errors', () => {
    const err = { response: { status: 401 } };
    const message = getUserFriendlyError(err);
    expect(message).toContain('Authentication required');
  });

  test('translates 403 errors', () => {
    const err = { response: { status: 403 } };
    const message = getUserFriendlyError(err);
    expect(message).toContain('Access denied');
  });

  test('translates 429 errors', () => {
    const err = { response: { status: 429 } };
    const message = getUserFriendlyError(err);
    expect(message).toContain('Too many requests');
  });

  test('translates 500 errors', () => {
    const err = { response: { status: 500, data: { detail: 'Database error' } } };
    const message = getUserFriendlyError(err);
    expect(message).toBe('Database error');
  });

  test('translates ECONNREFUSED', () => {
    const err = { code: 'ECONNREFUSED' };
    const message = getUserFriendlyError(err);
    expect(message).toContain('Cannot connect to MasterClaw Core');
    expect(message).toContain('mc revive');
  });

  test('translates ETIMEDOUT', () => {
    const err = { code: 'ETIMEDOUT' };
    const message = getUserFriendlyError(err);
    expect(message).toContain('timed out');
  });

  test('translates ENOTFOUND', () => {
    const err = { code: 'ENOTFOUND' };
    const message = getUserFriendlyError(err);
    expect(message).toContain('Could not resolve API address');
  });

  test('translates 502/503/504 errors', () => {
    for (const status of [502, 503, 504]) {
      const err = { response: { status } };
      const message = getUserFriendlyError(err);
      expect(message).toContain('Service temporarily unavailable');
    }
  });

  test('provides fallback for unknown errors', () => {
    const err = { message: 'Something weird happened' };
    const message = getUserFriendlyError(err);
    expect(message).toBe('Something weird happened');
  });

  test('provides fallback for errors with no message', () => {
    const message = getUserFriendlyError({});
    expect(message).toBe('An unexpected error occurred');
  });
});

// =============================================================================
// API Call Tests
// =============================================================================

describe('apiCall', () => {
  beforeEach(() => {
    config.get.mockResolvedValue('http://localhost:8000');
  });

  test('makes successful GET request', async () => {
    const mockData = { sessions: [], total: 0 };
    httpClient.request.mockResolvedValue({
      status: 200,
      data: mockData,
      config: {},
    });

    const result = await apiCall('GET', '/v1/sessions', null, { limit: 10 });

    expect(httpClient.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: 'http://localhost:8000/v1/sessions',
      params: { limit: 10 },
      _allowPrivateIPs: true,
      _audit: true,
    }));
    expect(result).toEqual(mockData);
  });

  test('makes successful POST request with data', async () => {
    const postData = { name: 'test-session' };
    const mockResponse = { id: '123', name: 'test-session' };
    httpClient.request.mockResolvedValue({
      status: 201,
      data: mockResponse,
      config: {},
    });

    const result = await apiCall('POST', '/v1/sessions', postData);

    expect(httpClient.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      data: postData,
    }));
    expect(result).toEqual(mockResponse);
  });

  test('uses circuit breaker', async () => {
    httpClient.request.mockResolvedValue({
      status: 200,
      data: {},
      config: {},
    });

    await apiCall('GET', '/v1/sessions');

    expect(executeWithCircuit).toHaveBeenCalledWith(
      'session-api',
      expect.any(Function),
      expect.objectContaining({
        circuitConfig: CIRCUIT_BREAKER_CONFIG,
        throwOnOpen: true,
      })
    );
  });

  test('uses custom circuit name when provided', async () => {
    httpClient.request.mockResolvedValue({
      status: 200,
      data: {},
      config: {},
    });

    await apiCall('GET', '/v1/sessions', null, null, { circuitName: 'custom-circuit' });

    expect(executeWithCircuit).toHaveBeenCalledWith(
      'custom-circuit',
      expect.any(Function),
      expect.any(Object)
    );
  });

  test('throws error on HTTP 4xx status', async () => {
    httpClient.request.mockResolvedValue({
      status: 404,
      data: { detail: 'Session not found' },
      config: {},
    });

    await expect(apiCall('GET', '/v1/sessions/123')).rejects.toThrow('Session not found');
  });

  test('throws error on HTTP 5xx status', async () => {
    httpClient.request.mockResolvedValue({
      status: 500,
      data: { detail: 'Internal server error' },
      config: {},
    });

    await expect(apiCall('GET', '/v1/sessions')).rejects.toThrow('Internal server error');
  });

  test('retries on retryable errors', async () => {
    // First two calls fail with ECONNRESET, third succeeds
    httpClient.request
      .mockRejectedValueOnce({ code: 'ECONNRESET', message: 'Connection reset' })
      .mockRejectedValueOnce({ code: 'ECONNRESET', message: 'Connection reset' })
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        config: {},
      });

    const result = await apiCall('GET', '/v1/sessions');

    expect(httpClient.request).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ success: true });
  });

  test('retries on 503 status', async () => {
    httpClient.request
      .mockResolvedValueOnce({
        status: 503,
        data: { detail: 'Service unavailable' },
        config: {},
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { success: true },
        config: {},
      });

    const result = await apiCall('GET', '/v1/sessions');

    expect(httpClient.request).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ success: true });
  });

  test('does not retry on non-retryable errors', async () => {
    httpClient.request.mockRejectedValue({
      code: 'EACCES',
      message: 'Permission denied',
    });

    await expect(apiCall('GET', '/v1/sessions')).rejects.toThrow('Permission denied');
    expect(httpClient.request).toHaveBeenCalledTimes(1);
  });

  test('gives up after max retries', async () => {
    httpClient.request.mockRejectedValue({
      code: 'ECONNRESET',
      message: 'Connection reset',
    });

    await expect(apiCall('GET', '/v1/sessions')).rejects.toThrow('Connection reset');
    expect(httpClient.request).toHaveBeenCalledTimes(RETRY_CONFIG.maxRetries + 1);
  });

  test('does not retry if circuit breaker is open', async () => {
    const circuitError = new Error('Circuit is open');
    circuitError.isCircuitBreakerError = true;

    httpClient.request.mockRejectedValue(circuitError);

    await expect(apiCall('GET', '/v1/sessions')).rejects.toMatchObject({
      isCircuitBreakerError: true,
    });
    expect(httpClient.request).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Format Utility Tests
// =============================================================================

describe('formatRelativeTime', () => {
  const now = new Date();

  test('formats just now', () => {
    const date = new Date(now - 30000); // 30 seconds ago
    expect(formatRelativeTime(date.toISOString())).toBe('just now');
  });

  test('formats minutes ago', () => {
    const date = new Date(now - 5 * 60000); // 5 minutes ago
    expect(formatRelativeTime(date.toISOString())).toBe('5m ago');
  });

  test('formats hours ago', () => {
    const date = new Date(now - 3 * 3600000); // 3 hours ago
    expect(formatRelativeTime(date.toISOString())).toBe('3h ago');
  });

  test('formats days ago', () => {
    const date = new Date(now - 2 * 86400000); // 2 days ago
    expect(formatRelativeTime(date.toISOString())).toBe('2d ago');
  });

  test('formats older dates', () => {
    const date = new Date('2023-01-01');
    const result = formatRelativeTime(date.toISOString());
    expect(result).toContain('/'); // Should be a date format
  });
});

describe('formatDuration', () => {
  test('formats less than 1 minute', () => {
    expect(formatDuration(0.5)).toBe('< 1 min');
  });

  test('formats minutes', () => {
    expect(formatDuration(45)).toBe('45 min');
  });

  test('formats hours and minutes', () => {
    expect(formatDuration(90)).toBe('1h 30m');
  });

  test('formats exact hours', () => {
    expect(formatDuration(120)).toBe('2h 0m');
  });
});

// =============================================================================
// Configuration Constants Tests
// =============================================================================

describe('Configuration Constants', () => {
  test('CIRCUIT_BREAKER_CONFIG has expected values', () => {
    expect(CIRCUIT_BREAKER_CONFIG.failureThreshold).toBe(3);
    expect(CIRCUIT_BREAKER_CONFIG.resetTimeoutMs).toBe(10000);
    expect(CIRCUIT_BREAKER_CONFIG.successThreshold).toBe(2);
  });

  test('RETRY_CONFIG has expected values', () => {
    expect(RETRY_CONFIG.maxRetries).toBe(3);
    expect(RETRY_CONFIG.baseDelayMs).toBe(500);
    expect(RETRY_CONFIG.maxDelayMs).toBe(5000);
    expect(RETRY_CONFIG.retryableStatuses).toContain(500);
    expect(RETRY_CONFIG.retryableStatuses).toContain(503);
    expect(RETRY_CONFIG.retryableCodes).toContain('ECONNRESET');
    expect(RETRY_CONFIG.retryableCodes).toContain('ETIMEDOUT');
  });
});

// =============================================================================
// Security Integration Tests
// =============================================================================

describe('Security Integration', () => {
  beforeEach(() => {
    config.get.mockResolvedValue('http://localhost:8000');
  });

  test('uses allowPrivateIPs for localhost connections', async () => {
    httpClient.request.mockResolvedValue({
      status: 200,
      data: {},
      config: {},
    });

    await apiCall('GET', '/v1/sessions');

    expect(httpClient.allowPrivateIPs).toHaveBeenCalled();
  });

  test('uses audit logging', async () => {
    httpClient.request.mockResolvedValue({
      status: 200,
      data: {},
      config: {},
    });

    await apiCall('GET', '/v1/sessions');

    expect(httpClient.withAudit).toHaveBeenCalled();
  });
});
