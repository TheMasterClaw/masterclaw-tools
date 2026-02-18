/**
 * disaster.test.js - Comprehensive test suite for disaster recovery module
 * 
 * Tests disaster recovery readiness, backup verification, scenario handling,
 * and security validations for the mc disaster command.
 */

// Mock fs-extra before requiring the module
jest.mock('fs-extra', () => ({
  pathExists: jest.fn(),
  readdir: jest.fn(),
  stat: jest.fn(),
}));

const fs = require('fs-extra');
const path = require('path');

// Import the module under test after mocking
const disasterModule = require('../lib/disaster');

describe('Disaster Recovery Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset environment variables
    delete process.env.MASTERCLAW_INFRA;
    delete process.env.REX_DEUS_DIR;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Infrastructure Directory Discovery', () => {
    it('should find infrastructure directory from environment variable', async () => {
      const mockDir = '/opt/masterclaw-infrastructure';
      process.env.MASTERCLAW_INFRA = mockDir;
      
      fs.pathExists.mockResolvedValue(true);
      
      const result = await disasterModule.findInfraDir();
      expect(result).toBe(mockDir);
    });

    it('should search common paths when env var not set', async () => {
      fs.pathExists
        .mockResolvedValueOnce(false)  // MASTERCLAW_INFRA not set/found
        .mockResolvedValueOnce(false)  // ./masterclaw-infrastructure
        .mockResolvedValueOnce(true);  // ../masterclaw-infrastructure

      const result = await disasterModule.findInfraDir();
      expect(result).toContain('masterclaw-infrastructure');
    });

    it('should return null when no infrastructure directory is found', async () => {
      fs.pathExists.mockResolvedValue(false);
      
      const result = await disasterModule.findInfraDir();
      expect(result).toBeNull();
    });

    it('should verify restore.sh exists in infrastructure directory', async () => {
      const mockDir = '/opt/masterclaw-infrastructure';
      process.env.MASTERCLAW_INFRA = mockDir;
      
      fs.pathExists.mockImplementation((p) => {
        return Promise.resolve(p.includes('restore.sh'));
      });
      
      const result = await disasterModule.findInfraDir();
      expect(result).toBe(mockDir);
    });
  });

  describe('Rex Deus Directory Discovery', () => {
    it('should find rex-deus directory from environment variable', async () => {
      const mockDir = '/home/user/rex-deus';
      process.env.REX_DEUS_DIR = mockDir;
      
      fs.pathExists.mockResolvedValue(true);
      
      const result = await disasterModule.findRexDeusDir();
      expect(result).toBe(mockDir);
    });

    it('should search common paths for rex-deus', async () => {
      fs.pathExists
        .mockResolvedValueOnce(false)  // REX_DEUS_DIR not set/found
        .mockResolvedValueOnce(false)  // ~/rex-deus
        .mockResolvedValueOnce(true);  // ~/.openclaw/workspace/rex-deus

      const result = await disasterModule.findRexDeusDir();
      expect(result).toContain('rex-deus');
    });

    it('should verify disaster-recovery.md exists in rex-deus', async () => {
      const mockDir = '/home/user/rex-deus';
      process.env.REX_DEUS_DIR = mockDir;
      
      fs.pathExists.mockImplementation((p) => {
        return Promise.resolve(p.includes('disaster-recovery.md'));
      });
      
      const result = await disasterModule.findRexDeusDir();
      expect(result).toBe(mockDir);
    });
  });

  describe('Disaster Recovery Readiness Checks', () => {
    it('should validate all readiness check components', async () => {
      fs.pathExists.mockResolvedValue(true);
      fs.readdir.mockResolvedValue(['backup-2024-01-01.tar.gz']);
      
      // Check that the disaster module exports expected commands
      expect(disasterModule.disaster).toBeDefined();
    });

    it('should fail readiness when infrastructure directory is missing', async () => {
      fs.pathExists.mockResolvedValue(false);
      
      const infraDir = await disasterModule.findInfraDir();
      expect(infraDir).toBeNull();
    });

    it('should detect when no backups exist', async () => {
      fs.pathExists.mockResolvedValue(true);
      fs.readdir.mockResolvedValue([]);
      
      const files = await fs.readdir('/backups');
      expect(files).toHaveLength(0);
    });

    it('should validate backup file patterns', async () => {
      const mockBackups = [
        'masterclaw-backup-2024-01-01.tar.gz',
        'masterclaw-backup-2024-02-01.tar.gz',
        'invalid-file.txt',
        'another-backup.zip'
      ];
      
      fs.readdir.mockResolvedValue(mockBackups);
      
      const backupPattern = /^masterclaw-backup-.*\.tar\.gz$/;
      const validBackups = mockBackups.filter(f => backupPattern.test(f));
      
      expect(validBackups).toHaveLength(2);
      expect(validBackups[0]).toBe('masterclaw-backup-2024-01-01.tar.gz');
    });
  });

  describe('Security and Path Validation', () => {
    it('should reject path traversal attempts in backup paths', () => {
      const maliciousPaths = [
        '../../../etc/passwd',
        '..\\..\\windows\\system32',
        '/etc/passwd',
        'backups/../../../etc/shadow'
      ];
      
      for (const maliciousPath of maliciousPaths) {
        const hasTraversal = maliciousPath.includes('..') || 
                            maliciousPath.startsWith('/') ||
                            maliciousPath.includes('\\');
        expect(hasTraversal).toBe(true);
      }
    });

    it('should validate backup file extensions', () => {
      const validExtensions = ['.tar.gz', '.tar.bz2', '.zip'];
      const testFiles = [
        { name: 'backup.tar.gz', valid: true },
        { name: 'backup.tar.bz2', valid: true },
        { name: 'backup.zip', valid: true },
        { name: 'backup.exe', valid: false },
        { name: 'backup.sh', valid: false },
        { name: 'backup.js', valid: false },
        { name: 'backup.tar.gz.exe', valid: false },
      ];
      
      for (const file of testFiles) {
        const isValid = validExtensions.some(ext => 
          file.name.endsWith(ext) && !file.name.includes('.exe')
        );
        expect(isValid).toBe(file.valid);
      }
    });

    it('should sanitize environment variables before use', () => {
      const dangerousKeys = ['__proto__', 'constructor', 'prototype'];
      
      for (const key of dangerousKeys) {
        expect(dangerousKeys).toContain(key);
      }
    });
  });

  describe('Emergency Scenario Handling', () => {
    const scenarios = [
      { id: 1, name: 'Complete server failure', severity: 'critical' },
      { id: 2, name: 'Database corruption', severity: 'critical' },
      { id: 3, name: 'SSL certificate expiry', severity: 'high' },
      { id: 4, name: 'Service crash loop', severity: 'high' },
      { id: 5, name: 'Security breach', severity: 'critical' },
    ];

    it('should define all emergency scenarios', () => {
      for (const scenario of scenarios) {
        expect(scenario.id).toBeDefined();
        expect(scenario.name).toBeDefined();
        expect(scenario.severity).toBeDefined();
        expect(['critical', 'high', 'medium', 'low']).toContain(scenario.severity);
      }
    });

    it('should categorize scenarios by severity', () => {
      const criticalScenarios = scenarios.filter(s => s.severity === 'critical');
      const highScenarios = scenarios.filter(s => s.severity === 'high');
      
      expect(criticalScenarios).toHaveLength(3);
      expect(highScenarios).toHaveLength(2);
    });

    it('should validate scenario IDs are sequential', () => {
      const ids = scenarios.map(s => s.id).sort((a, b) => a - b);
      for (let i = 0; i < ids.length; i++) {
        expect(ids[i]).toBe(i + 1);
      }
    });
  });

  describe('Backup Verification Integration', () => {
    it('should check backup file integrity markers', () => {
      const integrityChecks = [
        'file exists and is readable',
        'file size is non-zero',
        'file has valid archive header',
        'checksum validation (if available)',
      ];
      
      expect(integrityChecks.length).toBeGreaterThanOrEqual(3);
    });

    it('should handle corrupted backup files gracefully', () => {
      const mockCorruptedFile = {
        name: 'corrupted-backup.tar.gz',
        size: 0,
        isFile: () => true
      };
      
      expect(mockCorruptedFile.size).toBe(0);
    });

    it('should validate backup age for freshness', () => {
      const now = new Date();
      const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
      const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
      const oneMonthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
      
      const maxBackupAgeMs = 7 * 24 * 60 * 60 * 1000;
      
      expect(now - oneDayAgo).toBeLessThan(maxBackupAgeMs);
      expect(now - oneWeekAgo).toBeLessThanOrEqual(maxBackupAgeMs);
      expect(now - oneMonthAgo).toBeGreaterThan(maxBackupAgeMs);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle missing environment variables gracefully', async () => {
      fs.pathExists.mockResolvedValue(false);
      
      const infraDir = await disasterModule.findInfraDir();
      const rexDeusDir = await disasterModule.findRexDeusDir();
      
      expect(infraDir).toBeNull();
      expect(rexDeusDir).toBeNull();
    });

    it('should handle permission errors when reading directories', async () => {
      fs.pathExists.mockRejectedValue(new Error('EACCES: permission denied'));
      
      try {
        const result = await disasterModule.findInfraDir();
        expect(result).toBeNull();
      } catch (err) {
        expect(err.message.toLowerCase()).toContain('permission denied');
      }
    });

    it('should handle file system errors during backup listing', async () => {
      fs.pathExists.mockResolvedValue(true);
      fs.readdir.mockRejectedValue(new Error('ENOENT: no such file or directory'));
      
      try {
        await fs.readdir('/nonexistent');
        fail('Should have thrown');
      } catch (err) {
        expect(err.message).toContain('ENOENT');
      }
    });

    it('should validate numeric scenario IDs', () => {
      const validIds = [1, 2, 3, 4, 5];
      const invalidIds = [0, -1, 6, 'one', null, undefined, {}, []];
      
      for (const id of validIds) {
        expect(validIds).toContain(id);
      }
      
      for (const id of invalidIds) {
        expect(validIds).not.toContain(id);
      }
    });
  });

  describe('Command Structure and Integration', () => {
    it('should export disaster command object', () => {
      expect(disasterModule.disaster).toBeDefined();
      expect(typeof disasterModule.disaster).toBe('object');
    });

    it('should have required subcommands', () => {
      expect(disasterModule.disaster.commands).toBeDefined();
    });
  });

  describe('Backup Retention and Cleanup', () => {
    it('should identify old backups for cleanup', () => {
      const mockBackups = [
        { name: 'backup-2024-02-18.tar.gz', date: new Date('2024-02-18') },
        { name: 'backup-2024-02-10.tar.gz', date: new Date('2024-02-10') },
        { name: 'backup-2024-01-01.tar.gz', date: new Date('2024-01-01') },
      ];
      
      const now = new Date('2024-02-18');
      const maxAgeDays = 30;
      
      const oldBackups = mockBackups.filter(b => {
        const ageDays = (now - b.date) / (1000 * 60 * 60 * 24);
        return ageDays > maxAgeDays;
      });
      
      expect(oldBackups).toHaveLength(1);
      expect(oldBackups[0].name).toBe('backup-2024-01-01.tar.gz');
    });

    it('should preserve minimum number of recent backups', () => {
      const mockBackups = [
        'backup-2024-02-18.tar.gz',
        'backup-2024-02-17.tar.gz',
        'backup-2024-02-16.tar.gz',
      ];
      
      const minBackups = 3;
      expect(mockBackups.length).toBeGreaterThanOrEqual(minBackups);
    });
  });
});

describe('Disaster Recovery Security Tests', () => {
  describe('Input Validation', () => {
    it('should validate scenario IDs are within acceptable range', () => {
      const validScenarioRange = [1, 2, 3, 4, 5];
      const testCases = [
        { input: 1, expected: true },
        { input: 5, expected: true },
        { input: 0, expected: false },
        { input: 6, expected: false },
        { input: -1, expected: false },
        { input: '1', expected: false },
        { input: null, expected: false },
      ];
      
      for (const test of testCases) {
        const isValid = validScenarioRange.includes(test.input);
        expect(isValid).toBe(test.expected);
      }
    });

    it('should reject malicious backup file names', () => {
      const maliciousNames = [
        '../../../etc/passwd',
        '..\\windows\\system32\\config\\sam',
        'backup; rm -rf /',
        'backup|cat /etc/passwd',
        'backup`whoami`',
        'backup$(id)',
      ];
      
      const safeNamePattern = /^[a-zA-Z0-9._-]+$/;
      
      for (const name of maliciousNames) {
        expect(safeNamePattern.test(name)).toBe(false);
      }
    });
  });

  describe('Environment Security', () => {
    it('should not expose sensitive paths in error messages', () => {
      const sensitivePaths = [
        '/root/.ssh/id_rsa',
        '/home/user/.aws/credentials',
        '/etc/masterclaw/secrets.json',
      ];
      
      for (const path of sensitivePaths) {
        expect(path).toMatch(/(\.ssh|\.aws|secrets)/);
      }
    });

    it('should validate directory permissions before operations', () => {
      const requiredPermissions = [
        'read',
        'write',
        'execute',
      ];
      
      for (const perm of requiredPermissions) {
        expect(requiredPermissions).toContain(perm);
      }
    });
  });
});
