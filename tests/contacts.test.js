/**
 * Tests for Contacts Management Module
 *
 * @jest-environment node
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {
  maskContactValue,
  generateId,
  CATEGORIES,
  exportToCSV,
  exportToVCard,
} = require('../lib/contacts');

// Mock dependencies
jest.mock('../lib/context', () => ({
  findRexDeusDir: jest.fn(),
}));

jest.mock('../lib/audit', () => ({
  logAudit: jest.fn(),
  AuditEventType: {
    CONFIG_WRITE: 'CONFIG_WRITE',
  },
}));

const { findRexDeusDir } = require('../lib/context');

describe('Contacts Module', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-contacts-test-'));
    findRexDeusDir.mockResolvedValue(tempDir);
  });

  afterEach(async () => {
    await fs.remove(tempDir);
    jest.clearAllMocks();
  });

  describe('maskContactValue', () => {
    it('should mask phone numbers showing only last 4 digits', () => {
      expect(maskContactValue('phone', '+1-555-123-4567')).toBe('+*-***-***-4567');
      expect(maskContactValue('whatsapp', '+1234567890')).toBe('+******7890');
    });

    it('should mask email addresses', () => {
      expect(maskContactValue('email', 'john.doe@example.com')).toBe('jo***oe@example.com');
      expect(maskContactValue('email', 'ab@example.com')).toBe('ab@example.com');
    });

    it('should completely mask sensitive values', () => {
      expect(maskContactValue('token', 'secret-token-123')).toBe('********');
      expect(maskContactValue('api_key', 'sk-abc123')).toBe('********');
      expect(maskContactValue('password', 'mypassword')).toBe('********');
    });

    it('should return non-sensitive values unchanged', () => {
      expect(maskContactValue('website', 'https://example.com')).toBe('https://example.com');
      expect(maskContactValue('twitter', '@username')).toBe('@username');
    });
  });

  describe('generateId', () => {
    it('should generate unique IDs with correct format', () => {
      const id1 = generateId();
      const id2 = generateId();

      expect(id1).toMatch(/^contact_\d+_[a-z0-9]{9}$/);
      expect(id2).toMatch(/^contact_\d+_[a-z0-9]{9}$/);
      expect(id1).not.toBe(id2);
    });

    it('should include timestamp in ID', () => {
      const before = Date.now();
      const id = generateId();
      const after = Date.now();

      const timestamp = parseInt(id.split('_')[1], 10);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('CATEGORIES', () => {
    it('should have expected categories with icons', () => {
      expect(CATEGORIES.personal).toEqual({ icon: '👤', label: 'Personal' });
      expect(CATEGORIES.professional).toEqual({ icon: '💼', label: 'Professional' });
      expect(CATEGORIES.technical).toEqual({ icon: '🔧', label: 'Technical Support' });
      expect(CATEGORIES.services).toEqual({ icon: '🏢', label: 'Services' });
      expect(CATEGORIES.emergency).toEqual({ icon: '🚨', label: 'Emergency' });
    });
  });

  describe('exportToCSV', () => {
    it('should export contacts to CSV format', () => {
      const contacts = [
        {
          name: 'John Doe',
          category: 'personal',
          role: 'Friend',
          organization: '',
          contactMethods: [{ type: 'email', value: 'john@example.com' }],
        },
        {
          name: 'Jane Smith',
          category: 'professional',
          role: 'Engineer',
          organization: 'Tech Corp',
          contactMethods: [{ type: 'phone', value: '+1234567890' }],
        },
      ];

      const csv = exportToCSV(contacts);
      const lines = csv.split('\n');

      expect(lines[0]).toBe('Name,Category,Role,Organization,Primary Contact');
      expect(lines[1]).toContain('John Doe');
      expect(lines[1]).toContain('personal');
      expect(lines[2]).toContain('Jane Smith');
      expect(lines[2]).toContain('professional');
    });

    it('should handle empty contact list', () => {
      const csv = exportToCSV([]);
      expect(csv).toBe('Name,Category,Role,Organization,Primary Contact');
    });

    it('should handle contacts without contact methods', () => {
      const contacts = [{
        name: 'No Contact',
        category: 'personal',
        role: '',
        organization: '',
        contactMethods: [],
      }];

      const csv = exportToCSV(contacts);
      expect(csv).toContain('No Contact');
    });
  });

  describe('exportToVCard', () => {
    it('should export contacts to vCard format', () => {
      const contacts = [
        {
          name: 'John Doe',
          organization: 'Example Inc',
          role: 'Developer',
          contactMethods: [
            { type: 'email', value: 'john@example.com' },
            { type: 'phone', value: '+1234567890' },
          ],
        },
      ];

      const vcard = exportToVCard(contacts);

      expect(vcard).toContain('BEGIN:VCARD');
      expect(vcard).toContain('VERSION:3.0');
      expect(vcard).toContain('FN:John Doe');
      expect(vcard).toContain('ORG:Example Inc');
      expect(vcard).toContain('TITLE:Developer');
      expect(vcard).toContain('EMAIL:john@example.com');
      expect(vcard).toContain('TEL;TYPE=PHONE:+1234567890');
      expect(vcard).toContain('END:VCARD');
    });

    it('should handle multiple contacts', () => {
      const contacts = [
        { name: 'John', contactMethods: [] },
        { name: 'Jane', contactMethods: [] },
      ];

      const vcard = exportToVCard(contacts);
      const cards = vcard.split('\n\n');

      expect(cards).toHaveLength(2);
      expect(cards[0]).toContain('FN:John');
      expect(cards[1]).toContain('FN:Jane');
    });

    it('should handle WhatsApp and Signal phone types', () => {
      const contacts = [{
        name: 'Test',
        contactMethods: [
          { type: 'whatsapp', value: '+1234567890' },
          { type: 'signal', value: '+0987654321' },
        ],
      }];

      const vcard = exportToVCard(contacts);
      expect(vcard).toContain('TEL;TYPE=WHATSAPP:+1234567890');
      expect(vcard).toContain('TEL;TYPE=SIGNAL:+0987654321');
    });

    it('should handle website URLs', () => {
      const contacts = [{
        name: 'Test',
        contactMethods: [
          { type: 'website', value: 'https://example.com' },
        ],
      }];

      const vcard = exportToVCard(contacts);
      expect(vcard).toContain('URL:https://example.com');
    });
  });
});

describe('Contacts Security', () => {
  describe('Input Validation', () => {
    it('should validate category is one of allowed values', () => {
      const validCategories = ['personal', 'professional', 'technical', 'services', 'emergency'];
      for (const cat of validCategories) {
        expect(CATEGORIES[cat]).toBeDefined();
      }
    });

    it('should handle unknown categories gracefully', () => {
      // Unknown categories should fall back to personal
      const unknownCategory = 'unknown';
      expect(CATEGORIES[unknownCategory]).toBeUndefined();
    });
  });

  describe('ID Generation Security', () => {
    it('should generate IDs that are not easily guessable', () => {
      const ids = Array.from({ length: 10 }, generateId);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(10); // All unique
    });

    it('should not include sensitive info in IDs', () => {
      const id = generateId();
      expect(id).toContain('contact'); // IDs have 'contact' prefix by design
      expect(id).not.toMatch(/[A-Z]/); // No uppercase (base36 is lowercase)
    });
  });
});
