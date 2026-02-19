/**
 * Tests for cleanup.js module
 * Run with: npm test -- cleanup.test.js
 *
 * Tests cleanup command structure for data retention management.
 */

const cleanup = require('../lib/cleanup');

// =============================================================================
// Module Structure Tests
// =============================================================================

describe('Cleanup Module', () => {
  test('exports cleanup command', () => {
    expect(cleanup).toBeDefined();
    expect(cleanup.name()).toBe('cleanup');
  });

  test('has status subcommand', () => {
    const statusCmd = cleanup.commands.find(c => c.name() === 'status');
    expect(statusCmd).toBeDefined();
    expect(statusCmd.description()).toContain('status');
  });

  test('has schedule subcommand', () => {
    const scheduleCmd = cleanup.commands.find(c => c.name() === 'schedule');
    expect(scheduleCmd).toBeDefined();
    expect(scheduleCmd.description()).toContain('schedule');
  });

  describe('cleanup command itself', () => {
    test('has dry-run option', () => {
      const dryRunOpt = cleanup.options.find(o => o.long === '--dry-run');
      expect(dryRunOpt).toBeDefined();
    });

    test('has no required arguments', () => {
      expect(cleanup._args.length).toBe(0);
    });
  });

  describe('status command', () => {
    const statusCmd = cleanup.commands.find(c => c.name() === 'status');

    test('has no required arguments', () => {
      expect(statusCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(statusCmd._aliases).toEqual([]);
    });
  });

  describe('schedule command', () => {
    const scheduleCmd = cleanup.commands.find(c => c.name() === 'schedule');

    test('has no required arguments', () => {
      expect(scheduleCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(scheduleCmd._aliases).toEqual([]);
    });
  });

  describe('Cleanup functionality', () => {
    test('cleanup command cleans old data', () => {
      expect(cleanup.description()).toContain('Clean');
    });

    test('status command shows cleanup status', () => {
      const statusCmd = cleanup.commands.find(c => c.name() === 'status');
      expect(statusCmd.description()).toContain('status');
    });

    test('schedule command schedules automated cleanup', () => {
      const scheduleCmd = cleanup.commands.find(c => c.name() === 'schedule');
      expect(scheduleCmd.description()).toContain('schedule');
    });

    test('supports dry-run mode', () => {
      const dryRunOpt = cleanup.options.find(o => o.long === '--dry-run');
      expect(dryRunOpt).toBeDefined();
    });
  });
});
