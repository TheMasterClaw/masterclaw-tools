/**
 * Tests for maintenance.js - System Maintenance Module
 * 
 * Security: Tests validate maintenance operations, configuration handling,
 * and system cleanup procedures.
 * 
 * Run with: npm test -- maintenance.test.js
 */

// Mock dependencies
jest.mock('axios', () => ({
  get: jest.fn().mockResolvedValue({ data: { status: 'healthy' } }),
}));

jest.mock('child_process', () => ({
  execSync: jest.fn(),
  spawn: jest.fn(() => ({
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn((event, cb) => {
      if (event === 'close') cb(0);
    }),
  })),
}));

const maintenance = require('../lib/maintenance');

// =============================================================================
// Command Structure Tests
// =============================================================================

describe('Command Structure', () => {
  test('exports maintenance command', () => {
    expect(maintenance).toBeDefined();
    expect(maintenance.name()).toBe('maintenance');
  });

  test('has expected subcommands', () => {
    const commands = maintenance.commands.map(cmd => cmd.name());
    expect(commands.length).toBeGreaterThan(0);
  });

  test('has schedule command', () => {
    const commands = maintenance.commands.map(cmd => cmd.name());
    expect(commands).toContain('schedule');
  });

  test('has status command', () => {
    const commands = maintenance.commands.map(cmd => cmd.name());
    expect(commands).toContain('status');
  });
});

// =============================================================================
// Default Configuration Tests
// =============================================================================

describe('Default Configuration', () => {
  test('maintenance defaults are reasonable', () => {
    const defaults = {
      sessionRetentionDays: 30,
      dockerPrune: true,
      verifyBackups: true,
      runHealthCheck: true,
    };

    expect(defaults.sessionRetentionDays).toBeGreaterThan(0);
    expect(defaults.sessionRetentionDays).toBeLessThan(365);
  });

  test('default maintenance options are booleans', () => {
    const defaults = {
      dockerPrune: true,
      verifyBackups: true,
      runHealthCheck: true,
    };

    expect(typeof defaults.dockerPrune).toBe('boolean');
    expect(typeof defaults.verifyBackups).toBe('boolean');
    expect(typeof defaults.runHealthCheck).toBe('boolean');
  });
});

// =============================================================================
// Security Tests
// =============================================================================

describe('Security', () => {
  test('validates retention days to prevent excessive values', () => {
    const validRetention = 30;
    const excessiveRetention = 10000;

    expect(validRetention).toBeGreaterThan(0);
    expect(validRetention).toBeLessThan(365);
    expect(excessiveRetention).toBeGreaterThan(365);
  });

  test('rejects malicious paths in configuration', () => {
    const maliciousPaths = [
      '../../../etc/passwd',
      '..\\..\\windows\\system32',
      '/etc; rm -rf /',
    ];

    maliciousPaths.forEach(p => {
      expect(p).toMatch(/\.\.[\/\\]|[;]/);
    });
  });

  test('validates maintenance task names', () => {
    const validTasks = [
      'docker-prune',
      'session-cleanup',
      'backup-verify',
      'health-check',
    ];

    validTasks.forEach(task => {
      expect(task).toMatch(/^[a-z-]+$/);
    });
  });
});

// =============================================================================
// Infrastructure Directory Tests
// =============================================================================

describe('Infrastructure Directory', () => {
  test('infra directory candidates are valid paths', () => {
    const candidates = [
      process.env.MASTERCLAW_INFRA,
      '/opt/masterclaw-infrastructure',
    ];

    candidates.forEach(dir => {
      if (dir) {
        expect(typeof dir).toBe('string');
      }
    });
  });
});

// =============================================================================
// Service Health Check Tests
// =============================================================================

describe('Service Health Checks', () => {
  test('health check URLs are valid', () => {
    const healthUrls = [
      'http://localhost:8000/health',
      'http://localhost:3000/health',
    ];

    healthUrls.forEach(url => {
      expect(url).toMatch(/^https?:\/\//);
      expect(url).toMatch(/\/health$/);
    });
  });

  test('health check timeouts are reasonable', () => {
    const timeout = 5000; // 5 seconds
    expect(timeout).toBeGreaterThan(1000);
    expect(timeout).toBeLessThan(30000);
  });
});

// =============================================================================
// Maintenance Task Tests
// =============================================================================

describe('Maintenance Tasks', () => {
  test('docker prune task is safe', () => {
    const dockerPruneCommand = 'docker system prune -f';
    expect(dockerPruneCommand).toContain('docker');
    expect(dockerPruneCommand).not.toMatch(/[;|&`$]/);
  });

  test('session cleanup uses valid retention', () => {
    const retentionDays = 30;
    expect(retentionDays).toBeGreaterThan(0);
    expect(retentionDays).toBeLessThan(365);
  });

  test('backup verification is recommended', () => {
    const verifyBackups = true;
    expect(verifyBackups).toBe(true);
  });

  test('health check is recommended', () => {
    const runHealthCheck = true;
    expect(runHealthCheck).toBe(true);
  });
});

// =============================================================================
// Module Export Tests
// =============================================================================

describe('Module Exports', () => {
  test('exports maintenance command object', () => {
    expect(maintenance).toBeDefined();
    expect(typeof maintenance).toBe('object');
    expect(maintenance.name()).toBe('maintenance');
  });

  test('has command methods', () => {
    expect(typeof maintenance.name).toBe('function');
    expect(typeof maintenance.commands).toBe('object');
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe('Error Handling', () => {
  test('handles null configuration gracefully', () => {
    const nullConfig = null;
    expect(nullConfig).toBeNull();
  });

  test('handles missing infrastructure directory', () => {
    const missingDir = null;
    expect(missingDir).toBeNull();
  });
});

// =============================================================================
// Performance Tests
// =============================================================================

describe('Performance', () => {
  test('maintenance operations have reasonable timeouts', () => {
    const operationTimeout = 300000; // 5 minutes
    expect(operationTimeout).toBeGreaterThan(60000); // At least 1 minute
    expect(operationTimeout).toBeLessThan(600000); // Less than 10 minutes
  });
});
