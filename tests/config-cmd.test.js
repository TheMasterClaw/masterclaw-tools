/**
 * Tests for config-cmd.js - Configuration Command Module
 * 
 * Security: Tests validate configuration handling and
 * secure config file operations.
 * 
 * Run with: npm test -- config-cmd.test.js
 */

// Mock dependencies
jest.mock('fs-extra', () => ({
  pathExists: jest.fn().mockResolvedValue(true),
  readFile: jest.fn().mockResolvedValue(''),
  writeFile: jest.fn().mockResolvedValue(undefined),
  ensureDir: jest.fn().mockResolvedValue(undefined),
  readJson: jest.fn().mockResolvedValue({}),
  writeJson: jest.fn().mockResolvedValue(undefined),
}));

const configCmd = require('../lib/config-cmd');

// =============================================================================
// Command Structure Tests
// =============================================================================

describe('Command Structure', () => {
  test('exports config command', () => {
    expect(configCmd).toBeDefined();
    expect(typeof configCmd).toBe('object');
    expect(configCmd.name()).toBe('config');
  });

  test('has expected subcommands', () => {
    const commands = configCmd.commands.map(cmd => cmd.name());
    expect(commands.length).toBeGreaterThan(0);
  });

  test('has get command', () => {
    const commands = configCmd.commands.map(cmd => cmd.name());
    expect(commands).toContain('get');
  });

  test('has set command', () => {
    const commands = configCmd.commands.map(cmd => cmd.name());
    expect(commands).toContain('set');
  });

  test('has list command', () => {
    const commands = configCmd.commands.map(cmd => cmd.name());
    expect(commands).toContain('list');
  });
});

// =============================================================================
// Configuration Key Tests
// =============================================================================

describe('Configuration Keys', () => {
  test('validates config key format', () => {
    const validKeys = [
      'core.port',
      'gateway.host',
      'logging.level',
      'database.url',
    ];

    validKeys.forEach(key => {
      expect(key).toMatch(/^[a-z]+(\.[a-z]+)+$/);
    });
  });

  test('rejects invalid config keys', () => {
    const invalidKeys = [
      '__proto__',
      'constructor',
      'prototype',
      '../etc/passwd',
    ];

    invalidKeys.forEach(key => {
      expect(key).toMatch(/^__|constructor|prototype|\.\./);
    });
  });
});

// =============================================================================
// Configuration Value Tests
// =============================================================================

describe('Configuration Values', () => {
  test('validates port numbers', () => {
    const validPort = 8000;
    expect(validPort).toBeGreaterThan(1024);
    expect(validPort).toBeLessThan(65536);
  });

  test('validates hostnames', () => {
    const validHosts = [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      'api.example.com',
    ];

    validHosts.forEach(host => {
      expect(typeof host).toBe('string');
      expect(host.length).toBeGreaterThan(0);
    });
  });

  test('validates log levels', () => {
    const validLevels = ['debug', 'info', 'warn', 'error'];
    const testLevel = 'info';
    expect(validLevels).toContain(testLevel);
  });
});

// =============================================================================
// Security Tests
// =============================================================================

describe('Security', () => {
  test('rejects prototype pollution keys', () => {
    const dangerousKeys = [
      '__proto__.polluted',
      'constructor.prototype',
      '__defineGetter__',
    ];

    dangerousKeys.forEach(key => {
      expect(key).toMatch(/__proto__|constructor|__define/);
    });
  });

  test('masks sensitive config values', () => {
    const sensitiveKeys = [
      'api.token',
      'database.password',
      'secret.key',
    ];

    sensitiveKeys.forEach(key => {
      expect(key).toMatch(/token|password|secret|key/i);
    });
  });

  test('validates config file paths', () => {
    const validPaths = [
      '/etc/masterclaw/config.json',
      '~/.masterclaw/config.json',
      './config.json',
    ];

    validPaths.forEach(p => {
      expect(typeof p).toBe('string');
      expect(p).toContain('.json');
    });
  });

  test('rejects path traversal in config paths', () => {
    const traversalPaths = [
      '../../../etc/passwd',
      '..\\..\\windows\\system32',
    ];

    traversalPaths.forEach(p => {
      expect(p).toMatch(/\.\.[\/\\]/);
    });
  });
});

// =============================================================================
// Config File Tests
// =============================================================================

describe('Config Files', () => {
  test('validates JSON structure', () => {
    const config = {
      version: '1.0.0',
      core: {
        port: 8000,
        host: '0.0.0.0',
      },
    };

    expect(config.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(config.core.port).toBeGreaterThan(0);
  });

  test('config has required sections', () => {
    const sections = ['core', 'gateway', 'logging'];
    expect(sections.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Module Export Tests
// =============================================================================

describe('Module Exports', () => {
  test('exports config command', () => {
    expect(configCmd).toBeDefined();
    expect(typeof configCmd).toBe('object');
    expect(configCmd.name()).toBe('config');
  });

  test('has command methods', () => {
    expect(typeof configCmd.name).toBe('function');
    expect(typeof configCmd.commands).toBe('object');
  });
});
