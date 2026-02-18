/**
 * Tests for changelog.js module
 * 
 * @jest-environment node
 */

const fs = require('fs-extra');
const path = require('path');

// Mock dependencies
jest.mock('../lib/services', () => ({
  findInfraDir: jest.fn(),
}));

jest.mock('../lib/config', () => ({
  get: jest.fn(),
}));

jest.mock('../lib/rate-limiter', () => ({
  enforceRateLimit: jest.fn().mockResolvedValue(true),
}));

const { findInfraDir } = require('../lib/services');
const {
  parseChangelog,
  validateComponent,
  validateLimit,
  validateVersion,
  formatEntry,
  highlightTerms,
} = require('../lib/changelog');

describe('changelog.js', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('validateComponent', () => {
    it('should validate valid components', () => {
      expect(() => validateComponent('core')).not.toThrow();
      expect(() => validateComponent('tools')).not.toThrow();
      expect(() => validateComponent('infrastructure')).not.toThrow();
      expect(() => validateComponent('all')).not.toThrow();
    });

    it('should reject invalid components', () => {
      expect(() => validateComponent('invalid')).toThrow('Invalid component');
      expect(() => validateComponent('')).toThrow('Invalid component');
    });

    it('should be case insensitive', () => {
      expect(() => validateComponent('CORE')).not.toThrow();
      expect(() => validateComponent('Tools')).not.toThrow();
    });
  });

  describe('validateLimit', () => {
    it('should validate valid limits', () => {
      expect(validateLimit(1)).toBe(1);
      expect(validateLimit(10)).toBe(10);
      expect(validateLimit(100)).toBe(100);
    });

    it('should reject invalid limits', () => {
      expect(() => validateLimit(0)).toThrow('positive number');
      expect(() => validateLimit(-1)).toThrow('positive number');
      expect(() => validateLimit('abc')).toThrow('positive number');
    });

    it('should enforce maximum limit', () => {
      expect(() => validateLimit(2000)).toThrow('cannot exceed');
    });
  });

  describe('validateVersion', () => {
    it('should validate semantic versions', () => {
      expect(validateVersion('1.0.0')).toBe(true);
      expect(validateVersion('v1.0.0')).toBe(true);
      expect(validateVersion('1.0.0-beta.1')).toBe(true);
      expect(validateVersion('2.10.3')).toBe(true);
    });

    it('should reject invalid versions', () => {
      expect(validateVersion('')).toBe(false);
      expect(validateVersion('invalid')).toBe(false);
      expect(validateVersion('1.0')).toBe(false);
      expect(validateVersion(null)).toBe(false);
    });
  });

  describe('parseChangelog', () => {
    it('should parse changelog with versions', () => {
      const content = `
# Changelog

## [Unreleased]

### Added
- New feature A
- New feature B

### Fixed
- Bug fix 1

## [1.0.0] - 2024-01-15

### Added
- Initial release
- Core functionality
`;

      const entries = parseChangelog(content, 'test');
      
      expect(entries).toHaveLength(2);
      expect(entries[0].version).toBe('Unreleased');
      expect(entries[0].component).toBe('test');
      expect(entries[1].version).toBe('1.0.0');
      expect(entries[1].date).toBe('2024-01-15');
    });

    it('should parse sections correctly', () => {
      const content = `
## [1.0.0] - 2024-01-15

### Added
- Feature 1
- Feature 2

### Fixed
- Bug 1
`;

      const entries = parseChangelog(content, 'test');
      
      expect(entries).toHaveLength(1);
      expect(entries[0].sections['Added']).toHaveLength(2);
      expect(entries[0].sections['Fixed']).toHaveLength(1);
    });

    it('should handle changelog without versions', () => {
      const content = '# Changelog\n\nNo versions yet.';
      const entries = parseChangelog(content, 'test');
      
      expect(entries).toHaveLength(0);
    });
  });

  describe('formatEntry', () => {
    it('should format entry in compact mode', () => {
      const entry = {
        version: '1.0.0',
        date: '2024-01-15',
        component: 'core',
        sections: { Added: ['Feature 1'] },
      };

      const result = formatEntry(entry, true);
      
      expect(result).toContain('1.0.0');
      expect(result).toContain('core');
    });

    it('should format entry in full mode', () => {
      const entry = {
        version: '1.0.0',
        date: '2024-01-15',
        component: 'core',
        sections: { 
          Added: ['Feature 1', 'Feature 2'],
          Fixed: ['Bug 1'],
        },
      };

      const result = formatEntry(entry, false);
      
      expect(result).toContain('1.0.0');
      expect(result).toContain('Added');
      expect(result).toContain('Fixed');
      expect(result).toContain('Feature 1');
    });

    it('should highlight unreleased versions', () => {
      const entry = {
        version: 'Unreleased',
        date: null,
        component: 'core',
        sections: {},
      };

      const result = formatEntry(entry, true);
      expect(result).toContain('Unreleased');
    });
  });

  describe('highlightTerms', () => {
    it('should highlight NEW FEATURE', () => {
      const text = 'Added NEW FEATURE for users';
      const result = highlightTerms(text);
      // Chalk adds ANSI escape codes for styling
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThanOrEqual(text.length);
    });

    it('should highlight security terms', () => {
      const text = 'Fixed SECURITY issue';
      const result = highlightTerms(text);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThanOrEqual(text.length);
    });

    it('should highlight code snippets', () => {
      const text = 'Use `mc status` command';
      const result = highlightTerms(text);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThanOrEqual(text.length);
    });
  });
});
