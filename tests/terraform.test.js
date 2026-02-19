/**
 * Tests for terraform.js - Terraform Infrastructure Management
 * 
 * Security: Tests validate input sanitization, environment validation,
 * and protection against command injection in Terraform operations.
 * 
 * Run with: npm test -- terraform.test.js
 */

const {
  isValidEnvironment,
  isTerraformInstalled,
  isAwsCliInstalled,
  getTerraformDir,
  parseTerraformOutputs,
  VALID_ENVIRONMENTS,
} = require('../lib/terraform');

const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const { execSync } = require('child_process');

// Mock chalk to avoid ANSI codes in tests
jest.mock('chalk', () => ({
  red: (str) => str,
  yellow: (str) => str,
  green: (str) => str,
  cyan: (str) => str,
  gray: (str) => str,
  bold: (str) => str,
  blue: (str) => str,
}));

// Mock ora (spinner)
jest.mock('ora', () => {
  return jest.fn(() => ({
    start: jest.fn(function() { return this; }),
    succeed: jest.fn(function() { return this; }),
    fail: jest.fn(function() { return this; }),
    stop: jest.fn(function() { return this; }),
  }));
});

// Mock audit module
jest.mock('../lib/audit', () => ({
  logSecurityViolation: jest.fn().mockResolvedValue(true),
  logAudit: jest.fn().mockResolvedValue(true),
}));

// Mock config module
jest.mock('../lib/config', () => ({
  get: jest.fn().mockResolvedValue('/opt/masterclaw-infrastructure'),
}));

// Mock child_process execSync
jest.mock('child_process', () => ({
  execSync: jest.fn(),
  spawn: jest.fn(),
}));

// =============================================================================
// Environment Validation Tests
// =============================================================================

describe('Environment Validation', () => {
  describe('isValidEnvironment', () => {
    test('accepts valid environments', () => {
      expect(isValidEnvironment('dev')).toBe(true);
      expect(isValidEnvironment('staging')).toBe(true);
      expect(isValidEnvironment('prod')).toBe(true);
    });

    test('rejects invalid environments', () => {
      expect(isValidEnvironment('production')).toBe(false);
      expect(isValidEnvironment('development')).toBe(false);
      expect(isValidEnvironment('test')).toBe(false);
      expect(isValidEnvironment('')).toBe(false);
      expect(isValidEnvironment(null)).toBe(false);
      expect(isValidEnvironment(undefined)).toBe(false);
    });

    test('rejects environment with path traversal attempts', () => {
      expect(isValidEnvironment('../prod')).toBe(false);
      expect(isValidEnvironment('dev/../../etc')).toBe(false);
      expect(isValidEnvironment('dev; rm -rf /')).toBe(false);
    });

    test('VALID_ENVIRONMENTS constant contains expected values', () => {
      expect(VALID_ENVIRONMENTS).toContain('dev');
      expect(VALID_ENVIRONMENTS).toContain('staging');
      expect(VALID_ENVIRONMENTS).toContain('prod');
      expect(VALID_ENVIRONMENTS).toHaveLength(3);
    });
  });

  describe('getTerraformDir', () => {
    test('returns correct path structure', async () => {
      const dir = await getTerraformDir('dev');
      expect(dir).toContain('terraform');
      expect(dir).toContain('environments');
      expect(dir).toContain('dev');
      expect(path.isAbsolute(dir)).toBe(true);
    });

    test('returns different paths for different environments', async () => {
      const devDir = await getTerraformDir('dev');
      const prodDir = await getTerraformDir('prod');
      expect(devDir).not.toBe(prodDir);
      expect(devDir).toContain('dev');
      expect(prodDir).toContain('prod');
    });

    test('defaults to dev environment', async () => {
      const defaultDir = await getTerraformDir();
      const devDir = await getTerraformDir('dev');
      expect(defaultDir).toBe(devDir);
    });
  });
});

// =============================================================================
// CLI Detection Tests
// =============================================================================

describe('CLI Detection', () => {
  describe('isTerraformInstalled', () => {
    test('returns true when terraform is available', () => {
      execSync.mockImplementation(() => '');
      expect(isTerraformInstalled()).toBe(true);
      expect(execSync).toHaveBeenCalledWith(
        'terraform -version',
        expect.objectContaining({ stdio: 'ignore' })
      );
    });

    test('returns false when terraform is not available', () => {
      execSync.mockImplementation(() => {
        throw new Error('command not found');
      });
      expect(isTerraformInstalled()).toBe(false);
    });

    test('returns false on execSync error', () => {
      execSync.mockImplementation(() => {
        const error = new Error('spawn error');
        error.code = 'ENOENT';
        throw error;
      });
      expect(isTerraformInstalled()).toBe(false);
    });
  });

  describe('isAwsCliInstalled', () => {
    test('returns true when AWS CLI is available', () => {
      execSync.mockImplementation(() => '');
      expect(isAwsCliInstalled()).toBe(true);
      expect(execSync).toHaveBeenCalledWith(
        'aws --version',
        expect.objectContaining({ stdio: 'ignore' })
      );
    });

    test('returns false when AWS CLI is not available', () => {
      execSync.mockImplementation(() => {
        throw new Error('command not found');
      });
      expect(isAwsCliInstalled()).toBe(false);
    });

    test('returns false on execSync error', () => {
      execSync.mockImplementation(() => {
        const error = new Error('spawn error');
        error.code = 'ENOENT';
        throw error;
      });
      expect(isAwsCliInstalled()).toBe(false);
    });
  });
});

// =============================================================================
// Output Parsing Tests
// =============================================================================

describe('parseTerraformOutputs', () => {
  test('parses simple key-value outputs', () => {
    const output = `cluster_endpoint = https://abc123.eks.amazonaws.com
cluster_name = my-cluster
region = us-east-1`;

    const result = parseTerraformOutputs(output);
    expect(result.cluster_endpoint).toBe('https://abc123.eks.amazonaws.com');
    expect(result.cluster_name).toBe('my-cluster');
    expect(result.region).toBe('us-east-1');
  });

  test('parses quoted values', () => {
    const output = `cluster_endpoint = "https://abc123.eks.amazonaws.com"
cluster_name = "my-cluster"`;

    const result = parseTerraformOutputs(output);
    expect(result.cluster_endpoint).toBe('https://abc123.eks.amazonaws.com');
    expect(result.cluster_name).toBe('my-cluster');
  });

  test('handles empty output', () => {
    const result = parseTerraformOutputs('');
    expect(Object.keys(result)).toHaveLength(0);
  });

  test('handles output with extra whitespace', () => {
    const output = `cluster_endpoint   =   https://abc123.eks.amazonaws.com

cluster_name = my-cluster
  `;

    const result = parseTerraformOutputs(output);
    expect(result.cluster_endpoint).toBe('https://abc123.eks.amazonaws.com');
    expect(result.cluster_name).toBe('my-cluster');
  });

  test('ignores lines that do not match key=value pattern', () => {
    const output = `cluster_endpoint = https://abc123.eks.amazonaws.com
Some warning message
cluster_name = my-cluster`;

    const result = parseTerraformOutputs(output);
    expect(result.cluster_endpoint).toBe('https://abc123.eks.amazonaws.com');
    expect(result.cluster_name).toBe('my-cluster');
    expect(Object.keys(result)).toHaveLength(2);
  });

  test('handles snake_case keys correctly', () => {
    const output = `cluster_endpoint = https://test.com
cluster_ca_certificate = LS0tLS1CRUdJTi
worker_node_role_arn = arn:aws:iam::123456789012:role/worker`;

    const result = parseTerraformOutputs(output);
    expect(result.cluster_endpoint).toBe('https://test.com');
    expect(result.cluster_ca_certificate).toBe('LS0tLS1CRUdJTi');
    expect(result.worker_node_role_arn).toBe('arn:aws:iam::123456789012:role/worker');
  });
});

// =============================================================================
// Security Tests
// =============================================================================

describe('Security', () => {
  describe('Environment name validation', () => {
    test('rejects environment names with special characters', () => {
      const maliciousInputs = [
        'dev; rm -rf /',
        'prod && cat /etc/passwd',
        'dev|whoami',
        'prod`id`',
        '$(echo hacked)',
      ];

      maliciousInputs.forEach(input => {
        expect(isValidEnvironment(input)).toBe(false);
      });
    });

    test('rejects environment names with path traversal', () => {
      const traversalAttempts = [
        '../../../etc/passwd',
        'dev/../../etc',
        'prod/..',
        './prod',
        '~/prod',
      ];

      traversalAttempts.forEach(input => {
        expect(isValidEnvironment(input)).toBe(false);
      });
    });

    test('only accepts exact valid environment names', () => {
      // These look similar but should be rejected
      expect(isValidEnvironment('Dev')).toBe(false); // Wrong case
      expect(isValidEnvironment('DEV')).toBe(false);
      expect(isValidEnvironment(' dev')).toBe(false); // Leading space
      expect(isValidEnvironment('dev ')).toBe(false); // Trailing space
      expect(isValidEnvironment('dev\n')).toBe(false); // Newline
      expect(isValidEnvironment('dev\t')).toBe(false); // Tab
    });
  });

  describe('Output parsing security', () => {
    test('does not execute parsed values', () => {
      const outputWithCode = `cluster_endpoint = $(whoami)
malicious = \`id\``;

      const result = parseTerraformOutputs(outputWithCode);
      expect(result.cluster_endpoint).toBe('$(whoami)');
      expect(result.malicious).toBe('`id`');
    });

    test('handles very long values gracefully', () => {
      const longValue = 'a'.repeat(10000);
      const output = `cluster_endpoint = ${longValue}`;

      const result = parseTerraformOutputs(output);
      expect(result.cluster_endpoint).toBe(longValue);
    });
  });
});

// =============================================================================
// Error Handling Tests  
// =============================================================================

describe('Error Handling', () => {
  test('handles null/undefined inputs gracefully', () => {
    expect(() => isValidEnvironment(null)).not.toThrow();
    expect(() => isValidEnvironment(undefined)).not.toThrow();
    expect(() => parseTerraformOutputs(null)).not.toThrow();
    expect(() => parseTerraformOutputs(undefined)).not.toThrow();
  });

  test('handles empty strings', () => {
    expect(isValidEnvironment('')).toBe(false);
    expect(parseTerraformOutputs('')).toEqual({});
  });

  test('handles non-string environment names', () => {
    expect(isValidEnvironment(123)).toBe(false);
    expect(isValidEnvironment({})).toBe(false);
    expect(isValidEnvironment([])).toBe(false);
    expect(isValidEnvironment(true)).toBe(false);
  });
});

// =============================================================================
// Integration Tests with File System
// =============================================================================

describe('File System Integration', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-terraform-test-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  test('terraform directory path is properly constructed', async () => {
    // We can't easily test getTerraformDir with real paths since it uses
    // the mocked config, but we can verify the structure
    const terraformDir = await getTerraformDir('dev');
    
    // Path should contain expected components
    expect(terraformDir).toMatch(/terraform/);
    expect(terraformDir).toMatch(/environments/);
    expect(terraformDir).toMatch(/dev$/);
  });

  test('path components are properly joined', async () => {
    const terraformDir = await getTerraformDir('prod');
    const normalized = path.normalize(terraformDir);
    
    // Should not have double separators
    expect(normalized).not.toMatch(/\\/); // No backslashes on Unix
    expect(terraformDir).not.toContain('//');
  });
});
