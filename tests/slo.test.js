/**
 * Tests for slo.js module
 * Run with: npm test -- slo.test.js
 *
 * Tests Service Level Objective (SLO) tracking commands.
 */

const slo = require('../lib/slo');

// =============================================================================
// Module Structure Tests
// =============================================================================

describe('SLO Module', () => {
  test('exports slo command', () => {
    expect(slo).toBeDefined();
    expect(slo.name()).toBe('slo');
  });

  test('has list subcommand', () => {
    const listCmd = slo.commands.find(c => c.name() === 'list');
    expect(listCmd).toBeDefined();
    expect(listCmd.description()).toContain('List');
  });

  test('has status subcommand', () => {
    const statusCmd = slo.commands.find(c => c.name() === 'status');
    expect(statusCmd).toBeDefined();
    expect(statusCmd.description()).toContain('status');
  });

  test('has alerts subcommand', () => {
    const alertsCmd = slo.commands.find(c => c.name() === 'alerts');
    expect(alertsCmd).toBeDefined();
    expect(alertsCmd.description()).toContain('alert');
  });

  test('has explain subcommand', () => {
    const explainCmd = slo.commands.find(c => c.name() === 'explain');
    expect(explainCmd).toBeDefined();
    expect(explainCmd.description()).toContain('Explain');
  });

  describe('list command', () => {
    const listCmd = slo.commands.find(c => c.name() === 'list');

    test('has no required arguments', () => {
      expect(listCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(listCmd._aliases).toEqual([]);
    });
  });

  describe('status command', () => {
    const statusCmd = slo.commands.find(c => c.name() === 'status');

    test('has optional slo-name argument', () => {
      expect(statusCmd._args.length).toBeGreaterThan(0);
    });

    test('has no aliases', () => {
      expect(statusCmd._aliases).toEqual([]);
    });
  });

  describe('alerts command', () => {
    const alertsCmd = slo.commands.find(c => c.name() === 'alerts');

    test('has no required arguments', () => {
      expect(alertsCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(alertsCmd._aliases).toEqual([]);
    });
  });

  describe('explain command', () => {
    const explainCmd = slo.commands.find(c => c.name() === 'explain');

    test('has no required arguments', () => {
      expect(explainCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(explainCmd._aliases).toEqual([]);
    });
  });

  describe('SLO functionality', () => {
    test('list command lists all SLOs', () => {
      const listCmd = slo.commands.find(c => c.name() === 'list');
      expect(listCmd.description()).toContain('SLO');
    });

    test('status command checks SLO status', () => {
      const statusCmd = slo.commands.find(c => c.name() === 'status');
      expect(statusCmd.description()).toContain('status');
    });

    test('alerts command shows burn rate alerts', () => {
      const alertsCmd = slo.commands.find(c => c.name() === 'alerts');
      expect(alertsCmd.description()).toContain('burn');
    });

    test('explain command explains SLO concepts', () => {
      const explainCmd = slo.commands.find(c => c.name() === 'explain');
      expect(explainCmd.description()).toContain('SLO');
    });
  });
});
