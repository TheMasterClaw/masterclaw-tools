/**
 * Tests for alias.js module
 * Run with: npm test -- alias.test.js
 *
 * Tests alias management, validation, import/export, and formatting.
 */

const path = require('path');
const fs = require('fs-extra');
const os = require('os');

// Mock dependencies before requiring alias module
jest.mock('../lib/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../lib/rate-limiter', () => ({
  checkLimit: jest.fn().mockResolvedValue(true),
}));

// Mock error-handler's ExitCode
jest.mock('../lib/error-handler', () => ({
  wrapCommand: jest.fn((fn) => fn),
  ExitCode: {
    SUCCESS: 0,
    CONFIG_ERROR: 7,
    INVALID_ARGUMENTS: 2,
  },
}));

// Setup test directory
const testDir = path.join(os.tmpdir(), 'masterclaw-test-alias-' + Date.now());
process.env.REX_DEUS_DIR = testDir;

const {
  loadAliases,
  ensureAliasesFile,
  saveAliases,
  DEFAULT_ALIASES,
  ALIASES_FILE,
} = require('../lib/alias');

// =============================================================================
// Setup and Teardown
// =============================================================================

describe('Alias Module', () => {
  beforeEach(async () => {
    // Clean up test directory
    await fs.remove(testDir);
  });

  afterEach(async () => {
    await fs.remove(testDir);
  });

  afterAll(async () => {
    await fs.remove(testDir);
    delete process.env.REX_DEUS_DIR;
  });

  // ===========================================================================
  // DEFAULT_ALIASES Constant Tests
  // ===========================================================================
  describe('DEFAULT_ALIASES', () => {
    test('has aliases object', () => {
      expect(DEFAULT_ALIASES).toHaveProperty('aliases');
      expect(typeof DEFAULT_ALIASES.aliases).toBe('object');
    });

    test('has shortcuts object', () => {
      expect(DEFAULT_ALIASES).toHaveProperty('shortcuts');
      expect(typeof DEFAULT_ALIASES.shortcuts).toBe('object');
    });

    test('has common command aliases', () => {
      expect(DEFAULT_ALIASES.aliases).toHaveProperty('s');
      expect(DEFAULT_ALIASES.aliases).toHaveProperty('l');
      expect(DEFAULT_ALIASES.aliases).toHaveProperty('b');
      expect(DEFAULT_ALIASES.aliases).toHaveProperty('r');
    });

    test('alias values are valid mc commands', () => {
      for (const [name, command] of Object.entries(DEFAULT_ALIASES.aliases)) {
        expect(typeof command).toBe('string');
        expect(command.length).toBeGreaterThan(0);
      }
    });

    test('shortcut values are valid shell commands', () => {
      for (const [name, command] of Object.entries(DEFAULT_ALIASES.shortcuts)) {
        expect(typeof command).toBe('string');
        expect(command.length).toBeGreaterThan(0);
      }
    });
  });

  // ===========================================================================
  // ensureAliasesFile Tests
  // ===========================================================================
  describe('ensureAliasesFile', () => {
    test('creates config directory if not exists', async () => {
      await ensureAliasesFile();
      const configDir = path.dirname(ALIASES_FILE);
      expect(await fs.pathExists(configDir)).toBe(true);
    });

    test('creates default aliases file', async () => {
      await ensureAliasesFile();
      expect(await fs.pathExists(ALIASES_FILE)).toBe(true);
    });

    test('creates file with default structure', async () => {
      await ensureAliasesFile();
      const data = await fs.readJson(ALIASES_FILE);
      expect(data).toHaveProperty('aliases');
      expect(data).toHaveProperty('shortcuts');
    });

    test('does not overwrite existing file', async () => {
      await ensureAliasesFile();
      const customData = { aliases: { test: 'test-cmd' }, shortcuts: {} };
      await fs.writeJson(ALIASES_FILE, customData);

      await ensureAliasesFile();
      const data = await fs.readJson(ALIASES_FILE);
      expect(data.aliases.test).toBe('test-cmd');
    });
  });

  // ===========================================================================
  // loadAliases Tests
  // ===========================================================================
  describe('loadAliases', () => {
    test('returns default aliases when file does not exist', async () => {
      const data = await loadAliases();
      expect(data).toHaveProperty('aliases');
      expect(data).toHaveProperty('shortcuts');
    });

    test('returns saved aliases', async () => {
      await ensureAliasesFile();
      const customData = {
        aliases: { custom: 'custom-cmd' },
        shortcuts: { custom2: 'echo test' },
      };
      await fs.writeJson(ALIASES_FILE, customData);

      const data = await loadAliases();
      expect(data.aliases.custom).toBe('custom-cmd');
      expect(data.shortcuts.custom2).toBe('echo test');
    });

    test('returns defaults on corrupted file', async () => {
      await ensureAliasesFile();
      await fs.writeFile(ALIASES_FILE, 'invalid json');

      const data = await loadAliases();
      // Should return DEFAULT_ALIASES on error
      expect(data).toHaveProperty('aliases');
      expect(data).toHaveProperty('shortcuts');
    });
  });

  // ===========================================================================
  // saveAliases Tests
  // ===========================================================================
  describe('saveAliases', () => {
    test('saves aliases to file', async () => {
      const data = {
        aliases: { test: 'test-cmd' },
        shortcuts: { test2: 'echo hello' },
      };
      await saveAliases(data);

      const saved = await fs.readJson(ALIASES_FILE);
      expect(saved.aliases.test).toBe('test-cmd');
      expect(saved.shortcuts.test2).toBe('echo hello');
    });

    test('overwrites existing file', async () => {
      await ensureAliasesFile();

      const newData = {
        aliases: { new: 'new-cmd' },
        shortcuts: {},
      };
      await saveAliases(newData);

      const saved = await fs.readJson(ALIASES_FILE);
      expect(saved.aliases).toEqual({ new: 'new-cmd' });
      expect(saved.shortcuts).toEqual({});
    });

    test('saves with proper formatting', async () => {
      const data = { aliases: { a: 'b' }, shortcuts: {} };
      await saveAliases(data);

      const content = await fs.readFile(ALIASES_FILE, 'utf8');
      // Should be pretty-printed JSON
      expect(content).toContain('\n');
      expect(content).toContain('  ');
    });
  });

  // ===========================================================================
  // ALIASES_FILE Path Tests
  // ===========================================================================
  describe('ALIASES_FILE', () => {
    test('uses correct file path', () => {
      expect(ALIASES_FILE).toContain('aliases.json');
      expect(ALIASES_FILE).toContain('config');
    });

    test('uses REX_DEUS_DIR environment variable', () => {
      expect(ALIASES_FILE.startsWith(testDir)).toBe(true);
    });
  });

  // ===========================================================================
  // Alias Validation Tests (implicit through structure)
  // ===========================================================================
  describe('Alias Structure Validation', () => {
    test('alias names are alphanumeric with hyphens/underscores', () => {
      for (const name of Object.keys(DEFAULT_ALIASES.aliases)) {
        expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
      }
    });

    test('shortcut names are alphanumeric with hyphens/underscores', () => {
      for (const name of Object.keys(DEFAULT_ALIASES.shortcuts)) {
        expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
      }
    });

    test('alias names are 20 characters or less', () => {
      for (const name of Object.keys(DEFAULT_ALIASES.aliases)) {
        expect(name.length).toBeLessThanOrEqual(20);
      }
    });

    test('no duplicate names between aliases and shortcuts', () => {
      const aliasNames = Object.keys(DEFAULT_ALIASES.aliases);
      const shortcutNames = Object.keys(DEFAULT_ALIASES.shortcuts);
      const duplicates = aliasNames.filter(name => shortcutNames.includes(name));
      expect(duplicates).toEqual([]);
    });
  });

  // ===========================================================================
  // Integration Tests
  // ===========================================================================
  describe('Integration', () => {
    test('full alias lifecycle', async () => {
      // Load defaults
      let data = await loadAliases();
      expect(data.aliases).toBeDefined();

      // Add custom alias
      data.aliases['mytest'] = 'test-command';
      await saveAliases(data);

      // Reload and verify
      data = await loadAliases();
      expect(data.aliases['mytest']).toBe('test-command');

      // Remove alias
      delete data.aliases['mytest'];
      await saveAliases(data);

      // Verify removal
      data = await loadAliases();
      expect(data.aliases['mytest']).toBeUndefined();
    });

    test('persists across multiple loads', async () => {
      const customData = {
        aliases: { persist: 'persist-cmd' },
        shortcuts: { persist2: 'echo persist' },
      };
      await saveAliases(customData);

      // Load multiple times
      const data1 = await loadAliases();
      const data2 = await loadAliases();
      const data3 = await loadAliases();

      expect(data1.aliases.persist).toBe('persist-cmd');
      expect(data2.aliases.persist).toBe('persist-cmd');
      expect(data3.aliases.persist).toBe('persist-cmd');
    });
  });

  // ===========================================================================
  // Edge Case Tests
  // ===========================================================================
  describe('Edge Cases', () => {
    test('handles empty aliases object', async () => {
      await saveAliases({ aliases: {}, shortcuts: {} });
      const data = await loadAliases();
      expect(data.aliases).toEqual({});
      expect(data.shortcuts).toEqual({});
    });

    test('handles special characters in commands', async () => {
      const data = {
        aliases: { special: 'cmd --arg="value with spaces"' },
        shortcuts: { special2: 'echo "hello world" && ls -la' },
      };
      await saveAliases(data);

      const loaded = await loadAliases();
      expect(loaded.aliases.special).toBe('cmd --arg="value with spaces"');
      expect(loaded.shortcuts.special2).toBe('echo "hello world" && ls -la');
    });

    test('handles long commands', async () => {
      const longCommand = 'mc ' + 'a'.repeat(500);
      await saveAliases({ aliases: { long: longCommand }, shortcuts: {} });

      const loaded = await loadAliases();
      expect(loaded.aliases.long).toBe(longCommand);
    });

    test('handles many aliases', async () => {
      const aliases = {};
      for (let i = 0; i < 100; i++) {
        aliases[`alias${i}`] = `command${i}`;
      }
      await saveAliases({ aliases, shortcuts: {} });

      const loaded = await loadAliases();
      expect(Object.keys(loaded.aliases).length).toBe(100);
    });
  });
});
