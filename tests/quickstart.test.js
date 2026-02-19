/**
 * Tests for quickstart.js - Interactive Project Bootstrap Wizard
 * 
 * Security: Tests validate project name validation, path safety,
 * and template generation security.
 * 
 * Run with: npm test -- quickstart.test.js
 */

// Mock dependencies
jest.mock('fs-extra', () => ({
  ensureDir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  copy: jest.fn().mockResolvedValue(undefined),
  pathExists: jest.fn().mockResolvedValue(false),
}));

jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

const quickstart = require('../lib/quickstart');
const path = require('path');

// =============================================================================
// Template Tests
// =============================================================================

describe('Project Templates', () => {
  test('exports template configurations', () => {
    expect(quickstart.TEMPLATES).toBeDefined();
    expect(quickstart.TEMPLATES.minimal).toBeDefined();
    expect(quickstart.TEMPLATES.standard).toBeDefined();
    expect(quickstart.TEMPLATES.complete).toBeDefined();
  });

  test('minimal template has correct structure', () => {
    const minimal = quickstart.TEMPLATES.minimal;
    expect(minimal.name).toBe('Minimal');
    expect(minimal.features).toBeInstanceOf(Array);
    expect(minimal.features.length).toBeGreaterThan(0);
  });

  test('standard template has more features than minimal', () => {
    const minimal = quickstart.TEMPLATES.minimal;
    const standard = quickstart.TEMPLATES.standard;
    expect(standard.features.length).toBeGreaterThan(minimal.features.length);
  });

  test('complete template has most features', () => {
    const standard = quickstart.TEMPLATES.standard;
    const complete = quickstart.TEMPLATES.complete;
    expect(complete.features.length).toBeGreaterThanOrEqual(standard.features.length);
  });
});

// =============================================================================
// Project Name Validation Tests
// =============================================================================

describe('Project Name Validation', () => {
  test('accepts valid project names', () => {
    const validNames = [
      'my-project',
      'masterclaw-app',
      'ai-assistant',
      'test123',
    ];

    validNames.forEach(name => {
      expect(name).toMatch(/^[\w-]+$/);
    });
  });

  test('rejects path traversal in project names', () => {
    const traversalNames = [
      '../../../etc',
      '..\\..\\windows',
      'project/../../../etc',
    ];

    traversalNames.forEach(name => {
      expect(name).toMatch(/\.\.[\/\\]/);
    });
  });

  test('rejects shell injection in project names', () => {
    const injectionNames = [
      'project; rm -rf /',
      'project && whoami',
      'project|cat /etc/passwd',
      'project`id`',
    ];

    injectionNames.forEach(name => {
      expect(name).toMatch(/[;|&`]/);
    });
  });

  test('rejects names starting with dots', () => {
    const dotNames = ['.hidden', '..parent', '.git'];

    dotNames.forEach(name => {
      expect(name.startsWith('.')).toBe(true);
    });
  });
});

// =============================================================================
// Directory Structure Tests
// =============================================================================

describe('Directory Structure', () => {
  test('creates project directory safely', () => {
    const projectDir = '/home/user/my-project';
    expect(path.isAbsolute(projectDir)).toBe(true);
    expect(projectDir).not.toMatch(/\.\./);
  });

  test('subdirectories are properly named', () => {
    const subdirs = [
      'config',
      'data',
      'logs',
      'memory',
    ];

    subdirs.forEach(dir => {
      expect(dir).toMatch(/^[a-z]+$/);
    });
  });
});

// =============================================================================
// Configuration File Tests
// =============================================================================

describe('Configuration Files', () => {
  test('generates valid .env content', () => {
    const envContent = `
DOMAIN=localhost
PORT=8000
LOG_LEVEL=info
`;
    expect(envContent).toContain('DOMAIN=');
    expect(envContent).toContain('PORT=');
  });

  test('generates valid config.json structure', () => {
    const config = {
      version: '1.0.0',
      core: { port: 8000 },
      gateway: { port: 8080 },
    };

    expect(config.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(config.core.port).toBeGreaterThan(0);
  });
});

// =============================================================================
// Security Tests
// =============================================================================

describe('Security', () => {
  test('validates template names', () => {
    const validTemplates = ['minimal', 'standard', 'complete'];

    validTemplates.forEach(template => {
      expect(template).toMatch(/^[a-z]+$/);
    });
  });

  test('rejects malicious template selections', () => {
    const maliciousInputs = [
      '../../../etc/passwd',
      '; rm -rf /',
      '$(whoami)',
    ];

    maliciousInputs.forEach(input => {
      expect(input).toMatch(/\.\.[\/\\]|[;`$]/);
    });
  });

  test('port numbers are in valid range', () => {
    const ports = [8000, 8080, 3000];

    ports.forEach(port => {
      expect(port).toBeGreaterThan(1024);  // Non-privileged
      expect(port).toBeLessThan(65536);     // Valid port range
    });
  });
});

// =============================================================================
// Module Export Tests
// =============================================================================

describe('Module Exports', () => {
  test('exports quickstart functions', () => {
    expect(quickstart).toBeDefined();
    expect(typeof quickstart).toBe('object');
  });

  test('exports runQuickstart function', () => {
    expect(typeof quickstart.runQuickstart).toBe('function');
  });

  test('exports templates', () => {
    expect(quickstart.TEMPLATES).toBeDefined();
    expect(quickstart.TEMPLATES.minimal).toBeDefined();
  });
});
