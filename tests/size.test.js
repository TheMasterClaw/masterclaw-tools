/**
 * Tests for the size module
 */

const size = require('../lib/size');
const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

// Mock child_process
jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

// Mock fs-extra
jest.mock('fs-extra', () => ({
  pathExists: jest.fn(),
}));

describe('size module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(size.formatBytes(0)).toBe('0 B');
      expect(size.formatBytes(1024)).toBe('1 KB');
      expect(size.formatBytes(1024 * 1024)).toBe('1 MB');
      expect(size.formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    });

    it('should handle custom decimals', () => {
      expect(size.formatBytes(1536, 1)).toBe('1.5 KB');
      expect(size.formatBytes(1536, 0)).toBe('2 KB');
    });
  });

  describe('parseSizeString', () => {
    it('should parse size strings correctly', () => {
      expect(size.parseSizeString('0B')).toBe(0);
      expect(size.parseSizeString('1KB')).toBe(1024);
      expect(size.parseSizeString('1.5MB')).toBe(1.5 * 1024 * 1024);
      expect(size.parseSizeString('2GB')).toBe(2 * 1024 * 1024 * 1024);
    });

    it('should handle spaces in size strings', () => {
      expect(size.parseSizeString('1 KB')).toBe(1024);
      expect(size.parseSizeString('1.5 MB')).toBe(1.5 * 1024 * 1024);
    });

    it('should return 0 for invalid strings', () => {
      expect(size.parseSizeString('')).toBe(0);
      expect(size.parseSizeString('invalid')).toBe(0);
      expect(size.parseSizeString(null)).toBe(0);
    });
  });

  describe('getDirectorySize', () => {
    it('should return 0 for non-existent directories', async () => {
      fs.pathExists.mockResolvedValue(false);
      const result = await size.getDirectorySize('/nonexistent');
      expect(result).toBe(0);
    });

    it('should parse du output correctly', async () => {
      fs.pathExists.mockResolvedValue(true);
      execSync.mockReturnValue('1024 /path/to/dir');
      
      const result = await size.getDirectorySize('/path/to/dir');
      expect(result).toBe(1024 * 1024); // Converted from KB to bytes
    });

    it('should handle errors gracefully', async () => {
      fs.pathExists.mockResolvedValue(true);
      execSync.mockImplementation(() => {
        throw new Error('du failed');
      });
      
      const result = await size.getDirectorySize('/path/to/dir');
      expect(result).toBe(0);
    });
  });
});
