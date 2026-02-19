/**
 * Tests for audit.js - Security Audit Logging Module
 * 
 * Security: Tests validate audit entry signing, integrity verification,
 * and tamper detection mechanisms.
 * 
 * Run with: npm test -- audit.test.js
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Mock dependencies
jest.mock('../lib/security', () => ({
  sanitizeForLog: jest.fn((str) => str),
}));

const audit = require('../lib/audit');

// =============================================================================
// Audit Event Type Constants Tests
// =============================================================================

describe('AuditEventType Constants', () => {
  test('exports expected event types', () => {
    expect(audit.AuditEventType).toBeDefined();
    expect(audit.AuditEventType.AUTH).toBe('AUTH');
    expect(audit.AuditEventType.COMMAND).toBe('COMMAND');
    expect(audit.AuditEventType.CONFIG_READ).toBe('CONFIG_READ');
    expect(audit.AuditEventType.CONFIG_WRITE).toBe('CONFIG_WRITE');
    expect(audit.AuditEventType.SECRET_ACCESS).toBe('SECRET_ACCESS');
    expect(audit.AuditEventType.SECURITY_VIOLATION).toBe('SECURITY_VIOLATION');
    expect(audit.AuditEventType.BACKUP_CREATE).toBe('BACKUP_CREATE');
    expect(audit.AuditEventType.BACKUP_RESTORE).toBe('BACKUP_RESTORE');
    expect(audit.AuditEventType.DEPLOY_START).toBe('DEPLOY_START');
    expect(audit.AuditEventType.DEPLOY_END).toBe('DEPLOY_END');
  });

  test('exports severity levels', () => {
    expect(audit.Severity).toBeDefined();
    expect(audit.Severity.DEBUG).toBe('debug');
    expect(audit.Severity.INFO).toBe('info');
    expect(audit.Severity.WARNING).toBe('warning');
    expect(audit.Severity.ERROR).toBe('error');
    expect(audit.Severity.CRITICAL).toBe('critical');
  });

  test('exports HMAC algorithm constant', () => {
    expect(audit.HMAC_ALGORITHM).toBe('sha256');
  });
});

// =============================================================================
// Audit Entry Creation Tests
// =============================================================================

describe('createAuditEntry', () => {
  test('creates entry with required fields', () => {
    const entry = audit.createAuditEntry('COMMAND', { test: 'data' });

    expect(entry).toHaveProperty('timestamp');
    expect(entry).toHaveProperty('eventType', 'COMMAND');
    expect(entry).toHaveProperty('details');
    expect(entry).toHaveProperty('id');
    expect(entry).toHaveProperty('severity', 'info');
  });

  test('creates entry with custom severity', () => {
    const entry = audit.createAuditEntry(
      audit.AuditEventType.SECURITY_VIOLATION,
      { test: 'data' }
    );
    expect(entry.severity).toBe('error');
  });

  test('generates unique entry IDs', () => {
    const entry1 = audit.createAuditEntry('TEST', {});
    const entry2 = audit.createAuditEntry('TEST', {});

    expect(entry1.id).not.toBe(entry2.id);
    expect(entry1.id).toMatch(/^mc-/);
  });

  test('timestamp is in ISO format', () => {
    const entry = audit.createAuditEntry('TEST', {});
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// =============================================================================
// Entry ID Generation Tests
// =============================================================================

describe('generateEntryId', () => {
  test('generates 16 character hex string', () => {
    const id = audit.generateEntryId();
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  test('generates unique IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(audit.generateEntryId());
    }
    expect(ids.size).toBe(100);
  });
});

// =============================================================================
// Signature Generation Tests
// =============================================================================

describe('generateEntrySignature', () => {
  test('generates consistent signatures for same entry', () => {
    const key = crypto.randomBytes(32);
    const entry = {
      timestamp: '2024-01-01T00:00:00Z',
      eventType: 'test',
      details: { test: 'data' },
    };

    const sig1 = audit.generateEntrySignature(entry, key);
    const sig2 = audit.generateEntrySignature(entry, key);

    expect(sig1).toBe(sig2);
    expect(sig1).toHaveLength(64); // sha256 hex
  });

  test('generates different signatures for different entries', () => {
    const key = crypto.randomBytes(32);
    const entry1 = { timestamp: '2024-01-01T00:00:00Z', eventType: 'test1' };
    const entry2 = { timestamp: '2024-01-01T00:00:00Z', eventType: 'test2' };

    const sig1 = audit.generateEntrySignature(entry1, key);
    const sig2 = audit.generateEntrySignature(entry2, key);

    expect(sig1).not.toBe(sig2);
  });

  test('generates different signatures for different keys', () => {
    const key1 = crypto.randomBytes(32);
    const key2 = crypto.randomBytes(32);
    const entry = { timestamp: '2024-01-01T00:00:00Z', eventType: 'test' };

    const sig1 = audit.generateEntrySignature(entry, key1);
    const sig2 = audit.generateEntrySignature(entry, key2);

    expect(sig1).not.toBe(sig2);
  });

  test('excludes existing signature fields from signing', () => {
    const key = crypto.randomBytes(32);
    const entry = {
      timestamp: '2024-01-01T00:00:00Z',
      eventType: 'test',
      _signature: 'existing-sig',
      _sigAlg: 'sha256',
    };

    const sig = audit.generateEntrySignature(entry, key);
    expect(sig).toBeDefined();
    expect(sig).not.toBe('existing-sig');
  });
});

// =============================================================================
// Entry Signing Tests
// =============================================================================

describe('signAuditEntry', () => {
  test('adds signature to entry', async () => {
    const key = crypto.randomBytes(32);
    const entry = {
      timestamp: '2024-01-01T00:00:00Z',
      eventType: 'test',
      details: {},
    };

    const signed = await audit.signAuditEntry(entry, key);

    expect(signed).toHaveProperty('_signature');
    expect(signed).toHaveProperty('_sigAlg', 'sha256');
    expect(signed._signature).toHaveLength(64);
  });

  test('signature validates entry integrity', async () => {
    const key = crypto.randomBytes(32);
    const entry = {
      timestamp: '2024-01-01T00:00:00Z',
      eventType: 'test',
      details: { important: 'data' },
    };

    const signed = await audit.signAuditEntry(entry, key);
    const isValid = await audit.verifyEntrySignature(signed, key);

    expect(isValid).toBe(true);
  });
});

// =============================================================================
// Signature Verification Tests
// =============================================================================

describe('verifyEntrySignature', () => {
  test('returns true for valid signature', async () => {
    const key = crypto.randomBytes(32);
    const entry = {
      timestamp: '2024-01-01T00:00:00Z',
      eventType: 'test',
      _signature: audit.generateEntrySignature({
        timestamp: '2024-01-01T00:00:00Z',
        eventType: 'test',
      }, key),
      _sigAlg: 'sha256',
    };

    const isValid = await audit.verifyEntrySignature(entry, key);
    expect(isValid).toBe(true);
  });

  test('returns false for tampered entry', async () => {
    const key = crypto.randomBytes(32);
    const entry = {
      timestamp: '2024-01-01T00:00:00Z',
      eventType: 'test',
      _signature: audit.generateEntrySignature({
        timestamp: '2024-01-01T00:00:00Z',
        eventType: 'test',
      }, key),
      _sigAlg: 'sha256',
    };

    // Tamper with the entry
    entry.eventType = 'tampered';

    const isValid = await audit.verifyEntrySignature(entry, key);
    expect(isValid).toBe(false);
  });

  test('returns false for invalid algorithm', async () => {
    const key = crypto.randomBytes(32);
    const entry = {
      _signature: 'some-sig',
      _sigAlg: 'md5', // Unsupported
    };

    const isValid = await audit.verifyEntrySignature(entry, key);
    expect(isValid).toBe(false);
  });

  test('returns false for missing signature', async () => {
    const key = crypto.randomBytes(32);
    const entry = {
      timestamp: '2024-01-01T00:00:00Z',
    };

    const isValid = await audit.verifyEntrySignature(entry, key);
    expect(isValid).toBe(false);
  });
});

// =============================================================================
// Details Sanitization Tests
// =============================================================================

describe('sanitizeAuditDetails', () => {
  test('handles null/undefined details', () => {
    expect(audit.sanitizeAuditDetails(null)).toEqual({});
    expect(audit.sanitizeAuditDetails(undefined)).toEqual({});
  });

  test('preserves primitive values', () => {
    const details = {
      string: 'test',
      number: 42,
      boolean: true,
    };

    const sanitized = audit.sanitizeAuditDetails(details);
    expect(sanitized.string).toBe('test');
    expect(sanitized.number).toBe(42);
    expect(sanitized.boolean).toBe(true);
  });

  test('handles nested objects', () => {
    const details = {
      nested: {
        key: 'value',
      },
    };

    const sanitized = audit.sanitizeAuditDetails(details);
    expect(sanitized.nested.key).toBe('value');
  });

  test('skips dangerous keys', () => {
    const details = {
      __proto__: 'should be skipped',
      constructor: 'should be skipped',
      prototype: 'should be skipped',
      normalData: 'visible',
    };

    const sanitized = audit.sanitizeAuditDetails(details);
    expect(sanitized.__proto__).toBeUndefined();
    expect(sanitized.constructor).toBeUndefined();
    expect(sanitized.prototype).toBeUndefined();
    expect(sanitized.normalData).toBe('visible');
  });
});

// =============================================================================
// Security Violation Logging Tests
// =============================================================================

describe('logSecurityViolation', () => {
  test('creates security violation entry with error severity', () => {
    const entry = audit.createAuditEntry(
      audit.AuditEventType.SECURITY_VIOLATION,
      { type: 'injection_attempt', input: 'test' }
    );

    expect(entry.eventType).toBe('SECURITY_VIOLATION');
    expect(entry.severity).toBe('error');
  });
});

// =============================================================================
// Command Logging Tests
// =============================================================================

describe('logCommand', () => {
  test('creates command entry', () => {
    const entry = audit.createAuditEntry(
      'COMMAND',
      { command: 'mc status', args: [] }
    );

    expect(entry.eventType).toBe('COMMAND');
    expect(entry.details.command).toBe('mc status');
  });
});

// =============================================================================
// Export Validation Tests
// =============================================================================

describe('Module Exports', () => {
  test('exports main logging functions', () => {
    expect(typeof audit.logAudit).toBe('function');
    expect(typeof audit.logSecurityViolation).toBe('function');
    expect(typeof audit.logCommand).toBe('function');
    expect(typeof audit.logConfigAccess).toBe('function');
    expect(typeof audit.logDeployment).toBe('function');
  });

  test('exports query functions', () => {
    expect(typeof audit.queryAuditLog).toBe('function');
    expect(typeof audit.getSecuritySummary).toBe('function');
  });

  test('exports integrity functions', () => {
    expect(typeof audit.verifyAuditIntegrity).toBe('function');
    expect(typeof audit.rotateSigningKey).toBe('function');
  });

  test('exports internal utilities', () => {
    expect(typeof audit.createAuditEntry).toBe('function');
    expect(typeof audit.sanitizeAuditDetails).toBe('function');
    expect(typeof audit.generateEntryId).toBe('function');
    expect(typeof audit.getAuditSigningKey).toBe('function');
    expect(typeof audit.generateEntrySignature).toBe('function');
    expect(typeof audit.signAuditEntry).toBe('function');
    expect(typeof audit.verifyEntrySignature).toBe('function');
  });

  test('exports constants', () => {
    expect(audit.AUDIT_DIR).toBeDefined();
    expect(audit.HMAC_ALGORITHM).toBe('sha256');
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('Integration', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-audit-test-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  test('audit directory path is valid', () => {
    expect(audit.AUDIT_DIR).toContain('.masterclaw');
    expect(audit.AUDIT_DIR).toContain('audit');
    expect(path.isAbsolute(audit.AUDIT_DIR)).toBe(true);
  });

  test('signing key can be generated and used', async () => {
    const key = await audit.getAuditSigningKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);

    // Can use key for signing
    const entry = { test: 'data' };
    const sig = audit.generateEntrySignature(entry, key);
    expect(sig).toHaveLength(64);
  });
});

// =============================================================================
// Tamper Detection Tests
// =============================================================================

describe('Tamper Detection', () => {
  test('detects modified timestamp', async () => {
    const key = crypto.randomBytes(32);
    const originalEntry = {
      timestamp: '2024-01-01T00:00:00Z',
      eventType: 'test',
      _signature: audit.generateEntrySignature({
        timestamp: '2024-01-01T00:00:00Z',
        eventType: 'test',
      }, key),
      _sigAlg: 'sha256',
    };

    // Tamper with timestamp
    originalEntry.timestamp = '2024-02-01T00:00:00Z';

    const isValid = await audit.verifyEntrySignature(originalEntry, key);
    expect(isValid).toBe(false);
  });

  test('detects modified details', async () => {
    const key = crypto.randomBytes(32);
    const originalEntry = {
      timestamp: '2024-01-01T00:00:00Z',
      eventType: 'test',
      details: { user: 'admin' },
      _signature: audit.generateEntrySignature({
        timestamp: '2024-01-01T00:00:00Z',
        eventType: 'test',
        details: { user: 'admin' },
      }, key),
      _sigAlg: 'sha256',
    };

    // Tamper with details
    originalEntry.details.user = 'hacker';

    const isValid = await audit.verifyEntrySignature(originalEntry, key);
    expect(isValid).toBe(false);
  });

  test('detects swapped signatures between entries', async () => {
    const key = crypto.randomBytes(32);
    const entry1 = {
      timestamp: '2024-01-01T00:00:00Z',
      eventType: 'test1',
      _signature: audit.generateEntrySignature({
        timestamp: '2024-01-01T00:00:00Z',
        eventType: 'test1',
      }, key),
      _sigAlg: 'sha256',
    };

    const entry2 = {
      timestamp: '2024-01-01T00:00:00Z',
      eventType: 'test2',
      _signature: audit.generateEntrySignature({
        timestamp: '2024-01-01T00:00:00Z',
        eventType: 'test2',
      }, key),
      _sigAlg: 'sha256',
    };

    // Swap signatures
    const temp = entry1._signature;
    entry1._signature = entry2._signature;
    entry2._signature = temp;

    // Both should now be invalid
    expect(await audit.verifyEntrySignature(entry1, key)).toBe(false);
    expect(await audit.verifyEntrySignature(entry2, key)).toBe(false);
  });
});
