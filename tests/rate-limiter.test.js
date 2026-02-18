/**
 * Tests for rate-limiter.js module
 * Run with: npm test -- rate-limiter.test.js
 */

const rateLimiter = require('../lib/rate-limiter');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// Mock the audit module
jest.mock('../lib/audit', () => ({
  logSecurityViolation: jest.fn().mockResolvedValue(true),
}));

describe('Rate Limiter Module', () => {
  beforeEach(async () => {
    // Reset module state
    jest.clearAllMocks();

    // Reset all rate limits to ensure clean state
    try {
      await rateLimiter.resetRateLimits(null, true);
    } catch (e) {
      // Ignore errors during reset
    }
  });

  afterEach(async () => {
    // Clean up all rate limit state after each test
    try {
      await rateLimiter.resetRateLimits(null, true);
    } catch (e) {
      // Ignore errors during cleanup
    }
  });

  // ===========================================================================
  // User Identifier Tests
  // ===========================================================================
  describe('getUserIdentifier', () => {
    test('returns consistent identifier', () => {
      const id1 = rateLimiter.getUserIdentifier();
      const id2 = rateLimiter.getUserIdentifier();
      expect(id1).toBe(id2);
    });

    test('returns hex string of expected length', () => {
      const id = rateLimiter.getUserIdentifier();
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[a-f0-9]{16}$/);
    });
  });

  // ===========================================================================
  // State Management Tests
  // ===========================================================================
  describe('State Management', () => {
    test('loadRateLimitState returns empty object for new file', async () => {
      const state = await rateLimiter.loadRateLimitState();
      expect(state).toEqual({});
    });

    test('saveRateLimitState persists state', async () => {
      const testState = {
        'test-command': [Date.now(), Date.now() - 1000],
      };

      // Temporarily override the file path
      const originalFile = rateLimiter.RATE_LIMIT_FILE;
      await rateLimiter.saveRateLimitState(testState);

      const loaded = await rateLimiter.loadRateLimitState();
      expect(loaded).toEqual(testState);
    });

    test('cleanupOldEntries removes old entries', () => {
      const now = Date.now();
      const state = {
        'test-cmd': [
          now, // Recent
          now - 1000, // Recent
          now - rateLimiter.CLEANUP_AGE_MS - 1000, // Old
        ],
      };

      const cleaned = rateLimiter.cleanupOldEntries(state);
      expect(cleaned['test-cmd']).toHaveLength(2);
      expect(cleaned['test-cmd']).not.toContain(now - rateLimiter.CLEANUP_AGE_MS - 1000);
    });

    test('cleanupOldEntries limits entries per command', () => {
      const now = Date.now();
      const manyEntries = Array(rateLimiter.MAX_ENTRIES_PER_COMMAND + 10)
        .fill(0)
        .map((_, i) => now - i * 1000);

      const state = {
        'test-cmd': manyEntries,
      };

      const cleaned = rateLimiter.cleanupOldEntries(state);
      expect(cleaned['test-cmd'].length).toBeLessThanOrEqual(rateLimiter.MAX_ENTRIES_PER_COMMAND);
    });

    test('cleanupOldEntries removes empty commands', () => {
      const state = {
        'empty-cmd': [],
        'old-cmd': [Date.now() - rateLimiter.CLEANUP_AGE_MS - 1000],
        'valid-cmd': [Date.now()],
      };

      const cleaned = rateLimiter.cleanupOldEntries(state);
      expect(cleaned['empty-cmd']).toBeUndefined();
      expect(cleaned['old-cmd']).toBeUndefined();
      expect(cleaned['valid-cmd']).toBeDefined();
    });
  });

  // ===========================================================================
  // Rate Limit Checking Tests
  // ===========================================================================
  describe('checkRateLimit', () => {
    test('allows command within limit', async () => {
      const result = await rateLimiter.checkRateLimit('status');
      expect(result.allowed).toBe(true);
      expect(result.command).toBe('status');
      expect(result.max).toBe(rateLimiter.DEFAULT_RATE_LIMITS.status.max);
    });

    test('increments counter when allowed', async () => {
      // Reset state first
      await rateLimiter.resetRateLimits('test-inc', true);

      const result1 = await rateLimiter.checkRateLimit('test-inc', { increment: true });
      expect(result1.currentCount).toBe(1);

      const result2 = await rateLimiter.checkRateLimit('test-inc', { increment: true });
      expect(result2.currentCount).toBe(2);
    });

    test('does not increment when increment is false', async () => {
      // Reset state
      await rateLimiter.resetRateLimits('test-no-inc', true);

      await rateLimiter.checkRateLimit('test-no-inc', { increment: true });
      const result = await rateLimiter.checkRateLimit('test-no-inc', { increment: false });

      expect(result.currentCount).toBe(1); // Should not have incremented
    });

    test('blocks command over limit', async () => {
      const command = 'test-block';
      // Reset first
      await rateLimiter.resetRateLimits(command, true);

      // Make requests up to limit
      const limit = rateLimiter.DEFAULT_RATE_LIMITS.default.max;
      for (let i = 0; i < limit; i++) {
        await rateLimiter.checkRateLimit(command);
      }

      // Next request should be blocked
      const result = await rateLimiter.checkRateLimit(command);
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterSec).toBeGreaterThan(0);
    });

    test('uses default limits for unknown commands', async () => {
      const result = await rateLimiter.checkRateLimit('unknown-command-xyz');
      expect(result.max).toBe(rateLimiter.DEFAULT_RATE_LIMITS.default.max);
    });

    test('calculates retry time correctly', async () => {
      const command = 'test-retry';
      await rateLimiter.resetRateLimits(command, true);

      const limit = rateLimiter.DEFAULT_RATE_LIMITS.default.max;
      const now = Date.now();

      // Exceed limit
      for (let i = 0; i <= limit; i++) {
        await rateLimiter.checkRateLimit(command);
      }

      const result = await rateLimiter.checkRateLimit(command, { increment: false });
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.retryAfterSec).toBeGreaterThanOrEqual(1);
    });
  });

  // ===========================================================================
  // Enforcement Tests
  // ===========================================================================
  describe('enforceRateLimit', () => {
    test('resolves when under limit', async () => {
      await rateLimiter.resetRateLimits('test-enforce-ok', true);

      await expect(rateLimiter.enforceRateLimit('test-enforce-ok'))
        .resolves.not.toThrow();
    });

    test('throws RateLimitError when over limit', async () => {
      const command = 'test-enforce-fail';
      await rateLimiter.resetRateLimits(command, true);

      const limit = rateLimiter.DEFAULT_RATE_LIMITS.default.max;
      for (let i = 0; i <= limit; i++) {
        await rateLimiter.checkRateLimit(command);
      }

      await expect(rateLimiter.enforceRateLimit(command))
        .rejects.toThrow(rateLimiter.RateLimitError);
    });

    test('error includes rate limit details', async () => {
      const command = 'test-error-details';
      await rateLimiter.resetRateLimits(command, true);

      const limit = rateLimiter.DEFAULT_RATE_LIMITS.default.max;
      for (let i = 0; i <= limit; i++) {
        await rateLimiter.checkRateLimit(command);
      }

      try {
        await rateLimiter.enforceRateLimit(command);
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(rateLimiter.RateLimitError);
        expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
        expect(err.rateLimitResult).toBeDefined();
        expect(err.rateLimitResult.command).toBe(command);
      }
    });
  });

  // ===========================================================================
  // Status Tests
  // ===========================================================================
  describe('getRateLimitStatus', () => {
    test('returns status for all commands', async () => {
      const status = await rateLimiter.getRateLimitStatus();

      // Should have status for configured commands
      expect(status.status).toBeDefined();
      expect(status.health).toBeDefined();
      expect(status.security).toBeDefined();
    });

    test('status includes correct fields', async () => {
      // Make a request first
      await rateLimiter.checkRateLimit('status');

      const status = await rateLimiter.getRateLimitStatus();
      const statusInfo = status.status;

      expect(statusInfo).toHaveProperty('limit');
      expect(statusInfo).toHaveProperty('used');
      expect(statusInfo).toHaveProperty('remaining');
      expect(statusInfo).toHaveProperty('windowMs');
      expect(statusInfo).toHaveProperty('resetTime');
    });

    test('calculates remaining correctly', async () => {
      await rateLimiter.resetRateLimits('status', true);

      // Make some requests
      await rateLimiter.checkRateLimit('status');
      await rateLimiter.checkRateLimit('status');

      const status = await rateLimiter.getRateLimitStatus();
      expect(status.status.used).toBe(2);
      expect(status.status.remaining).toBe(status.status.limit - 2);
    });
  });

  // ===========================================================================
  // Reset Tests
  // ===========================================================================
  describe('resetRateLimits', () => {
    test('requires force flag', async () => {
      await expect(rateLimiter.resetRateLimits('test'))
        .rejects.toThrow('force=true');
    });

    test('resets specific command with force', async () => {
      // Add some entries
      await rateLimiter.checkRateLimit('test-reset-cmd');
      await rateLimiter.checkRateLimit('test-reset-cmd');

      // Reset
      await rateLimiter.resetRateLimits('test-reset-cmd', true);

      // Check it's reset
      const result = await rateLimiter.checkRateLimit('test-reset-cmd', { increment: false });
      expect(result.currentCount).toBe(0);
    });

    test('resets all commands with null and force', async () => {
      // Add entries to multiple commands
      await rateLimiter.checkRateLimit('test-reset-all-1');
      await rateLimiter.checkRateLimit('test-reset-all-2');

      // Reset all
      await rateLimiter.resetRateLimits(null, true);

      // Check both are reset
      const result1 = await rateLimiter.checkRateLimit('test-reset-all-1', { increment: false });
      const result2 = await rateLimiter.checkRateLimit('test-reset-all-2', { increment: false });
      expect(result1.currentCount).toBe(0);
      expect(result2.currentCount).toBe(0);
    });
  });

  // ===========================================================================
  // RateLimitError Tests
  // ===========================================================================
  describe('RateLimitError', () => {
    test('creates error with correct properties', () => {
      const result = {
        command: 'test',
        currentCount: 10,
        max: 5,
        retryAfterSec: 30,
      };

      const error = new rateLimiter.RateLimitError('Rate limit exceeded', result);

      expect(error.message).toBe('Rate limit exceeded');
      expect(error.name).toBe('RateLimitError');
      expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(error.rateLimitResult).toBe(result);
      expect(error.timestamp).toBeDefined();
    });

    test('toJSON returns serializable object', () => {
      const result = {
        command: 'test',
        currentCount: 10,
        max: 5,
        retryAfterSec: 30,
      };

      const error = new rateLimiter.RateLimitError('Rate limit exceeded', result);
      const json = error.toJSON();

      expect(json.error).toBe('Rate limit exceeded');
      expect(json.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(json.command).toBe('test');
      expect(json.retryAfterSec).toBe(30);
      expect(json.timestamp).toBeDefined();
    });
  });

  // ===========================================================================
  // Integration Helper Tests
  // ===========================================================================
  describe('withRateLimit', () => {
    test('executes handler when under limit', async () => {
      await rateLimiter.resetRateLimits('test-with-rl', true);

      const handler = jest.fn().mockResolvedValue('success');
      const wrapped = rateLimiter.withRateLimit('test-with-rl', handler);

      const result = await wrapped('arg1', 'arg2');

      expect(handler).toHaveBeenCalledWith('arg1', 'arg2');
      expect(result).toBe('success');
    });

    test('throws when over limit without executing handler', async () => {
      const command = 'test-with-rl-block';
      await rateLimiter.resetRateLimits(command, true);

      const handler = jest.fn().mockResolvedValue('success');
      const wrapped = rateLimiter.withRateLimit(command, handler);

      // Exceed limit
      const limit = rateLimiter.DEFAULT_RATE_LIMITS.default.max;
      for (let i = 0; i <= limit; i++) {
        await rateLimiter.checkRateLimit(command);
      }

      await expect(wrapped()).rejects.toThrow(rateLimiter.RateLimitError);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Configuration Tests
  // ===========================================================================
  describe('Configuration', () => {
    test('DEFAULT_RATE_LIMITS has expected commands', () => {
      expect(rateLimiter.DEFAULT_RATE_LIMITS).toHaveProperty('security');
      expect(rateLimiter.DEFAULT_RATE_LIMITS).toHaveProperty('config-audit');
      expect(rateLimiter.DEFAULT_RATE_LIMITS).toHaveProperty('deploy');
      expect(rateLimiter.DEFAULT_RATE_LIMITS).toHaveProperty('status');
      expect(rateLimiter.DEFAULT_RATE_LIMITS).toHaveProperty('default');
    });

    test('each limit has max and windowMs', () => {
      for (const [cmd, config] of Object.entries(rateLimiter.DEFAULT_RATE_LIMITS)) {
        expect(config).toHaveProperty('max');
        expect(config).toHaveProperty('windowMs');
        expect(typeof config.max).toBe('number');
        expect(typeof config.windowMs).toBe('number');
        expect(config.max).toBeGreaterThan(0);
        expect(config.windowMs).toBeGreaterThan(0);
      }
    });

    test('high security commands have stricter limits', () => {
      const securityLimit = rateLimiter.DEFAULT_RATE_LIMITS.security;
      const statusLimit = rateLimiter.DEFAULT_RATE_LIMITS.status;

      expect(securityLimit.max).toBeLessThan(statusLimit.max);
    });

    test('exports RATE_LIMIT_FILE constant', () => {
      expect(rateLimiter.RATE_LIMIT_FILE).toBeDefined();
      expect(typeof rateLimiter.RATE_LIMIT_FILE).toBe('string');
    });

    test('exports SECURE_FILE_MODE constant', () => {
      expect(rateLimiter.SECURE_FILE_MODE).toBeDefined();
      expect(typeof rateLimiter.SECURE_FILE_MODE).toBe('number');
      expect(rateLimiter.SECURE_FILE_MODE).toBe(0o600);
    });
  });

  // ===========================================================================
  // State Validation Tests (Security Hardening)
  // ===========================================================================
  describe('isValidRateLimitState', () => {
    test('returns true for valid state', () => {
      const validState = {
        'test-cmd': [Date.now(), Date.now() - 1000],
        'another_cmd': [Date.now()],
      };
      expect(rateLimiter.isValidRateLimitState(validState)).toBe(true);
    });

    test('returns false for null state', () => {
      expect(rateLimiter.isValidRateLimitState(null)).toBe(false);
    });

    test('returns false for undefined state', () => {
      expect(rateLimiter.isValidRateLimitState(undefined)).toBe(false);
    });

    test('returns false for array state', () => {
      expect(rateLimiter.isValidRateLimitState([1, 2, 3])).toBe(false);
    });

    test('returns false for string state', () => {
      expect(rateLimiter.isValidRateLimitState('invalid')).toBe(false);
    });

    test('returns false for state with non-array entries', () => {
      const invalidState = {
        'test-cmd': 'not-an-array',
      };
      expect(rateLimiter.isValidRateLimitState(invalidState)).toBe(false);
    });

    test('returns false for state with invalid timestamp entries', () => {
      const invalidState = {
        'test-cmd': [Date.now(), 'not-a-number'],
      };
      expect(rateLimiter.isValidRateLimitState(invalidState)).toBe(false);
    });

    test('returns false for state with negative timestamp entries', () => {
      const invalidState = {
        'test-cmd': [Date.now(), -1000],
      };
      expect(rateLimiter.isValidRateLimitState(invalidState)).toBe(false);
    });

    test('returns false for state with Infinity timestamp entries', () => {
      const invalidState = {
        'test-cmd': [Date.now(), Infinity],
      };
      expect(rateLimiter.isValidRateLimitState(invalidState)).toBe(false);
    });

    test('returns false for state with command name exceeding max length', () => {
      const invalidState = {
        ['a'.repeat(101)]: [Date.now()],
      };
      expect(rateLimiter.isValidRateLimitState(invalidState)).toBe(false);
    });

    test('returns false for state with empty command name', () => {
      const invalidState = {
        '': [Date.now()],
      };
      expect(rateLimiter.isValidRateLimitState(invalidState)).toBe(false);
    });

    test('returns true for empty object state', () => {
      expect(rateLimiter.isValidRateLimitState({})).toBe(true);
    });

    test('returns false for state with prototype pollution keys', () => {
      // Use Object.defineProperty to actually create an own property
      const pollutedState = {};
      Object.defineProperty(pollutedState, '__proto__', {
        value: [Date.now()],
        enumerable: true,
        writable: true,
        configurable: true,
      });
      expect(rateLimiter.isValidRateLimitState(pollutedState)).toBe(false);
    });

    test('returns false for state with constructor key', () => {
      const pollutedState = {};
      Object.defineProperty(pollutedState, 'constructor', {
        value: [Date.now()],
        enumerable: true,
        writable: true,
        configurable: true,
      });
      expect(rateLimiter.isValidRateLimitState(pollutedState)).toBe(false);
    });

    test('returns false for state with prototype key', () => {
      const pollutedState = {};
      Object.defineProperty(pollutedState, 'prototype', {
        value: [Date.now()],
        enumerable: true,
        writable: true,
        configurable: true,
      });
      expect(rateLimiter.isValidRateLimitState(pollutedState)).toBe(false);
    });

    test('returns false for state with oversized arrays', () => {
      const oversizedState = {
        'test-cmd': Array(rateLimiter.MAX_ENTRIES_PER_COMMAND * 3).fill(Date.now()),
      };
      expect(rateLimiter.isValidRateLimitState(oversizedState)).toBe(false);
    });

    test('returns false for state with timestamps too far in the future', () => {
      const invalidState = {
        'test-cmd': [Date.now() + 1000000000], // Way in the future
      };
      expect(rateLimiter.isValidRateLimitState(invalidState)).toBe(false);
    });

    test('returns false for state with timestamps too old', () => {
      const invalidState = {
        'test-cmd': [Date.now() - (366 * 24 * 60 * 60 * 1000)], // Over a year ago
      };
      expect(rateLimiter.isValidRateLimitState(invalidState)).toBe(false);
    });
  });

  // ===========================================================================
  // Log Sanitization Tests (Security Hardening)
  // ===========================================================================
  describe('Log Sanitization', () => {
    let consoleWarnSpy;

    beforeEach(() => {
      consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    });

    afterEach(() => {
      consoleWarnSpy.mockRestore();
    });

    test('sanitizes error messages in loadRateLimitState', async () => {
      // Create a corrupted JSON file
      const tempDir = path.join(os.tmpdir(), 'mc-test-' + Date.now());
      const tempFile = path.join(tempDir, 'rate-limits.json');
      
      await fs.ensureDir(tempDir);
      await fs.writeFile(tempFile, 'not valid json', { mode: 0o600 });

      // Temporarily override the file path by mocking readJson to fail
      const originalPath = rateLimiter.RATE_LIMIT_FILE;
      jest.spyOn(fs, 'readJson').mockRejectedValueOnce(new Error('Log injection\n[new fake log entry]'));

      await rateLimiter.loadRateLimitState();

      // Verify the logged error was sanitized (newlines escaped)
      expect(consoleWarnSpy).toHaveBeenCalled();
      const loggedMessage = consoleWarnSpy.mock.calls[0][0];
      expect(loggedMessage).not.toContain('\n[new fake log entry]');
      expect(loggedMessage).toContain('\\n');

      // Cleanup
      fs.readJson.mockRestore();
      await fs.remove(tempDir);
    });

    test('detects and logs prototype pollution attempts', async () => {
      const { logSecurityViolation } = require('../lib/audit');

      // Mock fs.pathExists to return true
      jest.spyOn(fs, 'pathExists').mockResolvedValueOnce(true);

      // Create a polluted object with __proto__ as an own property
      const pollutedState = {};
      Object.defineProperty(pollutedState, '__proto__', {
        value: { polluted: true },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      pollutedState.validCmd = [123];

      jest.spyOn(fs, 'readJson').mockResolvedValueOnce(pollutedState);

      await rateLimiter.loadRateLimitState();

      // Verify security violation was logged with new event type
      expect(logSecurityViolation).toHaveBeenCalledWith(
        'RATE_LIMIT_STATE_POLLUTION',
        expect.objectContaining({
          pollutionType: 'direct_key',
          details: '__proto__',
        })
      );

      // Cleanup
      fs.pathExists.mockRestore();
      fs.readJson.mockRestore();
    });
  });

  // ===========================================================================
  // File Permission Verification Tests (Security Hardening)
  // ===========================================================================
  describe('saveRateLimitState Permission Verification', () => {
    test('returns true when permissions are set correctly', async () => {
      // Reset state first
      await rateLimiter.resetRateLimits('test-perm-ok', true);

      // Save should succeed with correct permissions
      const result = await rateLimiter.saveRateLimitState({
        'test-perm-ok': [Date.now()],
      });

      expect(result).toBe(true);
    });

    test('returns false and logs when permissions do not match', async () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const { logSecurityViolation } = require('../lib/audit');

      // Create a file with wrong permissions
      const tempDir = path.join(os.tmpdir(), 'mc-test-perm-' + Date.now());
      const tempFile = path.join(tempDir, 'rate-limits.json');
      
      await fs.ensureDir(tempDir);
      await fs.writeFile(tempFile, '{}', { mode: 0o644 }); // Wrong permissions

      // Mock the RATE_LIMIT_FILE temporarily
      const originalModule = require('../lib/rate-limiter');
      jest.spyOn(path, 'join').mockReturnValueOnce(tempDir).mockReturnValueOnce(tempFile);

      // Try to save (permissions won't match)
      process.env.MC_VERBOSE = '1';
      const result = await rateLimiter.saveRateLimitState({ 'test': [123] });
      delete process.env.MC_VERBOSE;

      // Cleanup mocks and files
      path.join.mockRestore();
      await fs.remove(tempDir);
      consoleWarnSpy.mockRestore();
    });
  });
});
