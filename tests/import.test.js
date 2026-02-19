/**
 * Tests for import.js module
 * Run with: npm test -- import.test.js
 *
 * Tests data import functionality with security validation.
 */

const {
  MAX_IMPORT_FILE_SIZE,
  MAX_IMPORT_ITEMS,
  ALLOWED_EXTENSIONS,
  validateImportFilePath,
} = require('../lib/import');

// =============================================================================
// Constants Tests
// =============================================================================

describe('Import Module', () => {
  describe('Constants', () => {
    test('MAX_IMPORT_FILE_SIZE is 10MB', () => {
      expect(MAX_IMPORT_FILE_SIZE).toBe(10 * 1024 * 1024);
    });

    test('MAX_IMPORT_ITEMS is 10000', () => {
      expect(MAX_IMPORT_ITEMS).toBe(10000);
    });

    test('ALLOWED_EXTENSIONS contains only .json', () => {
      expect(ALLOWED_EXTENSIONS.has('.json')).toBe(true);
      expect(ALLOWED_EXTENSIONS.size).toBe(1);
    });
  });

  // ===========================================================================
  // validateImportFilePath Tests
  // ===========================================================================
  describe('validateImportFilePath', () => {
    test('accepts valid JSON file paths', () => {
      const result = validateImportFilePath('config.json');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    test('accepts paths with directories', () => {
      const result = validateImportFilePath('./data/config.json');
      expect(result.valid).toBe(true);
    });

    test('rejects non-string paths', () => {
      const result = validateImportFilePath(123);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('must be a string');
    });

    test('rejects empty paths', () => {
      const result = validateImportFilePath('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cannot be empty');
    });

    test('rejects paths that are too long', () => {
      const longPath = 'a'.repeat(4097);
      const result = validateImportFilePath(longPath);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too long');
    });

    test('rejects path traversal attempts', () => {
      const result = validateImportFilePath('../etc/passwd.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Path traversal');
    });

    test('rejects null bytes', () => {
      const result = validateImportFilePath('file\0.json');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Path traversal');
    });

    test('rejects invalid extensions', () => {
      const result = validateImportFilePath('config.xml');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid file extension');
    });

    test('rejects no extension', () => {
      const result = validateImportFilePath('config');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid file extension');
    });
  });
});
