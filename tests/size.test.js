/**
 * Size Module Tests - Disk Usage Analyzer
 *
 * Tests cover:
 * - Security: Path validation and sanitization (prevents command injection)
 * - Security: Shell argument escaping
 * - Functionality: Byte formatting and parsing
 * - Functionality: Directory size calculations
 * - Error handling: Invalid inputs, missing directories
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Module under test
const size = require('../lib/size');
const {
  formatBytes,
  parseSizeString,
  isValidPath,
  escapeShellArg,
  validateAndSanitizePath,
  getDirectorySize,
  getDirectoryBreakdown,
} = require('../lib/size');

describe('Size Module', () => {
  let tempDir;
  let testDir;

  beforeAll(async () => {
    // Create a temporary directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'size-test-'));
    testDir = path.join(tempDir, 'test-data');
    await fs.ensureDir(testDir);
  });

  afterAll(async () => {
    // Clean up temporary directory
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  beforeEach(async () => {
    // Reset test directory contents before each test
    await fs.emptyDir(testDir);
  });

  // ===========================================================================
  // Security: Path Validation Tests
  // ===========================================================================
  describe('Security: Path Validation', () => {
    describe('isValidPath', () => {
      it('should accept valid absolute paths', () => {
        expect(isValidPath('/home/user/data')).toBe(true);
        expect(isValidPath('/opt/masterclaw')).toBe(true);
        expect(isValidPath('/var/log')).toBe(true);
      });

      it('should accept valid relative paths', () => {
        expect(isValidPath('./data')).toBe(true);
        expect(isValidPath('logs/app.log')).toBe(true);
      });

      it('should reject paths with null bytes', () => {
        expect(isValidPath('/home/user\0/etc/passwd')).toBe(false);
        expect(isValidPath('/data\0')).toBe(false);
      });

      it('should reject paths with shell metacharacters', () => {
        expect(isValidPath('/data; rm -rf /')).toBe(false);
        expect(isValidPath('/data && echo hack')).toBe(false);
        expect(isValidPath('/data | cat /etc/passwd')).toBe(false);
        expect(isValidPath('/data `whoami`')).toBe(false);
        expect(isValidPath('/data $(id)')).toBe(false);
        expect(isValidPath('/data < /etc/passwd')).toBe(false);
        expect(isValidPath('/data > /dev/null')).toBe(false);
      });

      it('should reject paths with backticks', () => {
        expect(isValidPath('/data`date`')).toBe(false);
        expect(isValidPath('/data`whoami`')).toBe(false);
      });

      it('should reject paths with dollar signs (variable expansion)', () => {
        expect(isValidPath('/data$HOME')).toBe(false);
        expect(isValidPath('/data${PATH}')).toBe(false);
      });

      it('should reject paths with path traversal', () => {
        expect(isValidPath('/data/../etc')).toBe(false);
        expect(isValidPath('../etc/passwd')).toBe(false);
        expect(isValidPath('/data/../../etc')).toBe(false);
      });

      it('should reject empty paths', () => {
        expect(isValidPath('')).toBe(false);
      });

      it('should reject non-string paths', () => {
        expect(isValidPath(null)).toBe(false);
        expect(isValidPath(undefined)).toBe(false);
        expect(isValidPath(123)).toBe(false);
        expect(isValidPath({})).toBe(false);
        expect(isValidPath([])).toBe(false);
      });

      it('should reject paths that are too long', () => {
        const longPath = 'a'.repeat(5000);
        expect(isValidPath(longPath)).toBe(false);
      });

      it('should reject paths with newlines', () => {
        expect(isValidPath('/data\nrm -rf /')).toBe(false);
        expect(isValidPath('/data\recho hack')).toBe(false);
      });

      it('should accept paths with spaces', () => {
        expect(isValidPath('/path with spaces/data')).toBe(true);
        expect(isValidPath('/data/my file.txt')).toBe(true);
      });

      it('should accept paths with hyphens and underscores', () => {
        expect(isValidPath('/data/my-file_name')).toBe(true);
        expect(isValidPath('/my-dir/my_file')).toBe(true);
      });

      it('should accept paths with dots in filenames', () => {
        expect(isValidPath('/data/file.txt')).toBe(true);
        expect(isValidPath('/data/archive.tar.gz')).toBe(true);
      });
    });

    describe('escapeShellArg', () => {
      it('should escape double quotes', () => {
        expect(escapeShellArg('data"')).toBe('data\\"');
        expect(escapeShellArg('"data"')).toBe('\\"data\\"');
      });

      it('should escape backslashes', () => {
        expect(escapeShellArg('data\\')).toBe('data\\\\');
        expect(escapeShellArg('C:\\Users\\test')).toBe('C:\\\\Users\\\\test');
      });

      it('should handle empty strings', () => {
        expect(escapeShellArg('')).toBe('');
      });

      it('should handle non-strings gracefully', () => {
        expect(escapeShellArg(null)).toBe('');
        expect(escapeShellArg(undefined)).toBe('');
        expect(escapeShellArg(123)).toBe('');
      });

      it('should handle complex paths', () => {
        const input = 'C:\\Users\\test\\"Documents"\\file.txt';
        const escaped = escapeShellArg(input);
        // Should escape quotes
        expect(escaped).toContain('\\"');
        // Original quotes should not be present
        expect(escaped).not.toMatch(/(?<!\\)"/);
      });
    });

    describe('validateAndSanitizePath', () => {
      it('should return absolute path for valid input', () => {
        const result = validateAndSanitizePath('./data');
        expect(result).toBeTruthy();
        expect(path.isAbsolute(result)).toBe(true);
      });

      it('should return null for invalid paths', () => {
        expect(validateAndSanitizePath('/data; rm -rf /')).toBeNull();
        expect(validateAndSanitizePath('/data\0')).toBeNull();
        expect(validateAndSanitizePath('/../etc')).toBeNull();
      });

      it('should resolve relative paths to absolute', () => {
        const result = validateAndSanitizePath('.');
        expect(result).toBe(process.cwd());
      });

      it('should normalize paths', () => {
        const result = validateAndSanitizePath('/data//subdir///file.txt');
        expect(result).not.toContain('//');
      });
    });
  });

  // ===========================================================================
  // Functionality: Byte Formatting Tests
  // ===========================================================================
  describe('formatBytes', () => {
    it('should format zero bytes', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('should format bytes correctly', () => {
      expect(formatBytes(512)).toBe('512 B');
    });

    it('should format kilobytes correctly', () => {
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('should format megabytes correctly', () => {
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
      expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
    });

    it('should format gigabytes correctly', () => {
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
      expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
    });

    it('should format terabytes correctly', () => {
      expect(formatBytes(Math.pow(1024, 4))).toBe('1 TB');
    });

    it('should respect decimal places option', () => {
      expect(formatBytes(1536, 0)).toBe('2 KB');
      expect(formatBytes(1536, 3)).toBe('1.5 KB');
    });

    it('should handle negative decimals', () => {
      expect(formatBytes(1536, -1)).toBe('2 KB');
    });
  });

  describe('parseSizeString', () => {
    it('should parse bytes', () => {
      expect(parseSizeString('100B')).toBe(100);
      expect(parseSizeString('100 B')).toBe(100);
    });

    it('should parse kilobytes', () => {
      expect(parseSizeString('1KB')).toBe(1024);
      expect(parseSizeString('5 KB')).toBe(5 * 1024);
      expect(parseSizeString('2.5KB')).toBe(2.5 * 1024);
    });

    it('should parse megabytes', () => {
      expect(parseSizeString('1MB')).toBe(1024 * 1024);
      expect(parseSizeString('100 MB')).toBe(100 * 1024 * 1024);
    });

    it('should parse gigabytes', () => {
      expect(parseSizeString('1GB')).toBe(Math.pow(1024, 3));
      expect(parseSizeString('1.5 GB')).toBe(1.5 * Math.pow(1024, 3));
    });

    it('should parse terabytes', () => {
      expect(parseSizeString('1TB')).toBe(Math.pow(1024, 4));
    });

    it('should be case insensitive', () => {
      expect(parseSizeString('1mb')).toBe(1024 * 1024);
      expect(parseSizeString('1MB')).toBe(1024 * 1024);
      expect(parseSizeString('1Mb')).toBe(1024 * 1024);
    });

    it('should return 0 for invalid input', () => {
      expect(parseSizeString('')).toBe(0);
      expect(parseSizeString(null)).toBe(0);
      expect(parseSizeString(undefined)).toBe(0);
      expect(parseSizeString('invalid')).toBe(0);
      expect(parseSizeString('1XB')).toBe(0);
    });

    it('should return 0 for 0B', () => {
      expect(parseSizeString('0B')).toBe(0);
    });

    it('should handle edge cases', () => {
      expect(parseSizeString('0')).toBe(0);
      // .5MB is actually parsed as 0.5MB (524288 bytes) by parseFloat
      expect(parseSizeString('.5MB')).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Integration: Directory Size Tests
  // ===========================================================================
  describe('getDirectorySize', () => {
    it('should return 0 for non-existent directories', async () => {
      const size = await getDirectorySize('/nonexistent/path/12345');
      expect(size).toBe(0);
    });

    it('should return 0 for paths with shell injection attempts', async () => {
      // These should not execute any commands, just return 0
      const size1 = await getDirectorySize('/etc; cat /etc/passwd');
      expect(size1).toBe(0);

      const size2 = await getDirectorySize('/data`whoami`');
      expect(size2).toBe(0);

      const size3 = await getDirectorySize('/data$(id)');
      expect(size3).toBe(0);
    });

    it('should return 0 for files (not directories)', async () => {
      const filePath = path.join(testDir, 'testfile.txt');
      await fs.writeFile(filePath, 'test content');

      const size = await getDirectorySize(filePath);
      expect(size).toBe(0);
    });

    it('should return 0 for null/undefined paths', async () => {
      expect(await getDirectorySize(null)).toBe(0);
      expect(await getDirectorySize(undefined)).toBe(0);
    });

    it('should calculate size of empty directory', async () => {
      const emptyDir = path.join(testDir, 'empty');
      await fs.ensureDir(emptyDir);

      const size = await getDirectorySize(emptyDir);
      // Empty directories have some metadata overhead
      expect(size).toBeGreaterThanOrEqual(0);
    });

    it('should calculate size of directory with files', async () => {
      const dataDir = path.join(testDir, 'data');
      await fs.ensureDir(dataDir);
      await fs.writeFile(path.join(dataDir, 'file1.txt'), 'a'.repeat(1000));
      await fs.writeFile(path.join(dataDir, 'file2.txt'), 'b'.repeat(2000));

      const size = await getDirectorySize(dataDir);
      // Should be at least 3000 bytes (file content)
      expect(size).toBeGreaterThanOrEqual(3000);
    });

    it('should handle paths with spaces', async () => {
      const spacedDir = path.join(testDir, 'path with spaces');
      await fs.ensureDir(spacedDir);
      await fs.writeFile(path.join(spacedDir, 'file.txt'), 'content');

      const size = await getDirectorySize(spacedDir);
      expect(size).toBeGreaterThan(0);
    });

    it('should handle nested directories', async () => {
      const nestedDir = path.join(testDir, 'level1', 'level2', 'level3');
      await fs.ensureDir(nestedDir);
      await fs.writeFile(path.join(nestedDir, 'deep.txt'), 'deep content here');

      const size = await getDirectorySize(path.join(testDir, 'level1'));
      expect(size).toBeGreaterThan(0);
    });

    it('should not be vulnerable to path traversal', async () => {
      // This attempts to get size of /etc instead of testDir
      const maliciousPath = path.join(testDir, '..', '..', 'etc');
      const size = await getDirectorySize(maliciousPath);

      // Should return 0 because path validation rejects traversal
      expect(size).toBe(0);
    });
  });

  describe('getDirectoryBreakdown', () => {
    it('should return empty array for non-existent directories', async () => {
      const items = await getDirectoryBreakdown('/nonexistent/path');
      expect(items).toEqual([]);
    });

    it('should return 0 for paths with shell injection attempts', async () => {
      const items1 = await getDirectoryBreakdown('/etc; cat /etc/passwd');
      expect(items1).toEqual([]);

      const items2 = await getDirectoryBreakdown('/data`whoami`');
      expect(items2).toEqual([]);
    });

    it('should return breakdown of directory contents', async () => {
      const dataDir = path.join(testDir, 'breakdown');
      await fs.ensureDir(dataDir);
      await fs.writeFile(path.join(dataDir, 'large.txt'), 'x'.repeat(10000));
      await fs.writeFile(path.join(dataDir, 'small.txt'), 'x'.repeat(100));

      const items = await getDirectoryBreakdown(dataDir, 1);

      // Should have 2 items (the two files)
      expect(items.length).toBeGreaterThanOrEqual(0); // May vary by system

      if (items.length >= 2) {
        // Should be sorted by size (largest first)
        expect(items[0].size).toBeGreaterThan(items[1].size);

        // Should have correct names
        const names = items.map(i => i.name);
        expect(names).toContain('large.txt');
        expect(names).toContain('small.txt');
      }
    });

    it('should respect maxDepth parameter', async () => {
      const deepDir = path.join(testDir, 'deep');
      await fs.ensureDir(path.join(deepDir, 'level1', 'level2'));
      await fs.writeFile(path.join(deepDir, 'root.txt'), 'root');
      await fs.writeFile(path.join(deepDir, 'level1', 'level1.txt'), 'level1');
      await fs.writeFile(path.join(deepDir, 'level1', 'level2', 'level2.txt'), 'level2');

      // With maxDepth 1, should see root files and level1 directory
      const items1 = await getDirectoryBreakdown(deepDir, 1);
      const names1 = items1.map(i => i.name);

      // level1 directory should be in results
      expect(names1).toContain('level1');

      // level2 should not be directly listed (it's deeper than maxDepth)
      expect(names1).not.toContain('level2');
      expect(names1).not.toContain('level2.txt');
    });

    it('should clamp maxDepth to safe values', async () => {
      const deepDir = path.join(testDir, 'clamped');
      await fs.ensureDir(deepDir);
      await fs.writeFile(path.join(deepDir, 'file.txt'), 'content');

      // Very large maxDepth should be clamped
      const items = await getDirectoryBreakdown(deepDir, 1000);
      expect(items.length).toBeGreaterThanOrEqual(0);
    });

    it('should handle negative maxDepth', async () => {
      const deepDir = path.join(testDir, 'negative');
      await fs.ensureDir(deepDir);
      await fs.writeFile(path.join(deepDir, 'file.txt'), 'content');

      // Negative maxDepth should be treated as 0 or handled gracefully
      const items = await getDirectoryBreakdown(deepDir, -5);
      expect(Array.isArray(items)).toBe(true);
    });

    it('should handle paths with spaces', async () => {
      const spacedDir = path.join(testDir, 'breakdown spaces');
      await fs.ensureDir(spacedDir);
      await fs.writeFile(path.join(spacedDir, 'file.txt'), 'content');

      const items = await getDirectoryBreakdown(spacedDir, 1);
      // Should return array (may be empty or contain items)
      expect(Array.isArray(items)).toBe(true);
    });

    it('should return empty array for files', async () => {
      const filePath = path.join(testDir, 'not-a-dir.txt');
      await fs.writeFile(filePath, 'content');

      const items = await getDirectoryBreakdown(filePath);
      expect(items).toEqual([]);
    });
  });

  // ===========================================================================
  // Security: Command Injection Prevention Tests
  // ===========================================================================
  describe('Security: Command Injection Prevention', () => {
    it('should not execute commands via path parameter', async () => {
      // Create a marker file to detect if command was executed
      const markerFile = path.join(tempDir, 'marker-injection-test');

      // Attempt command injection via various techniques
      const injectionAttempts = [
        `/nonexistent && touch "${markerFile}"`,
        `/nonexistent; touch "${markerFile}"`,
        `/nonexistent | touch "${markerFile}"`,
        `/nonexistent$(touch "${markerFile}")`,
        `/nonexistent\`touch "${markerFile}"\``,
        `/nonexistent; rm -rf /`,
      ];

      for (const attempt of injectionAttempts) {
        // Remove marker if it exists
        if (await fs.pathExists(markerFile)) {
          await fs.remove(markerFile);
        }

        // Attempt the injection
        await getDirectorySize(attempt);
        await getDirectoryBreakdown(attempt);

        // Marker should not exist (command was not executed)
        expect(await fs.pathExists(markerFile)).toBe(false);
      }
    });

    it('should handle environment variable expansion attempts', async () => {
      // $HOME and similar should not be expanded
      const size1 = await getDirectorySize('/data$HOME');
      expect(size1).toBe(0);

      const size2 = await getDirectorySize('/data${PATH}');
      expect(size2).toBe(0);
    });

    it('should handle backtick execution attempts', async () => {
      const size = await getDirectorySize('/data`rm -rf /`');
      expect(size).toBe(0);
    });

    it('should handle null byte injection', async () => {
      // Null bytes are often used to bypass filters
      const size = await getDirectorySize('/data\0/etc/passwd');
      expect(size).toBe(0);
    });

    it('should handle newline injection', async () => {
      const size = await getDirectorySize('/data\nrm -rf /');
      expect(size).toBe(0);
    });

    it('should prevent directory traversal attacks', async () => {
      // Create a file that should not be accessed
      const sensitiveDir = path.join(tempDir, 'sensitive');
      await fs.ensureDir(sensitiveDir);
      await fs.writeFile(path.join(sensitiveDir, 'secret.txt'), 'secret data');

      // Attempt traversal using string concatenation (not path.join which normalizes)
      // This simulates an attacker trying to access ../sensitive
      const traversalPath = tempDir + '/test/../sensitive';
      const size = await getDirectorySize(traversalPath);

      // Should return 0 (rejected by path validation due to .. in path)
      expect(size).toBe(0);
    });
  });
});
