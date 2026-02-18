/**
 * circuit-breaker.test.js - Test suite for Circuit Breaker module
 * 
 * Tests cover:
 * - Circuit state transitions (CLOSED -> OPEN -> HALF_OPEN -> CLOSED)
 * - Failure threshold triggering
 * - Error rate threshold triggering
 * - Automatic recovery (half-open transition)
 * - Success threshold for closing
 * - Sliding window failure tracking
 * - Multiple circuit isolation
 * - Edge cases and error conditions
 */

const {
  CircuitBreaker,
  CircuitBreakerOpenError,
  CircuitState,
  DEFAULT_CONFIG,
  getCircuit,
  removeCircuit,
  getAllCircuitStatus,
  resetAllCircuits,
  executeWithCircuit,
  configure,
  getConfig,
} = require('../lib/circuit-breaker');

// Mock the audit and logger modules
jest.mock('../lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/logger', () => ({
  child: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe('CircuitBreaker', () => {
  beforeEach(() => {
    // Clear all circuits before each test
    resetAllCircuits();
    // Reset to default configuration
    configure(DEFAULT_CONFIG);
  });

  afterEach(() => {
    // Clean up any remaining timers
    resetAllCircuits();
    jest.clearAllMocks();
  });

  describe('Initialization', () => {
    test('should initialize in CLOSED state', () => {
      const cb = new CircuitBreaker('test-service');
      expect(cb.state).toBe(CircuitState.CLOSED);
      expect(cb.name).toBe('test-service');
    });

    test('should use default config when none provided', () => {
      const cb = new CircuitBreaker('test');
      expect(cb.config.failureThreshold).toBe(DEFAULT_CONFIG.failureThreshold);
      expect(cb.config.resetTimeoutMs).toBe(DEFAULT_CONFIG.resetTimeoutMs);
    });

    test('should merge custom config with defaults', () => {
      const customConfig = { failureThreshold: 3 };
      const cb = new CircuitBreaker('test', customConfig);
      expect(cb.config.failureThreshold).toBe(3);
      expect(cb.config.resetTimeoutMs).toBe(DEFAULT_CONFIG.resetTimeoutMs);
    });

    test('should initialize stats correctly', () => {
      const cb = new CircuitBreaker('test');
      expect(cb.stats.totalCalls).toBe(0);
      expect(cb.stats.totalSuccesses).toBe(0);
      expect(cb.stats.totalFailures).toBe(0);
      expect(cb.stats.stateTransitions).toEqual([]);
    });
  });

  describe('Record Success', () => {
    test('should increment total calls and successes', () => {
      const cb = new CircuitBreaker('test');
      cb.recordSuccess();
      
      expect(cb.stats.totalCalls).toBe(1);
      expect(cb.stats.totalSuccesses).toBe(1);
      expect(cb.stats.lastSuccessTime).toBeTruthy();
    });

    test('should reset consecutive failures', () => {
      const cb = new CircuitBreaker('test');
      cb.consecutiveFailures = 3;
      cb.recordSuccess();
      
      expect(cb.consecutiveFailures).toBe(0);
    });

    test('should not change state when CLOSED', () => {
      const cb = new CircuitBreaker('test');
      cb.recordSuccess();
      
      expect(cb.state).toBe(CircuitState.CLOSED);
    });

    test('should track consecutive successes in HALF_OPEN', () => {
      const cb = new CircuitBreaker('test', { successThreshold: 2 });
      cb.state = CircuitState.HALF_OPEN;
      
      cb.recordSuccess();
      expect(cb.consecutiveSuccesses).toBe(1);
      expect(cb.state).toBe(CircuitState.HALF_OPEN);
    });

    test('should close circuit after success threshold in HALF_OPEN', () => {
      const cb = new CircuitBreaker('test', { successThreshold: 2 });
      cb.state = CircuitState.HALF_OPEN;
      
      cb.recordSuccess();
      cb.recordSuccess();
      
      expect(cb.state).toBe(CircuitState.CLOSED);
    });
  });

  describe('Record Failure', () => {
    test('should increment total calls and failures', () => {
      const cb = new CircuitBreaker('test');
      cb.recordFailure(new Error('Test error'));
      
      expect(cb.stats.totalCalls).toBe(1);
      expect(cb.stats.totalFailures).toBe(1);
      expect(cb.stats.lastFailureTime).toBeTruthy();
    });

    test('should increment consecutive failures', () => {
      const cb = new CircuitBreaker('test');
      cb.recordFailure(new Error('Error 1'));
      cb.recordFailure(new Error('Error 2'));
      
      expect(cb.consecutiveFailures).toBe(2);
    });

    test('should reset consecutive successes', () => {
      const cb = new CircuitBreaker('test');
      cb.consecutiveSuccesses = 2;
      cb.recordFailure(new Error('Test'));
      
      expect(cb.consecutiveSuccesses).toBe(0);
    });

    test('should open circuit after consecutive failure threshold', () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 3 });
      
      cb.recordFailure(new Error('Error 1'));
      cb.recordFailure(new Error('Error 2'));
      expect(cb.state).toBe(CircuitState.CLOSED);
      
      cb.recordFailure(new Error('Error 3'));
      expect(cb.state).toBe(CircuitState.OPEN);
    });

    test('should open circuit in HALF_OPEN on any failure', () => {
      const cb = new CircuitBreaker('test');
      cb.state = CircuitState.HALF_OPEN;
      cb.consecutiveSuccesses = 2;
      
      cb.recordFailure(new Error('Test'));
      
      expect(cb.state).toBe(CircuitState.OPEN);
      expect(cb.consecutiveSuccesses).toBe(0);
    });

    test('should not open circuit if already OPEN', () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 1 });
      cb.recordFailure(new Error('First'));
      
      const openedAt = cb.stats.openedAt;
      cb.recordFailure(new Error('Second'));
      
      expect(cb.stats.openedAt).toBe(openedAt);
    });
  });

  describe('Sliding Window', () => {
    test('should track failures in sliding window', () => {
      const cb = new CircuitBreaker('test', { monitorWindowMs: 1000 });
      
      cb.recordFailure(new Error('Error'));
      expect(cb.failures.length).toBe(1);
    });

    test('should clean up old failures outside window', () => {
      const cb = new CircuitBreaker('test', { monitorWindowMs: 100 });
      
      cb.recordFailure(new Error('Old'));
      
      // Fast-forward time
      const oldTime = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(oldTime + 200);
      
      cb.recordFailure(new Error('New'));
      expect(cb.failures.length).toBe(1);
      
      Date.now.mockRestore();
    });
  });

  describe('Error Rate Threshold', () => {
    test('should open circuit when error rate exceeds threshold', () => {
      const cb = new CircuitBreaker('test', {
        minCallsBeforeCalculation: 4,
        errorRateThreshold: 50,
      });
      
      // 3 failures out of 4 calls = 75% error rate
      cb.recordFailure(new Error('1'));
      cb.recordFailure(new Error('2'));
      cb.recordFailure(new Error('3'));
      cb.recordSuccess();
      
      expect(cb.state).toBe(CircuitState.OPEN);
    });

    test('should not calculate error rate before minimum calls', () => {
      const cb = new CircuitBreaker('test', {
        minCallsBeforeCalculation: 5,
        errorRateThreshold: 10,
      });
      
      // 3 failures but not enough total calls
      cb.recordFailure(new Error('1'));
      cb.recordFailure(new Error('2'));
      cb.recordFailure(new Error('3'));
      
      expect(cb.state).toBe(CircuitState.CLOSED);
    });
  });

  describe('Automatic Recovery', () => {
    test('should schedule transition to half-open after reset timeout', (done) => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        resetTimeoutMs: 50,
      });
      
      cb.recordFailure(new Error('Test'));
      expect(cb.state).toBe(CircuitState.OPEN);
      
      setTimeout(() => {
        expect(cb.state).toBe(CircuitState.HALF_OPEN);
        done();
      }, 100);
    });

    test('should clear timer when manually closed', (done) => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        resetTimeoutMs: 1000,
      });
      
      cb.recordFailure(new Error('Test'));
      expect(cb.resetTimer).toBeTruthy();
      
      cb.closeCircuit();
      expect(cb.resetTimer).toBeNull();
      
      // Wait to ensure timer doesn't fire
      setTimeout(() => {
        expect(cb.state).toBe(CircuitState.CLOSED);
        done();
      }, 50);
    });
  });

  describe('Can Execute', () => {
    test('should allow execution when CLOSED', () => {
      const cb = new CircuitBreaker('test');
      const result = cb.canExecute();
      
      expect(result.allowed).toBe(true);
      expect(result.state).toBe(CircuitState.CLOSED);
    });

    test('should deny execution when OPEN', () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 1 });
      cb.recordFailure(new Error('Test'));
      
      const result = cb.canExecute();
      
      expect(result.allowed).toBe(false);
      expect(result.state).toBe(CircuitState.OPEN);
      expect(result.reason).toContain('OPEN');
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    test('should allow execution when HALF_OPEN', () => {
      const cb = new CircuitBreaker('test');
      cb.state = CircuitState.HALF_OPEN;
      
      const result = cb.canExecute();
      
      expect(result.allowed).toBe(true);
      expect(result.state).toBe(CircuitState.HALF_OPEN);
      expect(result.testing).toBe(true);
    });
  });

  describe('Get Status', () => {
    test('should return current status', () => {
      const cb = new CircuitBreaker('test');
      const status = cb.getStatus();
      
      expect(status.name).toBe('test');
      expect(status.state).toBe(CircuitState.CLOSED);
      expect(status.stats.totalCalls).toBe(0);
      expect(status.health).toBe('healthy');
    });

    test('should calculate error rate correctly', () => {
      const cb = new CircuitBreaker('test');
      cb.recordFailure(new Error('Test'));
      cb.recordSuccess();
      
      const status = cb.getStatus();
      expect(status.stats.errorRate).toBe('50.0%');
    });

    test('should return degraded health when failures exist', () => {
      const cb = new CircuitBreaker('test');
      cb.consecutiveFailures = 2;
      
      const status = cb.getStatus();
      expect(status.health).toBe('degraded');
    });

    test('should return unhealthy when OPEN', () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 1 });
      cb.recordFailure(new Error('Test'));
      
      const status = cb.getStatus();
      expect(status.health).toBe('unhealthy');
    });
  });

  describe('State Transitions', () => {
    test('should record state transitions', () => {
      const cb = new CircuitBreaker('test', { failureThreshold: 1 });
      
      cb.recordFailure(new Error('Test'));
      
      expect(cb.stats.stateTransitions).toHaveLength(1);
      expect(cb.stats.stateTransitions[0].from).toBe(CircuitState.CLOSED);
      expect(cb.stats.stateTransitions[0].to).toBe(CircuitState.OPEN);
    });

    test('should record transition to CLOSED on recovery', () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        successThreshold: 1,
      });
      
      cb.recordFailure(new Error('Test'));
      cb.state = CircuitState.HALF_OPEN;
      cb.recordSuccess();
      
      const closedTransition = cb.stats.stateTransitions.find(
        t => t.to === CircuitState.CLOSED
      );
      expect(closedTransition).toBeTruthy();
    });
  });
});

describe('Circuit Breaker Registry', () => {
  beforeEach(() => {
    resetAllCircuits();
  });

  test('getCircuit should create new circuit if not exists', () => {
    const cb = getCircuit('new-service');
    expect(cb).toBeInstanceOf(CircuitBreaker);
    expect(cb.name).toBe('new-service');
  });

  test('getCircuit should return existing circuit', () => {
    const cb1 = getCircuit('existing-service');
    const cb2 = getCircuit('existing-service');
    expect(cb1).toBe(cb2);
  });

  test('getCircuit should apply config to new circuits', () => {
    const cb = getCircuit('config-test', { failureThreshold: 10 });
    expect(cb.config.failureThreshold).toBe(10);
  });

  test('removeCircuit should remove circuit', () => {
    getCircuit('remove-test');
    removeCircuit('remove-test');
    
    const cb = getCircuit('remove-test');
    expect(cb.stats.totalCalls).toBe(0); // Fresh circuit
  });

  test('getAllCircuitStatus should return all circuits', () => {
    getCircuit('service-1');
    getCircuit('service-2');
    
    const statuses = getAllCircuitStatus();
    expect(statuses).toHaveLength(2);
    expect(statuses.map(s => s.name)).toContain('service-1');
    expect(statuses.map(s => s.name)).toContain('service-2');
  });

  test('resetAllCircuits should close all open circuits', () => {
    const cb = getCircuit('reset-test', { failureThreshold: 1 });
    cb.recordFailure(new Error('Test'));
    
    expect(cb.state).toBe(CircuitState.OPEN);
    
    resetAllCircuits();
    expect(cb.state).toBe(CircuitState.CLOSED);
  });
});

describe('Configuration', () => {
  afterEach(() => {
    configure(DEFAULT_CONFIG);
  });

  test('configure should update global config', () => {
    configure({ failureThreshold: 10 });
    const config = getConfig();
    expect(config.failureThreshold).toBe(10);
  });

  test('new circuits should use updated global config', () => {
    configure({ resetTimeoutMs: 60000 });
    const cb = new CircuitBreaker('test');
    expect(cb.config.resetTimeoutMs).toBe(60000);
  });

  test('circuit-specific config should override global', () => {
    configure({ failureThreshold: 10 });
    const cb = new CircuitBreaker('test', { failureThreshold: 3 });
    expect(cb.config.failureThreshold).toBe(3);
  });
});

describe('executeWithCircuit', () => {
  beforeEach(() => {
    resetAllCircuits();
  });

  test('should execute successful function', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    const result = await executeWithCircuit('test', fn);
    
    expect(result.success).toBe(true);
    expect(result.result).toBe('success');
    expect(fn).toHaveBeenCalled();
  });

  test('should record success and return result', async () => {
    const cb = getCircuit('test');
    const fn = jest.fn().mockResolvedValue(42);
    
    await executeWithCircuit('test', fn);
    
    expect(cb.stats.totalSuccesses).toBe(1);
  });

  test('should record failure and throw', async () => {
    const cb = getCircuit('test');
    const fn = jest.fn().mockRejectedValue(new Error('Test error'));
    
    await expect(executeWithCircuit('test', fn)).rejects.toThrow('Test error');
    expect(cb.stats.totalFailures).toBe(1);
  });

  test('should throw CircuitBreakerOpenError when circuit is open', async () => {
    const cb = getCircuit('test', { failureThreshold: 1 });
    cb.recordFailure(new Error('Test'));
    
    const fn = jest.fn().mockResolvedValue('success');
    
    await expect(executeWithCircuit('test', fn)).rejects.toThrow(CircuitBreakerOpenError);
  });

  test('should return error object when throwOnOpen is false', async () => {
    const cb = getCircuit('test', { failureThreshold: 1 });
    cb.recordFailure(new Error('Test'));
    
    const fn = jest.fn().mockResolvedValue('success');
    const result = await executeWithCircuit('test', fn, { throwOnOpen: false });
    
    expect(result.success).toBe(false);
    expect(result.circuitOpen).toBe(true);
    expect(result.error).toBeInstanceOf(CircuitBreakerOpenError);
  });

  test('should pass circuitConfig to new circuit', async () => {
    const fn = jest.fn().mockResolvedValue('success');
    await executeWithCircuit('new-circuit', fn, {
      circuitConfig: { failureThreshold: 2 },
    });
    
    const cb = getCircuit('new-circuit');
    expect(cb.config.failureThreshold).toBe(2);
  });
});

describe('Circuit Isolation', () => {
  beforeEach(() => {
    resetAllCircuits();
  });

  test('failure in one circuit should not affect another', () => {
    const cb1 = getCircuit('service-a', { failureThreshold: 1 });
    const cb2 = getCircuit('service-b', { failureThreshold: 5 });
    
    cb1.recordFailure(new Error('Test'));
    
    expect(cb1.state).toBe(CircuitState.OPEN);
    expect(cb2.state).toBe(CircuitState.CLOSED);
  });

  test('each circuit should have independent failure counts', () => {
    const cb1 = getCircuit('service-a');
    const cb2 = getCircuit('service-b');
    
    cb1.recordFailure(new Error('Test'));
    
    expect(cb1.consecutiveFailures).toBe(1);
    expect(cb2.consecutiveFailures).toBe(0);
  });
});

describe('Edge Cases', () => {
  beforeEach(() => {
    resetAllCircuits();
  });

  test('should handle rapid successive failures', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 100 });
    
    for (let i = 0; i < 1000; i++) {
      cb.recordFailure(new Error(`Error ${i}`));
    }
    
    expect(cb.state).toBe(CircuitState.OPEN);
    expect(cb.stats.totalFailures).toBe(1000);
  });

  test('should handle mixed successes and failures', () => {
    const cb = new CircuitBreaker('test', {
      failureThreshold: 5,
      minCallsBeforeCalculation: 100, // Disable error rate check for this test
    });

    // Pattern: success, fail, success, fail...
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) {
        cb.recordSuccess();
      } else {
        cb.recordFailure(new Error(`Error ${i}`));
      }
    }

    // Should not open because consecutive failures never reached threshold
    expect(cb.state).toBe(CircuitState.CLOSED);
    // After alternating pattern ending with failure (i=9), consecutiveFailures should be 1
    expect(cb.consecutiveFailures).toBe(1);
  });

  test('should handle undefined error in recordFailure', () => {
    const cb = new CircuitBreaker('test');
    
    expect(() => cb.recordFailure()).not.toThrow();
    expect(cb.stats.totalFailures).toBe(1);
  });

  test('half-open circuit should allow limited traffic', () => {
    const cb = new CircuitBreaker('test');
    cb.state = CircuitState.HALF_OPEN;
    
    const result = cb.canExecute();
    expect(result.allowed).toBe(true);
    expect(result.testing).toBe(true);
  });
});
