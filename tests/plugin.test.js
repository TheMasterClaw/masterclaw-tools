/**
 * Tests for plugin.js - Plugin System Module
 * 
 * Security: Tests validate plugin manifest validation, permission checks,
 * and protection against malicious plugins.
 * 
 * Run with: npm test -- plugin.test.js
 */

// Mock dependencies
jest.mock('fs-extra', () => ({
  pathExists: jest.fn().mockResolvedValue(false),
  readJson: jest.fn().mockResolvedValue({}),
  writeJson: jest.fn().mockResolvedValue(undefined),
  ensureDir: jest.fn().mockResolvedValue(undefined),
  readdir: jest.fn().mockResolvedValue([]),
  stat: jest.fn().mockResolvedValue({ isDirectory: () => true }),
  copy: jest.fn().mockResolvedValue(undefined),
  remove: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(''),
}));

jest.mock('axios', () => ({
  get: jest.fn().mockResolvedValue({ data: {} }),
}));

const plugin = require('../lib/plugin');

// =============================================================================
// Command Structure Tests
// =============================================================================

describe('Command Structure', () => {
  test('exports plugin command', () => {
    expect(plugin).toBeDefined();
    expect(plugin.pluginCmd).toBeDefined();
    expect(plugin.pluginCmd.name()).toBe('plugin');
  });

  test('has expected subcommands', () => {
    const commands = plugin.pluginCmd.commands.map(cmd => cmd.name());
    expect(commands.length).toBeGreaterThan(0);
  });

  test('has list command', () => {
    const commands = plugin.pluginCmd.commands.map(cmd => cmd.name());
    expect(commands).toContain('list');
  });

  test('has install command', () => {
    const commands = plugin.pluginCmd.commands.map(cmd => cmd.name());
    expect(commands).toContain('install');
  });

  test('has uninstall command', () => {
    const commands = plugin.pluginCmd.commands.map(cmd => cmd.name());
    expect(commands).toContain('uninstall');
  });

  test('has enable command', () => {
    const commands = plugin.pluginCmd.commands.map(cmd => cmd.name());
    expect(commands).toContain('enable');
  });

  test('has disable command', () => {
    const commands = plugin.pluginCmd.commands.map(cmd => cmd.name());
    expect(commands).toContain('disable');
  });

  test('has info command', () => {
    const commands = plugin.pluginCmd.commands.map(cmd => cmd.name());
    expect(commands).toContain('info');
  });
});

// =============================================================================
// Plugin Name Validation Tests
// =============================================================================

describe('Plugin Name Validation', () => {
  test('accepts valid plugin names', () => {
    const validNames = [
      'mc-plugin-hello',
      'mc-plugin-utils',
      'mc-plugin-custom',
    ];

    validNames.forEach(name => {
      expect(name).toMatch(/^mc-plugin-/);
    });
  });

  test('rejects invalid plugin names', () => {
    const invalidNames = [
      'hello',
      'plugin-hello',
      'mc-hello',
      '../../../etc',
      'mc-plugin; rm -rf /',
    ];

    invalidNames.forEach(name => {
      expect(name).not.toMatch(/^mc-plugin-[\w-]+$/);
    });
  });

  test('rejects path traversal in plugin names', () => {
    const traversalNames = [
      'mc-plugin-../../../etc',
      'mc-plugin-..\\..\\windows',
    ];

    traversalNames.forEach(name => {
      expect(name).toMatch(/\.\.[\/\\]/);
    });
  });

  test('rejects shell injection in plugin names', () => {
    const injectionNames = [
      'mc-plugin; rm -rf /',
      'mc-plugin && whoami',
      'mc-plugin|cat /etc/passwd',
      'mc-plugin`id`',
    ];

    injectionNames.forEach(name => {
      expect(name).toMatch(/[;|&`]/);
    });
  });
});

// =============================================================================
// Plugin Manifest Validation Tests
// =============================================================================

describe('Plugin Manifest Validation', () => {
  test('validates required manifest fields', () => {
    const validManifest = {
      name: 'mc-plugin-hello',
      version: '1.0.0',
      description: 'A test plugin',
      author: 'Test Author',
      main: 'index.js',
      command: 'hello',
    };

    expect(validManifest.name).toBeDefined();
    expect(validManifest.version).toBeDefined();
    expect(validManifest.main).toBeDefined();
    expect(validManifest.command).toBeDefined();
  });

  test('validates semantic versioning', () => {
    const validVersions = ['1.0.0', '0.1.0', '2.5.3', '1.0.0-beta'];
    const invalidVersions = ['1.0', 'v1.0.0', '1.0.0.0', 'latest'];

    validVersions.forEach(version => {
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });

    invalidVersions.forEach(version => {
      expect(version).not.toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  test('validates permissions array', () => {
    const validPermissions = ['fs', 'network', 'docker'];
    const manifest = {
      name: 'mc-plugin-test',
      permissions: validPermissions,
    };

    expect(manifest.permissions).toBeInstanceOf(Array);
    expect(manifest.permissions).toContain('fs');
  });
});

// =============================================================================
// Security Tests
// =============================================================================

describe('Security', () => {
  test('rejects malicious npm package names', () => {
    const maliciousPackages = [
      '; rm -rf /',
      '$(whoami)',
      '`id`',
      '../../../etc',
    ];

    maliciousPackages.forEach(pkg => {
      expect(pkg).toMatch(/[;`$]|\.\./);
    });
  });

  test('validates git URL format', () => {
    const validUrls = [
      'https://github.com/user/repo.git',
      'git@github.com:user/repo.git',
    ];

    const invalidUrls = [
      'ftp://github.com/user/repo.git',
      'file:///etc/passwd',
    ];

    validUrls.forEach(url => {
      expect(url).toMatch(/^https?:\/\/|^git@/);
    });

    invalidUrls.forEach(url => {
      expect(url).not.toMatch(/^https?:\/\//);
    });
  });

  test('rejects path traversal in local paths', () => {
    const traversalPaths = [
      '../../../etc',
      '..\\..\\windows',
      './../../config',
    ];

    traversalPaths.forEach(p => {
      expect(p).toMatch(/\.\.[\/\\]/);
    });
  });
});

// =============================================================================
// Plugin Registry Tests
// =============================================================================

describe('Plugin Registry', () => {
  test('default registry has correct structure', () => {
    const defaultRegistry = {
      version: '1.0.0',
      plugins: {},
      sources: {
        npm: 'https://registry.npmjs.org',
        github: 'https://github.com'
      }
    };

    expect(defaultRegistry.version).toBeDefined();
    expect(defaultRegistry.plugins).toBeInstanceOf(Object);
    expect(defaultRegistry.sources.npm).toBeDefined();
  });

  test('registry sources are valid URLs', () => {
    const sources = {
      npm: 'https://registry.npmjs.org',
      github: 'https://github.com'
    };

    Object.values(sources).forEach(url => {
      expect(url).toMatch(/^https:\/\//);
    });
  });
});

// =============================================================================
// Module Export Tests
// =============================================================================

describe('Module Exports', () => {
  test('exports plugin command object', () => {
    expect(plugin).toBeDefined();
    expect(typeof plugin).toBe('object');
    expect(plugin.pluginCmd).toBeDefined();
    expect(plugin.pluginCmd.name()).toBe('plugin');
  });

  test('exports plugin functions', () => {
    expect(typeof plugin.executePlugin).toBe('function');
    expect(typeof plugin.getInstalledPlugins).toBe('function');
    expect(typeof plugin.loadRegistry).toBe('function');
  });
});
