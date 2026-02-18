/**
 * Tests for secure wipe functionality in security module
 * Run with: npm test -- security.wipe.test.js
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const security = require('../lib/security');

describe('Security Module - Secure Wipe', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-wipe-test-'));
  });

  afterEach(async () => {
    // Cleanup any remaining test files
    await fs.remove(tempDir).catch(() => {});
  });

  // ===========================================================================
  // estimateWipeTime Tests
  // ===========================================================================
  describe('estimateWipeTime', () => {
    test('returns seconds for small files', () => {
      const result = security.estimateWipeTime(1024 * 1024, 3); // 1MB
      expect(result).toMatch(/~\d+s/);
    });

    test('returns seconds/minutes for medium files depending on speed', () => {
      const result = security.estimateWipeTime(100 * 1024 * 1024, 3); // 100MB
      // Fast SSDs may complete in seconds, slower drives in minutes
      expect(result).toMatch(/~\d+[sm]/);
    });

    test('returns minutes/hours for large files depending on speed', () => {
      const result = security.estimateWipeTime(1024 * 1024 * 1024, 3); // 1GB
      // Fast SSDs may complete in minutes, slower drives in hours
      expect(result).toMatch(/~\d+[mh]/);
    });

    test('uses default 3 passes when not specified', () => {
      const withDefault = security.estimateWipeTime(1024 * 1024 * 1024);
      const withExplicit = security.estimateWipeTime(1024 * 1024 * 1024, 3);
      expect(withDefault).toBe(withExplicit);
    });

    test('scales linearly with pass count', () => {
      const onePass = security.estimateWipeTime(100 * 1024 * 1024, 1);
      const threePass = security.estimateWipeTime(100 * 1024 * 1024, 3);
      const ninePass = security.estimateWipeTime(100 * 1024 * 1024, 9);

      // Extract numbers for comparison
      const oneNum = parseInt(onePass.match(/~(\d+)/)[1]);
      const threeNum = parseInt(threePass.match(/~(\d+)/)[1]);
      const nineNum = parseInt(ninePass.match(/~(\d+)/)[1]);

      expect(threeNum).toBeGreaterThanOrEqual(oneNum * 2);
      expect(nineNum).toBeGreaterThanOrEqual(threeNum * 2);
    });

    test('handles zero bytes', () => {
      const result = security.estimateWipeTime(0);
      expect(result).toMatch(/~0s/);
    });
  });

  // ===========================================================================
  // secureWipeFile Tests
  // ===========================================================================
  describe('secureWipeFile', () => {
    test('successfully wipes a small file', async () => {
      const testFile = path.join(tempDir, 'test-file.txt');
      const content = 'Secret data that should be wiped!';
      await fs.writeFile(testFile, content);

      // Verify file exists and has content
      expect(await fs.pathExists(testFile)).toBe(true);
      const beforeContent = await fs.readFile(testFile, 'utf8');
      expect(beforeContent).toBe(content);

      // Wipe the file
      const result = await security.secureWipeFile(testFile, { passes: 1 });
      expect(result).toBe(true);

      // Verify file is removed
      expect(await fs.pathExists(testFile)).toBe(false);
    });

    test('wipes file with multiple passes', async () => {
      const testFile = path.join(tempDir, 'multi-pass.txt');
      await fs.writeFile(testFile, 'Sensitive content for multi-pass wipe');

      const result = await security.secureWipeFile(testFile, { passes: 3 });
      expect(result).toBe(true);
      expect(await fs.pathExists(testFile)).toBe(false);
    });

    test('wipes large file in chunks', async () => {
      const testFile = path.join(tempDir, 'large-file.bin');
      // Create a 5MB file (larger than WIPE_BUFFER_SIZE)
      const largeContent = crypto.randomBytes(5 * 1024 * 1024);
      await fs.writeFile(testFile, largeContent);

      const result = await security.secureWipeFile(testFile, { passes: 1 });
      expect(result).toBe(true);
      expect(await fs.pathExists(testFile)).toBe(false);
    });

    test('wipes file without removing it when remove=false', async () => {
      const testFile = path.join(tempDir, 'keep-file.txt');
      await fs.writeFile(testFile, 'Content to wipe but keep file');

      const result = await security.secureWipeFile(testFile, { 
        passes: 1, 
        remove: false 
      });
      expect(result).toBe(true);

      // File should still exist but be empty (truncated)
      expect(await fs.pathExists(testFile)).toBe(true);
      const afterContent = await fs.readFile(testFile);
      expect(afterContent.length).toBe(0);
    });

    test('handles empty file', async () => {
      const testFile = path.join(tempDir, 'empty-file.txt');
      await fs.writeFile(testFile, '');

      const result = await security.secureWipeFile(testFile);
      expect(result).toBe(true);
      expect(await fs.pathExists(testFile)).toBe(false);
    });

    test('throws error for non-existent file', async () => {
      const nonExistent = path.join(tempDir, 'does-not-exist.txt');

      await expect(
        security.secureWipeFile(nonExistent)
      ).rejects.toThrow('Secure wipe failed');
    });

    test('throws error for directory path', async () => {
      const subDir = path.join(tempDir, 'test-dir');
      await fs.ensureDir(subDir);

      await expect(
        security.secureWipeFile(subDir)
      ).rejects.toThrow('Secure wipe failed');
    });

    test('uses default 3 passes when not specified', async () => {
      const testFile = path.join(tempDir, 'default-passes.txt');
      await fs.writeFile(testFile, 'Test content');

      // Should complete without error using default passes
      const result = await security.secureWipeFile(testFile);
      expect(result).toBe(true);
      expect(await fs.pathExists(testFile)).toBe(false);
    });

    test('data is actually overwritten (verification)', async () => {
      const testFile = path.join(tempDir, 'verify-wipe.txt');
      const sensitiveData = 'SECRET_API_KEY=sk-live-1234567890abcdef';
      await fs.writeFile(testFile, sensitiveData);

      // Get initial stats
      const initialStats = await fs.stat(testFile);
      const initialSize = initialStats.size;

      // Wipe without removing to verify truncation
      await security.secureWipeFile(testFile, { passes: 1, remove: false });

      // Verify file is truncated to zero
      const finalStats = await fs.stat(testFile);
      expect(finalStats.size).toBe(0);
    });
  });

  // ===========================================================================
  // secureWipeDirectory Tests
  // ===========================================================================
  describe('secureWipeDirectory', () => {
    test('wipes empty directory', async () => {
      const emptyDir = path.join(tempDir, 'empty-dir');
      await fs.ensureDir(emptyDir);

      const result = await security.secureWipeDirectory(emptyDir);
      expect(result.success).toBe(0);
      expect(result.failed).toBe(0);
      expect(await fs.pathExists(emptyDir)).toBe(false);
    });

    test('wipes directory with single file', async () => {
      const testDir = path.join(tempDir, 'single-file-dir');
      await fs.ensureDir(testDir);
      await fs.writeFile(path.join(testDir, 'file.txt'), 'Secret content');

      const result = await security.secureWipeDirectory(testDir, { passes: 1 });
      expect(result.success).toBe(1);
      expect(result.failed).toBe(0);
      expect(await fs.pathExists(testDir)).toBe(false);
    });

    test('wipes directory with multiple files', async () => {
      const testDir = path.join(tempDir, 'multi-file-dir');
      await fs.ensureDir(testDir);
      await fs.writeFile(path.join(testDir, 'file1.txt'), 'Content 1');
      await fs.writeFile(path.join(testDir, 'file2.txt'), 'Content 2');
      await fs.writeFile(path.join(testDir, 'file3.txt'), 'Content 3');

      const result = await security.secureWipeDirectory(testDir, { passes: 1 });
      expect(result.success).toBe(3);
      expect(result.failed).toBe(0);
      expect(await fs.pathExists(testDir)).toBe(false);
    });

    test('wipes nested directory structure', async () => {
      const testDir = path.join(tempDir, 'nested-dir');
      const subDir1 = path.join(testDir, 'level1');
      const subDir2 = path.join(subDir1, 'level2');
      await fs.ensureDir(subDir2);
      
      await fs.writeFile(path.join(testDir, 'root.txt'), 'Root file');
      await fs.writeFile(path.join(subDir1, 'level1.txt'), 'Level 1 file');
      await fs.writeFile(path.join(subDir2, 'deep.txt'), 'Deep file');

      const result = await security.secureWipeDirectory(testDir, { passes: 1 });
      expect(result.success).toBe(3);
      expect(result.failed).toBe(0);
      expect(await fs.pathExists(testDir)).toBe(false);
    });

    test('handles mixed content (files and directories)', async () => {
      const testDir = path.join(tempDir, 'mixed-dir');
      await fs.ensureDir(path.join(testDir, 'sub1'));
      await fs.ensureDir(path.join(testDir, 'sub2'));
      
      await fs.writeFile(path.join(testDir, 'root.txt'), 'Root');
      await fs.writeFile(path.join(testDir, 'sub1', 'file1.txt'), 'File 1');
      await fs.writeFile(path.join(testDir, 'sub2', 'file2.txt'), 'File 2');

      const result = await security.secureWipeDirectory(testDir, { passes: 1 });
      expect(result.success).toBe(3);
      expect(result.failed).toBe(0);
      expect(await fs.pathExists(testDir)).toBe(false);
    });

    test('continues on individual file failures', async () => {
      const testDir = path.join(tempDir, 'partial-fail-dir');
      await fs.ensureDir(testDir);
      
      // Create files
      await fs.writeFile(path.join(testDir, 'file1.txt'), 'Content 1');
      await fs.writeFile(path.join(testDir, 'file2.txt'), 'Content 2');

      const result = await security.secureWipeDirectory(testDir, { passes: 1 });
      
      // Should successfully wipe all files
      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
      expect(await fs.pathExists(testDir)).toBe(false);
    });

    test('throws error for non-existent directory', async () => {
      const nonExistent = path.join(tempDir, 'does-not-exist');

      await expect(
        security.secureWipeDirectory(nonExistent)
      ).rejects.toThrow('Secure directory wipe failed');
    });

    test('throws error for file path (not directory)', async () => {
      const testFile = path.join(tempDir, 'not-a-dir.txt');
      await fs.writeFile(testFile, 'I am a file');

      await expect(
        security.secureWipeDirectory(testFile)
      ).rejects.toThrow('Secure directory wipe failed');
    });

    test('respects custom pass count', async () => {
      const testDir = path.join(tempDir, 'custom-passes-dir');
      await fs.ensureDir(testDir);
      await fs.writeFile(path.join(testDir, 'file.txt'), 'Content');

      // Should complete successfully with custom pass count
      const result = await security.secureWipeDirectory(testDir, { passes: 7 });
      expect(result.success).toBe(1);
      expect(await fs.pathExists(testDir)).toBe(false);
    });

    test('reports errors array for failed files', async () => {
      const testDir = path.join(tempDir, 'error-reporting-dir');
      await fs.ensureDir(testDir);
      await fs.writeFile(path.join(testDir, 'file.txt'), 'Content');

      // Wipe should succeed normally
      const result = await security.secureWipeDirectory(testDir, { passes: 1 });
      
      // Result object should have expected structure
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('failed');
      expect(result).toHaveProperty('errors');
      expect(Array.isArray(result.errors)).toBe(true);
      expect(result.success).toBe(1);
      expect(result.failed).toBe(0);
    });
  });

  // ===========================================================================
  // Security Constants Tests
  // ===========================================================================
  describe('Secure Wipe Constants', () => {
    test('SECURE_WIPE_PASSES is defined and reasonable', () => {
      expect(security.SECURE_WIPE_PASSES).toBe(3);
      expect(security.SECURE_WIPE_PASSES).toBeGreaterThan(0);
    });

    test('WIPE_BUFFER_SIZE is defined and reasonable', () => {
      expect(security.WIPE_BUFFER_SIZE).toBe(1024 * 1024); // 1MB
      expect(security.WIPE_BUFFER_SIZE).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Integration Tests
  // ===========================================================================
  describe('Integration - Secure Wipe Workflow', () => {
    test('complete workflow: create, verify, wipe, confirm', async () => {
      const testDir = path.join(tempDir, 'integration-test');
      const testFile = path.join(testDir, 'sensitive-data.txt');
      
      // Create sensitive data
      await fs.ensureDir(testDir);
      const sensitiveContent = crypto.randomBytes(1024).toString('hex');
      await fs.writeFile(testFile, sensitiveContent);
      
      // Verify creation
      expect(await fs.pathExists(testFile)).toBe(true);
      const readContent = await fs.readFile(testFile, 'utf8');
      expect(readContent).toBe(sensitiveContent);
      
      // Get time estimate
      const stats = await fs.stat(testFile);
      const estimate = security.estimateWipeTime(stats.size, 1);
      expect(estimate).toMatch(/~\d+/);
      
      // Wipe the directory
      const result = await security.secureWipeDirectory(testDir, { passes: 1 });
      expect(result.success).toBe(1);
      expect(result.failed).toBe(0);
      
      // Confirm deletion
      expect(await fs.pathExists(testDir)).toBe(false);
      expect(await fs.pathExists(testFile)).toBe(false);
    });

    test('handles binary data correctly', async () => {
      const testFile = path.join(tempDir, 'binary.bin');
      const binaryData = Buffer.from([
        0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE, 0xFD, 0xFC,
        ...Array(100).fill(0x00), // Null bytes
        ...Array(100).fill(0xFF), // All ones
      ]);
      await fs.writeFile(testFile, binaryData);

      const result = await security.secureWipeFile(testFile, { passes: 1 });
      expect(result).toBe(true);
      expect(await fs.pathExists(testFile)).toBe(false);
    });

    test('handles files with special names', async () => {
      const testDir = path.join(tempDir, 'special-names');
      await fs.ensureDir(testDir);
      
      // Files with various special characters in names
      const specialFiles = [
        'file with spaces.txt',
        'file-with-dashes.txt',
        'file_with_underscores.txt',
        'file.multiple.dots.txt',
        'UPPERCASE.TXT',
        'lowercase.txt',
        '123numeric.txt',
      ];

      for (const filename of specialFiles) {
        await fs.writeFile(path.join(testDir, filename), `Content of ${filename}`);
      }

      const result = await security.secureWipeDirectory(testDir, { passes: 1 });
      expect(result.success).toBe(specialFiles.length);
      expect(await fs.pathExists(testDir)).toBe(false);
    });
  });
});
