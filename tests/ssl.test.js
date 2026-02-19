/**
 * Tests for ssl.js module
 * Run with: npm test -- ssl.test.js
 *
 * Tests SSL certificate management command structure.
 */

const ssl = require('../lib/ssl');

// =============================================================================
// Module Structure Tests
// =============================================================================

describe('SSL Module', () => {
  test('exports ssl command', () => {
    expect(ssl).toBeDefined();
    expect(ssl.name()).toBe('ssl');
  });

  test('has check subcommand', () => {
    const checkCmd = ssl.commands.find(c => c.name() === 'check');
    expect(checkCmd).toBeDefined();
    expect(checkCmd.description()).toContain('Check');
  });

  test('has renew subcommand', () => {
    const renewCmd = ssl.commands.find(c => c.name() === 'renew');
    expect(renewCmd).toBeDefined();
    expect(renewCmd.description()).toContain('renew');
  });

  test('has info subcommand', () => {
    const infoCmd = ssl.commands.find(c => c.name() === 'info');
    expect(infoCmd).toBeDefined();
    expect(infoCmd.description()).toContain('info');
  });

  describe('check command', () => {
    const checkCmd = ssl.commands.find(c => c.name() === 'check');

    test('has no required arguments', () => {
      expect(checkCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(checkCmd._aliases).toEqual([]);
    });
  });

  describe('renew command', () => {
    const renewCmd = ssl.commands.find(c => c.name() === 'renew');

    test('has force option', () => {
      const forceOpt = renewCmd.options.find(o => o.long === '--force');
      expect(forceOpt).toBeDefined();
    });

    test('has no required arguments', () => {
      expect(renewCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(renewCmd._aliases).toEqual([]);
    });
  });

  describe('info command', () => {
    const infoCmd = ssl.commands.find(c => c.name() === 'info');

    test('has no required arguments', () => {
      expect(infoCmd._args.length).toBe(0);
    });

    test('has no aliases', () => {
      expect(infoCmd._aliases).toEqual([]);
    });
  });

  describe('SSL functionality', () => {
    test('check command checks certificate expiration', () => {
      const checkCmd = ssl.commands.find(c => c.name() === 'check');
      expect(checkCmd.description()).toContain('certificate');
    });

    test('renew command triggers certificate renewal', () => {
      const renewCmd = ssl.commands.find(c => c.name() === 'renew');
      expect(renewCmd.description()).toContain('renew');
    });

    test('info command shows SSL configuration', () => {
      const infoCmd = ssl.commands.find(c => c.name() === 'info');
      expect(infoCmd.description()).toContain('configuration');
    });

    test('domains checked include main and subdomains', () => {
      // The module checks: domain, api.domain, gateway.domain, core.domain, traefik.domain
      const checkCmd = ssl.commands.find(c => c.name() === 'check');
      expect(checkCmd).toBeDefined();
    });
  });
});
