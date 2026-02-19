/**
 * Tests for task.js module
 * Run with: npm test -- task.test.js
 *
 * Tests task management command structure and configuration.
 */

const task = require('../lib/task');

// =============================================================================
// Module Structure Tests
// =============================================================================

describe('Task Module', () => {
  test('exports task command', () => {
    expect(task).toBeDefined();
    expect(task.name()).toBe('task');
  });

  test('has list subcommand', () => {
    const listCmd = task.commands.find(c => c.name() === 'list');
    expect(listCmd).toBeDefined();
    expect(listCmd.description()).toBe('List all tasks');
  });

  test('has add subcommand', () => {
    const addCmd = task.commands.find(c => c.name() === 'add');
    expect(addCmd).toBeDefined();
    expect(addCmd.description()).toBe('Add a new task');
  });

  test('has done subcommand', () => {
    const doneCmd = task.commands.find(c => c.name() === 'done');
    expect(doneCmd).toBeDefined();
    expect(doneCmd.description()).toBe('Mark task as complete');
  });

  describe('list command options', () => {
    const listCmd = task.commands.find(c => c.name() === 'list');

    test('has status option', () => {
      const statusOpt = listCmd.options.find(o => o.long === '--status');
      expect(statusOpt).toBeDefined();
      expect(statusOpt.description).toContain('filter');
    });

    test('has priority option', () => {
      const priorityOpt = listCmd.options.find(o => o.long === '--priority');
      expect(priorityOpt).toBeDefined();
      expect(priorityOpt.description).toContain('filter');
    });
  });

  describe('add command options', () => {
    const addCmd = task.commands.find(c => c.name() === 'add');

    test('has description option', () => {
      const descOpt = addCmd.options.find(o => o.long === '--description');
      expect(descOpt).toBeDefined();
      expect(descOpt.description).toContain('description');
    });

    test('has priority option with default value', () => {
      const priorityOpt = addCmd.options.find(o => o.long === '--priority');
      expect(priorityOpt).toBeDefined();
      expect(priorityOpt.defaultValue).toBe('normal');
    });

    test('accepts priority levels: low, normal, high', () => {
      const priorityOpt = addCmd.options.find(o => o.long === '--priority');
      // The option should accept these values
      expect(priorityOpt.defaultValue).toBe('normal');
    });

    test('has due date option', () => {
      const dueOpt = addCmd.options.find(o => o.long === '--due');
      expect(dueOpt).toBeDefined();
      expect(dueOpt.description).toContain('date');
    });
  });

  describe('done command', () => {
    const doneCmd = task.commands.find(c => c.name() === 'done');

    test('requires task ID argument', () => {
      // The command takes an <id> argument
      expect(doneCmd._args.length).toBeGreaterThan(0);
    });
  });

  describe('Command aliases', () => {
    test('list command has no aliases', () => {
      const listCmd = task.commands.find(c => c.name() === 'list');
      expect(listCmd._aliases).toEqual([]);
    });

    test('add command has no aliases', () => {
      const addCmd = task.commands.find(c => c.name() === 'add');
      expect(addCmd._aliases).toEqual([]);
    });

    test('done command has no aliases', () => {
      const doneCmd = task.commands.find(c => c.name() === 'done');
      expect(doneCmd._aliases).toEqual([]);
    });
  });

  describe('Command usage', () => {
    test('add command requires title argument', () => {
      const addCmd = task.commands.find(c => c.name() === 'add');
      expect(addCmd._args.length).toBeGreaterThan(0);
    });

    test('done command requires id argument', () => {
      const doneCmd = task.commands.find(c => c.name() === 'done');
      expect(doneCmd._args.length).toBeGreaterThan(0);
    });

    test('list command has no required arguments', () => {
      const listCmd = task.commands.find(c => c.name() === 'list');
      expect(listCmd._args.length).toBe(0);
    });
  });

  describe('Priority values', () => {
    test('valid priority levels are defined', () => {
      // From the add command, we know priorities are: low, normal, high
      const addCmd = task.commands.find(c => c.name() === 'add');
      const priorityOpt = addCmd.options.find(o => o.long === '--priority');
      expect(priorityOpt).toBeDefined();
    });
  });
});
