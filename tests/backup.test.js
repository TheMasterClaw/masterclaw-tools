/**
 * Tests for backup.js module
 * Run with: npm test -- backup.test.js
 *
 * Tests backup management command structure.
 */

const backup = require('../lib/backup');

// =============================================================================
// Module Structure Tests
// =============================================================================

describe('Backup Module', () => {
  test('exports backup command', () => {
    expect(backup).toBeDefined();
    expect(backup.name()).toBe('backup');
  });

  test('has list subcommand', () => {
    const listCmd = backup.commands.find(c => c.name() === 'list');
    expect(listCmd).toBeDefined();
    expect(listCmd.description()).toContain('List');
  });

  test('has stats subcommand', () => {
    const statsCmd = backup.commands.find(c => c.name() === 'stats');
    expect(statsCmd).toBeDefined();
    expect(statsCmd.description()).toContain('statistics');
  });

  test('has cleanup subcommand', () => {
    const cleanupCmd = backup.commands.find(c => c.name() === 'cleanup');
    expect(cleanupCmd).toBeDefined();
    expect(cleanupCmd.description()).toContain('Remove');
  });

  test('has export subcommand', () => {
    const exportCmd = backup.commands.find(c => c.name() === 'export');
    expect(exportCmd).toBeDefined();
    expect(exportCmd.description()).toContain('Export');
  });

  test('has cloud subcommand', () => {
    const cloudCmd = backup.commands.find(c => c.name() === 'cloud');
    expect(cloudCmd).toBeDefined();
  });

  describe('backup command itself', () => {
    test('has quiet option', () => {
      const quietOpt = backup.options.find(o => o.long === '--quiet');
      expect(quietOpt).toBeDefined();
    });

    test('has no required arguments', () => {
      expect(backup._args.length).toBe(0);
    });
  });

  describe('list command', () => {
    const listCmd = backup.commands.find(c => c.name() === 'list');

    test('has limit option', () => {
      const limitOpt = listCmd.options.find(o => o.long === '--limit');
      expect(limitOpt).toBeDefined();
    });

    test('limit has default value', () => {
      const limitOpt = listCmd.options.find(o => o.long === '--limit');
      expect(limitOpt.defaultValue).toBeDefined();
    });

    test('has json option', () => {
      const jsonOpt = listCmd.options.find(o => o.long === '--json');
      expect(jsonOpt).toBeDefined();
    });

    test('has no required arguments', () => {
      expect(listCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(listCmd._aliases).toEqual([]);
    });
  });

  describe('stats command', () => {
    const statsCmd = backup.commands.find(c => c.name() === 'stats');

    test('has json option', () => {
      const jsonOpt = statsCmd.options.find(o => o.long === '--json');
      expect(jsonOpt).toBeDefined();
    });

    test('has no required arguments', () => {
      expect(statsCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(statsCmd._aliases).toEqual([]);
    });
  });

  describe('cleanup command', () => {
    const cleanupCmd = backup.commands.find(c => c.name() === 'cleanup');

    test('has force option', () => {
      const forceOpt = cleanupCmd.options.find(o => o.long === '--force');
      expect(forceOpt).toBeDefined();
    });

    test('has dry-run option', () => {
      const dryRunOpt = cleanupCmd.options.find(o => o.long === '--dry-run');
      expect(dryRunOpt).toBeDefined();
    });

    test('has no required arguments', () => {
      expect(cleanupCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(cleanupCmd._aliases).toEqual([]);
    });
  });

  describe('export command', () => {
    const exportCmd = backup.commands.find(c => c.name() === 'export');

    test('has output option', () => {
      const outputOpt = exportCmd.options.find(o => o.long === '--output');
      expect(outputOpt).toBeDefined();
    });

    test('output has default value', () => {
      const outputOpt = exportCmd.options.find(o => o.long === '--output');
      expect(outputOpt.defaultValue).toBe('./mc-backups.json');
    });

    test('has no required arguments', () => {
      expect(exportCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(exportCmd._aliases).toEqual([]);
    });
  });
});
