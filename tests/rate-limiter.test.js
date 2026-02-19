/**
 * Tests for rate-limiter.js module
 * Run with: npm test -- rate-limiter.test.js
 *
 * Tests rate limiting functionality including prototype pollution protection.
 */

const path = require('path');
const fs = require('fs-extra');
const os = require('os');

// Mock dependencies
jest.mock('../lib/audit', () => ({
  logSecurityViolation: jest.fn().mockResolvedValue(true),
}));

jest.mock('../lib/security', () => ({
  sanitizeForLog: jest.fn((str) => str),
  maskSensitiveData: jest.fn((data) => data),
}));

// Import after mocking
const {
  DEFAULT_RATE_LIMITS,
  MAX_ENTRIES_PER_COMMAND,
  CLEANUP_AGE_MS,
  RATE_LIMIT_FILE,
  SECURE_FILE_MODE,
  POLLUTION_KEYS,
  getUserIdentifier,
  isSafeCommandName,
  isValidRateLimitState,
  detectPrototypePollution,
  cleanupOldEntries,
  RateLimitError,
} = require('../lib/rate-limiter');

// Load functions that need state management
const rateLimiter = require('../lib/rate-limiter');

// =============================================================================
// Constants Tests
// =============================================================================

describe('Rate Limiter Module', () => {
  describe('Constants', () => {
    test('DEFAULT_RATE_LIMITS has expected commands', () => {
      expect(DEFAULT_RATE_LIMITS).toHaveProperty('config-audit');
      expect(DEFAULT_RATE_LIMITS).toHaveProperty('exec');
      expect(DEFAULT_RATE_LIMITS).toHaveProperty('deploy');
      expect(DEFAULT_RATE_LIMITS).toHaveProperty('status');
      expect(DEFAULT_RATE_LIMITS).toHaveProperty('default');
    });

    test('DEFAULT_RATE_LIMITS have correct structure', () => {
      for (const [cmd, config] of Object.entries(DEFAULT_RATE_LIMITS)) {
        expect(config).toHaveProperty('max');
        expect(config).toHaveProperty('windowMs');
        expect(typeof config.max).toBe('number');
        expect(typeof config.windowMs).toBe('number');
        expect(config.max).toBeGreaterThan(0);
        expect(config.windowMs).toBeGreaterThan(0);
      }
    });

    test('high-security commands have stricter limits', () => {
      // Restore should be very limited
      expect(DEFAULT_RATE_LIMITS['restore'].max).toBeLessThanOrEqual(5);
      expect(DEFAULT_RATE_LIMITS['restore'].windowMs).toBeGreaterThan(60000);

      // Config commands should be strict
      expect(DEFAULT_RATE_LIMITS['config-fix'].max).toBeLessThanOrEqual(10);
    });

    test('read-only commands have permissive limits', () => {
      // Status should be very permissive
      expect(DEFAULT_RATE_LIMITS['status'].max).toBeGreaterThanOrEqual(30);
    });

    test('MAX_ENTRIES_PER_COMMAND is reasonable', () => {
      expect(MAX_ENTRIES_PER_COMMAND).toBeGreaterThan(0);
      expect(MAX_ENTRIES_PER_COMMAND).toBeLessThanOrEqual(1000);
    });

    test('CLEANUP_AGE_MS is 24 hours', () => {
      expect(CLEANUP_AGE_MS).toBe(24 * 60 * 60 * 1000);
    });

    test('RATE_LIMIT_FILE uses correct path', () => {
      expect(RATE_LIMIT_FILE).toContain('.masterclaw');
      expect(RATE_LIMIT_FILE).toContain('rate-limits.json');
    });

    test('SECURE_FILE_MODE is 0o600', () => {
      expect(SECURE_FILE_MODE).toBe(0o600);
    });

    test('POLLUTION_KEYS includes dangerous keys', () => {
      expect(POLLUTION_KEYS).toContain('__proto__');
      expect(POLLUTION_KEYS).toContain('constructor');
      expect(POLLUTION_KEYS).toContain('prototype');
    });
  });

  // ===========================================================================
  // getUserIdentifier Tests
  // ===========================================================================
  describe('getUserIdentifier', () => {
    test('returns a string identifier', () => {
      const id = getUserIdentifier();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    test('returns consistent identifier for same user', () => {
      const id1 = getUserIdentifier();
      const id2 = getUserIdentifier();
      expect(id1).toBe(id2);
    });

    test('returns hex string', () => {
      const id = getUserIdentifier();
      expect(id).toMatch(/^[a-f0-9]+$/);
    });
  });

  // ===========================================================================
  // isSafeCommandName Tests
  // ===========================================================================
  describe('isSafeCommandName', () => {
    test('accepts valid command names', () => {
      expect(isSafeCommandName('status')).toBe(true);
      expect(isSafeCommandName('config-audit')).toBe(true);
      expect(isSafeCommandName('deploy_app')).toBe(true);
      expect(isSafeCommandName('test123')).toBe(true);
    });

    test('rejects __proto__', () => {
      expect(isSafeCommandName('__proto__')).toBe(false);
    });

    test('rejects constructor', () => {
      expect(isSafeCommandName('constructor')).toBe(false);
    });

    test('rejects prototype', () => {
      expect(isSafeCommandName('prototype')).toBe(false);
    });

    test('rejects command names with pollution substrings', () => {
      expect(isSafeCommandName('__proto__.polluted')).toBe(false);
      expect(isSafeCommandName('test__proto__')).toBe(false);
    });

    test('rejects empty string', () => {
      expect(isSafeCommandName('')).toBe(false);
    });

    test('rejects non-string inputs', () => {
      expect(isSafeCommandName(null)).toBe(false);
      expect(isSafeCommandName(undefined)).toBe(false);
      expect(isSafeCommandName(123)).toBe(false);
      expect(isSafeCommandName({})).toBe(false);
    });

    test('rejects command names that are too long', () => {
      expect(isSafeCommandName('a'.repeat(101))).toBe(false);
    });

    test('rejects command names with special characters', () => {
      expect(isSafeCommandName('test;rm')).toBe(false);
      expect(isSafeCommandName('test|cat')).toBe(false);
      expect(isSafeCommandName('test$(cmd)')).toBe(false);
      expect(isSafeCommandName('../etc/passwd')).toBe(false);
    });
  });

  // ===========================================================================
  // isValidRateLimitState Tests
  // ===========================================================================
  describe('isValidRateLimitState', () => {
    test('accepts empty object', () => {
      expect(isValidRateLimitState({})).toBe(true);
    });

    test('accepts valid state with single command', () => {
      const state = {
        'status': [Date.now(), Date.now() - 1000],
      };
      expect(isValidRateLimitState(state)).toBe(true);
    });

    test('accepts valid state with multiple commands', () => {
      const now = Date.now();
      const state = {
        'status': [now, now - 1000],
        'deploy': [now],
      };
      expect(isValidRateLimitState(state)).toBe(true);
    });

    test('rejects null', () => {
      expect(isValidRateLimitState(null)).toBe(false);
    });

    test('rejects undefined', () => {
      expect(isValidRateLimitState(undefined)).toBe(false);
    });

    test('rejects arrays', () => {
      expect(isValidRateLimitState([])).toBe(false);
    });

    test('rejects state with __proto__ key', () => {
      const state = JSON.parse('{ "__proto__": { "polluted": true }, "status": [] }');
      expect(isValidRateLimitState(state)).toBe(false);
    });

    test('rejects state with constructor key', () => {
      const state = { 'constructor': [], 'status': [] };
      expect(isValidRateLimitState(state)).toBe(false);
    });

    test('rejects state with non-array entries', () => {
      const state = { 'status': 'not-an-array' };
      expect(isValidRateLimitState(state)).toBe(false);
    });

    test('rejects state with invalid timestamps', () => {
      const state = { 'status': ['not-a-number'] };
      expect(isValidRateLimitState(state)).toBe(false);
    });

    test('rejects state with negative timestamps', () => {
      const state = { 'status': [-1] };
      expect(isValidRateLimitState(state)).toBe(false);
    });

    test('rejects state with too many entries (DoS protection)', () => {
      const state = { 'status': Array(300).fill(Date.now()) };
      expect(isValidRateLimitState(state)).toBe(false);
    });
  });

  // ===========================================================================
  // detectPrototypePollution Tests
  // ===========================================================================
  describe('detectPrototypePollution', () => {
    test('returns null for empty object', () => {
      expect(detectPrototypePollution({})).toBeNull();
    });

    test('returns null for valid state', () => {
      expect(detectPrototypePollution({ 'status': [Date.now()] })).toBeNull();
    });

    test('detects __proto__ key', () => {
      const state = JSON.parse('{ "__proto__": [], "status": [] }');
      const result = detectPrototypePollution(state);
      expect(result).not.toBeNull();
      expect(result.type).toBe('direct_key');
    });

    test('detects constructor key', () => {
      const state = { 'constructor': [] };
      const result = detectPrototypePollution(state);
      expect(result).not.toBeNull();
      expect(result.type).toBe('direct_key');
    });

    test('returns null for null input', () => {
      expect(detectPrototypePollution(null)).toBeNull();
    });

    test('returns null for non-object input', () => {
      expect(detectPrototypePollution('string')).toBeNull();
    });
  });

  // ===========================================================================
  // cleanupOldEntries Tests
  // ===========================================================================
  describe('cleanupOldEntries', () => {
    test('returns empty object for empty state', () => {
      expect(cleanupOldEntries({})).toEqual({});
    });

    test('keeps recent entries', () => {
      const now = Date.now();
      const state = { 'status': [now, now - 1000] };
      const cleaned = cleanupOldEntries(state);
      expect(cleaned['status']).toHaveLength(2);
    });

    test('removes old entries', () => {
      const now = Date.now();
      const old = now - (25 * 60 * 60 * 1000); // 25 hours ago
      const state = { 'status': [now, old] };
      const cleaned = cleanupOldEntries(state);
      expect(cleaned['status']).toHaveLength(1);
      expect(cleaned['status'][0]).toBe(now);
    });

    test('limits entries per command', () => {
      const now = Date.now();
      const state = {
        'status': Array(150).fill(now).map((ts, i) => ts - i * 1000),
      };
      const cleaned = cleanupOldEntries(state);
      expect(cleaned['status'].length).toBeLessThanOrEqual(MAX_ENTRIES_PER_COMMAND);
    });

    test('removes empty commands', () => {
      const old = Date.now() - (25 * 60 * 60 * 1000);
      const state = { 'status': [old] };
      const cleaned = cleanupOldEntries(state);
      expect(cleaned['status']).toBeUndefined();
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
      const err = new RateLimitError('Rate limit exceeded', result);

      expect(err.name).toBe('RateLimitError');
      expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(err.message).toBe('Rate limit exceeded');
      expect(err.rateLimitResult).toBe(result);
      expect(err.timestamp).toBeDefined();
    });

    test('toJSON returns serializable object', () => {
      const result = {
        command: 'test',
        currentCount: 10,
        max: 5,
        retryAfterSec: 30,
      };
      const err = new RateLimitError('Rate limit exceeded', result);
      const json = err.toJSON();

      expect(json.error).toBe('Rate limit exceeded');
      expect(json.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(json.command).toBe('test');
      expect(json.retryAfterSec).toBe(30);
    });
  });
});
