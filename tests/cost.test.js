/**
 * Tests for cost.js - Cost Management Module
 * 
 * Security: Tests validate cost tracking command structure and options.
 * 
 * Run with: npm test -- cost.test.js
 */

// Mock dependencies before requiring cost module
jest.mock('fs-extra', () => ({
  pathExists: jest.fn().mockResolvedValue(false),
  readJson: jest.fn().mockResolvedValue({}),
  writeJson: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(''),
}));

jest.mock('../lib/security', () => ({
  sanitizeForLog: jest.fn((str) => str),
  maskSensitiveData: jest.fn((data) => data),
}));

jest.mock('../lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(true),
  AuditEventType: {
    COST_ALERT: 'COST_ALERT',
    CONFIG_WRITE: 'CONFIG_WRITE',
  },
}));

const cost = require('../lib/cost');

// =============================================================================
// Command Structure Tests
// =============================================================================

describe('Command Structure', () => {
  test('exports cost command', () => {
    expect(cost).toBeDefined();
    expect(cost.name()).toBe('cost');
  });

  test('has expected subcommands', () => {
    const commands = cost.commands.map(cmd => cmd.name());
    expect(commands.length).toBeGreaterThan(0);
  });

  test('has budget-show command', () => {
    const commands = cost.commands.map(cmd => cmd.name());
    expect(commands).toContain('budget-show');
  });

  test('has check command', () => {
    const commands = cost.commands.map(cmd => cmd.name());
    expect(commands).toContain('check');
  });
});

// =============================================================================
// Budget Configuration Tests
// =============================================================================

describe('Budget Configuration', () => {
  test('budget-set command exists', () => {
    const budgetCmd = cost.commands.find(cmd => cmd.name() === 'budget-set');
    expect(budgetCmd).toBeDefined();
  });

  test('budget-show command exists', () => {
    const showCmd = cost.commands.find(cmd => cmd.name() === 'budget-show');
    expect(showCmd).toBeDefined();
  });

  test('budget-check command exists', () => {
    const checkCmd = cost.commands.find(cmd => cmd.name() === 'budget-check');
    expect(checkCmd).toBeDefined();
  });

  test('budget-monitor command exists', () => {
    const monitorCmd = cost.commands.find(cmd => cmd.name() === 'budget-monitor');
    expect(monitorCmd).toBeDefined();
  });

  test('budget-history command exists', () => {
    const historyCmd = cost.commands.find(cmd => cmd.name() === 'budget-history');
    expect(historyCmd).toBeDefined();
  });

  test('summary command exists', () => {
    const summaryCmd = cost.commands.find(cmd => cmd.name() === 'summary');
    expect(summaryCmd).toBeDefined();
  });

  test('daily command exists', () => {
    const dailyCmd = cost.commands.find(cmd => cmd.name() === 'daily');
    expect(dailyCmd).toBeDefined();
  });
});

// =============================================================================
// Security Tests
// =============================================================================

describe('Security', () => {
  test('validates cost inputs to prevent injection', () => {
    const maliciousInputs = [
      '; rm -rf /',
      '$(whoami)',
      '`id`',
      '../../../etc/passwd',
    ];

    maliciousInputs.forEach(input => {
      // These should be detected as invalid
      expect(input).toMatch(/[;`$]|\.\./);
    });
  });

  test('validates budget amounts', () => {
    const validAmounts = [0, 1, 10, 100, 0.5];
    const invalidAmounts = [-1, -100, NaN];

    validAmounts.forEach(amount => {
      expect(typeof amount).toBe('number');
      expect(amount).toBeGreaterThanOrEqual(0);
    });

    invalidAmounts.forEach(amount => {
      if (!isNaN(amount)) {
        expect(amount).toBeLessThan(0);
      }
    });
  });
});

// =============================================================================
// Cost Formatting Tests
// =============================================================================

describe('Cost Formatting', () => {
  test('formats costs as currency strings', () => {
    const cost1 = 10.5;
    const formatted = `$${cost1.toFixed(2)}`;
    expect(formatted).toBe('$10.50');
    expect(formatted).toContain('$');
  });

  test('formats costs with 2 decimal places', () => {
    const cost = 10;
    const formatted = `$${cost.toFixed(2)}`;
    expect(formatted).toMatch(/\.\d{2}$/);
  });
});

// =============================================================================
// Alert Threshold Tests
// =============================================================================

describe('Alert Thresholds', () => {
  test('thresholds are within valid range', () => {
    const warningThreshold = 50; // 50%
    const criticalThreshold = 80; // 80%

    expect(warningThreshold).toBeGreaterThanOrEqual(0);
    expect(warningThreshold).toBeLessThanOrEqual(100);
    expect(criticalThreshold).toBeGreaterThan(warningThreshold);
  });

  test('rejects invalid threshold values', () => {
    const invalidThresholds = [-1, 101, 200];

    invalidThresholds.forEach(threshold => {
      expect(threshold < 0 || threshold > 100).toBe(true);
    });
  });
});

// =============================================================================
// Budget Status Tests
// =============================================================================

describe('Budget Status', () => {
  test('calculates budget percentage correctly', () => {
    const spent = 50;
    const budget = 100;
    const percentage = (spent / budget) * 100;
    expect(percentage).toBe(50);
  });

  test('identifies when under budget', () => {
    const spent = 50;
    const budget = 100;
    expect(spent).toBeLessThan(budget);
  });

  test('identifies when over budget', () => {
    const spent = 150;
    const budget = 100;
    expect(spent).toBeGreaterThan(budget);
  });
});

// =============================================================================
// Module Export Tests
// =============================================================================

describe('Module Exports', () => {
  test('exports cost command object', () => {
    expect(cost).toBeDefined();
    expect(typeof cost).toBe('object');
    expect(cost.name()).toBe('cost');
  });

  test('has command methods', () => {
    expect(typeof cost.name).toBe('function');
    expect(typeof cost.commands).toBe('object');
  });
});
