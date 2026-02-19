/**
 * Tests for config.js module
 * Run with: npm test -- config.test.js
 *
 * Tests configuration management with prototype pollution protection.
 */

const path = require('path');
const os = require('os');

// Mock fs-extra before requiring config
const mockPathExists = jest.fn();
const mockReadJson = jest.fn();
const mockWriteJson = jest.fn();
const mockEnsureDir = jest.fn();
const mockChmod = jest.fn();
const mockStat = jest.fn();

jest.mock('fs-extra', () => ({
  pathExists: mockPathExists,
  readJson: mockReadJson,
  writeJson: mockWriteJson,
  ensureDir: mockEnsureDir,
  chmod: mockChmod,
  stat: mockStat,
}));

const {
  CONFIG_DIR,
  CONFIG_FILE,
  DANGEROUS_KEYS,
  isDangerousKey,
  sanitizeKey,
  safeDeepMerge,
  sanitizeConfigObject,
  checkConfigPermissions,
  loadConfig,
  saveConfig,
  get,
  set,
  list,
  reset,
} = require('../lib/config');

// =============================================================================
// Constants Tests
// =============================================================================

describe('Config Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Constants', () => {
    test('CONFIG_DIR uses correct path', () => {
      expect(CONFIG_DIR).toContain('.masterclaw');
      expect(CONFIG_DIR).toContain(os.homedir());
    });

    test('CONFIG_FILE uses correct path', () => {
      expect(CONFIG_FILE).toContain('.masterclaw');
      expect(CONFIG_FILE).toContain('config.json');
    });

    test('DANGEROUS_KEYS includes prototype pollution keys', () => {
      expect(DANGEROUS_KEYS.has('__proto__')).toBe(true);
      expect(DANGEROUS_KEYS.has('constructor')).toBe(true);
      expect(DANGEROUS_KEYS.has('prototype')).toBe(true);
    });
  });

  // ===========================================================================
  // isDangerousKey Tests
  // ===========================================================================
  describe('isDangerousKey', () => {
    test('returns true for __proto__', () => {
      expect(isDangerousKey('__proto__')).toBe(true);
    });

    test('returns true for constructor', () => {
      expect(isDangerousKey('constructor')).toBe(true);
    });

    test('returns true for prototype', () => {
      expect(isDangerousKey('prototype')).toBe(true);
    });

    test('returns false for safe keys', () => {
      expect(isDangerousKey('infraDir')).toBe(false);
      expect(isDangerousKey('gateway')).toBe(false);
      expect(isDangerousKey('url')).toBe(false);
    });

    test('returns false for similar but safe keys', () => {
      expect(isDangerousKey('__proto')).toBe(false);
      expect(isDangerousKey('proto__')).toBe(false);
      expect(isDangerousKey('construct')).toBe(false);
    });
  });

  // ===========================================================================
  // sanitizeKey Tests
  // ===========================================================================
  describe('sanitizeKey', () => {
    test('returns safe keys unchanged', () => {
      expect(sanitizeKey('infraDir')).toBe('infraDir');
      expect(sanitizeKey('gateway')).toBe('gateway');
    });

    test('throws for __proto__', () => {
      expect(() => sanitizeKey('__proto__')).toThrow('prototype pollution');
    });

    test('throws for constructor', () => {
      expect(() => sanitizeKey('constructor')).toThrow('prototype pollution');
    });

    test('throws for prototype', () => {
      expect(() => sanitizeKey('prototype')).toThrow('prototype pollution');
    });

    test('throws for non-string keys', () => {
      expect(() => sanitizeKey(123)).toThrow('must be a string');
      expect(() => sanitizeKey(null)).toThrow('must be a string');
      expect(() => sanitizeKey({})).toThrow('must be a string');
    });
  });

  // ===========================================================================
  // safeDeepMerge Tests
  // ===========================================================================
  describe('safeDeepMerge', () => {
    test('merges simple objects', () => {
      const target = { a: 1 };
      const source = { b: 2 };
      const result = safeDeepMerge(target, source);
      expect(result).toEqual({ a: 1, b: 2 });
    });

    test('source overrides target properties', () => {
      const target = { a: 1, b: 2 };
      const source = { b: 3 };
      const result = safeDeepMerge(target, source);
      expect(result).toEqual({ a: 1, b: 3 });
    });

    test('deep merges nested objects', () => {
      const target = { gateway: { url: 'http://localhost:3000' } };
      const source = { gateway: { token: 'abc123' } };
      const result = safeDeepMerge(target, source);
      expect(result).toEqual({
        gateway: { url: 'http://localhost:3000', token: 'abc123' }
      });
    });

    test('skips dangerous keys', () => {
      const target = { a: 1 };
      const source = JSON.parse('{ "__proto__": { "polluted": true }, "b": 2 }');
      const result = safeDeepMerge(target, source);
      expect(result).toEqual({ a: 1, b: 2 });
      expect(result.__proto__.polluted).toBeUndefined();
    });

    test('skips constructor key', () => {
      const target = { a: 1 };
      const source = { constructor: { polluted: true }, b: 2 };
      const result = safeDeepMerge(target, source);
      expect(result).toEqual({ a: 1, b: 2 });
    });

    test('handles null source', () => {
      const target = { a: 1 };
      const result = safeDeepMerge(target, null);
      expect(result).toBeNull();
    });

    test('handles null target', () => {
      const source = { a: 1 };
      const result = safeDeepMerge(null, source);
      expect(result).toEqual({ a: 1 });
    });

    test('handles arrays', () => {
      const target = { arr: [1, 2] };
      const source = { arr: [3, 4] };
      const result = safeDeepMerge(target, source);
      expect(result).toEqual({ arr: [3, 4] });
    });
  });

  // ===========================================================================
  // sanitizeConfigObject Tests
  // ===========================================================================
  describe('sanitizeConfigObject', () => {
    test('returns primitives unchanged', () => {
      expect(sanitizeConfigObject('string')).toBe('string');
      expect(sanitizeConfigObject(123)).toBe(123);
      expect(sanitizeConfigObject(null)).toBe(null);
    });

    test('sanitizes simple objects', () => {
      const obj = { a: 1, b: 2 };
      expect(sanitizeConfigObject(obj)).toEqual({ a: 1, b: 2 });
    });

    test('removes dangerous keys from objects', () => {
      const obj = JSON.parse('{ "a": 1, "__proto__": { "polluted": true } }');
      const result = sanitizeConfigObject(obj);
      expect(result).toEqual({ a: 1 });
      expect(result.__proto__).toEqual({}); // Should not have polluted property
    });

    test('sanitizes nested objects', () => {
      const obj = {
        gateway: JSON.parse('{ "url": "http://localhost", "__proto__": {} }'),
        api: { url: 'http://api' }
      };
      const result = sanitizeConfigObject(obj);
      expect(result.gateway).toEqual({ url: 'http://localhost' });
      expect(result.gateway.url).toBe('http://localhost');
    });

    test('sanitizes arrays of objects', () => {
      const arr = [
        { name: 'item1' },
        JSON.parse('{ "name": "item2", "__proto__": {} }')
      ];
      const result = sanitizeConfigObject(arr);
      expect(result[0]).toEqual({ name: 'item1' });
      expect(result[1]).toEqual({ name: 'item2' });
    });
  });

  // ===========================================================================
  // checkConfigPermissions Tests
  // ===========================================================================
  describe('checkConfigPermissions', () => {
    test('returns secure for good permissions', async () => {
      mockPathExists.mockImplementation((p) => {
        return p === CONFIG_DIR || p === CONFIG_FILE;
      });
      mockStat.mockImplementation((p) => {
        if (p === CONFIG_DIR) {
          return Promise.resolve({ mode: 0o700 }); // Secure dir
        }
        return Promise.resolve({ mode: 0o600 }); // Secure file
      });

      const result = await checkConfigPermissions();
      expect(result.secure).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    test('detects insecure file permissions', async () => {
      mockPathExists.mockImplementation((p) => {
        return p === CONFIG_DIR || p === CONFIG_FILE;
      });
      mockStat.mockImplementation((p) => {
        if (p === CONFIG_DIR) {
          return Promise.resolve({ mode: 0o700 }); // Secure dir
        }
        return Promise.resolve({ mode: 0o644 }); // Insecure file
      });

      const result = await checkConfigPermissions();
      expect(result.secure).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    test('detects group writable', async () => {
      mockPathExists.mockImplementation((p) => {
        return p === CONFIG_DIR || p === CONFIG_FILE;
      });
      mockStat.mockImplementation((p) => {
        if (p === CONFIG_DIR) {
          return Promise.resolve({ mode: 0o700 }); // Secure dir
        }
        return Promise.resolve({ mode: 0o660 }); // Group writable file
      });

      const result = await checkConfigPermissions();
      expect(result.secure).toBe(false);
    });
  });

  // ===========================================================================
  // loadConfig Tests
  // ===========================================================================
  describe('loadConfig', () => {
    test('returns default config when file does not exist', async () => {
      mockPathExists.mockResolvedValue(false);

      const config = await loadConfig();
      expect(config).toHaveProperty('infraDir');
      expect(config).toHaveProperty('gateway');
      expect(config).toHaveProperty('api');
      expect(config).toHaveProperty('core');
      expect(config).toHaveProperty('defaults');
    });

    test('loads and merges config from file', async () => {
      mockPathExists.mockResolvedValue(true);
      mockReadJson.mockResolvedValue({
        infraDir: '/custom/path',
        gateway: { token: 'custom-token' }
      });

      const config = await loadConfig();
      expect(config.infraDir).toBe('/custom/path');
      expect(config.gateway.url).toBe('http://localhost:3000'); // Default preserved
      expect(config.gateway.token).toBe('custom-token'); // Custom value
    });

    test('sanitizes loaded config', async () => {
      mockPathExists.mockResolvedValue(true);
      mockReadJson.mockResolvedValue(
        JSON.parse('{ "infraDir": "/test", "__proto__": { "polluted": true } }')
      );

      const config = await loadConfig();
      expect(config.infraDir).toBe('/test');
      expect(config.__proto__.polluted).toBeUndefined();
    });

    test('ensures config directory exists', async () => {
      mockPathExists.mockResolvedValue(false);

      await loadConfig();
      expect(mockEnsureDir).toHaveBeenCalledWith(CONFIG_DIR);
      expect(mockChmod).toHaveBeenCalledWith(CONFIG_DIR, 0o700);
    });
  });

  // ===========================================================================
  // saveConfig Tests
  // ===========================================================================
  describe('saveConfig', () => {
    test('saves config to file', async () => {
      const config = { test: 'value' };

      await saveConfig(config);

      expect(mockWriteJson).toHaveBeenCalledWith(
        CONFIG_FILE,
        config,
        { spaces: 2 }
      );
    });

    test('sets secure file permissions', async () => {
      await saveConfig({ test: 'value' });

      expect(mockChmod).toHaveBeenCalledWith(CONFIG_FILE, 0o600);
    });

    test('ensures config directory exists', async () => {
      await saveConfig({ test: 'value' });

      expect(mockEnsureDir).toHaveBeenCalledWith(CONFIG_DIR);
    });
  });

  // ===========================================================================
  // get Tests
  // ===========================================================================
  describe('get', () => {
    test('gets top-level value', async () => {
      mockPathExists.mockResolvedValue(false);

      const value = await get('infraDir');
      expect(value).toBeNull(); // Default is null
    });

    test('gets nested value with dot notation', async () => {
      mockPathExists.mockResolvedValue(false);

      const value = await get('gateway.url');
      expect(value).toBe('http://localhost:3000');
    });

    test('returns undefined for missing key', async () => {
      mockPathExists.mockResolvedValue(false);

      const value = await get('nonexistent.key');
      expect(value).toBeUndefined();
    });
  });

  // ===========================================================================
  // set Tests
  // ===========================================================================
  describe('set', () => {
    test('sets top-level value', async () => {
      mockPathExists.mockResolvedValue(false);

      await set('infraDir', '/new/path');

      expect(mockWriteJson).toHaveBeenCalled();
      const savedConfig = mockWriteJson.mock.calls[0][1];
      expect(savedConfig.infraDir).toBe('/new/path');
    });

    test('sets nested value with dot notation', async () => {
      mockPathExists.mockResolvedValue(false);

      await set('gateway.token', 'new-token');

      const savedConfig = mockWriteJson.mock.calls[0][1];
      expect(savedConfig.gateway.token).toBe('new-token');
    });

    test('throws for dangerous keys', async () => {
      mockPathExists.mockResolvedValue(false);

      await expect(set('__proto__.polluted', true)).rejects.toThrow('prototype pollution');
    });

    test('creates nested objects as needed', async () => {
      mockPathExists.mockResolvedValue(false);

      await set('new.nested.key', 'value');

      const savedConfig = mockWriteJson.mock.calls[0][1];
      expect(savedConfig.new.nested.key).toBe('value');
    });
  });

  // ===========================================================================
  // list Tests
  // ===========================================================================
  describe('list', () => {
    test('returns full config', async () => {
      mockPathExists.mockResolvedValue(false);

      const config = await list();
      expect(config).toHaveProperty('gateway');
      expect(config).toHaveProperty('api');
      expect(config).toHaveProperty('core');
    });
  });

  // ===========================================================================
  // reset Tests
  // ===========================================================================
  describe('reset', () => {
    test('resets to default config', async () => {
      mockPathExists.mockResolvedValue(false);

      const config = await reset();
      expect(config.gateway.url).toBe('http://localhost:3000');
      expect(config.api.url).toBe('http://localhost:3001');
      expect(mockWriteJson).toHaveBeenCalled();
    });
  });
});
