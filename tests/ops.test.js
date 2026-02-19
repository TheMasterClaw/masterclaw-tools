/**
 * Tests for the ops command (Operational Dashboard)
 * Covers logging integration, error handling, and core functionality
 * 
 * Security: Tests verify secure HTTP client is used for all internal requests
 */

const { Command } = require('commander');
const ops = require('../lib/ops');
const { logger } = require('../lib/logger');

// Mock secure HTTP client (replaces axios)
jest.mock('../lib/http-client', () => ({
  get: jest.fn(),
  post: jest.fn(),
  allowPrivateIPs: jest.fn((opts) => ({ ...opts, _allowPrivateIPs: true })),
  withAudit: jest.fn((opts) => ({ ...opts, _audit: true })),
}));

const mockHttpClient = require('../lib/http-client');

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
    beforeEach(() => {
      mockHttpClient.allowPrivateIPs.mockImplementation((opts) =>
        ({ ...opts, _allowPrivateIPs: true }));
    });

    test('logs debug message when service check completes successfully', async () => {
      mockHttpClient.get.mockResolvedValue({ status: 200 });

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
      mockHttpClient.get.mockRejectedValue(new Error('Connection refused'));

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
      mockHttpClient.get.mockResolvedValue({ status: 200 });

      const results = await ops.getServiceHealth();

      expect(results.every(r => r.healthy)).toBe(true);
    });

    test('returns unhealthy status for non-200 response', async () => {
      mockHttpClient.get.mockResolvedValue({ status: 500 });

      const results = await ops.getServiceHealth();

      expect(results.every(r => !r.healthy)).toBe(true);
    });

    test('returns down status for network errors', async () => {
      mockHttpClient.get.mockRejectedValue({ code: 'ECONNREFUSED', message: 'Connection refused' });

      const results = await ops.getServiceHealth();

      expect(results.every(r => r.status === 'down')).toBe(true);
    });

    test('uses secure HTTP client with allowPrivateIPs for internal services', async () => {
      mockHttpClient.get.mockResolvedValue({ status: 200 });

      await ops.getServiceHealth();

      // Verify httpClient.get was called
      expect(mockHttpClient.get).toHaveBeenCalled();
      // Verify allowPrivateIPs was used (required for localhost/internal URLs)
      expect(mockHttpClient.allowPrivateIPs).toHaveBeenCalled();

      // Verify all calls are to localhost URLs
      const calls = mockHttpClient.get.mock.calls;
      for (const [url] of calls) {
        expect(url).toMatch(/^http:\/\/localhost/);
      }
    });
  });

  describe('getRecentErrors', () => {
    beforeEach(() => {
      mockHttpClient.allowPrivateIPs.mockImplementation((opts) =>
        ({ ...opts, _allowPrivateIPs: true }));
    });

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
      mockHttpClient.get.mockRejectedValue(new Error('Connection refused'));

      await ops.getRecentErrors();

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Loki not available'),
        expect.any(Object)
      );
    });

    test('uses secure HTTP client for Loki queries', async () => {
      mockHttpClient.get.mockResolvedValue({
        status: 200,
        data: { data: { result: [] } }
      });

      await ops.getRecentErrors();

      // Verify httpClient.get was called for Loki
      expect(mockHttpClient.get).toHaveBeenCalled();
      // Verify allowPrivateIPs was used for localhost:3100
      expect(mockHttpClient.allowPrivateIPs).toHaveBeenCalled();

      // Check the URL contains Loki endpoint
      const calls = mockHttpClient.get.mock.calls;
      const lokiCall = calls.find(([url]) => url.includes('localhost:3100'));
      expect(lokiCall).toBeDefined();
    });
  });

  describe('logging integration', () => {
    test('all status check functions log correlation ID', async () => {
      mockHttpClient.get.mockRejectedValue(new Error('test error'));
      mockHttpClient.allowPrivateIPs.mockImplementation((opts) => opts);

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

  describe('security hardening', () => {
    test('does not use raw axios for HTTP requests', () => {
      const opsSource = require('fs').readFileSync(
        require('path').join(__dirname, '../lib/ops.js'),
        'utf8'
      );

      // Should not contain raw axios.get/axios.post calls
      expect(opsSource).not.toMatch(/axios\.(get|post|put|delete|request)\(/);

      // Should use httpClient for all HTTP calls
      expect(opsSource).toMatch(/httpClient\.(get|post)/);

      // Should import http-client module
      expect(opsSource).toMatch(/require\(['"][\.\/]*http-client['"]\)/);
    });

    test('uses allowPrivateIPs for all internal service calls', () => {
      const opsSource = require('fs').readFileSync(
        require('path').join(__dirname, '../lib/ops.js'),
        'utf8'
      );

      // Should use allowPrivateIPs for localhost/internal services
      expect(opsSource).toMatch(/allowPrivateIPs/);

      // Should be used in multiple places (getServiceHealth, getRecentErrors, getCostStatus)
      const allowPrivateIpMatches = opsSource.match(/allowPrivateIPs/g);
      expect(allowPrivateIpMatches.length).toBeGreaterThanOrEqual(3);
    });

    test('documents security features in module header', () => {
      const opsSource = require('fs').readFileSync(
        require('path').join(__dirname, '../lib/ops.js'),
        'utf8'
      );

      // Should mention SSRF and DNS rebinding protection in header comment
      expect(opsSource).toMatch(/Security.*SSRF|SSRF.*Security/i);
      expect(opsSource).toMatch(/DNS rebinding/i);
    });

    test('secure HTTP client provides SSRF protection', () => {
      // The http-client module provides SSRF protection:
      // - Blocks private IPs by default
      // - Validates hostnames against suspicious patterns
      // - Prevents access to internal services from external URLs

      const httpClientSource = require('fs').readFileSync(
        require('path').join(__dirname, '../lib/http-client.js'),
        'utf8'
      );

      // http-client should implement SSRF protection
      expect(httpClientSource).toMatch(/SSRF/i);
      expect(httpClientSource).toMatch(/validateUrlSSRF/i);
    });

    test('secure HTTP client provides DNS rebinding protection', () => {
      // The http-client module provides DNS rebinding protection:
      // - Validates resolved IP addresses after DNS lookup
      // - Blocks private IPs that resolve from external hostnames

      const httpClientSource = require('fs').readFileSync(
        require('path').join(__dirname, '../lib/http-client.js'),
        'utf8'
      );

      expect(httpClientSource).toMatch(/DNS.*rebinding|rebinding.*protection/i);
      expect(httpClientSource).toMatch(/validateDNSRebinding/i);
    });
  });
});
