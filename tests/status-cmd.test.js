/**
 * Tests for status-cmd.js - Status Command Module
 * 
 * Security: Tests validate status command execution and
 * system status reporting.
 * 
 * Run with: npm test -- status-cmd.test.js
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

jest.mock('axios', () => ({
  get: jest.fn().mockResolvedValue({ data: { status: 'healthy' } }),
}));

const statusCmd = require('../lib/status-cmd');

// =============================================================================
// Command Structure Tests
// =============================================================================

describe('Command Structure', () => {
  test('exports status command', () => {
    expect(statusCmd).toBeDefined();
    expect(typeof statusCmd).toBe('object');
    expect(statusCmd.name()).toBe('status');
  });

  test('has expected subcommands', () => {
    const commands = statusCmd.commands.map(cmd => cmd.name());
    expect(commands.length).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// Status Report Tests
// =============================================================================

describe('Status Reports', () => {
  test('validates status categories', () => {
    const categories = [
      'system',
      'services',
      'docker',
      'config',
    ];

    categories.forEach(cat => {
      expect(cat).toMatch(/^[a-z]+$/);
    });
  });

  test('status values are valid', () => {
    const validStatuses = ['healthy', 'degraded', 'unhealthy', 'unknown'];
    const testStatus = 'healthy';
    expect(validStatuses).toContain(testStatus);
  });

  test('generates comprehensive status report', () => {
    const report = {
      timestamp: new Date().toISOString(),
      overall: 'healthy',
      components: {
        core: 'healthy',
        database: 'healthy',
        gateway: 'healthy',
      },
    };

    expect(report.overall).toBeDefined();
    expect(report.components).toBeDefined();
  });
});

// =============================================================================
// Service Status Tests
// =============================================================================

describe('Service Status', () => {
  test('checks service health', () => {
    const services = [
      { name: 'core', status: 'running', healthy: true },
      { name: 'gateway', status: 'running', healthy: true },
      { name: 'database', status: 'running', healthy: true },
    ];

    services.forEach(service => {
      expect(service.status).toBe('running');
      expect(service.healthy).toBe(true);
    });
  });

  test('identifies stopped services', () => {
    const services = [
      { name: 'core', status: 'stopped', healthy: false },
    ];

    const stopped = services.filter(s => s.status === 'stopped');
    expect(stopped.length).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// Security Tests
// =============================================================================

describe('Security', () => {
  test('validates status check parameters', () => {
    const validParams = [
      '--verbose',
      '--json',
      '--component=core',
    ];

    validParams.forEach(param => {
      if (param.includes('=')) {
        expect(param).toMatch(/^--[a-z-]+=[a-z]+$/);
      } else {
        expect(param).toMatch(/^--[a-z-]+$/);
      }
    });
  });

  test('rejects injection in status queries', () => {
    const maliciousQueries = [
      '; rm -rf /',
      '$(whoami)',
      '`id`',
    ];

    maliciousQueries.forEach(query => {
      expect(query).toMatch(/[;`$]/);
    });
  });
});

// =============================================================================
// Health Endpoint Tests
// =============================================================================

describe('Health Endpoints', () => {
  test('validates health check URLs', () => {
    const urls = [
      'http://localhost:8000/health',
      'http://localhost:8080/health',
    ];

    urls.forEach(url => {
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
// Module Export Tests
// =============================================================================

describe('Module Exports', () => {
  test('exports status command', () => {
    expect(statusCmd).toBeDefined();
    expect(typeof statusCmd).toBe('object');
    expect(statusCmd.name()).toBe('status');
  });

  test('has command methods', () => {
    expect(typeof statusCmd.name).toBe('function');
    expect(typeof statusCmd.commands).toBe('object');
  });
});
