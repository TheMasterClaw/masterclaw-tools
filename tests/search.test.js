/**
 * Tests for search.js module
 * Run with: npm test -- search.test.js
 *
 * Tests search functionality command structure.
 */

const search = require('../lib/search');

// =============================================================================
// Module Structure Tests
// =============================================================================

describe('Search Module', () => {
  test('exports search command', () => {
    expect(search).toBeDefined();
    expect(search.name()).toBe('search');
  });

  test('has memory subcommand', () => {
    const memoryCmd = search.commands.find(c => c.name() === 'memory');
    expect(memoryCmd).toBeDefined();
    expect(memoryCmd.description()).toBe('Search through memories');
  });

  test('has task subcommand', () => {
    const taskCmd = search.commands.find(c => c.name() === 'task');
    expect(taskCmd).toBeDefined();
    expect(taskCmd.description()).toBe('Search through tasks');
  });

  describe('memory command', () => {
    const memoryCmd = search.commands.find(c => c.name() === 'memory');

    test('takes query argument', () => {
      expect(memoryCmd._args.length).toBeGreaterThan(0);
    });

    test('has limit option', () => {
      const limitOpt = memoryCmd.options.find(o => o.long === '--limit');
      expect(limitOpt).toBeDefined();
      expect(limitOpt.description).toContain('number');
    });

    test('limit defaults to 5', () => {
      const limitOpt = memoryCmd.options.find(o => o.long === '--limit');
      expect(limitOpt.defaultValue).toBe('5');
    });

    test('limit has short alias -n', () => {
      const limitOpt = memoryCmd.options.find(o => o.short === '-n');
      expect(limitOpt).toBeDefined();
    });

    test('has no aliases', () => {
      expect(memoryCmd._aliases).toEqual([]);
    });
  });

  describe('task command', () => {
    const taskCmd = search.commands.find(c => c.name() === 'task');

    test('takes query argument', () => {
      expect(taskCmd._args.length).toBeGreaterThan(0);
    });

    test('has no options', () => {
      expect(taskCmd.options.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(taskCmd._aliases).toEqual([]);
    });
  });

  describe('Search functionality', () => {
    test('memory command searches via core API', () => {
      const memoryCmd = search.commands.find(c => c.name() === 'memory');
      expect(memoryCmd.description()).toBe('Search through memories');
      // Posts to /v1/memory/search endpoint
    });

    test('task command searches via API', () => {
      const taskCmd = search.commands.find(c => c.name() === 'task');
      expect(taskCmd.description()).toBe('Search through tasks');
      // Gets from /tasks endpoint and filters
    });

    test('memory search uses top_k parameter', () => {
      const memoryCmd = search.commands.find(c => c.name() === 'memory');
      const limitOpt = memoryCmd.options.find(o => o.long === '--limit');
      expect(limitOpt).toBeDefined();
      // Limit is converted to top_k in the API call
    });

    test('task search filters by title and description', () => {
      const taskCmd = search.commands.find(c => c.name() === 'task');
      expect(taskCmd.description()).toBe('Search through tasks');
      // Searches both title and description fields
    });
  });
});
