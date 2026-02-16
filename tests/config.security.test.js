/**
 * Tests for config.js prototype pollution protection
 * Run with: npm test -- config.security.test.js
 */

const path = require('path');
const fs = require('fs-extra');
const os = require('os');

// Helper to check if key is an own property (not inherited)
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// We need to test the security functions directly since CONFIG_DIR is set at module load time
const {
  DANGEROUS_KEYS,
  isDangerousKey,
  sanitizeKey,
  safeDeepMerge,
  sanitizeConfigObject,
} = require('../lib/config');

// =============================================================================
// Dangerous Key Detection Tests
// =============================================================================

describe('DANGEROUS_KEYS constant', () => {
  test('contains expected dangerous keys', () => {
    expect(DANGEROUS_KEYS.has('__proto__')).toBe(true);
    expect(DANGEROUS_KEYS.has('constructor')).toBe(true);
    expect(DANGEROUS_KEYS.has('prototype')).toBe(true);
  });

  test('contains exactly 3 keys', () => {
    expect(DANGEROUS_KEYS.size).toBe(3);
  });
});

describe('isDangerousKey', () => {
  test('returns true for dangerous keys', () => {
    expect(isDangerousKey('__proto__')).toBe(true);
    expect(isDangerousKey('constructor')).toBe(true);
    expect(isDangerousKey('prototype')).toBe(true);
  });

  test('returns false for safe keys', () => {
    expect(isDangerousKey('gateway')).toBe(false);
    expect(isDangerousKey('url')).toBe(false);
    expect(isDangerousKey('token')).toBe(false);
    expect(isDangerousKey('__proto')).toBe(false); // Missing one underscore
    expect(isDangerousKey('constructor__')).toBe(false);
    expect(isDangerousKey('Prototype')).toBe(false); // Case sensitive
    expect(isDangerousKey('')).toBe(false);
  });
});

describe('sanitizeKey', () => {
  test('returns key for safe keys', () => {
    expect(sanitizeKey('gateway')).toBe('gateway');
    expect(sanitizeKey('url')).toBe('url');
    expect(sanitizeKey('nested.deep.key')).toBe('nested.deep.key');
  });

  test('throws for __proto__', () => {
    expect(() => sanitizeKey('__proto__')).toThrow('prototype pollution');
    expect(() => sanitizeKey('__proto__')).toThrow('__proto__');
  });

  test('throws for constructor', () => {
    expect(() => sanitizeKey('constructor')).toThrow('prototype pollution');
  });

  test('throws for prototype', () => {
    expect(() => sanitizeKey('prototype')).toThrow('prototype pollution');
  });

  test('throws for non-string keys', () => {
    expect(() => sanitizeKey(null)).toThrow('string');
    expect(() => sanitizeKey(undefined)).toThrow('string');
    expect(() => sanitizeKey(123)).toThrow('string');
    expect(() => sanitizeKey({})).toThrow('string');
    expect(() => sanitizeKey([])).toThrow('string');
  });
});

// =============================================================================
// Safe Deep Merge Tests
// =============================================================================

describe('safeDeepMerge', () => {
  test('merges simple objects', () => {
    const target = { a: 1, b: 2 };
    const source = { b: 3, c: 4 };
    const result = safeDeepMerge(target, source);
    
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  test('merges nested objects', () => {
    const target = { gateway: { url: 'http://localhost:3000' } };
    const source = { gateway: { token: 'secret123' } };
    const result = safeDeepMerge(target, source);
    
    expect(result).toEqual({
      gateway: { url: 'http://localhost:3000', token: 'secret123' },
    });
  });

  test('ignores __proto__ key', () => {
    const target = {};
    const source = JSON.parse('{ "__proto__": { "polluted": true } }');
    const result = safeDeepMerge(target, source);
    
    expect(hasOwn(result, '__proto__')).toBe(false);
    expect(result.polluted).toBeUndefined();
    expect(({}).polluted).toBeUndefined(); // Verify prototype was not polluted
  });

  test('ignores constructor key', () => {
    const target = {};
    const source = { constructor: { polluted: true } };
    const result = safeDeepMerge(target, source);
    
    expect(hasOwn(result, 'constructor')).toBe(false);
  });

  test('ignores prototype key', () => {
    const target = {};
    const source = { prototype: { polluted: true } };
    const result = safeDeepMerge(target, source);
    
    expect(result.prototype).toBeUndefined();
  });

  test('handles nested dangerous keys', () => {
    const target = {};
    const source = {
      safe: {
        __proto__: { polluted: true },
        constructor: { alsoPolluted: true },
      },
    };
    const result = safeDeepMerge(target, source);
    
    expect(result.safe).toBeDefined();
    expect(hasOwn(result.safe, '__proto__')).toBe(false);
    expect(hasOwn(result.safe, 'constructor')).toBe(false);
  });

  test('handles null values', () => {
    const target = { a: 1 };
    const source = null;
    const result = safeDeepMerge(target, source);
    
    expect(result).toBeNull();
  });

  test('handles arrays', () => {
    const target = { items: [1, 2] };
    const source = { items: [3, 4] };
    const result = safeDeepMerge(target, source);
    
    expect(result.items).toEqual([3, 4]);
  });

  test('handles empty objects', () => {
    const target = {};
    const source = {};
    const result = safeDeepMerge(target, source);
    
    expect(result).toEqual({});
  });

  test('creates new object when target is null', () => {
    const target = null;
    const source = { key: 'value' };
    const result = safeDeepMerge(target, source);
    
    expect(result).toEqual({ key: 'value' });
  });
});

// =============================================================================
// Sanitize Config Object Tests
// =============================================================================

describe('sanitizeConfigObject', () => {
  test('returns primitive values unchanged', () => {
    expect(sanitizeConfigObject(null)).toBeNull();
    expect(sanitizeConfigObject('string')).toBe('string');
    expect(sanitizeConfigObject(123)).toBe(123);
    expect(sanitizeConfigObject(true)).toBe(true);
  });

  test('returns arrays with sanitized items', () => {
    const input = [
      { safe: 'value' },
      { __proto__: { bad: true }, good: 'value' },
    ];
    const result = sanitizeConfigObject(input);
    
    expect(result[0]).toEqual({ safe: 'value' });
    expect(result[1]).toEqual({ good: 'value' });
    expect(hasOwn(result[1], '__proto__')).toBe(false);
  });

  test('removes dangerous keys from objects', () => {
    const input = {
      safe: 'value',
      __proto__: { polluted: true },
      constructor: { alsoPolluted: true },
      prototype: { againPolluted: true },
      nested: {
        __proto__: { nestedPolluted: true },
        safeNested: 'value',
      },
    };
    const result = sanitizeConfigObject(input);
    
    expect(result.safe).toBe('value');
    expect(hasOwn(result, '__proto__')).toBe(false);
    expect(hasOwn(result, 'constructor')).toBe(false);
    expect(hasOwn(result, 'prototype')).toBe(false);
    expect(result.nested.safeNested).toBe('value');
    expect(hasOwn(result.nested, '__proto__')).toBe(false);
  });

  test('handles deeply nested objects', () => {
    const input = {
      level1: {
        level2: {
          level3: {
            __proto__: { bad: true },
            safe: 'deep',
          },
        },
      },
    };
    const result = sanitizeConfigObject(input);
    
    expect(result.level1.level2.level3.safe).toBe('deep');
    expect(hasOwn(result.level1.level2.level3, '__proto__')).toBe(false);
  });
});

// =============================================================================
// Integration Tests - Prototype Pollution Prevention
// =============================================================================

describe('Config Integration - Prototype Pollution Prevention', () => {
  const testConfigDir = path.join(os.tmpdir(), '.masterclaw-test-' + Date.now());
  let configModule;

  // Mock homedir BEFORE requiring config module
  beforeAll(() => {
    jest.resetModules();
    os.homedir = jest.fn(() => testConfigDir);
    // Require fresh copy with mocked homedir
    configModule = require('../lib/config');
  });

  afterAll(() => {
    // Restore original
    jest.unmock('os');
  });

  beforeEach(async () => {
    await fs.ensureDir(testConfigDir);
    // Reset config file before each test
    await fs.remove(path.join(testConfigDir, '.masterclaw'));
  });

  afterEach(async () => {
    await fs.remove(testConfigDir);
  });

  test('set() rejects __proto__ in key path', async () => {
    await expect(configModule.set('__proto__.polluted', 'value')).rejects.toThrow('prototype pollution');
  });

  test('set() rejects constructor in key path', async () => {
    await expect(configModule.set('constructor.polluted', 'value')).rejects.toThrow('prototype pollution');
  });

  test('set() rejects prototype in key path', async () => {
    await expect(configModule.set('prototype.polluted', 'value')).rejects.toThrow('prototype pollution');
  });

  test('set() allows nested keys with dangerous names in middle of path', async () => {
    // This should work - dangerous key in the middle of path
    await expect(configModule.set('gateway.__proto__.url', 'value')).rejects.toThrow('prototype pollution');
  });

  test('set() works with safe keys', async () => {
    await expect(configModule.set('gateway.url', 'http://localhost:3000')).resolves.toBe(true);
    await expect(configModule.set('gateway.token', 'secret123')).resolves.toBe(true);
  });

  test('loadConfig() sanitizes dangerous keys from file', async () => {
    // Create a config file with dangerous keys
    const configDir = path.join(testConfigDir, '.masterclaw');
    await fs.ensureDir(configDir);
    const maliciousConfig = {
      safe: 'value',
      __proto__: { polluted: true },
      gateway: {
        url: 'http://localhost:3000',
        constructor: { bad: true },
      },
    };
    await fs.writeJson(path.join(configDir, 'config.json'), maliciousConfig);

    const config = await configModule.loadConfig();
    
    // Safe values should be present
    expect(config.safe).toBe('value');
    expect(config.gateway.url).toBe('http://localhost:3000');
    
    // Dangerous keys should be removed
    expect(hasOwn(config, '__proto__')).toBe(false);
    expect(hasOwn(config.gateway, 'constructor')).toBe(false);
    
    // Verify prototype was not actually polluted
    expect(({}).polluted).toBeUndefined();
  });

  test('loadConfig() uses defaults for missing values', async () => {
    const config = await configModule.loadConfig();
    
    expect(config.gateway).toBeDefined();
    expect(config.gateway.url).toBe('http://localhost:3000');
    expect(config.api).toBeDefined();
    expect(config.core).toBeDefined();
    expect(config.defaults).toBeDefined();
  });

  test('prototype pollution attack simulation is blocked', async () => {
    // Simulate an attacker trying to pollute Object.prototype
    const maliciousPayload = JSON.parse('{ "__proto__": { "isAdmin": true } }');
    
    // Save malicious payload
    const configDir = path.join(testConfigDir, '.masterclaw');
    await fs.ensureDir(configDir);
    await fs.writeJson(path.join(configDir, 'config.json'), maliciousPayload);

    // Load config
    await configModule.loadConfig();

    // Verify Object.prototype was NOT polluted
    const testObj = {};
    expect(testObj.isAdmin).toBeUndefined();
    expect(({}).isAdmin).toBeUndefined();
  });

  test('complex nested prototype pollution is blocked', async () => {
    const maliciousPayload = {
      gateway: {
        __proto__: { 
          url: 'http://evil.com',
        },
      },
      constructor: {
        prototype: {
          polluted: true,
        },
      },
    };
    
    const configDir = path.join(testConfigDir, '.masterclaw');
    await fs.ensureDir(configDir);
    await fs.writeJson(path.join(configDir, 'config.json'), maliciousPayload);

    const config = await configModule.loadConfig();

    // Verify the pollution did not take effect
    expect(hasOwn(config.gateway, '__proto__')).toBe(false);
    expect(hasOwn(config, 'constructor')).toBe(false);
    
    // Object prototype should be clean
    expect(({}).polluted).toBeUndefined();
  });
});

// =============================================================================
// Edge Case Tests
// =============================================================================

describe('Edge cases', () => {
  test('handles empty config object', () => {
    const result = sanitizeConfigObject({});
    expect(result).toEqual({});
  });

  test('handles config with only dangerous keys', () => {
    const result = sanitizeConfigObject({
      __proto__: { a: 1 },
      constructor: { b: 2 },
      prototype: { c: 3 },
    });
    expect(result).toEqual({});
  });

  test('preserves valid config values', () => {
    const config = {
      infraDir: '/path/to/infra',
      gateway: {
        url: 'http://localhost:3000',
        token: 'secret-token-123',
      },
      api: {
        url: 'http://localhost:3001',
      },
      defaults: {
        backupRetention: 7,
        autoUpdate: true,
      },
    };
    
    const result = sanitizeConfigObject(config);
    expect(result).toEqual(config);
  });

  test('handles mixed arrays and objects', () => {
    const config = {
      items: [
        { name: 'item1', __proto__: { bad: true } },
        { name: 'item2', constructor: { alsoBad: true } },
      ],
      nested: {
        array: [1, 2, 3],
        prototype: { polluted: true },
      },
    };
    
    const result = sanitizeConfigObject(config);
    expect(result.items[0].name).toBe('item1');
    expect(hasOwn(result.items[0], '__proto__')).toBe(false);
    expect(result.items[1].name).toBe('item2');
    expect(hasOwn(result.items[1], 'constructor')).toBe(false);
    expect(result.nested.array).toEqual([1, 2, 3]);
    expect(hasOwn(result.nested, 'prototype')).toBe(false);
  });
});

// Export for Jest
module.exports = {};
