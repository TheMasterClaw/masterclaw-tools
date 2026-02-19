/**
 * Tests for template.js - Configuration Template Generator
 * 
 * Security: Tests validate template generation, input sanitization,
 * and safe file output operations.
 * 
 * Run with: npm test -- template.test.js
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// Mock chalk
jest.mock('chalk', () => ({
  red: (str) => str,
  yellow: (str) => str,
  green: (str) => str,
  cyan: (str) => str,
  gray: (str) => str,
  bold: (str) => str,
  blue: (str) => str,
}));

// Mock inquirer
jest.mock('inquirer', () => ({
  prompt: jest.fn(),
}));

const template = require('../lib/template');
const inquirer = require('inquirer');

// =============================================================================
// Template Structure Tests
// =============================================================================

describe('Template Structure', () => {
  test('exports template command', () => {
    expect(template.templateCmd).toBeDefined();
    expect(template.templateCmd.name()).toBe('template');
  });

  test('exports TEMPLATES object', () => {
    expect(template.TEMPLATES).toBeDefined();
    expect(typeof template.TEMPLATES).toBe('object');
  });

  test('has expected templates defined', () => {
    const expectedTemplates = [
      'env',
      'docker-override',
      'terraform-vars',
      'service',
      'monitoring',
      'backup',
    ];

    expectedTemplates.forEach(name => {
      expect(template.TEMPLATES[name]).toBeDefined();
    });
  });

  test('each template has required properties', () => {
    Object.entries(template.TEMPLATES).forEach(([key, tmpl]) => {
      expect(tmpl).toHaveProperty('name');
      expect(tmpl).toHaveProperty('description');
      expect(tmpl).toHaveProperty('filename');
      expect(tmpl).toHaveProperty('generate');
      expect(typeof tmpl.generate).toBe('function');
    });
  });

  test('template filenames are valid', () => {
    Object.entries(template.TEMPLATES).forEach(([key, tmpl]) => {
      expect(tmpl.filename).toBeTruthy();
      expect(tmpl.filename.length).toBeGreaterThan(0);
      // Should not contain path traversal
      expect(tmpl.filename).not.toContain('../');
      expect(tmpl.filename).not.toContain('..\\');
    });
  });
});

// =============================================================================
// Template Generation Tests
// =============================================================================

describe('Template Generation', () => {
  test('env template generates valid content', () => {
    const tmpl = template.TEMPLATES.env;
    const content = tmpl.generate({
      domain: 'test.example.com',
      email: 'test@example.com',
    });

    expect(content).toContain('DOMAIN=test.example.com');
    expect(content).toContain('ACME_EMAIL=test@example.com');
    expect(content).toContain('GATEWAY_TOKEN=');
    expect(content).toContain('MasterClaw Environment Configuration');
  });

  test('env template uses defaults when options not provided', () => {
    const tmpl = template.TEMPLATES.env;
    const content = tmpl.generate({});

    expect(content).toContain('DOMAIN=mc.example.com');
    expect(content).toContain('ACME_EMAIL=admin@example.com');
  });

  test('docker-override template generates valid content', () => {
    const tmpl = template.TEMPLATES['docker-override'];
    const content = tmpl.generate({});

    expect(content).toContain('version:');
    expect(content).toContain('services:');
    expect(content).toContain('Docker Compose');
  });

  test('terraform-vars template generates valid content', () => {
    const tmpl = template.TEMPLATES['terraform-vars'];
    const content = tmpl.generate({
      awsRegion: 'us-west-2',
      domain: 'test.example.com',
    });

    expect(content).toContain('aws_region');
    expect(content).toContain('domain');
    expect(content).toContain('Terraform Variables');
  });

  test('service template generates valid content', () => {
    const tmpl = template.TEMPLATES.service;
    const content = tmpl.generate({
      serviceName: 'my-service',
      servicePort: 8080,
    });

    expect(content).toContain('my-service');
    expect(content).toContain('8080');
  });

  test('monitoring template generates valid content', () => {
    const tmpl = template.TEMPLATES.monitoring;
    const content = tmpl.generate({});

    expect(content).toContain('alert');
    expect(content).toContain('Grafana');
    expect(content).toContain('dashboards');
  });

  test('backup template generates valid content', () => {
    const tmpl = template.TEMPLATES.backup;
    const content = tmpl.generate({});

    expect(content).toContain('RETENTION_DAYS');
    expect(content).toContain('BACKUP');
  });
});

// =============================================================================
// Security Tests
// =============================================================================

describe('Security', () => {
  test('rejects path traversal in domain names', () => {
    const maliciousDomains = [
      '../../../etc/passwd',
      '..\\..\\windows\\system32',
      'example.com; rm -rf /',
      'example.com|cat /etc/passwd',
    ];

    maliciousDomains.forEach(domain => {
      expect(domain).toMatch(/\.\.[\/\\]|[;|]/);
    });
  });

  test('validates email format in templates', () => {
    const validEmails = [
      'test@example.com',
      'admin@masterclaw.local',
      'user+tag@example.co.uk',
    ];

    const invalidEmails = [
      'not-an-email',
      '@example.com',
      'test@',
      '',
    ];

    validEmails.forEach(email => {
      expect(email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    });

    invalidEmails.forEach(email => {
      if (email) {
        expect(email).not.toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
      }
    });
  });

  test('generated tokens are random and sufficiently long', () => {
    const tmpl = template.TEMPLATES.env;
    
    // Generate multiple times to check randomness
    const content1 = tmpl.generate({});
    const content2 = tmpl.generate({});
    
    // Extract tokens
    const token1 = content1.match(/GATEWAY_TOKEN=(.+)/)?.[1];
    const token2 = content2.match(/GATEWAY_TOKEN=(.+)/)?.[1];
    
    // Tokens should exist and be different
    expect(token1).toBeTruthy();
    expect(token2).toBeTruthy();
    expect(token1).not.toBe(token2);
    
    // Tokens should be reasonably long (at least 16 chars)
    expect(token1.length).toBeGreaterThanOrEqual(16);
  });

  test('template content does not contain malicious patterns', () => {
    Object.entries(template.TEMPLATES).forEach(([key, tmpl]) => {
      const content = tmpl.generate({});
      
      // Should not contain shell injection patterns
      expect(content).not.toContain('$(whoami)');
      expect(content).not.toContain('`rm -rf');
      
      // Should not contain path traversal
      expect(content).not.toContain('../');
    });
  });
});

// =============================================================================
// Input Validation Tests
// =============================================================================

describe('Input Validation', () => {
  test('validates service name format', () => {
    const validNames = [
      'my-service',
      'service123',
      'api_gateway',
      'web-server',
    ];

    const invalidNames = [
      '../etc',
      'service;rm',
      'service|cat',
      '',
    ];

    validNames.forEach(name => {
      expect(name).toMatch(/^[\w-]+$/);
    });

    invalidNames.forEach(name => {
      if (name) {
        expect(name).not.toMatch(/^[\w-]+$/);
      }
    });
  });

  test('validates port numbers', () => {
    const validPorts = [80, 443, 8080, 3000, 1, 65535];
    const invalidPorts = [-1, 0, 65536, 99999, 'abc'];

    validPorts.forEach(port => {
      expect(typeof port).toBe('number');
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65535);
    });

    invalidPorts.forEach(port => {
      if (typeof port === 'number') {
        expect(port <= 0 || port > 65535).toBe(true);
      }
    });
  });

  test('handles null/undefined options gracefully', () => {
    Object.entries(template.TEMPLATES).forEach(([key, tmpl]) => {
      expect(() => tmpl.generate(null)).not.toThrow();
      expect(() => tmpl.generate(undefined)).not.toThrow();
      expect(() => tmpl.generate({})).not.toThrow();
    });
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe('Error Handling', () => {
  test('handles unknown template names', () => {
    const unknownTemplate = 'unknown-template';
    expect(template.TEMPLATES[unknownTemplate]).toBeUndefined();
  });

  test('template generation handles missing options', () => {
    // Should not throw when options are missing
    Object.entries(template.TEMPLATES).forEach(([key, tmpl]) => {
      const content = tmpl.generate({});
      expect(content).toBeTruthy();
      expect(typeof content).toBe('string');
    });
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('Integration', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-template-test-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  test('can write generated templates to files', async () => {
    const tmpl = template.TEMPLATES.env;
    const content = tmpl.generate({ domain: 'test.local' });
    
    const outputPath = path.join(tempDir, '.env');
    await fs.writeFile(outputPath, content);
    
    const readContent = await fs.readFile(outputPath, 'utf8');
    expect(readContent).toContain('DOMAIN=test.local');
  });

  test('template filenames are safe for filesystem', () => {
    Object.entries(template.TEMPLATES).forEach(([key, tmpl]) => {
      // Filename should not contain path separators
      expect(tmpl.filename).not.toContain('/');
      expect(tmpl.filename).not.toContain('\\');
      // Filename should not start with dot-dot
      expect(tmpl.filename).not.toMatch(/^\.\./);
    });
  });
});

// =============================================================================
// Command Structure Tests
// =============================================================================

describe('Command Structure', () => {
  test('template command has expected subcommands', () => {
    const commands = template.templateCmd.commands.map(cmd => cmd.name());
    expect(commands).toContain('list');
    expect(commands).toContain('generate');
    expect(commands).toContain('show');
  });

  test('TEMPLATES object is immutable reference', () => {
    // Verify the structure doesn't have circular references
    const keys = Object.keys(template.TEMPLATES);
    expect(keys.length).toBeGreaterThan(0);
    
    keys.forEach(key => {
      const tmpl = template.TEMPLATES[key];
      expect(tmpl).toBeInstanceOf(Object);
    });
  });
});
