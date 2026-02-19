/**
 * Tests for api-maintenance.js module
 * Run with: npm test -- api-maintenance.test.js
 *
 * Tests API maintenance command structure.
 */

const apiMaintenance = require('../lib/api-maintenance');

// =============================================================================
// Module Structure Tests
// =============================================================================

describe('API Maintenance Module', () => {
  test('exports api-maintenance command', () => {
    expect(apiMaintenance).toBeDefined();
    expect(apiMaintenance.name()).toBe('api-maintenance');
  });

  test('has apim alias', () => {
    expect(apiMaintenance._aliases).toContain('apim');
  });

  test('has status subcommand', () => {
    const statusCmd = apiMaintenance.commands.find(c => c.name() === 'status');
    expect(statusCmd).toBeDefined();
  });

  test('has run subcommand', () => {
    const runCmd = apiMaintenance.commands.find(c => c.name() === 'run');
    expect(runCmd).toBeDefined();
  });

  test('has tasks subcommand', () => {
    const tasksCmd = apiMaintenance.commands.find(c => c.name() === 'tasks');
    expect(tasksCmd).toBeDefined();
  });

  describe('status command', () => {
    const statusCmd = apiMaintenance.commands.find(c => c.name() === 'status');

    test('has json option', () => {
      const jsonOpt = statusCmd.options.find(o => o.long === '--json');
      expect(jsonOpt).toBeDefined();
    });

    test('has no required arguments', () => {
      expect(statusCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(statusCmd._aliases).toEqual([]);
    });
  });

  describe('run command', () => {
    const runCmd = apiMaintenance.commands.find(c => c.name() === 'run');

    test('has dry-run option', () => {
      const dryRunOpt = runCmd.options.find(o => o.long === '--dry-run');
      expect(dryRunOpt).toBeDefined();
    });

    test('has days option', () => {
      const daysOpt = runCmd.options.find(o => o.long === '--days');
      expect(daysOpt).toBeDefined();
    });

    test('has force option', () => {
      const forceOpt = runCmd.options.find(o => o.long === '--force');
      expect(forceOpt).toBeDefined();
    });

    test('has no required arguments', () => {
      expect(runCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(runCmd._aliases).toEqual([]);
    });
  });

  describe('tasks command', () => {
    const tasksCmd = apiMaintenance.commands.find(c => c.name() === 'tasks');

    test('has no required arguments', () => {
      expect(tasksCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(tasksCmd._aliases).toEqual([]);
    });
  });

  describe('API Maintenance functionality', () => {
    test('status command checks maintenance status', () => {
      const statusCmd = apiMaintenance.commands.find(c => c.name() === 'status');
      expect(statusCmd.description()).toContain('status');
    });

    test('run command runs maintenance tasks', () => {
      const runCmd = apiMaintenance.commands.find(c => c.name() === 'run');
      expect(runCmd.description()).toContain('Run');
    });

    test('tasks command lists available tasks', () => {
      const tasksCmd = apiMaintenance.commands.find(c => c.name() === 'tasks');
      expect(tasksCmd.description()).toContain('List');
    });

    test('supports dry-run mode', () => {
      const runCmd = apiMaintenance.commands.find(c => c.name() === 'run');
      const dryRunOpt = runCmd.options.find(o => o.long === '--dry-run');
      expect(dryRunOpt).toBeDefined();
    });
  });
});
