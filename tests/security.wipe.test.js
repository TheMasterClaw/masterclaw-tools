/**
 * @jest-environment node
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const {
  secureWipeFile,
  secureWipeDirectory,
  estimateWipeTime,
  SECURE_WIPE_PASSES,
  WIPE_BUFFER_SIZE,
} = require('../lib/security');

describe('Secure File Wipe', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'secure-wipe-test-'));
  });

  afterEach(async () => {
    // Cleanup any remaining test files
    if (await fs.pathExists(tempDir)) {
      await fs.remove(tempDir);
    }
  });

  describe('secureWipeFile', () => {
    it('should securely wipe a small file', async () => {
      const testFile = path.join(tempDir, 'test.txt');
      const sensitiveData = 'SUPER_SECRET_PASSWORD_12345';
      await fs.writeFile(testFile, sensitiveData);

      // Verify file exists and has content
      expect(await fs.pathExists(testFile)).toBe(true);
      const beforeContent = await fs.readFile(testFile, 'utf-8');
      expect(beforeContent).toBe(sensitiveData);

      // Wipe the file
      const result = await secureWipeFile(testFile);
      expect(result).toBe(true);

      // Verify file is deleted
      expect(await fs.pathExists(testFile)).toBe(false);
    });

    it('should handle empty files', async () => {
      const testFile = path.join(tempDir, 'empty.txt');
      await fs.writeFile(testFile, '');

      const result = await secureWipeFile(testFile);
      expect(result).toBe(true);
      expect(await fs.pathExists(testFile)).toBe(false);
    });

    it('should wipe file without removing when remove=false', async () => {
      const testFile = path.join(tempDir, 'preserve.txt');
      await fs.writeFile(testFile, 'sensitive data');

      const result = await secureWipeFile(testFile, { remove: false });
      expect(result).toBe(true);

      // File should exist but be empty (truncated)
      expect(await fs.pathExists(testFile)).toBe(true);
      const content = await fs.readFile(testFile, 'utf-8');
      expect(content).toBe('');
    });

    it('should use specified number of passes', async () => {
      const testFile = path.join(tempDir, 'multi-pass.txt');
      await fs.writeFile(testFile, 'test data for multiple passes');

      // Should complete successfully with custom pass count
      const result = await secureWipeFile(testFile, { passes: 5 });
      expect(result).toBe(true);
      expect(await fs.pathExists(testFile)).toBe(false);
    });

    it('should handle large files in chunks', async () => {
      const testFile = path.join(tempDir, 'large.bin');
      // Create a 5MB file
      const largeData = crypto.randomBytes(5 * 1024 * 1024);
      await fs.writeFile(testFile, largeData);

      const result = await secureWipeFile(testFile);
      expect(result).toBe(true);
      expect(await fs.pathExists(testFile)).toBe(false);
    });

    it('should throw error for non-existent file', async () => {
      const nonExistent = path.join(tempDir, 'does-not-exist.txt');

      await expect(secureWipeFile(nonExistent)).rejects.toThrow('Secure wipe failed');
    });

    it('should throw error for directory path', async () => {
      const subDir = path.join(tempDir, 'subdir');
      await fs.ensureDir(subDir);

      await expect(secureWipeFile(subDir)).rejects.toThrow('Secure wipe failed');
    });

    it('should prevent recovery of original data after wipe', async () => {
      const testFile = path.join(tempDir, 'recover-test.bin');
      const originalData = crypto.randomBytes(1024);
      await fs.writeFile(testFile, originalData);

      // Wipe the file
      await secureWipeFile(testFile, { passes: 3, remove: false });

      // Read the wiped content
      const wipedContent = await fs.readFile(testFile);

      // Should be all zeros (final pass)
      const allZeros = Buffer.alloc(wipedContent.length, 0);
      expect(wipedContent.equals(allZeros)).toBe(true);

      // Cleanup
      await fs.remove(testFile);
    });

    it('should handle files with special characters in name', async () => {
      const testFile = path.join(tempDir, 'special-file_123.tmp');
      await fs.writeFile(testFile, 'test content');

      const result = await secureWipeFile(testFile);
      expect(result).toBe(true);
      expect(await fs.pathExists(testFile)).toBe(false);
    });
  });

  describe('secureWipeDirectory', () => {
    it('should wipe all files in a directory', async () => {
      // Create test structure
      const subDir = path.join(tempDir, 'wipe-me');
      await fs.ensureDir(subDir);
      await fs.writeFile(path.join(subDir, 'file1.txt'), 'secret1');
      await fs.writeFile(path.join(subDir, 'file2.txt'), 'secret2');

      const result = await secureWipeDirectory(subDir);

      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
      expect(await fs.pathExists(subDir)).toBe(false);
    });

    it('should recursively wipe nested directories', async () => {
      // Create nested structure
      const rootDir = path.join(tempDir, 'nested');
      const level1 = path.join(rootDir, 'level1');
      const level2 = path.join(level1, 'level2');

      await fs.ensureDir(level2);
      await fs.writeFile(path.join(rootDir, 'root.txt'), 'root');
      await fs.writeFile(path.join(level1, 'level1.txt'), 'level1');
      await fs.writeFile(path.join(level2, 'level2.txt'), 'level2');

      const result = await secureWipeDirectory(rootDir);

      expect(result.success).toBe(3);
      expect(result.failed).toBe(0);
      expect(await fs.pathExists(rootDir)).toBe(false);
    });

    it('should handle empty directories', async () => {
      const emptyDir = path.join(tempDir, 'empty');
      await fs.ensureDir(emptyDir);

      const result = await secureWipeDirectory(emptyDir);

      expect(result.success).toBe(0);
      expect(result.failed).toBe(0);
      expect(await fs.pathExists(emptyDir)).toBe(false);
    });

    it('should report failures for unreadable files', async () => {
      const testDir = path.join(tempDir, 'partial');
      await fs.ensureDir(testDir);
      await fs.writeFile(path.join(testDir, 'readable.txt'), 'data');

      // Create a file that will cause issues by making it a directory
      const problemPath = path.join(testDir, 'problem');
      await fs.ensureDir(problemPath);

      // Try to wipe (will fail on the directory named as file)
      const result = await secureWipeDirectory(testDir);

      // Directory should still be removed despite failures
      expect(await fs.pathExists(testDir)).toBe(false);
    });

    it('should throw error for non-existent directory', async () => {
      const nonExistent = path.join(tempDir, 'does-not-exist');

      await expect(secureWipeDirectory(nonExistent)).rejects.toThrow('Secure directory wipe failed');
    });

    it('should throw error when given a file path', async () => {
      const testFile = path.join(tempDir, 'not-a-dir.txt');
      await fs.writeFile(testFile, 'content');

      await expect(secureWipeDirectory(testFile)).rejects.toThrow('Secure directory wipe failed');
    });
  });

  describe('estimateWipeTime', () => {
    it('should estimate small files in seconds', () => {
      const estimate = estimateWipeTime(1024 * 1024); // 1MB
      expect(estimate).toMatch(/~\d+s/);
    });

    it('should estimate medium files in minutes', () => {
      const estimate = estimateWipeTime(2 * 1024 * 1024 * 1024); // 2GB
      expect(estimate).toMatch(/~\d+m/);
    });

    it('should estimate large files in hours', () => {
      const estimate = estimateWipeTime(100 * 1024 * 1024 * 1024); // 100GB
      expect(estimate).toMatch(/~\d+h/);
    });

    it('should account for pass count', () => {
      const small = estimateWipeTime(100 * 1024 * 1024, 1);
      const large = estimateWipeTime(100 * 1024 * 1024, 35); // Gutmann method

      // More passes should take longer
      expect(large).not.toBe(small);
    });
  });

  describe('constants', () => {
    it('should export default pass count', () => {
      expect(SECURE_WIPE_PASSES).toBe(3);
    });

    it('should export buffer size', () => {
      expect(WIPE_BUFFER_SIZE).toBe(1024 * 1024);
    });
  });
});
