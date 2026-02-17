/**
 * circuit-breaker.js - Circuit Breaker Pattern for MasterClaw CLI
 *
 * Provides fault tolerance and prevents cascading failures by:
 * - Opening the circuit after consecutive failures (fail-fast)
 * - Half-open state for testing recovery
 * - Automatic recovery detection
 * - Per-service circuit isolation
 *
 * This complements the retry logic by preventing repeated calls to known-failing services.
 */

const logger = require('./logger').child('circuit-breaker');
const { logAudit } = require('./audit');

// Audit event type constants (to avoid circular dependency issues)
const AUDIT_EVENT_TYPES = {
  AUTH_FAILURE: 'AUTH_FAILURE',
  CONFIG_WRITE: 'CONFIG_WRITE',
};

// =============================================================================
// Circuit Breaker States
// =============================================================================

const CircuitState = {
  CLOSED: 'CLOSED',       // Normal operation - requests pass through
  OPEN: 'OPEN',           // Failure threshold exceeded - requests fail fast
  HALF_OPEN: 'HALF_OPEN', // Testing if service has recovered
};

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG = {
  // Number of failures before opening the circuit
  failureThreshold: 5,
  
  // Time in milliseconds before attempting to close (half-open)
  resetTimeoutMs: 30000,
  
  // Number of successes in half-open state before closing
  successThreshold: 3,
  
  // Monitor window for failures (sliding window in ms)
  monitorWindowMs: 60000,
  
  // Minimum number of calls before calculating error rate
  minCallsBeforeCalculation: 3,
  
  // Error rate threshold percentage (0-100) - if exceeded, circuit opens
  errorRateThreshold: 50,
};

// =============================================================================
// Circuit Breaker Registry
// =============================================================================

/** Map of service name to circuit breaker instance */
const circuits = new Map();

/** Global configuration (can be overridden per circuit) */
let globalConfig = { ...DEFAULT_CONFIG };

// =============================================================================
// Circuit Breaker Class
// =============================================================================

class CircuitBreaker {
  /**
   * Create a new circuit breaker
   * @param {string} name - Circuit name (typically service name)
   * @param {Object} config - Circuit configuration
   */
  constructor(name, config = {}) {
    this.name = name;
    this.config = { ...globalConfig, ...config };
    
    // Current state
    this.state = CircuitState.CLOSED;
    
    // Failure tracking
    this.failures = [];
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    
    // Statistics
    this.stats = {
      totalCalls: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      stateTransitions: [],
      lastFailureTime: null,
      lastSuccessTime: null,
      openedAt: null,
      closedAt: Date.now(),
    };
    
    // Timer for half-open transition
    this.resetTimer = null;
    
    logger.debug(`Circuit breaker '${name}' initialized`, { config: this.config });
  }

  /**
   * Record a successful call
   */
  recordSuccess() {
    const now = Date.now();
    this.stats.totalCalls++;
    this.stats.totalSuccesses++;
    this.stats.lastSuccessTime = now;
    this.consecutiveFailures = 0;
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.consecutiveSuccesses++;
      logger.debug(`Circuit '${this.name}' half-open success (${this.consecutiveSuccesses}/${this.config.successThreshold})`);
      
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        this.closeCircuit();
      }
    }
  }

  /**
   * Record a failed call
   * @param {Error} error - The error that occurred
   */
  recordFailure(error) {
    const now = Date.now();
    this.stats.totalCalls++;
    this.stats.totalFailures++;
    this.stats.lastFailureTime = now;
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;
    
    // Add failure to sliding window
    this.failures.push(now);
    this.cleanupOldFailures(now);
    
    logger.debug(`Circuit '${this.name}' failure recorded`, {
      consecutiveFailures: this.consecutiveFailures,
      totalFailures: this.failures.length,
      error: error?.message,
    });

    // Check if we should open the circuit
    if (this.state === CircuitState.CLOSED) {
      this.checkThresholds();
    } else if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in half-open state reopens the circuit
      this.openCircuit('Failure in half-open state');
    }
  }

  /**
   * Clean up failures outside the monitor window
   * @param {number} now - Current timestamp
   */
  cleanupOldFailures(now) {
    const cutoff = now - this.config.monitorWindowMs;
    this.failures = this.failures.filter(timestamp => timestamp >= cutoff);
  }

  /**
   * Check if failure thresholds have been exceeded
   */
  checkThresholds() {
    // Check consecutive failure threshold
    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.openCircuit(`Consecutive failures threshold exceeded (${this.consecutiveFailures})`);
      return;
    }

    // Check error rate threshold (only if we have enough calls)
    if (this.stats.totalCalls >= this.config.minCallsBeforeCalculation) {
      const errorRate = (this.failures.length / this.stats.totalCalls) * 100;
      if (errorRate >= this.config.errorRateThreshold) {
        this.openCircuit(`Error rate threshold exceeded (${errorRate.toFixed(1)}%)`);
      }
    }
  }

  /**
   * Open the circuit
   * @param {string} reason - Reason for opening
   */
  openCircuit(reason) {
    if (this.state === CircuitState.OPEN) return;
    
    const previousState = this.state;
    this.state = CircuitState.OPEN;
    this.stats.openedAt = Date.now();
    
    this.stats.stateTransitions.push({
      from: previousState,
      to: CircuitState.OPEN,
      reason,
      timestamp: new Date().toISOString(),
    });

    logger.warn(`Circuit '${this.name}' OPENED: ${reason}`);
    
    // Log audit event for security/monitoring (non-blocking)
    logAudit(AUDIT_EVENT_TYPES.AUTH_FAILURE, {
      circuit: this.name,
      reason,
      consecutiveFailures: this.consecutiveFailures,
      totalFailures: this.failures.length,
    }).catch(() => {});

    // Schedule transition to half-open
    this.scheduleReset();
  }

  /**
   * Close the circuit (normal operation)
   */
  closeCircuit() {
    if (this.state === CircuitState.CLOSED) return;
    
    const previousState = this.state;
    this.state = CircuitState.CLOSED;
    this.stats.closedAt = Date.now();
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.failures = [];
    
    this.stats.stateTransitions.push({
      from: previousState,
      to: CircuitState.CLOSED,
      reason: 'Service recovered',
      timestamp: new Date().toISOString(),
    });

    logger.info(`Circuit '${this.name}' CLOSED: Service recovered`);
    
    // Clear any pending reset timer
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }

    // Log audit event (non-blocking)
    logAudit(AUDIT_EVENT_TYPES.CONFIG_WRITE, {
      circuit: this.name,
      previousState,
      downtimeMs: this.stats.openedAt ? Date.now() - this.stats.openedAt : 0,
    }).catch(() => {});
  }

  /**
   * Transition to half-open state for recovery testing
   */
  halfOpenCircuit() {
    if (this.state !== CircuitState.OPEN) return;
    
    const previousState = this.state;
    this.state = CircuitState.HALF_OPEN;
    this.consecutiveSuccesses = 0;
    this.resetTimer = null;
    
    this.stats.stateTransitions.push({
      from: previousState,
      to: CircuitState.HALF_OPEN,
      reason: 'Reset timeout elapsed',
      timestamp: new Date().toISOString(),
    });

    logger.info(`Circuit '${this.name}' HALF-OPEN: Testing recovery`);
  }

  /**
   * Schedule transition to half-open after reset timeout
   */
  scheduleReset() {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }
    
    this.resetTimer = setTimeout(() => {
      this.halfOpenCircuit();
    }, this.config.resetTimeoutMs);
  }

  /**
   * Check if a call should be allowed
   * @returns {Object} - Result with allowed boolean and state info
   */
  canExecute() {
    if (this.state === CircuitState.CLOSED) {
      return { allowed: true, state: this.state };
    }
    
    if (this.state === CircuitState.OPEN) {
      return {
        allowed: false,
        state: this.state,
        reason: `Circuit breaker is OPEN for '${this.name}'`,
        retryAfter: this.stats.openedAt 
          ? Math.max(0, this.config.resetTimeoutMs - (Date.now() - this.stats.openedAt))
          : this.config.resetTimeoutMs,
      };
    }
    
    if (this.state === CircuitState.HALF_OPEN) {
      // In half-open, allow limited traffic for testing
      return { allowed: true, state: this.state, testing: true };
    }
    
    return { allowed: false, state: this.state, reason: 'Unknown state' };
  }

  /**
   * Get current circuit status
   * @returns {Object} - Status information
   */
  getStatus() {
    const now = Date.now();
    this.cleanupOldFailures(now);
    
    const errorRate = this.stats.totalCalls > 0 
      ? (this.stats.totalFailures / this.stats.totalCalls * 100).toFixed(1)
      : '0.0';
    
    return {
      name: this.name,
      state: this.state,
      config: this.config,
      stats: {
        ...this.stats,
        errorRate: `${errorRate}%`,
        failuresInWindow: this.failures.length,
      },
      health: this.getHealthIndicator(),
    };
  }

  /**
   * Get a health indicator for monitoring
   * @returns {string} - Health status
   */
  getHealthIndicator() {
    switch (this.state) {
      case CircuitState.CLOSED:
        if (this.consecutiveFailures > 0) {
          return 'degraded';
        }
        return 'healthy';
      case CircuitState.HALF_OPEN:
        return 'recovering';
      case CircuitState.OPEN:
        return 'unhealthy';
      default:
        return 'unknown';
    }
  }
}

// =============================================================================
// Circuit Breaker Management
// =============================================================================

/**
 * Get or create a circuit breaker for a service
 * @param {string} name - Service/circuit name
 * @param {Object} config - Optional configuration
 * @returns {CircuitBreaker} - Circuit breaker instance
 */
function getCircuit(name, config = {}) {
  if (!circuits.has(name)) {
    circuits.set(name, new CircuitBreaker(name, config));
  }
  return circuits.get(name);
}

/**
 * Remove a circuit breaker
 * @param {string} name - Circuit name to remove
 */
function removeCircuit(name) {
  const circuit = circuits.get(name);
  if (circuit && circuit.resetTimer) {
    clearTimeout(circuit.resetTimer);
  }
  circuits.delete(name);
}

/**
 * Get status of all circuits
 * @returns {Array} - Array of circuit statuses
 */
function getAllCircuitStatus() {
  return Array.from(circuits.values()).map(c => c.getStatus());
}

/**
 * Reset all circuits (useful for testing or manual recovery)
 */
function resetAllCircuits() {
  for (const [name, circuit] of circuits) {
    if (circuit.resetTimer) {
      clearTimeout(circuit.resetTimer);
    }
    circuit.closeCircuit();
  }
}

/**
 * Configure global circuit breaker defaults
 * @param {Object} config - Configuration overrides
 */
function configure(config = {}) {
  globalConfig = { ...DEFAULT_CONFIG, ...config };
  logger.debug('Global circuit breaker configuration updated', { config: globalConfig });
}

/**
 * Get global configuration
 * @returns {Object} - Current global configuration
 */
function getConfig() {
  return { ...globalConfig };
}

// =============================================================================
// Execution Wrapper
// =============================================================================

/**
 * Execute a function with circuit breaker protection
 * 
 * @param {string} circuitName - Name of the circuit to use
 * @param {Function} fn - Async function to execute
 * @param {Object} options - Execution options
 * @param {Object} options.circuitConfig - Circuit configuration (if creating new)
 * @param {boolean} options.throwOnOpen - Throw error if circuit is open (default: true)
 * @returns {Promise<any>} - Function result or error
 * @throws {CircuitBreakerOpenError} - If circuit is open and throwOnOpen is true
 */
async function executeWithCircuit(circuitName, fn, options = {}) {
  const { circuitConfig, throwOnOpen = true } = options;
  
  const circuit = getCircuit(circuitName, circuitConfig);
  const canExecute = circuit.canExecute();
  
  if (!canExecute.allowed) {
    const error = new CircuitBreakerOpenError(
      canExecute.reason,
      circuitName,
      canExecute.retryAfter
    );
    
    if (throwOnOpen) {
      throw error;
    }
    
    return { success: false, error, circuitOpen: true };
  }
  
  try {
    const result = await fn();
    circuit.recordSuccess();
    return { success: true, result, circuitState: circuit.state };
  } catch (error) {
    circuit.recordFailure(error);
    throw error;
  }
}

// =============================================================================
// Custom Error Class
// =============================================================================

class CircuitBreakerOpenError extends Error {
  constructor(message, circuitName, retryAfterMs) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
    this.circuitName = circuitName;
    this.retryAfterMs = retryAfterMs;
    this.isCircuitBreakerError = true;
  }
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  // Main classes
  CircuitBreaker,
  CircuitBreakerOpenError,
  
  // Constants
  CircuitState,
  DEFAULT_CONFIG,
  
  // Circuit management
  getCircuit,
  removeCircuit,
  getAllCircuitStatus,
  resetAllCircuits,
  
  // Configuration
  configure,
  getConfig,
  
  // Execution wrapper
  executeWithCircuit,
};
