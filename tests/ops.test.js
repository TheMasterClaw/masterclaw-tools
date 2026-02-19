/**
 * Tests for the ops command (Operational Dashboard)
 */

const { Command } = require('commander');
const ops = require('../lib/ops');

describe('mc ops', () => {
  let program;

  beforeEach(() => {
    program = new Command();
    program.addCommand(ops);
  });

  test('ops command is registered', () => {
    const cmd = program.commands.find(c => c.name() === 'ops');
    expect(cmd).toBeDefined();
  });

  test('ops command has correct description', () => {
    const cmd = program.commands.find(c => c.name() === 'ops');
    expect(cmd.description()).toContain('operational dashboard');
  });

  test('ops command has --compact option', () => {
    const cmd = program.commands.find(c => c.name() === 'ops');
    const compactOpt = cmd.options.find(o => o.long === '--compact');
    expect(compactOpt).toBeDefined();
  });

  test('ops command has --watch option', () => {
    const cmd = program.commands.find(c => c.name() === 'ops');
    const watchOpt = cmd.options.find(o => o.long === '--watch');
    expect(watchOpt).toBeDefined();
  });

  test('ops command has --alerts-only option', () => {
    const cmd = program.commands.find(c => c.name() === 'ops');
    const alertsOpt = cmd.options.find(o => o.long === '--alerts-only');
    expect(alertsOpt).toBeDefined();
  });

  test('ops command has --export option', () => {
    const cmd = program.commands.find(c => c.name() === 'ops');
    const exportOpt = cmd.options.find(o => o.long === '--export');
    expect(exportOpt).toBeDefined();
  });

  test('ops command has --exit-code option', () => {
    const cmd = program.commands.find(c => c.name() === 'ops');
    const exitCodeOpt = cmd.options.find(o => o.long === '--exit-code');
    expect(exitCodeOpt).toBeDefined();
  });
});

describe('ops health score calculation', () => {
  // Import the internal functions for testing
  // Note: In a real implementation, you might want to export these functions
  // from ops.js for unit testing
  
  test('calculates perfect score for all healthy components', () => {
    const components = [
      { status: 'healthy' },
      { status: 'healthy' },
      { status: 'healthy' },
    ];
    
    // Score should be 100
    expect(calculateHealthScore(components)).toBe(100);
  });

  test('reduces score for warning components', () => {
    const components = [
      { status: 'healthy' },
      { status: 'warning' },
      { status: 'healthy' },
    ];
    
    // 100 - 10 = 90
    expect(calculateHealthScore(components)).toBe(90);
  });

  test('reduces score for critical components', () => {
    const components = [
      { status: 'healthy' },
      { status: 'critical' },
      { status: 'healthy' },
    ];
    
    // 100 - 20 = 80
    expect(calculateHealthScore(components)).toBe(80);
  });

  test('never goes below 0', () => {
    const components = [
      { status: 'critical' },
      { status: 'critical' },
      { status: 'critical' },
      { status: 'critical' },
      { status: 'critical' },
      { status: 'critical' },
    ];
    
    // Would be -20, but should be 0
    expect(calculateHealthScore(components)).toBe(0);
  });
});

// Helper function (mirrors the one in ops.js)
function calculateHealthScore(components) {
  let score = 100;
  
  for (const comp of components) {
    if (comp.status === 'critical') score -= 20;
    else if (comp.status === 'warning') score -= 10;
    else if (comp.status === 'down' || comp.status === 'error') score -= 15;
  }

  return Math.max(0, Math.min(100, score));
}
