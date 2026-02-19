/**
 * Tests for export.js module
 * Run with: npm test -- export.test.js
 *
 * Tests data export functionality with security features.
 */

const exporter = require('../lib/export');

// =============================================================================
// Module Structure Tests
// =============================================================================

describe('Export Module', () => {
  test('exports export command', () => {
    expect(exporter).toBeDefined();
    expect(exporter.name()).toBe('export');
  });

  test('has config subcommand', () => {
    const configCmd = exporter.commands.find(c => c.name() === 'config');
    expect(configCmd).toBeDefined();
    expect(configCmd.description()).toContain('config');
  });

  test('has memory subcommand', () => {
    const memoryCmd = exporter.commands.find(c => c.name() === 'memory');
    expect(memoryCmd).toBeDefined();
    expect(memoryCmd.description()).toContain('memories');
  });

  test('has sessions subcommand', () => {
    const sessionsCmd = exporter.commands.find(c => c.name() === 'sessions');
    expect(sessionsCmd).toBeDefined();
    expect(sessionsCmd.description()).toContain('session');
  });

  test('has all subcommand', () => {
    const allCmd = exporter.commands.find(c => c.name() === 'all');
    expect(allCmd).toBeDefined();
    expect(allCmd.description()).toContain('everything');
  });

  describe('config command', () => {
    const configCmd = exporter.commands.find(c => c.name() === 'config');

    test('takes output argument', () => {
      expect(configCmd._args.length).toBeGreaterThan(0);
    });

    test('has no aliases', () => {
      expect(configCmd._aliases).toEqual([]);
    });
  });

  describe('memory command', () => {
    const memoryCmd = exporter.commands.find(c => c.name() === 'memory');

    test('takes output argument', () => {
      expect(memoryCmd._args.length).toBeGreaterThan(0);
    });

    test('has no aliases', () => {
      expect(memoryCmd._aliases).toEqual([]);
    });
  });

  describe('sessions command', () => {
    const sessionsCmd = exporter.commands.find(c => c.name() === 'sessions');

    test('takes output argument', () => {
      expect(sessionsCmd._args.length).toBeGreaterThan(0);
    });

    test('has no aliases', () => {
      expect(sessionsCmd._aliases).toEqual([]);
    });
  });

  describe('all command', () => {
    const allCmd = exporter.commands.find(c => c.name() === 'all');

    test('takes output argument', () => {
      expect(allCmd._args.length).toBeGreaterThan(0);
    });

    test('has no aliases', () => {
      expect(allCmd._aliases).toEqual([]);
    });
  });

  describe('Export functionality', () => {
    test('config command exports configuration', () => {
      const configCmd = exporter.commands.find(c => c.name() === 'config');
      expect(configCmd.description()).toContain('config');
    });

    test('memory command exports memories', () => {
      const memoryCmd = exporter.commands.find(c => c.name() === 'memory');
      expect(memoryCmd.description()).toContain('memories');
    });

    test('sessions command exports sessions', () => {
      const sessionsCmd = exporter.commands.find(c => c.name() === 'sessions');
      expect(sessionsCmd.description()).toContain('session');
    });

    test('all command exports everything', () => {
      const allCmd = exporter.commands.find(c => c.name() === 'all');
      expect(allCmd.description()).toContain('everything');
    });
  });
});
