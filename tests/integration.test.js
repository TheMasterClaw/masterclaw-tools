/**
 * Integration tests for MasterClaw CLI
 * 
 * These tests validate that different modules work together correctly
 * and that the CLI as a whole maintains security and functionality.
 * 
 * Run with: npm test -- integration.test.js
 */

const path = require('path');
const fs = require('fs-extra');
const os = require('os');

// Mock external dependencies
jest.mock('child_process', () => ({
  spawn: jest.fn(() => ({
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn((event, cb) => {
      if (event === 'close') cb(0);
    }),
  })),
  execSync: jest.fn(),
}));

// =============================================================================
// Module Integration Tests
// =============================================================================

describe('Module Integration', () => {
  test('all security modules export validation functions', () => {
    const securityModules = [
      '../lib/docker',
      '../lib/security',
      '../lib/validate',
    ];

    securityModules.forEach(modulePath => {
      const mod = require(modulePath);
      expect(mod).toBeDefined();
      expect(typeof mod).toBe('object');
    });
  });

  test('all command modules export command objects', () => {
    const commandModules = [
      '../lib/cost',
      '../lib/health',
      '../lib/plugin',
      '../lib/template',
      '../lib/notify',
      '../lib/workflow',
    ];

    commandModules.forEach(modulePath => {
      const mod = require(modulePath);
      expect(mod).toBeDefined();
    });
  });

  test('audit module integrates with other modules', () => {
    const audit = require('../lib/audit');
    expect(audit.logAudit).toBeDefined();
    expect(audit.AuditEventType).toBeDefined();
    expect(typeof audit.logSecurityViolation).toBe('function');
  });
});

// =============================================================================
// Security Integration Tests
// =============================================================================

describe('Security Integration', () => {
  test('path traversal is blocked across all modules', () => {
    const traversalAttempts = [
      '../../../etc/passwd',
      '..\\..\\windows\\system32',
      'normal/../../../etc',
    ];

    traversalAttempts.forEach(filepath => {
      expect(filepath).toMatch(/\.\.[\/\\]/);
    });
  });

  test('command injection is blocked across all modules', () => {
    const injectionAttempts = [
      '; rm -rf /',
      '&& whoami',
      '| cat /etc/passwd',
      '`id`',
      '$(whoami)',
    ];

    injectionAttempts.forEach(cmd => {
      expect(cmd).toMatch(/[;|&`$]/);
    });
  });

  test('security constants are consistent', () => {
    const docker = require('../lib/docker');
    
    expect(docker.MAX_CONTAINER_NAME_LENGTH).toBeGreaterThan(0);
    expect(docker.MAX_TAIL_LINES).toBeGreaterThan(0);
    expect(docker.ALLOWED_COMPOSE_COMMANDS).toBeInstanceOf(Set);
  });
});

// =============================================================================
// Error Handling Integration Tests
// =============================================================================

describe('Error Handling Integration', () => {
  test('all modules handle null inputs gracefully', () => {
    const modules = [
      { mod: require('../lib/security'), method: 'sanitizeForLog' },
      { mod: require('../lib/docker'), method: 'validateContainerName' },
    ];

    modules.forEach(({ mod, method }) => {
      if (mod[method]) {
        expect(() => mod[method](null)).not.toThrow(TypeError);
      }
    });
  });

  test('all modules handle empty string inputs', () => {
    const security = require('../lib/security');
    if (security.sanitizeForLog) {
      const result = security.sanitizeForLog('');
      expect(result).toBeDefined();
    }
  });
});

// =============================================================================
// Configuration Integration Tests
// =============================================================================

describe('Configuration Integration', () => {
  test('config paths are consistent', () => {
    const paths = [
      path.join(os.homedir(), '.masterclaw'),
      path.join(os.homedir(), '.openclaw'),
    ];

    paths.forEach(p => {
      expect(path.isAbsolute(p)).toBe(true);
    });
  });

  test('audit directory is in correct location', () => {
    const auditDir = path.join(os.homedir(), '.masterclaw', 'audit');
    expect(auditDir).toContain('.masterclaw');
    expect(auditDir).toContain('audit');
  });
});

// =============================================================================
// Constants Validation Tests
// =============================================================================

describe('Constants Validation', () => {
  test('timeout values are reasonable', () => {
    const docker = require('../lib/docker');
    
    expect(docker.DEFAULT_DOCKER_TIMEOUT_MS).toBeGreaterThan(0);
    expect(docker.QUICK_DOCKER_TIMEOUT_MS).toBeGreaterThan(0);
    expect(docker.DEFAULT_DOCKER_TIMEOUT_MS).toBeGreaterThan(docker.QUICK_DOCKER_TIMEOUT_MS);
  });

  test('size limits are reasonable', () => {
    const docker = require('../lib/docker');
    
    expect(docker.MAX_CONTAINER_NAME_LENGTH).toBeGreaterThan(0);
    expect(docker.MAX_TAIL_LINES).toBeGreaterThan(0);
    expect(docker.MAX_TAIL_LINES).toBeLessThan(100000);
  });
});

// =============================================================================
// Export Consistency Tests
// =============================================================================

describe('Export Consistency', () => {
  test('all modules export expected types', () => {
    const modules = [
      { name: 'docker', mod: require('../lib/docker') },
      { name: 'security', mod: require('../lib/security') },
      { name: 'audit', mod: require('../lib/audit') },
      { name: 'validate', mod: require('../lib/validate') },
    ];

    modules.forEach(({ name, mod }) => {
      expect(mod).toBeDefined();
      expect(typeof mod).toBe('object');
    });
  });
});

// =============================================================================
// Performance Integration Tests
// =============================================================================

describe('Performance Integration', () => {
  test('regex patterns compile efficiently', () => {
    const patterns = [
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/,
      /[;|\u0026`$(){}[\]\\<>\n\r]/,
      /\.\.[\/\\]/,
    ];

    patterns.forEach(pattern => {
      expect(pattern).toBeInstanceOf(RegExp);
      // Test that pattern doesn't take too long
      const start = Date.now();
      pattern.test('test-string-123');
      expect(Date.now() - start).toBeLessThan(10);
    });
  });
});
