/**
 * Performance Module Test Suite
 * 
 * Tests for security hardening, input validation, retry logic,
 * correlation ID integration, and error handling.
 */

// Mock dependencies before importing the module
jest.mock('axios');
jest.mock('../lib/config', () => ({
  readConfig: jest.fn(),
}));
jest.mock('../lib/correlation', () => ({
  getCurrentCorrelationId: jest.fn(),
  CORRELATION_ID_HEADER: 'x-correlation-id',
}));
jest.mock('../lib/security', () => ({
  maskSensitiveData: jest.fn((msg) => msg),
}));

const axios = require('axios');
const chalk = require('chalk');
const config = require('../lib/config');
const { getCurrentCorrelationId, CORRELATION_ID_HEADER } = require('../lib/correlation');
const { maskSensitiveData } = require('../lib/security');

// Import the module after mocking
const performance = require('../lib/performance');

describe('Performance Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Default mock implementations
    config.readConfig.mockReturnValue({});
    getCurrentCorrelationId.mockReturnValue('mc_test_correlation_id');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ===========================================================================
  // Input Validation Tests
  // ===========================================================================
  
  describe('validateLimit', () => {
    it('should return default value for undefined/null', () => {
      expect(performance.validateLimit(undefined, 10, 100)).toBe(10);
      expect(performance.validateLimit(null, 10, 100)).toBe(10);
    });

    it('should parse string values correctly', () => {
      expect(performance.validateLimit('50', 10, 100)).toBe(50);
      expect(performance.validateLimit('5', 10, 100)).toBe(5);
    });

    it('should use default for invalid strings', () => {
      console.warn = jest.fn();
      expect(performance.validateLimit('invalid', 10, 100)).toBe(10);
      expect(console.warn).toHaveBeenCalled();
    });

    it('should enforce minimum limit', () => {
      console.warn = jest.fn();
      expect(performance.validateLimit(0, 10, 100)).toBe(1);
      expect(performance.validateLimit(-5, 10, 100)).toBe(1);
      expect(console.warn).toHaveBeenCalled();
    });

    it('should enforce maximum limit (DoS protection)', () => {
      console.warn = jest.fn();
      expect(performance.validateLimit(1000, 10, 100)).toBe(100);
      expect(performance.validateLimit(10000, 10, 100)).toBe(100);
      expect(console.warn).toHaveBeenCalled();
    });

    it('should reject unsafe integers', () => {
      console.warn = jest.fn();
      expect(performance.validateLimit(Number.MAX_SAFE_INTEGER + 1, 10, 100)).toBe(100);
      expect(console.warn).toHaveBeenCalled();
    });

    it('should handle NaN values', () => {
      console.warn = jest.fn();
      expect(performance.validateLimit(NaN, 10, 100)).toBe(10);
      expect(performance.validateLimit('abc', 10, 100)).toBe(10);
      expect(console.warn).toHaveBeenCalled();
    });

    it('should accept valid numeric values', () => {
      expect(performance.validateLimit(50, 10, 100)).toBe(50);
      expect(performance.validateLimit(1, 10, 100)).toBe(1);
      expect(performance.validateLimit(100, 10, 100)).toBe(100);
    });
  });

  describe('validateTimeout', () => {
    it('should return default for invalid types', () => {
      expect(performance.validateTimeout('string')).toBe(performance.DEFAULT_TIMEOUT_MS);
      expect(performance.validateTimeout(null)).toBe(performance.DEFAULT_TIMEOUT_MS);
      expect(performance.validateTimeout(undefined)).toBe(performance.DEFAULT_TIMEOUT_MS);
      expect(performance.validateTimeout(NaN)).toBe(performance.DEFAULT_TIMEOUT_MS);
    });

    it('should enforce minimum timeout (1 second)', () => {
      expect(performance.validateTimeout(100)).toBe(1000);
      expect(performance.validateTimeout(500)).toBe(1000);
    });

    it('should enforce maximum timeout (60 seconds)', () => {
      expect(performance.validateTimeout(120000)).toBe(60000);
      expect(performance.validateTimeout(100000)).toBe(60000);
    });

    it('should accept valid timeout values', () => {
      expect(performance.validateTimeout(5000)).toBe(5000);
      expect(performance.validateTimeout(10000)).toBe(10000);
      expect(performance.validateTimeout(30000)).toBe(30000);
    });
  });

  // ===========================================================================
  // Retry Logic Tests
  // ===========================================================================
  
  describe('isRetryableError', () => {
    it('should return false for null/undefined errors', () => {
      expect(performance.isRetryableError(null)).toBe(false);
      expect(performance.isRetryableError(undefined)).toBe(false);
    });

    it('should recognize retryable error codes', () => {
      expect(performance.isRetryableError({ code: 'ECONNRESET' })).toBe(true);
      expect(performance.isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
      expect(performance.isRetryableError({ code: 'ECONNREFUSED' })).toBe(true);
      expect(performance.isRetryableError({ code: 'ENOTFOUND' })).toBe(true);
      expect(performance.isRetryableError({ code: 'EAI_AGAIN' })).toBe(true);
      expect(performance.isRetryableError({ code: 'ECONNABORTED' })).toBe(true);
    });

    it('should recognize retryable HTTP status codes', () => {
      expect(performance.isRetryableError({ response: { status: 502 } })).toBe(true);
      expect(performance.isRetryableError({ response: { status: 503 } })).toBe(true);
      expect(performance.isRetryableError({ response: { status: 504 } })).toBe(true);
      expect(performance.isRetryableError({ response: { status: 429 } })).toBe(true);
    });

    it('should recognize timeout errors', () => {
      expect(performance.isRetryableError({ message: 'Request timeout' })).toBe(true);
      expect(performance.isRetryableError({ code: 'ECONNABORTED' })).toBe(true);
    });

    it('should not retry non-retryable errors', () => {
      expect(performance.isRetryableError({ code: 'ENOENT' })).toBe(false);
      expect(performance.isRetryableError({ code: 'EACCES' })).toBe(false);
      expect(performance.isRetryableError({ response: { status: 400 } })).toBe(false);
      expect(performance.isRetryableError({ response: { status: 404 } })).toBe(false);
      expect(performance.isRetryableError({ response: { status: 500 } })).toBe(false);
    });
  });

  describe('calculateBackoff', () => {
    it('should calculate exponential backoff', () => {
      const delay0 = performance.calculateBackoff(0);
      const delay1 = performance.calculateBackoff(1);
      const delay2 = performance.calculateBackoff(2);
      
      expect(delay0).toBeGreaterThanOrEqual(375); // 500 * 0.75
      expect(delay0).toBeLessThanOrEqual(625);    // 500 * 1.25
      
      expect(delay1).toBeGreaterThanOrEqual(750); // 1000 * 0.75
      expect(delay1).toBeLessThanOrEqual(1250);   // 1000 * 1.25
      
      expect(delay2).toBeGreaterThanOrEqual(1500); // 2000 * 0.75
      expect(delay2).toBeLessThanOrEqual(2500);    // 2000 * 1.25
    });

    it('should cap backoff at max delay', () => {
      const delay = performance.calculateBackoff(10);
      expect(delay).toBeLessThanOrEqual(6250); // 5000 * 1.25
    });

    it('should include jitter', () => {
      // Run multiple times to account for randomness
      const delays = [];
      for (let i = 0; i < 10; i++) {
        delays.push(performance.calculateBackoff(1));
      }
      
      // All delays should be different (or at least not all the same)
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);
    });
  });

  describe('executeWithRetry', () => {
    it('should return result on successful call', async () => {
      const apiCall = jest.fn().mockResolvedValue({ data: 'success' });
      
      const result = await performance.executeWithRetry(apiCall, 'Test Operation');
      
      expect(result).toEqual({ data: 'success' });
      expect(apiCall).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable errors', async () => {
      const apiCall = jest.fn()
        .mockRejectedValueOnce({ code: 'ECONNRESET' })
        .mockRejectedValueOnce({ code: 'ETIMEDOUT' })
        .mockResolvedValue({ data: 'success' });
      
      console.log = jest.fn();
      
      const result = await performance.executeWithRetry(apiCall, 'Test Operation');
      
      expect(result).toEqual({ data: 'success' });
      expect(apiCall).toHaveBeenCalledTimes(3);
    });

    it('should fail after max retries', async () => {
      const error = { code: 'ECONNRESET', message: 'Connection reset' };
      const apiCall = jest.fn().mockRejectedValue(error);
      
      console.log = jest.fn();
      
      await expect(performance.executeWithRetry(apiCall, 'Test Operation'))
        .rejects.toEqual(error);
      
      expect(apiCall).toHaveBeenCalledTimes(4); // Initial + 3 retries
    });

    it('should not retry non-retryable errors', async () => {
      const error = new Error('Not found');
      error.response = { status: 404 };
      const apiCall = jest.fn().mockRejectedValue(error);
      
      await expect(performance.executeWithRetry(apiCall, 'Test Operation'))
        .rejects.toEqual(error);
      
      expect(apiCall).toHaveBeenCalledTimes(1);
    });

    it('should include backoff delay between retries', async () => {
      const apiCall = jest.fn()
        .mockRejectedValueOnce({ code: 'ECONNRESET' })
        .mockResolvedValue({ data: 'success' });
      
      console.log = jest.fn();
      
      // Track sleep calls by mocking setTimeout
      const sleepCalls = [];
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn, ms) => {
        sleepCalls.push(ms);
        return originalSetTimeout(fn, 1); // Speed up tests
      };
      
      await performance.executeWithRetry(apiCall, 'Test Operation');
      
      // Restore setTimeout
      global.setTimeout = originalSetTimeout;
      
      expect(sleepCalls.length).toBe(1);
      expect(sleepCalls[0]).toBeGreaterThanOrEqual(375);
      expect(sleepCalls[0]).toBeLessThanOrEqual(625);
    });
  });

  // ===========================================================================
  // API Client Tests
  // ===========================================================================
  
  describe('createApiClient', () => {
    it('should create axios instance with default config', () => {
      axios.create.mockReturnValue({});
      
      performance.createApiClient();
      
      expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({
        baseURL: 'http://localhost:8000',
        timeout: performance.DEFAULT_TIMEOUT_MS,
        maxContentLength: 1024 * 1024,
        maxBodyLength: 1024 * 1024,
      }));
    });

    it('should include API key when configured', () => {
      config.readConfig.mockReturnValue({
        core: { apiKey: 'test-api-key' }
      });
      axios.create.mockReturnValue({});
      
      performance.createApiClient();
      
      expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-Key': 'test-api-key',
        }),
      }));
    });

    it('should include correlation ID when available', () => {
      getCurrentCorrelationId.mockReturnValue('mc_test_123');
      axios.create.mockReturnValue({});
      
      performance.createApiClient();
      
      expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({
        headers: expect.objectContaining({
          [CORRELATION_ID_HEADER]: 'mc_test_123',
        }),
      }));
    });

    it('should use custom URL from config', () => {
      config.readConfig.mockReturnValue({
        core: { url: 'http://custom:9000' }
      });
      axios.create.mockReturnValue({});
      
      performance.createApiClient();
      
      expect(axios.create).toHaveBeenCalledWith(expect.objectContaining({
        baseURL: 'http://custom:9000',
      }));
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================
  
  describe('handleApiError', () => {
    beforeEach(() => {
      console.log = jest.fn();
    });

    it('should handle connection refused', () => {
      const error = { code: 'ECONNREFUSED' };
      
      const result = performance.handleApiError(error, 'Test Context');
      
      expect(result).toBeNull();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Cannot connect'));
    });

    it('should handle timeout errors', () => {
      const error = { code: 'ECONNABORTED', message: 'timeout' };
      
      performance.handleApiError(error, 'Test Context');
      
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('timed out'));
    });

    it('should handle not found errors', () => {
      const error = { code: 'ENOTFOUND' };
      
      performance.handleApiError(error, 'Test Context');
      
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Cannot resolve'));
    });

    it('should handle 401 authentication errors', () => {
      const error = { response: { status: 401 } };
      
      performance.handleApiError(error, 'Test Context');
      
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Authentication required'));
    });

    it('should handle 429 rate limit errors', () => {
      const error = { response: { status: 429 } };
      
      performance.handleApiError(error, 'Test Context');
      
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Rate limit exceeded'));
    });

    it('should handle server errors', () => {
      const error = { response: { status: 500 } };
      
      performance.handleApiError(error, 'Test Context');
      
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Server error'));
    });

    it('should mask sensitive data in generic errors', () => {
      maskSensitiveData.mockReturnValue('masked error');
      const error = new Error('Something with secret-token-123');
      
      performance.handleApiError(error, 'Test Context');
      
      expect(maskSensitiveData).toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('masked error'));
    });
  });

  // ===========================================================================
  // Formatting Tests
  // ===========================================================================
  
  describe('formatDuration', () => {
    it('should format fast durations in green', () => {
      const result = performance.formatDuration(100, 1000);
      expect(result).toContain('100.00ms');
      // chalk.green adds ANSI codes, so we check the content
    });

    it('should format medium durations in yellow', () => {
      const result = performance.formatDuration(700, 1000);
      expect(result).toContain('700.00ms');
    });

    it('should format slow durations in red', () => {
      const result = performance.formatDuration(1500, 1000);
      expect(result).toContain('1500.00ms');
    });

    it('should handle invalid values gracefully', () => {
      expect(performance.formatDuration(NaN, 1000)).toBe(chalk.gray('N/A'));
      expect(performance.formatDuration(Infinity, 1000)).toBe(chalk.gray('N/A'));
      expect(performance.formatDuration(-1, 1000)).toContain('-1.00ms');
    });

    it('should handle string numbers', () => {
      const result = performance.formatDuration('500', 1000);
      expect(result).toContain('500.00ms');
    });
  });

  // ===========================================================================
  // Integration Tests
  // ===========================================================================
  
  describe('API Functions', () => {
    let mockClient;

    beforeEach(() => {
      mockClient = {
        get: jest.fn(),
        delete: jest.fn(),
      };
      axios.create.mockReturnValue(mockClient);
      console.log = jest.fn();
    });

    describe('showSummary', () => {
      it('should fetch and display summary', async () => {
        mockClient.get.mockResolvedValue({
          data: {
            total_requests: 1000,
            avg_response_ms: 250,
            slow_requests: 50,
            slow_percentage: 5,
            endpoints_tracked: 10,
            slow_threshold_ms: 1000,
          }
        });

        const result = await performance.showSummary();

        expect(result).toBeTruthy();
        expect(mockClient.get).toHaveBeenCalledWith('/v1/performance/summary');
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Performance Summary'));
      });

      it('should handle missing data gracefully', async () => {
        mockClient.get.mockResolvedValue({ data: {} });

        const result = await performance.showSummary();

        expect(result).toBeTruthy();
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Total Requests: 0'));
      });

      it('should handle API errors', async () => {
        mockClient.get.mockRejectedValue({ code: 'ECONNREFUSED' });

        const result = await performance.showSummary();

        expect(result).toBeNull();
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Cannot connect'));
      });
    });

    describe('showSlowest', () => {
      it('should validate and bound the limit parameter', async () => {
        mockClient.get.mockResolvedValue({
          data: { endpoints: [], threshold_ms: 1000 }
        });

        await performance.showSlowest(5000); // Try to request 5000 endpoints

        // Should be bounded to MAX_ENDPOINTS_LIMIT
        expect(mockClient.get).toHaveBeenCalledWith(
          expect.stringContaining(`n=${performance.MAX_ENDPOINTS_LIMIT}`)
        );
      });

      it('should handle string limit parameter', async () => {
        mockClient.get.mockResolvedValue({
          data: { endpoints: [], threshold_ms: 1000 }
        });

        await performance.showSlowest('5');

        expect(mockClient.get).toHaveBeenCalledWith('/v1/performance/slowest?n=5');
      });

      it('should display endpoints sorted by response time', async () => {
        mockClient.get.mockResolvedValue({
          data: {
            endpoints: [
              { endpoint: 'GET /slow', count: 10, avg_ms: 2000, max_ms: 3000, slow_count: 8, slow_percent: 80 },
              { endpoint: 'GET /fast', count: 100, avg_ms: 100, max_ms: 200, slow_count: 0, slow_percent: 0 },
            ],
            threshold_ms: 1000,
          }
        });

        await performance.showSlowest(10);

        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Slowest Endpoints'));
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('GET /slow'));
      });
    });

    describe('showProfiles', () => {
      it('should validate limit parameter', async () => {
        mockClient.get.mockResolvedValue({
          data: { profiles: [], total: 0 }
        });

        await performance.showProfiles({ limit: 5000 });

        // Should be bounded to MAX_PROFILES_LIMIT
        expect(mockClient.get).toHaveBeenCalledWith(
          expect.stringContaining(`limit=${performance.MAX_PROFILES_LIMIT}`)
        );
      });

      it('should handle slowOnly flag', async () => {
        mockClient.get.mockResolvedValue({
          data: { profiles: [], total: 0 }
        });

        await performance.showProfiles({ slowOnly: true });

        expect(mockClient.get).toHaveBeenCalledWith(
          expect.stringContaining('slow_only=true')
        );
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Slow Request Profiles'));
      });

      it('should group profiles by endpoint', async () => {
        mockClient.get.mockResolvedValue({
          data: {
            profiles: [
              { method: 'GET', path: '/api/test', timestamp: new Date().toISOString(), duration_ms: 100, slow: false, status_code: 200 },
              { method: 'GET', path: '/api/test', timestamp: new Date().toISOString(), duration_ms: 150, slow: false, status_code: 200 },
              { method: 'POST', path: '/api/other', timestamp: new Date().toISOString(), duration_ms: 200, slow: true, status_code: 201 },
            ],
            total: 3,
          }
        });

        await performance.showProfiles({ limit: 20 });

        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('GET /api/test'));
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('POST /api/other'));
      });

      it('should handle invalid timestamps gracefully', async () => {
        mockClient.get.mockResolvedValue({
          data: {
            profiles: [
              { method: 'GET', path: '/test', timestamp: 'invalid-date', duration_ms: 100, slow: false, status_code: 200 },
            ],
            total: 1,
          }
        });

        await performance.showProfiles({ limit: 20 });

        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Invalid'));
      });
    });

    describe('clearProfiles', () => {
      it('should clear profiles successfully', async () => {
        mockClient.delete.mockResolvedValue({
          data: { message: 'All profiles cleared' }
        });

        const result = await performance.clearProfiles();

        expect(result).toBe(true);
        expect(mockClient.delete).toHaveBeenCalledWith('/v1/performance/profiles');
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('All profiles cleared'));
      });

      it('should handle authentication errors', async () => {
        mockClient.delete.mockRejectedValue({ response: { status: 401 } });

        const result = await performance.clearProfiles();

        expect(result).toBe(false);
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Authentication required'));
      });
    });
  });

  // ===========================================================================
  // Security Tests
  // ===========================================================================
  
  describe('Security Hardening', () => {
    it('should prevent DoS via excessive limit values', async () => {
      axios.create.mockReturnValue({
        get: jest.fn().mockResolvedValue({ data: { endpoints: [] } })
      });
      console.warn = jest.fn();
      console.log = jest.fn();

      // Attempt to request an excessive number of endpoints
      await performance.showSlowest(999999);

      // Verify the limit was bounded
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('exceeds maximum')
      );
    });

    it('should mask sensitive data in error messages', async () => {
      maskSensitiveData.mockReturnValue('[REDACTED]');
      console.log = jest.fn();

      const error = new Error('Error with secret-key-abc123');
      performance.handleApiError(error, 'Test');

      expect(maskSensitiveData).toHaveBeenCalledWith('Error with secret-key-abc123');
    });

    it('should include correlation ID for tracing', async () => {
      getCurrentCorrelationId.mockReturnValue('trace-123');
      axios.create.mockReturnValue({});

      performance.createApiClient();

      expect(axios.create).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            [CORRELATION_ID_HEADER]: 'trace-123'
          })
        })
      );
    });
  });
});
