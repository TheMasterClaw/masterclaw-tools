/**
 * Tests for circuit breaker fallback functionality
 * Run with: npm test -- circuit-breaker.fallback.test.js
 * 
 * These tests verify the graceful degradation capabilities of the circuit breaker,
 * ensuring services can continue operating with reduced functionality when
 * dependencies are unavailable.
 */

const {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  executeWithCircuit,
  getCircuit,
  resetAllCircuits,
} = require('../lib/circuit-breaker');

// Mock logger to avoid console output during tests
jest.mock('../lib/logger', () => ({
  child: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// Mock audit to avoid side effects
jest.mock('../lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

describe('Circuit Breaker Fallback', () => {
  beforeEach(() => {
    resetAllCircuits();
    jest.clearAllMocks();
  });

  afterEach(() => {
    resetAllCircuits();
  });

  // =============================================================================
  // Fallback Value Tests
  // =============================================================================

  describe('fallbackValue', () => {
    test('returns fallback value when circuit is open', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000, // Long timeout to keep circuit open
      });

      // Open the circuit by recording a failure
      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      const fallbackData = { status: 'degraded', data: [] };
      const result = await executeWithCircuit(
        'test-service',
        async () => ({ status: 'ok', data: [1, 2, 3] }),
        { fallbackValue: fallbackData }
      );

      expect(result.success).toBe(true);
      expect(result.result).toEqual(fallbackData);
      expect(result.circuitState).toBe(CircuitState.OPEN);
      expect(result.fallback).toBe(true);
      expect(result.circuitOpen).toBe(true);
    });

    test('fallback value can be null', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      const result = await executeWithCircuit(
        'test-service',
        async () => 'primary',
        { fallbackValue: null }
      );

      expect(result.success).toBe(true);
      expect(result.result).toBeNull();
      expect(result.fallback).toBe(true);
    });

    test('fallback value can be false', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      const result = await executeWithCircuit(
        'test-service',
        async () => true,
        { fallbackValue: false }
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe(false);
      expect(result.fallback).toBe(true);
    });

    test('fallback value can be 0', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      const result = await executeWithCircuit(
        'test-service',
        async () => 42,
        { fallbackValue: 0 }
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe(0);
      expect(result.fallback).toBe(true);
    });

    test('fallback value can be empty string', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      const result = await executeWithCircuit(
        'test-service',
        async () => 'primary',
        { fallbackValue: '' }
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe('');
      expect(result.fallback).toBe(true);
    });

    test('does not use fallback when circuit is closed', async () => {
      const primaryResult = { status: 'ok', data: [1, 2, 3] };
      const fallbackData = { status: 'degraded', data: [] };

      const result = await executeWithCircuit(
        'test-service',
        async () => primaryResult,
        { fallbackValue: fallbackData }
      );

      expect(result.success).toBe(true);
      expect(result.result).toEqual(primaryResult);
      expect(result.fallback).toBe(false);
      expect(result.circuitOpen).toBeUndefined();
    });
  });

  // =============================================================================
  // Fallback Function Tests
  // =============================================================================

  describe('fallbackFn', () => {
    test('executes fallback function when circuit is open', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      const fallbackFn = jest.fn().mockResolvedValue({ cached: true, data: 'cached' });

      const result = await executeWithCircuit(
        'test-service',
        async () => ({ live: true, data: 'live' }),
        { fallbackFn }
      );

      expect(fallbackFn).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.result).toEqual({ cached: true, data: 'cached' });
      expect(result.fallback).toBe(true);
      expect(result.circuitOpen).toBe(true);
    });

    test('fallback function receives no arguments', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      const fallbackFn = jest.fn().mockResolvedValue('result');

      await executeWithCircuit(
        'test-service',
        async () => 'primary',
        { fallbackFn }
      );

      expect(fallbackFn).toHaveBeenCalledWith();
    });

    test('fallback function can be async', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      const fallbackFn = jest.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { async: true };
      });

      const result = await executeWithCircuit(
        'test-service',
        async () => 'primary',
        { fallbackFn }
      );

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ async: true });
    });

    test('falls back to fallbackValue if fallbackFn throws', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      const fallbackFn = jest.fn().mockRejectedValue(new Error('Fallback failed'));
      const fallbackValue = { static: true };

      const result = await executeWithCircuit(
        'test-service',
        async () => 'primary',
        { fallbackFn, fallbackValue }
      );

      expect(fallbackFn).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.result).toEqual(fallbackValue);
      expect(result.fallback).toBe(true);
    });

    test('throws if both fallbackFn and fallbackValue fail', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      const fallbackFn = jest.fn().mockRejectedValue(new Error('Fallback failed'));

      await expect(
        executeWithCircuit(
          'test-service',
          async () => 'primary',
          { fallbackFn } // No fallbackValue provided
        )
      ).rejects.toThrow(CircuitBreakerOpenError);
    });

    test('does not execute fallbackFn when circuit is closed', async () => {
      const fallbackFn = jest.fn().mockResolvedValue('fallback');

      const result = await executeWithCircuit(
        'test-service',
        async () => 'primary',
        { fallbackFn }
      );

      expect(fallbackFn).not.toHaveBeenCalled();
      expect(result.result).toBe('primary');
      expect(result.fallback).toBe(false);
    });

    test('fallbackFn takes precedence over fallbackValue', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      const fallbackFn = jest.fn().mockResolvedValue({ from: 'function' });
      const fallbackValue = { from: 'value' };

      const result = await executeWithCircuit(
        'test-service',
        async () => 'primary',
        { fallbackFn, fallbackValue }
      );

      expect(result.result).toEqual({ from: 'function' });
      expect(fallbackFn).toHaveBeenCalledTimes(1);
    });
  });

  // =============================================================================
  // Fallback Statistics Tests
  // =============================================================================

  describe('fallback statistics', () => {
    test('tracks total fallbacks in circuit stats', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      expect(circuit.stats.totalFallbacks).toBe(0);

      await executeWithCircuit(
        'test-service',
        async () => 'primary',
        { fallbackValue: 'fallback' }
      );

      expect(circuit.stats.totalFallbacks).toBe(1);
      expect(circuit.stats.lastFallbackTime).not.toBeNull();
    });

    test('increments total fallbacks on each fallback use', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      for (let i = 0; i < 5; i++) {
        await executeWithCircuit(
          'test-service',
          async () => 'primary',
          { fallbackValue: `fallback-${i}` }
        );
      }

      expect(circuit.stats.totalFallbacks).toBe(5);
    });

    test('includes fallback stats in getStatus', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      await executeWithCircuit(
        'test-service',
        async () => 'primary',
        { fallbackValue: 'fallback' }
      );

      const status = circuit.getStatus();
      expect(status.stats.totalFallbacks).toBe(1);
      expect(status.stats.lastFallbackTime).toBeDefined();
    });

    test('updates lastFallbackTime on each fallback use', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      await executeWithCircuit(
        'test-service',
        async () => 'primary',
        { fallbackValue: 'fallback1' }
      );

      const firstTime = circuit.stats.lastFallbackTime;

      await new Promise(resolve => setTimeout(resolve, 10));

      await executeWithCircuit(
        'test-service',
        async () => 'primary',
        { fallbackValue: 'fallback2' }
      );

      expect(circuit.stats.lastFallbackTime).toBeGreaterThan(firstTime);
    });
  });

  // =============================================================================
  // Error Handling Tests
  // =============================================================================

  describe('error handling', () => {
    test('throws CircuitBreakerOpenError when no fallback and circuit open', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      await expect(
        executeWithCircuit(
          'test-service',
          async () => 'primary',
          { throwOnOpen: true }
        )
      ).rejects.toThrow(CircuitBreakerOpenError);
    });

    test('returns error object when throwOnOpen is false and no fallback', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      const result = await executeWithCircuit(
        'test-service',
        async () => 'primary',
        { throwOnOpen: false }
      );

      expect(result.success).toBe(false);
      expect(result.circuitOpen).toBe(true);
      expect(result.error).toBeInstanceOf(CircuitBreakerOpenError);
    });

    test('fallback value prevents error even with throwOnOpen true', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      const result = await executeWithCircuit(
        'test-service',
        async () => 'primary',
        { 
          throwOnOpen: true, 
          fallbackValue: 'safe-fallback' 
        }
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe('safe-fallback');
      expect(result.fallback).toBe(true);
    });
  });

  // =============================================================================
  // Integration Tests
  // =============================================================================

  describe('integration scenarios', () => {
    test('graceful degradation pattern: cache fallback', async () => {
      // Simulate a service that falls back to cached data
      const cache = new Map();
      cache.set('user-123', { id: 'user-123', name: 'Cached User' });

      const circuit = getCircuit('user-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      // Open the circuit
      circuit.recordFailure(new Error('Service unavailable'));
      circuit.openCircuit('Service down');

      const result = await executeWithCircuit(
        'user-service',
        async () => {
          // This would normally fetch from the live service
          return { id: 'user-123', name: 'Live User' };
        },
        {
          fallbackFn: async () => {
            // Return cached data when service is down
            return cache.get('user-123') || { id: 'user-123', name: 'Unknown' };
          },
        }
      );

      expect(result.success).toBe(true);
      expect(result.result.name).toBe('Cached User');
      expect(result.fallback).toBe(true);
    });

    test('graceful degradation pattern: feature flag fallback', async () => {
      // Simulate a feature that disables gracefully when service is down
      const circuit = getCircuit('feature-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Service unavailable'));
      circuit.openCircuit('Service down');

      const result = await executeWithCircuit(
        'feature-service',
        async () => {
          // Check if advanced feature is enabled
          return { enabled: true, tier: 'premium' };
        },
        {
          fallbackValue: { enabled: false, tier: 'basic', reason: 'service_unavailable' },
        }
      );

      expect(result.success).toBe(true);
      expect(result.result.enabled).toBe(false);
      expect(result.result.reason).toBe('service_unavailable');
    });

    test('successful primary execution after circuit closes', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 2,
        resetTimeoutMs: 100, // Short timeout for testing
        successThreshold: 1, // Only need 1 success to close from half-open
      });

      // Open the circuit
      circuit.recordFailure(new Error('Error 1'));
      circuit.recordFailure(new Error('Error 2'));

      expect(circuit.state).toBe(CircuitState.OPEN);

      // Wait for circuit to transition to half-open
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(circuit.state).toBe(CircuitState.HALF_OPEN);

      // Success in half-open should close the circuit (with successThreshold: 1)
      const result = await executeWithCircuit(
        'test-service',
        async () => 'success',
        { fallbackValue: 'fallback' }
      );

      expect(result.result).toBe('success');
      expect(result.fallback).toBe(false);
      expect(circuit.state).toBe(CircuitState.CLOSED);
    });
  });

  // =============================================================================
  // Edge Cases
  // =============================================================================

  describe('edge cases', () => {
    test('handles non-function fallbackFn gracefully', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      // Invalid fallbackFn should be treated as not provided
      const result = await executeWithCircuit(
        'test-service',
        async () => 'primary',
        { 
          fallbackFn: 'not-a-function',
          fallbackValue: 'static-fallback'
        }
      );

      expect(result.success).toBe(true);
      expect(result.result).toBe('static-fallback');
    });

    test('handles primary function throwing error when circuit closed', async () => {
      await expect(
        executeWithCircuit(
          'test-service',
          async () => {
            throw new Error('Primary failed');
          },
          { fallbackValue: 'fallback' }
        )
      ).rejects.toThrow('Primary failed');
    });

    test('fallback can return a Promise', async () => {
      const circuit = getCircuit('test-service', {
        failureThreshold: 1,
        resetTimeoutMs: 60000,
      });

      circuit.recordFailure(new Error('Test error'));
      circuit.openCircuit('Test open');

      const result = await executeWithCircuit(
        'test-service',
        async () => 'primary',
        { fallbackValue: Promise.resolve('promise-fallback') }
      );

      // Note: The Promise itself is returned as the value, not awaited
      expect(result.result).toBeInstanceOf(Promise);
    });
  });
});

module.exports = {};
