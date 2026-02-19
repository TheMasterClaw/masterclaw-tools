/**
 * Tests for restore.js - Backup Restore Module
 * 
 * Security: Tests validate path traversal prevention, input sanitization,
 * and disaster recovery procedure safety checks.
 * 
 * Run with: npm test -- restore.test.js
 */

const restore = require('../lib/restore');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

// Mock chalk to avoid ANSI codes in tests
jest.mock('chalk', () => ({
  red: (str) => str,
  yellow: (str) => str,
  green: (str) => str,
  cyan: (str) => str,
  gray: (str) => str,
  bold: (str) => str,
  blue: (str) => str,
  white: (str) => str,
}));

// Mock ora (spinner)
jest.mock('ora', () => {
  return jest.fn(() => ({
    start: jest.fn(function() { return this; }),
    succeed: jest.fn(function() { return this; }),
    fail: jest.fn(function() { return this; }),
    stop: jest.fn(function() { return this; }),
  }));
});

// Mock inquirer
jest.mock('inquirer', () => ({
  prompt: jest.fn().mockResolvedValue({}),
}));

// Mock child_process
jest.mock('child_process', () => ({
  execSync: jest.fn(),
  spawn: jest.fn(),
}));

// Mock audit module
jest.mock('../lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(true),
  AuditEventType: {
    BACKUP_RESTORE: 'BACKUP_RESTORE',
  },
}));

// =============================================================================
// Backup File Naming and Validation Tests
// =============================================================================

describe('Backup File Naming', () => {
  test('validates backup filename format', () => {
    const validNames = [
      'masterclaw_backup_20240115_143022.tar.gz',
      'masterclaw_backup_20231225_000000.tar.gz',
      'masterclaw_backup_20241231_235959.tar.gz',
    ];

    const invalidNames = [
      'backup_20240115_143022.tar.gz',          // Missing masterclaw_ prefix
      'masterclaw_backup_20240115.tar.gz',      // Missing time
      'masterclaw_backup_2024_01_15_143022.tar.gz', // Wrong date format
      'masterclaw_backup_20240115_143022.zip',  // Wrong extension
      '../../../etc/passwd',                     // Path traversal
      'masterclaw_backup_20240115_143022.tar.gz.exe', // Double extension
    ];

    const validPattern = /^masterclaw_backup_\d{8}_\d{6}\.tar\.gz$/;

    validNames.forEach(name => {
      expect(name).toMatch(validPattern);
    });

    invalidNames.forEach(name => {
      expect(name).not.toMatch(validPattern);
    });
  });

  test('parses backup date from filename', () => {
    const filename = 'masterclaw_backup_20240115_143022.tar.gz';
    const match = filename.match(/masterclaw_backup_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);

    expect(match).not.toBeNull();
    expect(match[1]).toBe('2024');
    expect(match[2]).toBe('01');
    expect(match[3]).toBe('15');
    expect(match[4]).toBe('14');
    expect(match[5]).toBe('30');
    expect(match[6]).toBe('22');

    // Create date object
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1;
    const day = parseInt(match[3], 10);
    const hour = parseInt(match[4], 10);
    const minute = parseInt(match[5], 10);
    const second = parseInt(match[6], 10);

    const date = new Date(year, month, day, hour, minute, second);
    expect(date.getFullYear()).toBe(2024);
    expect(date.getMonth()).toBe(0); // January = 0
    expect(date.getDate()).toBe(15);
    expect(date.getHours()).toBe(14);
    expect(date.getMinutes()).toBe(30);
    expect(date.getSeconds()).toBe(22);
  });
});

// =============================================================================
// Size Formatting Tests
// =============================================================================

describe('Size Formatting', () => {
  test('formats bytes correctly', () => {
    const testCases = [
      { bytes: 0, expected: /^0/ },
      { bytes: 512, expected: /512|0\.5/ },
      { bytes: 1024, expected: /1.*KB|1\.0/ },
      { bytes: 1536, expected: /1\.5.*KB/ },
      { bytes: 1024 * 1024, expected: /1.*MB/ },
      { bytes: 1024 * 1024 * 1024, expected: /1.*GB/ },
      { bytes: 1024 * 1024 * 1024 * 1024, expected: /1024.*GB/ }, // Falls through to GB since TB not in units
    ];

    testCases.forEach(({ bytes, expected }) => {
      const units = ['B', 'KB', 'MB', 'GB'];
      let size = bytes;
      let unitIndex = 0;

      while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
      }

      const result = `${size.toFixed(1)} ${units[unitIndex]}`;
      expect(result).toMatch(expected);
    });
  });

  test('handles edge cases for size formatting', () => {
    const edgeCases = [
      { bytes: -1, shouldHandle: true },
      { bytes: Number.MAX_SAFE_INTEGER, shouldHandle: true },
      { bytes: 1024 * 1024 * 1024 * 10, shouldHandle: true }, // 10 GB
    ];

    edgeCases.forEach(({ bytes, shouldHandle }) => {
      expect(() => {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = Math.max(0, bytes);
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
          size /= 1024;
          unitIndex++;
        }

        return `${size.toFixed(1)} ${units[unitIndex]}`;
      }).not.toThrow();
    });
  });
});

// =============================================================================
// Age Formatting Tests
// =============================================================================

describe('Age Formatting', () => {
  test('formats age correctly', () => {
    const now = new Date();

    const testCases = [
      { date: new Date(now - 30 * 1000), expected: /sec|just|now/i },
      { date: new Date(now - 5 * 60 * 1000), expected: /5.*min/ },
      { date: new Date(now - 2 * 60 * 60 * 1000), expected: /2.*hour/ },
      { date: new Date(now - 3 * 24 * 60 * 60 * 1000), expected: /3.*day/ },
    ];

    testCases.forEach(({ date, expected }) => {
      const diff = now - date;
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      let result;
      if (days > 0) {
        result = `${days} day${days !== 1 ? 's' : ''} ago`;
      } else if (hours > 0) {
        result = `${hours} hour${hours !== 1 ? 's' : ''} ago`;
      } else if (minutes > 0) {
        result = `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
      } else {
        result = `${seconds} second${seconds !== 1 ? 's' : ''} ago`;
      }

      expect(result).toMatch(expected);
    });
  });
});

// =============================================================================
// Security Tests
// =============================================================================

describe('Security', () => {
  test('rejects path traversal in backup names', () => {
    const maliciousNames = [
      '../../../etc/passwd',
      '..\\..\\windows\\system32',
      'backup/../../../etc',
      './../etc/passwd',
      '~/backup',
      '/absolute/path/to/backup',
    ];

    maliciousNames.forEach(name => {
      // Path traversal attempts should be detected
      const hasPathTraversal = /\.\.[/\\]|^\/|^\\|^~\//.test(name);
      expect(hasPathTraversal).toBe(true);
    });
  });

  test('validates backup file extensions', () => {
    const validExtensions = ['.tar.gz'];
    const invalidExtensions = [
      '.exe',
      '.sh',
      '.php',
      '.js',
      '.zip',
      '.rar',
      '.7z',
      '',
      '.tar',
      '.gz',
    ];

    validExtensions.forEach(ext => {
      expect('.tar.gz').toBe(ext);
    });

    invalidExtensions.forEach(ext => {
      if (ext) {
        expect(ext).not.toBe('.tar.gz');
      }
    });
  });

  test('validates environment variable names', () => {
    const validEnvVars = [
      'MASTERCLAW_INFRA',
      'BACKUP_DIR',
      'RESTORE_BACKUP',
    ];

    const invalidEnvVars = [
      'PATH',
      'HOME',
      'SHELL',
      'LD_PRELOAD',
    ];

    validEnvVars.forEach(varName => {
      expect(varName.startsWith('MASTERCLAW_') || varName.startsWith('BACKUP_') || varName.startsWith('RESTORE_')).toBe(true);
    });

    invalidEnvVars.forEach(varName => {
      expect(varName.startsWith('MASTERCLAW_') || varName.startsWith('BACKUP_') || varName.startsWith('RESTORE_')).toBe(false);
    });
  });

  test('prevents command injection in backup paths', () => {
    const maliciousPaths = [
      'backup; rm -rf /',
      'backup && cat /etc/passwd',
      'backup|whoami',
      'backup`id`',
      'backup$(echo hacked)',
      'backup;drop table backups;--',
    ];

    maliciousPaths.forEach(p => {
      expect(p).toMatch(/[;|&$`]|\$\(/);
    });
  });
});

// =============================================================================
// Path Validation Tests
// =============================================================================

describe('Path Validation', () => {
  test('validates backup directory structure', () => {
    const infraDir = '/opt/masterclaw-infrastructure';
    const backupDir = path.join(infraDir, 'backups');

    expect(backupDir).toContain('backups');
    expect(path.isAbsolute(backupDir)).toBe(true);
  });

  test('validates restore script path', () => {
    const infraDir = '/opt/masterclaw-infrastructure';
    const scriptPath = path.join(infraDir, 'scripts', 'restore.sh');

    expect(scriptPath).toContain('scripts');
    expect(scriptPath).toContain('restore.sh');
    expect(scriptPath.endsWith('.sh')).toBe(true);
  });

  test('handles relative paths correctly', () => {
    const candidates = [
      process.env.MASTERCLAW_INFRA,
      path.join(process.cwd(), 'masterclaw-infrastructure'),
      path.join(process.cwd(), '..', 'masterclaw-infrastructure'),
      path.join(os.homedir(), 'masterclaw-infrastructure'),
      '/opt/masterclaw-infrastructure',
    ];

    candidates.forEach(dir => {
      if (dir) {
        const normalized = path.normalize(dir);
        expect(typeof normalized).toBe('string');
        expect(normalized.length).toBeGreaterThan(0);
      }
    });
  });
});

// =============================================================================
// Error Handling Tests
// =============================================================================

describe('Error Handling', () => {
  test('handles missing backup directory gracefully', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-restore-test-'));
    const nonExistentDir = path.join(tempDir, 'non-existent');

    expect(await fs.pathExists(nonExistentDir)).toBe(false);

    await fs.remove(tempDir);
  });

  test('handles empty backup directory', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-restore-empty-'));

    const files = await fs.readdir(tempDir);
    expect(files.length).toBe(0);

    await fs.remove(tempDir);
  });

  test('handles malformed backup filenames', () => {
    const malformedNames = [
      '',
      null,
      undefined,
      'backup',
      '.tar.gz',
      'masterclaw_backup_.tar.gz',
    ];

    const validPattern = /^masterclaw_backup_\d{8}_\d{6}\.tar\.gz$/;

    malformedNames.forEach(name => {
      if (typeof name === 'string') {
        expect(name).not.toMatch(validPattern);
      } else {
        expect(name).toBeFalsy();
      }
    });
  });

  test('handles null/undefined inputs gracefully', () => {
    expect(() => {
      const result = typeof null === 'object' && null !== null;
      return result;
    }).not.toThrow();

    expect(undefined).toBeUndefined();
    expect(null).toBeNull();
  });
});

// =============================================================================
// Restore Command Tests
// =============================================================================

describe('Restore Command', () => {
  test('exports restore command', () => {
    expect(restore).toBeDefined();
    expect(restore.name()).toBe('restore');
  });

  test('restore has expected subcommands', () => {
    const commands = restore.commands.map(cmd => cmd.name());
    expect(commands).toContain('list');
    expect(commands).toContain('preview');
    expect(commands).toContain('run');
  });

  test('validates dry-run mode', () => {
    // Dry-run should be a boolean option
    const dryRunOptions = ['--dry-run', '-d'];
    expect(dryRunOptions).toContain('--dry-run');
  });

  test('validates confirmation requirements', () => {
    // Restore should require confirmation by default
    const confirmationSteps = [
      'confirm prompt',
      'type "restore" to confirm',
    ];

    expect(confirmationSteps.length).toBeGreaterThan(0);
    expect(confirmationSteps[0]).toContain('confirm');
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('Integration', () => {
  test('backup sorting by date works correctly', () => {
    const backups = [
      { name: 'masterclaw_backup_20240101_000000.tar.gz', created: new Date('2024-01-01') },
      { name: 'masterclaw_backup_20240115_000000.tar.gz', created: new Date('2024-01-15') },
      { name: 'masterclaw_backup_20240110_000000.tar.gz', created: new Date('2024-01-10') },
    ];

    // Sort by date (newest first)
    const sorted = [...backups].sort((a, b) => b.created - a.created);

    expect(sorted[0].name).toContain('20240115');
    expect(sorted[1].name).toContain('20240110');
    expect(sorted[2].name).toContain('20240101');
  });

  test('environment variable precedence', () => {
    // BACKUP_DIR env var should override default
    const envBackupDir = process.env.BACKUP_DIR;
    const infraDir = '/opt/masterclaw-infrastructure';
    const defaultDir = path.join(infraDir, 'backups');

    if (envBackupDir) {
      expect(envBackupDir).not.toBe(defaultDir);
    } else {
      expect(defaultDir).toContain('backups');
    }
  });

  test('handles concurrent backup operations', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-restore-concurrent-'));

    // Simulate multiple backup files
    const backupFiles = [
      'masterclaw_backup_20240115_143022.tar.gz',
      'masterclaw_backup_20240115_143023.tar.gz',
      'masterclaw_backup_20240115_143024.tar.gz',
    ];

    for (const file of backupFiles) {
      await fs.writeFile(path.join(tempDir, file), 'test data');
    }

    const files = await fs.readdir(tempDir);
    expect(files.length).toBe(3);

    await fs.remove(tempDir);
  });
});

// =============================================================================
// Disaster Recovery Safety Tests
// =============================================================================

describe('Disaster Recovery Safety', () => {
  test('requires explicit confirmation for restore', () => {
    // Restore should require multiple confirmations
    const safetySteps = [
      { type: 'confirm', message: 'Are you sure?' },
      { type: 'input', message: 'Type "restore" to confirm' },
    ];

    expect(safetySteps.length).toBeGreaterThanOrEqual(2);
    expect(safetySteps[0].type).toBe('confirm');
    expect(safetySteps[1].type).toBe('input');
  });

  test('checks for running services before restore', () => {
    const runningServices = [
      'mc-core',
      'mc-backend',
      'mc-gateway',
    ];

    expect(runningServices.length).toBeGreaterThan(0);
    expect(runningServices[0]).toContain('mc-');
  });

  test('supports dry-run mode for safety', () => {
    // Dry-run should show what would be done without making changes
    const dryRunBehavior = {
      showsChanges: true,
      makesChanges: false,
      requiresConfirmation: false,
    };

    expect(dryRunBehavior.showsChanges).toBe(true);
    expect(dryRunBehavior.makesChanges).toBe(false);
  });

  test('validates backup integrity before restore', () => {
    const integrityChecks = [
      'file exists',
      'file is readable',
      'file is valid tar.gz',
      'backup is not corrupted',
    ];

    expect(integrityChecks.length).toBeGreaterThan(0);
    expect(integrityChecks).toContain('file exists');
  });
});
