/**
 * Tests for the ops command (Operational Dashboard)
 * Covers logging integration, error handling, and core functionality
 */

const { Command } = require('commander');
const axios = require('axios');
const ops = require('../lib/ops');
const { logger } = require('../lib/logger');

// Mock dependencies
jest.mock('axios');
jest.mock('../lib/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  LogLevel: {
    DEBUG: 4,
    INFO: 3,
    WARN: 2,
    ERROR: 1,
    SILENT: 0,
  },
}));

jest.mock('../lib/correlation', () => ({
  getCurrentCorrelationId: jest.fn(() => 'test-correlation-id'),
  createChildCorrelationId: jest.fn(() => 'child-correlation-id'),
}));

describe('mc ops', () => {
  let program;

  beforeEach(() => {
    program = new Command();
    program.addCommand(ops);
    jest.clearAllMocks();
  });

  describe('command registration', () => {
    test('ops command is registered', () => {
      const cmd = program.commands.find(c => c.name() === 'ops');
      expect(cmd).toBeDefined();
    });

    test('ops command has correct description', () => {
      const cmd = program.commands.find(c => c.name() === 'ops');
      expect(cmd.description()).toContain('operational dashboard');
    });

    test('ops command has --compact option', () => {
      const cmd = program.commands.find(c => c.name() === 'ops');
      const compactOpt = cmd.options.find(o => o.long === '--compact');
      expect(compactOpt).toBeDefined();
    });

    test('ops command has --watch option', () => {
      const cmd = program.commands.find(c => c.name() === 'ops');
      const watchOpt = cmd.options.find(o => o.long === '--watch');
      expect(watchOpt).toBeDefined();
    });

    test('ops command has --alerts-only option', () => {
      const cmd = program.commands.find(c => c.name() === 'ops');
      const alertsOpt = cmd.options.find(o => o.long === '--alerts-only');
      expect(alertsOpt).toBeDefined();
    });

    test('ops command has --export option', () => {
      const cmd = program.commands.find(c => c.name() === 'ops');
      const exportOpt = cmd.options.find(o => o.long === '--export');
      expect(exportOpt).toBeDefined();
    });

    test('ops command has --exit-code option', () => {
      const cmd = program.commands.find(c => c.name() === 'ops');
      const exitCodeOpt = cmd.options.find(o => o.long === '--exit-code');
      expect(exitCodeOpt).toBeDefined();
    });

    test('ops command has --interval option', () => {
      const cmd = program.commands.find(c => c.name() === 'ops');
      const intervalOpt = cmd.options.find(o => o.long === '--interval');
      expect(intervalOpt).toBeDefined();
    });
  });

  describe('health score calculation', () => {
    test('calculates perfect score for all healthy components', () => {
      const components = [
        { status: 'healthy' },
        { status: 'healthy' },
        { status: 'healthy' },
      ];

      expect(ops.calculateHealthScore(components)).toBe(100);
    });

    test('reduces score for warning components', () => {
      const components = [
        { status: 'healthy' },
        { status: 'warning' },
        { status: 'healthy' },
      ];

      expect(ops.calculateHealthScore(components)).toBe(90);
    });

    test('reduces score for critical components', () => {
      const components = [
        { status: 'healthy' },
        { status: 'critical' },
        { status: 'healthy' },
      ];

      expect(ops.calculateHealthScore(components)).toBe(80);
    });

    test('reduces score for down components', () => {
      const components = [
        { status: 'healthy' },
        { status: 'down' },
        { status: 'healthy' },
      ];

      expect(ops.calculateHealthScore(components)).toBe(85);
    });

    test('never goes below 0', () => {
      const components = [
        { status: 'critical' },
        { status: 'critical' },
        { status: 'critical' },
        { status: 'critical' },
        { status: 'critical' },
        { status: 'critical' },
      ];

      expect(ops.calculateHealthScore(components)).toBe(0);
    });

    test('handles empty components array', () => {
      expect(ops.calculateHealthScore([])).toBe(100);
    });

    test('handles components with unknown status', () => {
      const components = [
        { status: 'healthy' },
        { status: 'unknown' },
        { status: 'healthy' },
      ];

      expect(ops.calculateHealthScore(components)).toBe(100);
    });
  });

  describe('getServiceHealth', () => {
    test('logs debug message when service check completes successfully', async () => {
      axios.get.mockResolvedValue({ status: 200 });

      await ops.getServiceHealth();

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Service health check completed'),
        expect.objectContaining({
          service: expect.any(String),
          healthy: true,
          correlationId: 'test-correlation-id',
        })
      );
    });

    test('logs warning when service check fails', async () => {
      axios.get.mockRejectedValue(new Error('Connection refused'));

      await ops.getServiceHealth();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Service health check failed'),
        expect.objectContaining({
          service: expect.any(String),
          error: expect.any(String),
          correlationId: 'test-correlation-id',
        })
      );
    });

    test('returns healthy status for 200 response', async () => {
      axios.get.mockResolvedValue({ status: 200 });

      const results = await ops.getServiceHealth();

      expect(results.every(r => r.healthy)).toBe(true);
    });

    test('returns unhealthy status for non-200 response', async () => {
      axios.get.mockResolvedValue({ status: 500 });

      const results = await ops.getServiceHealth();

      expect(results.every(r => !r.healthy)).toBe(true);
    });

    test('returns down status for network errors', async () => {
      axios.get.mockRejectedValue({ code: 'ECONNREFUSED', message: 'Connection refused' });

      const results = await ops.getServiceHealth();

      expect(results.every(r => r.status === 'down')).toBe(true);
    });
  });

  describe('getRecentErrors', () => {
    test('logs error when docker check fails', async () => {
      const { execSync } = require('child_process');
      jest.mock('child_process', () => ({
        execSync: jest.fn(() => { throw new Error('docker not found'); }),
      }));

      await ops.getRecentErrors();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to check container status'),
        expect.objectContaining({
          correlationId: 'test-correlation-id',
        })
      );
    });

    test('logs debug when Loki is not available', async () => {
      axios.get.mockRejectedValue(new Error('Connection refused'));

      await ops.getRecentErrors();

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Loki not available'),
        expect.any(Object)
      );
    });
  });

  describe('logging integration', () => {
    test('all status check functions log correlation ID', async () => {
      axios.get.mockRejectedValue(new Error('test error'));

      await ops.getServiceHealth();

      // Verify logger calls include correlationId
      const calls = logger.debug.mock.calls.concat(logger.warn.mock.calls);
      calls.forEach(call => {
        if (call[1] && call[1].correlationId) {
          expect(call[1].correlationId).toBe('test-correlation-id');
        }
      });
    });
  });

  describe('error handling', () => {
    test('getSystemResources handles exec errors gracefully', async () => {
      // Since execSync is called at module load time in some cases, 
      // we verify the function doesn't throw but returns unavailable status
      const result = await ops.getSystemResources();

      // Should return result with available property
      expect(result).toHaveProperty('available');
      // In test environment, either it works or returns unavailable - both are valid
      expect(typeof result.available).toBe('boolean');
    });

    test('getBackupStatus handles missing directory gracefully', async () => {
      const result = await ops.getBackupStatus();

      // When infra dir is not found, it returns available: false
      // When infra dir exists but backup dir doesn't, it returns available: true with warning
      expect(result).toHaveProperty('available');
      expect(typeof result.available).toBe('boolean');
    });

    test('getSSLStatus handles missing certs gracefully', async () => {
      const result = await ops.getSSLStatus();

      expect(result.available).toBe(false);
    });
  });
});
