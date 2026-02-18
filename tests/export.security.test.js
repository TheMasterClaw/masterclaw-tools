/**
 * export.security.test.js - Security tests for export functionality
 *
 * Tests path traversal protection and data size validation
 * to prevent security vulnerabilities in export operations.
 */

const {
  validateExportFilePath,
  validateExportDataSize,
  MAX_EXPORT_FILE_SIZE,
  ALLOWED_EXTENSIONS,
} = require('../lib/export');

describe('Export Security', () => {
  describe('validateExportFilePath', () => {
    it('should accept valid file paths', () => {
      const validPaths = [
        'export.json',
        './export.json',
        './backups/export.json',
        'data/export.json',
        '/home/user/export.json',
        'export-file.json',
        'export_file.json',
        'export123.json',
      ];

      for (const filePath of validPaths) {
        const result = validateExportFilePath(filePath);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      }
    });

    it('should reject path traversal attempts with ../', () => {
      const traversalPaths = [
        '../etc/passwd.json',
        '../../etc/passwd.json',
        '../../../etc/passwd.json',
        'data/../../etc/passwd.json',
        './../etc/passwd.json',
      ];

      for (const filePath of traversalPaths) {
        const result = validateExportFilePath(filePath);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Path traversal detected');
      }
    });

    it('should reject path traversal attempts with ..\\', () => {
      const traversalPaths = [
        '..\\etc\\passwd.json',
        'data\\..\\..\\etc\\passwd.json',
      ];

      for (const filePath of traversalPaths) {
        const result = validateExportFilePath(filePath);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Path traversal detected');
      }
    });

    it('should reject paths starting with ..', () => {
      const result = validateExportFilePath('../sensitive.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Path traversal detected');
    });

    it('should reject non-string paths', () => {
      const invalidPaths = [
        null,
        undefined,
        123,
        {},
        [],
        true,
      ];

      for (const filePath of invalidPaths) {
        const result = validateExportFilePath(filePath);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('must be a string');
      }
    });

    it('should reject empty paths', () => {
      const result = validateExportFilePath('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cannot be empty');
    });

    it('should reject paths exceeding maximum length', () => {
      const longPath = 'a'.repeat(4097) + '.json';
      const result = validateExportFilePath(longPath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too long');
    });

    it('should reject paths with null bytes', () => {
      const result = validateExportFilePath('export\0.json');
      expect(result.valid).toBe(false);
      // Null bytes may be caught by path traversal check or null byte check
      expect(result.error).toMatch(/Null bytes not allowed|Path traversal detected/);
    });

    it('should reject non-JSON file extensions', () => {
      const invalidExtensions = [
        'export.txt',
        'export.csv',
        'export.xml',
        'export.html',
        'export.js',
        'export.sh',
        'export.exe',
        'export',
        'export.',
      ];

      for (const filePath of invalidExtensions) {
        const result = validateExportFilePath(filePath);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid file extension');
      }
    });

    it('should accept only .json extensions', () => {
      const result = validateExportFilePath('export.JSON');
      // Note: extension check is case-insensitive
      expect(result.valid).toBe(true);
    });

    it('should handle complex but valid paths', () => {
      const complexPaths = [
        './data/backups/2024/masterclaw-export.json',
        '/var/lib/masterclaw/exports/backup.json',
        'exports/weekly/backup-file_v1.2.3.json',
      ];

      for (const filePath of complexPaths) {
        const result = validateExportFilePath(filePath);
        expect(result.valid).toBe(true);
      }
    });
  });

  describe('validateExportDataSize', () => {
    it('should accept data within size limits', () => {
      const smallData = { key: 'value', count: 42 };
      const result = validateExportDataSize(smallData);
      expect(result.valid).toBe(true);
      expect(result.size).toBeGreaterThan(0);
    });

    it('should calculate correct size for data', () => {
      const data = { test: 'data' };
      const result = validateExportDataSize(data);
      const expectedSize = JSON.stringify(data).length;
      expect(result.size).toBe(expectedSize);
    });

    it('should reject data exceeding maximum size', () => {
      // Create data that exceeds MAX_EXPORT_FILE_SIZE
      const largeData = {
        content: 'x'.repeat(MAX_EXPORT_FILE_SIZE + 1000),
      };

      const result = validateExportDataSize(largeData);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too large');
    });

    it('should handle circular references gracefully', () => {
      const data = { name: 'test' };
      data.self = data; // Create circular reference

      // This should not throw, but may return an error
      const result = validateExportDataSize(data);
      // The function should handle this gracefully
      expect(result).toBeDefined();
    });

    it('should handle various data types', () => {
      const dataTypes = [
        { array: [1, 2, 3, 4, 5] },
        { nested: { deep: { data: { here: 'value' } } } },
        { text: 'Hello World'.repeat(100) },
        { number: 12345, bool: true, null: null },
      ];

      for (const data of dataTypes) {
        const result = validateExportDataSize(data);
        expect(result.valid).toBe(true);
        expect(result.size).toBeGreaterThan(0);
      }
    });
  });

  describe('Security Constants', () => {
    it('should have reasonable maximum file size', () => {
      // 100MB is a reasonable limit for JSON exports
      expect(MAX_EXPORT_FILE_SIZE).toBe(100 * 1024 * 1024);
    });

    it('should only allow JSON extensions', () => {
      expect(ALLOWED_EXTENSIONS.has('.json')).toBe(true);
      expect(ALLOWED_EXTENSIONS.size).toBe(1);
    });
  });

  describe('Real-world attack scenarios', () => {
    it('should prevent writing to /etc/passwd', () => {
      const result = validateExportFilePath('../../../etc/passwd.json');
      expect(result.valid).toBe(false);
    });

    it('should prevent writing to Windows system files', () => {
      const result = validateExportFilePath('..\\..\\Windows\\System32\\config.json');
      expect(result.valid).toBe(false);
    });

    it('should prevent writing to SSH keys', () => {
      const result = validateExportFilePath('../../../.ssh/id_rsa.json');
      expect(result.valid).toBe(false);
    });

    it('should prevent arbitrary code execution via shell files', () => {
      const result = validateExportFilePath('../../../tmp/malicious.sh');
      expect(result.valid).toBe(false);
      // Path traversal is detected before extension check
      expect(result.error).toMatch(/Path traversal detected|Invalid file extension/);
    });

    it('should prevent writing outside export directory with encoded traversal', () => {
      // Some systems may decode %2e%2e%2f as ../
      // Our validation should catch the raw pattern
      const result = validateExportFilePath('..%2f..%2fetc%2fpasswd.json');
      // This should fail either due to traversal detection or invalid extension
      expect(result.valid).toBe(false);
    });
  });
});
