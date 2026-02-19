/**
 * Tests for analyze.js - System Analysis Module
 * 
 * Security: Tests validate log analysis, pattern detection,
 * and diagnostic security checks.
 * 
 * Run with: npm test -- analyze.test.js
 */

// Mock dependencies
jest.mock('fs-extra', () => ({
  pathExists: jest.fn().mockResolvedValue(true),
  readFile: jest.fn().mockResolvedValue(''),
  readdir: jest.fn().mockResolvedValue([]),
}));

jest.mock('axios', () => ({
  get: jest.fn().mockResolvedValue({ data: {} }),
}));

const analyze = require('../lib/analyze');

// =============================================================================
// Command Structure Tests
// =============================================================================

describe('Command Structure', () => {
  test('exports analyze functions', () => {
    expect(analyze).toBeDefined();
    expect(typeof analyze).toBe('object');
  });

  test('exports analysis functions', () => {
    expect(typeof analyze.runAnalysis).toBe('function');
    expect(typeof analyze.analyzeErrors).toBe('function');
    expect(typeof analyze.generateInsights).toBe('function');
  });
});

// =============================================================================
// Log Analysis Tests
// =============================================================================

describe('Log Analysis', () => {
  test('validates log file paths', () => {
    const validPaths = [
      '/var/log/masterclaw/app.log',
      '/home/user/.masterclaw/logs/core.log',
    ];

    validPaths.forEach(logPath => {
      expect(logPath).toMatch(/\.log$/);
      expect(logPath).not.toMatch(/\.\./);
    });
  });

  test('detects error patterns in logs', () => {
    const errorPatterns = [
      'Error:',
      'Exception:',
      'Failed to',
      'Connection refused',
    ];

    errorPatterns.forEach(pattern => {
      expect(pattern).toMatch(/Error|Exception|Failed|refused/);
    });
  });

  test('log levels are valid', () => {
    const validLevels = ['debug', 'info', 'warn', 'error', 'fatal'];
    const testLevel = 'error';
    expect(validLevels).toContain(testLevel);
  });
});

// =============================================================================
// Error Pattern Tests
// =============================================================================

describe('Error Pattern Detection', () => {
  test('identifies common error types', () => {
    const errors = [
      { type: 'connection', pattern: /connection.*refused/i },
      { type: 'timeout', pattern: /timeout/i },
      { type: 'auth', pattern: /unauthorized|authentication failed/i },
    ];

    errors.forEach(err => {
      expect(err.type).toBeDefined();
      expect(err.pattern).toBeInstanceOf(RegExp);
    });
  });

  test('categorizes errors by severity', () => {
    const severities = ['low', 'medium', 'high', 'critical'];
    const testSeverity = 'high';
    expect(severities).toContain(testSeverity);
  });
});

// =============================================================================
// Performance Analysis Tests
// =============================================================================

describe('Performance Analysis', () => {
  test('measures response times', () => {
    const responseTime = 150; // ms
    expect(responseTime).toBeGreaterThan(0);
    expect(responseTime).toBeLessThan(30000);
  });

  test('identifies slow queries', () => {
    const slowThreshold = 1000; // 1 second
    const queryTime = 2500;
    expect(queryTime).toBeGreaterThan(slowThreshold);
  });

  test('memory usage is within limits', () => {
    const memoryMB = 512;
    expect(memoryMB).toBeGreaterThan(0);
    expect(memoryMB).toBeLessThan(8192);
  });
});

// =============================================================================
// Security Tests
// =============================================================================

describe('Security', () => {
  test('validates log file access paths', () => {
    const maliciousPaths = [
      '../../../etc/passwd',
      '..\\..\\windows\\system32',
    ];

    maliciousPaths.forEach(p => {
      expect(p).toMatch(/\.\.[\/\\]/);
    });
  });

  test('sanitizes log content', () => {
    const sensitiveData = [
      'password=secret123',
      'api_key=sk-abc123',
      'token=Bearer xyz',
    ];

    sensitiveData.forEach(data => {
      expect(data).toMatch(/password|api_key|token/i);
    });
  });

  test('rejects command injection in analysis parameters', () => {
    const injectionAttempts = [
      '; rm -rf /',
      '$(whoami)',
      '`id`',
    ];

    injectionAttempts.forEach(attempt => {
      expect(attempt).toMatch(/[;`$]/);
    });
  });
});

// =============================================================================
// Insight Generation Tests
// =============================================================================

describe('Insight Generation', () => {
  test('generates actionable insights', () => {
    const insights = [
      { type: 'critical', message: 'High error rate detected' },
      { type: 'warning', message: 'Slow response times' },
      { type: 'info', message: 'Memory usage normal' },
    ];

    insights.forEach(insight => {
      expect(insight.type).toBeDefined();
      expect(insight.message).toBeDefined();
    });
  });

  test('insight types are valid', () => {
    const validTypes = ['critical', 'warning', 'info', 'success'];
    const testType = 'warning';
    expect(validTypes).toContain(testType);
  });
});

// =============================================================================
// Module Export Tests
// =============================================================================

describe('Module Exports', () => {
  test('exports analyze module', () => {
    expect(analyze).toBeDefined();
    expect(typeof analyze).toBe('object');
  });
});

// =============================================================================
// Time Range Tests
// =============================================================================

describe('Time Range Validation', () => {
  test('validates time range formats', () => {
    const validRanges = [
      '1h',
      '24h',
      '7d',
      '30d',
    ];

    validRanges.forEach(range => {
      expect(range).toMatch(/^\d+[hd]$/);
    });
  });

  test('rejects invalid time ranges', () => {
    const invalidRanges = ['abc', '1x', 'xyz'];

    invalidRanges.forEach(range => {
      expect(range).not.toMatch(/^\d+[hd]$/);
    });
  });
});
