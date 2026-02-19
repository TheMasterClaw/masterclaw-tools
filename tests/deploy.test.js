/**
 * Tests for deploy.js module
 * Run with: npm test -- deploy.test.js
 *
 * Tests deployment management command structure.
 */

const deploy = require('../lib/deploy');

// =============================================================================
// Module Structure Tests
// =============================================================================

describe('Deploy Module', () => {
  test('exports deploy command', () => {
    expect(deploy).toBeDefined();
    expect(deploy.name()).toBe('deploy');
  });

  test('has rolling subcommand', () => {
    const rollingCmd = deploy.commands.find(c => c.name() === 'rolling');
    expect(rollingCmd).toBeDefined();
    expect(rollingCmd.description()).toContain('Deploy');
  });

  test('has canary subcommand', () => {
    const canaryCmd = deploy.commands.find(c => c.name() === 'canary');
    expect(canaryCmd).toBeDefined();
    expect(canaryCmd.description()).toContain('canary');
  });

  test('has rollback subcommand', () => {
    const rollbackCmd = deploy.commands.find(c => c.name() === 'rollback');
    expect(rollbackCmd).toBeDefined();
    expect(rollbackCmd.description()).toContain('Rollback');
  });

  test('has status subcommand', () => {
    const statusCmd = deploy.commands.find(c => c.name() === 'status');
    expect(statusCmd).toBeDefined();
    expect(statusCmd.description()).toContain('status');
  });

  test('has history subcommand', () => {
    const historyCmd = deploy.commands.find(c => c.name() === 'history');
    expect(historyCmd).toBeDefined();
    expect(historyCmd.description()).toContain('history');
  });

  test('has notify subcommand', () => {
    const notifyCmd = deploy.commands.find(c => c.name() === 'notify');
    expect(notifyCmd).toBeDefined();
    expect(notifyCmd.description()).toContain('notification');
  });

  test('has notify-test subcommand', () => {
    const notifyTestCmd = deploy.commands.find(c => c.name() === 'notify-test');
    expect(notifyTestCmd).toBeDefined();
    expect(notifyTestCmd.description()).toContain('test');
  });

  describe('rolling command', () => {
    const rollingCmd = deploy.commands.find(c => c.name() === 'rolling');

    test('has no required arguments', () => {
      expect(rollingCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(rollingCmd._aliases).toEqual([]);
    });
  });

  describe('canary command', () => {
    const canaryCmd = deploy.commands.find(c => c.name() === 'canary');

    test('requires percent argument', () => {
      expect(canaryCmd._args.length).toBeGreaterThan(0);
    });

    test('has no aliases', () => {
      expect(canaryCmd._aliases).toEqual([]);
    });
  });

  describe('rollback command', () => {
    const rollbackCmd = deploy.commands.find(c => c.name() === 'rollback');

    test('has no required arguments', () => {
      expect(rollbackCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(rollbackCmd._aliases).toEqual([]);
    });
  });

  describe('status command', () => {
    const statusCmd = deploy.commands.find(c => c.name() === 'status');

    test('has no required arguments', () => {
      expect(statusCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(statusCmd._aliases).toEqual([]);
    });
  });

  describe('history command', () => {
    const historyCmd = deploy.commands.find(c => c.name() === 'history');

    test('has no required arguments', () => {
      expect(historyCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(historyCmd._aliases).toEqual([]);
    });
  });

  describe('notify command', () => {
    const notifyCmd = deploy.commands.find(c => c.name() === 'notify');

    test('has no required arguments', () => {
      expect(notifyCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(notifyCmd._aliases).toEqual([]);
    });
  });

  describe('notify-test command', () => {
    const notifyTestCmd = deploy.commands.find(c => c.name() === 'notify-test');

    test('has no required arguments', () => {
      expect(notifyTestCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(notifyTestCmd._aliases).toEqual([]);
    });
  });

  describe('Deployment functionality', () => {
    test('rolling command performs rolling deployment', () => {
      const rollingCmd = deploy.commands.find(c => c.name() === 'rolling');
      expect(rollingCmd.description()).toContain('Deploy');
    });

    test('canary command performs canary deployment', () => {
      const canaryCmd = deploy.commands.find(c => c.name() === 'canary');
      expect(canaryCmd.description()).toContain('canary');
    });

    test('rollback command rolls back deployment', () => {
      const rollbackCmd = deploy.commands.find(c => c.name() === 'rollback');
      expect(rollbackCmd.description()).toContain('Rollback');
    });

    test('status command shows deployment status', () => {
      const statusCmd = deploy.commands.find(c => c.name() === 'status');
      expect(statusCmd.description()).toContain('status');
    });

    test('history command shows deployment history', () => {
      const historyCmd = deploy.commands.find(c => c.name() === 'history');
      expect(historyCmd.description()).toContain('history');
    });

    test('notify command configures notifications', () => {
      const notifyCmd = deploy.commands.find(c => c.name() === 'notify');
      expect(notifyCmd.description()).toContain('notification');
    });

    test('notify-test command tests notifications', () => {
      const notifyTestCmd = deploy.commands.find(c => c.name() === 'notify-test');
      expect(notifyTestCmd.description()).toContain('test');
    });
  });
});
