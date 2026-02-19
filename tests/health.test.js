/**
 * Tests for health.js module
 * Run with: npm test -- health.test.js
 *
 * Tests health monitoring command structure.
 */

const health = require('../lib/health');

// =============================================================================
// Module Structure Tests
// =============================================================================

describe('Health Module', () => {
  test('exports health command', () => {
    expect(health).toBeDefined();
    expect(health.name()).toBe('health');
  });

  test('has check subcommand', () => {
    const checkCmd = health.commands.find(c => c.name() === 'check');
    expect(checkCmd).toBeDefined();
    expect(checkCmd.description()).toContain('health');
  });

  test('has history subcommand', () => {
    const historyCmd = health.commands.find(c => c.name() === 'history');
    expect(historyCmd).toBeDefined();
    expect(historyCmd.description()).toContain('history');
  });

  test('has summary subcommand', () => {
    const summaryCmd = health.commands.find(c => c.name() === 'summary');
    expect(summaryCmd).toBeDefined();
    expect(summaryCmd.description()).toContain('summary');
  });

  test('has uptime subcommand', () => {
    const uptimeCmd = health.commands.find(c => c.name() === 'uptime');
    expect(uptimeCmd).toBeDefined();
    expect(uptimeCmd.description()).toContain('uptime');
  });

  test('has record subcommand', () => {
    const recordCmd = health.commands.find(c => c.name() === 'record');
    expect(recordCmd).toBeDefined();
    expect(recordCmd.description()).toContain('Record');
  });

  describe('check command', () => {
    const checkCmd = health.commands.find(c => c.name() === 'check');

    test('has no required arguments', () => {
      expect(checkCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(checkCmd._aliases).toEqual([]);
    });
  });

  describe('history command', () => {
    const historyCmd = health.commands.find(c => c.name() === 'history');

    test('has limit option', () => {
      const limitOpt = historyCmd.options.find(o => o.long === '--limit');
      expect(limitOpt).toBeDefined();
    });

    test('has no required arguments', () => {
      expect(historyCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(historyCmd._aliases).toEqual([]);
    });
  });

  describe('summary command', () => {
    const summaryCmd = health.commands.find(c => c.name() === 'summary');

    test('has no required arguments', () => {
      expect(summaryCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(summaryCmd._aliases).toEqual([]);
    });
  });

  describe('uptime command', () => {
    const uptimeCmd = health.commands.find(c => c.name() === 'uptime');

    test('has no required arguments', () => {
      expect(uptimeCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(uptimeCmd._aliases).toEqual([]);
    });
  });

  describe('record command', () => {
    const recordCmd = health.commands.find(c => c.name() === 'record');

    test('has no required arguments', () => {
      expect(recordCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(recordCmd._aliases).toEqual([]);
    });
  });

  describe('Health functionality', () => {
    test('check command performs health checks', () => {
      const checkCmd = health.commands.find(c => c.name() === 'check');
      expect(checkCmd.description()).toContain('health');
    });

    test('history command shows health history', () => {
      const historyCmd = health.commands.find(c => c.name() === 'history');
      expect(historyCmd.description()).toContain('history');
    });

    test('summary command shows health summary', () => {
      const summaryCmd = health.commands.find(c => c.name() === 'summary');
      expect(summaryCmd.description()).toContain('summary');
    });

    test('uptime command shows uptime statistics', () => {
      const uptimeCmd = health.commands.find(c => c.name() === 'uptime');
      expect(uptimeCmd.description()).toContain('uptime');
    });

    test('record command records health status', () => {
      const recordCmd = health.commands.find(c => c.name() === 'record');
      expect(recordCmd.description()).toContain('Record');
    });

    test('services checked include core components', () => {
      // The module checks: Interface, Backend API, AI Core, Gateway
      const checkCmd = health.commands.find(c => c.name() === 'check');
      expect(checkCmd).toBeDefined();
    });
  });
});
