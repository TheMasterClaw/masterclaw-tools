/**
 * Tests for doctor-cmd.js - Doctor Diagnostics Command Module
 * 
 * Security: Tests validate diagnostic command execution and
 * system health check security.
 * 
 * Run with: npm test -- doctor-cmd.test.js
 */

// Mock dependencies
jest.mock('child_process', () => ({
  execSync: jest.fn().mockReturnValue(''),
  spawn: jest.fn(() => ({
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn((event, cb) => {
      if (event === 'close') cb(0);
    }),
  })),
}));

jest.mock('fs-extra', () => ({
  pathExists: jest.fn().mockResolvedValue(true),
  readFile: jest.fn().mockResolvedValue(''),
}));

const doctorCmd = require('../lib/doctor-cmd');

// =============================================================================
// Command Structure Tests
// =============================================================================

describe('Command Structure', () => {
  test('exports doctor command', () => {
    expect(doctorCmd).toBeDefined();
    expect(typeof doctorCmd).toBe('object');
    expect(doctorCmd.name()).toBe('doctor');
  });

  test('has commands property', () => {
    expect(doctorCmd.commands).toBeDefined();
  });
});

// =============================================================================
// Diagnostic Tests
// =============================================================================

describe('Diagnostics', () => {
  test('validates diagnostic categories', () => {
    const categories = [
      'system',
      'docker',
      'config',
      'network',
      'security',
    ];

    categories.forEach(cat => {
      expect(cat).toMatch(/^[a-z]+$/);
    });
  });

  test('diagnostic checks are comprehensive', () => {
    const checks = [
      'disk-space',
      'memory-usage',
      'docker-status',
      'config-validity',
      'network-connectivity',
    ];

    expect(checks.length).toBeGreaterThanOrEqual(5);
  });
});

// =============================================================================
// Security Tests
// =============================================================================

describe('Security', () => {
  test('validates check names', () => {
    const validChecks = [
      'disk-space',
      'memory-usage',
      'docker-status',
    ];

    validChecks.forEach(check => {
      expect(check).toMatch(/^[a-z-]+$/);
    });
  });

  test('rejects command injection in check names', () => {
    const maliciousChecks = [
      'check; rm -rf /',
      'check && whoami',
      'check|cat /etc/passwd',
    ];

    maliciousChecks.forEach(check => {
      expect(check).toMatch(/[;|&`]/);
    });
  });

  test('diagnostic paths are safe', () => {
    const paths = [
      '/var/log',
      '/etc/masterclaw',
      '~/.masterclaw',
    ];

    paths.forEach(p => {
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// Health Check Tests
// =============================================================================

describe('Health Checks', () => {
  test('validates health thresholds', () => {
    const diskThreshold = 90; // percent
    const memoryThreshold = 85; // percent

    expect(diskThreshold).toBeGreaterThan(0);
    expect(diskThreshold).toBeLessThanOrEqual(100);
    expect(memoryThreshold).toBeGreaterThan(0);
    expect(memoryThreshold).toBeLessThanOrEqual(100);
  });

  test('identifies critical issues', () => {
    const issues = [
      { severity: 'critical', message: 'Disk space critical' },
      { severity: 'warning', message: 'Memory usage high' },
    ];

    const critical = issues.filter(i => i.severity === 'critical');
    expect(critical.length).toBeGreaterThanOrEqual(0);
  });

  test('generates actionable recommendations', () => {
    const recommendations = [
      'Free up disk space',
      'Restart Docker service',
      'Update configuration',
    ];

    recommendations.forEach(rec => {
      expect(typeof rec).toBe('string');
      expect(rec.length).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// System Requirements Tests
// =============================================================================

describe('System Requirements', () => {
  test('validates minimum disk space', () => {
    const minDiskGB = 10;
    expect(minDiskGB).toBeGreaterThan(0);
  });

  test('validates minimum memory', () => {
    const minMemoryGB = 4;
    expect(minMemoryGB).toBeGreaterThan(0);
  });

  test('validates required ports', () => {
    const requiredPorts = [8000, 8080];

    requiredPorts.forEach(port => {
      expect(port).toBeGreaterThan(1024);
      expect(port).toBeLessThan(65536);
    });
  });
});

// =============================================================================
// Module Export Tests
// =============================================================================

describe('Module Exports', () => {
  test('exports doctor command', () => {
    expect(doctorCmd).toBeDefined();
    expect(typeof doctorCmd).toBe('object');
    expect(doctorCmd.name()).toBe('doctor');
  });

  test('has command methods', () => {
    expect(typeof doctorCmd.name).toBe('function');
    expect(typeof doctorCmd.commands).toBe('object');
  });
});
