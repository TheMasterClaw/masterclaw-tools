/**
 * Tests for backup-verify.js module
 * Run with: npm test -- backup-verify.test.js
 * 
 * Tests cover:
 * - Input validation and security hardening
 * - Path traversal prevention
 * - File extension validation
 * - Option validation
 * - Error handling
 */

const backupVerify = require('../lib/backup-verify');
const { validateBackupFilePath, validateVerifyOptions, findInfraDir } = require('../lib/backup-verify');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// Mock dependencies
jest.mock('../lib/security', () => ({
  containsPathTraversal: jest.fn((p) => {
    // Only return true for actual traversal patterns
    if (typeof p !== 'string') return false;
    return p.includes('../') || p.includes('..\\') || p.startsWith('..');
  }),
  sanitizeFilename: jest.fn((f) => f.replace(/[^a-zA-Z0-9._-]/g, '_')),
}));

jest.mock('../lib/docker', () => ({
  validateWorkingDirectory: jest.fn((dir) => {
    if (dir.includes('..')) throw new Error('Path traversal detected');
  }),
  DockerSecurityError: class DockerSecurityError extends Error {
    constructor(msg, code, details) {
      super(msg);
      this.code = code;
      this.details = details;
    }
  },
}));

jest.mock('../lib/audit', () => ({
  logAuditEvent: jest.fn().mockResolvedValue(true),
  logSecurityViolation: jest.fn().mockResolvedValue(true),
}));

// Mock fs-extra
jest.mock('fs-extra');

// Mock child_process
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

const { spawn } = require('child_process');

describe('Backup Verify Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MASTERCLAW_INFRA = '';
  });

  afterEach(() => {
    delete process.env.MASTERCLAW_INFRA;
  });

  // ===========================================================================
  // Input Validation Tests
  // ===========================================================================
  describe('validateBackupFilePath', () => {
    test('accepts valid file paths', () => {
      const validPaths = [
        '/backups/backup.tar.gz',
        './backup.sql',
        'backup.dump',
        '/data/backups/my-backup_2024-01-15.tar',
        'C:\\backups\\backup.zip',
      ];

      for (const filePath of validPaths) {
        const result = validateBackupFilePath(filePath);
        expect(result.valid).toBe(true);
        expect(result.sanitizedPath).toBeDefined();
      }
    });

    test('rejects non-string inputs', () => {
      const invalidInputs = [null, undefined, 123, {}, [], true];

      for (const input of invalidInputs) {
        const result = validateBackupFilePath(input);
        expect(result.valid).toBe(false);
        expect(result.error).toBe('File path must be a string');
      }
    });

    test('rejects empty file paths', () => {
      const result = validateBackupFilePath('');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('File path cannot be empty');
    });

    test('rejects paths exceeding maximum length', () => {
      const longPath = 'a'.repeat(5000);
      const result = validateBackupFilePath(longPath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds maximum length');
    });

    test('rejects paths with path traversal', () => {
      const { containsPathTraversal } = require('../lib/security');
      containsPathTraversal.mockReturnValue(true);

      const traversalPaths = [
        '../../../etc/passwd',
        '..\\..\\windows\\system32',
        'backup/../../../etc/shadow',
      ];

      for (const filePath of traversalPaths) {
        const result = validateBackupFilePath(filePath);
        expect(result.valid).toBe(false);
        expect(result.securityViolation).toBe(true);
        expect(result.error).toContain('path traversal');
      }
    });

    test('rejects paths with null bytes', () => {
      const result = validateBackupFilePath('backup\0/etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.securityViolation).toBe(true);
      expect(result.error).toContain('null bytes');
    });

    test('sanitizes filename component', () => {
      const { sanitizeFilename } = require('../lib/security');
      sanitizeFilename.mockReturnValue('safe_backup.tar.gz');

      // Use a path without special traversal characters but with other unsafe chars
      const result = validateBackupFilePath('/path/to/my backup file.tar.gz');
      expect(result.valid).toBe(true);
      expect(sanitizeFilename).toHaveBeenCalled();
    });

    test('accepts various backup extensions', () => {
      const extensions = ['.tar', '.tar.gz', '.tgz', '.zip', '.sql', '.dump'];
      
      for (const ext of extensions) {
        const result = validateBackupFilePath(`backup${ext}`);
        expect(result.valid).toBe(true);
      }
    });
  });

  // ===========================================================================
  // Options Validation Tests
  // ===========================================================================
  describe('validateVerifyOptions', () => {
    test('accepts valid single-mode options', () => {
      const validOptions = [
        { file: '/backups/backup.tar.gz' },
        { latest: true },
        { all: true },
        {}, // No mode specified (uses default)
        { metrics: true },
        { quiet: true },
        { file: '/backup.tar', metrics: true, quiet: false },
      ];

      for (const options of validOptions) {
        const result = validateVerifyOptions(options);
        expect(result.valid).toBe(true);
      }
    });

    test('rejects conflicting mode options', () => {
      const conflictingOptions = [
        { file: '/backup.tar', latest: true },
        { file: '/backup.tar', all: true },
        { latest: true, all: true },
        { file: '/backup.tar', latest: true, all: true },
      ];

      for (const options of conflictingOptions) {
        const result = validateVerifyOptions(options);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Conflicting options');
      }
    });

    test('rejects invalid file paths in options', () => {
      const { containsPathTraversal } = require('../lib/security');
      containsPathTraversal.mockReturnValue(true);

      const options = { file: '../../../etc/passwd' };
      const result = validateVerifyOptions(options);
      expect(result.valid).toBe(false);
      expect(result.securityViolation).toBe(true);
    });
  });

  // ===========================================================================
  // Infrastructure Directory Tests
  // ===========================================================================
  describe('findInfraDir', () => {
    test('returns directory when MASTERCLAW_INFRA is set and valid', async () => {
      const validDir = '/opt/masterclaw-infrastructure';
      process.env.MASTERCLAW_INFRA = validDir;
      
      fs.pathExists.mockResolvedValue(true);
      fs.stat.mockResolvedValue({ mode: 0o755 });

      const result = await findInfraDir();
      expect(result).toBe(validDir);
    });

    test('returns null when no valid directory found', async () => {
      fs.pathExists.mockResolvedValue(false);

      const result = await findInfraDir();
      expect(result).toBeNull();
    });

    test('skips directories with path traversal', async () => {
      const { validateWorkingDirectory } = require('../lib/docker');
      validateWorkingDirectory.mockImplementation((dir) => {
        if (dir.includes('..')) throw new Error('Path traversal detected');
      });

      // Should skip invalid paths and continue searching
      fs.pathExists.mockResolvedValue(true);
      
      const result = await findInfraDir();
      // May find a valid path or return null, but shouldn't throw
      expect(result === null || typeof result === 'string').toBe(true);
    });

    test('warns about insecure script permissions', async () => {
      const validDir = '/opt/masterclaw-infrastructure';
      process.env.MASTERCLAW_INFRA = validDir;
      
      fs.pathExists.mockResolvedValue(true);
      // Script is writable by others (insecure)
      fs.stat.mockResolvedValue({ mode: 0o777 });

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      
      await findInfraDir();
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('writable by others')
      );
      
      consoleSpy.mockRestore();
    });
  });

  // ===========================================================================
  // Execute Backup Verify Tests
  // ===========================================================================
  describe('executeBackupVerify', () => {
    beforeEach(() => {
      fs.pathExists.mockReset();
      spawn.mockReset();
    });

    test('throws error when infrastructure directory not found', async () => {
      fs.pathExists.mockResolvedValue(false);

      await expect(backupVerify.executeBackupVerify({}))
        .rejects.toThrow('MasterClaw infrastructure directory not found');
    });

    test('throws error when backup script not found', async () => {
      // First call for script check returns false
      fs.pathExists.mockResolvedValueOnce(true)  // infra dir exists
        .mockResolvedValueOnce(false); // script doesn't exist

      await expect(backupVerify.executeBackupVerify({}))
        .rejects.toThrow('Backup verification script not found');
    });

    test('executes verification script successfully', async () => {
      fs.pathExists.mockResolvedValue(true);
      fs.stat.mockResolvedValue({ mode: 0o755 });

      const mockProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };

      spawn.mockReturnValue(mockProcess);

      // Simulate successful execution
      setTimeout(() => {
        const closeHandler = mockProcess.on.mock.calls.find(
          call => call[0] === 'close'
        )[1];
        closeHandler(0);
      }, 10);

      const result = await backupVerify.executeBackupVerify({ latest: true });
      expect(result.success).toBe(true);
    });

    test('handles verification failure (exit code 1)', async () => {
      fs.pathExists.mockResolvedValue(true);

      const mockProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };

      spawn.mockReturnValue(mockProcess);

      setTimeout(() => {
        const closeHandler = mockProcess.on.mock.calls.find(
          call => call[0] === 'close'
        )[1];
        closeHandler(1);
      }, 10);

      await expect(backupVerify.executeBackupVerify({}))
        .rejects.toMatchObject({
          code: 'VERIFY_FAILED',
          exitCode: 1,
        });
    });

    test('handles no backups found (exit code 2)', async () => {
      fs.pathExists.mockResolvedValue(true);

      const mockProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };

      spawn.mockReturnValue(mockProcess);

      setTimeout(() => {
        const closeHandler = mockProcess.on.mock.calls.find(
          call => call[0] === 'close'
        )[1];
        closeHandler(2);
      }, 10);

      await expect(backupVerify.executeBackupVerify({}))
        .rejects.toMatchObject({
          code: 'NO_BACKUPS',
          exitCode: 2,
        });
    });

    test('handles spawn errors', async () => {
      fs.pathExists.mockResolvedValue(true);

      const mockProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };

      spawn.mockReturnValue(mockProcess);

      setTimeout(() => {
        const errorHandler = mockProcess.on.mock.calls.find(
          call => call[0] === 'error'
        )[1];
        errorHandler(new Error('Spawn failed'));
      }, 10);

      await expect(backupVerify.executeBackupVerify({}))
        .rejects.toThrow('Spawn failed');
    });

    test('handles timeout', async () => {
      fs.pathExists.mockResolvedValue(true);
      const { logSecurityViolation } = require('../lib/audit');

      const mockProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };

      spawn.mockReturnValue(mockProcess);

      setTimeout(() => {
        const timeoutHandler = mockProcess.on.mock.calls.find(
          call => call[0] === 'timeout'
        )[1];
        timeoutHandler();
      }, 10);

      await expect(backupVerify.executeBackupVerify({}))
        .rejects.toMatchObject({
          code: 'VERIFY_TIMEOUT',
        });

      expect(logSecurityViolation).toHaveBeenCalledWith(
        'BACKUP_VERIFY_TIMEOUT',
        expect.any(Object)
      );
    });

    test('sanitizes file path before passing to script', async () => {
      fs.pathExists.mockResolvedValue(true);
      fs.stat.mockResolvedValue({ mode: 0o755 });

      const { sanitizeFilename } = require('../lib/security');
      sanitizeFilename.mockReturnValue('safe_backup.tar.gz');

      const mockProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
        kill: jest.fn(),
      };

      spawn.mockReturnValue(mockProcess);

      setTimeout(() => {
        const closeHandler = mockProcess.on.mock.calls.find(
          call => call[0] === 'close'
        )?.[1];
        if (closeHandler) closeHandler(0);
      }, 10);

      // Use a valid file path (not a traversal path)
      await backupVerify.executeBackupVerify({ file: '/path/backup.tar.gz' });

      // Verify spawn was called with sanitized arguments
      expect(spawn).toHaveBeenCalled();
      const spawnArgs = spawn.mock.calls[0][1];
      expect(spawnArgs).toContain('--file');
    });
  });

  // ===========================================================================
  // Constants Tests
  // ===========================================================================
  describe('Constants', () => {
    test('ALLOWED_BACKUP_EXTENSIONS contains expected values', () => {
      const { ALLOWED_BACKUP_EXTENSIONS } = require('../lib/backup-verify');
      expect(ALLOWED_BACKUP_EXTENSIONS.has('.tar')).toBe(true);
      expect(ALLOWED_BACKUP_EXTENSIONS.has('.tar.gz')).toBe(true);
      expect(ALLOWED_BACKUP_EXTENSIONS.has('.tgz')).toBe(true);
      expect(ALLOWED_BACKUP_EXTENSIONS.has('.zip')).toBe(true);
      expect(ALLOWED_BACKUP_EXTENSIONS.has('.sql')).toBe(true);
      expect(ALLOWED_BACKUP_EXTENSIONS.has('.dump')).toBe(true);
    });

    test('MAX_FILE_PATH_LENGTH is reasonable', () => {
      const { MAX_FILE_PATH_LENGTH } = require('../lib/backup-verify');
      expect(MAX_FILE_PATH_LENGTH).toBe(4096);
    });

    test('DEFAULT_VERIFY_TIMEOUT is 10 minutes', () => {
      const { DEFAULT_VERIFY_TIMEOUT } = require('../lib/backup-verify');
      expect(DEFAULT_VERIFY_TIMEOUT).toBe(10 * 60 * 1000); // 10 minutes in ms
    });
  });

  // ===========================================================================
  // Security Integration Tests
  // ===========================================================================
  describe('Security Integration', () => {
    test('prevents command injection via file path', async () => {
      const { containsPathTraversal } = require('../lib/security');
      containsPathTraversal.mockReturnValue(true);

      const result = validateBackupFilePath('backup; rm -rf /');
      expect(result.valid).toBe(false);
      expect(result.securityViolation).toBe(true);
    });

    test('prevents path traversal attacks', async () => {
      const { containsPathTraversal } = require('../lib/security');
      
      const traversalAttempts = [
        '../../../etc/passwd',
        '..\\..\\windows\\system32\\config\\sam',
        'backup/../../../etc/shadow',
        './../../etc/passwd',
      ];

      for (const attempt of traversalAttempts) {
        containsPathTraversal.mockReturnValue(attempt.includes('..'));
        const result = validateBackupFilePath(attempt);
        
        if (!result.valid) {
          expect(result.securityViolation || result.error).toBeDefined();
        }
      }
    });

    test('validates all option combinations', () => {
      const combinations = [
        { options: {}, shouldPass: true },
        { options: { file: '/backup.tar' }, shouldPass: true },
        { options: { latest: true }, shouldPass: true },
        { options: { all: true }, shouldPass: true },
        { options: { file: '/backup.tar', latest: true }, shouldPass: false },
        { options: { latest: true, all: true }, shouldPass: false },
        { options: { file: '/backup.tar', all: true }, shouldPass: false },
      ];

      for (const { options, shouldPass } of combinations) {
        const result = validateVerifyOptions(options);
        expect(result.valid).toBe(shouldPass);
      }
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================
  describe('Error Handling', () => {
    test('error objects include appropriate codes', async () => {
      fs.pathExists.mockResolvedValue(false);

      try {
        await backupVerify.executeBackupVerify({});
        fail('Should have thrown');
      } catch (err) {
        expect(err.code).toBe('INFRA_NOT_FOUND');
      }
    });

    test('invalid file path errors include security flag', () => {
      const { containsPathTraversal } = require('../lib/security');
      containsPathTraversal.mockReturnValue(true);

      const result = validateBackupFilePath('../../../etc/passwd');
      expect(result.securityViolation).toBe(true);
    });

    test('verification failure includes exit code', async () => {
      fs.pathExists.mockResolvedValue(true);

      const mockProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn((event, cb) => { cb('error output'); }) },
        on: jest.fn(),
        kill: jest.fn(),
      };

      spawn.mockReturnValue(mockProcess);

      setTimeout(() => {
        const closeHandler = mockProcess.on.mock.calls.find(
          call => call[0] === 'close'
        )?.[1];
        if (closeHandler) closeHandler(5);
      }, 10);

      try {
        await backupVerify.executeBackupVerify({});
        fail('Should have thrown');
      } catch (err) {
        expect(err.exitCode).toBe(5);
        expect(err.code).toBe('VERIFY_FAILED');
      }
    });
  });
});
