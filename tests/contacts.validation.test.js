/**
 * Tests for contacts module security validation
 * Run with: npm test -- contacts.validation.test.js
 */

const {
  validateContactName,
  validateContactValue,
  validateTag,
  validateSearchQuery,
  validateExportFilename,
  sanitizeContact,
  sanitizeForMarkdown,
  exportToCSV,
  MAX_LENGTHS,
} = require('../lib/contacts');

describe('Contacts Security Validation', () => {
  // ===========================================================================
  // Contact Name Validation
  // ===========================================================================
  describe('validateContactName', () => {
    test('accepts valid names', () => {
      expect(validateContactName('John Doe').valid).toBe(true);
      expect(validateContactName('Mary Smith-Jones').valid).toBe(true);
      expect(validateContactName("O'Brien").valid).toBe(true);
      expect(validateContactName('Jean-Luc Picard').valid).toBe(true);
    });

    test('rejects empty names', () => {
      const result = validateContactName('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    test('rejects whitespace-only names', () => {
      const result = validateContactName('   ');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('required');
    });

    test('rejects names with control characters', () => {
      expect(validateContactName('John\x00Doe').valid).toBe(false);
      expect(validateContactName('John\x1fDoe').valid).toBe(false);
      expect(validateContactName('John\x7fDoe').valid).toBe(false);
    });

    test('rejects names that are too long', () => {
      const longName = 'a'.repeat(MAX_LENGTHS.name + 1);
      const result = validateContactName(longName);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('100');
    });

    test('rejects names with too many special characters', () => {
      const result = validateContactName('!!!@@@###$$$%%%');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('special characters');
    });

    test('rejects non-string inputs', () => {
      expect(validateContactName(null).valid).toBe(false);
      expect(validateContactName(123).valid).toBe(false);
      expect(validateContactName({}).valid).toBe(false);
    });
  });

  // ===========================================================================
  // Contact Value Validation
  // ===========================================================================
  describe('validateContactValue', () => {
    describe('email validation', () => {
      test('accepts valid emails', () => {
        expect(validateContactValue('email', 'user@example.com').valid).toBe(true);
        expect(validateContactValue('email', 'user.name@example.co.uk').valid).toBe(true);
        expect(validateContactValue('email', 'user+tag@example.com').valid).toBe(true);
      });

      test('rejects invalid emails', () => {
        expect(validateContactValue('email', 'invalid').valid).toBe(false);
        expect(validateContactValue('email', '@example.com').valid).toBe(false);
        expect(validateContactValue('email', 'user@').valid).toBe(false);
        expect(validateContactValue('email', 'user@@example.com').valid).toBe(false);
      });
    });

    describe('phone validation', () => {
      test('accepts valid phone numbers', () => {
        expect(validateContactValue('phone', '+1-555-123-4567').valid).toBe(true);
        expect(validateContactValue('phone', '(555) 123-4567').valid).toBe(true);
        expect(validateContactValue('phone', '5551234567').valid).toBe(true);
        expect(validateContactValue('whatsapp', '+44 20 7123 4567').valid).toBe(true);
        expect(validateContactValue('signal', '+33 1 23 45 67 89').valid).toBe(true);
      });

      test('rejects invalid phone numbers', () => {
        expect(validateContactValue('phone', '123').valid).toBe(false);
        expect(validateContactValue('phone', 'not-a-phone').valid).toBe(false);
        expect(validateContactValue('phone', 'abc-def-ghij').valid).toBe(false);
      });
    });

    describe('website validation', () => {
      test('accepts valid URLs', () => {
        expect(validateContactValue('website', 'https://example.com').valid).toBe(true);
        expect(validateContactValue('website', 'http://example.com/path').valid).toBe(true);
      });

      test('rejects invalid URLs', () => {
        expect(validateContactValue('website', 'example.com').valid).toBe(false);
        expect(validateContactValue('website', 'ftp://example.com').valid).toBe(false);
        expect(validateContactValue('website', 'javascript:alert(1)').valid).toBe(false);
      });
    });

    test('rejects values with control characters', () => {
      // Embedded null bytes should be rejected
      expect(validateContactValue('other', 'value\x00here').valid).toBe(false);
      // Embedded newlines should be rejected
      expect(validateContactValue('other', 'value\nhere').valid).toBe(false);
      expect(validateContactValue('other', 'value\rhere').valid).toBe(false);
      // Note: trailing newlines are stripped by trim() before validation
    });

    test('rejects values that are too long', () => {
      const longValue = 'a'.repeat(MAX_LENGTHS.contactValue + 1);
      const result = validateContactValue('other', longValue);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('500');
    });

    test('accepts other types with minimal validation', () => {
      expect(validateContactValue('discord', 'username#1234').valid).toBe(true);
      expect(validateContactValue('github', '@username').valid).toBe(true);
      expect(validateContactValue('twitter', '@handle').valid).toBe(true);
    });
  });

  // ===========================================================================
  // Tag Validation
  // ===========================================================================
  describe('validateTag', () => {
    test('accepts valid tags', () => {
      expect(validateTag('friend').valid).toBe(true);
      expect(validateTag('work-contact').valid).toBe(true);
      expect(validateTag('family member').valid).toBe(true);
      expect(validateTag('VIP').valid).toBe(true);
    });

    test('rejects empty tags', () => {
      expect(validateTag('').valid).toBe(false);
      expect(validateTag('   ').valid).toBe(false);
    });

    test('rejects tags with invalid characters', () => {
      expect(validateTag('tag<script>').valid).toBe(false);
      expect(validateTag('tag;drop').valid).toBe(false);
      expect(validateTag('tag|pipe').valid).toBe(false);
    });

    test('rejects tags that are too long', () => {
      const longTag = 'a'.repeat(MAX_LENGTHS.tag + 1);
      expect(validateTag(longTag).valid).toBe(false);
    });
  });

  // ===========================================================================
  // Search Query Validation
  // ===========================================================================
  describe('validateSearchQuery', () => {
    test('accepts valid queries', () => {
      expect(validateSearchQuery('John').valid).toBe(true);
      expect(validateSearchQuery('Mary Smith').valid).toBe(true);
      expect(validateSearchQuery('company-name').valid).toBe(true);
    });

    test('rejects empty queries', () => {
      expect(validateSearchQuery('').valid).toBe(false);
      expect(validateSearchQuery('   ').valid).toBe(false);
    });

    test('sanitizes regex special characters', () => {
      const result = validateSearchQuery('test[abc]');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBeDefined();
    });

    test('rejects queries that are too long', () => {
      const longQuery = 'a'.repeat(MAX_LENGTHS.searchQuery + 1);
      expect(validateSearchQuery(longQuery).valid).toBe(false);
    });
  });

  // ===========================================================================
  // Export Filename Validation
  // ===========================================================================
  describe('validateExportFilename', () => {
    test('accepts valid filenames', () => {
      expect(validateExportFilename('contacts.json').valid).toBe(true);
      expect(validateExportFilename('my-backup.csv').valid).toBe(true);
      expect(validateExportFilename('export-2024.vcard').valid).toBe(true);
    });

    test('rejects path traversal attempts', () => {
      expect(validateExportFilename('../etc/passwd').valid).toBe(false);
      expect(validateExportFilename('..\\windows\\system32').valid).toBe(false);
      expect(validateExportFilename('../../../etc/hosts').valid).toBe(false);
    });

    test('rejects filenames with null bytes', () => {
      expect(validateExportFilename('file\x00.json').valid).toBe(false);
    });

    test('rejects filenames with control characters', () => {
      expect(validateExportFilename('file\x01.json').valid).toBe(false);
    });

    test('rejects empty filenames', () => {
      expect(validateExportFilename('').valid).toBe(false);
      expect(validateExportFilename('   ').valid).toBe(false);
    });

    test('sanitizes to basename only', () => {
      const result = validateExportFilename('/path/to/contacts.json');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('contacts.json');
    });
  });

  // ===========================================================================
  // Markdown Sanitization
  // ===========================================================================
  describe('sanitizeForMarkdown', () => {
    test('escapes markdown special characters', () => {
      expect(sanitizeForMarkdown('**bold**')).toBe('\\*\\*bold\\*\\*');
      expect(sanitizeForMarkdown('[link](url)')).toBe('\\[link\\]\\(url\\)');
      expect(sanitizeForMarkdown('# heading')).toBe('\\# heading');
    });

    test('handles non-string inputs', () => {
      expect(sanitizeForMarkdown(null)).toBe('');
      expect(sanitizeForMarkdown(123)).toBe('');
      expect(sanitizeForMarkdown({})).toBe('');
    });

    test('preserves safe text', () => {
      expect(sanitizeForMarkdown('Hello World')).toBe('Hello World');
      expect(sanitizeForMarkdown('John Doe')).toBe('John Doe');
    });
  });

  // ===========================================================================
  // Contact Sanitization
  // ===========================================================================
  describe('sanitizeContact', () => {
    test('sanitizes all fields', () => {
      const contact = {
        id: 'contact_123',
        name: 'John Doe',
        category: 'personal',
        role: 'Developer',
        organization: 'Acme Corp',
        contactMethods: [
          { type: 'email', value: 'john@example.com' },
        ],
        tags: ['friend', 'work'],
        notes: 'Some notes',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };

      const sanitized = sanitizeContact(contact);

      expect(sanitized.name).toBe('John Doe');
      expect(sanitized.category).toBe('personal');
      expect(sanitized.contactMethods).toHaveLength(1);
    });

    test('truncates fields that are too long', () => {
      const contact = {
        id: 'contact_123',
        name: 'a'.repeat(200),
        role: 'b'.repeat(200),
        category: 'personal',
        contactMethods: [],
        tags: [],
        notes: 'c'.repeat(10000),
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };

      const sanitized = sanitizeContact(contact);

      expect(sanitized.name.length).toBe(MAX_LENGTHS.name);
      expect(sanitized.role.length).toBe(MAX_LENGTHS.role);
      expect(sanitized.notes.length).toBe(MAX_LENGTHS.notes);
    });

    test('filters out invalid contact methods', () => {
      const contact = {
        id: 'contact_123',
        name: 'John',
        category: 'personal',
        contactMethods: [
          { type: 'email', value: 'john@example.com' },
          { type: 'email', value: '' }, // Empty value should be filtered
          null, // Null should be filtered
          'invalid', // Non-object should be filtered
        ],
        tags: [],
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };

      const sanitized = sanitizeContact(contact);

      expect(sanitized.contactMethods).toHaveLength(1);
      expect(sanitized.contactMethods[0].value).toBe('john@example.com');
    });

    test('filters out invalid tags', () => {
      const contact = {
        id: 'contact_123',
        name: 'John',
        category: 'personal',
        contactMethods: [],
        tags: ['valid', 'also-valid', '<script>', '', 123, null],
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };

      const sanitized = sanitizeContact(contact);

      expect(sanitized.tags).toEqual(['valid', 'also-valid']);
    });

    test('defaults invalid categories to personal', () => {
      const contact = {
        id: 'contact_123',
        name: 'John',
        category: 'invalid_category',
        contactMethods: [],
        tags: [],
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };

      const sanitized = sanitizeContact(contact);

      expect(sanitized.category).toBe('personal');
    });
  });

  // ===========================================================================
  // CSV Export Security
  // ===========================================================================
  describe('exportToCSV', () => {
    test('prevents CSV injection attacks', () => {
      const contacts = [{
        name: "=CMD|'/C calc'!A0",
        category: 'personal',
        role: '',
        organization: '',
        contactMethods: [],
      }];

      const csv = exportToCSV(contacts);

      // Should prefix with quote to treat as text, escaping the formula
      // The dangerous formula should be wrapped in quotes with a single quote prefix
      expect(csv).toContain("\"'");
      // The formula should be quoted, preventing execution
      expect(csv).toMatch(/"'=CMD/);
    });

    test('handles fields with commas', () => {
      const contacts = [{
        name: 'Smith, John',
        category: 'personal',
        role: '',
        organization: '',
        contactMethods: [],
      }];

      const csv = exportToCSV(contacts);

      expect(csv).toContain('"Smith, John"');
    });

    test('handles fields with quotes', () => {
      const contacts = [{
        name: 'John "Johnny" Doe',
        category: 'personal',
        role: '',
        organization: '',
        contactMethods: [],
      }];

      const csv = exportToCSV(contacts);

      expect(csv).toContain('"John ""Johnny"" Doe"');
    });
  });
});
